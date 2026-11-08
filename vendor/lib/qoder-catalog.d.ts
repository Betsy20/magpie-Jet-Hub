/**
 * Qoder **远端模型目录**（`/api/v2/model/list?Encode=1`）。
 *
 * ## 为什么需要它（真实缺陷，2026-10-20 用户报障）
 *
 * 本插件此前**恒用编译期兜底表**（`QoderProduct.fallbackModels`，快照日期
 * 国际版 2026-09-21 / 中国版 2026-09-27），一次远端请求都不发。而上游改价、
 * 改免费额度、上/下架模型都不会通知任何人 ⇒ 纯静态快照必然腐坏：
 *
 * | 现象（2026-10-20 真机对账） | 兜底表 | 上游实际 |
 * |---|---|---|
 * | `dfmodel`（DeepSeek-Flash） | `price_factor = 0.1` | **`0` + `is_free` + 原价 0.1**（IDE 显示 `0.1×`划掉`0×`） |
 * | `mmodel` | `MiniMax-M2.7` / 0.2 | **`MiniMax-M3.1-Flash` / 0.1** |
 * | `fast` | 无此条 | 有（`price_factor 0.8`，受客户端版本闸门控制） |
 *
 * ⇒ 模型列表**必须以远端为准**，兜底表只作「拉不到时别把菜单变空」的回退
 * （与其余 12 家的 `loadCatalog` / `syncCatalog` 两段式同形）。
 *
 * ## 协议（取自本机 IDE 产物 + 真机实测）
 *
 * 端点与请求形状来自客户端 `qoder-worker-runtime` 的 `listModelsFromRemote`：
 *
 * ```js
 * let s = "/api/v2/model/list?Encode=1"          // 可再拼 &outerProviders=…
 * let l = async () => {
 *   let A = JqA(g, s, this.authManager)          // ← WASM 签名（prepareRequest）
 *   return await this.fetchWithTrace({ operation:"listModels", endpointType:"infer",
 *     method:"GET", path:s, url:A.url, init:{ method:"GET", headers:A.headers } })
 * }
 * let E = rb(await B.text())                     // ← rb = decrypt_server_response（失败即明文）
 * let u = JSON.parse(E)                          // { 场景: [模型…] }
 * ```
 *
 * 四条**实测边界**（2026-10-20，真实凭据，两个产品各验一遍）：
 *
 * 1. **host = `encryptedInferBase`**（CN `gateway.qoder.com.cn` / 国际 `api2.qoder.sh`），
 *    WASM 会在路径前补 `/algo` ⇒ 实发 `…/algo/api/v2/model/list?Encode=1`。
 * 2. **只发 GET、不带 body**，鉴权是 WASM 生成的 `Bearer COSY.<载荷>.<签名>`
 *    （18 个头）—— 用普通 `Bearer <token>` 会被拒。
 * 3. **`Encode=1` 不保证响应加密**：实测两个产品都回**明文 JSON**
 *    （`decrypt_server_response` 失败 ⇒ 走「失败即明文」回退，与官方 `rb()` 逐字同形）。
 *    故解密那一步**不能**当成必成功。
 * 4. **响应是 `{场景: [模型]}`**，顶层实际键：
 *    `chat / developer / assistant / inline / quest / qwork / experts / qwake / app /
 *    byok_teams / byok_enterprise`。本插件取 {@link QODER_CATALOG_SCENES}
 *    （`chat` ∪ `app`）—— **只取 `chat` 会漏掉 `QoDuck`**，见下一节。
 *
 * ## ⚠️ 为什么必须并 `app` 场景：`QoDuck`（`lmodel`）只发布在 `app` 里
 *
 * 2026-11-07 实测（真实凭据；声明版本 `1.1.49` / `1.1.69` / `1.1.70` 三档各拉
 * 一遍，`scripts/probe-qoder-duck.mts`）：
 *
 * `app` 场景 ≡ `chat` 场景 **+ `lmodel`（`QoDuck`）**，**逐版本成立**；
 * 反向差集（`chat` 有而 `app` 没有的）**一条都没有**。
 *
 * 而 `QoDuck` 条目里**根本没有 `minimal_version` 字段** ⇒ 它不受版本闸门管辖，
 * 抬版本一分都拿不到它（抬到 1.1.70 多出的是另一个模型 `fast`）。只读 `chat`
 * 的旧实现因此**结构性地**看不见它 —— 这不是「声明版本太低」，是**读错了场景**。
 *
 * 可用性已实测：`QoderAdapter.stream({ model: 'lmodel' })` 回 200 + 正文正常
 * （`scripts/probe-qoder-duck-call.mts`）。⚠️ 首包 **91.4s**，而 `dfmodel` 只要
 * **3.7s** —— 上游模型特性，不是插件问题；接进列表后会体现为「这个模型很慢」。
 *
 * 并场景后它自动走同一条展示/能力链路：窗口 **1M**（`parseContextWindow` 取
 * `context_config` 最大值，**刻意不认** `max_input_tokens: 180000`，理由见该函数
 * 注释）、`supportsImage: true`（`is_vl`）、三档思考 `low/high/xhigh`（默认
 * `high`）、`isFree: true`（`price_factor: 0`，原价 `0.5×`）。
 *
 * ## ⚠️ 版本闸门（`minimal_version`）
 *
 * 模型条目可带 `minimal_version: {app, cli, qoder_wake, vsc}`，服务端按
 * **请求方自称的客户端类型**选对应的命名空间比较：
 *
 * | 实测用例（同一账号、只改身份与版本） | `chat` 条数 | `fast` |
 * |---|---|---|
 * | `client_type=5`（cli） + `1.1.49`（2026-10 的旧值） | 14 | ✗ |
 * | `client_type=5` + `1.1.69` | 14 | ✗ |
 * | `client_type=5` + `1.1.70` | 15 | ✓ |
 * | `client_type=5` + `1.1.79` / `1.1.80` / `1.2.0` / `9.9.9` | 15 | ✓ |
 * | `client_type=10`（app，IDE 用它） + `0.4.8` | 14 | ✗ |
 * | `client_type=10` + `1.1.66` | 15 | ✓ |
 * | `client_type=10` + `1.1.69`（= IDE 的 SDK 版本常量） | 15 | ✓ |
 *
 * 即 `fast` 的闸门是 `{app: 1.1.66, cli: 1.1.70}`，**且目录在 1.1.70 处封顶**
 * （1.1.79 / 1.1.80 / 1.2.0 / 9.9.9 与 1.1.70 逐条相同）。
 *
 * ⚠️ **2026-11-07 起 `COSY_VERSION` 抬到 `1.1.79`**（用户要求）。依据：本机两个
 * 产品都装到 IDE **0.5.6**，其 `logs/runs/<run>/manifest.json` 的 `cli_version` 恒为
 * **`1.1.79-hotfix.18`**（`~/.qoder` 与 `~/.qoder-cn` 各取最新一条 run 实测一致）
 * ⇒ 官方客户端自称的就是 1.1.79 这一档。取 `1.1.79`（**不带** `-hotfix.18`
 * 预发布后缀）以保持 semver 单调 —— 预发布版本按 semver **低于**同位正式版，
 * 若上游哪天把闸门抬到 `1.1.79` 本身，带后缀会静默判不过。
 *
 * ⚠️ 该常量**同时进推理签名**（`QoderContext` 的 `Cosy-Version` 与签名载荷），
 * 故抬版本必须**实测推理仍 200**：`scripts/probe-qoder-duck-call.mts` 在 1.1.79
 * 下对 `lmodel` / `dfmodel` 各发一次，均 HTTP 200 + 正文正常（2026-11-07）。
 *
 * ## ⚠️ 与「本地 catalog-v6」的区别（不要混用）
 *
 * IDE 的 `~/.qoder/.models/{uid}/catalog-v6` 也能解出同一份数据，且**离线**、
 * 不需要签名。但它是**该账号在本地 IDE 里打开过**才有的产物：纯插件用户
 * （没装 IDE / 没在 IDE 登录过该账号）恒为空 —— 那正是「未开通」那类账号。
 * 故线上路径走本模块（签名远端），本地缓存只用于排查对账。
 */
import type { QoderCredential } from './qoder.js';
import type { QoderFallbackModel, QoderProduct } from './qoder-product.js';
/**
 * 目录端点（挂 `encryptedInferBase`）。
 *
 * ⚠️ **不要**写成 `/algo/api/v2/model/list`：`/algo` 前缀由 WASM 的
 * `prepareRequest` 自己补（与 `webSearch/oneSearch` 同款），手写会变成
 * `/algo/algo/…` 而 404。
 */
export declare const QODER_MODEL_LIST_PATH = "/api/v2/model/list?Encode=1";
/** 目录响应的**场景键**（见模块头第 4 条）。 */
export declare const QODER_CATALOG_SCENE = "chat";
/**
 * 参与合并的**场景键**，**按优先级降序**（前面的赢）。
 *
 * ⚠️ 必须并 `app`：`QoDuck`（`lmodel`）只发布在 `app` 场景，且**不带**
 * `minimal_version`（完整论证见模块头「为什么必须并 `app` 场景」）。
 * 实测 `app` ≡ `chat` + `lmodel`，逐版本成立，故并进来**只多这一个模型**。
 *
 * 顺序即优先级：`chat` 是加密推理端点实际走的那一类会话，同一 id 在两边都
 * 出现时取 `chat` 那条（与旧实现的取值逐字节一致 ⇒ 并场景不改变既有模型）。
 */
export declare const QODER_CATALOG_SCENES: readonly string[];
/**
 * 单次目录请求预算（毫秒）。
 *
 * 官方客户端的目录请求超时是 `Sqc = 12e4`（120s，见 `HzA/Sqc` 常量对），
 * 但那是**后台目录同步**的预算；本插件在 `listModels` 的宿主路径上被 await，
 * 拖满两分钟会让模型选择器卡死。取 15s（与 `qoder-credits.ts` 的
 * `QODER_CREDITS_TIMEOUT_MS` 同值同因），超时即回退兜底表。
 */
export declare const QODER_CATALOG_TIMEOUT_MS = 15000;
/**
 * 把一个远端模型条目转成兜底表同形（`QoderFallbackModel`）。
 *
 * ⚠️ **刻意复用兜底表的结构**：下游的 `qoderDisplayName`（倍率拼名）、
 * `qoderEffortsFor`（档位）、`toCatalogEntry`（能力）全都按该形状实现，
 * 转换放这里 ⇒ 远端与兜底表**走完全同一条展示/能力链路**，
 * 不会出现「远端条目少了某个字段于是倍率不显示」这类分叉。
 *
 * 形状不符（缺 key / 缺 display_name）或 `enable === false` 的条目返回 undefined
 * —— 后者是上游的「已停用」标记，客户端也把它滤掉。
 */
export declare function qoderRemoteModelToFallback(raw: unknown): QoderFallbackModel | undefined;
/**
 * 解析 `/api/v2/model/list` 的响应体。
 *
 * @param body - 已解密的 JSON。
 * @param scene - 场景键；缺省 {@link QODER_CATALOG_SCENE}。
 * @returns 该场景的模型列表；**响应形状不符时返回 `undefined`**（与「空列表」
 *   严格区分：前者是协议变了，后者是上游真的没给模型，两者对调用方的含义不同）。
 */
export declare function parseQoderRemoteModels(body: unknown, scene?: string): QoderFallbackModel[] | undefined;
/**
 * 解析**多个场景**并合并（按 `scenes` 顺序去重，靠前的赢）。
 *
 * 为什么不直接「逐个场景各调一次 {@link parseQoderRemoteModels} 再拼」：那样
 * **跨场景**会留下重复 id，而 DSH 的 `listModels` 对重复 id 抛 `INVALID_CATALOG`
 * —— 整个 provider 从选择器里消失（比少一个模型更糟）。去重必须与合并同时做。
 *
 * @param body - 已解密的 JSON。
 * @param scenes - 参与合并的场景键，**按优先级降序**；缺省
 *   {@link QODER_CATALOG_SCENES}。
 * @returns 合并后的模型列表；**一个场景都不是数组**时返回 `undefined`
 *   （协议变了）。⚠️ 与「空列表」严格区分：`chat` 空但 `app` 有模型时
 *   **照常返回** `app` 的那些（不能被「空 `chat`」判成协议变更）。
 */
export declare function parseQoderRemoteModelsForScenes(body: unknown, scenes?: readonly string[]): QoderFallbackModel[] | undefined;
/** {@link fetchQoderRemoteModels} 的可注入依赖（测试用）。 */
export interface QoderRemoteCatalogOptions {
    /** 注入的 fetch；缺省用全局。 */
    fetcher?: typeof fetch;
    /** 单次请求预算（毫秒）；缺省 {@link QODER_CATALOG_TIMEOUT_MS}。 */
    timeoutMs?: number;
}
/**
 * 拉取远端模型目录（WASM 签名 → GET → 解密 → 解析）。
 *
 * ⚠️ **失败一律抛错**，由调用方（`QoderAdapter.ensureRemoteModels`）回退兜底表：
 * 这里吃掉的失败会让「目录挂了」表现为「模型变少了」，而回退兜底表至少保住菜单。
 *
 * ⚠️ **凭据的 `uid` 与 `machine_id` 是必需项**：前者参与
 * `generate_runtime_auth_fields`（缺了会产出**签名无效**的请求），后者进
 * `QoderContext`。缺任一项直接抛，不发一次注定失败的请求。
 */
export declare function fetchQoderRemoteModels(credential: QoderCredential, product: QoderProduct, options?: QoderRemoteCatalogOptions): Promise<QoderFallbackModel[]>;
//# sourceMappingURL=qoder-catalog.d.ts.map