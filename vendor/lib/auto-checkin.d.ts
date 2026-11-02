/**
 * 「每日首次启动自动签到」—— 开关、当日记录与执行体。
 *
 * ## 它做什么
 *
 * DSH 启动后延迟一小段（默认 30 秒，见下），若这个开关开着、且**今天（UTC+8）
 * 还没跑过**，就串行遍历「账号池里真的有账号的渠道」，逐个调内部
 * `credits.claimAll`；跑完把日期与**逐渠道结果**写进文档 ⇒ **当天不再触发**。
 * 用户手动点「全部渠道签到」不受此限（那是显式操作，永远放行）。
 *
 * ⚠️ **开关默认打开**（用户 2026-10-02 明确要求：「自动签到默认保持打开状态」）。
 * 这与「这是代用户打上游的写操作」相权：该特性本身是用户要的，默认开启才符合
 * 「每日第一次打开 DSH 就自动签到」的预期；用户随时可以在状态灯上关掉。
 * 判据是**只有显式 `false` 才算关闭**（与本仓库账号的 `enabled !== false` 同惯例）。
 *
 * ## 为什么延迟 30 秒
 *
 * 两个理由，任一成立都不该立刻跑：
 * 1. **不跟启动抢资源**：一轮签到是「渠道数 × 账号数」次串行上游请求（反风控
 *    口径，见 `collectCreditBalances` 的顺序查询），启动瞬间打它会拖慢首屏；
 * 2. **等凭据续期先跑一轮**：宿主启动时的续期调度器**本身也要立刻跑一轮**
 *    （见 `index.ts` 的注释：短寿命 provider 的凭据在关机期间早就过期）。
 *    若抢在续期之前签到，过期凭据会让整轮变成失败。
 * 即便如此仍可能抢在续期完成前（多账号时续期本身就要几秒到几十秒），故**再加
 * 一道保险**：整轮跑完**没有任何一条能证明「今天已被处理」**时**不记日期**，
 * 下次启动会重试（见 {@link runnableSlotKey} 与逐渠道水位线）。延迟可用
 * `DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS` 覆盖，`0` 合法（表示立刻跑，单测用它）。
 *
 * ## 什么算「今天已被处理」
 *
 * ⚠️ **不是** `claimed + alreadyClaimed`，而是各渠道用
 * `ClaimOutcome.coversToday` 声明出来的 `summary.coversToday`
 * （真实缺陷，2026-10-02 审查 PR !33 定位：Qoder 活动每日 10:00（UTC+8）才刷新，
 * 上午那轮看到的 `CLAIMED` 属于**昨天**，拿它记账会让当天额度**整天漏领**）。
 *
 * ## 为什么单独一份文档，而不是塞进 ui-preferences.json
 *
 * `ui-preferences.json` 是**同 dsh home、多 profile 共享**的文档，而本仓库写盘
 * 是**整体替换**语义（见 `badge-preferences.ts` 的文件头对 state.json 记过的
 * 同一条理由）。同机上另一条工作区跑着**没有本功能**的旧版本插件时，它保存显示
 * 偏好会把这里的字段静默抹掉 —— 后果是「开关自己关了」或「今天又跑一次」。
 * 独立文档的读写者只有本文件，旧版本代码碰不到它。
 *
 * ## ⚠️ 不支持的渠道怎么判：**不建第二份能力名单**
 *
 * 「哪些渠道能签到」的权威是客户端的 `credits-capabilities.js`（12 个渠道逐项
 * 登记）。在本模块再抄一份必然漂移（本仓库已有「两份名单漂移」的真实缺陷）。
 * 故判据交给 `credits.claimAll` 自己：cline / raccoon / **workbuddy** 三条分支
 * **不发任何上游请求**就返回「不支持每日签到」，本模块把这类错误计为**跳过**，
 * 既不算失败也不重试。
 *
 * ⚠️ 其中 **workbuddy 的那条守卫是本功能先补上的**：此前它会落到 buddy 产品
 * 分支、真去发必然失败的签到请求（客户端从不调用它，是因为能力表写着 false，
 * 所以这个洞一直没被触发）。补上之后，「调用即判定」这条规则才真正安全。
 *
 * ## ⚠️「调用即判定」管不到的一类：签到**有代价**的渠道
 *
 * zcode 有签到，但每次领取都要现场产阿里云 captcha（web 版会拉起 headful
 * Chromium，且阿里云按设备限流 150 次/小时）。「等它返回错误再判定」来不及 ——
 * 代价发生在**调用期间**。故另有一张**排除表** `isAutoCheckinExcluded()`，
 * 在调 `claim` **之前**生效（详见那里的说明与维护口径）。用户仍可手动签到。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { BadgeRpcResult } from './usage-badge.js';
import type { RpcCreditsClaimAllResponse, RpcUsageAutoCheckinState } from './types.js';
/** 独立文档的文件名（与 state.json / ui-preferences.json 同目录）。 */
export declare const AUTO_CHECKIN_FILE = "auto-checkin.json";
/**
 * 文档内容。
 *
 * `lastDate` / `lastResult` 既是「当天不重复触发」的判据，也是状态灯提示的来源
 * （用户要求「记录签到状态，不多次重复触发」）。`channels` 是**逐渠道**结果，
 * 供面板上那行常驻的自动签到状态文字使用（用户 2026-10-02：「自动签到状态下，
 * 下方应该也显示文字状态，这样才能够知道各个渠道的签到状态」）。
 */
export interface AutoCheckinDoc {
    /**
     * 自动签到开关。**默认打开**（用户 2026-10-02 明确要求：「自动签到默认保持打开
     * 状态」）—— 故判据是「只有显式 `false` 才算关闭」，与本仓库账号的
     * `enabled !== false` 惯例一致。
     */
    enabled: boolean;
    /**
     * 每天**两个**执行时刻（`HH:MM`，UTC+8，升序、去重、恰好两个）。
     *
     * 用户 2026-10-18 要求：「每天几点自动启动…一天两次实现无遗漏」—— 原先的
     * 「每日首次启动跑一次」在「早上开过 DSH 就再也不跑」时，会让 21:00 之后才刷新
     * 额度的渠道整天漏领。两个时段各自独立记账（见 {@link lastSlot}）。
     *
     * ⚠️ 2026-10-31 重建：上一版实现随一次 `git reset --hard` 升级被清空，本字段
     * 与 `lastSlot` 是按同一设计**重新实现**的（不是从 stash 恢复）。
     */
    times: string[];
    /**
     * 随机浮动幅度（分钟）：0 = 精确按 `times` 执行；>0 = 每轮在 ±N 分钟内随机偏移。
     *
     * 用户 2026-10-31：「搞得像真人一样有时间波动」—— 固定到分钟的签到时刻是
     * 很明显的脚本特征。取 0 即关闭（默认，与旧行为等价）。
     *
     * ⚠️ 偏移**每轮重新抽**，而不是「每天固定一个偏移量」：后者的指纹仍然每天相同
     *（例如每天都晚 7 分钟），和固定时刻一样可识别。
     */
    jitterMinutes: number;
    /** 上次**完成**自动签到的 UTC+8 日期（`YYYY-MM-DD`）；空串 = 从未跑过。 */
    lastDate: string;
    /**
     * 已完成时段的**水位线**（`YYYY-MM-DD#HH:MM`）。
     *
     * 语义：**key 不大于它的时段都算已处理**。用单条水位线而不是逐时段布尔表，
     * 是因为时段天然单调，一条水位线就能表达「今天 09:00 跑过了、21:00 还没到」；
     * 而逐时段表会随时间无限增长，还得写清理逻辑。
     *
     * ⚠️ 空串 = 从未跑过 ⇒ **已到点的时段都算待补**（见 `shouldRunNow`）。
     * 这是「启动后补跑错过时段」的落点：DSH 没开时那一刻不会触发，下次启动看到
     * 水位线落后就会补跑。
     */
    lastSlot: string;
    /**
     * 正在**补领**的时段（`YYYY-MM-DD#HH:MM`）；空串 = 没有待补的渠道。
     *
     * ## 为什么需要它（2026-11-01 审计 P1-5）
     *
     * 水位线是**整轮**粒度：一轮里只要**有一个**渠道证明「今天已处理」，整轮就记账，
     * 于是「10:00 才刷新额度」的渠道（Qoder 活动）在 09:00 那轮拿到的是昨天的痕迹
     * 却**再也不会被单独重试** ⇒ 当天漏领。实测：混合池 + 21:00 前关 DSH，
     * Qoder 在 10:00 之后的调用次数为 **0**。
     *
     * 修法：把「哪个渠道已经处理到哪个时段」记成逐渠道水位线
     *（{@link providerSlots}），本轮没领到的渠道留在 `pendingSlot` 上按退避重试，
     * 重试时**只打**那些渠道（`performRun` 会跳过已处理的）。
     */
    pendingSlot: string;
    /**
     * **逐渠道**水位线：该渠道已处理到哪个时段 key。
     *
     * 语义与 `lastSlot` 同构，只是粒度是渠道：
     * - 缺失 / 空串 ⇒ 该渠道还没处理过任何时段；
     * - `>= 目标时段` ⇒ 本轮跳过它（不重复打上游）。
     *
     * ⚠️ 只保留**当前池里出现过的**渠道键（`performRun` 每轮用 `listProviderIds()`
     * 的结果重建），故不会无限增长 —— 渠道总数就 12 个。
     */
    providerSlots: Record<string, string>;
    /** 上次结果摘要（中文短句，展示在状态灯提示里）。 */
    lastResult: string;
    /** 上次跑完的时刻（毫秒）；0 = 从未跑过。 */
    lastAt: number;
    /** 逐渠道结果（顺序即遍历顺序）；空数组 = 没有可展示的逐渠道信息。 */
    channels: Array<{
        provider: string;
        text: string;
    }>;
    /**
     * 用户点过「关闭」的那一轮（存的是那一刻的 `lastAt`）。
     *
     * ⚠️ 存 `lastAt` 而不是布尔：新一轮跑出来 `lastAt` 变了，状态文字就会**重新出现**
     *（否则用户关过一次以后就再也看不到新的结果）。0 = 未曾关闭过。
     */
    dismissedRunAt: number;
}
/**
 * 默认两个执行时刻（UTC+8）。
 *
 * ## 为什么保持 **09:00 / 21:00**（2026-11-01 第二轮审计推翻了「改成 10:05」）
 *
 * 本仓库各渠道的每日额度刷新时点**不统一**：多数在 00:00，而 Qoder 活动要
 * **10:00（UTC+8）** 才刷新（见文件头与 `credits.ts`）。09:00 那轮对 Qoder 拿到的是
 * **昨天**的 `CLAIMED`（`coversToday === 0`）——旧实现因此整天漏领。
 *
 * 曾经把默认改成 10:05 来回避，但那有两个真问题：
 * ① **修不到存量用户**：`FileAutoCheckinStore.save` 每轮都会把 `times` 写盘，跑过一轮的
 *   文档里 09:00 已被固化 ⇒ 只有「从没跑过的新装」才变成 10:05，两批用户行为不一致；
 * ② **多跑一整轮**：工作日 09:00–18:00 的用户会看到「每天两轮全渠道扫」（12 渠道
 *   24 次写请求），而某些开关机组合会从「1 轮/天」变成「某天 0 轮」。
 *
 * 真正的修法是**逐渠道水位线 + 补领**（见 {@link AutoCheckinDoc.pendingSlot}）：
 * 09:00 那轮 Qoder 没证明今天 ⇒ 只重试 Qoder，10:00 刷新后自然领到；
 * 窗口 3 小时（`LAG_RETRY_WINDOW_MS`）覆盖「浮动把 09:00 提前到 07:00」的最坏情形。
 */
export declare const DEFAULT_AUTO_CHECKIN_TIMES: readonly string[];
/** 恰好两个时段：用户明确要求「一天两次」。 */
export declare const AUTO_CHECKIN_SLOT_COUNT = 2;
/** 默认：打开 + 默认时段 + 无记录。 */
export declare const DEFAULT_AUTO_CHECKIN: AutoCheckinDoc;
/**
 * 归一化文档：非法值一律回落默认值（**不抛错**）。
 *
 * ⚠️ 与 RPC 写入路径的严格校验**不冲突**：那条路径面对用户输入，要拒绝非法值；
 * 这条路径面对**磁盘上的脏数据**（手工编辑过、被旧版本写坏），回落比整机不可用
 * 更合理 —— 判据口径与 `sanitizeBadgePreference` 一致。
 * ⚠️ 缺新字段的**旧文档**（没有 `channels` / `lastAt` / `enabled`）必须照常读出来：
 * 前两个是本功能上线后追加的，而 `enabled` 缺失要按**默认打开**处理（不是关闭）。
 */
export declare function sanitizeAutoCheckin(raw: unknown): AutoCheckinDoc;
/**
 * 归一化时段列表：丢掉非法项、去重、升序，**不足回落到默认两个**、**多于保留首尾**。
 *
 * ⚠️ 不能「只补到两个」：旧文档没有 `times` 字段 ⇒ 空数组 ⇒ 若原样保留，自动
 * 签到会**永远等不到时段**（一天都不跑），而这正是本特性的核心失效形态。回落
 * 默认值让升级后立刻按 09:00/21:00 工作，用户再改。
 * ⚠️ 也不能保留多于两个：用户要求「一天两次」，多留的时段会变成「一天跑三次」。
 * ⚠️ 但**多余项要留首尾**，不是「排序后前两个」（2026-11-01 第二轮审计 P3）：
 * 取前两个会把**最晚那一轮**静默丢掉（`["09:00","14:00","21:00"]` ⇒ 只剩
 * 09:00/14:00，晚上那次没了）。留首尾至少保住全天的覆盖跨度。
 */
export declare function sanitizeTimes(raw: unknown): string[];
/**
 * 严格校验用户提交的浮动幅度（RPC 写入路径专用）。
 *
 * ⚠️ 与 {@link sanitizeJitter} 分开：那个面对磁盘脏数据（回落 0），本函数面对
 * 用户输入（**抛错**）。回落会让「设置没生效」看起来像「保存成功」。
 */
export declare function sanitizeJitterStrict(raw: unknown): number;
/** 随机浮动的上限（分钟）。超过 2 小时就不再是「波动」而是「随机跑」，会破坏「两次覆盖全天」的设计。 */
export declare const MAX_CHECKIN_JITTER_MINUTES = 120;
/**
 * 归一化随机浮动幅度。
 *
 * ⚠️ 非法值一律回落 **0**（= 关闭浮动），而不是回落默认值：读不出「用户到底要多少」
 * 时，宁可**精确执行**（可预期）也不要随机漂移 —— 后者会让「今天怎么没跑」难以排查。
 * ⚠️ 上限 `MAX_CHECKIN_JITTER_MINUTES`：超过 2 小时的偏移会让某个时段的执行落到
 * 另一个时段附近，两个时段可能合并成一次，破坏「两次覆盖」的前提。
 */
export declare function sanitizeJitter(raw: unknown): number;
/** 时段文本是否合法（`HH:MM`）。RPC 写入路径用它拒非法值。 */
export declare function isLegalTimeText(value: unknown): value is string;
/**
 * 取「UTC+8 的当天日期」（`YYYY-MM-DD`）。
 *
 * ⚠️ 必须用**算术平移**而不是本机时区：日界归服务端（各渠道的每日额度按 UTC+8
 * 结算），取本机时区会在用户出差/改系统时区时得到错的「今天」—— 偏东会提前把
 * 当天记为已跑（真的漏签），偏西会一天跑两次。偏移量复用 `model-queue.ts` 的
 * `QODER_BILLING_UTC_OFFSET_MS`（同一口径，不另立常量）。
 */
export declare function utc8DateString(nowMs?: number): string;
/**
 * 取「UTC+8 的当前时刻」（`HH:MM`）。与 `utc8DateString` 同源平移。
 *
 * ⚠️ 同样不能用本机时区：时段是用户按 UTC+8 心智设定的（上游额度也按 UTC+8 结算），
 * 用本机时区会在改系统时区时整体偏移。
 */
export declare function utc8TimeString(nowMs?: number): string;
/**
 * `YYYY-MM-DD` + `HH:MM`（UTC+8）⇒ 毫秒时刻。
 *
 * ⚠️ 必须手动拼 UTC 再减偏移，**不能**用 `new Date('2026-10-18T09:00')`：
 * 后者按**本机时区**解析，用户改系统时区时会算错（与 `utc8DateString` 同一条理由）。
 */
export declare function utc8MomentMs(date: string, time: string): number;
/**
 * 把「日期 + 时刻」拼成可比较的水位线 key。
 *
 * ⚠️ 比较必须用**字符串**而非 Date：key 的字典序恰好等于时间序（定宽
 * `YYYY-MM-DD#HH:MM`），而跨时区用 Date 反而容易算错 —— 本模块的日界一律按
 * UTC+8 算术平移，不需要也不应该引入本地 Date 语义。
 */
export declare function slotKey(date: string, time: string): string;
/**
 * 一个时段的解析结果：`key` 用于水位线比较，`realAt` 是**真实执行时刻**
 * （= 时段时刻 + 该轮确定性偏移）。
 */
export interface CheckinSlot {
    key: string;
    realAt: number;
}
/**
 * 枚举 [昨天, 今天, 明天] 三天的全部时段，按 `realAt` 升序。
 *
 * ## 为什么把「偏移」算进时段本身（2026-11-01 审计 P1-2）
 *
 * 旧实现先按**时段时刻**取 `due`，再拿 `realAt` 比 `now`。偏移为负时
 * （真实执行时刻在时段**之前**），`due` 还没轮到那个时段 ⇒ `shouldRunNow`
 * 恒 false ⇒ **负偏移是死代码**，「±N 浮动」实际只有 `[0, +N]`。
 * 实测：全年 730 个时段里负偏移占 49.7%、**提前执行 0 次**；而且约一半的日子
 * 精确在 `HH:MM:00` 执行 —— 正是浮动想消掉的那个脚本指纹。
 *
 * 把 `realAt` 作为**唯一**判据（「到点」= `realAt <= now`）之后：
 * - 负偏移的时段会在时段**之前**被判为到点 ⇒ `±N` 真的是双向的；
 * - 「已到点但真实时刻未到」这个中间态**不存在**了 ⇒ `nextRunDelayMs` 不再
 *   恒返回 0，`armNext` 的每秒空转自动消失（审计 P1-3）。
 *
 * ⚠️ 偏移的夹紧保证 `span <= 与下一时段间隔的一半` ⇒ `realAt` 的先后顺序与
 * 时段 key 的字典序**一致**，故水位线仍可用字符串比较。
 */
export declare function checkinSlotsAround(nowMs: number, times: readonly string[], jitterMinutes?: number): CheckinSlot[];
/**
 * 当前时刻**已经真的到点**的最大时段 key（含浮动偏移）。
 *
 * 例（times = 09:00 / 21:00，jitter = 0）：
 * - 今天 08:30 ⇒ **昨天 21:00**；
 * - 今天 09:05 ⇒ 今天 09:00；
 * - 今天 22:00 ⇒ 今天 21:00。
 *
 * 配了浮动后判据换成「时段时刻 + 偏移 <= now」：偏移为负 ⇒ 会在时段之前到点。
 *
 * @param jitterMinutes - 浮动幅度（分钟）；省略 = 0（与旧签名兼容）。
 */
export declare function latestDueSlotKey(nowMs: number, times: readonly string[], jitterMinutes?: number): string;
/** 下一个**真实执行时刻还没到**的时段；没有（`times` 为空）⇒ `null`。 */
export declare function nextSlotRef(nowMs: number, times: readonly string[], jitterMinutes?: number): CheckinSlot | null;
/**
 * 为某个时段算一个「随机但确定」的执行偏移（毫秒）。
 *
 * ## 为什么要「确定」
 *
 * 偏移必须**同一个时段每次算出来都一样**，否则同一轮会出现两种时间：
 * 面板显示的「下次执行」与实际触发时刻不一致（用户会发现「说 9:05 却 9:12 才跑」）。
 * 故用 (日期, 时刻) 作为**种子**做哈希 —— 同一天同一时段恒定，换一天/换时段就变。
 *
 * ## 为什么不用 Math.random()
 *
 * `Math.random()` 每次调用都不同 ⇒ 上面那条立刻不成立；而且它不可测（单测无法固定）。
 * 这里用一个极简的字符串哈希（FNV-1a 变体），纯函数、可复现、零依赖。
 *
 * ## 边界：偏移绝不许越过下一个时段
 *
 * ⚠️ 若 09:00 那轮被 +60 分钟推到 10:00，而下一时段是 10:30，就可能出现两轮贴着跑；
 * 更糟的是若推到 21:00 之后，两个时段会**合并成一次**，「一天两次」就失效了。
 * 故偏移幅度取 `min(jitter, 与下一时段间隔的一半)`。
 *
 * @param date - UTC+8 日期（`YYYY-MM-DD`）。
 * @param time - 该时段的原始时刻（`HH:MM`）。
 * @param jitterMinutes - 用户配置的浮动幅度（0 = 不浮动）。
 * @param nextGapMinutes - 与下一时段的间隔分钟数（用于夹紧）。
 * @returns 毫秒偏移；正负都可能。
 */
export declare function checkinJitterOffsetMs(date: string, time: string, jitterMinutes: number, nextGapMinutes: number): number;
/**
 * 现在该为**哪个时段**跑一轮：`''` = 不用跑。
 *
 * 判据优先级：
 * 1. `pendingSlot`（上一轮还有渠道没领到，例如 10:00 才刷新额度的渠道）——
 *    只要它还没被新时段顶掉，就继续打它（审计 P1-5：旧实现只认「整轮是否
 *    证明今天」，混合渠道池里只要别的渠道证明过今天，Qoder 这类 10:00 才刷新
 *    的渠道就再也不会被单独重试 ⇒ 当天漏领）；
 * 2. 水位线落后于**已到点的最大时段** ⇒ 跑那个时段。
 *
 * ⚠️ 这里**不是**「今天跑过没有」：一天两个时段各自要跑一次，用「今天跑过」
 * 判会让第二个时段永远不触发。
 * ⚠️ `lastSlot` 为空（从未跑过）⇒ 只要有到点的时段就跑：这正是「首次启用
 * 立刻补跑」的行为。
 */
export declare function runnableSlotKey(doc: Pick<AutoCheckinDoc, 'enabled' | 'times' | 'lastSlot'> & {
    jitterMinutes?: number;
    pendingSlot?: string;
}, nowMs: number): string;
export declare function shouldRunNow(doc: Pick<AutoCheckinDoc, 'enabled' | 'times' | 'lastSlot'> & {
    jitterMinutes?: number;
    pendingSlot?: string;
}, nowMs: number): boolean;
/** 环境变量：启动后延迟多久再尝试自动签到（毫秒）。 */
export declare const DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS = "DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS";
/** 默认延迟（毫秒）。理由见文件头「为什么延迟 30 秒」。 */
export declare const AUTO_CHECKIN_DELAY_MS = 30000;
/**
 * 读延迟配置。
 *
 * ⚠️ 不能写成 `Number(env.X) || 默认值`：`0` 是**合法**值（立刻执行），
 * 而 `0` 是 falsy 会被静默换成 30 秒 —— 与本仓库 `DSH_JET_HUB_BADGE_TTL_MS`、
 * `DSH_QODER_QUEUE_TIMEOUT_MS` 记过的是同一个坑。
 */
export declare function autoCheckinDelayMs(env?: NodeJS.ProcessEnv): number;
/** 文档后端：文件（正常）或内存（定位不到 dsh home 时的显式降级）。 */
export type AutoCheckinStoreKind = 'file' | 'memory';
/** 文档读写接口（同步读、异步写，与 `BadgePreferenceStore` 同款约定）。 */
export interface AutoCheckinStore {
    readonly kind: AutoCheckinStoreKind;
    /** 载入文档；不存在 / 损坏 / 字段非法时返回默认值。 */
    load(): AutoCheckinDoc;
    /** 整份写入（原子写）。 */
    save(doc: AutoCheckinDoc): Promise<void>;
}
/** 创建文档后端（home 与账号池 / 偏好文档用**同一个** `resolveJetHubHome`）。 */
export declare function createAutoCheckinStore(ctx: Context): AutoCheckinStore;
/** 一轮执行的累计口径（账号级计数来自各渠道的 `summary`）。 */
interface RunTotals {
    /** 真正跑过 `claimAll` 的渠道数（不含被跳过的）。 */
    providers: number;
    claimed: number;
    totalCredit: number;
    /**
     * ★ **按单位分组**的合计（2026-10-04）。
     *
     * ⚠️ 展示路径**必须**用它而不是 {@link totalCredit}：后者跨单位求和，
     * 会把 ZCode 的 token 与其余渠道的积分加成一个数（真实缺陷，见
     * `RpcCreditsClaimSummary.totalByUnit`）。
     */
    totalByUnit: Record<'token' | 'credit', number>;
    alreadyClaimed: number;
    inactive: number;
    failed: number;
    /**
     * 其中**能证明「今天这一轮已被处理」**的账号数（来自 `summary.coversToday`）。
     *
     * ⚠️ 这是**唯一**该看的口径（逐渠道判据也用它）—— 不能用
     * `claimed + alreadyClaimed`：那两项里混着「刷新前那一轮」的痕迹
     * （Qoder 活动 10:00 UTC+8 才刷新），拿它们记账会让当天新额度整天漏领。
     * 字段语义见 `src/credits.ts` 的 `ClaimOutcomeCommon.coversToday`。
     */
    coversToday: number;
    /** 渠道级：不支持签到（`claimAll` 未发上游请求就返回的那些）。 */
    skipped: number;
    /** 渠道级：其它错误（凭据、网络……）。 */
    errors: number;
}
/**
 * 「不支持每日签到」的判据：`credits.claimAll` 对 cline / raccoon / workbuddy
 * 返回的**显式**错误文案（这三条分支都不发上游请求）。
 *
 * ⚠️ 兜底认 `unsupported provider`：那是 `productById` 找不到产品时的文案，
 * 语义同样是「这个渠道没有可用的签到实现」，计成失败只会制造假警报。
 * ⚠️ 判据必须**窄**：只匹配这两个短语，不要泛化成「含 unsupported」之类，
 * 免得把真正的参数错误也吞掉。
 */
export declare function isUnsupportedCheckin(message: string): boolean;
/**
 * ⚠️ **自动签到不适合**的渠道：领取过程需要**用户在场 / 外部程序**。
 *
 * ## 为什么不靠「错误文案」判（真实缺陷，2026-10-02 审查 PR !33 定位）
 *
 * 本文件原先的规则是「判据交给 `credits.claimAll` 自己：不支持的渠道会
 * **不发上游请求**就返回错误」。那对 cline / raccoon / workbuddy 成立 ——
 * 它们的守卫在 `claimAll` 里，返回前一个请求都没发。
 *
 * 但**漏了一类**：zcode **有**签到，只是每次领取都要现场产一个阿里云
 * captcha param（`jet-hub-rpc.ts` 的 zcode 分支无条件调 `zcode.mintCaptcha`）。
 * web 版下它会**拉起 headful Chromium**（约 200–400MB），而阿里云按**设备**
 * 限流「同设备每小时 150 次」。默认开启的自动签到等于：用户什么都没点，
 * 开 DSH 就起一棵浏览器进程树、白耗设备级配额；一旦这轮失败又不写 `lastDate`
 * ⇒ **每次启动都重来**，一天开十次就是十轮 captcha。
 *
 * ## 判据与维护口径
 *
 * - 这张表是**第二份名单**，但它记的不是「谁有签到接口」（那仍由
 *   `claimAll` 的守卫 + 客户端能力表负责），而是「谁有签到**代价**」——
 *   后者无处可查，只能显式登记。**新增带 captcha / 外部浏览器的 provider 时，
 *   必须同时登记到这里**（`tests/unit/auto-checkin.spec.ts` 有反向守护用例：
 *   一旦 zcode 的 claim 分支又开始调 `mintCaptcha`，而本表没登记，用例会红）。
 * - 用户仍可在面板里**手动**点 zcode 的「一键领取积分」—— 那是有意行为，
 *   浏览器弹出来是用户自己能理解的交互。
 */
export declare function isAutoCheckinExcluded(provider: string): boolean;
/** 把一轮结果拼成一句中文摘要（给状态灯提示与日志用）。 */
export declare function describeRun(totals: RunTotals): string;
/**
 * 单个渠道的短状态（面板上那行常驻文字用它逐渠道列出，用户要求「这样才能够知道
 * **各个渠道**的签到状态」）。
 *
 * ⚠️ 必须**短**：十余个渠道要挤在 280px 的面板里一行一个片段，长文案会撑成好几屏。
 * （⚠️ 这里**刻意不写死渠道数** —— 2026-10-16 合并审计实测：原文写「9 个」，
 * 加 `minimaxintl` 后已是 10 个。写死数字必然腐坏。）
 * 故只给「几个账号 + 什么结果」，不带渠道名（渠道名由展示层补）。
 */
export declare function describeChannel(summary: {
    claimed: number;
    totalCredit: number;
    alreadyClaimed: number;
    inactive: number;
    failed: number;
    /** 见 `RpcCreditsClaimSummary.coversToday`；缺省按 `claimed+alreadyClaimed` 兜底。 */
    coversToday?: number;
    /**
     * ★ 按单位分组的合计（2026-10-04）。**缺省回落到「全部按积分」**，
     * 以兼容尚未上报该字段的旧响应（与 `coversToday` 的兜底同思路）。
     */
    totalByUnit?: Partial<Record<'token' | 'credit', number>>;
}): string;
/**
 * 严格校验用户提交的时段列表（RPC 写入路径专用）。
 *
 * ⚠️ 与 {@link sanitizeTimes} **刻意分开**，两者面对的数据源不同：
 * - `sanitizeTimes` 面对**磁盘脏数据** ⇒ 必须回落默认值，因为「读不回来」不该
 *   让整个特性失效；
 * - 本函数面对**用户输入** ⇒ 非法值必须**抛错**。回落会让「设置没生效」看起来像
 *   「保存成功」，用户之后永远等不到那轮签到却毫无提示。
 *
 * 约束（用户要求「一天两次」）：恰好 {@link AUTO_CHECKIN_SLOT_COUNT} 个、格式
 * `HH:MM`、**不许重复**、自动升序（顺序对执行时机无影响，统一排序让水位线可比较）。
 */
export declare function sanitizeTimesStrict(raw: readonly unknown[]): string[];
/**
 * 下一个**尚未处理**的时段对应的毫秒时刻（UTC+8 基准）。
 *
 * 三种情形：
 * - 有时段待跑（水位线落后，或上一轮还有渠道没领到）⇒ 返回**现在**；
 * - 下一个时段的**真实执行时刻**还没到 ⇒ 返回那一刻（含浮动偏移）；
 * - `times` 为空 / 开关关 ⇒ 0。
 *
 * ⚠️ 「待跑即现在」这一步不能省：否则「22:00 启动、水位线停在昨天」会被算成
 * 「下次明天 10:05」，而实际上一轮补跑马上就要执行 —— 面板会显示自相矛盾的时间。
 * ⚠️ 但它**只覆盖「马上要跑」这一格**：退避重试期间真实的下一次尝试由
 * `state().nextRunAt` 取 `armNext` 排定的时刻（见 `nextAttemptAt`），不再在这里
 * 编一个「现在」（审计 P1-4：旧实现在退避期间一直显示「马上执行」，实际 30 分钟后）。
 */
export declare function nextRunAtOf(nowMs: number, doc: Pick<AutoCheckinDoc, 'enabled' | 'times' | 'lastSlot'> & {
    jitterMinutes?: number;
    pendingSlot?: string;
}): number;
/**
 * 距下一次执行的毫秒数。
 *
 * ⚠️ 待跑（水位线落后 / 有渠道没领到）时返回 **0** —— 调用方用
 * `Math.max(1_000, …)` 兜住，既保证「立刻补跑」，又不会在水位线尚未写盘时形成忙循环。
 *
 * ⚠️⚠️ 旧实现在这里留了一个坑（审计 P1-3）：「时段已到点、但浮动后的真实时刻还没到」
 * 也会返回 0 ⇒ `armNext` 每秒醒一次（实测 2 小时 2653 次唤醒）。现在「到点」的判据
 * 本身含偏移（见 `checkinSlotsAround`），这个中间态不存在了 ⇒ 会返回正的等待时长。
 */
export declare function nextRunDelayMs(nowMs: number, doc: Pick<AutoCheckinDoc, 'enabled' | 'times' | 'lastSlot'> & {
    jitterMinutes?: number;
    pendingSlot?: string;
}): number;
/** 装配层注入的依赖（全部可替换 ⇒ 单测零网络、零文件系统、零等待）。 */
export interface AutoCheckinDeps {
    store: AutoCheckinStore;
    /**
     * 列出**账号池里有账号**的渠道 id。
     * 只遍历有账号的渠道：没有账号的渠道调 `claimAll` 只会拿到空结果，白白走一遍
     * 12 条分支。
     */
    listProviderIds(): Promise<string[]>;
    /**
     * 调某个渠道的签到 —— **必须复用 `credits.claimAll` 的实现**（装配层直接调内部
     * `handleMethod`）。本模块不认任何具体渠道，只按返回的信封判「跳过 / 失败」。
     */
    claim(provider: string): Promise<BadgeRpcResult<RpcCreditsClaimAllResponse>>;
    now?(): number;
    /** 延迟毫秒数；默认读环境变量。 */
    delayMs?: number;
    /** 排定延迟执行（注入以便单测零等待）。返回值交给 `stop()` 取消。 */
    schedule?(fn: () => void, ms: number): {
        cancel(): void;
    };
    warn?(message: string): void;
}
/** 自动签到执行体。 */
export interface AutoCheckin {
    /** 实时状态（供 RPC 与状态灯；`enabled` 等取自内存，不重新读盘）。 */
    state(): RpcUsageAutoCheckinState;
    /** 写开关；**打开时若有时段没跑，立刻跑一轮**（否则用户会以为开关没生效）。 */
    setEnabled(enabled: boolean): Promise<RpcUsageAutoCheckinState>;
    /**
     * 写两个执行时刻（`HH:MM`，UTC+8）。
     *
     * ⚠️ 校验必须在**写入前**：非法值一律拒绝（抛错由 RPC 层转成 `bad-request`），
     * **不做静默回落** —— 回落会让「设置没生效」看起来像「保存成功」。
     * ⚠️ 写完要**重排定时器**：否则新的 21:00 要等到明天才生效。
     */
    setTimes(times: readonly string[], jitterMinutes?: number): Promise<RpcUsageAutoCheckinState>;
    /**
     * 关闭面板上那行**常驻的**自动签到状态文字（用户点它上方的小按钮时调用）。
     *
     * ⚠️ 与手动签到的结果提示不同：那条是**按时自动消失**；这一条是用户要求
     * 「不要自动取消、给我开放手动关闭」。关闭记的是**这一轮**（当前的 `lastAt`），
     * 故下一轮跑出新结果时它会重新出现。
     */
    dismiss(): Promise<RpcUsageAutoCheckinState>;
    /** 启动时调用一次：延迟后排定一轮（内部自己判开关与当天是否已跑）。 */
    start(): void;
    /** 立刻按判据跑一轮（供「刚打开开关」与单测用）。 */
    runIfDue(): Promise<void>;
    /** 取消尚未执行的延迟任务（不打断已开始的一轮）。 */
    stop(): void;
}
/** 创建自动签到执行体。 */
export declare function createAutoCheckin(deps: AutoCheckinDeps): AutoCheckin;
export {};
//# sourceMappingURL=auto-checkin.d.ts.map