/**
 * MonkeyCode 认证服务：**凭据保管与有效期对账**（浏览器登录 + 手工 Key 两条入口，无续期）。
 *
 * ## 与 qiniu 同型：没有 OAuth、不能续期 —— 但**有浏览器登录**
 *
 * 两种凭据都是用户在 MonkeyCode 平台（或桌面客户端）里**手工生成**的静态材料：
 *
 * - 白泽 `sk-…`：平台「API Keys」页生成；
 * - 网关 `oma_…` + `signing_secret`：平台「OhMyAgent」页生成。
 *
 * 既没有 OAuth 授权页，也没有 refresh 端点 ⇒ 不实现 `login()` / `startLogin()`，
 * **但实现了 `loginViaBrowser()`**（四审 H-2 更正：本节此前写成「无登录、入口是
 * 粘贴 Key 弹窗、不跳浏览器」，与本文件 `loginViaBrowser()` 的实现完全相反）。
 *
 * 两条入口并存，**浏览器登录是主路径**：
 *
 * - **主路径** — `account.create { mode: 'browser' }` ⇒ `loginViaBrowser()` 自己开窗、
 *   读 `monkeycode_ai_session` cookie（HttpOnly，`document.cookie` 拿不到），
 *   由宿主 `src/jet-hub-rpc.ts` 调用。一次能拿齐 `oma_…` Key + `signing_secret`
 *   + session cookie ⇒ 积分 / 额度 / 签到都有数据。
 * - **备用路径** — 面板上的**粘贴 Key 弹窗** ⇒ `monkeycode.addAccount`，同步一步
 *   完成（写凭据 + 落账号条目）。缺 session cookie 时积分与签到不可用，可事后
 *   点卡片上的「改 Key」只补这一栏。
 *
 * ⚠️ 注意与「两步式登录」的区别：`account.create` 的两步式（先返回 `loginUrl`
 * 再异步回填）是给**浏览器 OAuth** 那一类用的；本 provider 的浏览器登录走的是
 * `ChromiumSession` 读 cookie，不是 OAuth 回调。
 *
 * ## `refreshAll()` 只看凭据、**不看 `enabled`**
 *
 * 本仓库铁律：停用只影响「账号池的自动选号」，与「凭据是否需要保持新鲜」无关。
 * 本 provider 没有网络请求可发（静态材料），但**接口形态必须与其余 provider
 * 一致** —— 否则将来上游若推出 refresh 端点，这里会成为一个单向门。
 *
 * ## 服务名
 *
 * 由产品 id 派生为 `monkeycodeAuth`（cordis 的 `Service` 同名二次注册会抛错，
 * 故每个 provider 各占一个服务名）。
 *
 * @module src/monkeycode-auth.ts
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { type MonkeycodeCredential } from './monkeycode.js';
import { type MonkeycodeProduct } from './monkeycode-product.js';
import { type MonkeycodeBrowserLogin, type MonkeycodeBrowserLoginStartOptions } from './monkeycode-browser-login.js';
import { exchangeMonkeycodeSessionForKey, fetchMonkeycodeProfile } from './monkeycode-credits.js';
import { AccountPool } from './account-pool.js';
/** 用于 Jet Hub 面板的只读登录状态。 */
export interface MonkeycodeLoginStatus {
    configured: boolean;
    /**
     * 恒为 `'api-key'` —— 注意这里**不是**「用户手工粘贴」的意思（2026-11-02 五审更正）：
     * 上游既没有 OAuth 授权页也没有 refresh 端点，浏览器登录拿到的同样是一把
     * `oma_…` 静态 Key ⇒ 两种来源在凭据结构上无从分辨，一律标 `api-key`。
     */
    source?: string;
    expiresAt?: number;
    /** 恒为 `false`（上游没有续期机制）。 */
    refreshable: boolean;
    /** 最近一次对账失败的原因（如有）。 */
    refreshError?: string;
    /**
     * 凭据里是否带了平台会话 cookie。
     *
     * ⚠️ 这**不影响推理可用性**，只决定「额度 / 积分 / 签到」能不能查。
     * 单独暴露它是为了让面板能显示「未配置会话」而不是一个空洞的
     * 「查询失败」——两者对用户的行动指引完全不同。
     */
    hasSession?: boolean;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** MonkeyCode 的认证服务实例。 */
        monkeycodeAuth: MonkeycodeAuth;
    }
}
/**
 * 从存储值解析凭据 JSON；解析失败返回 undefined。
 *
 * ⚠️ 只校验主键 `access_token` 是非空字符串，**不校验前缀**：
 * 白泽 `sk-` / 网关 `oma_` 之外，上游将来可能加新前缀；把前缀写死成
 * 白名单会让新 Key 直接被判「凭据不完整」（opencode 的 IKPLRU 教训）。
 * 形状是否可用留给请求层（它会给出真实的 HTTP 错误）。
 */
export declare function parseMonkeycodeCredential(value: string): MonkeycodeCredential | undefined;
/** `MonkeycodeAuth` 的构造选项。 */
export interface MonkeycodeAuthOptions {
    /** 产品配置；默认 {@link MONKEYCODE}。 */
    product?: MonkeycodeProduct;
    /** 服务名覆盖（默认由产品 id 派生为 `monkeycodeAuth`）。 */
    serviceName?: string;
    /**
     * 浏览器登录工厂（**单测唯一该注入的东西**；生产缺省
     * {@link startMonkeycodeBrowserLogin}，即真起一个可见窗口）。
     *
     * ⚠️ 缺省值**不要**在单测里被调用 —— 那会真的拉一个 Chromium 起来。
     */
    browserLoginFactory?: (options: MonkeycodeBrowserLoginStartOptions) => Promise<MonkeycodeBrowserLogin>;
    /**
     * 会话换网关凭据的原语（单测注入；生产缺省
     * {@link exchangeMonkeycodeSessionForKey}）。
     */
    exchangeKey?: typeof exchangeMonkeycodeSessionForKey;
    /**
     * 平台用户资料读取（单测注入；生产缺省
     * {@link fetchMonkeycodeProfile}）。
     *
     * ⚠️ 必须有注入点：它是登录成功后额外一次**真网络请求**，单测若不注入就会
     * 真发到 `monkeycode-ai.com`（本仓库红线「单测不许发真网络」；本轮实测
     * 一条用例因此从 2ms 变成 4.4s）。
     */
    profileOf?: typeof fetchMonkeycodeProfile;
}
/**
 * MonkeyCode 认证服务：**凭据保管与有效期对账**（浏览器登录 + 手工 Key 两条入口，无续期）。
 */
export declare class MonkeycodeAuth extends Service {
    /** 本实例所属的产品配置。 */
    readonly product: MonkeycodeProduct;
    /** 本实例默认读写的凭据 ref 名称（`MONKEYCODE_ACCESS_TOKEN`）。 */
    readonly credentialRefName: string;
    private readonly browserLoginFactory;
    private readonly exchangeKey;
    private readonly profileOf;
    /**
     * 本实例是否仍在服役（登出 / 插件被停用时置 false）。
     *
     * ⚠️ 与 `magicrew-auth.ts` 同因：等用户登录是**分钟级**的，期间插件可能已被停用
     * 或账号已被删除。那个在途的登录若照常返回凭据，就会把一个**已停用插件的凭据**
     * 写进库 —— 之后没人续期、也没人展示它。
     */
    private active;
    constructor(ctx: Context, options?: MonkeycodeAuthOptions);
    /**
     * **网页版登录**：开一个独立 profile 的浏览器窗口，用户在官方页面上登录后，
     * 插件自动读 `monkeycode_ai_session` 并用它换一对网关凭据。
     *
     * ## 为什么这才是「跟插件搭」的那条路
     *
     * 用户明确要求（2026-11-02）：「新建账号是浏览器登录」。手工粘三格
     * （API Key / Signing Secret / Session Cookie）被判为不符合插件范式 ——
     * 尤其 cookie 是 HttpOnly 的，用户**在浏览器里根本拿不到它**。
     *
     * ## 返回 `undefined` 的两种情形（都**不是**异常）
     *
     * 1. 用户没登完就关了窗口 / 等满 `timeoutMs`；
     * 2. 等待期间本插件被停用（`this.active` 转 false）—— 同
     *    `refreshAccountCredential` 那道闸门，不能把已停用插件的凭据写进库。
     *
     * ## 抛错的唯一情形
     *
     * 已读到会话，但**换凭据失败**（`POST /api/v1/users/ohmyagent/api-keys` 拒绝 / 网络异常）。
     * 此时**不能**退化成「只有 cookie 的账号」：那种账号查得到额度却完全不能推理，
     * 在面板上长得像「已配置」而用户一用就 error —— 比明确报错更糟。
     *
     * @param options.timeoutMs 等用户登录的上限（缺省 240 秒）。
     */
    loginViaBrowser(options?: {
        timeoutMs?: number;
    }): Promise<MonkeycodeCredential | undefined>;
    /**
     * 登出：只关掉「在途登录是否还该落库」这道闸门。
     *
     * ⚠️ **不删凭据**（那是账号池 `removeAccount` 的事）：本方法只防「登出之后
     * 一个在途的网页登录回来，又把凭据写回去」。
     */
    logout(): Promise<void>;
    /** 插件被停用时调用（与 {@link logout} 同因）。 */
    stop(): void;
    /**
     * 面板状态：只看**池里有没有该 provider 的凭据**（与其余 provider 的门控
     * 判据完全一致，不为单凭据 ref 开例外）。
     *
     * ⚠️ 无池（headless / 单测）时退化为读默认 ref —— 与 qiniu 同型兼容路径。
     */
    status(pool?: AccountPool): Promise<MonkeycodeLoginStatus>;
    /**
     * 单凭据路径的「续期」。
     *
     * ⚠️ **不发任何网络请求、不写凭据**：MonkeyCode 没有 refresh 端点。
     * 它只做一次**有效性对账**：凭据不可读时抛可读错误（引导用户重新粘贴），
     * 可读时静默通过。**绝不返回「续期成功」的假象**（与 loomy / qiniu 同口径）。
     */
    refresh(): Promise<void>;
    /**
     * 按**凭据 ref** 对账指定账号（RPC `account.refresh` 的分派目标）。
     *
     * ⚠️ 签名里的 `pool` / `accountId` **必须接受并透传**给 `syncAccountExpiry`：
     * 它们是「续期后把新的 `expiresAt` 回写账号池」这条链路的唯一入口
     * （issue IKIRTT）。MonkeyCode 通常没有 `expires_at` 可写，但**接口不能少**
     * —— `tests/unit/refresh-bootstrap-wiring.spec.ts` 会逐个 provider 扫这条
     * 不变式，缺参数能编译、类型全绿，但会静默丢回写。
     *
     * @param refName   账号的凭据 ref（**不是**默认单凭据 ref）。
     * @param pool      账号池；提供时才回写 `expiresAt`。
     * @param accountId 账号 id；提供时免去按凭据身份反查。
     */
    refreshAccountCredential(refName: string, pool?: AccountPool, accountId?: string): Promise<void>;
    /**
     * 批量对账（启动首轮 + 每 30 分钟的定时器）。
     *
     * ## ⚠️ 三条必须同时满足（见 AGENTS.md 的「续期三件事缺一不可」）
     *
     * 1. **不看 `enabled`**：停用账号的凭据同样要保持新鲜；
     * 2. **不过滤 `refreshable`**：那个布尔只是**凭据材料的镜像**，拿它当门禁会把
     *    一次瞬时失败固化成永久状态。本家凭据恒 `refreshable:false`，用它会变成
     *    **一条都进不来**；
     * 3. **判据用凭据自己的值，不用池里的 `expiresAt`**：池值正是可能陈旧的那份。
     *
     * 本 provider 的「跳过」分支**只跳过对账之外的动作**，且每轮仍会调用
     * `syncAccountExpiry` —— 存量账号的池值即便早已陈旧（例如上一版插件从未
     * 回写过），也会在第一次运行后被自动更正。
     */
    refreshAll(pool?: AccountPool): Promise<void>;
    /** 凭据是否被判定为已失效（供门控与面板用）。 */
    checkExpired(pool?: AccountPool): Promise<boolean>;
    /** 把一个可解析的凭据映射成面板状态（`status()` 的两条路径共用）。 */
    private statusOf;
    /** 读一个 ref 下的凭据（不可用或非 JSON 时返回 undefined）。 */
    private readCredential;
}
//# sourceMappingURL=monkeycode-auth.d.ts.map