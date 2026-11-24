/**
 * 豆包（Doubao，字节跳动）积分/额度余额与每日签到（薄壳）。
 *
 * ## 实测结论（2026-11-03 签到 / 2026-11-22 额度，真机接通）
 *
 * - **签到端点**：`POST https://www.doubao.com/alice/ug/campaign/landing/checkin`
 *   （公共 query 见 `src/doubao.ts` 的 `doubaoCheckinQuery`），body
 *   `{"scene":"pc_incentive_task_mvp_v3"}`，响应
 *   `{data:{checked_in,checkin_date,continuous_days,idempotent,reward_amount,…},code:0}`。
 * - **鉴权 = cookie**（`sessionid`/`sid_tt`/`ttwid` 等），无 `Authorization`。
 * - **签名 = query 的 `a_bogus`**，由豆包页面上下文的 `window.bdms.frontierSign` 生成
 *   （`bdms` 只在 doubao.com 页面里存在）⇒ **签到必须走 CDP 页面会话**，
 *   纯 Node fetch 产不出合法 `a_bogus`（实测裸 fetch 恒 `710010702 系统错误`）。
 * - **幂等**：`idempotent: true`（重复调用安全，今日已签会回 `checked_in:true`）。
 *
 * ## ⚠️ 2026-11-22 更正：「豆包无余额概念」是错的
 *
 * 旧注释写「豆包没有积分/额度余额概念，余额查询如实回 null」——
 * **那只对签到口径成立**。豆包账号面板确实有额度：
 * `POST /alice/commerce/sale/subscription/quota/summary/` 真机回
 * `{ data: { current_subscription: { display: { short_name: "免费体验" } },
 *   incentive_quota_section: { window_limit_groups: [{ feature_group_name: "活动赠送额度",
 *   window_limits: [{ total_amount: "1,600", used_amount: "<1", end_time: … }] }] } }, code: 0 }`。
 * 这些是**真实额度窗口**，本模块如实读出来，不再回 null。
 * 协议细节（header/query/解析）见 `src/doubao-upstream.ts`。
 *
 * ## 模块分工
 *
 * - 本文件：**余额**（真实读 quota）+ **签到薄壳**（把凭据转给 `doubao-signin.ts`）；
 * - `src/doubao-upstream.ts`：额度/模型/对话三条腿的共享协议；
 * - `src/doubao-signin.ts`：真正的 **CDP 页面会话驱动**（起豆包内核 + 挂其 User Data，
 *   在页面里用 `bdms.frontierSign` 签名再领取）。签名逻辑只在那一份，别在这里抄。
 *
 * @module src/doubao-credits.ts
 */
import type { ClaimOutcome, CreditBalance } from './credits.js';
import type { DoubaoCredential } from './doubao.js';
/**
 * 拉取豆包账号额度（`fetchBalanceDetailed` 形态：失败自带可读原因）。
 *
 * ⚠️ 请求由**凭据里的 cookie** 发，不用全局 fetch 的隐式 cookie jar。
 */
export declare function fetchDoubaoBalanceDetailed(credential: DoubaoCredential): Promise<{
    balance: CreditBalance | null;
    error?: string;
}>;
/**
 * 执行豆包每日签到领取。
 *
 * 真正的 CDP 页面会话驱动在 `src/doubao-signin.ts` 的 `claimDoubaoDailyViaPage`
 * （起豆包内核 + 挂其 User Data，在页面里用 `bdms.frontierSign` 签名再领取）。
 * 本函数是它的薄壳：把凭据原文转过去。
 *
 * ⚠️ 凭据必须带 `cookie`（登录会话）；没有它 ⇒ `inactive`（不发请求）。
 */
export declare function claimDoubaoDailyCheckin(credential: DoubaoCredential): Promise<ClaimOutcome>;
//# sourceMappingURL=doubao-credits.d.ts.map