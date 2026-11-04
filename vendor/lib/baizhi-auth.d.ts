/**
 * 百智云（BaiZhiCloud）认证服务。
 *
 * ## 与其余 provider 的**根本差异：没有登录流程，也不能续期**
 *
 * 百智云的凭据是**长期静态 API Key**（`sk-` 开头，实测 67 字符；由「大模型商店」生成，
 * 也可手工粘贴 —— 三审 F🟡-9：主路径已是浏览器登录 + 商店），
 * 既没有 OAuth 授权页，也没有 refresh 端点，更不下发 `expires_at`：
 *
 * - 因此**不实现** `login()` / `startLogin()` —— 本 provider 的入口是 Jet Hub
 *   面板上的**粘贴 Key 弹窗**（与 `qiniu` / `opencode` 同型）；
 * - `refresh()` / `refreshAccountCredential()` / `refreshAll()` 只做
 *   **有效性对账**（重读凭据 + 回写 `expiresAt`），**不假装续期成功** ——
 *   与 `qiniu` 同类，但理由更根本：百智云按量计费、Key 长期有效，压根没有
 *   「快过期」这回事。
 *
 * ## ⚠️ `refreshAll()` 既不看 `enabled` 也不看 `refreshable`
 *
 * AGENTS.md 的铁律：停用只影响「账号池的自动选号」，与「凭据是否需要保持新鲜」
 * 无关；`refreshable` 只是**凭据材料的镜像**，拿它当门禁会把一次瞬时失败
 * 固化成永久状态。百智云的凭据恒 `refreshable:false`，用 `refreshable` 过滤
 * 会让**一条都进不来**。
 *
 * ## 服务名
 *
 * 由产品 id 派生为 `baizhiAuth`（cordis 的 `Service` 同名二次注册会抛错，
 * 故每个 provider 各占一个服务名）。
 *
 * @module src/baizhi-auth.ts
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { type BaizhiCredential } from './baizhi.js';
import { type BaizhiProduct } from './baizhi-product.js';
import { type BaizhiBrowserLogin, type BaizhiBrowserLoginStartOptions } from './baizhi-browser-login.js';
import { exchangeBaizhiSessionForKey } from './baizhi-credits.js';
import { AccountPool } from './account-pool.js';
/** 用于 Jet Hub 面板的只读登录状态。 */
export interface BaizhiLoginStatus {
    configured: boolean;
    /** 恒为 `'api-key'`：凭据是长期静态 Key（浏览器登录 / 大模型商店 / 手工粘贴三条来源），不是 OAuth 换来的。 */
    source?: string;
    expiresAt?: number;
    /** 恒为 `false`（百智云没有续期机制）。 */
    refreshable: boolean;
    /** 最近一次对账失败的原因（如有）。 */
    refreshError?: string;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** 百智云的认证服务实例。 */
        baizhiAuth: BaizhiAuth;
    }
}
/** 从存储值解析凭据 JSON；解析失败返回 `undefined`。 */
export declare function parseBaizhiCredential(value: string): BaizhiCredential | undefined;
/** `BaizhiAuth` 的构造选项。 */
export interface BaizhiAuthOptions {
    /** 产品配置；默认 {@link BAIZHI}。 */
    product?: BaizhiProduct;
    /** 服务名覆盖（默认由产品 id 派生为 `baizhiAuth`）。 */
    serviceName?: string;
    /**
     * 浏览器登录工厂（缺省 {@link startBaizhiBrowserLogin}；单测注入 ⇒ 零浏览器）。
     *
     * ⚠️ 注入点存在只为单测：真机上这条路径会 `spawn` 一个可见窗口。
     */
    browserLoginFactory?: (options: BaizhiBrowserLoginStartOptions) => Promise<BaizhiBrowserLogin>;
    /**
     * 网页登录态 → `sk-` Key 的兑换原语（缺省 {@link exchangeBaizhiSessionForKey}）。
     *
     * 抽成注入点是为了单测能覆盖「换不到 Key」「401 后重试成功」两条路，
     * 而不必发真网络。
     */
    exchangeKey?: typeof exchangeBaizhiSessionForKey;
}
/**
 * 百智云认证服务：**凭据保管与有效期对账**（无续期；登录走 `loginViaBrowser()`）。
 */
/** 浏览器登录读回来的**登录态**（只有 cookie，没有推理 Key —— 见下）。 */
export interface BaizhiBrowserSession {
    readonly session_cookie: string;
    readonly nickname?: string;
    readonly user_id?: string;
}
export declare class BaizhiAuth extends Service {
    /** 本实例所属的产品配置。 */
    readonly product: BaizhiProduct;
    /** 本实例默认读写的凭据 ref 名称（`BAIZHI_ACCESS_TOKEN`）。 */
    readonly credentialRefName: string;
    /** 浏览器登录工厂（可在单测里换成假实现）。 */
    private readonly browserLoginFactory;
    /** 网页登录态 → `sk-` Key 的兑换原语。 */
    private readonly exchangeKey;
    /**
     * 实例是否还活着。
     *
     * ⚠️ 插件卸载后 `loginViaBrowser` 仍在等浏览器（最长 240 秒），此时**不能**
     * 再把凭据写回宿主 —— `stop()` 会把它置 `false`，循环每轮先判一次。
     */
    private active;
    constructor(ctx: Context, options?: BaizhiAuthOptions);
    /**
     * 面板状态：只看**池里有没有该 provider 的凭据**（与其余 provider 的门控
     * 判据完全一致：都只看账号池，不为单凭据 ref 开例外）。
     */
    status(pool?: AccountPool): Promise<BaizhiLoginStatus>;
    /**
     * 单凭据路径的「续期」。
     *
     * ⚠️ **这里不发出任何网络请求，也不写凭据** —— 百智云没有 refresh 端点。
     * 它只做一次**有效性对账**：凭据不可读时抛可读错误（引导用户重新粘贴），
     * 可读时静默通过。**绝不返回「续期成功」的假象**。
     */
    refresh(): Promise<void>;
    /**
     * 按**凭据 ref** 对账指定账号（RPC `account.refresh` 的分派目标）。
     *
     * ⚠️ 签名里的 `pool` / `accountId` **必须接受并透传**给 `syncAccountExpiry`：
     * 它们是「续期后把新的 `expiresAt` 回写账号池」这条链路的唯一入口
     * （issue !IKIRTT）。百智云通常没有 `expires_at` 可写，但**接口不能少** ——
     * `tests/unit/refresh-bootstrap-wiring.spec.ts` 会逐个 provider 扫这条不变式，
     * 缺参数能编译、类型全绿，但会静默丢回写。
     *
     * @param refName  账号的凭据 ref（**不是**默认单凭据 ref）。
     * @param pool     账号池；提供时才回写 `expiresAt`。
     * @param accountId 账号 id；提供时免去按凭据身份反查。
     */
    refreshAccountCredential(refName: string, pool?: AccountPool, accountId?: string): Promise<void>;
    /**
     * 批量对账（启动首轮 + 每 30 分钟的定时器）。
     *
     * ⚠️ 三条必须同时满足（见 AGENTS.md 的「续期三件事缺一不可」）：
     * 1. **不看 `enabled`**：停用账号的凭据同样要保持新鲜；
     * 2. **不过滤 `refreshable`**：它只是凭据材料的镜像（百智云恒 `false`，
     *    用它会一条都进不来）；
     * 3. **判据用凭据自己的值，不用池里的 `expiresAt`**（池值正是可能陈旧的那份）。
     *
     * 每轮仍会调用 `syncAccountExpiry`：存量账号的池值即便早已陈旧
     * （例如上一版插件从未回写过），也会在第一次运行后被自动更正。
     */
    refreshAll(pool?: AccountPool): Promise<void>;
    /**
     * **网页版登录**：开浏览器 → 用户登进百智云控制台 → 读控制台 cookie →
     * 用 cookie 换 `sk-` Key → 得到一份完整凭据。
     *
     * 返回 `undefined` = 用户没登完 / 自己关了窗口 / 超时（**正常路径**，不抛错）；
     * 抛错 = 真的失败（换不到 Key、上游 5xx、找不到浏览器）。
     *
     * ⚠️ **为什么必须重试 exchange**：控制台在用户还在登录页时就已经下发了
     *    `sl-session`（匿名会话）。若只在「两枚 cookie 都到齐」后换一次，
     *    遇到「`baizhi_session` 已写入但服务端登录态尚未生效」的边缘时刻会直接失败
     *    并把窗口收掉 —— 用户看到的就是「登录成功却报错」。
     *    ⇒ 401/403 视为「还没生效」，隔 {@link BAIZHI_SESSION_RETRY_MS} 再试，
     *    直到总体超时。
     */
    /**
     * **只取登录态**（不换 Key）—— 百智云的浏览器登录的正确定位。
     *
     * ## 为什么不是「登录后自动建号」
     *
     * 2026-11-02 真机实测推翻了我最初的假设：
     *
     * | 来源 | key 形状 | 打 `ai-models.app.baizhi.cloud` |
     * |---|---|---|
     * | 控制台「API Keys」页 `POST /api/v1/user/api-keys` | `bzy_` + 11 位（15 字符） | **401「API Key 无效」** |
     * | MonkeyCode 桌面端 `config.json` | `sk-` + 64 位（67 字符） | 200 |
     *
     * 且控制台全部 chunk 里**没有** `sk-` 字面量、也没有 model/inference 路由
     * ⇒ 推理 Key 在控制台里压根取不到。
     *
     * ⇒ 浏览器登录的产物只能是 **cookie**（查积分：`/api/v1/user/wallet/balance`），
     *   推理 Key 必须由用户手填。把两件事拆开之后：
     *   · 新建账号 = 填 `sk-`（能对话）
     *   · 卡片「登录」= 补 cookie（能看积分）
     *
     * 验活用 `fetchBaizhiProfile`（`GET /api/v1/user/profile`）：窗口刚打开时
     * 服务端就下发匿名 cookie，那时 profile 回 401 ⇒ 继续等；回 200 才是真登完。
     */
    loginSessionViaBrowser(options?: {
        timeoutMs?: number;
    }): Promise<BaizhiBrowserSession | undefined>;
    loginViaBrowser(options?: {
        timeoutMs?: number;
    }): Promise<BaizhiCredential | undefined>;
    /**
     * 注销：只停掉本实例的后台等待，**不删账号池里的凭据**。
     *
     * 百智云没有服务端注销端点（静态 Key 只能去控制台删）⇒ 这里不做网络请求。
     */
    logout(): Promise<void>;
    /** 插件卸载钩子：让在途的浏览器登录循环尽快退出。 */
    stop(): void;
    /** 凭据是否被判定为已失效（供门控与面板用）。 */
    checkExpired(pool?: AccountPool): Promise<boolean>;
    /** 读一个 ref 下的凭据（不可用或非 JSON 时返回 `undefined`）。 */
    private readCredential;
}
/**
 * 换 Key 失败时，「登录态还没生效」的错误特征。
 *
 * 与 `monkeycode-credits.ts` 的 `isMonkeycodeSessionExpiredError` 同型：
 * 401/403 是**时序问题**（用户还在登录页），其余（5xx / 网络）才是真失败。
 */
export declare function isBaizhiSessionPendingError(message: string): boolean;
//# sourceMappingURL=baizhi-auth.d.ts.map