/**
 * Marvis 的**隔离浏览器登录**：在 Request 阶段截停 OAuth 回调。
 *
 * ## 为什么不能像别的 provider 那样「等 cookie」
 *
 * Marvis 的回调端点是 `https://yybadaccess.3g.qq.com/marvis_client_login/marvis_oauth`，
 * 它**不是**登录成功的证明，而是一个**一次性 code 兑换入口**：
 *
 * - 浏览器一发出这个请求，`code` 就被消费掉了（第二次换回 `-107 RC_NO_AUTH_ERR`）；
 * - 而它**必须**带 `Ual-Access-Guid` 请求头才认参数（2026-11-09 实测：
 *   guid 放 query ⇒ `-109 RC_PARAMS_INVALID`），**浏览器顶层导航带不了自定义头**
 *   ⇒ 让浏览器真的发出这个请求，结果是页面上显示一段 JSON 错误，而我们
 *   永远拿不到能用的 code。
 *
 * ⇒ 唯一可行的做法（magpie 同款）：用 CDP 的 **`Fetch` 域**在
 * `requestStage: 'Request'` 把它**拦在发出之前**，`Fetch.fulfillRequest`
 * 喂一段静态「登录成功」页，然后把 URL 交给 Node 侧**带 guid 换唯一一次**。
 *
 * ## ⚠️ 为什么必须 `Fetch.fulfillRequest` 而不是 `Fetch.continueRequest`
 *
 * 放行就等于让浏览器真的请求了回调端点 —— 即使我们同时拿到了 URL，`code` 也
 * 已被消费（且 params 检查在前，浏览器那次必然 `-109`，code 反而**没**被消费，
 * 但这依赖上游实现细节）。`fulfillRequest` 是**确定性**的：请求根本不出网。
 *
 * @module src/marvis-browser-login.ts
 */
import { type CdpEvent } from './chromium-session.js';
import { type MarvisProduct } from './marvis-product.js';
/** 等待用户完成登录的上限（毫秒）：与 magicrew / monkeycode 同档。 */
export declare const MARVIS_BROWSER_LOGIN_TIMEOUT_MS = 240000;
/** 轮询间隔（毫秒）。 */
export declare const MARVIS_BROWSER_LOGIN_POLL_MS = 500;
/**
 * 喂给浏览器的静态完成页。
 *
 * ⚠️ 必须**自包含**（无外链、无脚本）：此时浏览器处于 `Fetch` 拦截状态，
 * 任何额外子资源都会再触发一次 `Fetch.requestPaused`，而我们只对该路径
 * 放行 ⇒ 页面会白屏等待。
 */
export declare const MARVIS_CALLBACK_PAGE = "<!doctype html>\n<html lang=\"zh-CN\"><head><meta charset=\"utf-8\">\n<title>Marvis \u767B\u5F55\u5B8C\u6210</title>\n<style>body{font:16px/1.6 system-ui,\"Microsoft YaHei\",sans-serif;margin:0;display:flex;height:100vh;align-items:center;justify-content:center;background:#f6f7f9;color:#1f2328}main{text-align:center;padding:32px 40px;background:#fff;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.06)}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#57606a}</style>\n</head><body><main><h1>\u767B\u5F55\u5DF2\u5B8C\u6210</h1><p>\u53EF\u4EE5\u5173\u95ED\u6B64\u7A97\u53E3\uFF0C\u56DE\u5230 DSH \u7EE7\u7EED\u3002</p></main></body></html>";
/**
 * 构造 Marvis 的授权页 URL。
 *
 * ## 两个平台的形状**不同**（都是 2026-11-09 真机核对过的）
 *
 * - QQ：`graph.qq.com/oauth2.0/authorize`，`state` 必须是**小数**
 *   （magpie 注释：整数会被上游拒），`login_type` 放在 redirect_uri 的 query 里；
 * - 微信：`open.weixin.qq.com/connect/qrconnect`，`state` 就是设备 guid
 *   （回调时靠它取回同一个 guid），`login_type` 同样在 redirect_uri 里。
 */
export declare function authorizeUrlOf(loginType: '1' | '2', guid: string, state?: string): string;
/**
 * 这个 URL 是不是授权回调。
 *
 * ⚠️ 只认路径**且**带 `code=` 或 `error=`：同一路径也是授权页自己的
 * `redirect_uri` 参数值，若只判路径，页面刚打开就会被当成「已回调」。
 */
export declare function isMarvisCallbackUrl(url: string, matcher?: RegExp): boolean;
/** 一个已起好浏览器的登录会话。 */
export interface MarvisBrowserLogin {
    /** 收掉浏览器（**幂等**，必须在 `finally` 里调）。 */
    close(): void;
    /**
     * 等用户在窗口里登完，返回**被截停的回调 URL**。
     *
     * ⚠️ **绝不抛错**：用户没登完 / 自己关了窗口 / 超时都是**正常路径**，
     * 返回 `undefined` 让调用方走「未完成」分支。
     */
    waitForCallbackUrl(timeoutMs?: number): Promise<string | undefined>;
}
/** 本模块对 `ChromiumSession` 的最小依赖面（便于单测注入假会话）。 */
export interface MarvisLoginSession {
    cdp: {
        send: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
        subscribe: (listener: (event: CdpEvent) => void) => () => void;
    } | undefined;
    readonly exited: boolean;
    start(): Promise<void>;
    dispose(): void;
    readonly userDataDir: string | undefined;
}
/** 起浏览器用的选项（与 `ChromiumSessionOptions` 同形，只透传本模块要用的字段）。 */
export interface MarvisLoginSessionOptions {
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
export interface MarvisBrowserLoginDeps {
    product?: MarvisProduct;
    loginType: '1' | '2';
    guid: string;
    state?: string;
    /** 浏览器探测（缺省 {@link findBrowserExecutable}）。 */
    resolveBrowser?: () => string | undefined;
    platform?: NodeJS.Platform;
    executablePath?: string;
    readyTimeoutMs?: number;
    timeoutMs?: number;
    pollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    log?: (message: string) => void;
    /** 浏览器会话工厂（单测注入 ⇒ 完全不起浏览器）。 */
    sessionFactory?: (options: MarvisLoginSessionOptions) => Promise<MarvisLoginSession>;
}
/**
 * 起浏览器打开 Marvis 授权页（**独立 profile、可见窗口**）。
 *
 * 找不到浏览器 ⇒ 抛 {@link BrowserDeploymentError}（`deployKind: 'browser-not-found'`）。
 */
export declare function createChromiumMarvisLogin(deps: MarvisBrowserLoginDeps): Promise<MarvisBrowserLogin>;
//# sourceMappingURL=marvis-browser-login.d.ts.map