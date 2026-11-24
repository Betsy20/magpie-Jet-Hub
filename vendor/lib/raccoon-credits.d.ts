/**
 * Raccoon Work 积分（余额 + 每日签到 + 一次性登录奖励）。
 *
 * ## 三个来源的语义（2026-11-15 修正）
 *
 * | 来源 | 金额 | 触发方式 | 本模块 |
 * |---|---|---|---|
 * | 新人注册礼包 | 3000 | 注册时服务端自动发放（`reward_grant`） | 不涉及（用户注册即有） |
 * | 桌面端登录奖励 | 3000 | `POST …/desktop/v1/login/points/grant`（幂等一次性） | ✅ `claimRaccoonLoginReward` |
 * | 每日赠送积分 | 300/日 | **`GET …/office/v3/setting_info`**（按天幂等） | ✅ `claimRaccoonDailyCheckin` |
 *
 * ## ⚠️⚠️ 旧结论「每日 300 没有签到端点」已作废（2026-11-15 真实账号复验）
 *
 * 原注释的依据是「`/points/v1|v2` 下 `sign_in` / `check_in` / `daily` / `claim`
 * 全 404」，那条**仍然成立**（本次逐个复验，仍是 HTML 无关的纯文本
 * `404 page not found`）—— 但结论下早了：每日积分的触发器不在 points 前缀下，
 * 而在**办公端**的 `GET /api/web/office/v3/setting_info`。
 *
 * 实测（2026-11-16 00:14 UTC+8，跨日后第一次调用，3 个真实账号各一次）：
 * - `available_points` 三个账号**全部 +300**，`daily_points` 同步 +300；
 * - 响应带 `point_grant_popups: [{source:'daily', points:300,
 *   expire_at:'2026-11-22T23:59:59+08:00'}]`；
 * - 紧接着再调一次 ⇒ `popups: []` + 余额不变 ⇒ **按天幂等**，重复调用不会多发。
 *
 * ## 成功判据：以**余额前后差**为准，账单只作兜底
 *
 * ⚠️ 触发成功后**立刻**拉账单有时看不到当天那笔（积分记录同步有延迟，官方文档
 * 也写了这一点）。只用账单会把「刚发放成功」误报成「今天早就发过了」——
 * 用户看到「已领」而实际未记账，逐日累计就差一整笔。故顺序是：
 * 余额(before) → 触发 → 余额(after) → 差额 > 0 判 `claimed`；差额为 0 才查账单
 * 区分「今天早些时候已到账」与「确实没发」。
 *
 * ## 账单必须走 v2 + `type=income`
 *
 * v1 的 `/bills` 按时间倒序返回全部记录（消耗也在内）。2026-11-15 实测三个
 * 账号的 `paging.limit=50` 全被 `daily_grant` + `desktop` 占满，
 * `reward_grant` **零命中** ⇒ 登录奖励状态恒报「未领取」。见
 * {@link RACCOON_POINTS_V2_PREFIX}。
 *
 * ## ⚠️ 登录奖励仍是「一次性」，不登记为每日签到
 *
 * 它幂等一次性（已领过返回 `granted:false`），语义与 Loomy 的新手任务同构，
 * 故登记为 `onboardingTasks`；`dailyCheckin` 归的是每天的 `setting_info` 那条。
 *
 * ## 只读优先
 *
 * 余额查询用 `GET /points/v1/balance`（**只读**）。在「打开面板」这类
 * 高频路径上**绝不**触碰触发端点（Loomy 的 `first-login` 就踩过这个坑：
 * 打开面板即意外触发签到）。
 */
import { type RaccoonCredential } from './raccoon.js';
import { type RaccoonProduct } from './raccoon-product.js';
import { type ClaimOutcome, type CreditBalance } from './credits.js';
/** 登录奖励的默认额度（服务端未在 popup 里给出时兜底）。 */
export declare const RACCOON_LOGIN_REWARD_POINTS = 3000;
/** 登录奖励在账单里的 `event_name`（用于判定是否已领）。 */
export declare const RACCOON_LOGIN_REWARD_EVENT_NAME = "\u684C\u9762\u7AEF\u767B\u5F55\u5956\u52B1";
/**
 * 每日积分在账单里的 `event_name` 与 `biz_type`。
 *
 * 实测三个账号逐条一致（`biz_type: 'daily_grant'`、`event_name: '每日积分发放'`）。
 * ⚠️ 判据**只用 `biz_type`**：`event_name` 是展示文案、上游随时可能改字，
 * 而 `biz_type` 是机器码。`event_name` 留在这里只为 README/排查时对得上。
 */
export declare const RACCOON_DAILY_GRANT_BIZ_TYPE = "daily_grant";
export declare const RACCOON_DAILY_GRANT_EVENT_NAME = "\u6BCF\u65E5\u79EF\u5206\u53D1\u653E";
/**
 * 查询积分余额（映射成既有的 `CreditBalance` 形状）。
 *
 * ⚠️ 各池**分开作 package**，让用户看出「注册礼包 / 每日 / 充值」是独立来源
 * —— 它们的有效期与回补规则都不同（每日积分每日刷新、充值积分长期有效）。
 *
 * @returns 查不到时返回 `null`（卡片显示原因，**不是** 0）。
 */
export declare function fetchRaccoonCreditBalance(product: RaccoonProduct, credential: RaccoonCredential, fetcher?: typeof fetch): Promise<CreditBalance | null>;
/**
 * 领取「桌面端登录奖励」（一次性，幂等）。
 *
 * ⚠️ **不是每日签到**：实测该端点是幂等一次性的（已领过返回 `granted:false`
 * 且账单里能看到上一次的记录）。映射到 `onboardingTasks` 能力。
 *
 * ⚠️ 需要 `X-Client-Platform` 头（值见 `product.clientPlatform`）——
 * 它标识「来自桌面端」，缺了会被拒。见 `raccoonHeaders`。
 *
 * 本函数**不抛错**（失败也返回 `failed`），保证批量领取不会因单个账号中断。
 */
export declare function claimRaccoonLoginReward(product: RaccoonProduct, credential: RaccoonCredential, fetcher?: typeof fetch): Promise<ClaimOutcome>;
/**
 * 查询「桌面端登录奖励」是否已领（供 `onboarding.status` 用）。
 *
 * 判据：收入账单里存在 `biz_type === 'reward_grant'` 且
 * `event_name === '桌面端登录奖励'` 的记录。
 *
 * ⚠️⚠️ **这里是「判据只用 `biz_type`」那条纪律的唯一例外，且是刻意的**：
 * 「新人注册礼包」也是 `reward_grant`（实测），只按 `biz_type` 判会让新用户
 * 一打开面板就显示「登录奖励已领取」。⇒ 必须再叠一层 `event_name` 才能区分。
 * 代价是**上游改文案就会翻成未领**（对抗审计 F7/C6 实测：把「桌面端登录奖励」
 * 改成「…发放」⇒ `claimed` 由 true 变 false），这是一个**已知的取舍**：
 * 宁可让老用户偶尔多点一次（服务端幂等，无害），也不要让新用户一开始就错过。
 *
 * ⚠️ **不能靠 `balance` 推断** —— 余额是多个来源（注册礼包/每日/充值）的
 * 合计，无法区分某一项是否已领。
 * ⚠️ **不能只按 `biz_type === 'reward_grant'` 判定** —— 「新人注册礼包」
 * 也是 `reward_grant`，把它算作登录奖励会让新用户一开始就显示「已领取」。
 * ⚠️ **服务端没有单独的奖励状态端点**（实测），故只能查账单明细。
 * ⚠️ 查询失败时保守返回 `claimed: false` —— 宁可让用户多点一次
 * （服务端幂等，无害），也不要误报「已领」而让他真的错过。
 */
export declare function fetchRaccoonOnboardingStatus(product: RaccoonProduct, credential: RaccoonCredential, fetcher?: typeof fetch): Promise<{
    claimed: boolean;
    points: number;
}>;
/**
 * UTC+8 的当天日期（`YYYY-MM-DD`）—— 上游每日积分按北京零点切日。
 *
 * ⚠️ 必须用**算术平移**而不是本机时区：日界归服务端（UTC+8），用本机时区
 * 会在用户出差 / 改系统时区时得到错的「今天」。
 */
export declare function raccoonUtc8Date(nowMs?: number): string;
/** 触发结果：成功时带上游自带的发放提示（已结算过则为空）。 */
export interface RaccoonDailyGrantResult {
    readonly ok: boolean;
    readonly message: string;
    readonly toast: string;
    readonly popups: ReadonlyArray<{
        displayName: string;
        points: number;
        expireAt: string;
    }>;
}
/**
 * 触发一次「每日积分结算」（按天幂等）。
 *
 * @returns `ok: false` 表示上游拒绝 / 网络失败（`message` 带原因）；
 *          `ok: true` 时 `toast` / `popups` 是上游自带的发放提示，**可能为空**
 *          （为空只说明「今天此前已经结算过」，不代表失败）。
 */
export declare function triggerRaccoonDailyGrant(product: RaccoonProduct, credential: RaccoonCredential, fetcher?: typeof fetch): Promise<RaccoonDailyGrantResult>;
/**
 * 读账单，汇总「今天（UTC+8）到账的每日积分」。
 *
 * @returns `null` 表示账单查不到（调用方必须当成失败，不能编造 0）。
 */
export declare function fetchRaccoonTodayDailyGrants(product: RaccoonProduct, credential: RaccoonCredential, fetcher?: typeof fetch, nowMs?: number): Promise<{
    total: number;
    entries: ReadonlyArray<{
        name: string;
        points: number;
    }>;
} | null>;
/**
 * 每日签到：触发办公端结算，再用**余额前后差**核对。
 *
 * 三条返回分支：
 * - 余额差额 > 0 ⇒ `claimed`（`credit` = 差额，含上游顺带补发的历史缺额）；
 * - 差额为 0 且今日账单已有 `daily_grant` ⇒ `already-claimed`（今天早些时候到过账）；
 * - 触发或两次余额查询都失败 ⇒ `failed`（带原因，**不虚报成功**）。
 *
 * ⚠️ `coversToday` **不再恒为 `true`**：只有在「差额 > 0」或「账单/弹窗给出了
 * 今天的凭证」时才声明今天已处理；**三者都拿不到证据时回 `false`**
 * （让自动签到下一轮重试，而不是把真失败锁成当天不再尝试）。
 *
 * ⚠️ 余额查询失败（`null`）**不直接判失败**：差额判据要求两次都读得到，
 * 读不到就退到账单判据 —— 账单也说没有时才算「今天没发」。这条短路顺序
 * 是刻意的：余额端点偶尔 5xx 时不该让用户看到「签到失败」。
 */
export declare function claimRaccoonDailyCheckin(product: RaccoonProduct, credential: RaccoonCredential, fetcher?: typeof fetch): Promise<ClaimOutcome>;
/** 默认产品配置下的便捷包装（供 `RaccoonAuth` 调用）。 */
export declare const raccoonCreditsForDefaultProduct: {
    fetchBalance: (credential: RaccoonCredential, fetcher?: typeof fetch) => Promise<CreditBalance | null>;
    claimLoginReward: (credential: RaccoonCredential, fetcher?: typeof fetch) => Promise<ClaimOutcome>;
    fetchOnboardingStatus: (credential: RaccoonCredential, fetcher?: typeof fetch) => Promise<{
        claimed: boolean;
        points: number;
    }>;
    claimDailyCheckin: (credential: RaccoonCredential, fetcher?: typeof fetch) => Promise<ClaimOutcome>;
    triggerDailyGrant: (credential: RaccoonCredential, fetcher?: typeof fetch) => Promise<RaccoonDailyGrantResult>;
};
//# sourceMappingURL=raccoon-credits.d.ts.map