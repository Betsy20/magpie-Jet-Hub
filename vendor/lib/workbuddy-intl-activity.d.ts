/**
 * WorkBuddy 国际版（www.workbuddy.ai）的「每日活跃」链路。
 *
 * ## 为什么单独一个文件
 *
 * 国内版（CodeBuddy，copilot.tencent.com）的每日奖励就是一次签到：`claim`
 * 成功即到账。国际版不一样 —— 它的每日奖励**挂在活动上**，活动没开时
 * `/daily-checkin` 回 `41000`（活动未开始或已结束），此时真正驱动到账的是
 * **活跃**：上游按「当日是否活跃」异步发放。
 *
 * 活跃这件事由三个互补的端点构成（实测依据见
 * `docs/agent-notes/providers-workbuddy-intl-checkin.md`，移植自社区实现 L0NE-6/WorkBuddy-Daily
 * 的 `workbuddy_intl_daily.py`）：
 *
 * | 动作 | 端点 | 作用 |
 * | --- | --- | --- |
 * | 上报 | `POST /v2/report`（`chat_request_send` 事件） | 点亮成长中心「连登」 |
 * | 回读 | `GET /activity/growth/streak` | 读连登天数（只读，兼作上报是否生效的判据） |
 * | 网页会话 | `POST /console/as/conversations/` | 上游「当日活跃」计数**只认这一发** |
 *
 * 还有第四发（`POST /v2/chat/completions` 发一次最小对话）刻意**不移植**：
 * 它只是维持「账号有调用」，既不进「当日活跃」计数、也要烧模型额度。
 *
 * ## 契约（与 `ProviderCredits.afterClaimNote` 对齐）
 *
 * - **永不抛**：任何失败都折算成 `undefined` 或一句说明，绝不能把签到结果
 *   带成失败（本仓库有两轮「签到成功却因记账失败被报成失败」的事故史）。
 * - 返回 `undefined` 表示「没做事」（本就不该报出来，报出来是噪声）。
 * - 缺 `user_id` 时**什么都不发**：`/v2/report` 的 `userId` 是必填，缺了会被
 *   服务端**静默丢弃**（回 200，但什么也没发生）—— 那就成了一次假成功。
 */
import type { BuddyCredential } from './buddy.js';
import type { ClaimOutcome } from './credits.js';
import type { BuddyProduct } from './product.js';
/** 活跃上报端点（`chat_request_send` 事件，body 是**数组**）。 */
export declare const WORKBUDDY_INTL_REPORT_PATH = "/v2/report";
/** 连登天数回读端点（只读）。 */
export declare const WORKBUDDY_INTL_STREAK_PATH = "/activity/growth/streak";
/** 网页通道建会话端点（「当日活跃」计数只认它）。 */
export declare const WORKBUDDY_INTL_WEB_CONVERSATION_PATH = "/console/as/conversations/";
/** 网页会话与上报共用的免费模型链（逐个尝试，全部失败才算失败）。 */
export declare const WORKBUDDY_INTL_MODELS: readonly string[];
/** 一次 JSON 请求的结果（失败带可读原因，不抛）。 */
type JsonResult = {
    ok: true;
    body: Record<string, unknown>;
} | {
    ok: false;
    message: string;
};
/**
 * 一条活跃上报事件的载荷（形状取自官方客户端的 `chat_request_send`）。
 *
 * ⚠️ 字段**一个都不能省**：服务端按整份结构做风控比对，缺字段的事件会被丢弃
 * （不报错），于是「上报成功但连登没亮」变成一条查不出来的静默失败。
 * ⚠️ `userId` 必填且必须是**凭据里的 user_id**，不是 token 里的 sub —— 两者
 * 在换了登录方式的账号上并不相等。
 */
export declare function reportEventOf(uid: string, nowMs?: number): Record<string, unknown>;
/**
 * 发一条活跃上报，并回读连登天数。
 *
 * 返回 `{ ok, note }`：`ok` 只表示**上报被接受**（回读失败不影响 `ok`，但会在
 * `note` 里如实说明）—— 与「签到成功 ≠ 活跃成功」的分开报告口径一致。
 */
export declare function reportWorkBuddyIntlActivity(credential: BuddyCredential, product: BuddyProduct, fetcher?: typeof fetch, timeoutMs?: number): Promise<{
    ok: boolean;
    note: string;
}>;
/** 从回读响应里取连登天数；取不到回 `undefined`（不回 0 —— 0 是「没连登」的语义）。 */
/** 导出仅为可直测：`NaN` 经 `JSON.parse` 无法表达，只能走纯函数入口。 */
export declare function streakDaysOf(result: JsonResult): number | undefined;
/**
 * 在网页通道建一个带 prompt 的会话（「当日活跃」计数只认这一发）。
 *
 * 逐个免费模型尝试，**建成一个就停**：换个模型重试会把同一件事做两遍，
 * 而每建一个都是用户账号里的一个真实会话。
 *
 * 返回 `{ ok, note }`，`note` 里带最后一个模型失败的原因（便于排查是模型下线
 * 还是通道被拒）。
 */
export declare function createWorkBuddyIntlWebSession(credential: BuddyCredential, product: BuddyProduct, fetcher?: typeof fetch, timeoutMs?: number): Promise<{
    ok: boolean;
    note: string;
}>;
/**
 * 签到收尾钩子：把「今天的活跃」补上（`ProviderCredits.afterClaimNote`）。
 *
 * ## 顺序与短路
 *
 * 1. **先看 `outcome`**（PR #87 对抗审计 P1-1/P1-2）：只有 `claimed` /
 *    `already-claimed` 才继续 —— 那是「今天确实有痕迹」的两种结局。
 *    `inactive`（`41000` 活动未开）与 `failed` **直接回 `undefined`**：
 *    - `inactive` 不计 `coversToday`（`auto-checkin.ts` 只认
 *      `claimed + alreadyClaimed`）⇒ 下个时段会重跑本钩子，若无条件发，
 *      中招日两个时段各发一次 ⇒ 用户账号里 **2 个 `Hi` 会话/天**；
 *    - `failed` 说明签到本身没成，此时发活跃上报既无意义也污染诊断。
 * 2. 上报活跃（2 个请求：上报 + 回读）；
 * 3. 网页会话（**仅当** `DSH_WORKBUDDY_INTL_WEB_SESSION` 打开）——
 *    上报成功已经点亮连登，但「当日活跃」计数不认 `/v2/report`，只有网页会话
 *    进这个计数；故只在显式打开时才补这一发。
 *
 * ## 失败也必须出话（对抗审计 P1-3）
 *
 * 原实现只 `push` 成功的 note，全失败回 `undefined` ⇒ 唯一的用户可见通道
 * （`jet-hub-rpc.ts` 把返回值追加到 `outcome.message`）空转，上游挂了也**零日志
 * 零提示**。现在失败也 push 一句可读原因（**不**把签到判成失败 —— 契约要求
 * 永不抛、永不影响签到结果）。
 */
export declare function keepWorkBuddyIntlActivity(credential: BuddyCredential, product: BuddyProduct, outcome: ClaimOutcome, fetcher?: typeof fetch): Promise<string | undefined>;
export {};
//# sourceMappingURL=workbuddy-intl-activity.d.ts.map