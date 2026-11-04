/**
 * 百智云**网页版登录**：开一个**独立 profile** 的浏览器窗口，让用户在
 * `baizhi.cloud` 控制台完成登录，再把控制台那两枚 cookie（`sl-session` +
 * `baizhi_session`）读回来。
 *
 * ## 为什么百智云也要浏览器登录（两个理由）
 *
 * 1. **模型 Key 可以自动取**：`GET https://baizhi.cloud/api/v1/user/api-keys`
 *    用网页登录态直接返回**明文** `items[].key`（实测 2026-11-02：
 *    `{"items":[{"id":188069570000001,"name":"demo-user","key":"sk-…"}]}`）
 *    ⇒ 用户只要登进去，插件就能自动建号，不需要去控制台翻 API Key 页抄。
 * 2. **积分只有登录态能读**：`/api/v1/user/wallet/balance`、
 *    `/api/v1/user/wallet/app-credit-usage` 只认 cookie；拿 `sk-` 走
 *    `x-api-key` 一律 401。只填 Key 的账号「能发消息但看不到积分」，
 *    而用户明确要求卡片上要显示积分（2026-11-02 报障）。
 *
 * ## ⚠️ 与 monkeycode 版的差异：这里要读**两枚** cookie
 *
 * 控制台同时下发 `sl-session`（设备/风控会话）与 `baizhi_session`（登录会话），
 * 实测**两枚都要带上**才能通过（只带 `baizhi_session` 时 `/api/v1/user/profile`
 * 会 401）。故本模块把它们拼成一个 `Cookie` 头字符串返回，调用方原样存进
 * 凭据的 `session_cookie`。
 *
 * ## ⚠️⚠️ 必须按 `domain === 'baizhi.cloud'` **精确**匹配
 *
 * `baizhi-cookies.json` 里实测有**三枚** `sl-session`：一枚属于 `baizhi.cloud`，
 * 另两枚分别属于 `ai-models.app.baizhi.cloud` 与 `agent-toolkit.app.baizhi.cloud`。
 * 用「后缀包含」判据会随机拿到网关那枚 —— 它不是控制台会话。
 *
 * ## 读 cookie 只能用 `Storage.getCookies`
 *
 * `chromium-session.ts:1406-1420` 的实测结论：浏览器级端点只认
 * `Target.*` / `Storage.*` / `Browser.*`，**没有 `Network.getCookies`**；
 * 读 cookie 的唯一可用命令是 `Storage.getCookies`，且不需要 `sessionId`。
 *
 * @module src/baizhi-browser-login.ts
 */
import { type BaizhiProduct } from './baizhi-product.js';
/** 控制台域名（cookie 必须**精确**落在这个域上）。 */
export declare const BAIZHI_CONSOLE_HOST = "baizhi.cloud";
/** 等待用户完成登录的上限（毫秒）：与 magicrew / monkeycode 同档。 */
export declare const BAIZHI_BROWSER_LOGIN_TIMEOUT_MS = 240000;
/** 轮询间隔（毫秒）。 */
export declare const BAIZHI_BROWSER_LOGIN_POLL_MS = 500;
/** 一个已起好浏览器的网页登录会话。 */
export interface BaizhiBrowserLogin {
    /** 收掉浏览器（**幂等**，必须在 `finally` 里调）。 */
    close(): void;
    /**
     * 等用户在窗口里登完并读到控制台 cookie。
     *
     * 返回拼好的 `sl-session=…; baizhi_session=…` 串；**绝不抛错** ——
     * 用户没登完 / 自己关窗 / 超时都是正常路径，返回 `undefined`。
     */
    waitForSessionCookie(timeoutMs?: number): Promise<string | undefined>;
}
/** 浏览器会话的最小依赖面（便于单测注入假会话）。 */
export interface BaizhiLoginSession {
    cdp: {
        send: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
    } | undefined;
    readonly exited: boolean;
    start(): Promise<void>;
    dispose(): void;
    readonly userDataDir: string | undefined;
}
/** 起浏览器用的选项。 */
export interface BaizhiLoginSessionOptions {
    executablePath: string;
    hideWindow: boolean;
    windowSize: string;
    profilePrefix: string;
    initialUrl: string;
    label: string;
    notFoundHint: string;
    readyTimeoutMs?: number;
    log?: (message: string) => void;
}
/** `createChromiumBaizhiLogin` 的依赖（生产缺省全接线；单测逐个注入）。 */
export interface BaizhiBrowserLoginDeps {
    /** 产品常量（只用于登录页地址与诊断文案）。 */
    product?: BaizhiProduct;
    /** 浏览器探测（缺省 {@link findBrowserExecutable}；可注入以测「找不到」那条路）。 */
    resolveBrowser?: () => string | undefined;
    /** 平台（只影响「找不到浏览器」的文案措辞）。缺省 `process.platform`。 */
    platform?: NodeJS.Platform;
    /** 显式指定可执行文件（跳过探测）。 */
    executablePath?: string;
    /** 浏览器就绪上限（缺省 `ChromiumSession` 的 30 秒）。 */
    readyTimeoutMs?: number;
    /** 等待用户完成登录的上限。 */
    timeoutMs?: number;
    /** 轮询间隔。 */
    pollIntervalMs?: number;
    /** 读 cookie 原语（缺省 {@link readBaizhiSessionCookieViaCdp}；单测注入）。 */
    readCookie?: (session: BaizhiLoginSession) => Promise<string | undefined>;
    /** 等待原语（单测注入 ⇒ 零真实等待）。 */
    sleep?: (ms: number) => Promise<void>;
    /** 时钟（单测注入）。 */
    now?: () => number;
    /** 诊断输出（缺省静默）。 */
    log?: (message: string) => void;
    /** 浏览器会话工厂（单测注入 ⇒ 完全不起浏览器）。 */
    sessionFactory?: (options: BaizhiLoginSessionOptions) => Promise<BaizhiLoginSession>;
}
/**
 * 通过浏览器级 CDP 读控制台 cookie，拼成 `Cookie` 头。
 *
 * 顺序固定为 `sl-session` → `baizhi_session`（与浏览器实际下发顺序一致）。
 * 两枚**都读到**才算登录完成：只读到一枚时返回 `undefined` 继续等，
 * 因为那通常意味着「用户还在登录页、登录会话 cookie 尚未写入」。
 *
 * ⚠️ **任何一步失败都返回 `undefined` 而不抛**：轮询里抛错会把「还没登完」
 * 显示成「登录失败」，而窗口明明还开着。
 */
export declare function readBaizhiSessionCookieViaCdp(session: Pick<BaizhiLoginSession, 'cdp'>): Promise<string | undefined>;
/**
 * 起浏览器并打开百智云控制台（**独立 profile、可见窗口**）。
 *
 * 找不到浏览器 ⇒ 抛 `BrowserDeploymentError('browser-not-found')`，
 * 文案由 {@link browserNotFoundMessage} 生成（按平台说人话 + 回显候选清单）。
 */
export declare function createChromiumBaizhiLogin(deps?: BaizhiBrowserLoginDeps): Promise<BaizhiBrowserLogin>;
/** {@link startBaizhiBrowserLogin} 的选项。 */
export interface BaizhiBrowserLoginStartOptions {
    /** 产品配置；默认 {@link BAIZHI}。 */
    product?: BaizhiProduct;
    /** 等待用户完成登录的上限（毫秒）。 */
    timeoutMs?: number;
    /** 浏览器工厂（单测注入）。 */
    sessionFactory?: (options: BaizhiLoginSessionOptions) => Promise<BaizhiLoginSession>;
    /** 诊断输出。 */
    log?: (message: string) => void;
}
/**
 * 起一次网页登录（便捷包装）。
 *
 * 调用方**必须**在 `finally` 里 `login.close()`。
 */
export declare function startBaizhiBrowserLogin(options?: BaizhiBrowserLoginStartOptions): Promise<BaizhiBrowserLogin>;
//# sourceMappingURL=baizhi-browser-login.d.ts.map