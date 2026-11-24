/**
 * Qoder「资源包」逐笔到期的两个来源（issue IKTLMX 的后续）。
 *
 * `/sash/api/v2/me/usage` 的 `addOnQuota` 只给聚合标量，卡片只能写「到期未知」。
 * 逐笔到期只能从下面两处拿到：
 *
 * 1. **网页会话明细**（准确）：`GET {官网}/api/v2/me/usages/big_model_credits`，
 *    即官方「用量明细」页的数据源。它**只认浏览器登录后的会话 Cookie**，
 *    OAuth `access_token` 一律 401（本仓与 CodexBar / CreditDaddy /
 *    qoder-trae-workbuddy-switch / TraeWorkAssistant 实测一致）⇒ 需要用户手动粘贴 Cookie。
 * 2. **本地领取记录**（推算）：每日领取的响应顶层带 `expiresAt`，领取成功时记下
 *    「金额 + 到期」。剩余额度按「先到期先扣」分摊到最晚到期的几笔上 ——
 *    扣费顺序是假设，界面文案须注明「推算」。
 *
 * 两者都没有时维持原行为（一整包「到期未知」）。
 *
 * ⚠️ Cookie 是能登录官网的会话凭据：只存凭据库（独立的 `<credentialRef>_web` 条目，
 *    随账号删除一并清理），绝不下发客户端、绝不写日志或错误消息。
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import type { CreditBalance, CreditPackage } from './credits.js';
import type { QoderProduct } from './qoder-product.js';
/** 一笔已领取的积分。 */
export interface QoderGrant {
    amount: number;
    /** 到期时刻（毫秒）。 */
    expiresAtMs: number;
}
/** 网页明细里的一笔资源包（已过滤掉用完 / 失效的）。 */
export interface QoderWebPackage {
    remaining: number;
    total: number;
    used: number;
    /** 到期时刻（毫秒）；`0` = 上游未给。 */
    expiresAtMs: number;
}
/** 拆分 `addOnQuota` 的依据。 */
export type QoderAddOnDetail = {
    kind: 'web';
    packages: readonly QoderWebPackage[];
    /**
     * ⚠️ 与 ledger 分支**对称**（2026-11-14 审计 P3）：上游可能给一笔
     * `status: ACTIVE` 但 `expires_at` **已经过去**的明细。不过滤的话它照样
     * 吃掉 `left`，随后又被客户端的 `end > at` 丢掉 ⇒ 各档合计**少于**真实余额，
     * 且 `left` 已归零 ⇒ 连「到期未知」兜底包都不产出（用户看到的总数变小）。
     * 缺省用 `Date.now()`；生产路径由调用方显式传，单测可钉死。
     */
    nowMs?: number;
} | {
    kind: 'ledger';
    grants: readonly QoderGrant[];
    nowMs: number;
};
/** 凭据库里 `<credentialRef>_web` 条目的形状。 */
export interface QoderWebStore {
    /** `k=v; k2=v2` 形状的 Cookie 头。 */
    cookie?: string;
    grants?: QoderGrant[];
}
/** 凭据服务的最小依赖面。 */
export interface QoderWebCredentials {
    resolve(ref: ReturnType<typeof credentialRef>): Promise<{
        value: string;
    } | null | undefined>;
    set(ref: ReturnType<typeof credentialRef>, value: string): Promise<void>;
    unset(ref: ReturnType<typeof credentialRef>): Promise<void>;
}
/** `parseQoderUsage` 给 `addOnQuota` 起的包名（判定「哪一包是资源包」只认它）。 */
export declare const QODER_ADD_ON_PACKAGE = "\u8D44\u6E90\u5305";
export declare const QODER_WEB_USAGE_PATH = "/api/v2/me/usages/big_model_credits";
/** 网页明细请求超时（毫秒）。 */
export declare const QODER_WEB_USAGE_TIMEOUT_MS = 10000;
export declare function qoderWebRefName(accountCredentialRef: string): string;
/**
 * 官网站点。中国版有两个域名在用（CodexBar / switch 用 `qoder.com.cn`，
 * TraeWorkAssistant 用 `qoder.cn`），Cookie 按域名隔离 ⇒ 两个都试。
 */
export declare function qoderWebOrigins(product: Pick<QoderProduct, 'id'>): string[];
export declare function loadQoderWebStore(credentials: QoderWebCredentials, accountCredentialRef: string): Promise<QoderWebStore>;
export declare function saveQoderWebStore(credentials: QoderWebCredentials, accountCredentialRef: string, store: QoderWebStore): Promise<void>;
/** 追加领取记录（顺带丢掉已过期的，按到期去重）。 */
export declare function recordQoderGrants(credentials: QoderWebCredentials, accountCredentialRef: string, grants: readonly QoderGrant[], nowMs?: number): Promise<void>;
/** 账号卡片的最小依赖面（补布尔标记只需要这一格）。 */
export interface QoderWebFlagTarget {
    credentialRef: string;
}
/**
 * 给账号列表补「是否已保存网页会话」的**布尔标记**。
 *
 * ⚠️⚠️ 只下发布尔值 —— Cookie 本身绝不下发客户端（本文件开头的红线）。
 *
 * 为什么抽成函数而不是在 `jet-hub-rpc.ts` 里就地写：那样「只下发布尔」这条
 * 不变式**零守卫** —— 把 `{ ...account, qoderWebSession: true }` 写成
 * `{ ...account, cookie: store.cookie }` 不会有任何用例变红（2026-11-14 审计 P2）。
 * 抽出来之后，`tests/unit/qoder-web-session-guards.spec.ts` 能断言
 * 「返回值序列化后不含 Cookie 明文」。
 *
 * 没会话时**不加键**（而不是 `false`）：与 `benefitOnly` / `modelscopeKeyMask`
 * 同款式，避免每个调用方都要为「多一个恒假字段」改断言。
 */
export declare function withQoderWebSessionFlag<T extends QoderWebFlagTarget>(accounts: readonly T[], credentials: QoderWebCredentials): Promise<Array<T & {
    qoderWebSession?: boolean;
}>>;
/** 把用户粘贴的内容归一成 Cookie 头：接受裸 Cookie、`Cookie: …` 行或整段 cURL。 */
export declare function normalizeCookieInput(raw: string): string;
/**
 * 把文本里的 Cookie 抹掉（出错文案的**最后一道**防线）。
 *
 * ⚠️⚠️ 为什么需要它（2026-11-14 审计 P1，端到端实测）：`cleanCookie` 修好之后
 * 正常输入不会再产生非法头值，但
 * 1. **存量坏值**（旧版本已写进凭据库的带换行 Cookie）仍会被读出来用；
 * 2. 上游/`fetch` 实现换一条错误文案就可能重新引用头值。
 * 两条都不该让 Cookie 出现在日志或客户端文案里 —— 那是本文件开头的红线
 * （「绝不下发客户端、绝不写日志或错误消息」）。
 *
 * 判据：整串命中就整串抹；否则按 **8 字符窗口**兜底（错误消息可能只引用一段），
 * 宁可多抹几个字符，不可漏。
 */
export declare function redactQoderCookie(text: string, cookie: string): string;
export type QoderWebUsageResult = {
    ok: true;
    packages: QoderWebPackage[];
} | {
    ok: false;
    authFailed: boolean;
    reason: string;
};
/**
 * 用网页会话 Cookie 取资源包逐笔明细。本身不抛；错误原因里**不含** Cookie。
 */
export declare function fetchQoderWebPackages(cookie: string, product: Pick<QoderProduct, 'id'>, fetcher?: typeof fetch, timeoutMs?: number): Promise<QoderWebUsageResult>;
/**
 * 解析 `big_model_credits` 响应，只取**个人资源包**（与 `addOnQuota` 同源）。
 *
 * 取 `resource_package_quota.quota_detail`；不取 `total_quota`：实测有账号的
 * `total_quota.quota_detail` 只列 PLAN 一条（qoder-trae-workbuddy-switch 的真机样本）。
 * 该族缺失时才回落 `total_quota` 里 `source` 以 `RESOURCE_PACKAGE` 开头的条目。
 *
 * @returns 形状不符时 `undefined`；有响应但没有可用包时 `[]`。
 */
export declare function parseQoderWebUsage(body: unknown): QoderWebPackage[] | undefined;
/**
 * `expires_at` 单位上游无文档：真机样本里同一响应同时出现毫秒与秒
 * （`1795595404000` 与 `1795595404`）⇒ 小于 1e12 的按秒处理。
 */
export declare function normalizeEpochMs(raw: number): number;
/**
 * 把一整包 `addOnQuota` 按逐笔到期拆开。拆不出任何带日期的包时返回 `undefined`
 * （调用方保留原来那一整包「到期未知」）。
 *
 * 守恒：拆出各包 `remaining` 之和恒等于 `addOn.remaining`，总余额与 sash 口径一致。
 * - 带日期部分合计多于 sash 余额（两次请求之间又用掉了一些）⇒ 按先到期先扣削掉；
 * - 少于 sash 余额（领取记录不全 / 网页明细缺日期）⇒ 差额另列一包「到期未知」。
 */
export declare function splitAddOnQuota(addOn: CreditPackage, detail: QoderAddOnDetail): CreditPackage[] | undefined;
/**
 * 把余额里那一整包「资源包」（`parseQoderUsage` 产出的 `addOnQuota`）换成逐笔到期的包。
 * 拆不出时原样返回。总额不变（`splitAddOnQuota` 守恒）。
 *
 * 刻意在查完余额**之后**做，而不是塞进 `fetchQoderBalanceDetailed`：那条调用
 * 只负责「用该账号的出口查 sash」，到期来源与它无关，混在一起会让每个调用点
 * 都要关心 Cookie / 领取记录。
 */
export declare function withQoderAddOnDetail(balance: CreditBalance | null, detail: QoderAddOnDetail | undefined): CreditBalance | null;
//# sourceMappingURL=qoder-web-usage.d.ts.map