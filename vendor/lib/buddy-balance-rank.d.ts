/**
 * CodeBuddy / WorkBuddy 账号按「积分何时作废」分档排序（负载均衡 + 永久积分锁定）。
 *
 * ## 它与 Loomy 那份（`loomy-balance-rank.ts`）的关系
 *
 * **同构但判据不同**，故刻意不共用实现：
 *
 * | | Loomy | 两个 buddy |
 * |---|---|---|
 * | 临时积分 | `dailyBalance` —— 服务端**直接给了一个字段** | 需要**自己算**：遍历资源包，取 `DeductionEndTime` 距今 **< 15 天** 的那几包余额之和 |
 * | 永久积分 | `balance`（注册奖励 + 新手任务，不过期） | 其余资源包（`DeductionEndTime` ≥ 15 天或未下发）的余额之和 |
 * | 到期节奏 | **当日**到期，明天重新发放 | **14 天 / 30 天 / 365 天**到期，没有「每天一笔」的概念 |
 *
 * ⚠️ 把两者压成一份代码需要把「什么叫临时」参数化成一个回调 —— 那会让本文件
 * 唯一有价值的东西（**15 天这条线是怎么来的**）从注释里消失，收益不抵损失。
 * 新增同族 provider 时优先扩本文件，不要再开第三份。
 *
 * ## 为什么用 `DeductionEndTime` 而不是 `CycleEndTime`（实测 2026-09-29）
 *
 * 两站真实账号的资源包形状：
 *
 * | 包 | `DeductionEndTime` 距今 | `CycleEndTime` 距今 | 归入 |
 * |---|---|---|---|
 * | WorkBuddy「Bonus Pack」 | 9 天 | 9 天 | **临时** |
 * | WorkBuddy「Free Plan Subscription」 | 3008 天 | **2 天** | **永久** |
 * | CodeBuddy「个人体验版」 | 3008 天 | 已过期 | 永久（本周期已无余额） |
 * | CodeBuddy「拉新权益包 / 国内运营裂变包」 | 17～208 天 | 同左 | ≥15 天者永久、<15 天者临时 |
 *
 * 套餐包的**计量周期**虽短（月度），但扣费截止在 8 年后 —— 取 `CycleEndTime`
 * 会把每月刷新的套餐判成「马上作废」，锁定永久积分就形同虚设。
 * 有效包的 `ExpiredTime` 一律是空串（它只在包真正失效后才回填），没有区分力。
 *
 * ## 策略（用户指定）
 *
 * | 档位 | 判据 | 含义 |
 * |---|---|---|
 * | 1 | `imminent > 0` | 有 **5 天内到期**的积分（临期）—— 再不用立刻作废，最优先 |
 * | 2 | `expiring > 0` | 只剩 **5~15 天内到期**的积分（短期） |
 * | 3 | `permanent > 0` | 只剩「永久」积分（≥ 15 天后才到期） |
 * | 4 | 其余（含**查询失败**） | 无可用余额 |
 *
 * ⚠️ 三档判据是**嵌套**的：`临期 ⊂ 15 天内`，故 `expiring` 桶同时包含临期与短期，
 * `imminent` 是它的子量。这样「锁定永久积分」的可用性判据（`expiring > 0`）不变。
 *
 * ⚠️ **档内保持传入顺序**（= 用户在 Jet Hub 拖拽的手动顺序），**不重排** ——
 * 与 `AccountPool.getAvailableAccount` 的既有语义一致。**临期档内同样如此**：
 * 两笔都临期时，顺序完全由帐号顺序决定，不按"谁更急"二次排序
 *（用户 2026-11-17 明确要求「原来是什么策略就使用什么策略」）。
 *
 * ⚠️ **查询失败归入最后一档**：宁可把请求发给能确认余额的号（与 Loomy 同规）。
 *
 * ⚠️ 本模块是**纯函数**，不碰网络与凭据 —— 余额由调用方查好后传入。
 */
import { type CreditBalance } from './credits.js';
import type { RotationStartTier } from './jet-hub-store.js';
/**
 * 「临时积分」的时间窗口：距扣费截止不足 **15 天**的积分算临时（会很快作废），
 * 其余算永久。用户 2026-09-29 定的判据。
 *
 * ⚠️ 这条线同时决定了**锁定永久积分**后哪些账号仍可用：只有 15 天内到期那部分
 * 积分可被消耗，故实测里「裂变包全部还有 17 天以上」的账号在锁定期间
 * **等同于无可用账号**（不是缺陷，正是该判据的直接推论）。
 */
export declare const BUDDY_EXPIRING_WINDOW_DAYS = 15;
/** 由天数换算的毫秒窗口（导出供单测按同一口径构造时间戳）。 */
export declare const BUDDY_EXPIRING_WINDOW_MS: number;
/**
 * 「临期积分」的时间窗口：距扣费截止不足 **5 天**的积分算临期（最优先烧掉）。
 * 用户 2026-11-17 定的判据。
 *
 * ## 它与 15 天那条是**嵌套**关系，不是并列
 *
 * ```
 * 临期（< 5 天） ⊂ 短期（5 ~ 15 天） ⊂ 原「临时」（< 15 天）
 * ```
 *
 * 引入它的原因（用户 2026-11-17 需求）：原先**只有一条线**，于是「14 天后到期」
 * 与「3 天后到期」都算同一档 `expiring` ⇒ 排序时**全靠帐号顺序**决定先烧谁
 * ⇒ 一个还有 14 天的号会长期霸占轮换，而 3 天后作废的积分**一分没用上**。
 *
 * ## ⚠️ 它是 `expiring` 的**子量**，不是第 4 个平级桶
 *
 * `expiring` 的语义（15 天内）**逐字节不变** —— 这是刻意的，因为
 * `split.expiring > 0` 是「锁定永久积分」的可用性判据
 *（`src/officeace-lock.ts:255`、`plugin-src/client/usage-badge.js` 的 `expiringOf()`），
 * 改它的含义会让锁定态把一个「只有 3 天积分」的可用号误判成不可用。
 * 与 `permanent` 承载 `unknownExpiry` 子量是同一手法（见 `src/credits.ts:289-310`）。
 */
export declare const BUDDY_IMMINENT_WINDOW_DAYS = 5;
/** 由天数换算的毫秒窗口（导出供单测按同一口径构造时间戳）。 */
export declare const BUDDY_IMMINENT_WINDOW_MS: number;
/**
 * 覆盖「临期」窗口的环境变量名。
 *
 * ⚠️ 与 15 天那条同理：不同渠道的发卡节奏差别极大，5 天对某家合适、对另一家过紧。
 * 设成 `0` 可**关掉临期档**（退化成原来的两档）。
 */
export declare const DSH_BUDDY_IMMINENT_WINDOW_DAYS = "DSH_BUDDY_IMMINENT_WINDOW_DAYS";
/**
 * 覆盖窗口的环境变量名。
 *
 * ## 为什么需要这道逃生门（实测 2026-09-29，真实账号）
 *
 * 15 天这条线在两站的效果**差别极大**：
 *
 * | 池 | 实测形状 | 锁定的后果 |
 * |---|---|---|
 * | WorkBuddy 5 个号 | Bonus Pack 250（8～9 天）+ Free Plan 100（3008 天） | 4 个号仍可用，1 个（Bonus Pack 已耗尽）不可用 —— 正是期望效果 |
 * | CodeBuddy 中国版 1 个号 | 裂变包共 10064.6，**距到期最少 17 天** | **立刻「无可用账号」**（17 天 > 15 天 ⇒ 全算永久） |
 *
 * 中国版的包是按 30 天发放的，所以"距到期"天然落在 17～30 天区间 ——
 * 判据本身没错，但这类池想用锁定就得把窗口放宽（如 `DSH_BUDDY_EXPIRING_WINDOW_DAYS=31`，
 * 让"本批包"整体算临时）。
 *
 * ⚠️ 窗口只能由**用户显式**改：默认值必须是用户定的 15 天。
 */
export declare const DSH_BUDDY_EXPIRING_WINDOW_DAYS = "DSH_BUDDY_EXPIRING_WINDOW_DAYS";
/**
 * 当前生效的「临时积分」窗口（天）。
 *
 * ⚠️ **不能写成 `parseInt(raw) || 默认值`**：`0` 是合法值（表示「没有临时积分」，
 * 于是锁定期间整池不可用），而 `0` 是 falsy 会被 `||` 静默换成默认值 ——
 * 与 Qoder 排队超时那个坑同型。
 *
 * 非法值（空 / 非数字 / 负数）一律回落到默认窗口，不报错：这是展示与选号的
 * 辅助判据，配置写错不该让插件起不来。
 */
export declare function buddyExpiringWindowDays(env?: NodeJS.ProcessEnv): number;
/** 当前生效的窗口（毫秒）。 */
export declare function buddyExpiringWindowMs(env?: NodeJS.ProcessEnv): number;
/**
 * 当前生效的「临期」窗口（天）。
 *
 * ⚠️ **解析纪律与 {@link buddyExpiringWindowDays} 逐条相同**：`0` 是**合法值**
 * （表示「关掉临期档，退化成两档」），故**绝不能**写 `Number(raw) || 默认值` ——
 * 那会把 `0` 静默换成 5。非法值（空 / 非数字 / 负数）回落到默认。
 */
export declare function buddyImminentWindowDays(env?: NodeJS.ProcessEnv): number;
/** 当前生效的临期窗口（毫秒）。 */
export declare function buddyImminentWindowMs(env?: NodeJS.ProcessEnv): number;
/**
 * 生效的临期窗口（毫秒）—— **全仓唯一的钳制点**。
 *
 * ## 为什么要钳制
 *
 * 两个窗口是**嵌套**的（临期 ⊂ 15 天）。用户可分别用两个环境变量调它们，
 * 于是出现「临期窗口比总窗口还大」时，分档表就自相矛盾了：
 *
 * | `DSH_BUDDY_EXPIRING_WINDOW_DAYS` | `DSH_BUDDY_IMMINENT_WINDOW_DAYS` | 不钳制的后果 |
 * |---|---|---|
 * | 15 | 20 | 「短期」档的判据 `5~15 天` 变成空区间 ⇒ 该档永远为 0（看着像缺陷） |
 * | 3 | 5 | 「临期」判据 `>3 天 且 <5 天` 两处比较打架 ⇒ 必须钳到 3 |
 *
 * 钳制后语义始终自洽：**临期 ⊂ 总窗口**，最坏情况是「短期档消失」，
 * 而那是用户显式把两个窗口调到相等/倒挂的**直接推论**，不是缺陷。
 *
 * ⚠️ 只在**这一处**钳制。调用方拿到的值已经是合法的 —— 别在别处再
 * `Math.min` 一次，那会让「同一语义两套判据」重新出现（本仓首条红线）。
 *
 * @param windowMs - 总窗口（15 天，已按 env 解析）。
 * @param imminentMs - 临期窗口候选值；省略时读环境变量。
 * @returns 恒 `>= 0` 且 `<= windowMs`。
 */
export declare function resolveImminentWindowMs(windowMs: number, imminentMs?: number): number;
/** 账号余额档位。数字越小越优先。 */
export declare const BUDDY_BALANCE_TIER: Readonly<{
    /** 有 5 天内到期的积分（临期）—— 最优先消耗，否则直接作废。 */
    readonly imminent: 0;
    /** 只剩 5~15 天内到期的积分（短期）—— 次优先。 */
    readonly expiring: 1;
    /** 只剩永久积分（≥ 15 天后到期，或到期时间未知）—— 最后才用。 */
    readonly permanent: 2;
    /** 无余额 / 查询失败 / 锁定态下只剩永久积分。 */
    readonly none: 3;
}>;
export type BuddyBalanceTier = (typeof BUDDY_BALANCE_TIER)[keyof typeof BUDDY_BALANCE_TIER];
/** 三类余额的拆分结果。 */
export interface BuddyCreditSplit {
    /**
     * 15 天内到期、**且尚未作废**的积分合计（本计费周期口径）。
     *
     * ⚠️⚠️ **语义与引入「临期」档之前逐字节相同**（= 临期 + 短期）。
     * 它是「锁定永久积分」的可用性判据（`split.expiring > 0` ⇒ 该号可烧），
     * 故**绝不能**把它改成「只有 5~15 天」—— 那会让一个只剩 3 天积分的可用号
     * 在锁定态被判成不可用。临期额度请读 {@link imminent}。
     */
    expiring: number;
    /**
     * {@link expiring} 的**子量**：其中 5 天内到期的部分（临期，最优先烧掉）。
     *
     * 不变量 `0 <= imminent <= expiring`；只在 `> 0` 时出现在返回值里
     *（与 {@link expired} 同款约定，避免给每个调用方加一个恒 0 的键）。
     */
    imminent?: number;
    /** 其余积分合计（≥ 15 天后到期，或到期时间未知）。 */
    permanent: number;
    /**
     * **已经作废**的额度（`deductionEndTime <= now` 但 `active` 仍为 true）。
     *
     * ⚠️⚠️ **必须从 `expiring` 里摘出来**（2026-11-02 修，PR #168 对抗审计 B1）：
     * TRAE / Qoder 的 `active` 是**硬编码 true**（`trae-credits.ts` 从不反映是否过期），
     * 所以这类包一定会出现。旧行为把它算进 `expiring` ⇒
     * ① `buddyBalanceTier` 判 `expiring` = **可用**（锁定永久积分下也照发）；
     * ② `sharedPackageExpiry` 把它的过去时刻当最早 ⇒ 聚合**排第一**、先被烧；
     * ③ 请求必然失败（那些积分扣不到）。
     *
     * 摘出来之后：只剩作废额度的账号 ⇒ `expiring=0 permanent=0` ⇒ 档位 `none`（不可用），
     * 这正是「钱已经没了」的正确表示。
     *
     * 只在 `> 0` 时出现在返回值里（与前端 `splitCreditsByExpiry` 同款，避免给每个
     * 调用方加一个恒 0 的键）。
     */
    expired?: number;
}
/** 参与分档的账号（两个字段缺失表示查询失败）。 */
export interface BuddyAccountBalance {
    id: string;
    /** 15 天内到期的积分；`undefined` = 查询失败。 */
    expiringBalance?: number;
    /**
     * 其中 5 天内到期的部分（{@link expiringBalance} 的子量）；`undefined` = 查询失败。
     *
     * ⚠️ 可选且**不校验**它是否真的 `<= expiringBalance` —— 分桶层
     *（{@link splitBuddyCreditsByExpiry}）天然保证 `imminent += remaining` 与
     * `expiring += remaining` 在同一分支里同时发生。外部手工构造的对象若倒挂，
     * 最坏后果只是档位判「临期」而金额偏小，不会误烧长期积分。
     */
    imminentBalance?: number;
    /** 永久积分；`undefined` = 查询失败。 */
    permanentBalance?: number;
}
/**
 * 把一个账号的积分余额拆成「快到期」与「永久」两桶。
 *
 * ⚠️ **口径是 `remaining`（= `CycleCapacityRemain`，本计费周期剩余）**，与
 * CodeBuddy IDE 顶部的 Credits Balance 一致。用户选定该口径的理由：实测
 * CodeBuddy 体验版套餐的**终身**剩余是 500 而**本周期**剩余是 0 ——
 * 那 500 实际扣不到，算进可用余额会让账号「看起来有钱却用不了」。
 *
 * ⚠️ **`active === false` 的包一律跳过**：失效包的服务端仍会返回余额，
 * 并进任何一桶都会虚增可用额度（`fetchCreditBalance` 的 `total` 同理只算有效包）。
 *
 * ⚠️ **到期时间未知（`deductionEndTime` 缺失 / 非正数）归入永久桶**：
 * 宁可把它当作「不会马上作废」——这是**保守方向**，最坏结果是锁定时少用一个号，
 * 而不是误把长期积分当成快到期烧掉。
 *
 * @param balance - `fetchCreditBalance` 的结果；`null`（查询失败）返回 `undefined`。
 * @param now - 当前时刻（毫秒），注入以便单测断言边界。
 * @param windowMs - 窗口，默认 {@link BUDDY_EXPIRING_WINDOW_MS}。
 * @param imminentMs - 「临期」子窗口，默认 {@link BUDDY_IMMINENT_WINDOW_MS}。
 *   ⚠️ 由调用方经 {@link resolveImminentWindowMs} 归一（保证 ≤ `windowMs`）
 *   —— 这里给默认值只为既有调用点（含大量用例）不必改动。
 * @returns 三桶合计（`expiring` 内含 `imminent` 子量）；`balance` 为 null/undefined
 *   时返回 `undefined`（= 查询失败）。
 */
export declare function splitBuddyCreditsByExpiry(balance: CreditBalance | null | undefined, now?: number, windowMs?: number, imminentMs?: number): BuddyCreditSplit | undefined;
/** 分档选项。 */
export interface BuddyTierOptions {
    /** 是否允许消耗永久积分。默认 `true`（解锁）。 */
    allowPermanent?: boolean;
    /**
     * ⚠️ **当前实现不读它**（2026-11-01 四审登记）。保留只为调用形态稳定。
     *
     * 档位**只**取决于入参里**已经分好桶**的 `expiringBalance` / `permanentBalance` ——
     * 分桶发生在 {@link splitBuddyCreditsByExpiry}（那里才读 `now` / `windowMs`）。
     * 后果：测试里传 `windowMs: 1` 想让窗口「失效」是**空转**（实测 4 处全改后 20/20 仍绿）。
     * 要钉窗口边界，请改喂**不同到期时刻的原始包**，不要指望这个参数。
     */
    now?: number;
    /** ⚠️ 同上：**当前实现不读它**（保留但无效果，别用它做窗口边界用例）。 */
    windowMs?: number;
    /**
     * 「严格手动顺序」：**档位只决定可用性，不决定先后**（见
     * {@link rankBuddyAccountsByManualOrder}）。
     *
     * 默认 `false` = 既有语义（先按到期档位、档内看手动顺序）。
     *
     * ⚠️ 它**不影响** `buddyBalanceTier` 的返回值，只用在那两个排序函数的
     * 选择上 —— 故传 `true` 时「锁定永久积分」这道门照旧生效。
     */
    strictManualOrder?: boolean;
    /**
     * 「轮换起点」：本会话指定的起始账号 id（`undefined` = 默认起点）。
     *
     * 语义：**只把轮换的起点挪到该账号**，不改任何档位/可用性判据。
     * 详见 {@link rotateFromPreferred}。
     */
    rotationStartId?: string;
    /**
     * ★ **起点选定那一刻的档位**（S6，2026-11-20）。
     *
     * 语义：`rotateFromPreferred` 只在「起点**当前**档位 == 本字段」时让起点
     * 绝对第一；不同（= 那一档已烧完、档位下降）则**交出首位**，回到档位排序。
     * 详见 {@link rotateFromPreferred} 的 S6 说明。
     *
     * ## 三个取值的含义
     *
     * | 值 | 行为 |
     * |---|---|
     * | `'imminent'` / `'expiring'` / `'permanent'` | 按 S6 判降档 |
     * | **`undefined`** | **保持 S5**（起点绝对第一）—— 老数据 / 老客户端 |
     *
     * ⚠️ `undefined` 走 S5 是刻意的向后兼容：升级前选的起点没有这个快照，
     *    静默改变其行为违反本仓纪律。用户重选一次起点即启用 S6。
     */
    rotationStartTier?: RotationStartTier;
    /**
     * 「轮换起点的定位基准」：**全量启用账号**的 id 列表（池序，**不过滤**封禁/限流）。
     *
     * ⚠️ 存在的理由（PR #59 正向审计 P1-a）：`rotationStartId` 指向的账号
     * 可能**不在候选集里**（被账号级封禁 / 被目标模型限流）—— 此时只按
     * `ranked.findIndex(id === startId)` 判会得到「找不到就原样」，于是
     * **静默回落默认第一个号**（恰是用户想避开的那个）。
     *
     * 提供本列表后，`rotateFromPreferred` 能算出「起点在池里的位次」，再从
     * 候选里取「位次 ≥ 起点」的第一个 —— 即用户明确要求的「循环到下一个可用」。
     *
     * `undefined` / 空数组 / 起点已被删除（不在本列表里）⇒ 保持既有语义
     * （找不到就原样，不报错）。
     */
    enabledAccountIds?: readonly string[];
    /**
     * ★★★ **把 `rotationStartId` 当作「绝对第一」**（2026-11-23）。
     *
     * ## 它解决什么问题
     *
     * 用户要求「子代理固定帐号」语义是：该号**还有任何可用积分就一直用它** ——
     * 烧完临期继续烧短期，烧完短期继续烧永久（未锁定时），「烧没了才切帐号」。
     *
     * 而 `rotationStartId` 的既有语义是 S5/S6 的「起点绝对第一**直到它那一档烧完**」
     * —— 烧完临期、落到短期档时就**交出首位**（S6）。那不满足用户的要求。
     *
     * ## 判据
     *
     * `pinnedFirst === true` 时**跳过** `tierStillHeld` 检查：
     * 只要 `rotationStartId` 那个账号**可用**（`buddyTierUsable` 为真），
     * 就恒排第一，**无视**它的档位怎么变。
     *
     * ## ⚠️ 「不可用」的准确含义
     *
     * 与主代理**完全同源**：
     *
     * ```ts
     * buddyTierUsable(buddyBalanceTier(account, { allowPermanent }))
     * ```
     *
     * | 场景 | `allowPermanent` | 判定 |
     * |---|---|---|
     * | 锁定永久 + 只剩永久积分 | `false` | **不可用** ⇒ 切帐号 |
     * | 未锁定 + 只剩永久积分 | `true` | **可用** ⇒ 继续用它烧永久 |
     * | 临期/短期任一 > 0 | 两者 | **可用** |
     * | 完全无积分 | 两者 | **不可用** ⇒ 切帐号 |
     *
     * 这正是用户 2026-11-23 确认的口径：
     * > 「未锁定永久的帐号就在用它的永久积分」
     *
     * ⚠️ `pinnedFirst` 只在 `rotationStartId` 已给且**该号确实可用**时生效；
     * 不可用时退回既有 S5/S6 逻辑（继续按档位找下一个）——
     * 那就是用户说的「烧没了才切帐号」。
     */
    pinnedFirst?: boolean;
}
/**
 * 「轮换起点」的**唯一实现**：把已排好序的候选从指定账号处绕一圈。
 *
 * ## 语义（用户 2026-11-10 需求）
 *
 * ```
 * 策略顺序：A → B → C → D →（回到 A）
 * 选 C 后： C → D → A → B →（回到 C）
 * ```
 *
 * ⚠️ **只挪起点，不改任何策略**：
 * - 档位判据照旧（临期优先仍然成立）；
 * - 可用性过滤照旧（锁定永久积分时「只剩永久」仍不可用）；
 * - 失败换号照旧（`tried` 循环在旋转后的数组上跑）。
 *
 * ## ⚠️ 起点落在「往后第一个可用项」
 *
 * 用户选的号**可能当前不可用**，分两种成因，**都必须循环到下一个可用**、
 * 不能回落默认（用户明确要求）：
 *
 * 1. **在候选集里但档位不可用**（`none` 档）—— 向后扫时跳过；
 * 2. **压根不在候选集里**（账号级封禁 / 目标模型限流，被 `candidatesOf` 滤掉）
 *    —— 此时只按 `ranked.findIndex(id)` 会得到 `-1`，于是**静默回落默认第一个号**
 *    （恰是用户想避开的）。PR #59 正向审计 P1-a 实测。
 *
 * 成因 2 的修法：调用方额外传 {@link BuddyTierOptions.enabledAccountIds}
 * （**全量启用账号**的 id 列表，池序、不过滤封禁/限流）。本函数据它算出起点
 * 的**池位次**，再从候选里取「池位次 ≥ 起点」的第一个 —— 候选是按策略序
 * 排的，故那个就是「起点之后」的第一个候选。
 *
 * ## 三条不变量
 *
 * 1. **集合不变**：只旋转，不增删（长度与元素身份都不变）；
 * 2. **保序**：起点之后 / 之前的各自保持原相对顺序；
 * 3. **找不到就原样**：`rotationStartId` 指向的账号**已被删除**（不在
 *    `enabledAccountIds` 里）⇒ 与未设置**逐字节相同**，不报错。
 *    ⚠️ 与「起点被封禁/限流」**刻意区分**：后者账号还在，用户的选择仍有意义，
 *    故循环到下一个可用；前者选择已无处可指，回落默认才是唯一合理语义。
 *
 * @param ranked - **已按策略排好序**的候选（⚠️ 必须排在旋转之前）
 * @param options - 与排序同一份选项（需要 `allowPermanent` 判可用性，
 *   可选 `enabledAccountIds` 定位「不在候选里的起点」）
 * @returns **新数组**
 */
export declare function rotateFromPreferred<T extends BuddyAccountBalance>(ranked: readonly T[], options?: BuddyTierOptions): T[];
/**
 * 判定单个账号的档位。
 *
 * ⚠️⚠️ **入参必须是「已分桶」的形状，不是 `CreditBalance`**（2026-11-01 三审实测踩到）：
 * 两个字段都是**可选**的 ⇒ TypeScript 对**任意对象**都放行（`CreditBalance` 也兼容）⇒
 * 传错时**编译零报错**，而 `positiveOrZero(undefined)` 归 0 ⇒ **恒返回 `none`**。
 * 症状极像真缺陷：「锁定永久积分后整池不可用」，与「所有号真的只剩永久」**同形**，
 * 且日志零字 —— 三审的探针就这样误报过一次（连「今天到期的 200 分」都被判成 none）。
 *
 * 正确形状只能由 `splitBuddyCreditsByExpiry(...)` 的 `{expiring, permanent}` 映射而来
 * （见 `src/buddy-balance-selector.ts` 的 `classify()` 与下面的 `rankBuddyAccountsByBalance`）。
 *
 * ⚠️ 刻意**不**把两个字段改成必填：`buddyBalanceTier({})` 返回 `none` 是既有用例
 * 明确要求的**防御语义**（`tests/unit/buddy-balance-rank.spec.ts` 有一条专门钉它），
 * 改成必填会连带推翻它 —— 故只登记、不改签名。
 *
 * ⚠️ **`expiring > 0` 优先于 `permanent > 0`**：快到期不用就作废，永久积分短期
 * 内还在。故只要还有 15 天内到期的余额就一定先用它。
 *
 * ⚠️ **锁定永久积分时（`allowPermanent: false`）**：永久积分不参与判定 ——
 * 只剩永久积分的账号直接落入 `none`（不可用），而不是降到 `permanent` 档。
 */
export declare function buddyBalanceTier(balance: {
    expiringBalance?: number;
    imminentBalance?: number;
    permanentBalance?: number;
}, options?: BuddyTierOptions): BuddyBalanceTier;
/**
 * 该档位是否「可用」（可承载请求）。
 *
 * `none` 档不可用 —— 调用方据此判断「真的没有可用账号」并报明确错误。
 */
export declare function buddyTierUsable(tier: BuddyBalanceTier): boolean;
/**
 * 按档位排序账号（**稳定排序**：档内保持传入顺序）。
 *
 * 与 `rankLoomyAccountsByBalance` 同款「装饰 - 排序 - 解装饰」写法：显式带
 * 原始下标可让「档内不重排」这一约定自明，且不受引擎实现影响。
 *
 * @param accounts - 待排序账号（顺序即手动优先级）。
 * @param options - 分档选项（`allowPermanent` = 是否允许消耗永久积分）。
 * @returns **新数组**（不修改入参）。
 */
export declare function rankBuddyAccountsByBalance<T extends BuddyAccountBalance>(accounts: readonly T[], options?: BuddyTierOptions): T[];
/**
 * 「严格手动顺序」版的候选排序：**档位只当可用性判据，不当先后判据**。
 *
 * ## 它与 {@link rankBuddyAccountsByBalance} 的唯一差别
 *
 * | | 默认（`rankBuddyAccountsByBalance`） | 严格手动顺序 |
 * |---|---|---|
 * | 先后由谁决定 | 先按档位，**档内**才看手动顺序 | 一律按手动顺序 |
 * | 档位还剩什么用 | 决定谁先 | **只决定「谁还可用」**（`none` 档沉底） |
 *
 * ## 为什么「沉底」这一条不能一起去掉
 *
 * `none` 档包含两类账号：**余额查询失败**的，和**锁定永久积分后只剩永久积分**的。
 * 后者正是「锁定永久积分」要保护的对象 —— 若严格模式把它当普通候选排在最前，
 * 用户明明锁了永久积分，请求仍会落到那个号上并消耗永久积分（不可撤回）。
 *
 * ⇒ 严格模式**保留档位的筛选语义**（`none` 沉底），只**放弃档位的排序语义**：
 * `expiring` 与 `permanent` 两档在严格模式下**同权**，全都按用户拖的顺序排。
 *
 * ⚠️ 这与「锁定永久积分」的既有判据不冲突：`buddyBalanceTier` 在
 * `allowPermanent: false` 时对「只剩永久积分」的账号直接返回 `none`，
 * 于是它照样被沉底 —— 锁定语义在两条排序里完全一致。
 *
 * ⚠️ 稳定排序：`Array.prototype.sort` 在现代引擎是稳定的，但这里的比较器本身
 * 就带原始下标兜底，故不依赖引擎实现细节。
 *
 * @param accounts - 待排序账号（顺序即手动优先级）。
 * @param options - 与 {@link rankBuddyAccountsByBalance} 同义（`allowPermanent` 决定
 *   哪些账号算「不可用」）。
 * @returns **新数组**（不修改入参）。
 */
export declare function rankBuddyAccountsByManualOrder<T extends BuddyAccountBalance>(accounts: readonly T[], options?: BuddyTierOptions): T[];
/**
 * 把一次拆分结果格式化成一行摘要（供日志与账号卡片提示使用）。
 *
 * ⚠️ 两个桶都为 0 时返回「无可用积分」而不是「临时 0 / 永久 0」——
 * 用户读后者需要自己推断，前者一眼可见。
 *
 * ⚠️ **有临期额度时必须把它单列**（`临期 X · 5 天内到期 Y · 永久 Z`）：
 * 若只说「15 天内到期 Y」，「其中 X 会在 5 天内烧掉」这个最关键的决策信息
 * 就丢了 —— 而这正是引入临期档的全部目的。
 */
export declare function describeBuddyCreditSplit(split: BuddyCreditSplit | undefined, windowDays?: number, imminentDays?: number): string;
//# sourceMappingURL=buddy-balance-rank.d.ts.map