/**
 * 腾讯 Marvis **令牌钱包**读取。
 *
 * ## 数据来源（2026-11-09 真机实测）
 *
 *     POST https://yybadaccess.3g.qq.com/v3/marvis_get_wallet
 *     Ual-Access-Businessid/Timestamp/Nonce/Signature/Guid/Access-Token/Login-Type/Openid
 *     {"{}"}  ——— body 就是字面量 `{}`
 *     → {"code":0,"msg":"","data":{
 *          "openid":"…","total_tokens":"10000000","used_tokens":"0",
 *          "frozen_tokens":"0","avail_tokens":"10000000","total_cost":0,"status":1}}
 *
 * ## ⚠️ 三个必须按「字符串」读的字段
 *
 * 上游把额度都下发成**字符串数字**（`"10000000"`）。直接 `Number()` 之外的
 * 任何算术都会得到 `NaN` 或字符串拼接；`typeof === 'number'` 的判据在这里
 * **恒假** ⇒ 会静默退化成「读不到余额」。
 *
 * ## ⚠️ 没有任何日期字段
 *
 * 钱包响应里**没有**重置时间、到期时间、周期字段（8 个真实账号逐一核对）。
 * 而 Marvis 的免费额度是**按自然日回满**的（README：每日 1000 万计费 token）。
 * ⇒ 只能置 `expiryUnknown: true`，**绝不**编造一个「明天 0 点」的日期：
 * 本仓库红线是「绝不编造日期」，而「上游没给日期」不等于「永不到期」。
 *
 * @module src/marvis-credits.ts
 */
import type { CreditBalance } from './credits.js';
import { type MarvisCredential } from './marvis.js';
import { type MarvisProduct } from './marvis-product.js';
/**
 * 把额度字段收敛成安全整数。
 *
 * 接受 `number` 与**字符串数字**（实测就是字符串）；其余一律 `undefined`
 * （= 读不到），**绝不**回落成 `0` —— 0 的语义是「已用光」。
 */
export declare function readMarvisAmount(value: unknown): number | undefined;
/** 可注入的依赖（单测用；生产不传）。 */
export interface MarvisCreditsDeps {
    fetchImpl?: typeof fetch;
}
/**
 * 拉取令牌钱包余额。
 *
 * ## 为什么用 `Detailed`（失败要带原因）
 *
 * 三种失败的**用户动作完全不同**，压成笼统的「余额查询失败」会误导：
 *
 * - `401` / 业务码 `4100403` ⇒ **登录态过期** ⇒ 该续期或重新登录；
 * - `code !== 0` ⇒ 上游拒绝（常见于账号被风控/封禁）⇒ 换号，不是重新登录；
 * - `code === 0` 但缺字段 ⇒ **上游改版** ⇒ 该报「读数格式变了」，而不是「余额 0」。
 */
export declare function fetchMarvisBalanceDetailed(credential: MarvisCredential, product?: MarvisProduct, deps?: MarvisCreditsDeps): Promise<{
    balance: CreditBalance | null;
    error?: string;
}>;
//# sourceMappingURL=marvis-credits.d.ts.map