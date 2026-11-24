/**
 * Raccoon Work 登录与续期的纯 API 层。
 *
 * ## 两条登录路径
 *
 * 1. **微信扫码**（首选）：`code` 由**客户端本地随机生成**，服务端只做轮询查询。
 *    实测任意自造 code 都被接受并进入 `pending`，故完全绕开官方那条
 *    `office-raccoon://auth/callback` 自定义协议回调 —— 那是本插件（宿主侧
 *    Node 进程）无法接收的。
 * 2. **短信验证码**（次选）：手机号需 AES-128-CFB 加密，且 `send_sms` 要求
 *    先过阿里云滑块拿到 `captcha_param`。
 *
 * ## 为什么不用官方桌面端的授权码链路
 *
 * `desktopLogin.js` 走「网页授权 → `office-raccoon://auth/callback?code=` →
 * `POST /login_with_authorization_code`」。回调地址在网页里是**写死的**，
 * 改不成 localhost，插件收不到回调。故该链路只保留 `exchangeRaccoonAuthorizationCode`
 * 供将来（如支持自定义协议的环境）复用。
 *
 * ## 本模块是纯 API 层
 *
 * 不含本地 HTTP 服务器（那是 `raccoon-login-page.ts` 的职责），
 * 也不做凭据持久化（那是 `raccoon-auth.ts` 的职责）。全部函数可离线单测。
 */
import { type RaccoonCredential } from './raccoon.js';
import { type RaccoonProduct } from './raccoon-product.js';
/**
 * 扫码轮询的状态值。
 *
 * ⚠️ `expired` **不是服务端下发的状态值** —— 它由我们在 IAM 回
 * `AUTH_QRCODE_INVALID`（HTTP 401）时合成（官方前端同款映射）。
 */
export type RaccoonQrStatus = 'pending' | 'logging' | 'canceled' | 'success' | 'expired';
/** 一次扫码轮询的结果。 */
export interface RaccoonQrPollResult {
    status: RaccoonQrStatus;
    /** 仅 `success` 时存在。 */
    accessToken?: string;
    /** 仅 `success` 时存在。 */
    refreshToken?: string;
    /** 仅 `success` 时存在（毫秒时间戳字符串）。 */
    expiresAt?: string;
    /** 仅 `logging` 时存在（二维码有效期）。 */
    expiredAt?: string;
}
/**
 * 一次扫码会话的**服务端签发**票据。
 *
 * ⚠️⚠️ 2026-11-14 起，`qrcode_code` **不再由客户端生成** —— 必须由 IAM 的
 * `POST /api/iam/v1/auth/mp/qrcode` 签发（形如 `qr-<uuidv7>`），二维码落地页
 * 用服务端下发的 `scan_path` 拼。
 *
 * 旧的「本地随机 32 位 hex」在**新**轮询端点上恒回
 * `401 {"code":"AUTH_QRCODE_INVALID"}`（见 Gitee IKVA90）；而**旧**轮询端点
 * 对任意字符串恒回 `pending`（僵尸端点）⇒ 症状是「扫码后插件一直转圈、零报错」。
 */
export interface RaccoonQrTicket {
    /** 服务端签发的 `qrcode_code`。 */
    code: string;
    /** 二维码落地页路径（服务端下发，形如 `/login/mp`）。 */
    scanPath: string;
    /** 本张二维码的有效期（毫秒）。 */
    expiresInMs: number;
    /** 服务端要求的轮询间隔（毫秒）。 */
    pollIntervalMs: number;
}
/**
 * 向 IAM 申请一张扫码票据。
 *
 * 依据官网登录组件的 `createQr()`：`POST /auth/mp/qrcode`（其 `t()` 的
 * `baseUrl = '/api/iam/v1'`），并校验 `qrcode_code` / `scan_path` 为字符串、
 * `expires_in ∈ (0, 3600]`、`poll_interval > 0`。
 * 实测返回 `{ qrcode_code: 'qr-…', scan_path: '/login/mp', expires_in: 300, poll_interval: 2 }`
 * （`expires_in` 与 `poll_interval` 的单位都是**秒**）。
 *
 * ⚠️ 签发失败必须**抛出**（而不是退回本地随机 code）—— 本地随机 code 在新端点上
 * 100% 被拒，静默退回只会把「明确失败」变成「一直转圈」。
 */
export declare function createRaccoonQrTicket(product: RaccoonProduct, fetcher?: typeof fetch): Promise<RaccoonQrTicket>;
/**
 * 构造二维码承载的登录页 URL。
 *
 * 依据官网 `5348-…js`：`new URL(scan_path, qrOrigin)` 后 `search = ''`，再
 * `set('code', qrcode_code)` / `set('appname', brand)` / `set('source', 'platform')`。
 * `qrOrigin` 取自服务端渲染数据（实测 `https://xiaohuanxiong.com/`），与
 * `product.apiBase` 同源，故直接以它作 base。
 *
 * ⚠️ 该页面在 2026-11-14 实测**全部 404**（`/login/mp` 及其变体都是
 * `__next_error__`，只有 `/login/mp/` 回 308 再 404）——`scan_path` 名为
 * `/login/mp`，疑似**小程序页面路径**被误用于 web 端。我们仍按官方拼法生成
 * （页面恢复后自然可用），但 `raccoon-login-page.ts` 必须同时给出
 * 「用手机 App 扫码」的兜底提示，不能只给一个打不开的二维码。
 */
export declare function buildQrImageUrl(product: RaccoonProduct, ticket: RaccoonQrTicket): string;
/**
 * 轮询一次扫码登录状态（走 IAM 新端点）。
 *
 * ⚠️ **任何异常都降级为 `pending`**（网络抖动、响应畸形、未知 status）：
 * 轮询是 2 秒一次的循环，偶发失败不应中断整个登录流程；而把未知状态
 * 误判成 `success` 会让流程拿到空 token 后卡死，误判成 `canceled` 则会让
 * 用户正在扫码的二维码被无故刷新。
 *
 * ⚠️⚠️ **终态有两个码，必须都认**（2026-11-15 真机实测）：
 * - `401 AUTH_QRCODE_INVALID`：code 不是 IAM 签发的（乱码/伪造）
 * - `410 AUTH_QRCODE_EXPIRED`：这张票曾经有效，但已过 `expires_in`
 *   （签一张真票等它自然到期，`t+305s` 实测回这个）
 *
 * 两者都必须让页面重新签发（我们合成为 `expired`）。**不能降级成 `pending`**：
 * 那样页面会永远转圈，而这正是 2026-11-14 之前「扫码后插件一直转圈、零报错」
 * 的症状（Gitee IKVA90）。
 *
 * ⚠️ 反向对照：**5xx 绝不能被当成过期**（否则上游抖一下就会无限重签）。所以这里
 * 只认精确的 401/410，不写 `httpStatus >= 400`（对抗审计 S2）。
 *
 * ⚠️ 旧端点 `/api/web/auth/v1/login_with_qrcode_code` 已是**僵尸端点**：对任意
 * 字符串恒回 `{"code":0,…,"status":"pending"}`（实测），不再推进任何状态。
 * 保留它只会让「二维码早就失效」看起来像「一直在等」。
 */
export declare function pollRaccoonQrLogin(product: RaccoonProduct, code: string, fetcher?: typeof fetch): Promise<RaccoonQrPollResult>;
/**
 * 下发短信验证码。
 *
 * ⚠️ 手机号必须 AES-128-CFB 加密（否则 `100003 params_encryted_error`）。
 * ⚠️ `captcha_param` 是阿里云滑块验证码的产物，**必需**（否则
 * `100006 captcha_verify_error`）。
 */
export declare function sendRaccoonSmsCode(product: RaccoonProduct, phone: string, captchaParam: string, fetcher?: typeof fetch): Promise<void>;
/**
 * 用短信验证码登录。
 *
 * @returns 完整凭据（`expires_at` 由 JWT 的 exp 推算）。
 * @throws 验证码错误/过期、手机号非法、网络失败。
 */
export declare function loginRaccoonWithSmsCode(product: RaccoonProduct, phone: string, smsCode: string, fetcher?: typeof fetch): Promise<RaccoonCredential>;
/**
 * 用授权码换取凭据（官方桌面端链路）。
 *
 * 本插件**当前不走这条路**（收不到自定义协议回调），保留它是为了让
 * 「官方链路」有可单测的落点，并在将来支持自定义协议时可直接复用。
 */
export declare function exchangeRaccoonAuthorizationCode(product: RaccoonProduct, authorizationCode: string, fetcher?: typeof fetch): Promise<RaccoonCredential>;
/**
 * 用 refresh_token 换新凭据。
 *
 * ⚠️ 服务端可能**只返回新的 access_token**（不带新 refresh_token），
 * 此时必须**保留旧值** —— 否则续期一次就把账号变成不可续期。
 * ⚠️ 服务端不返回的附加字段（昵称、身份、设备号）也要保留。
 * ⚠️ 401 表示 refresh_token 已失效，**抛「请重新登录」且不重试**。
 */
export declare function refreshRaccoonCredential(product: RaccoonProduct, credential: RaccoonCredential, fetcher?: typeof fetch): Promise<RaccoonCredential>;
/**
 * 拉取用户信息（展示用）。
 *
 * ⚠️ 失败时返回**空对象**而不是抛错：用户信息只用于昵称展示，
 * 不该因为它失败而让整个登录流程失败（登录已经成功了）。
 *
 * ⚠️ `nickname` 取的是远端的 `name`，而**它是服务端自动生成的默认名**
 *（实测 `RaccoonAva`），微信扫码不回传微信昵称 —— 故多账号消歧要靠 `phone`。
 */
export declare function fetchRaccoonUserInfo(product: RaccoonProduct, credential: RaccoonCredential, fetcher?: typeof fetch): Promise<{
    userId?: string;
    nickname?: string;
    officeIdentity?: string;
    phone?: string;
}>;
//# sourceMappingURL=raccoon-oauth.d.ts.map