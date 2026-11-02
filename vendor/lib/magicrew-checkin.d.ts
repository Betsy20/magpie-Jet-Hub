/**
 * Magicrew（超级麦吉 / MagiCrew）的**每日签到**与**新人奖励**协议实现。
 *
 * ## 两套机制，别混（`credits` 域 vs `onboarding` 域）
 *
 * | 机制 | 端点 | 频率 | 归属域 |
 * |---|---|---|---|
 * | 每日登录积分（= 真正的「每日签到」） | `POST /api/v1/login-gift` | 每天一次 | `credits.claim` |
 * | 新手引导任务（=「新人奖励」） | `GET /api/v1/onboarding/tasks` + `PUT …/<code>/completion` | **每号一辈子一次** | `onboarding` |
 *
 * ⚠️ 别拿「今天领过没」的判据去判「领过没」—— 那正是本仓库记录过的
 * 「一份语义两套判据」形态（见 `src/provider-onboarding.ts` 文件头的域边界表）。
 *
 * ## ① 每日登录积分（实测报文）
 *
 * ```json
 * POST /api/v1/login-gift          （**请求体存在且为空串** —— 见下方 ⚠️）
 * → {"code":1000,"data":{"granted":true,"point_amount":50,
 *                        "expire_type":1,"message":"成功领取每日登录积分"}}
 * ```
 *
 * 关键性质（两站都验过）：
 * - **幂等**：当天已领 → `granted:false, point_amount:0`「今日已领取登录积分」，
 *   **HTTP 仍是 200，不是错误** ⇒ 可以每天无脑调用。
 * - **两站同构**：路径、方法、返回结构完全一样，只有金额不同
 *   （国内 **+200/天**、国际 **+50/天**）。
 * - 抓包来源：2026-10-27 真实网页登录（`magicrew.ai` 的 `/login-gift`）。
 *
 * ## ② 新手引导任务（实测报文）
 *
 * ```json
 * GET /api/v1/onboarding/tasks
 * → {"code":1000,"data":{"participant_type":null,"tasks":[
 *      {"code":"…","title":"…","points":50,"status":"COMPLETED",
 *       "reward_status":"GRANTED","completed_at":"…"}]}}
 *
 * PUT /api/v1/onboarding/tasks/<code>/completion      （body `{}`）
 * → {"code":1000,"data":{"points":50}}
 * ```
 *
 * 国内站 8 项，其中 7 项 PUT 即完成（总分以 `tasks[].points` 现场累加，不写死）。
 *
 * ### ⚠️⚠️ 两条会让人报假账的坑
 *
 * 1. **`first_ai_work` 不支持手动完成** —— 服务端回 **`9303`**「该新人引导任务
 *    不支持手动完成」。它必须真发一条消息才置位（走话题 Socket.IO）。
 *    ⇒ 本实现**不发请求、直接归 `manualRequired`**（**不是** `skipped` ——
 *    那个字段的契约是「此前已完成」，而它既没完成也没领到分；
 *    见 `src/types.ts` 的 `RpcOnboardingClaimResponse`），否则既拿不到分
 *    又会把它写成「已完成」= 报假账。
 * 2. **国际站 `tasks` 恒为空数组** —— `{participant_type: null, tasks: []}` 是
 *    「该账号没被登记进引导计划」，**不是**「已经领完了」。
 *    ⇒ 0 项时如实报「无任务可领」，**不得**报「新手福利 0 项已全部完成」
 *      （magpie 0.3.7 犯过这个错，会把「什么都没做」写成成功）。
 *
 * ## ⚠️ 本文件不引 `node:*`，也不构造 `AbortSignal` 之外的全局副作用
 *
 * 与 `magicrew-product.ts` 同因：它可能被客户端产物（esbuild）间接引用。
 */
import { type MagicrewProduct } from './magicrew-product.js';
import type { ClaimOutcome } from './credits.js';
import type { RpcOnboardingClaimResponse, RpcOnboardingStatusResponse } from './types.js';
/** 已知**不支持手动完成**的任务 code —— 别再白试（服务端回 9303）。 */
export declare const MAGICREW_NOT_MANUALLY_COMPLETABLE: readonly string[];
/** 请求参数（三处共用）。 */
export interface MagicrewCheckinParams {
    readonly jwt: string;
    readonly organizationCode: string;
    readonly product?: MagicrewProduct;
    readonly fetchImpl?: typeof fetch;
    /**
     * 两次 PUT 之间的间隔（毫秒）。缺省 {@link MAGICREW_PUT_GAP_MS}。
     *
     * ⚠️ 单测传 `0` 免等待 —— 否则一条用例要真等 2.4 秒（7 项 × 400ms）。
     */
    readonly throttleMs?: number;
}
/** 一条新手任务（上游原样的子集）。 */
export interface MagicrewOnboardingTask {
    readonly code: string;
    readonly title: string;
    readonly points: number;
    readonly status: string;
    readonly rewardStatus: string;
    readonly completedAt?: string;
}
/**
 * 一条任务是否**已经拿过分**。
 *
 * ⚠️ 判据是 `status === 'COMPLETED'` **或** `reward_status === 'GRANTED'`：
 * 两者在上游是**独立**字段（实测存在 `COMPLETED` 但 `reward_status` 为空的样本），
 * 只判一个会重复 PUT 已领过的任务。
 */
export declare function magicrewTaskIsDone(task: MagicrewOnboardingTask): boolean;
/**
 * **每日签到** —— `POST /api/v1/login-gift`。
 *
 * 幂等：当天已领回 `granted:false`，此处映射成 `already-claimed` 而**不是**
 * `claimed` —— 后者会让用户以为每天都在加积分，而实际上什么都没发生。
 */
export declare function claimMagicrewLoginGift(params: MagicrewCheckinParams): Promise<ClaimOutcome>;
/**
 * **新人奖励状态**（只读）—— `GET /api/v1/onboarding/tasks`。
 *
 * ⚠️ **只读：不得**在此触发任何 `completion`（面板挂载时会调用它）。
 * ⚠️ 0 项时如实回 `total: 0`，调用侧据此显示「无任务可领」而不是「已全部完成」。
 */
export declare function fetchMagicrewOnboardingStatus(params: MagicrewCheckinParams): Promise<RpcOnboardingStatusResponse>;
/**
 * **领取新人奖励** —— 对每个未完成任务 `PUT …/<code>/completion`。
 *
 * ⚠️ `first_ai_work` **不发 PUT**：服务端固定回 `9303`，白试一轮还会让用户看到
 * 一条假的失败。它归入 `manualRequired`（**不是** `skipped`）—— 后者在前端被
 * 渲染成「N 个此前已完成」，而这一项**既没完成也没领到分**，混进去就是把
 * "没做"写成"做过"（2026-11-01 协议审查点名的缺陷）。
 *
 * ⚠️ **单项失败不中断整轮**：其余项照领，失败项收进 `errors` **上抛或返回**。
 * 中断会让「8 项里有 1 项抖动」变成「一项都没领到」，而下一轮重试时前面几项
 * 已经领过，用户看起来像卡住了。
 * - **零成功 + 有失败** ⇒ **上抛**（否则上层会包成「成功但没领到」）
 * - **有成功 + 有失败** ⇒ 返回并带上 `errors`（上抛会让用户以为整轮失败，
 *   而实际已经领到了大部分分；旧实现把它静默吞掉，同样是缺陷）
 *
 * ## ⚠️ 能力上限（**如实说明，不要以为只差一项**）
 *
 * 国内站 8 项里 7 项 PUT 即完成，第 8 项 `first_ai_work` 必须**真发一条消息**
 * （走话题 Socket.IO）才会置位；国际站的首对话任务同理。而它**同时是邀请奖励
 * 的触发条件**（被邀请人完成首个任务/对话后，邀请人才 +200 分）。
 *
 * 本实现**不做**发消息那条腿（协议是另一套 Socket.IO 通道，不在本次范围内），
 * 故：该项分 + 国际站首对话 + 邀请奖励**都拿不到**。这是**已知取舍**，
 * 已通过 `manualRequired` 如实告知用户，不是"已全部领完"。
 *
 * ⚠️ 相邻两次 PUT 之间留 **400ms**：参考实现（magpie `tasks.mjs:162`）如此，
 * 注释写明「服务端限流留点余地」。连发 7 个 PUT 撞上风控会让后面几项失败，
 * 而症状是「每次都只领到前面几项」。
 */
export declare function claimMagicrewOnboardingTasks(params: MagicrewCheckinParams): Promise<RpcOnboardingClaimResponse>;
//# sourceMappingURL=magicrew-checkin.d.ts.map