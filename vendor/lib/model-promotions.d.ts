/**
 * 上游**活动信息**的解析与「此刻该画哪一枚徽标」（GitHub issue #101）。
 *
 * ## 它解决什么
 *
 * 服务商的模型目录**自带**活动字段（限时免费 / 夜间折扣 / 错峰折扣 / 订阅优先）。
 * 本插件此前只把**倍率**抄进模型展示名（形如 GLM-5.2 · x0.79→x0.50），而那个箭头是
 * **取目录那一刻**算出来的字符串 —— 活动一过期，名字里的折扣还在，用户按优惠期
 * 选择模型却被按原价计费。issue #101 要的正是让「活动过期而用户仍按优惠期选择」
 * 这件事可被避免。
 *
 * 本模块补的是**徽标**这条腿：把上游的活动声明读成一份**未决**（不预先挑定）的候选表，
 * 由目录在**被读取的那一刻**按当前时钟挑一枚，画成宿主官方的 LlmModelInfo.badge ——
 * DSH 0.2.2 起模型选择器自己会渲染它（宿主 ModelSelect 的 renderModelLabel 回落分支
 * 就是 Tag{tone: badge.tone} + 名字；宿主 LlmRuntime.listModels 与 buildModelCatalog
 * 都把 badge 逐字透传，实测于本机 app.asar）。
 *
 * ## 移植来源（两条腿各取一家，判据不重写）
 *
 * - dsh-connect-workbuddy（src/promo.ts + docs/PROMO_BADGE.md）：腾讯系 /v3/config 的
 *   data.modelPromotions / data.modelTiers 形状，以及六条判据 —— running 优先于 standing、
 *   dailyUnusable 不许当成全天、validUntil 端点不含、display activeOnly、
 *   同分时活动先于等级标记、无颜色即 neutral。
 * - dsh-connect-qoder（src/promo.ts）：Qoder 目录 promotion 的形状，以及两条判据 ——
 *   有窗口时窗口说了算（active 只是无窗口时的回退）、**声明了窗口但读不懂**
 *   ⇒ 整条不画，既不当全天也不退回 active。
 *
 * ## ⚠️ 四条不能改的取舍
 *
 * 1. **判定放在读取时刻，不放在解析时刻**。一次目录读取会被宿主缓存很久
 *    （本仓后台刷新器 20 分钟一轮）。在解析时把徽标定死，等于「22:59 读到的
 *    夜间折扣，第二天 08:00 还挂在行上」—— 那正是本 issue 要修的形态。
 *    ⇒ 解析保留**全部候选**（parseModelsFromConfig 把它们挂在每条模型的 promos 上），
 *    挑选一枚发生在 toCatalogEntry 里。
 * 2. **不替上游说话**。文案一律是上游自己的 badge.label / badge.zh / badge.en，
 *    插件不翻译、不改写、不从 discount_factor 反推措辞。上游没给任何可显示的文案
 *    （无 badge）⇒ **整条丢弃**：腾讯的 modelPromotions 数组里混着
 *    hy-image-3.5 / kling-video-v3 这类**非促销**条目（只有 tags / videoGeneration），
 *    「无 badge 即丢弃」正是把它们挡在界面外的那道闸。
 * 3. **徽标只是提示，不改任何行为**。本模块不改写请求体、不改价格链路：倍率后缀继续走
 *    既有 parsePromotions + formatCreditsRate 那条已实测的路（src/buddy.ts，含
 *    「x 前后缀两套写法」「factor 0 = 免费」「无窗口 0x 视为占位」等判据，一律不动）。
 *    两条腿读的是**同一份上游文档** ⇒ **零新增请求**（这就是 issue 里
 *    「信息来自你获取模型的端点，不用担心时效性」那句的依据）。
 * 4. **窗口外不画「还没到点」**。参考实现的**卡片**可以画一枚降饱和胶囊并在悬停里写
 *    「几点生效」；宿主徽标契约**只有 text + tone、没有悬停位** ⇒ 窗口外把同一句
 *    「错峰 4 折」画出来就是在说一件没发生的事。所以那一家只画「此刻成立」，
 *    窗口外什么都没有（行上的原价后缀已经把「现在按原价」讲明白）。
 *    这是与参考实现**刻意不同**的一处，不是漏接。见 ModelPromotion.standingEligible。
 *
 * ## ⚠️ 时区兜底必须与**价格腿**同判据
 *
 * 上游没写 timezone 时，本仓价格腿（src/buddy.ts 的 zonedMinutes、
 * src/qoder-adapter.ts 的 promotionActiveNow）都按 **UTC+8** 算。徽标腿若默认 UTC，
 * 同一个窗口就会差 8 小时 —— 那是「一文件两套同义判据」的复发形态。
 * ⇒ 两个入口都**必须**传入与价格腿一致的 fallbackTimeZone，不许各猜一个。
 *
 * ## 与「用量徽标」的区别
 *
 * plugin-src/client/badge-model.js 与 usage-badge.js 是**本插件自己的**用量徽标
 * （挂在 conversation.input.right），与这里的「上游活动徽标」（数据面 = 宿主目录
 * badge 字段、渲染面 = 选择器每一行）不是同一条通路，别混为一谈。
 *
 * @module src/model-promotions
 */
/** 宿主徽标的语义档（DSH 0.2.2 起 LlmModelBadgeTone 的四个取值）。 */
export type ModelPromotionTone = 'neutral' | 'info' | 'success' | 'warning';
/** 上游自己声明的徽标外观与文案。 */
export interface ModelPromotionBadge {
    /**
     * 上游的**本地区**文案（CN 站「夜间折扣」，国际站「Free now」）。
     *
     * ⚠️ 必需字段：没有它就没有可画的东西，整条活动在解析阶段被丢弃（取舍 2）。
     */
    label: string;
    /** 上游的英文文案，**只在它真的下发时**才有。 */
    labelEn?: string;
    /**
     * 上游给的颜色（hex，实测 #009273 / #1E90FF / #FF0000）。
     *
     * ⚠️ 必须是**可选**的：腾讯 modelTiers 与 Qoder promotion 都**不下发**颜色
     * （实测 2026-10-21），缺省落 neutral。
     */
    color?: string;
    /**
     * 'activeOnly' —— 徽标属于活动的**进行期**，活动一结束就必须消失。
     *
     * 缺省 —— **常驻**徽标：描述这个模型「在该条活动存续期间」的性质，而活动自己的
     * 每日时段只管**折扣**、不管徽标。腾讯的「夜间折扣」就是成对下发的（一条带夜间
     * 时段、一条带白天时段，同一个徽标），靠的就是这条区别。
     */
    display?: 'activeOnly';
}
/** 一条每日时段，写在**上游自己声明**的时区里。 */
export interface ModelPromotionWindow {
    /** 'HH:mm'，**起点含**。实测小时可能不补零（7:50）。 */
    start: string;
    /**
     * 'HH:mm'，**终点不含**。
     *
     * end ≤ start 表示**跨零点**（23:00→7:50 是实测的夜间窗口）；end === start 表示**空区间**。
     */
    end: string;
    /**
     * 这条时段**只在列出的星期几**生效（ISO 序：1=周一 … 7=周日）。
     *
     * ⚠️ 缺席 = 每天（腾讯与 Qoder 都不下发该字段，实测如此）。TRAE 的
     * `activity_discount.data.off_peak.time_windows[]` 是**唯一**带星期维度的上游
     * （2026-11-17 真机：工作周 00:00–09:00 / 12:00–14:00 / 18:00–24:00 +
     * 周末 00:00–24:00 四条并列），且它用**当日分钟数**而非 HH:mm —— 那一层换算
     * 在 src/trae.ts 完成，本模块只认 HH:mm，**不为第二种上游形态再开一套判定**
     * （一文件两套同义判据是本仓的复发缺陷形态）。
     */
    weekdays?: readonly number[];
}
/** 活动什么时候跑。 */
export interface ModelPromotionSchedule {
    /** 上游声明的 IANA 时区（实测 Asia/Shanghai / Asia/Singapore）。 */
    timezone?: string;
    /** epoch 毫秒；活动在此之前**还没开始**。 */
    validFrom?: number;
    /**
     * epoch 毫秒；活动**到该时刻即结束**（**端点不含**）。
     *
     * ⚠️ 上游写的是「活动次日的零点」，自己的文案却说「– 10月31日」。拿原值当最后一天
     * 渲染会多说一天 ⇒ 展示侧要减 1 毫秒。
     */
    validUntil?: number;
    /** 每日时段（可多条）。**缺席** = 这条活动只要在有效期内就全天跑。 */
    daily?: readonly ModelPromotionWindow[];
    /**
     * 上游**下发了** daily，但每一条都读不懂。
     *
     * ⚠️ 这**不等于**「没有 daily」：没有 = 24 小时活动；读不懂 = 上游说了有时段而我们
     * 不知道是几点。把后者当成「全天」会把一个夜间活动画成全天徽标 —— 那是本模块唯一
     * 会**夸大上游声明**的方向。带此标记的条目**永不**算生效。
     */
    dailyUnusable?: true;
    /**
     * 上游在**取目录那一刻**给出的「常驻活动此刻开不开」快照（Qoder 的 promotion.active）。
     *
     * 只有「没给任何窗口」时才读它，见 promotionRunningAt 第 2 支。腾讯不发这种字段，故缺省。
     */
    snapshotActive?: boolean;
}
/** 上游的活动说明（腾讯 hover / Qoder description，都是双语）。 */
export interface ModelPromotionCopy {
    zh?: string;
    en?: string;
}
/** 一条已解析的上游活动（来自 modelPromotions / modelTiers / promotion）。 */
export interface ModelPromotion {
    /** 上游条目 id（缺失时用 source:modelIds / promotion:modelId 合成）。 */
    id: string;
    /** 来自上游哪张表。同分时**活动先于等级标记**，见 sortPromotions。 */
    source: 'promotion' | 'tier';
    /** 这条活动挂在哪些模型 id 上。 */
    modelIds: readonly string[];
    /** 徽标说什么、长什么样。 */
    badge: ModelPromotionBadge;
    /** 上游的解释文案（宿主徽标契约没有悬停位；保留数据，见取舍 4）。 */
    hover?: ModelPromotionCopy;
    /** 活动时间声明。**缺席** = 上游对时间什么都没说（腾讯 modelTiers）。 */
    schedule?: ModelPromotionSchedule;
    /**
     * 上游是否**声明了**时间（每日时段或有效期）。
     *
     * ⚠️ 必须显式带着走，**不能**由 schedule !== undefined 反推：Qoder 会下发
     * { active: false } 而没有任何窗口 —— 那是「常驻活动此刻没开」；而腾讯
     * modelTiers 的「没有 schedule」是「这条陈述无条件成立」。两者若合并，
     * promotionRunningAt 的第 2 支（退回快照）永远走不到。
     */
    timeDeclared: boolean;
    /**
     * 此刻不在窗口内时，能否画成**常驻**徽标。
     *
     * 腾讯 = true（白天那条「只带角标」的活动靠它让徽标全天挂着）；
     * Qoder = false（取舍 4：宿主没有悬停位，窗口外不许说「错峰 4 折」）。
     */
    standingEligible: boolean;
    /** 上游 ordering 权重：数字越大越重要。缺失按 0（最低）。 */
    priority: number;
}
/**
 * 宿主 LlmModelBadge.text 的形状（本地声明）。
 *
 * ⚠️ 表形态**必须显式写出 en**：宿主类型是
 * LocalizedText = string | { readonly en: string; readonly [locale: string]: string }，
 * 裸 Record<string, string> **不可赋值** —— 必需的 en 只存在于字面量类型里。
 * 把 en 写进类型不是绕编译错误，而是把「少了 en 会让胶囊整个消失」交给编译器检查。
 */
export type ModelPromotionBadgeText = string | ({
    en: string;
} & Record<string, string>);
/**
 * 一条已定徽标：宿主契约的两个字段。
 *
 * ⚠️ **刻意不 import LlmModelBadge / LlmModelBadgeTone**：本包 peer 下界是
 * ^0.1.2-rc.1，那里的 LlmModelInfo **没有** badge 字段（0.2.2 才加）。导入一个低界
 * 不存在的类型名会让下界编译不过 —— dsh-connect-workbuddy 的 adapter.ts 正因为
 * 这件事把结构就地声明。形状稳定：{ text, tone }。
 */
export interface ModelPromotionBadgeValue {
    text: ModelPromotionBadgeText;
    tone: ModelPromotionTone;
}
/**
 * 活动的**绝对有效期**在 nowMs 是否成立。
 *
 * 它单独就是一道闸：一条已经结束的活动不该继续自我宣传，无论它的每日时段怎么说。
 * 常驻徽标同样受它约束（见 promotionStandingAt）—— 这是「活动过期而徽标还在」
 * 最直接的成因，也是 issue #101 点名的形态。
 */
export declare function promotionWithinAbsoluteWindow(promotion: ModelPromotion, nowMs?: number): boolean;
/** 活动的**每日时段**（含上游声明的时区）在 nowMs 是否成立。 */
export declare function promotionWithinDailyWindow(promotion: ModelPromotion, nowMs?: number): boolean;
/** 绝对有效期 ∧ 每日时段。**不**含「上游是否声明了时间」这道闸。 */
export declare function promotionActiveAt(promotion: ModelPromotion, nowMs?: number): boolean;
/**
 * 这条活动在 nowMs **正在跑**吗（可画实心徽标）。三条分支缺一不可：
 *
 * 1. 上游**声明了**时间（窗口或有效期）⇒ 按 nowMs 现算，**不看** snapshotActive。
 *    目录是缓存的快照，active 会过期；而窗口是「此刻」的纯函数，快照多旧都不会说错话。
 *    若把 active 也当成门，白天启动的进程会拿着 16:00 的 active false 一直到退出 ——
 *    22:00 窗口开了也不画，这个功能对「一直开着 DSH」的用户等于不存在。
 * 2. 上游没声明时间、只给了 active 快照（Qoder 的 { active: true } 无窗口形态）
 *    ⇒ 只能信快照：那是上游对「常驻活动此刻开不开」的唯一表态。
 * 3. 上游既没声明时间也没有快照（腾讯 modelTiers）⇒ **不算在跑**，它只可能「常驻」。
 *    否则一个高优先级的等级标记会压掉一个真的在跑的低价活动
 *    （参考实现里的 hasSchedule 就是为此存在）。
 */
export declare function promotionRunningAt(promotion: ModelPromotion, nowMs?: number): boolean;
/**
 * 此刻不在窗口内时，这条活动能否画成**常驻**徽标。
 *
 * - badge.display 是 activeOnly ⇒ 不可以：那是「只在活动期内出现」的徽标；
 * - standingEligible false ⇒ 不可以：取舍 4（Qoder 没有悬停位可说「还没到点」）；
 * - dailyUnusable ⇒ 不可以：读不懂的时段不能替上游背书；
 * - 其余 ⇒ 只受**绝对有效期**约束：一条过期活动的常驻徽标同样不许挂。
 */
export declare function promotionStandingAt(promotion: ModelPromotion, nowMs?: number): boolean;
/**
 * priority 降序；同分时**活动先于等级标记**。
 *
 * 上游把两者都标成 200（实测 2026-10-21），而一句「Free now / 限时免费」比一句
 * 「Pro Only / 订阅优先」对用户更有行动价值。同分不能靠数组顺序碰运气 ——
 * 比较器显式覆盖它，调用方因此不必依赖 Array#sort 的稳定性。
 */
export declare function sortPromotions(promotions: readonly ModelPromotion[]): ModelPromotion[];
/**
 * 此刻该画的那一条活动，或 undefined（不画）。
 *
 * 两步顺序就是全部要点：
 * 1. **正在跑的**赢（promotionRunningAt）；
 * 2. 否则取**常驻**徽标（promotionStandingAt）。
 *
 * 每个模型**只画一枚**：选择器一行只有一条宽度，两枚会把模型名挤出去。
 *
 * ⚠️ 调用方**不得**在解析时刻调它并把结果存进缓存 —— 那等于把「此刻」冻进目录，
 * 正是本模块存在的理由要修的事（取舍 1）。
 */
export declare function selectPromotionAt(promotions: readonly ModelPromotion[] | undefined, nowMs?: number): ModelPromotion | undefined;
/**
 * 只接受 hex（#RGB / #RRGGBB）。
 *
 * ⚠️ 值最终会进样式，而上游只发 hex。其它写法一律拒绝，由展示侧回落语义色。
 * **不要**在这里放行 rgb() 或 CSS 变量 —— 那不是上游会发的东西，放行等于把
 * 未校验字符串送进样式属性。
 */
export declare function promotionBadgeColor(promotion: ModelPromotion): string | undefined;
/**
 * 上游 hex 颜色 → 宿主语义档。
 *
 * ## 为什么映射而不是原样送颜色
 *
 * 宿主的 badge 只认 tone（四档），由主题 token 上色，从而在每个主题下都保证可读；
 * 任意 hex 做不到这件事。所以就近映射：绿色（CN 每个「免费/折扣」活动用的都是它）
 * → success；蓝 → info；暖色（琥珀/红）→ warning；**其余 neutral，不替上游发明含义**。
 *
 * 上游没给颜色（Qoder promotion、腾讯 modelTiers）同样落 neutral —— 实测如此，不是兜底。
 */
export declare function promotionTone(promotion: ModelPromotion): ModelPromotionTone;
/**
 * 候选表 → 宿主 badge 值（此刻该画的那一枚），不成立时 undefined。
 *
 * ## 为什么出「表」形态
 *
 * 宿主按**读者**的语言解析 badge.text，而本函数跑在宿主进程里，看不到浏览器语言。
 * 给一张表让宿主自己挑；给一个裸字符串就是把一种语言强加给所有用户。
 *
 * ## 什么时候塌成裸字符串
 *
 * CN 大多数活动**只发中文**，于是 en 就是那句中文，两端相同 ⇒ 塌成字符串。
 * 这是刻意的：**编造英文文案比给英文读者看上游自己的中文更糟**（取舍 2）。
 */
export declare function promotionBadgeFor(promotions: readonly ModelPromotion[] | undefined, nowMs?: number): ModelPromotionBadgeValue | undefined;
/**
 * 腾讯系 /v3/config：data.modelPromotions + data.modelTiers → 候选表。
 *
 * 真实形态（docs/PROMO_BADGE.md 留档；2026-10-21 实测 CN 站 8 条促销 + 1 条等级标记），
 * 一条促销条目原文（截断）：
 *
 *     { "id": "hy3-free-trial-202608", "kind": "discount", "enabled": true,
 *       "priority": 200, "modelIds": ["hy3"],
 *       "badge": { "label": "限时免费", "color": "#009273", "display": "activeOnly" },
 *       "discount": { "discountedCredits": "0x", "displayMode": "replace", "factor": 0 },
 *       "hover": { "textZh": "7月6日–10月31日，每日赠送免费额度。" },
 *       "schedule": { "timezone": "Asia/Shanghai",
 *                     "validFrom": "2026-07-06T00:00:00+08:00",
 *                     "validUntil": "2026-11-01T00:00:00+08:00",
 *                     "daily": [{ "start": "23:00", "end": "7:50" }] } }
 *
 * modelTiers 同形但**没有** schedule / badge.color，多一个 requiredUserType。
 *
 * 三条丢弃判据（都在解析层做完，下游可假定每条都画得出来）：
 * - enabled === false（**缺省即启用**：上游只在关掉时才写这个字段）；
 * - 无 modelIds —— 数组里混着图片/视频模型的**非促销**条目；
 * - 无 badge 文案 —— 没有可显示的话，插件不该自己编。
 *
 * ⚠️ **折扣价不在这里算**（取舍 3）：腾讯的促销价继续走 src/buddy.ts 的 parsePromotions。
 * 同一份文档读两套判据，**请求仍只有一次**。
 *
 * ⚠️ fallbackTimeZone 必须与价格腿一致（见模块头）：腾讯价格腿用 Asia/Shanghai。
 *
 * @param rawPromotions - 上游 data.modelPromotions。
 * @param rawTiers - 上游 data.modelTiers。
 * @param fallbackTimeZone - 上游未写 timezone 时用的时区（与价格腿同值）。
 * @param warn - 可选日志出口（时段读不懂时点名到条目）。
 */
export declare function parseTencentPromotions(rawPromotions: unknown, rawTiers: unknown, fallbackTimeZone?: string, warn?: (message: string) => void): ModelPromotion[];
/**
 * 本仓 Qoder 目录条目的 promotion（错峰折扣）→ **一条**候选（只挂它自己那一行）。
 *
 * ⚠️ 输入是 src/qoder-product.ts 的**已解析**形状（camelCase），不是上游的 snake_case：
 * 本仓 qoder-catalog.ts 已把远端条目归一成与编译期兜底表同形的结构，远端与兜底表
 * 因此**走完全同一条展示链路**。若在这里再写一份 snake_case 解析，就是同一个 schema
 * 的两套判据 —— 本仓的反复出缺陷形态。
 *
 * 三个必须处理的形态，与参考实现 dsh-connect-qoder/promo.ts 逐条同口径：
 * 1. **窗口读得懂** ⇒ timeDeclared true + daily，窗口说了算（active 完全不参与）；
 * 2. **窗口声明了但读不懂**（24:30、只给一端、非 HH:mm）⇒ dailyUnusable ⇒ 既不当全天
 *    也不退回 active（running 与 standing 两道闸都拒）；
 * 3. **完全没给窗口** ⇒ timeDeclared false + snapshotActive，由 promotionRunningAt
 *    第 2 支读快照。
 *
 * ⚠️ badge.zh 与 badge.en 都没有 ⇒ 返回 undefined：没有可显示的话就不该画（取舍 2）。
 * 此时**折扣价照旧**由 qoderDisplayName 的箭头承载，两条腿互不依赖。
 *
 * ⚠️ fallbackTimeZone 必须与价格腿一致：qoder-adapter.ts 的 promotionActiveNow 按
 * UTC+8 硬算（目录时区与用户一致），故这里传 Asia/Shanghai。
 */
export declare function qoderPromotionCandidate(promotion: {
    readonly active: boolean;
    readonly windowStart?: string | undefined;
    readonly windowEnd?: string | undefined;
    readonly badgeZh?: string | undefined;
    readonly badgeEn?: string | undefined;
    readonly descriptionZh?: string | undefined;
    readonly descriptionEn?: string | undefined;
    readonly timezone?: string | undefined;
    readonly ruleId?: string | undefined;
} | undefined, modelId: string, fallbackTimeZone?: string, warn?: (message: string) => void): ModelPromotion | undefined;
/**
 * TRAE `activity_discount.data.off_peak` 的**已解析**形状（由 src/trae.ts 产出）。
 *
 * ⚠️ 这里吃的不是上游的 snake_case 原文：与 Qoder 同一纪律 —— 本仓适配器已把
 * 条目归一成 camelCase，若在这里再写一份原文解析，就是同一个 schema 两套判据。
 */
export interface TraeOffPeakInput {
    /** 折前倍率（`before_consumption_rate`）。 */
    readonly beforeRate?: number | undefined;
    /** 折后倍率（`after_consumption_rate`）。 */
    readonly rate?: number | undefined;
    /** 上游 `discount` = **支付比例**百分数（实测 50 = 半价、100 = 原价）。 */
    readonly discountPercent?: number | undefined;
    /**
     * 上游 `time_zone`。
     *
     * ⚠️ **2026-11-17 真机：32 条带 off_peak 的行里只有 6 条下发该字段** ——
     * 兜底时区因此是主路径而不是边角，必须与价格腿同值（Asia/Shanghai）。
     */
    readonly timeZone?: string | undefined;
    /** 当日分钟数窗口（0–1440，**起点含、终点不含**）。 */
    readonly windows?: readonly TraeOffPeakWindowInput[] | undefined;
    /**
     * 上游**是否声明过** `time_windows`（哪怕一条都读不出）。
     *
     * 只由 `readTraeOffPeakDiscount` 填。缺这一位时「没声明时段」与「声明了却读不懂」
     * 在展示层同形（都是 `windows: []`）⇒ 后者会被静默画成 24/7 常亮。
     */
    readonly windowsDeclared?: boolean | undefined;
    /** 上游机器名（`off_peak_discount` / `off_peak_member_discount_18_9`），进候选 id，供日志点名。 */
    readonly subKey?: string | undefined;
}
/** TRAE 的一个闲时窗口：当日分钟数 + 生效的星期（ISO 序 1=周一 … 7=周日）。 */
export interface TraeOffPeakWindowInput {
    readonly weekdays?: readonly number[] | undefined;
    readonly startMinute?: number | undefined;
    readonly endMinute?: number | undefined;
}
/**
 * 本仓 TRAE 目录条目的闲时折扣 → **一条**候选（只挂它自己那一行）。
 *
 * ## 为什么只有 off_peak 这一支
 *
 * 真机（2026-11-17）51 条带 `activity_discount` 的行里，`current.discount_type`
 * 只有 `subsidy`(13) 与 `none`(38) 两种取值；`subsidy` 那批**已经**由既有的
 * 价格腿在模型名上画出箭头（`Seed-Code · x0.12→x0.06`），再补一枚徽标是用两种
 * 控件讲同一句话。而 32 条 `off_peak` 的行 `current` 恒为 `none` 且
 * `before === rate` ⇒ **两条腿都不亮**（既无箭头也无徽标），而闲时价是真的 ——
 * 这才是缺口。因此本函数**只**为闲时窗口产出候选。
 *
 * ## 判据
 *
 * 1. 必须**真降价**：`before > 0` 且 `rate < before`（有限数）。上游对未生效的
 *    `limited_discount` 就是发 `before === rate`，照画等于说谎；
 * 2. 窗口换算不过的**丢弃**；上游**声明过** `time_windows` 却一条都没留下
 *    （非数组 / 元素读不出 `start_minute` / 星期读不懂 / 空区间）⇒ `dailyUnusable`
 *    （= 永不成立）并留一条日志 —— 与腾讯 / Qoder 同向。注意「声明过」看的是
 *    `windowsDeclared` / 原始条数，**不是**留下的条数：两者混为一谈会让
 *    「声明了却读不懂」静默退化成「全天」（PR #106 正向审计 P1-1）；
 * 3. `standingEligible: false`：窗口外**什么都不画**（取舍 4，宿主徽标无悬停位）；
 * 4. `timeDeclared: true`：闲时窗口就是时间声明，判定永远走「此刻」这条路，
 *    绝不读任何快照布尔。
 *
 * ⚠️ 上游 `end_minute: 1440` 是「到当日结束」，**不是**次日 00:00 的另一天：
 * 换算成 '24:00' 交给 `clockMinute` 的终点分支，与 #104 统一过的那条同判据。
 */
export declare function traePromotionCandidate(offPeak: TraeOffPeakInput | undefined, modelId: string, fallbackTimeZone?: string, warn?: (message: string) => void): ModelPromotion | undefined;
/**
 * ## 为什么判据全抄客户端 asar 而不是自己推
 *
 * 上游对这条活动的**语义**只体现在客户端怎么画：`limitedFree`（声明）与
 * `limitedFreeActive`（此刻）分开用、`costMultiplier` 在生效时被**强制成 0**、
 * 红 chip 的文案来自 i18n。这三件事各自都能从「上游字段名」误推成另一个样子
 * （例如把 `limitedFree` 当徽标开关 ⇒ 活动还没开始就先挂一年）。
 */
/**
 * LobsterAI 模型上的限免四件套（`GET /api/models/available`）。
 *
 * ⚠️ **两个布尔不是同义词，别合并**（官方客户端 @32509033 / @32483752）：
 * - `limitedFree` = 上游**声明了**这条限免活动（不论此刻开不开），客户端拿它算
 *   「下一次刷新时刻」（`Date.parse(startAt/endAt)` 取最近边界 + `setTimeout`）；
 * - `limitedFreeActive` = **取目录那一刻**上游说「此刻限免中」，客户端拿它画红 chip。
 *
 * 两者可能同时为真（常驻活动），也可能只有前者的窗口而后者此刻为假。
 */
export interface LobsteraiLimitedFreeInput {
    /** 上游 `limitedFree` 原值。 */
    limitedFree?: boolean;
    /** 上游 `limitedFreeActive` 原值（快照）。 */
    limitedFreeActive?: boolean;
    /** `limitedFreeStartAt` 解析后的 epoch 毫秒；缺失 = 上游没给（或 null）。 */
    validFrom?: number;
    /** `limitedFreeEndAt` 解析后的 epoch 毫秒；缺失 = 上游没给（或 null）。 */
    validUntil?: number;
    /**
     * 上游**给了**起止，但至少一个读不懂（见 `LobsteraiRemoteModel` 同名字段的说明）。
     *
     * ⚠️ 它与「没给起止」是两件事：前者必须 fail-closed（永不成立），后者才落回快照。
     * 合并会让「只解析到起点」变成一条**无上界**的窗口。
     */
    windowUnreadable?: true;
}
/**
 * LobsterAI 限免 → 一条活动候选（画红 chip「限时免费」）。
 *
 * ## 判据逐字来自官方客户端 asar
 *
 * - 文案：i18n `modelLimitedFreeBadge` = **「限时免费」/「Limited-time free」**
 *   （@48491027 中文表、@48724162 英文表）—— 不是我们编的措辞。
 * - 何时画：客户端条件是 `!model.presetId && model.limitedFreeActive`（@32509033）。
 *   本仓**只采纳后半个条件**：载荷里从未观测到 `presetId` 字段（`LobsteraiRemoteModel`
 *   也没有它），凭空加一条「`presetId` 非空就不画」的闸门等于**替上游发明判据**
 *   （本仓红线）⇒ 如实登记为**未采纳**，而非假装实现了。若将来在真实载荷里看到
 *   该字段，闸门应加在 {@link lobsteraiLimitedFreeCandidate} 的入口。
 *   另一层理由：本仓只在**此刻生效**时画，故 `display: 'activeOnly'` +
 *   `standingEligible: false`（与 Qoder 那条同一取舍：宿主徽标没有悬停位，
 *   窗口外不许说「限时免费」）。
 * - 起点/终点是**字符串**：客户端对它直接 `Date.parse(value22)`（@32483752）。
 *   本仓在**解析层**（`lobsterai-adapter.ts`）就折成 epoch 毫秒，此处只收数字 ——
 *   这里再 `Date.parse` 一次就是「一文件两套同义判据」的复发形态。
 * - 颜色：上游**不下发**颜色（目录里没有任何颜色字段）⇒ 按本模块契约
 *   **不替上游发明颜色**，落 neutral。客户端画的是红（`text-red-600`），但那是
 *   Tailwind 类、不是上游声明，写死一个 hex 就成了编造数据。
 *
 * ## 窗口 vs 快照的取舍
 *
 * 与 `promotionRunningAt` 的两支完全一致：**声明了起止 ⇒ 按窗口现算**（目录是
 * 缓存快照，active 会过期；窗口是此刻的纯函数）；**只有 active 快照 ⇒ 只能信快照**。
 * 因此 `timeDeclared` 必须按「起止是否真的解析到了数字」定，**不按键是否存在**：
 * 实测 21/21 条目的两个键都在、值全是 `null`，按键判会把「上游没办活动」判成
 * 「活动全天在跑」（PR #104 正向审计 P1-1 的同一个坑）。
 *
 * @returns undefined = 上游没说这条有限免（不制造空候选）。
 */
export declare function lobsteraiLimitedFreeCandidate(limitedFree: LobsteraiLimitedFreeInput | undefined, modelId: string, warn?: (message: string) => void): ModelPromotion | undefined;
/**
 * Raccoon `billing_discounts[]` 的一条，**已归一成 camelCase**。
 *
 * ⚠️ 这里收的不是上游原文（`start_at` / `daily_start` 那套），归一在
 * `src/raccoon-auth.ts` 的 `normalizeRemoteModel` 里做完 —— 与 Qoder / TRAE 同一纪律：
 * 本仓适配器已归一，若在本模块再写一份原文解析就是「同一个 schema 两套判据」。
 */
export interface RaccoonDiscountInput {
    /** 上游 `name`（如「限时折扣至11月22日」）。客户端**只用它当非空校验**，不上屏。 */
    readonly name?: string | undefined;
    /**
     * 上游 `multiplier`。
     *
     * ⚠️⚠️ **这是折扣比，不是折后价**：Qwen4-Max 实测 `billing_multiplier 0.75` +
     * `multiplier 0.67` ⇒ 折后 `0.5`（0.75 × 0.67 ≈ 0.5）。折后价**只认**
     * `billing_effective_multiplier`，拿本字段当折后价会画成「0.67 倍」。
     */
    readonly multiplier?: number | undefined;
    /** 上游 `active` —— 取目录那一刻这条活动开不开（快照，会过期）。 */
    readonly active?: boolean | undefined;
    /** 上游 `start_at`（ISO-8601，实测带 `Z`）。 */
    readonly startAt?: string | undefined;
    /** 上游 `end_at`（同上）。 */
    readonly endAt?: string | undefined;
    /**
     * `start_at` / `end_at` 键**存在但读不成字符串**（`null` / 数字时间戳 / 对象）。
     *
     * ⚠️⚠️ 「没声明」与「声明了但读不出」是两件事，揉成一件会让单边窗口逃过 fail-closed：
     * 实测 `end_at: null` / `1795363199000` / `{}` 会被折成「没声明」⇒ 只剩 `validFrom`
     * ⇒ 活动**永不结束**（2031 年仍画、零 warn）。有了这个标记，下游按「读不懂 ⇒ 不画」
     * 处理（2026-11-18 对抗审计 P1-②）。
     */
    readonly startAtUnreadable?: true | undefined;
    /** 见 {@link startAtUnreadable}。 */
    readonly endAtUnreadable?: true | undefined;
    /** 上游 `daily_start`（'HH:mm'）。 */
    readonly dailyStart?: string | undefined;
    /** 上游 `daily_end`（'HH:mm'）。 */
    readonly dailyEnd?: string | undefined;
}
/** Raccoon 目录行里与本模块有关的那族字段（`billing_*`）。 */
export interface RaccoonPromotionInput {
    /** 上游 `billing_status`：**唯一**决定画不画 chip 的字段。 */
    readonly status?: 'normal' | 'discount' | 'limited_free' | undefined;
    /**
     * 上游 `billing_status` **有值但不在白名单**（如上游加了第四种状态）。
     *
     * ⚠️ `normalizeRemoteModel` 会把未知状态**收成 `normal`**（`raccoon.ts` 的
     * `RaccoonModelMeta['status']` 只有三态），对展示名无害；但对 chip 就是
     * 「上游说在打折、我们画不出来、**全仓零日志**」—— 与 qoder 那次「黑名单 ⊃ 收缩目录」
     * 同形。故把原文留在这里，由构造函数播一条**诊断**（chip 仍不画：读不懂的东西不画）。
     */
    readonly statusUnknown?: string | undefined;
    /** 上游 `billing_multiplier`（原价倍率）。 */
    readonly baseMultiplier?: number | undefined;
    /** 上游 `billing_effective_multiplier`（**当前生效**倍率，折扣价只认它）。 */
    readonly effectiveMultiplier?: number | undefined;
    /** 上游 `billing_status_note`（整句说明，如「限免到11月30日」）。 */
    readonly statusNote?: string | undefined;
    /** 上游 `billing_discounts`（**空数组 = 没有活动**，不是「读不懂」）。 */
    readonly discounts?: readonly RaccoonDiscountInput[] | undefined;
    /**
     * `billing_discounts` 键**存在但读不懂**（不是数组）。
     *
     * ⚠️ 与「空数组」必须分开（同 `daily: []` 那条判据）：空数组是「上游没办活动」，
     * 类型漂移是「上游说了什么而我们读不出来」。
     */
    readonly discountsUnreadable?: true | undefined;
}
/**
 * Raccoon 计费状态 → 一条活动候选（画「限免中」/「限时折扣」）。
 *
 * ## 判据逐字来自官方客户端（三处，全部实读 asar）
 *
 * 1. **行内 chip**（`aM({model})`）：
 *    - `billing_status === 'limited_free'` ⇒ 只画 `modelBilling.freeOffer`（「限免中」/
 *      「Free for now」），**不画倍率**；
 *    - `billing_status === 'discount'` ⇒ 画 `modelBilling.limitedDiscount`（「限时折扣」）
 *      ，`title` 挂 `billing_status_note`，右侧再画 `rate(effective ?? base ?? points)`；
 *    - 其余（`normal`）⇒ **不画 chip**（只有倍率）。
 * 2. **悬停/明细**（`az({model})`，`desktop-model-billing-details`）：
 *    - 摘要行 `consumption`：限免 ⇒ `originalLimitedFree`（「原 0.75 倍，当前限免」，无原价则
 *      「当前限免」）；折扣 ⇒ `originalPrefix` +（有 effective ⇒ `currentRate`；
 *      没有 ⇒ **退回上游 `billing_status_note`**，再没有才是「限时折扣」）；
 *    - 再逐条 discount：`dailyStart && dailyEnd` ⇒ `daily`（「每日 09:00–22:00」）**优先**；
 *      否则 `active === true && endAt` ⇒ `until`（「活动至 11月22日」）；否则不画。
 * 3. **i18n 原文**（chunk `67406` 的 `zh` / `en` 两张表）：
 *    `freeOffer: 限免中 / Free for now`、`limitedDiscount: 限时折扣 / Limited-time discount`、
 *    `originalLimitedFree: 原 {{original}} 倍，当前限免 / Was {{original}}×, now free for a limited time`、
 *    `originalPrefix: 原 {{original}} 倍，/ Was {{original}}×, `、
 *    `currentRate: 当前 {{effective}} 倍 / now {{effective}}×`。
 *
 * ## 与「不替上游说话」的关系
 *
 * 文案**不是我们编的**：chip 两句与悬停两句都逐字取自官方 i18n 表，数字来自上游字段，
 * `{{original}}`/`{{effective}}` 的填充只是把上游自己的倍率塞进上游自己的句子。
 *
 * ## 时间：什么时候必须消失
 *
 * - `billing_discounts[]` 的 `start_at`/`end_at` 可读 ⇒ 落**绝对窗口**，
 *   `promotionWithinAbsoluteWindow` 到点即不画（issue #101 的核心：活动过期不许再挂）；
 * - 声明了却读不懂 ⇒ `dailyUnusable`（**fail-closed**，与腾讯那条同方向）：宁可少画
 *   一枚，也不能让一条结束不了的活动永久自我宣传；
 * - **没声明**窗口 ⇒ 退回 `billing_status` 这张快照（`snapshotActive: true`）。
 *   ⚠️ 这里与 `dailyUnusable` 的纪律**刻意分叉**：`billing_status` 是上游自己给的
 *   「此刻在打折」表态，chip 不依赖 discounts 才成立；`billing_discounts` 读不懂只损失
 *   「哪一天结束」，不足以让一枚上游明确说在打折的 chip 消失（那是**少报**真信息）。
 *   而 `start_at` 读了是「知道了结束时刻却算不出来」，方向相反。
 *
 * ## 刻意不做的两件事
 *
 * - **不给颜色**：上游这件 payload 里没有任何颜色字段（`billing_discounts[]` 只有
 *   name / multiplier / active / 日期），客户端画的是 Tailwind 类不是上游声明 ⇒
 *   `tone` 落 neutral（与 lobsterai 同一取舍，不替上游发明 hex）。
 * - **不读 `points_multiplier`**：本地实测 10/10 个模型**全部缺失**该键，
 *   读它是一条死分支（`assert` 形状里没有这个字段）。
 *
 * @returns undefined = 这条没有可画的活动（`normal` / 输入缺失 / 不是活动态）。
 */
export declare function raccoonPromotionCandidate(input: RaccoonPromotionInput | undefined, modelId: string, fallbackTimeZone?: string, warn?: (message: string) => void): ModelPromotion | undefined;
/**
 * 候选表里**下一个**会改变徽标的时刻（epoch 毫秒）；找不到返回 undefined。
 *
 * ## 为什么需要它
 *
 * 徽标是「此刻」的函数，而宿主缓存的是**一次目录读取**的结果（本仓后台刷新器
 * 20 分钟一轮）。于是 23:00 开的窗口要靠用户恰好在那一分钟打开菜单才会出现，
 * 而 7:50 关的窗口会在那之后最长 20 分钟里继续挂着 —— 后者正是 issue #101
 * 点名的「活动过期而用户仍按优惠期选择」。
 *
 * ⇒ 边界到了必须**主动播报**一次目录变更，让客户端重读。本函数是它的排程依据。
 *
 * ⚠️ **播报不等于重打上游**：重读走 loadCatalog，而 ensureRemoteModels 的
 * 20 分钟新鲜度判据会短路 ⇒ 边界时刻只是**用新时钟重算一遍候选表**，
 * 零网络请求。这条是「徽标自己会消失」能常驻开启的前提。
 *
 * 会改变徽标的时刻有四类：validFrom、validUntil，以及每条 daily 的两端
 * （后者按**每日重复**取「下一次」）。
 *
 * ⚠️ 全部按上游声明的时区算，而不是本地时区：23:00 说的是 Asia/Shanghai 的
 * 23:00，用户人在 UTC+0 时也一样。
 *
 * @param promotions - 全部候选（**不要**先筛过：读不懂的条目本来就没有边界）。
 * @param nowMs - 起算时刻。
 * @returns 严格大于 nowMs 的最近边界；一年内没有则 undefined。
 */
export declare function nextPromotionEdgeMs(promotions: readonly ModelPromotion[], nowMs?: number): number | undefined;
//# sourceMappingURL=model-promotions.d.ts.map