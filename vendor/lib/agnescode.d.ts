/**
 * AgnesCode 协议层：本机会话采集 + 三个 BFF 端点 + 凭据钉扎。
 *
 * ## 这家为什么不是「一个 Key 填进去就能用」
 *
 * AgnesCode 是**桌面客户端产品**，没有面向第三方的 API Key：
 * 凭据只存在于本机 App 的 Chromium 会话文件里（`code-auth-session*.v1`），
 * 且它是**账号级数据**——文件里带着 `bffPublicBaseUrl`，国内站与国际版
 * 各自指向不同的 host。所以本 provider 的凭据是一条 **JSON**
 * `{access_token, bff_base, user_id?, nickname?, expires_at?}`，
 * 而不是一个裸 token。
 *
 * ## 三条端点（都在同一个 BFF 进程后面）
 *
 * | 用途 | 路径 | 备注 |
 * |---|---|---|
 * | 目录 | `GET {apiRoot}/v2/models` | `v2`，不是 `v1`；需要网关头闸 |
 * | 额度 | `GET {apiRoot}/api/v2/subscription/credits-balance` | **不在 `/v1` 前缀下** |
 * | 推理 | `POST {bffBase}/chat/completions` | 纯 OpenAI 兼容 |
 *
 * 网关头闸：目录端点**必须**带 `X-App-Id: 1` + `X-Platform: 1`（实测缺它恒
 * 403）。头集合声明一次、两个构造器共用，避免认证/匿名两条腿漂移成不同的
 * gate 值。
 *
 * ## 安全边界（这是本文件最重要的约束）
 *
 * `bffPublicBaseUrl` 来自**本地文件**，因此在任何 `Authorization` 头指向它
 * 之前，必须先钉扎到 Agnes 的 origin 族（https + `*.agnes-ai.cn` /
 * `*.agnes-ai.com`）。一个损坏或被篡改的会话文件绝不能把 token 送到第三方
 * host —— 那是一条凭据外泄链，不是一次「加载失败」。
 *
 * @module src/agnescode.ts
 */
import type { AgnescodeModelEntry, AgnescodeProduct } from './agnescode-product.js';
/** 会话文件名（家族匹配：国内站 `.cn.v1`、国际站 `.v1`）。 */
export declare const AGNESCODE_SESSION_FILE_PATTERN: RegExp;
/**
 * **宽松**家族（只要求以 `code-auth-session` 开头）。
 *
 * 用途只有一处：严格模式一个都没命中、但宽松模式有时，说明桌面端**换了文件形状**
 * （例如后缀改成 `.v2`）—— 那是「格式漂移」，不是「没装 App」。
 * 两件事在面板上是完全不同的结论（用户会去重装 vs 去等适配），必须分开报。
 * 与参考实现 `AGNESCODE_SESSION_FAMILY_PATTERN` 同形。
 */
export declare const AGNESCODE_SESSION_FAMILY_PATTERN: RegExp;
/** 桌面端 Chromium 配置目录（逐平台）。本仓只有 win32 有已验证的采集路径。 */
export declare const AGNESCODE_APP_DATA_CANDIDATES: ReadonlyArray<{
    platform: string;
    dirEnv: string;
    leaf: string;
}>;
/**
 * 每个 BFF 请求都带的头。
 *
 * ⚠️ `X-App-Id` / `X-Platform` 是**目录端点实测必需**的闸门（缺它 403），
 * 对另外两个端点无害。`X-User-Language` 跟随桌面端。
 */
export declare const AGNESCODE_BASE_HEADERS: Readonly<{
    Accept: "application/json";
    'Content-Type': "application/json";
    'X-App-Id': "1";
    'X-Platform': "1";
    'X-User-Language': "zh-Hans";
}>;
/** 采集结果里的一行诊断（**只带形状事实，绝不带凭据值**）。 */
export interface AgnescodeHarvestAttempt {
    file: string | null;
    tier: string;
    detail: string;
}
/** 本机采集的失败/成功分档。面板照这些码说明「到底卡在哪一层」。 */
export declare const AGNESCODE_HARVEST_TIER: Readonly<{
    OK: "ok";
    UNSUPPORTED_PLATFORM: "unsupported_platform";
    FILE_MISSING: "file_missing";
    FORMAT_DRIFT: "format_drift";
    UNREADABLE: "unreadable";
    NO_KEY: "no_key";
    DECRYPT_FAILED: "decrypt_failed";
    MALFORMED: "malformed";
    NO_TOKEN: "no_token";
    UNTRUSTED_BASE: "untrusted_base";
}>;
/** 会话解码后的形状。 */
export interface AgnescodeSession {
    accessToken: string;
    userId: string;
    nickname: string;
    bffBase: string;
}
/**
 * 钉扎 BFF base：只放行 https + Agnes 的 origin 族。
 *
 * ⚠️ 判据必须是**域名边界**（`host === apex` 或 `host.endsWith('.apex')`），
 * 不能写成 `href.includes('agnes-ai.cn')` —— 后者会放行
 * `https://api.agnes-ai.cn.evil.example/` 这种把域名当前缀的地址。
 * 这正是「凭据外泄链」的入口。
 *
 * @param raw - 会话里的 `bffPublicBaseUrl`（或手工录入的 base）。
 * @returns 去掉尾部斜杠的 base；不可信时 `null`。
 */
export declare function trustAgnescodeBffBase(raw: unknown): string | null;
/**
 * 账号级端点（`/api/...`）所对的根：BFF base **去掉** `/v1` 后缀。
 *
 * 额度端点不在 `/v1` 下，直接拼完整 base 会 404。
 */
export declare function agnescodeApiRoot(bffBase: string): string;
/** 带凭据的请求头。 */
export declare function agnescodeHeaders(credential: {
    access_token?: unknown;
}): Record<string, string>;
/**
 * 凭据的**短期指纹**：只用于「缓存是不是同一个凭据」这一个判据，**不是**安全哈希。
 *
 * ## 为什么需要它
 *
 * 目录缓存键必须含「账号身份」，否则同站两账号会互串目录（2026-11-19 双审计实测）。
 * 但只用 `accountId` 还不够：用户点「导入本机登录态」会**原地换掉该槽的凭据**
 *（同一个 accountId、不同的 token）⇒ 只按 id 缓存会让改完凭据还要等 5 分钟 TTL。
 *
 * ## 为什么是「非安全哈希」
 *
 * - 输入是**已经在内存里**的 token（同进程同对象，指纹不扩大暴露面）；
 * - 输出只喂给缓存比较，**不落盘、不进日志、不进错误文案**；
 * - 因此不需要抗碰撞，只需要「变了就能看出来」—— 用 `djb2` 足够且零依赖。
 *
 * ⚠️ 刻意**不含** `expires_at`：续期会刷新到期时间但**不该**因此重拉目录。
 */
export declare function agnescodeCredentialFingerprint(credential: {
    access_token?: unknown;
}): string;
/** 解析后的凭据（落库形态）。 */
export interface AgnescodeCredential {
    access_token: string;
    /** 钉扎后的 BFF base（**已过 {@link trustAgnescodeBffBase}**）。 */
    bff_base: string;
    user_id?: string;
    nickname?: string;
    expires_at?: number;
}
/**
 * 把落库的 JSON 字符串解析成 {@link AgnescodeCredential}；任何一处不成立都
 * 返回 `undefined`（调用方按「这个槽不可用」跳过，而不是让整家 provider 倒下）。
 */
export declare function parseAgnescodeCredential(value: string, product: AgnescodeProduct): AgnescodeCredential | undefined;
/**
 * 从 JWT 的 `exp` 取有效期（毫秒）。失败返回 `undefined`（= 「未知」，不是「已过期」）。
 *
 * ⚠️ `undefined` 与「已过期」必须分开：前者不该触发任何续期/重登动作，
 * 后者才该。把两者混成一个 `0` 会让「解析不出来的 token」被反复判失效。
 */
export declare function decodeAgnescodeJwtExpMs(token: string): number | undefined;
/**
 * Chromium `os_crypt` blob → 明文：`v10` 前缀 + AES-256-GCM（12 字节 nonce、
 * 尾部 16 字节 auth tag）。
 */
export declare function decryptAgnescodeSessionBlob(blob: Buffer | Uint8Array, key: Buffer | Uint8Array): Buffer;
/**
 * 从 `Local State` 里解出 os_crypt 密钥。
 *
 * 存储形态是 base64(`"DPAPI"` + DPAPI 密文)；DPAPI 调用**注入**进来，
 * 单测因此不需要真实 DPAPI，也不会把密钥写进任何地方。
 */
export declare function unwrapAgnescodeLocalStateKey(localStateRaw: string | Buffer | Uint8Array, dpapiUnprotect: (wrapped: Buffer) => Promise<Buffer>): Promise<Buffer>;
/**
 * 生产环境的 DPAPI 解包：PowerShell 子进程。
 *
 * 不引原生依赖、不需要构建（Host 侧零构建），密钥只在**内存**里过一道：
 * 输入以 base64 走参数、输出以 base64 走 stdout，绝不打印/落盘。
 */
export declare function defaultDpapiUnprotect(wrapped: Buffer): Promise<Buffer>;
/** 会话 JSON → 钉扎后的会话；缺 token 或 base 不可信时 `null`。 */
export declare function parseAgnescodeSession(raw: unknown): AgnescodeSession | null;
/** 按站点排序候选会话文件：本站构建优先，其次另一站，最后按名稳定排序。 */
export declare function sortAgnescodeSessionFiles(names: readonly string[], domain: 'cn' | 'intl'): string[];
/** 采集器的注入点（单测离线跑，不需要真 DPAPI / 真文件）。 */
export interface AgnescodeHarvestOptions {
    product: AgnescodeProduct;
    env?: NodeJS.ProcessEnv;
    platform?: string;
    readFileImpl?: (path: string) => Promise<Buffer>;
    readDirImpl?: (path: string) => Promise<string[]>;
    dpapiUnprotect?: (wrapped: Buffer) => Promise<Buffer>;
}
/**
 * 采集本机 AgnesCode 会话。
 *
 * 逐候选文件给一行诊断，**第一个可用会话胜出**；失败时也返回诊断行
 * （「没装 App」/「装了没登录」/「登录了但格式变了」是三件不同的事，
 * 不能统一成一句「未登录」）。
 */
export declare function harvestAgnescodeLocalSession(options: AgnescodeHarvestOptions): Promise<{
    ok: false;
    attempts: AgnescodeHarvestAttempt[];
} | {
    ok: true;
    attempts: AgnescodeHarvestAttempt[];
    session: AgnescodeSession;
}>;
/**
 * 拉账号级模型目录；读不到返回 `null`（调用方回落到 {@link AgnescodeModelEntry} 表，
 * 本家那张表**刻意留空**，见 `agnescode-product.ts`）。
 *
 * 契约细节（都是实测，不是推断）：
 * - 端点是 `/v2/models`（`/v1/models` 是另一个目录，没有倍率字段，且不按账号裁剪）；
 * - `data` 是**数组**，不套 `{code,message,data}` 信封 ⇒ 不能用统一的信封门禁；
 * - `auto` 是路由别名（只在 v2 出现、无倍率）⇒ 按 id 明确剔除，不按「有没有倍率」剔除。
 */
export declare function fetchAgnescodeCatalog(credential: AgnescodeCredential, product: AgnescodeProduct, fetcher?: typeof fetch): Promise<AgnescodeModelEntry[] | null>;
/**
 * 读账号的积分池（只读）。
 *
 * ⚠️ 这是**订阅积分池**（限时 / 永久两桶），不是「Token Plan 用量」——
 * 面板不得按配额窗口语义渲染。
 */
export declare function fetchAgnescodeBalance(credential: AgnescodeCredential, product: AgnescodeProduct, fetcher?: typeof fetch): Promise<{
    total: number;
    timeSensitive: number;
    permanent: number;
} | null>;
/**
 * 由凭据算出「有效期」（毫秒）；未知时 `undefined`。
 *
 * 优先用落库的 `expires_at`（采集时写进去的），回落 JWT 的 `exp`。
 */
export declare function agnescodeExpiryMs(credential: AgnescodeCredential): number | undefined;
/**
 * 「这枚凭据是不是已经过期了」——只用于**诊断/探测**，不参与选槽。
 *
 * ⚠️ 为什么单独抽出来（2026-11-19 二次自查）：桌面会话过期时三个端点都回 401，
 * 而目录端点把 401 吞成空数组 ⇒ 用户点「重测」看到的是「没有模型」这种**答非所问**
 * 的结论。有效期是**本地就能判**的确定性信息，用它换一句可读的原因
 * （「请在本机重新登录桌面端再导入」）比多打一次上游有用。
 *
 * ⚠️ **未知 ≠ 过期**：`agnescodeExpiryMs` 拿不到值时一律 `false`（JWT 解析失败、
 * 手工粘贴的非 JWT token 都会走到这里）——那类凭据只能靠真请求验。
 */
export declare function agnescodeSessionExpired(credential: AgnescodeCredential, now?: number): boolean;
//# sourceMappingURL=agnescode.d.ts.map