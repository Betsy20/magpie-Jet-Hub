/**
 * 每账号代理 → undici Dispatcher。
 *
 * ## 两条实现路线（设计文档 §3）
 *
 * - **HTTP(S)**：undici 的 `ProxyAgent`。⚠️ 必须传
 *   `clientFactory` + `pipelining: 0` —— 默认的 keep-alive 连接池会被
 *   Clash 类代理静默关闭空闲 CONNECT 隧道，导致请求挂死
 *   （opencode2dsh / dsh-llm-proxy 都实测踩过，数据 2/10 → 10/10）。
 * - **SOCKS5**：Node 生态**没有**可用的纯 JS 栈（npm 的 `socks-proxy-agent`
 *   是给 node:http 的 Agent，不是 undici Dispatcher），故自实现最小
 *   CONNECT 隧道：RFC 1928 握手 + RFC 1929 认证 + CONNECT，
 *   **不**自写加密协议栈（设计文档 §8 明确排除）。
 *
 * ## 作用域：仅本 provider
 *
 * 只在 `fetch(url, { dispatcher })` 里逐请求传入，**不动全局 dispatcher**
 * （opencode2dsh 的 R1 教训：两个插件抢全局槽位会互相短路整个路由层）。
 *
 * ⚠️ **发请求必须走本模块的 {@link proxyFetch}**，不要自己写
 * `fetch(url, { dispatcher: buildProxyDispatcher(...) })` —— 那正是缺陷 IKK4BY，
 * 原因见 {@link proxyFetch} 的注释。
 *
 * ## ⚠️ 依赖说明
 *
 * 本模块是**全仓库唯一**新增的 npm 依赖（undici）。原本的设计要求「零新依赖」，
 * 但 per-request 代理的 `ProxyAgent` / 可插 connector 的 `Agent` 都住在 undici
 * 里，而它既不在本仓库依赖中、也无法从 Node 内部路径 require 到
 * （`node:undici` 不存在、`globalThis.ProxyAgent` 未定义、
 * `--use-env-proxy` 是**进程全局**的，给不了「每账号不同出口」）。
 * 用户已确认接受这一处破例。
 */
import type { Dispatcher } from 'undici';
import { type Socket } from 'node:net';
import { type PeerCertificate, type TLSSocket } from 'node:tls';
import type { NormalizedProxy } from './opencode.js';
/**
 * 走**指定代理**发请求（本 provider 的唯一出口方法）。
 *
 * ## ⚠️⚠️ 为什么不能直接用全局 `fetch`（真实缺陷 IKK4BY）
 *
 * {@link buildProxyDispatcher} 的 Dispatcher 来自**外部 undici**，而全局
 * `fetch` 是 Node **内置 undici** 的实现。把前者塞进 `RequestInit.dispatcher`，
 * 等于让「内置版本的 handler」去满足「外部版本的断言」—— 两个版本区间不搭就
 * **在建连之前**同步抛错：
 *
 *     InvalidArgumentError: invalid onRequestStart method
 *     code = UND_ERR_INVALID_ARG
 *
 * 该异常被 fetch 包装成 `TypeError: fetch failed` 且 **cause 被丢弃**，
 * 于是用户只看到「测试失败 fetch failed、耗时 0~1ms」「保存后每次对话都失败」，
 * 与代理地址是否可用**完全无关**（实测断言早于任何连接）。
 *
 * ## 版本对应关系（本机实测 Node 22.19 / 24.21 / 26.10）
 *
 * | Node | 内置 undici | 全局 fetch + 外部 8.x |
 * |---|---|---|
 * | 22.19 | 6.21.2 | ✗ 缺 6 个新契约字段 |
 * | 24.21 | 7.29.1 | ✗ 缺 5 个 |
 * | 26.10 | 8.10.2 | ✓ **恰好**同契约 |
 *
 * ⚠️ 机制细节：undici **7.x** 的 `assertRequestHandler` 开头有「双契约早返回」
 * （`typeof handler.onRequestStart === 'function'` 就直接 return），
 * 而 **8.x 删掉了它**，改为无条件要求新契约字段。这就是「同一份 handler，
 * Node 26 过、Node 22/24 挂」的全部来源。
 *
 * ⚠️ 因此 Node 26 上「看似正常」纯属**版本巧合**，不是「跨实例 Dispatcher 被支持」。
 * 外部 undici 升到 9.x、或用户换回 Node 22/24，都会立刻复发 ——
 * 故**凡是要传 dispatcher 的请求都必须走本函数**，这是唯一与版本无关的根治办法。
 *
 * ## 与全局 fetch 的语义差异（已实测无影响）
 *
 * - **SSE 增量语义不变**：`response.body` 仍逐块到达（4 段 SSE 的分片数与
 *   首片耗时与全局 fetch 一致，未被整体缓冲）—— `consumeOpenAiSse` 依赖这条；
 * - **`AbortSignal` 行为不变**：1.5s 中断 3s 慢响应，两者都是 `AbortError`；
 * - **无代理时不切实现**：`proxy === undefined` 时仍走全局 `fetch`，
 *   以免改变「不传 dispatcher」路径的既有行为（例如 Node 24+ 的
 *   `NODE_USE_ENV_PROXY` 等**由内置 fetch 提供**的宿主特性）。
 *   ⚠️ 这条已实测：`NODE_USE_ENV_PROXY=1` + `HTTP_PROXY=<中介>` 时，
 *   Node 26 的全局 fetch 确实经中介（中介命中 +2），而 Node 22 不支持该特性
 *   （命中 0）—— 故「无代理也切到 undici fetch」会**静默丢掉**这类宿主能力。
 *
 * ## ⚠️ 不接受 `Request` 对象（实测的静默降级风险）
 *
 * 本函数把 `init` 用 `{ ...init }` 展开后再补 `dispatcher`。若有人传
 * **`Request` 对象**当 `init`，展开得到的是**空对象**（`Request` 的
 * method / body / headers 都不是自有可枚举属性）—— 于是请求会**静默降级**：
 *
 *     全局 fetch(url, Request)         → POST + body + headers   ✓ 正确
 *     fetch(url, { ...Request })      → **GET、无 body、无 headers**  ← 静默错
 *
 * 这比抛错更危险（错得没有声音）。故这里**显式拦截**并抛出，让调用方立刻发现。
 * ⚠️ 当前三个调用点都传普通对象或 `{ signal }`，均未触发 —— 这是**防御**而非修 bug。
 */
export declare function proxyFetch(input: string, init: RequestInit, proxy: NormalizedProxy | undefined): Promise<Response>;
/** 取（或建）该代理地址的 Dispatcher。 */
export declare function buildProxyDispatcher(proxy: NormalizedProxy): Dispatcher;
/** 当前缓存的代理实例数（诊断用）。 */
export declare function proxyCacheSize(): number;
/** 关闭并清空全部缓存实例（插件 dispose 路径）。 */
export declare function closeAllProxyDispatchers(): Promise<void>;
/**
 * SOCKS5 握手的**首帧**（可单测的纯函数）。
 *
 * - 无认证 → `[0x05, 0x01, 0x00]`（VER=5，NMETHODS=1，METHOD=NO AUTH）
 * - 有认证 → `[0x05, 0x02, 0x00, 0x02]`（NMETHODS=2，NO AUTH + USER/PASS）
 *
 * ⚠️ 凭据用 `decodeURIComponent` 解码：用户在 URL 里写 `%40` 表示 `@`。
 */
export declare function buildSocks5Handshake(proxy: Pick<NormalizedProxy, 'url'>): Uint8Array;
/**
 * SOCKS5 Dispatcher：把自定义 connector 交给 undici 的 `Agent`。
 *
 * 隧道 socket 交给 undici 后，它会继续在上面做 TLS 握手与 HTTP/1.x 收发。
 *
 * ## ⚠️⚠️ 端口**不能**写成 `Number(opts.port ?? 443)`（真实缺陷，2026-10-08 实测）
 *
 * undici 传给 connector 的 `opts.port` 在**默认端口**时是**空字符串 `""`**，
 * 而不是 `undefined`（实测 undici 8.11.2，`opts` 全部键为
 * `host,hostname,protocol,port,servername,localAddress`）：
 *
 * | 目标 URL | `opts.port` | `Number(opts.port ?? 443)` |
 * |---|---|---|
 * | `https://opencode.ai/zen/...`（默认 443） | `""` | **0** ← 坏 |
 * | `https://example.com:8443/` | `"8443"` | 8443 ✓ |
 *
 * `??` 只兜 `null`/`undefined`，**兜不住空字符串**，于是 `Number("") === 0`，
 * SOCKS5 的 CONNECT 帧把端口写成 `0x0000` ⇒ 上游按端口 0 连接必然失败：
 *
 *     中介实测：CONNECT → "opencode.ai:0" → 失败（应答码 0x5）
 *     显式端口实测：CONNECT → "example.com:8443" → 通过
 *
 * 影响面**正好命中生产主路径** —— `OPENCODE.baseUrl` 是
 * `https://opencode.ai/zen`（默认 443），故「SOCKS5 代理」这个功能
 * 在修复前是**恒不可用**的（HTTP 代理不受影响，它不走这条 connector）。
 * 三代 Node（22.19 / 24.21 / 26.10）一致复现，与版本无关。
 *
 * ⇒ 判据必须同时覆盖「空串」与「非法值」，回退到按协议推出的默认端口。
 */
export interface SocksConnectDeps {
    tunnel?: (proxy: NormalizedProxy, host: string, port: number) => Promise<Socket>;
    wrapTls?: (options: {
        socket: Socket;
        servername?: string;
        checkServerIdentity?: (hostname: string, cert: PeerCertificate) => Error | undefined;
    }) => TLSSocket;
}
interface SocksConnectOptions {
    hostname?: string;
    host?: string;
    port?: number | string;
    protocol?: string;
    /** undici 可能带上 SNI override（内置 connector 也读它）。 */
    servername?: string;
}
/**
 * 构造 undici 的 `connect` 钩子：SOCKS5 握手后按目标协议**再做 TLS**。
 *
 * ## ⚠️⚠️ 为什么必须自己包 TLS（真实缺陷，Gitee/GitHub issue #19）
 *
 * undici 的 `connect` 选项**整体替换**内置 connector —— 内置 connector 在
 * `protocol === 'https:'` 时会自己 `tls.connect`，而自定义钩子返回的 socket
 * 会被当作**已就绪**直接写 HTTP。只返回裸 TCP 隧道 ⇒ TLS ClientHello 被当成
 * HTTP 明文发给上游 ⇒ `https://opencode.ai/...` 经 SOCKS5 必然失败
 * （HTTP 代理不走这条 connector，所以只有 SOCKS5 用户中招）。
 *
 * ⇒ 握手成功后：https/wss 目标用 `tls.connect({ socket, servername })` 包一层，
 * 等 `secureConnect` 再交给 undici；`servername` 只对域名设置（IP 不发 SNI）。
 */
export declare function createSocksConnect(proxy: NormalizedProxy, deps?: SocksConnectDeps): (opts: SocksConnectOptions, callback: (error: Error | null, socket?: Socket) => void) => void;
/**
 * 从 undici 传来的 `opts` 里解析出**真正的目标端口**。
 *
 * 三层兜底（缺一不可，每一层都有实测依据）：
 * 1. `opts.port` 是**空串** ⇒ 视为「未指明」，落到协议默认端口
 *    （⚠️ 这是本函数存在的根本原因，见 {@link buildSocksDispatcher} 的事故注释）；
 * 2. 解析结果不是 **1..65535 的整数**（`NaN` / 0 / 越界 / 小数）⇒ 同样回退；
 * 3. 协议默认端口：`https:`/`wss:` → 443，其余 → 80。
 *    ⚠️ 不复用 443 作通用兜底：http 目标回退到 443 会把「端口没给对」伪装成
 *    「连不上」，掩盖真实原因。
 */
export declare function resolveConnectPort(opts: {
    port?: number | string;
    protocol?: string;
}): number;
export {};
//# sourceMappingURL=opencode-proxy.d.ts.map