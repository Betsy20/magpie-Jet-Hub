/**
 * 豆包（Doubao）每日签到 —— CDP 页面会话驱动（**按账号隔离**）。
 *
 * ## 账号隔离（2026-11-03 支点验证后重写）
 *
 * **每个账号有独立的 cookie / device_id / web_id**，签到时必须严格按账号隔离：
 *
 * - **独立临时 profile**（不是豆包客户端的 User Data）：起一个干净的 Chromium，
 *   **不带**任何账号的登录态；
 * - **按账号注入 cookie**：把池里**该账号**的 cookie 用 `Network.setCookie`
 *   注入到这个干净 profile（`credentials:'include'` 读的就是它）；
 * - **按账号拼 query**：`device_id` / `web_id` / `tea_uuid` 由**该账号的
 *   `accountKey`（sessionid）确定性派生**（每账号一套 19 位数字设备号，
 *   对齐 TRAE `deriveDeviceId15` 的纪律 —— 规避服务端「每设备每天一次」
 *   配额），不是页面随机的 verify id。
 *
 * ⇒ 多账号场景下，选哪个账号就签哪个账号（实测：注入 A 号 cookie 签到，
 *   返回的是 A 号的 `checkin_date` / `continuous_days`）。
 *
 * ## 为什么不能复用豆包客户端的 User Data
 *
 * 那会固定打在「客户端当前登录的那个号」上 —— 注入的账号 cookie 会被
 * profile 里的 cookie 覆盖（同名键），且 device_id 读的是 Local State 里的
 * 当前号。这是「账号隔离失效」的真实根因（本次重写前的缺陷形态）。
 *
 * @module src/doubao-signin.ts
 */
import { type BrowserLookup } from './chromium-session.js';
export declare function doubaoSigninBrowserExecutable(lookup?: BrowserLookup): string | undefined;
/**
 * 签到找不到浏览器时的提示（分平台说人话 + 回显候选清单）。
 *
 * 与 {@link doubaoSigninBrowserExecutable} 同因：修复前那句「未找到可用的浏览器
 * （Chrome / 豆包内核）——签到需要它的 bdms 签名环境」同样**不分平台、不提变量名、
 * 不回显候选**。本仓其余五家浏览器登录都用 `browserNotFoundMessage`，豆包不该是例外。
 */
export declare function doubaoSigninBrowserHint(lookup?: BrowserLookup): string;
/** 极简 CDP 通道（Node 内置 WebSocket，零依赖）。登录会话（`doubao-login.ts`）也复用它。 */
export declare class MiniCdp {
    private readonly ws;
    private nextId;
    private readonly pending;
    private constructor();
    static connect(wsUrl: string): Promise<MiniCdp>;
    send(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<unknown>;
    close(): void;
}
/**
 * 执行豆包每日签到（**按账号隔离**：独立 profile + 注入该账号 cookie/device_id）。
 *
 * @param rawCredential 池里那份 JSON 凭据（含 `cookie` / `deviceId` / `webId`）。
 */
export declare function claimDoubaoDailyViaPage(rawCredential: string, options?: {
    log?: (msg: string) => void;
    executablePath?: string;
    timeoutMs?: number;
}): Promise<import('./credits.js').ClaimOutcome>;
//# sourceMappingURL=doubao-signin.d.ts.map