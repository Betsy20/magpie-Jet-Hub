/**
 * 豆包（Doubao）扫码登录 —— 浏览器会话落池。
 *
 * ## 登录形态（2026-11-03 实测）
 *
 * 打开 `https://www.doubao.com/chat/`（未登录态）→ 点击右上「登录」→
 * 页面内弹出**二维码模态框** → 用户用手机豆包 App 扫码 → 成功后
 * `.doubao.com` 种下 `sessionid` 等登录 cookie。
 *
 * ## 账号隔离（每个账号独立身份）
 *
 * - **一次性 profile**：每次登录一个全新临时目录 ⇒ 不同账号的 cookie 会话
 *   天然不串；
 * - 登录成功后从**该会话**读全量 cookie（`Storage.getCookies`，浏览器级，
 *   可读 HttpOnly —— kukuai 笔记 §5.4.5 的实测结论）落池；
 * - **设备身份**：落库时存 `accountKey`（= `sessionid`，账号稳定标识），
 *   签到时由它**确定性派生**每账号独享的 19 位数字设备号
 *   （`doubao.ts` 的 `doubaoDerivedDeviceIdentity`，对齐 TRAE
 *   `deriveDeviceId15` 的纪律）⇒ 规避服务端「每设备每天一次」配额。
 *
 * @module src/doubao-login.ts
 */
import { type BrowserLookup } from './chromium-session.js';
import { type DoubaoCredential } from './doubao.js';
export declare function doubaoLoginBrowserExecutable(lookup?: BrowserLookup): string | undefined;
/**
 * 找不到浏览器时的**用户可执行提示**（分平台说人话 + 回显候选清单）。
 *
 * ## ⚠️⚠️ 为什么必须复用 `browserNotFoundMessage` 而不是自己编一句
 *
 * 修复前那句是 `豆包登录需要本机有 Chromium 内核浏览器（Chrome / 豆包客户端），
 * 未找到可执行文件` —— 三处会把人带偏：
 *
 * 1. **不分平台**：macOS / Linux 上「豆包客户端」根本不在候选链里（那几条是
 *    `D:\Program File\Doubao\app\Doubao.exe` 这种 Windows 路径）；
 * 2. **不说变量名**：用户唯一真能自救的动作是设 `DSH_DOUBAO_BROWSER_PATH`，
 *    而原文案一个字都没提；
 * 3. **不回显候选**：报障人照着提示做只能猜。
 *
 * 这正是 Issue IKJKNT 的形态（当时 zcode 的提示让 Mac 用户去找 `chrome.exe`），
 * 共享模块的 {@link browserNotFoundMessage} 就是那次的产物 —— 本仓其余五家
 * 浏览器登录**全都**用它，豆包是唯一自己编的。
 */
export declare function doubaoLoginBrowserHint(lookup?: BrowserLookup): string;
/** CDP 通道的最小接口（只声明本文件用到的方法，便于单测注入假通道）。 */
export interface DoubaoClickCdp {
    send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
}
/**
 * 点击「登录」按钮的结果 —— **三态**（单测靠它区分「走了真鼠标事件」还是
 * 「退化成合成事件」，二者对上游风控的可信度不同）。
 */
export type DoubaoLoginClickOutcome = 'trusted' | 'synthetic' | 'not-found';
/**
 * 点击豆包页面上的「登录」按钮（弹出二维码）。
 *
 * ## ⚠️⚠️ 为什么不能只 `loginEl.click()`（Gitee issue IKV5HC 第三条）
 *
 * 修复前是 `if (loginEl) loginEl.click()`。豆包登录按钮的处理器挂在
 * `pointerdown` / `mousedown` 上（报障人实测），而 `HTMLElement.click()`
 * **只派发 `click`**，`pointerdown` / `mousedown` / `pointerup` / `mouseup`
 * 一个都不发 ⇒ 处理器不触发、二维码不弹，用户得手动点（自动点击形同虚设）。
 *
 * ⇒ 两级策略：
 *
 * 1. **真鼠标事件（首选）**：先用 `Runtime.evaluate` 取按钮**中心点**，再
 *    `Input.dispatchMouseEvent` 发 `mousePressed` + `mouseReleased` —— 这是
 *    **浏览器进程**派发的受信任事件（`isTrusted === true`），Chromium 会按
 *    标准顺序自行派生 `pointerdown` / `mousedown` / `pointerup` / `mouseup` /
 *    `click`，与用户真点一下**等价**；
 * 2. **合成事件（兜底）**：按钮存在但**拿不到盒子**（`0×0`、被浮层裁掉、
 *    `display:none` 的祖先）时，用 JS 按同一顺序 `dispatchEvent` 一整套
 *    （`pointerdown → mousedown → pointerup → mouseup → click`）。这些事件
 *    `isTrusted === false`，但对「只监听事件、不校验 isTrusted」的页面足够。
 *
 * ⚠️ 返回三态而不是 `void`：单测必须能区分「走了第 1 级」「退化到第 2 级」
 * 「按钮压根没找到」—— 只断言「没抛错」的话，把整段换成 `loginEl.click()`
 * 也照样绿（本仓「假绿」列表里的常客）。
 */
export declare function clickDoubaoLoginButton(cdp: DoubaoClickCdp, sessionId: string, log?: (msg: string) => void): Promise<DoubaoLoginClickOutcome>;
/**
 * 一次豆包扫码登录会话。用完必须 `close()`（收进程 + 删临时 profile）。
 *
 * 生命周期：`open()` → `waitForCredential()`（轮询）→ `close()`。
 */
export declare class DoubaoLoginSession {
    private readonly child;
    private readonly port;
    private readonly profileDir;
    private closed;
    private cdp;
    private readonly log;
    private constructor();
    /** 起一个**可见**浏览器窗口并打开豆包（用户要扫码）。 */
    static open(options?: {
        executablePath?: string;
        log?: (msg: string) => void;
    }): Promise<DoubaoLoginSession>;
    /**
     * 等待用户完成扫码登录，读出该账号的 cookie + 设备身份。
     *
     * ## 判定信号
     *
     * `Storage.getCookies`（浏览器级）里出现 `.doubao.com` 的 `sessionid`
     * ⇒ 登录成功。轮询期间任何 CDP 失败都**返回 `undefined` 继续**等
     * （页面在导航、用户还没扫，都不是终态）。
     */
    waitForCredential(timeoutMs?: number): Promise<DoubaoCredential | undefined>;
    /** 尝试一次：找到「登录」按钮并点击（弹出二维码）。失败不抛（用户可手动点）。 */
    private clickLoginButton;
    /** 尝试一次读凭据：`sessionid` 在 ⇒ 组装 `DoubaoCredential`。 */
    private readCredentialOnce;
    /** attach 到豆包页面拿 sessionId（每次现取 —— 页面导航会让旧 sessionId 失效）。 */
    private attachPageSession;
    /** 收掉浏览器（幂等）：杀进程 + 删一次性 profile。 */
    close(): void;
}
//# sourceMappingURL=doubao-login.d.ts.map