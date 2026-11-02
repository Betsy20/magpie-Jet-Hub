/**
 * Magicrew（超级麦吉）provider 的**产品常量与静态兜底表**。
 *
 * ## 协议速览（2026-10-28 本机实发实测，详见设计规格 §1）
 *
 * | 用途 | 方法 | 地址 | 认证 |
 * |---|---|---|---|
 * | 登录（**不采用**） | POST | `<host>/api/v1/sessions` | 无（`type: 'phone_password'`） |
 * | 登录（**短信**，未接线） | POST | `/v4/user/send-sms` + `/v4/user/login` | 无（`type: 'phone_captcha'`） |
 * | 签/续 gateway key | POST/PUT | `<host>/api/v1/model-gateway/tokens` | JWT（POST）/ refresh_token（PUT） |
 * | 目录 | GET | `<host>/api/v1/flows/models` | JWT |
 * | 计费 | POST | `<host>/api/v1/products/model-points` | JWT |
 * | 积分 | GET | `<host>/api/v1/quota/points/total` | JWT |
 * | 推理 | POST | `<host>/v1/chat/completions` | `mgw_` api_key |
 *
 * ## ⚠️ 登录方式：**不接手机号密码**
 *
 * `POST /api/v1/sessions` 的 `phone_password` 端点确实存在（magpie 的 `api.mjs` 实测过 200），
 * 但参考实现里那个 `login()` **零调用者** —— 它是未被采用的探索代码；真实入口是
 * **短信验证码**（先解「旋转验证码」⇒ 要识图模型）。⇒ 本插件只走两条**无门槛**的路：
 * 读本机浏览器登录态（`mode: 'local-browser'`）与开窗网页登录（`mode: 'browser'`）。
 *
 * ## ⚠️ 两条实测出来的硬约束（都不在文档里，是发请求才知道的）
 *
 * 1. **api_key 与 organizationCode 必须配对**：用错配的 key 会得到
 *    **HTTP 200 + `{"code":403,"message":"token无效"}`** —— 错误藏在 body 里，
 *    只判 `res.ok` 会误判成功。
 * 2. **`expires_at` 无时区**（`2026-11-27 13:47:42`）⇒ 按 **UTC+8** 解释。
 *
 * ## ⚠️ 本文件必须零 `node:*` 依赖
 *
 * 与 `provider-registry.ts` 同因：它可能被客户端产物（esbuild）引用。
 */
/** 一条静态兜底模型。远端目录**不返回** ctx 与档位 ⇒ 只能由本表提供。 */
export interface MagicrewFallbackModel {
    readonly id: string;
    readonly name: string;
    readonly contextWindow: number;
    readonly maxTokens?: number;
    /** 实测上游认 7 档，但强度不被区分 ⇒ 只声明「关闭 / 开启」两档。 */
    readonly reasoningEfforts?: readonly string[];
    readonly defaultReasoningEffort?: string;
    readonly supportsImage?: boolean;
}
export interface MagicrewProduct {
    /** provider id。国内 `magicrew`、国际 `magicrewintl`（全小写、无连字符）。 */
    readonly id: 'magicrew' | 'magicrewintl';
    readonly site: 'cn' | 'intl';
    readonly displayName: string;
    /** 业务 API 与模型网关共用同一个 host（与 magpie 侧 `SITES` 一致）。 */
    readonly host: string;
    /** 网页 origin（`Origin` 头必带，缺了偶发 403）。 */
    readonly webOrigin: string;
    /**
     * 该站是否**强制**要求 `organization-code`。
     *
     * 实测：国内站不强制（缺了仍 200）；国际站缺了会被上游拒 —— 但**形态分两种**
     *（二审更正，原注释把两者混成一句）：
     * - 业务 API `/api/v1/*`：`{"code":2182,"message":"用户所在组织不存在"}`
     * - 聊天网关 `/v1/*`：⚠️ **形态未定**。参考实现记的是「HTTP 500 + 22 字节裸文本」，
     *   但 2026-11-01 用真实 apiKey 实测缺 org 时仍是 HTTP 200 + 正常 SSE ⇒ **不写死**
     */
    readonly needsOrgOnGateway: boolean;
    readonly defaultCredentialRef: string;
    readonly requestTimeoutMs: number;
    readonly chatHeaderTimeoutMs: number;
    /**
     * 目录 GET 失败后的**退避窗口**（负缓存）。
     *
     * ⚠️ 没有它时「失败」在 TTL 门里**不是一种状态**（`catalogAt` 仍是 0）⇒
     * 每条消息都会再发一次目录 GET + 一条 warn：一次上游抖动就会让整段对话
     * 每轮多一次超时请求。成功即清零，故正常路径不受影响。
     */
    readonly catalogRetryMs: number;
    /** SSE 两字节之间的上限。推理模型可能长时间无输出。 */
    readonly chunkTimeoutMs: number;
    readonly fallbackModels: readonly MagicrewFallbackModel[];
}
export declare const MAGICREW_SESSIONS_PATH = "/api/v1/sessions";
export declare const MAGICREW_GATEWAY_TOKENS_PATH = "/api/v1/model-gateway/tokens";
export declare const MAGICREW_MODELS_PATH = "/api/v1/flows/models";
export declare const MAGICREW_MODEL_POINTS_PATH = "/api/v1/products/model-points";
export declare const MAGICREW_POINTS_PATH = "/api/v1/quota/points/total";
export declare const MAGICREW_CHAT_PATH = "/v1/chat/completions";
/**
 * 每日登录积分（= 真正的「每日签到」）。
 *
 * `POST <host>/api/v1/login-gift`，**请求体存在且为空串 `''`**（不是省略 body
 * —— 照这句注释删掉 `body: ''` 就是协议回归），幂等，每天一次。
 * - 国内站（超级麦吉）：**+200 / 天**
 * - 国际站（MagiCrew）：**+50 / 天**
 * - 当天已领 → HTTP 仍 200，但 body 里 `granted: false` +「今日已领取登录积分」
 *
 * ⚠️ 两站**逐字符同构**（同一个 Go 服务），故路径是共享常量而非产品字段。
 * 来源：magpie 插件 `magpie-magicrew-auth/src/tasks.mjs:1-21` 的实测注释
 * （2026-10-27 用真实网页登录抓包得到 `magicrew.ai` 的 `/login-gift`）。
 */
export declare const MAGICREW_LOGIN_GIFT_PATH = "/api/v1/login-gift";
/**
 * 新手引导任务（=「新人奖励」）。
 *
 * - 查询：`GET <host>/api/v1/onboarding/tasks`
 * - 完成：`PUT <host>/api/v1/onboarding/tasks/<code>/completion`（body 为 `{}`）
 *
 * 国内站 8 项，其中 7 项 PUT 即完成；第 8 项 `first_ai_work`
 * 服务端回 **`9303`「该新人引导任务不支持手动完成」**，必须真发一条消息才置位。
 * **每个账号一辈子一次**。
 *
 * ⚠️ 「8 项合计 500 积分」这个数字**在参考实现里查不到依据**（`api.mjs` 与
 * `tasks.mjs` 只说了 8 项 / 7 项可 PUT，没给总分）⇒ 本仓不写死它，一切以
 * 上游 `tasks[].points` 为准（`fetchMagicrewOnboardingStatus` 现场累加）。
 *
 * ⚠️⚠️ **国际站这个接口恒返回 `{participant_type: null, tasks: []}`** ——
 * 那是「该账号没被登记进引导计划」，**不是**「已经领完了」。别把 0 项当成功
 * 上报「新手福利 0 项已全部完成」（magpie 0.3.7 犯过这个错）。
 * ⇒ 本插件照做（代码在，能领就领），但国际站预期就是「拿不到」。
 */
export declare const MAGICREW_ONBOARDING_TASKS_PATH = "/api/v1/onboarding/tasks";
/** 账号池凭据 ref 前缀（`jet-hub-store.ts` 的前缀表必须同步）。 */
export declare const MAGICREW_ACCOUNT_PREFIX = "MAGICREW_ACCOUNT_";
/**
 * 思考档位：**只有两档**。
 *
 * 实测（2026-10-28，`deepseek-v4.1-flash`，`max_tokens=1024`，解题类提问）：
 *
 * | 载荷 | `reasoning_tokens` |
 * |---|---|
 * | 裸请求（不发该字段） | 54（**默认就在思考**） |
 * | `none` | **0**（真关闭，正文变成完整推导 1311 字符） |
 * | `minimal` / `low` / `medium` / `high` / `xhigh` / `max` | 72 / 91 / 87 / 51 / 77 / 88 |
 * | 非法值 | HTTP 400（`must be one of: none, minimal, low, medium, high, xhigh, max`） |
 *
 * ⇒ 上游**接受** 7 档，但 `reasoning_tokens` **不单调**（51~91 波动）⇒ 强度**不被区分**。
 * 声明 7 档会让用户以为能调强度（假的）；一档都不声明则用户**无法关闭思考**。
 * ⇒ 只声明 `none`（关）与 `high`（开）。
 *
 * ⚠️ 上行前必须按本集合过滤：上游对非法值回 **400**，目录腐坏会给出非法值。
 */
export declare const MAGICREW_REASONING_EFFORTS: readonly string[];
export declare const MAGICREW_DEFAULT_EFFORT = "high";
/**
 * `max_tokens` 下限。
 *
 * 实测（`max_tokens=64`，图片提问）：`mimo-v2.6-flash` 正常答出 "Red"，
 * 而 `deepseek-v4.1-flash` / `glm-5.3-flash` 的 `finish_reason` 是 **`length`**、
 * `content` 是**空串**（64 个 token 被 reasoning 吃满）。
 * ⇒ 用户看到「模型不回复」，而上游 HTTP 200、零报错。
 */
export declare const MAGICREW_MIN_MAX_TOKENS = 512;
/**
 * **目录里没有该 id 时**的兜底上下文窗口。
 *
 * ⚠️ 给大不给小：给 1M 而实际 128K ⇒ 上游超限报错（用户看得见）；
 * 给 256K 而实际 1M ⇒ agent 主动拒绝本可处理的对话（**静默的能力损失**）。
 *
 * 参考 codearts 的真实报障：`contextWindow === undefined` 时
 * `dsh-client-ui-conversation` 的 `contextOccupancy()` 返回 `null`、
 * `ContextMeter` 整条不渲染 ⇒ 用户看不到占用条，自动压缩阈值也失去唯一输入。
 */
export declare const MAGICREW_FALLBACK_CONTEXT_WINDOW = 1048576;
export declare const MAGICREW: MagicrewProduct;
/**
 * **Magicrew 国际站**（MagiCrew，`www.magicrew.ai`）。
 *
 * ## 为什么是独立 provider 而不是 `MAGICREW` 的站点参数
 *
 * 判据与 `minimaxintl` / `autoclawintl` 同款（见 `src/minimax-product.ts` 文件头）：
 *
 * | 判据 | 国内（超级麦吉） | 国际（MagiCrew） |
 * |---|---|---|
 * | 展示名 | 超级麦吉 | MagiCrew |
 * | 网页 | `www.letsmagic.cn` | `www.magicrew.ai` |
 * | API host | `i-magic-service.letsmagic.cn` | **`magic-service.magicrew.ai`** |
 * | 登录体系 | 手机号 / 短信验证码 | 邮箱 / OAuth |
 * | 每日签到 | +200 / 天 | **+50 / 天** |
 * | 强制 org | 否（缺了仍 200） | **是**（缺了业务 API 回 `code 2182`「用户所在组织不存在」；
 *   聊天网关 `/v1/*` 的形态**未定**，实测 apiKey 形态下仍 200） |
 *
 * 账号体系物理隔离（同一个 Go 服务，但数据面分开）⇒ 必须是独立 provider，
 * 否则一个 provider 下会混进两套 host 的账号，选号器与余额全错位。
 *
 * ## ⚠️ `api.magicrew.ai` 不是这套 API
 *
 * 它是 teamshare 网关（`MAGIC_GATEWAY_ADDRESS`），对 `/v1/models`、`/api/v1/*`
 * 一律回 `not match rule path`。真实业务 API 是 **`magic-service.magicrew.ai`**
 * —— 来源：`GET https://www.magicrew.ai/workspace` 的 HTML 里内嵌的运行时配置
 * `"MAGIC_SERVICE_BASE_URL":"https://magic-service.magicrew.ai"`
 * （`MAGIC_APP_ENV: "international-prod"`）。
 *
 * ## ⚠️ 实现零复制
 *
 * `MagicrewAuth` / `MagicrewService` / `MagicrewAdapter` / 目录 / 积分 / 资料
 * 全部复用国内版那一套，**只有本常量不同**（与 `autoclawintl` 同纪律：
 * 复制会让同类缺陷修两遍）。
 */
export declare const MAGICREW_INTL: MagicrewProduct;
/** 按 id 取静态兜底条目；未登记返回 `undefined`（**不编造**）。 */
export declare function magicrewFallbackModelOf(modelId: string): MagicrewFallbackModel | undefined;
//# sourceMappingURL=magicrew-product.d.ts.map