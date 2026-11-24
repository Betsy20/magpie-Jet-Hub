/**
 * Raccoon Work 本地登录页（宿主侧承载弹窗页）。
 *
 * ## 为什么需要本地服务器
 *
 * 官方桌面端的登录靠 `office-raccoon://auth/callback` 自定义协议回调，
 * 而本插件是宿主侧 Node 进程，**收不到该回调**；`/code/authorize` 页面的
 * 回调地址又是写死的，改不成 localhost。故改为：
 *
 * ```
 * 本地服务器（127.0.0.1:随机端口）
 *   GET  /raccoon/login       → 弹窗页：Tab 切换「微信扫码 / 短信登录」
 *   GET  /raccoon/poll        → 前端轮询登录状态（宿主侧持有 qrcode_code）
 *   POST /raccoon/sms/send    → 提交手机号 + 阿里云 captcha_param
 *   POST /raccoon/sms/verify  → 提交验证码完成登录
 * ```
 *
 * 微信扫码的 `code` 由 **IAM 服务端签发**（`POST /api/iam/v1/auth/mp/qrcode`）。
 *
 * ⚠️ 2026-11-14 起**不能**再本地随机生成：旧端点
 * `/api/web/auth/v1/login_with_qrcode_code` 已成僵尸（对任意字符串恒回
 * `pending`、不再推进状态），新端点会直接拒发非签发 code（Gitee IKVA90）。
 *
 * ## 与其余 provider 的契约一致性
 *
 * 对外仍返回 `loginUrl`（指向本地 `/raccoon/login`），前端照常 `window.open`
 * —— 与 codearts / lobsterai / qoder / trae / cline / loomy 的「两步式」
 * 体验完全一致。
 *
 * ## ⚠️ 职责边界（安全约束）
 *
 * - **宿主侧**持有全部敏感状态：`qrcode_code`、手机号、凭据
 * - **页面侧**只做展示与表单提交：**不知道** `phoneCipherSecret`、token 等秘密
 * - 二维码由**宿主侧**生成 SVG 内联进 HTML（页面不需要任何 QR 逻辑，也不需要 CDN）
 * - 手机号加密在宿主侧的 `/raccoon/sms/send` 里完成
 */
import { type RaccoonCredential } from './raccoon.js';
import { type RaccoonQrTicket } from './raccoon-oauth.js';
import { type RaccoonProduct } from './raccoon-product.js';
/** 本地登录页的路径。 */
export declare const RACCOON_LOGIN_PAGE_PATHS: {
    readonly login: "/raccoon/login";
    readonly poll: "/raccoon/poll";
    readonly smsSend: "/raccoon/sms/send";
    readonly smsVerify: "/raccoon/sms/verify";
    /** 申请一条 `/authorize` 链接（浏览器授权的**第一步**）。 */
    readonly authorizeStart: "/raccoon/authorize/start";
    /** 查询这一轮授权的状态（第二步：等回调 / 换码结果）。 */
    readonly authorizeStatus: "/raccoon/authorize/status";
    /** 取消这一轮等待。 */
    readonly authorizeCancel: "/raccoon/authorize/cancel";
};
/** 一次登录流程的句柄。 */
export interface StartedRaccoonLoginFlow {
    /** 弹窗地址（本地服务器）。 */
    loginUrl: string;
    /** 登录结果（凭据）。 */
    result: Promise<RaccoonCredential>;
    /** 主动关闭本地服务器。 */
    close: () => Promise<void>;
}
/** `startRaccoonLoginFlow` 的选项。 */
export interface RaccoonLoginFlowOptions {
    product?: RaccoonProduct;
    /** 注入的 fetch（测试用）。 */
    fetcher?: typeof fetch;
    /** 超时（毫秒）。 */
    timeoutMs?: number;
    /**
     * 注入的「打开授权页」动作（测试用）。
     *
     * ⚠️⚠️ **单测里绝不能真的开窗**：那是**用户桌面**上的真实浏览器窗口，
     * 且它会**真的**加载授权页并（若浏览器里已有会话）**真的**投递一个回调
     * —— 那会消费掉接收端，让用例测到的东西完全不是它想测的。
     * （本仓在 officeace 那次已登记过同一条纪律：开窗的行为测试只能放 e2e。）
     */
    openAuthorizePage?: (url: string) => void;
    /**
     * 「自动打开浏览器」闸门（2026-11-23）。
     *
     * 返回 `false` ⇒ 宿主**不**打开 `/authorize` 页，改为把链接交给本地页展示
     * + 复制（与「新建账号时自动打开浏览器授权页」开关同源）。
     *
     * ⚠️ 注入点：单测传 `() => false` 就不必真开窗（本仓纪律：开窗的行为测试
     * 只能放 e2e）。缺省读宿主偏好（`login-preferences.ts`）。
     */
    autoOpenBrowser?: () => boolean;
}
/**
 * 启动登录流程。
 *
 * 立即返回 `loginUrl` 与 `result` promise，**不阻塞** —— 与其余 provider 的
 * 「两步式」约束一致（`window.open` 只在用户手势窗口内有效）。
 */
export declare function startRaccoonLoginFlow(options?: RaccoonLoginFlowOptions): Promise<StartedRaccoonLoginFlow>;
/**
 * 渲染登录页 HTML。
 *
 * 导出以便单测断言页面结构（尤其是「不含任何密钥」这条安全约束）。
 *
 * ## 页面职责
 *
 * - 两个 Tab：微信扫码（默认）与短信登录
 * - 二维码由宿主侧生成的 **SVG 内联**进来（页面不需要 QR 逻辑，也不走 CDN）
 * - 每 2 秒轮询 `/raccoon/poll`（与官方客户端一致）
 * - 短信 Tab 加载阿里云滑块脚本，拿到 `captchaParam` 后提交
 *
 * @param ticket 当前会话的**服务端签发**票据。**注意**：本函数只是把它渲染成
 *   二维码 —— 页面拿不到 `qrcode_code` 本身（它被编码进二维码图像里）。
 *   这符合职责边界：页面不需要知道 code，只需要展示。
 * @param error 申请票据失败的原因（有值时二维码区域改为可读错误 + 短信兜底提示）。
 */
export declare function renderRaccoonLoginPage(product: RaccoonProduct, ticket?: RaccoonQrTicket, error?: string): string;
//# sourceMappingURL=raccoon-login-page.d.ts.map