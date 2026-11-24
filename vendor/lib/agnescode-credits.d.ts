/**
 * AgnesCode 的积分余额原语（订阅积分池，只读）。
 *
 * ## 口径（这是本文件最容易被后来者改错的地方）
 *
 * 上游给的是**一个订阅池的两个标量桶**：
 * - `permanent_balance`：平台自己叫「永久」；
 * - `time_sensitive_balance`：会过期，但**不给任何逐笔日期**（只有聚合值）。
 *
 * ⇒ 「限时」那一桶必须置 `expiryUnknown: true`。本仓红线（Issue IKTLMX）：
 *   「没有 `deductionEndTime`」在展示层会被读成**真·永久**，于是卡片写
 *   「永久 3000」—— 而它其实会作废。把「上游没给日期」说成「永不到期」
 *   正是那个 issue 的原始缺陷。
 *
 * ⚠️ `permanent_balance` **不标** `expiryUnknown`：那是平台明说的永久，
 * 反过来一律标未知会让「永久」这一类读数失真（Loomy 那种明说永久的必须还是永久）。
 *
 * ⚠️ 不反推日期（`remaining / 每日领取量 = 天数` 只在「每天都领」时成立，
 * 那是乐观上界，不是事实）。
 *
 * @module src/agnescode-credits.ts
 */
import type { AgnescodeProduct } from './agnescode-product.js';
import type { ProviderBalanceDetail } from './provider-runtime.js';
/**
 * 查余额（带原因）。
 *
 * `credential` 是**已落库的 JSON 字符串**（`ProviderCredits` 的通用契约：
 * 端点表把 `entry.credentialRef` 解析出来的原值直接传进来）。
 */
export declare function fetchAgnescodeBalanceDetailed(product: AgnescodeProduct, credential: unknown, fetcher?: typeof fetch): Promise<ProviderBalanceDetail>;
//# sourceMappingURL=agnescode-credits.d.ts.map