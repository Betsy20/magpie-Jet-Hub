/**
 * AutoClaw 凭据获取、本地探测、短信验证码快速登录与 Token 刷新。
 */
import { type AutoclawProduct } from './autoclaw-product.js';
import { type AutoclawCredential } from './autoclaw.js';
export declare const AUTOCLAW_SEND_CODE_PATH = "/userapi/v1/agent-send-code";
export declare const AUTOCLAW_LOGIN_PATH = "/userapi/v1/agent-login";
/** Z.ai **授权端点**（国际版）。⚠️ 不是 `https://chat.z.ai/auth` —— 那是登录页前端路由，见上方实测。 */
export declare const AUTOCLAW_ZAI_AUTH_URL = "https://chat.z.ai/api/oauth/authorize";
/**
 * Z.ai OAuth 的 `client_id` —— **只用于降级路径**，正常路径由服务端下发。
 *
 * ## ⚠️⚠️ 只用这个值自己拼**不成立**（2026-11-02 第三轮真机证伪）
 *
 * 它来自一次真实授权 URL（两次采样逐字节相同）。但真机复现时，用同一个 `client_id`
 * + 已注册端口 + 自造 `state` 打 `/api/oauth/authorize`，服务端回
 * `{"detail":"Redirect URI not registered for this client"}` —— 端口与路径都已经被
 * 上一轮修对了，仍被拒。
 *
 * 客户端实现里**没有**这个常量：它走 `POST /userapi/overseasv1/zai-oauth-url`
 * 拿 `{oauth_url, state}`。⇒ 真正成立的是「服务端按 `navigate_uri` 现注册一组」，
 * 而不是「某个固定的 (client_id, redirect_uri) 组合」。
 *
 * ⇒ 生产路径见 `fetchAutoclawZaiAuthUrl`；这里保留常量只为「服务端不可达时仍能渲染出
 * 可点的链接」这一降级分支，且页面会显式告知用户可能失败。
 */
export declare const AUTOCLAW_ZAI_CLIENT_ID = "client_EnD0QI8bLRFT8cciLp389Q";
/** OAuth 换 token 端点（`overseasv1` 命名空间，仅国际站有）。 */
export declare const AUTOCLAW_ZAI_EXCHANGE_PATH = "/userapi/overseasv1/zai-oauth-login";
/** Google OAuth 换 token 端点（对照用）。 */
export declare const AUTOCLAW_GOOGLE_EXCHANGE_PATH = "/userapi/overseasv1/google-oauth-login";
/** OAuth 回调路径（与客户端同款：`/auth/callback-zai`）。 */
export declare const AUTOCLAW_OAUTH_CALLBACK_PATH = "/auth/callback-zai";
/** OAuth 回调端口候选（与客户端 `OAUTH_CALLBACK_PORTS` 逐字相同）。 */
export declare const AUTOCLAW_OAUTH_CALLBACK_PORTS: readonly number[];
/**
 * 生成 Z.ai OAuth 的 `state`。
 *
 * 形态对齐官方：`aosi.<base64url(JSON)>`。官方那个 JWT 里 `dh = SHA256(deviceId)`
 * **已破解**、`nh` **未解**，但服务端不硬校验内容（见上方实测表）⇒ 我们只放
 * 一个能自证「这是本轮流程」的随机串，不做任何防伪。
 *
 * ⚠️ **它必须非空**：`/api/oauth/authorize` 缺 `state` 直接回 **422**（实测），
 * 这正是 2026-11-02 那次「点完按钮、登录成功、回调永不发生」的根因。
 */
export declare function autoclawZaiState(now?: number): string;
/**
 * 按顺序尝试监听**注册过的回调端口**（{@link AUTOCLAW_OAUTH_CALLBACK_PORTS}）。
 *
 * ## ⚠️⚠️ 为什么不能 `listen(0)` 随机端口（2026-11-02 真机，第二处报障）
 *
 * Z.ai 的 `/api/oauth/authorize` 对**已登录**用户会校验 `redirect_uri` 白名单，
 * 未注册的端口直接回一段 JSON：
 *
 * ```
 * {"detail":"Redirect URI not registered for this client"}
 * ```
 *
 * 实测端点是随机端口 `60768`。而 `AUTOCLAW_OAUTH_CALLBACK_PORTS` 正是官方客户端
 * 注册的那几个 —— 它在本次接线之前是**零消费**常量（审查员登记过「与 `listen(0)`
 * 冲突，若服务端做端口白名单会直接死在授权页」，现在被真机证实）。
 *
 * ⚠️ 未登录时**看不出**这个问题：那时 `/api/oauth/authorize` 一律 307 到登录页，
 * 不做白名单校验 ⇒ 「curl 探针 307」**不能**当成「端口没问题」的证据。
 *
 * ## 回退策略
 *
 * 4 个端口全被占用 ⇒ 回退 `listen(0)`。此时 OAuth 一定登不上（未注册），但本地页
 * 仍能打开 —— 用户至少能看到授权页并拿到一条可诊断的失败，而不是「窗口都起不来」。
 * 回调里对这种情况已经会返回「授权失败」的可见文案。
 *
 * @param server - 只需 `listen` / `once` / `removeListener`（单测因此可以注入替身）。
 * @param candidates - 候选端口，按顺序尝试。
 */
export declare function listenOnCallbackPorts(server: AutoclawCallbackListenable, candidates?: readonly number[]): Promise<void>;
/** `listenOnCallbackPorts` 需要的最小 server 面（结构类型，便于单测注入替身）。 */
export interface AutoclawCallbackListenable {
    listen: (port: number, host: string) => unknown;
    once: (event: 'listening' | 'error', listener: () => void) => unknown;
    removeListener: (event: 'listening' | 'error', listener: () => void) => unknown;
}
/**
 * 构造 Z.ai 授权 URL。
 *
 * @param redirectUri - 回调地址（`http://127.0.0.1:<port>/auth/callback-zai`）。
 * @param state - **必填**（见 {@link autoclawZaiState}）。回调时原样带回，用于认领本轮流程。
 */
export declare function buildAutoclawZaiAuthUrl(redirectUri: string, state: string): string;
/**
 * 由**服务端签发**授权 URL 的端点（`overseasv1`，仅国际站）。
 *
 * ## 为什么必须走它，而不是自己拼（2026-11-02 第三轮真机报障）
 *
 * 自己拼的 URL 在真机上被 Z.ai 拒绝：
 * `{"detail":"Redirect URI not registered for this client"}`。
 * 客户端实现（`dist/main.cjs`）里根本没有 `client_id` 常量 —— 它的顺序是：
 *
 * ```js
 * // 1) 起 loopback，拿到 navigate_uri
 * // 2) 向服务端要授权地址
 * const t = await this.post('/userapi/overseasv1/zai-oauth-url', { navigate_uri });
 * const oauthUrl = a.data.oauth_url, state = a.data.state;   // ← 服务端签发
 * // 3) 打开 oauthUrl；回调拿 code+state；4) POST zai-oauth-login
 * ```
 *
 * ⇒ **`(client_id, redirect_uri, state)` 是服务端按 `navigate_uri` 现注册的一组**。
 * 我们照抄过一次真实 URL 里的 `client_id`，但那一组的 `state` 已随上一轮流程失效
 * ⇒ 服务端找不到「这个 redirect_uri 属于哪个 state」，于是报成「redirect_uri 未注册」。
 * 这个报错文案极具误导性 —— 它让人以为是端口/路径问题（实际都改对了）。
 *
 * @param navigateUri - 回调地址，必须与 `zai-oauth-login` 的 `navigate_uri` 逐字节相同。
 */
export declare const AUTOCLAW_ZAI_AUTH_URL_PATH = "/userapi/overseasv1/zai-oauth-url";
/** 服务端签发的授权参数。 */
export interface AutoclawZaiAuthorization {
    /** 直接可以打开的授权页地址（已含 `client_id` / `redirect_uri` / `state`）。 */
    authUrl: string;
    /** 服务端签发的 `state`，回调时原样带回，比对用。 */
    state: string;
}
/**
 * 向服务端申请一次授权：返回**授权页地址**与配套的 `state`。
 *
 * 失败时**不抛**（返回 `{ ok: false, error }`）—— 调用方（登录页）要把原因显示出来。
 */
export declare function fetchAutoclawZaiAuthUrl(navigateUri: string, options?: LoginAutoclawWithCodeOptions): Promise<{
    ok: true;
    value: AutoclawZaiAuthorization;
} | {
    ok: false;
    error: string;
}>;
/**
 * 用授权码换 token（国际版 Z.ai OAuth）。
 *
 * ## 与国内版 HTTP 请求的差别：**必须带完整 managed 头**
 *
 * 客户端 `createZworkManagedRequestHeaders` 里除了签名头还有三个：
 * `X-Version`（客户端版本）/ `X-Tm`（平台 `win`）/ `X-Product`（`autoclaw`）。
 *
 * ⚠️ **实测对照（2026-10-20）**：缺这三个头时服务端回
 * `410000 用户未登录`（看起来像「没登录」但其实**压根没进登录逻辑**）；
 * 补齐后回 `631001 User login error`（= 进了逻辑、code 无效）。
 * ⇒ 三个头是**必需**的，缺了会被误诊成「凭据问题」。
 *
 * @param code - 授权码（回调 URL 的 `code`）。
 * @param state - 授权页原样带回的 `state`（透传，不解析）。
 * @param navigateUri - 与授权时**完全相同**的回调地址。
 */
export declare function exchangeAutoclawZaiCode(code: string, state: string, navigateUri: string, options?: LoginAutoclawWithCodeOptions): Promise<LoginAutoclawWithCodeResult>;
/**
 * AutoClaw 客户端版本号（`X-Version` 头用）—— **单一真相源在 `autoclaw-product.ts`**。
 *
 * ⚠️ 此处不再重复定义（2026-10-20）：`X-Version` 是国际站推理的硬校验头
 *    （缺它 → HTTP 500 空响应体），两处各写一份 `'2.1.1'` 必然漂移，
 *    统一从 `autoclaw-product.js` 导入（见 `AUTOCLAW_CLIENT_VERSION` 的注释）。
 */
/** 手机号格式正则（中国大陆11位手机号）。 */
export declare const PHONE_NUMBER_RE: RegExp;
/**
 * 从本地 Windows DPAPI 及 AES-256-GCM 探测 AutoClaw 桌面端保存的有效凭据（一键导入模式）。
 *
 * ## ⚠️⚠️ 凭据来源是**用户真实凭据**，故必须可隔离（2026-10-17 审计 P0 修复）
 *
 * 本函数会真读 `%APPDATA%\AutoClaw-official\` 并**真跑 powershell 解 DPAPI**
 * （约 1s）⇒ 单测里若不隔离，用户装了 AutoClaw 桌面端时就会读到**他的真实
 * access/refresh token**（本仓库 `.office-claw` 未隔离事故的同型，见
 * `tests/setup-isolation.ts` 的长注释）。
 *
 * ⇒ 新增 `DSH_AUTOCLAW_APPDATA` 覆盖：**优先级高于 `APPDATA`**，
 *   `tests/setup-isolation.ts` 在**进程级**把它指向临时目录
 *   （与 `DSH_OFFICEACE_HOME` / `DSH_JET_HUB_STATE_DIR` 同型）。
 * ⚠️ 为什么不用「在用例里改 `APPDATA`」：`apply()` 内部有 fire-and-forget 的
 *   后台链，用例的 `afterEach` 恢复环境变量**之后**那条链才跑到本分支 ⇒
 *   与 officeace 那次事故同型，唯一可靠做法是进程级。
 */
export declare function probeAutoclawLocalCredential(options?: {
    customAppData?: string;
    /**
     * **产品配置**（推荐形态）—— 目录名从 `product.userDataDirName` 取。
     *
     * ⚠️ 与下面的 `appDirName` 二选一，`product` 优先。新增调用点**必须**用它
     * （而不是自己拼目录名），否则又会出现「三个读点各写一份」的事故形态。
     */
    product?: AutoclawProduct;
    /**
     * 客户端 userData 目录名（**低层逃生口**，仅测试/特殊场景用）。
     *
     * ⚠️ **国内版与国际版是同一客户端的两份构建**（`isOversea` 是构建期常量），
     * 但 userData 目录名不同 —— 实测（2026-10-20）：
     * - 国内构建：`AutoClaw-official`
     * - 国际构建：`AutoClaw-oversea-official`
     *
     * ⇒ 生产调用点一律传 `product`，别在这里写死（原实现硬编码国内目录，
     *   导致国际版**永远导入不到**自己的凭据；审计 P0 就是漏了本函数的
     *   `/autoclaw/import-local` 那个调用点）。
     *
     * @default AUTOCLAW.userDataDirName（`'AutoClaw-official'`）
     */
    appDirName?: string;
}): Promise<AutoclawCredential | undefined>;
/**
 * 刷新 AutoClaw Token。
 */
export declare function refreshAutoclawToken(refreshToken: string, options?: {
    product?: AutoclawProduct;
    fetchImpl?: typeof fetch;
    deviceId?: string;
    /**
     * **单次请求**超时（毫秒）；缺省 {@link AUTOCLAW_REQUEST_TIMEOUT_MS}（60s）。
     *
     * ⚠️ 存在的理由（2026-10-27 审计 P2-2）：本函数**依次试两个端点**
     * （`/userapi/v1/refresh` 与 `/agent-refresh`），各用 60s ⇒ 调用方光等刷新
     * 就可能 **120s**。签到那条腿若用它，用户点「一键领取」最坏要等
     * `2×60 + 15 = 135s`（实测真实挂钟 **120,015ms** 只差 claim 那段），
     * 而修复前上界是 15s ⇒ 9 倍。
     *
     * ⇒ 让调用方按自己的预算覆盖它（签到腿用 {@link AUTOCLAW_CLAIM_REFRESH_TIMEOUT_MS}）。
     */
    timeoutMs?: number;
}): Promise<AutoclawCredential>;
/**
 * 校验 AutoClaw 凭据是否连通可用。
 */
export declare function testAutoclawConnection(accessToken: string, options?: {
    product?: AutoclawProduct;
    fetchImpl?: typeof fetch;
}): Promise<boolean>;
export interface SendAutoclawCodeOptions {
    product?: AutoclawProduct;
    fetchImpl?: typeof fetch;
    deviceId?: string;
}
export interface SendAutoclawCodeResult {
    ok: boolean;
    msgid?: string;
    error?: string;
}
export interface LoginAutoclawWithCodeOptions {
    product?: AutoclawProduct;
    fetchImpl?: typeof fetch;
    deviceId?: string;
}
export interface LoginAutoclawWithCodeResult {
    ok: boolean;
    credential?: AutoclawCredential;
    error?: string;
}
/**
 * 向手机号发送 AutoClaw 登录验证码（/userapi/v1/agent-send-code）。
 */
export declare function sendAutoclawVerificationCode(phone: string, options?: SendAutoclawCodeOptions): Promise<SendAutoclawCodeResult>;
/**
 * 使用手机验证码登录 AutoClaw 并兑换凭据（/userapi/v1/agent-login）。
 */
export declare function loginAutoclawWithCode(phone: string, code: string, options?: LoginAutoclawWithCodeOptions): Promise<LoginAutoclawWithCodeResult>;
export interface StartedAutoclawSmsLoginFlow {
    readonly loginUrl: string;
    readonly result: Promise<{
        credential: AutoclawCredential;
        phone: string;
    }>;
    readonly close: () => Promise<void>;
}
export interface AutoclawSmsLoginFlowOptions {
    product?: AutoclawProduct;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    deviceId?: string;
}
/**
 * 启动本地独立服务器承载 AutoClaw 登录授权页（支持一键读取本地凭据或手机验证码登录）。
 */
export declare function startAutoclawSmsLoginFlow(options?: AutoclawSmsLoginFlowOptions): Promise<StartedAutoclawSmsLoginFlow>;
//# sourceMappingURL=autoclaw-oauth.d.ts.map