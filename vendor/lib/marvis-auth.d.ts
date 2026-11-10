/**
 * 腾讯 Marvis 的认证服务：OAuth 兑换、续期、资料回填与账号池适配。
 *
 * ## 两条登录腿
 *
 * | 腿 | 入口 | 用在哪 |
 * |---|---|---|
 * | 浏览器截获回调 | `loginViaBrowser('1'|'2')` | 面板「新建账号」的 QQ / 微信 |
 * | 从 magpie 导入 | `readMagpieCredential()`（宿主**自己**读
 *   `~/.config/magpie/plugin-auth.json`） | 已经在本机 magpie 里登过的用户（一键迁移） |
 *
 * 两条腿产出**同一种** `MarvisCredential`，区别只在换 code 的方式。
 *
 * ## ⚠️ 为什么 `exchangeCode` 必须带 `Ual-Access-Guid`
 *
 * 2026-11-09 真机 A/B（假 code，只读）：
 * `?login_type=QC&code=…` ⇒ `-109 RC_PARAMS_INVALID`；guid 放 query ⇒ 同样 -109；
 * guid 放 `Ual-Access-Guid` 请求头 ⇒ `-107 RC_NO_AUTH_ERR`（参数过关、code 假）。
 * ⇒ 兑换**只能**由 Node 侧带头发起，浏览器顶层导航永远做不到（这也是
 *   `marvis-browser-login.ts` 必须在 Request 阶段截停的原因）。
 *
 * @module src/marvis-auth.ts
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { type CredentialRef } from '@deepseek-ai/dsh-credentials';
import type { AccountPool } from './account-pool.js';
import { type MarvisBrowserLogin } from './marvis-browser-login.js';
import { type MarvisProduct } from './marvis-product.js';
import { type MarvisCredential } from './marvis.js';
/** 凭据库的最小接口（与宿主 `ctx.credentials` 同形，值恒为字符串）。 */
/**
 * magpie 的凭据文件位置（magpie 与插件共用 `~/.config` 约定）。
 *
 * ⚠️ 路径**在调用时**才算（`homedir()`），不要在模块顶层算成常量：单测会把
 * `HOME`/`USERPROFILE` 指到临时目录，顶层常量会读到真实用户目录 —— 那样
 * 「没装 magpie 时要回可读错误」这条用例会变成读开发机的真文件（假绿/假红都
 * 取决于开发机上有没有登过）。
 */
export declare function magpieAuthPath(): string;
/** `readMagpieMarvisCredential` 的返回：凭据 **或** 一句可读的原因。 */
export type MagpieImportResult = {
    credential: MarvisCredential;
} | {
    error: string;
};
/**
 * 直接读本机 magpie 的 `plugin-auth.json`，取出 `marvis` 那一条。
 *
 * ## 为什么由宿主读、而不是让用户复制粘贴
 *
 * 2026-11-09 用户报障：弹窗里放一个 textarea 让用户自己去
 * `~/.config/magpie/plugin-auth.json` 里抄一段 JSON，既要求用户会找文件、
 * 又要精确复制（漏一个 `}` 就被判成「凭据不完整」）。可这个文件本来就在
 * **本机**、而且是**插件自己**能读的位置 ⇒ 没有任何理由把这件事外包给用户。
 *
 * `readFile` 可注入：单测用它喂临时文件，生产走 `readFileSync`。
 */
export declare function readMagpieMarvisCredential(options?: {
    path?: string;
    readFile?: (path: string) => string;
}): MagpieImportResult;
export interface MarvisCredentialStore {
    resolve(ref: CredentialRef): Promise<{
        value: string;
    } | undefined>;
    set(ref: CredentialRef, value: string): Promise<void>;
    unset(ref: CredentialRef): Promise<void>;
}
/** 面板用的只读登录状态。 */
export interface MarvisLoginStatus {
    configured: boolean;
    /** 登录来源（`'qq'` / `'wechat'` / `'magpie'`）。 */
    source?: string;
    expiresAt?: number;
    refreshable: boolean;
    /** 最近一次续期失败的原因（如有）。 */
    refreshError?: string;
}
export interface MarvisAuthOptions {
    product?: MarvisProduct;
    fetchImpl?: typeof fetch;
    warn?: (message: string) => void;
    store?: MarvisCredentialStore;
    /** 浏览器登录工厂（单测注入 ⇒ 完全不起浏览器）。 */
    browserLoginFactory?: (options: {
        loginType: '1' | '2';
        guid: string;
        state?: string;
        /**
         * 等用户完成授权的总时长（毫秒）。
         *
         * ⚠️ 2026-11-09 评审 M2：这个字段原先**只在调用点**存在、被 `as` 断言从类型里
         * 抹掉 ⇒ 默认工厂收不到它，`createChromiumMarvisLogin` 的会话准备超时与
         * 调用方想要的等待时长**脱钩**。类型里写出来，工厂才有机会自己决定怎么用。
         */
        timeoutMs?: number;
    }) => Promise<MarvisBrowserLogin>;
    /** 时钟（单测注入）。 */
    now?: () => number;
    /**
     * 读 magpie 凭据文件用的实现（单测注入）。
     *
     * ⚠️ 生产必须走默认的 `readFileSync`：这不是「可配置」而是「可测」——
     * 单测若去读真实 `~/.config/magpie/plugin-auth.json`，结果会取决于开发机
     * 上有没有登过 Marvis（假绿），也可能把真实凭据喂进断言。
     */
    readFile?: (path: string) => string;
}
/** 从 magpie 的 `plugin-auth.json` 片段导入凭据。 */
export declare function importCredentialFromMagpie(raw: string): MarvisCredential | undefined;
/** 把 Set-Cookie 列表解析成 name → value（值做 decodeURIComponent）。 */
export declare function parseMarvisCookies(headers: Headers): Record<string, string>;
export declare class MarvisAuth extends Service {
    readonly product: MarvisProduct;
    private readonly fetchImpl;
    private readonly warnImpl;
    private readonly store;
    private readonly browserLoginFactory;
    private readonly now;
    /** 读 magpie 凭据文件的实现（单测注入；生产走 `readFileSync`）。 */
    private readonly readFile;
    private active;
    constructor(ctx: Context, options?: MarvisAuthOptions);
    private warn;
    private storeFor;
    /** 读指定 ref 的凭据；解析失败当「没有」（一次凭据库损坏不该炸掉整轮续期）。 */
    currentCredential(refName?: string): Promise<MarvisCredential | undefined>;
    /**
     * 用回调 URL 里的 code 换凭据（**唯一**一次使用 code）。
     *
     * ⚠️ 成功响应是 **302 + Set-Cookie**（不是 JSON）；错误响应才是 JSON
     * `{code:-107|-109}`。
     */
    exchangeCode(params: {
        code: string;
        loginType: '1' | '2';
        guid: string;
        state?: string;
    }): Promise<MarvisCredential>;
    /**
     * 取账号资料（昵称 / 头像）。
     *
     * ⚠️ **失败返回空对象、绝不抛**：昵称只是展示名，取不到不该挡登录
     * （与 magicrew `withProfileNickname` 同一条纪律）。
     * ⚠️ 只带 business 签名头，**不带** `Ual-Access-Access-Token`（magpie 实测带了会 500）。
     */
    fetchUserProfile(credential: MarvisCredential): Promise<{
        nickname?: string;
        avatar?: string;
    }>;
    /**
     * 网页登录（QQ / 微信）：起浏览器 → 截停回调 → 换 code → 补昵称。
     *
     * @returns 凭据；用户没登完 / 自己关窗 / 超时 ⇒ `undefined`（**不是异常**）。
     */
    loginViaBrowser(loginType: '1' | '2', options?: {
        timeoutMs?: number;
    }): Promise<MarvisCredential | undefined>;
    /** 面板状态：只看池里有没有该 provider 的账号。 */
    /**
     * 从本机 magpie 的 `plugin-auth.json` 直接读 Marvis 凭据。
     *
     * 面板上的「从 magpie 导入」走这条：用户不需要找文件、不需要复制。
     */
    readMagpieCredential(): MagpieImportResult;
    status(pool?: AccountPool): Promise<MarvisLoginStatus>;
    /**
     * 续期**指定账号**并写回账号池。
     *
     * ⚠️ 续期响应的 `access_token` 与旧值**相同**（Marvis 只重置有效期），
     * `refresh_token` 可能回空串 ⇒ **必须保留旧值**（否则账号变单向门）。
     */
    refreshAccountCredential(refName: string, pool: AccountPool, accountId: string): Promise<void>;
    /** 批量续期（调度器入口）；只看 lead-time，不看 enabled / refreshable。 */
    refreshAll(pool: AccountPool): Promise<void>;
    /** 对账：过期且能续期的账号返回其 id（面板状态用）。 */
    checkExpired(pool?: AccountPool): Promise<readonly string[]>;
    /** 登出（阻止在途续期回写）。 */
    logout(): Promise<void>;
    /** 插件被停用时调用。 */
    stop(): void;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        marvisAuth: MarvisAuth;
    }
}
//# sourceMappingURL=marvis-auth.d.ts.map