/**
 * MonkeyCode 网关的专用 HTTP 传输。
 *
 * ## 为什么不能用全局 `fetch`
 *
 * 网关要求 `X-OhmyAgent-Signature: v1=HMAC-SHA256(signing_secret, prompt)`。
 * bili（billion-context）在 native 模式下会替换 `globalThis.fetch`，按请求头
 * 形状（任何以 `-signature` 结尾的头）把请求判定为「正文签名请求」；它没有
 * `x-ohmyagent-signature` 的重签器，于是按 compress-or-refuse 契约直接回
 * 403 `bili_resign_unavailable` —— 请求根本到不了 MonkeyCode。
 *
 * 这不是凭据问题，换号 / 重新登录都不会好；bili 的文档也明确说第三方插件
 * 若密钥密封在自己手里，唯一出路是走模块级 HTTP 客户端（`undici.request` /
 * `node:http`）直连 —— 它只替换 `globalThis.fetch`，拦不到模块导入。
 *
 * ⚠️ 代价：这条链路不经过 bili 的上下文压缩（bili 也拒绝压缩签名字段）。
 * 这是「能用」与「用不了」之间的取舍，不是可配置项。
 *
 * ## ⚠️⚠️ 为什么用 `undici.request` 而不是 `node:http`（2026-11-05 审计返工）
 *
 * 上一版直接 `node:https.request`，审计打穿三条：
 * 1. **代理被绕过**：`node:https` 不读宿主 `setGlobalDispatcher`、也不读
 *    `HTTP(S)_PROXY` ⇒ 需要代理才能到网关的用户整条渠道消失；
 * 2. **没有超时**：`fetch` 有 undici 默认 300s，`node:http` 默认 0 ⇒ 上游吊死即
 *    永久挂起；
 * 3. **205/≥600 崩溃**：`new Response(body,{status:205})` 在异步回调里抛
 *    `TypeError`（205 是 null-body status），`≥600` 抛 `RangeError` ⇒
 *    **未捕获异常直接带走宿主进程**。
 *
 * `undici.request` 一次解决三条：它走 dispatcher（显式 `ProxyAgent` 时尊重
 * 代理）、自带 `headersTimeout`/`bodyTimeout`，且返回值由我们构造 `Response`
 * 前可以逐项校验。代价是 `undici` 是直接依赖（见 package.json）。
 *
 * @module src/monkeycode-http.ts
 */
/**
 * 用 `undici.request` 发一次请求，返回 WHATWG `Response`。
 *
 * 只实现适配器真正用到的 Response 表面（`ok` / `status` / `headers` / `body` /
 * `text()`）；响应体流式桥接，不预先缓冲。
 */
export declare function monkeycodeDirectFetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
//# sourceMappingURL=monkeycode-http.d.ts.map