/**
 * 聚合 provider 的**共享底座**：哨兵常量、候选排序、倍率解析。
 *
 * ## 为什么要抽出来（而不是在 auto 与新 provider 各写一份）
 *
 * 本仓库对「同一语义两套实现」有明确的红线记录（AGENTS.md 首条判据：
 * `buddy-growth.ts` 因两处对同一字段给出相反判据，产生**静默失效**——测试全绿、
 * 只在畸形响应上分叉）。跨渠道选型逻辑若写两份，必然漂移，症状是「同一个档位
 * 在两处算出不同结果」。
 *
 * ⇒ 本文件是选型口径的**唯一权威**；`auto-adapter.ts` 与
 * `aggregate-adapter.ts` 都只是它的调用方。
 *
 * ## 哨兵语义（三者严格互斥）
 *
 * | 值 | 含义 | 排序行为 |
 * |---|---|---|
 * | `NEVER` | 可用，但**无临期额度**（永久/长期积分） | **参与排序且可当选**（排最后） |
 * | `UNUSABLE` | 本次不可用（无启用账号 / 探测失败） | **剔除** |
 * | abort | 这次调用不该继续 | **立刻抛 AbortError**，绝不折算成 `UNUSABLE` |
 *
 * ⚠️ 真实缺陷（PR !69 审计实测）：初版拿 `bestExpiry` 的初值 `Infinity` 当
 * 「还没选中任何 provider」的哨兵，于是**全部条目都是 `NEVER` 时循环一次都不
 * 赋值** ⇒ 返回 `undefined` ⇒ 用户看到「没有任何已登录且可用的 provider 账号，
 * 请先登录」——而账号全都正常，只是积分都是永久的。这是「账号都在」被误报成
 * 「没登录」。⇒ 两种语义必须用**独立变量**分开。
 *
 * @module src/aggregate-core.ts
 */
/** 无到期概念（只有永久/长期积分）时的失效时刻。 */
export const NEVER = Number.POSITIVE_INFINITY;
/** 该 provider 本次不可用（无启用账号 / 探测失败）的哨兵值。 */
export const UNUSABLE = -1;
/** 见 {@link CandidateGate} 的判定表与优先级说明。 */
export function resolveCandidateGate(input) {
    if (input.rejected)
        return 'rejected';
    if (input.allowed)
        return 'allowed';
    return input.expiryWired ? 'allowed' : 'default-rejected';
}
/**
 * 从「provider → 最早失效时刻」里挑出胜者（**纯函数**）。
 *
 * 规则：剔除 `UNUSABLE`；其余按失效时刻**升序**（越早越先烧）；时刻相同按传入
 * 顺序（即候选表的声明顺序）。
 *
 * ⚠️ `NEVER` 必须参与排序并能当选：它表示「可用、只是没有临期可烧」，而不是
 * 「不可用」（见模块头的真实缺陷）。
 *
 * @returns 胜出的 provider；**全部 `UNUSABLE`** 时才返回 `undefined`。
 */
export function pickSoonestProvider(entries) {
    let best;
    let bestExpiry = NEVER;
    for (const [provider, expiry] of entries) {
        if (expiry === UNUSABLE)
            continue;
        // 严格小于：并列时保留先出现的，不重排。
        if (best === undefined || expiry < bestExpiry) {
            bestExpiry = expiry;
            best = provider;
        }
    }
    return best;
}
/**
 * 从目录展示名解析倍率；带「免费」按 0；解析不出按 `Infinity`（排在任何有标注的之后）。
 *
 * ⚠️ **必须要求倍率前有分隔符**（真实缺陷，PR !69 审计实测）：初版正则
 * `/[×x]\s*(\d+(?:\.\d+)?)\s*$/i` 只要求「`x` + 数字 + 行尾」，不要求分隔符
 * ⇒ 模型名里的 `x` 被当成倍率。实测：
 *
 * | 展示名 | 初版解析 | 应为 |
 * |---|---|---|
 * | `Spark X2.5`（**无**倍率标注） | **2.5 倍** ❌ | `Infinity` |
 * | `GPT-X5` | **5 倍** ❌ | `Infinity` |
 * | `Grok x4` | **4 倍** ❌ | `Infinity` |
 * | `DeepSeek V4 Flash 0731 · x3.0` | 3.0 ✅ | 3.0 |
 *
 * `Spark X2.5` 这条路径**真实可达**：loomy 的 `splitLoomyRate` 在远端下发**不带
 * 倍率**的名称时原样返回原名（`loomy.ts`），而 `loomyDisplayName` 不追加
 * 分隔符，该原名会被 `loomy-adapter.ts` 直接写进目录名 ⇒ 就会把它当 2.5 倍，
 * 于是「挑最便宜」反而**挑到了最贵的**（同池里 `· x0.8` 的模型排到了它后面）。
 *
 * ✅ 修法：要求倍率前有分隔符（`·` / `×` / `·x`），并按真实形态支持促销箭头
 * `x0.17→x0.50` —— 取**促销后的**那个值，那才是实际计费倍率。
 *
 * ⚠️ 只做展示层解析：各 provider 的倍率权威来源不同（qoder 在目录 `priceFactor`、
 * buddy 在远端 config 拼进名字），逐家接字段是个大工程，而目录名是所有 provider
 * 统一展示的地方 —— 先用这一层。
 */
export function priceFactorFromName(name) {
    if (name.includes('免费'))
        return 0;
    // ⚠️ 倍率标注的**真实形态**只有两种（`formatCreditsRate`，buddy.ts；
    // `loomyDisplayName`，loomy.ts）：`… · x{n}` 与 `… ×{n}` —— 分隔符是
    // **间隔号 U+00B7** 或乘号。促销期为 `· x0.17→x0.50`，取箭头右侧（实际计费倍率）。
    const m = /·\s*[×x]?\s*(\d+(?:\.\d+)?)(?:\s*[→>]\s*[×x]?\s*(\d+(?:\.\d+)?))?\s*$/i
        .exec(name.trim());
    if (m === null)
        return Number.POSITIVE_INFINITY;
    const raw = m[2] ?? m[1];
    const value = Number(raw);
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}
/**
 * 候选排序：**手工位次严格优先 → 临期升序 → 同档倍率升序 → 声明顺序兜底**。
 *
 * - 第一判据「手工位次」（仅当传入 `manualRankOf`）：「按手工排序」模式下用户拖出来的顺序，
 *   排过的一律排在**全部**没排过的之前；
 * - 第二判据「临期升序」：越早作废的先用掉（本功能的全部价值）；
 * - 第三判据「倍率升序」：同一临期档内挑便宜的（省钱）；
 * - 第四判据「声明顺序」：完全并列时保持候选表顺序（`Array.prototype.sort` 在
 *   ES2019 起是**稳定**的，故无需显式兜底字段）。
 *
 * ⚠️⚠️ **手工位次是「严格序 + 临期兜底」，不是「临期为主、手工为辅」**（用户 2026-10-15 的取舍）：
 *    已排过的候选按位次排在**全部**未排过的候选之前，即使它临期更晚。理由：用户拖动时表达的是
 *    「我要这个渠道先被用」；若临期仍优先，拖动会被临期值**静默覆盖** ⇒ 面板显示的顺序与真实
 *    轮换顺序分叉（本仓库红线之一）。
 *
 * ⚠️ `manualRankOf` 返回 `undefined` = 该候选没被手工排过。两者都未排过时**必须**落到
 *    临期兜底分支 —— 那里用 `a.expiry !== b.expiry` 先判不等，**顺带避开**
 *    `Infinity - Infinity === NaN`（两个 `NEVER` 候选相减会得到 `NaN`，而 `NaN` 不是合法的
 *    比较器返回值：`sort` 会把它当 `0`，顺序随引擎实现漂移）。
 *    ⇒ 别把两个分支合成 `(a.expiry - b.expiry) || (a.price - b.price)`。
 *
 * ⚠️ **纯函数**：不改传入数组（先 `slice()`）。适配器会对同一份候选表反复排序
 * （每次请求），原地排序会让顺序随调用次数漂移。
 */
export function rankCandidates(candidates, manualRankOf) {
    return candidates
        .filter((candidate) => candidate.expiry !== UNUSABLE)
        .slice()
        .sort((a, b) => {
        if (manualRankOf !== undefined) {
            const rankA = manualRankOf(a) ?? Number.POSITIVE_INFINITY;
            const rankB = manualRankOf(b) ?? Number.POSITIVE_INFINITY;
            if (rankA !== rankB)
                return rankA - rankB;
        }
        return a.expiry !== b.expiry ? a.expiry - b.expiry : a.price - b.price;
    });
}
/**
 * `auto` 每个渠道在第一轮里最多占的名额（见 {@link pickDiversified}）。
 *
 * ⚠️ **这是经验封面，不是实测最优**：没有生产数据能证明「2」比「1」或「3」更好。
 * 取 2 而不是 1 的理由是「同一渠道的第二个模型偶尔能过（按模型记账的额度、单模型
 * 降级）」，留一个备位；再多就会重现「名额被一家占满」。
 * ⚠️ 它只是**上界**：真正生效的配额还会被 `limit` 再夹一次（见 `pickDiversified`
 * 里的 `quota`），所以「每家最多 2 个」不成立时以那边为准。
 */
export const AUTO_PER_PROVIDER_FIRST_PASS = 2;
/**
 * 从已排序的候选里取前 `limit` 个，**第一轮每个渠道最多取 `min(perProvider, limit - 1)` 个**
 * （配额还会按 `limit` 收紧，见下），名额有剩再按原序补齐。
 *
 * ## 为什么需要（真实故障，2026-11-14 NAS 生产日志）
 *
 * `aggregate/auto` 的池是所有渠道的所有模型，排序后只取前 `limit` 个尝试。未接入临期
 * 折算的渠道（qoder）一律 `NEVER`、免费模型倍率最低 ⇒ **前 9 名全是 qoder**。qoder 的
 * 账号整体排队（`10605`，9 个模型同一账号、同一 `retryAfterSeconds`）时，9 次切换全在
 * qoder 内部打转，名额用完直接报错 —— 其它能用的渠道一个都没轮到：
 * ```
 * [aggregate] qoder（qfmodel）失败，切换下一个候选 … code=QUEUE
 * [aggregate] qoder（gfmodel）失败，切换下一个候选 … code=QUEUE
 * …（共 9 个，全是 qoder）… 最后一个 dmodel 失败后整轮报错
 * ```
 *
 * ## 口径
 *
 * - **轮内保序**：第一轮与补齐轮**各自**都按 `ranked` 的原序取 —— 但整体**不是**
 *   `ranked` 的子序列（补齐轮整体排在第一轮之后，见下一条）。所以「排序偏好不变」
 *   只在**轮内**成立：第 3 名的同渠道候选会被第 4、5 名的别家候选插到前面。
 *   ⚠️ 调用方若依赖「`targets` 整体是临期单调」，在 `auto` 分支上已不成立。
 * - **总名额不变**：仍是 `limit`（渠道少时由补齐轮用回同渠道的其余候选）；
 * - **补齐轮可能仍偏向一家**：名额必须填满，若某渠道可用模型远多于别家（例如 qoder 12 个、
 *   别家各 1 个），补齐轮会把剩下的名额都给它 ⇒ 最终池仍可能 12/14 是同一家。这是**有意的**：
 *   补齐轮的候选整体排在第一轮**之后**，别家在第 3、4 位就已经被试过了；要压「整池占比」
 *   就得放弃「把名额填满」，那会让末位候选永远轮不到（本仓 issue 记录过的坑）。
 * - **一家不许吃光**：`limit >= 2` 时一家最多 `limit - 1` 个（配额取
 *   `perProvider` 与 `limit - 1` 的较小者）⇒ **永远给别家留一个名额**。
 *   没有这一条时，`limit <= perProvider` 会**完全不分散** —— 而 `limit =
 *   maxAttemptsFor(catalog)` 是「最长候选表的长度」，只登录两家的部署里它恰好是 2。
 * - **纯函数**：不改传入数组；
 * - **退化值**：`perProvider` 非有限或 `<= 0` ⇒ 第一轮一个都不取、全部进补齐轮
 *   ⇒ 等价 `ranked.slice(0, limit)`（调用方显式关掉分散意图时就是这个效果）。
 * - provider 按**原样字符串**比较：本仓 provider id 全小写，**不做大小写归一**
 *   （归一了 `Qoder` 与 `qoder` 就成了两家，反而突破配额）。
 */
export function pickDiversified(ranked, limit, perProvider = AUTO_PER_PROVIDER_FIRST_PASS) {
    // ⚠️⚠️ **配额必须再按 `limit` 夹一次**（正向审计 P2-1，2026-11-14）。
    //    只按 `perProvider` 收时，`limit <= perProvider` 会**完全不分散**：
    //    `limit = 2`、`ranked = [q/a, q/b, q/c, buddy/x]` 仍取 `[q/a, q/b]`，
    //    「名额被一家占满」原样存在。而 `limit = maxAttemptsFor(catalog)` 是
    //    **最长候选表的长度**（`Math.max(1, longest)`），只登录两家的部署里
    //    它恰好就是 2 ⇒ 这是**可达**的，不是理论边界。
    //    夹法：`limit >= 2` 时一家最多 `limit - 1` 个 ⇒ 永远给别家留一个名额。
    const quota = Number.isFinite(perProvider) && perProvider > 0
        ? Math.max(1, Math.min(Math.floor(perProvider), Math.max(1, limit - 1)))
        : perProvider;
    const picked = [];
    const deferred = [];
    const taken = new Map();
    for (const candidate of ranked) {
        if (picked.length >= limit)
            break;
        const count = taken.get(candidate.provider) ?? 0;
        if (count < quota) {
            taken.set(candidate.provider, count + 1);
            picked.push(candidate);
        }
        else {
            deferred.push(candidate);
        }
    }
    for (const candidate of deferred) {
        if (picked.length >= limit)
            break;
        picked.push(candidate);
    }
    return picked;
}
//# sourceMappingURL=aggregate-core.js.map