/**
 * AgnesCode 认证服务：**凭据保管 + 有效期对账 + 本机会话导入**。
 *
 * ## 这家没有 refresh，也没有 OAuth 授权页
 *
 * AgnesCode 的凭据是桌面客户端的登录态：一枚 JWT（约 28 天），没有 refresh
 * 端点。因此：
 *
 * - `refreshAll()` **不发网络请求**，只按凭据自己的 `exp` 对账池里的 `expiresAt`；
 * - `refresh()` / `refreshAccountCredential()` **绝不伪造「续期成功」**
 *   （与 qiniu / loomy / monkeycode 同口径）：凭据不可读时抛可读错误，
 *   引导用户重新导入；
 * - 进 `SELF_HEAL` 的名单里**不能有它**（那个名单是「有 refresh 端点」的镜像）。
 *
 * ## 凭据从哪来
 *
 * ① **本机导入**（主路径，Windows）：`%APPDATA%\AgnesCode` 里的
 *    `code-auth-session*.v1` + 兄弟文件 `Local State`。读取与解密全在
 *    `agnescode.ts`（纯函数 + 注入式 IO），本服务只负责「把它落成凭据」。
 * ② **手工粘贴**（备用）：用户从桌面端复制一段 JSON 或裸 token。
 *
 * @module src/agnescode-auth.ts
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { AccountPool } from './account-pool.js';
import { type AgnescodeProduct } from './agnescode-product.js';
import { harvestAgnescodeLocalSession, type AgnescodeCredential, type AgnescodeHarvestAttempt } from './agnescode.js';
/** 用于 Jet Hub 面板的只读登录状态。 */
export interface AgnescodeLoginStatus {
    configured: boolean;
    /**
     * 恒为 `'local-session'` —— 两种入口（本机导入 / 手工粘贴）拿到的都是
     * 同一枚桌面端会话 JWT，凭据结构上无从分辨。
     */
    source?: string;
    expiresAt?: number;
    /** 恒为 `false`（上游没有续期机制）。 */
    refreshable: boolean;
    /** 最近一次对账失败的原因（如有）。 */
    refreshError?: string;
}
/** 本机导入的结果：成功带凭据，失败带诊断行（**绝不带凭据值**）。 */
export type AgnescodeLocalImportResult = {
    ok: true;
    credential: AgnescodeCredential;
    attempts: AgnescodeHarvestAttempt[];
} | {
    ok: false;
    attempts: AgnescodeHarvestAttempt[];
};
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** AgnesCode（国内站）的认证服务实例。 */
        agnescodeAuth: AgnescodeAuth;
        /** AgnesCode（国际版）的认证服务实例。 */
        agnescodeintlAuth: AgnescodeAuth;
    }
}
/** `AgnescodeAuth` 的构造选项。 */
export interface AgnescodeAuthOptions {
    /** 产品配置；默认 {@link AGNESCODE}。 */
    product?: AgnescodeProduct;
    /** 服务名覆盖（默认由产品 id 派生为 `${id}Auth`）。 */
    serviceName?: string;
    /** 本机采集的注入点（单测离线跑；生产缺省走真文件 + 真 DPAPI）。 */
    harvest?: typeof harvestAgnescodeLocalSession;
}
/**
 * AgnesCode 认证服务：凭据保管 + 有效期对账 + 本机会话导入。
 */
export declare class AgnescodeAuth extends Service {
    /** 本实例所属的产品配置。 */
    readonly product: AgnescodeProduct;
    /** 本实例默认读写的凭据 ref 名称。 */
    readonly credentialRefName: string;
    private readonly harvest;
    /** 本实例是否仍在服役（登出 / 插件停用时置 false）。 */
    private active;
    constructor(ctx: Context, options?: AgnescodeAuthOptions);
    /** 登出：只关掉「在途导入是否还该落库」这道闸门（不删凭据）。 */
    logout(): Promise<void>;
    /** 插件被停用时调用（与 {@link logout} 同因）。 */
    stop(): void;
    /**
     * 读本机桌面端的登录态，**不写库**。
     *
     * 之所以把「读」和「落」分开：调用方（RPC 的 `account.create`）需要先拿它
     * 去判重（同一账号反复导入不得攒出多张卡），再决定写到哪个 ref。
     */
    importLocal(): Promise<AgnescodeLocalImportResult>;
    /**
     * 把一段手工粘贴的内容解析成凭据。
     *
     * 接受两种形态：完整 JSON（`{access_token, bff_base?}`）或**裸 token**
     * （只有一串 JWT —— 用站点常量补 base）。
     *
     * ⚠️ 裸 token 补 base 是**唯一**允许 base 缺省的路径（见 `agnescode.ts`
     * `parseAgnescodeCredential`）。
     */
    parseManual(input: string): AgnescodeCredential | undefined;
    /**
     * 把凭据写进指定 ref（`account.create` / 手工录入的落库步骤）。
     *
     * ⚠️ 等待/采集是秒级以上的过程，期间插件可能被停用 ⇒ 回来时**再判一次**
     * `active`，不能把已停用插件的凭据写进库。
     *
     * @returns 是否真的写进去了。**必须把结果交给调用方**：静默 `return` 会让
     *   `account.create` 接着 `updateAccount(...)` 并报成功，池里留下一张
     *   「有账号、没凭据」的幽灵卡（导入按钮按一次多一张，且永远不可用）。
     */
    saveCredential(credential: AgnescodeCredential, refName?: string): Promise<boolean>;
    /** 面板状态：只看池里有没有该 provider 的可用凭据（与其余 provider 同判据）。 */
    status(pool?: AccountPool): Promise<AgnescodeLoginStatus>;
    /**
     * 单凭据路径的「续期」。
     *
     * ⚠️ **不发网络请求、不写凭据**：AgnesCode 没有 refresh 端点。只做一次
     * 有效性对账：不可读时抛可读错误（引导重新导入）。
     */
    refresh(): Promise<void>;
    /**
     * 按**凭据 ref** 对账指定账号（RPC `account.refresh` 的分派目标）。
     *
     * ⚠️ `pool` / `accountId` 必须接受并透传：它们是「续期后回写 `expiresAt`」
     * 的唯一入口（`refresh-bootstrap-wiring.spec.ts` 会逐个 provider 扫这条不变式）。
     */
    refreshAccountCredential(refName: string, pool?: AccountPool, accountId?: string): Promise<void>;
    /**
     * 批量对账（启动首轮 + 每 30 分钟）。
     *
     * 与 monkeycode 逐条同款：**不看 `enabled`、不看 `refreshable`**，
     * 判据只用凭据自己的值（池里的 `expiresAt` 正是可能陈旧的那份）。
     */
    refreshAll(pool?: AccountPool): Promise<void>;
    /** 凭据是否被判定为已失效（供门控与面板用）。 */
    checkExpired(pool?: AccountPool): Promise<boolean>;
    /** 把一个可解析的凭据映射成面板状态。 */
    private statusOf;
    /** 读一个 ref 下的凭据（不可用 / 非 JSON / 形状不对时 undefined）。 */
    private readCredential;
}
//# sourceMappingURL=agnescode-auth.d.ts.map