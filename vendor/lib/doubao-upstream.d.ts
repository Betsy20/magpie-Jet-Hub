/**
 * 豆包（Doubao，字节跳动）**网页端上游协议**。
 *
 * ## ⚠️ 这个模块解决的是什么问题
 *
 * 2026-11-03 接入豆包时，本仓只做了**每日签到**（`src/doubao-signin.ts`），
 * 结论写的是「豆包无积分余额概念」「没有模型调用协议」——
 * 那两条结论**只对签到口径成立**，对**账号面板与模型选择器**是错的：
 *
 * - **额度**（`/alice/commerce/sale/subscription/quota/summary/`）确实存在，
 *   2026-11-22 真机实测回 `活动赠送额度 total_amount:"1,600"`；
 * - **模型目录**（`/alice/slot/action_bar_v3/brief_list`）确实存在，
 *   同日实测回 14 个真实模型（豆包 2.1 Pro/Lite、DeepSeek V4.1 Flash、Kimi K3.1 Pro、
 *   GLM 5.3、Qwen 4 Max…）与各自的倍率标签；
 * - **对话**（`/chat/completion`）也通，回真实增量正文。
 *
 * ⇒ 本模块把这三条腿的**协议细节**集中到一处，适配器与额度查询共用。
 *
 * ## 鉴权与设备身份
 *
 * - **鉴权 = cookie**（`sessionid` / `sid_tt` / `ttwid`…），无 `Authorization`。
 * - **设备身份 = 确定性派生**（`doubaoDeviceIdentityOf`）：每账号一套 19 位数字
 *   `device_id` / `web_id` / `tea_uuid`，`fp` 恒为 `verify_<device_id>`。
 * - ⚠️ 这三条腿**不需要** `a_bogus` 签名（签到那条腿需要，走 CDP 页面会话）。
 *   实测依据：2026-11-22 用纯 cookie + 客户端请求头，三个端点均 200。
 *
 * ## 请求头是**客户端身份**，不是随便填的
 *
 * ⚠️ `Referer` 必须是 `chrome://doubao-chat/`（桌面端方案），
 * **不能**用 `https://www.doubao.com/chat/`；`User-Agent` 必须带
 * `SamanthaDoubao/<version>` 后缀。这两条来自豆包桌面端抓包，
 * 与本仓 TRAE 那条「UA 前缀决定 WAF 放行」是同型约束。
 *
 * @module src/doubao-upstream.ts
 */
import { type DoubaoCredential } from './doubao.js';
/** 豆包网页端基址。 */
export declare const DOUBAO_WEB_BASE_URL = "https://www.doubao.com";
/** 额度汇总端点（**只接受 POST**；GET 同路径是 404 空体）。 */
export declare const DOUBAO_QUOTA_PATH = "/alice/commerce/sale/subscription/quota/summary/";
/** 模型目录端点（**只接受 POST**；GET 同路径是 404）。 */
export declare const DOUBAO_BRIEF_LIST_PATH = "/alice/slot/action_bar_v3/brief_list";
/** 对话端点。 */
export declare const DOUBAO_CHAT_PATH = "/chat/completion";
/**
 * 豆包助手 bot id（对话与模型目录两处都要它）。
 *
 * ⚠️ 缺它 → 模型目录回 `code 710010202 / common invalid param`（2026-11-22 实测）。
 */
export declare const DOUBAO_BOT_ID = "7338286299411103781";
/** 客户端版本号（随豆包客户端发版变化，风控会看它）。 */
export declare const DOUBAO_CLIENT_VERSION = "2.31.4";
/** 运行时版本号（同上）。 */
export declare const DOUBAO_RUNTIME_VERSION = "3.39.0";
/** Chromium 版本（客户端自报）。 */
export declare const DOUBAO_CHROMIUM_VERSION = "147.0.7727.149";
/** 请求超时（毫秒）。 */
export declare const DOUBAO_HTTP_TIMEOUT_MS = 15000;
/**
 * ★★★ **对话请求的超时**（issue #150 第 1 条，2026-11-23）。
 *
 * ⚠️ 与 {@link DOUBAO_HTTP_TIMEOUT_MS}（**目录**请求，15s）刻意分开：
 * 这里等的是**一整段对话**（本家目前还是「读完才吐 chunk」），15 秒远远不够。
 *
 * ⚠️ 取值 180s：介于「目录的 15s」与「undici 默认 300s」之间 —— 旧行为是
 * **完全无超时**（`signal: null`），唯一上界就是 undici 那 300s，用户会干等 5 分钟。
 * 比它短一点既能让用户更早拿到「超时」这个明确结论，又不至于误杀正常的长回答。
 */
export declare const DOUBAO_CHAT_TIMEOUT_MS = 180000;
/**
 * 从上游错误 body 里取出人话原因（`msg` / `message`），取不到就返回空串。
 *
 * ⚠️ 这是 issue #150 第 2 条的配套：旧代码在非 2xx 时**压根不读 body**，
 * 于是用户只看到 `豆包：上游返回 HTTP 500`，而上游其实可能给了
 * 「当前对话人数过多，请稍后再试」这种人话。
 *
 * ⚠️ **只取这两个字段**，绝不把整段 body 拼进 message —— body 可能含
 * 请求回显（含 Cookie/URL），那就是把脱敏白做了。取不到就退回旧文案。
 */
export declare function doubaoUpstreamReasonOf(bodyText: string): string;
/**
 * 构造豆包客户端形态的请求头。
 *
 * ⚠️ `Referer` 用 `chrome://doubao-chat/`（桌面端方案）——这是抓包实测值。
 * ⚠️ `sec-ch-ua` 是客户端自报的 brand 串，与 UA 里的 Chrome 版本一致。
 */
export declare function doubaoHeaders(cookie: string, extra?: Record<string, string>): Record<string, string>;
/**
 * 构造公共 query。
 *
 * ⚠️ `aid` 聊天侧是 `582478`（签到侧是 `497858`，两者不同，别混）。
 * ⚠️ `fp` 恒为 `verify_<device_id>`——客户端就是这么发的，不是 `s_v_web_id`。
 */
export declare function doubaoQuery(credential: DoubaoCredential): URLSearchParams;
/**
 * 豆包上游返回的**信封**。
 *
 * ⚠️ `code !== 0` 时 `data` 是 `null`，且 `message`/`msg` 都有内容
 * （实测 `code 710010202 / message "common invalid param" / msg "系统错误"`）。
 */
export interface DoubaoEnvelope {
    code?: number;
    msg?: string;
    message?: string;
    data?: unknown;
}
/** 解析信封；非 JSON 时回 `undefined`（不抛）。 */
export declare function parseDoubaoEnvelope(raw: string): DoubaoEnvelope | undefined;
/** 从信封里取可读错误文案（没有就回空串）。 */
export declare function doubaoErrorText(envelope: DoubaoEnvelope | undefined): string;
/**
 * 额度窗口（上游 `window_limits[]` 的一条）。
 *
 * ⚠️ `total_amount` / `used_amount` 是**千分位字符串**（实测 `"1,600"`），
 * 而 `used_amount` 还可能是 `"<1"`（不足 1 的占比）——两者都要能解析。
 */
export interface DoubaoQuotaWindow {
    readonly featureGroup: string;
    readonly featureGroupName: string;
    readonly total: number;
    readonly used: number;
    readonly endTime?: number;
    readonly usedPercent?: number;
}
/**
 * 解析额度响应里的窗口列表。
 *
 * ⚠️ 上游把它放在 `incentive_quota_section` 与 `window_limit_section` 两处，
 * 形状相同 ⇒ 两处都走（未来出现第三处只需再加一个）。
 */
export declare function doubaoQuotaWindows(payload: unknown): readonly DoubaoQuotaWindow[];
/**
 * 解析一个额度数字。
 *
 * ⚠️ 上游给的是**千分位字符串**（`"1,600"`）；带 `<` 的阈值字符串当前按阈值
 * 数字保守取整（例如 `"<1"` → `1`），宁可少算剩余额度，也不虚报可用数。
 */
export declare function doubaoAmount(value: unknown): number | undefined;
/**
 * 订阅展示名（实测 `display.short_name` = 「免费体验」，
 * `display.product_name` = 「个人订阅」）。
 */
export declare function doubaoSubscriptionName(payload: unknown): string | undefined;
/**
 * 目录里的一条模型（来自 `brief_list` 的 `entry_list` 树）。
 *
 * ⚠️ `default_mode` 是**豆包的模式号**：`1` = 对话、`3` = 工作任务。
 * 它决定请求体的 `mode_id` / `agent_mode` / `conversation_mode`（见 `src/doubao-adapter.ts`）。
 */
export interface DoubaoRemoteModel {
    /** 上游的 `model_item_key`（请求里用它路由，**不是**显示名）。 */
    readonly key: string;
    /** 显示名（实测「豆包 2.1 Pro」「DeepSeek V4.1 Flash」…）。 */
    readonly name: string;
    /** 模式号：1 = 对话，3 = 工作任务。 */
    readonly modeId: string;
    /** 倍率 / 活动标签（实测「0.65x」「限时优惠 0.01x」「小额免费」）。 */
    readonly tags: readonly string[];
    /** 只在模型菜单明确公开档位时存在；不声明默认值，避免隐式开启推理。 */
    readonly reasoning?: {
        readonly efforts: readonly {
            readonly id: string;
            readonly name: string;
        }[];
    };
}
export declare function doubaoRemoteModels(payload: unknown): readonly DoubaoRemoteModel[];
/**
 * 解析标签列表。
 *
 * ⚠️ 上游的元素要么是**字符串**，要么是 `{ text }` 形态（实测两种都有）。
 */
export declare function doubaoTagList(value: unknown): readonly string[];
/**
 * 把倍率/活动标签整理成展示后缀（上游客户端的原始拼法）。
 *
 * ⚠️ 「限时优惠 0.01x」按上游原样展示（**不**改写成 `x0.01 限时优惠`）——
 * 展示层读的是上游给的文本，改写就是二次加工。
 */
export declare function doubaoTagSuffix(tags: readonly string[]): string | undefined;
//# sourceMappingURL=doubao-upstream.d.ts.map