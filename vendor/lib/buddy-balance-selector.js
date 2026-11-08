/**
 * CodeBuddy / WorkBuddy 账号余额缓存 + 按「积分何时作废」优先的选号。
 *
 * ## 它解决什么
 *
 * 两个 buddy 的账号池里，一个号常同时持有多种资源包（实测 WorkBuddy 每个号都有
 * 「Bonus Pack（14 天到期）」+「Free Plan Subscription（扣费截止 8 年后）」），
 * 而**服务端扣哪个包不由我们决定**。插件能做的是决定**用哪个号**：
 *
 * - 优先用「还有 15 天内到期积分」的号（那部分再不用就作废）；
 * - 只剩永久积分的号排最后；
 * - **锁定永久积分**时，只剩永久积分的号**等同于不可用**（与 Loomy 同语义）。
 *
 * 分档判据见 `buddy-balance-rank.ts`（为什么是 15 天、为什么用 `DeductionEndTime`）。
 *
 * ## 与 Loomy 那份（`loomy-balance-selector.ts`）的关系
 *
 * 同构：同样的 60 秒 TTL、同样的并发查余额、同样的「查询失败不抛错、归入最后
 * 一档」。差异只在余额的来源 —— Loomy 读服务端给的两个字段，这里读
 * `get-user-resource` 的包列表并按到期时间现算。
 *
 * ## 缓存**原料**、绝不冻结分类（本文件最重要的一条）
 *
 * 每次选号都实时查所有账号会显著变慢（N 个账号 = N 次网络往返，且该端点的响应
 * 实测可达数百 KB —— 一个账号可能有 105 个资源包）。故缓存 `get-user-resource`
 * 的原始 `CreditBalance`，TTL 60 秒。
 *
 * ⚠️ 但 TTL 的**唯一职责是抑制网络请求**，不能顺手把算好的两桶也缓存住：
 * 「临时 / 永久」是**当前时刻的函数**（`DeductionEndTime - now` 与 15 天比较），
 * 而宿主长期开着、时间只向前流 —— 一笔距到期 15.02 天的余额，在用户什么都不做的
 * 两分钟里就越过了线。若分类被缓存，选号会继续按「永久」处理一笔其实马上要作废的
 * 积分（锁定时更糟：本该可用的号被判成不可用）。所以 `balanceOf` 命中缓存也
 * **每次重新分桶**（窗口 env 也每次重读）。
 *
 * ℹ️ Loomy 那份（`loomy-balance-selector.ts`）缓存的是服务端给的**两个数字**，
 * 里面不含「按 now 现算」的成分，所以它没有这个问题 —— 不是漏改。
 */
import { fetchCreditBalance } from './credits.js';
import { buddyExpiringWindowDays, buddyBalanceTier, BUDDY_BALANCE_TIER, buddyTierUsable, rankBuddyAccountsByBalance, splitBuddyCreditsByExpiry, } from './buddy-balance-rank.js';
/** 余额缓存 TTL（毫秒），与 Loomy 同值。 */
export const BUDDY_BALANCE_CACHE_TTL_MS = 60_000;
/**
 * **失败**结果的缓存 TTL（毫秒）—— 比成功短一个数量级。
 *
 * 与 Loomy 那份同一修复（用户报障 2026-09-29）：失败条目归入 `none` 档，
 * 锁定时被判「不可用」，于是**一次网络抖动**会让整池在 60 秒内全部不可用，
 * 用户被告知「额度已用尽」而实际号里都有钱。失败是瞬时状态，
 * 不该被当成一个持续一分钟的事实。
 */
export const BUDDY_BALANCE_ERROR_CACHE_TTL_MS = 5_000;
/**
 * 余额缓存 + 选号器。
 *
 * 生命周期与 provider 的适配器注册一致（**每个 provider 各一个实例**），
 * 故不存在跨站缓存互相串味的可能。
 *
 * ⚠️ 泛型参数见 {@link BuddySelectionDeps}；缺省仍是 buddy 系，
 * 既有调用点（CodeBuddy / WorkBuddy）无需改动。
 */
export class BuddyBalanceSelector {
    deps;
    cache = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    /** 清空缓存（凭据变化、手动刷新余额、领取积分后调用）。 */
    invalidate(accountId) {
        if (accountId === undefined)
            this.cache.clear();
        else
            this.cache.delete(accountId);
    }
    /**
     * 当前生效的「临时积分」窗口（毫秒）。
     *
     * ⚠️ **每次调用都重新解析环境变量**，不能缓存：窗口可被用户随时改，
     * 而提示文案与选号判据必须取同一个值 —— 缓存会让两者在不同时刻分裂。
     */
    windowMs() {
        return this.deps.windowMs ?? buddyExpiringWindowDays() * 24 * 60 * 60 * 1000;
    }
    /**
     * 查一个账号的余额分类（**缓存原料、每次现算**）。
     *
     * ⚠️ TTL 只用于抑制**网络请求**，绝不能拿来冻结分类：「临时 / 永久」是
     * **当前时刻的函数** —— 一笔距到期 15.2 天的余额，什么都没人操作，
     * 过 30 分钟就成了临时积分。所以这里缓存的是 `get-user-resource` 的原始
     * `CreditBalance`，命中缓存也重新分桶（并重新读一次窗口 env）。
     * 宿主是长期开着的，时间只会向前流动。
     *
     * ⚠️ **查询失败不抛错**：返回 `ok: false` 的条目，由分档逻辑归入最后一档 ——
     * 让「一个号查不到」不至于让整个选号失败（凭据过期是最常见的失败原因，
     * 此时应继续用别的号，而不是把错误抛给用户）。
     *
     * ⚠️ **失败结果的 TTL 短一个数量级**（与 Loomy 那份同一修复，见
     * `BUDDY_BALANCE_ERROR_CACHE_TTL_MS`）：把一次抖动缓存满 60 秒，会让
     * 「查不到」伪装成「额度用尽」整整一分钟。
     */
    async balanceOf(account) {
        const now = this.deps.now?.() ?? Date.now();
        const cached = this.cache.get(account.id);
        if (cached !== undefined) {
            /**
             * ⚠️⚠️ **降级结果必须走「错误」那档短 TTL**（2026-10-21 二轮审计，P2）。
             *
             * `ok: true` + `degraded: true` 的组合语义是「总额读到了、逐包明细丢了」——
             * 它**不是一个稳定的成功读数**，而是一次**瞬态不确定性**（例如流水端点抖动）。
             *
             * 若按 `ok` 走 60 秒长 TTL：一次抖动 ⇒ **60 秒内每次选号都报 `unknown`**
             *（修前更糟：60 秒内报「积分都已用尽」）。
             * ⇒ 降级与失败同等对待，走 `errorTtlMs`（默认 5 秒）⇒ 抖动一过即自愈。
             *
             * ⚠️ 判据必须读 `cached.source.balance.degraded`（**原料**），不是
             * `classify()` 之后的条目 —— `classify` 依赖 `now`，而这里是在**决定
             * 要不要重算**，必须看「当时取到的原料」。
             */
            const degradedSource = cached.source.ok && cached.source.balance.degraded === true;
            const ttl = cached.source.ok && !degradedSource
                ? (this.deps.ttlMs ?? BUDDY_BALANCE_CACHE_TTL_MS)
                : (this.deps.errorTtlMs ?? BUDDY_BALANCE_ERROR_CACHE_TTL_MS);
            if (now - cached.at < ttl) {
                return this.classify(account.id, cached.source, now);
            }
        }
        const source = await this.fetchSource(account);
        this.cache.set(account.id, { at: now, source });
        return this.classify(account.id, source, now);
    }
    /**
     * 把原料按**当前时刻**分成两桶并定档。
     *
     * 单独成函数就是为了「原料只查一次、分类随时间重算」这件事结构上无法被绕过。
     */
    classify(id, source, now) {
        if (source.ok !== true)
            return failedEntry(id, source.error);
        const windowMs = this.windowMs();
        const split = splitBuddyCreditsByExpiry(source.balance, now, windowMs);
        if (split === undefined)
            return failedEntry(id, '余额响应无法解析出积分池');
        const entry = {
            id,
            ok: true,
            expiringBalance: split.expiring,
            permanentBalance: split.permanent,
            split,
            // ⚠️ 透传「降级」：总额可信、明细不可达 ⇒ 下游不得据此断言 exhausted。
            ...(source.balance.degraded === true ? { degraded: true } : {}),
        };
        entry.tier = buddyBalanceTier(entry, { now, windowMs });
        return entry;
    }
    /** 发一次请求取原料（不做任何分类）。 */
    async fetchSource(account) {
        let credential;
        try {
            credential = await this.deps.resolveCredential(account.credentialRef);
        }
        catch (error) {
            return { ok: false, error: `读取凭据失败：${error instanceof Error ? error.message : String(error)}` };
        }
        if (credential === undefined) {
            return { ok: false, error: '凭据未配置或已失效' };
        }
        let balance;
        try {
            // ⚠️ 缺省实现只适用于 buddy 系（凭据结构相同）。其它 provider 的
            // `fetchBalance` 由 {@link FetchBalanceRule} 在**编译期**强制必填；
            // 这里再加一道运行时防御 —— 万一有人用 `as` 绕过了类型，
            // 宁可立刻抛一条能指认到原因的错，也不要发出 `undefined/...` 的畸形请求
            // 让它变成一句无法归因的「余额查询失败」。
            //
            // ⚠️ **详细变体优先**（见 {@link BalanceQueryDetail}）：它返回
            // `{ balance, error? }`，能同时给出「有没有余额」和「为什么查不到」。
            // 传了它就不再走 `fetchBalance` —— 两者都传时详细变体是严格超集。
            const detailed = this.deps.fetchBalanceDetailed;
            if (detailed !== undefined) {
                /**
                 * ⚠️ **同样要传第三参**：详细变体优先于 `fetchBalance`，若此处不给
                 * `ctx`，那些「按出口 IP 分流」的渠道会在这条腿上丢掉出口配置
                 * （详见 {@link BuddySelectionDeps.fetchBalanceDetailed} 的注释）。
                 */
                const result = await detailed(credential, this.deps.product, {
                    accountId: account.id,
                    ...this.deps.fetchFor === undefined ? {} : { fetchFor: this.deps.fetchFor },
                });
                if (result.balance === null) {
                    // ⚠️ `error` 缺失时仍给一句**能指认到「未知」**的话，而不是
                    //    回落到那句会把用户引向凭据的概括文案 —— 后者是确定的错误归因。
                    return { ok: false, error: result.error ?? '余额查询失败（未提供具体原因）' };
                }
                return { ok: true, balance: result.balance };
            }
            const injected = this.deps.fetchBalance;
            if (injected === undefined && typeof this.deps.product.endpoint !== 'string') {
                throw new Error(`${this.deps.product.id ?? 'provider'} 未注入 fetchBalance，`
                    + '且产品配置没有 endpoint —— 选号器无法查询该 provider 的余额');
            }
            balance = await (injected
                ?? ((cred, product) => fetchCreditBalance(cred, product, this.deps.fetcher ?? fetch)))(
            /**
             * ⚠️ **第三参带上账号上下文**：出口代理是**账号维度**的，而本方法
             * 手上正有 `account.id` —— 不传下去，按出口 IP 分流的渠道（MiniMax
             * 国际站）会恒查不到余额 ⇒ 在聚合轮换里被**静默剔除**。
             */
            credential, this.deps.product, { accountId: account.id, ...this.deps.fetchFor === undefined ? {} : { fetchFor: this.deps.fetchFor } });
        }
        catch (error) {
            return { ok: false, error: `余额查询异常：${error instanceof Error ? error.message : String(error)}` };
        }
        if (balance === null) {
            return { ok: false, error: '余额查询失败（凭据失效或响应异常）' };
        }
        return { ok: true, balance };
    }
    /**
     * 从候选账号中按「快到期优先」选一个。
     *
     * 排序规则见 `rankBuddyAccountsByBalance`：
     * 有快到期积分 → 只剩永久 → 无余额/查不到。**档内保持传入顺序**（= 手动顺序）。
     *
     * ⚠️ **锁定永久积分时（`allowPermanent: false`）**：只剩永久积分的账号落入
     * `none` 档（不可用）。若**全部候选都不可用**，返回 `ok: false` 并带上原因 ——
     * 调用方据此报明确错误，而不是硬着头皮消耗永久积分。
     *
     * ⚠️ **解锁时不改变既有行为**：所有候选余额都是 0 仍返回第一个候选，
     * 让上游去报真正的失败原因（凭据、限流、余额），错误信息更准确。
     *
     * @param candidates - 已按 `enabled` 与模型限流过滤过的候选（顺序即手动优先级）。
     * @param options - `allowPermanent` 为 false 时禁止消耗永久积分。
     */
    async select(candidates, options = {}) {
        if (candidates.length === 0) {
            // ⚠️ 空候选 = **压根没查过余额**，不能报 `exhausted`（那是在替服务端
            //    断言「积分是 0」）。见 `no-candidates` 的说明。
            return { ok: false, reason: { kind: 'no-candidates' } };
        }
        // 并发查余额：账号数通常个位数，并发比串行快得多。
        const balances = await Promise.all(candidates.map((c) => this.balanceOf(c)));
        const byId = new Map(candidates.map((c, i) => [c.id, { account: c, balance: balances[i] }]));
        const ranked = rankBuddyAccountsByBalance(balances, options);
        const first = ranked[0];
        if (first === undefined) {
            return { ok: false, reason: noAccountReason(balances) };
        }
        // ⚠️ 排序只保证「可用的在前」，**不保证第一个可用** —— 未锁定时 none 档
        // 也参与排序（作为兜底），故只在锁定情况下才把「全部不可用」判成无可用账号。
        if (options.allowPermanent === false && !buddyTierUsable(buddyBalanceTier(first, options))) {
            // ⚠️⚠️ **降级只能放行「查不到」的账号，不能放行「明确只剩永久积分」的账号**
            //（2026-11-05 三审回归面 P1-1，`631f1c8` 引入的回归）。
            //
            // `noAccountReason` 是**池级**判据：只要有**任何一个**账号查不到就返回
            // `unknown`（`kind: 'unknown'`）。而降级分支（见 `select` 下方的
            // `degradeOnUnknown`）会把 `allowPermanent` **全局**置真后重排 ——
            // 置真后 `buddyBalanceTier` 对「`expiring = 0` 且 `permanent > 0`」的账号
            // 返回 `permanent`（可用）⇒ 该账号被选中 ⇒ **用户明明关掉了「消耗永久
            // 积分」却被烧永久积分**。
            //
            // 叠加形态实测（真实 `lib/` 链路，`probe-degrade-mixed.mjs`）：
            // ```
            // 候选 = [a1 查不到, a2 只剩永久 800]
            //   degrade=false ⇒ locked（reason: unknown）        ← 正确
            //   degrade=true  ⇒ account a2 (tier=permanent) 🚨   ← 烧永久积分
            // ```
            //
            // ⚠️ `expiring > 0` 的账号在锁定态**本就可承载**（`buddyBalanceTier` 先
            // 判 `expiring`），永远进不了这条降级分支 ⇒ 降级的真实风险是
            // 「**永久**积分」，不是「临期积分」（本文件与 `src/index.ts` 原先三处
            // 注释写反了，已一并订正）。
            //
            // ⇒ 只要存在「余额查得到、且只剩永久积分」的账号，就必须报 `exhausted`
            //   （`exhausted` 不会触发 `pickBuddyAccount` 的降级分支），而不是
            //   `unknown`。用 `buddyBalanceTier` 判而不是硬编码字段名，避免与
            //   `positiveOrZero` 的归一化漂移。
            const definitive = balances.some((entry) => entry.ok
                && entry.degraded !== true
                && buddyBalanceTier(entry, { allowPermanent: true }) === BUDDY_BALANCE_TIER.permanent);
            return { ok: false, reason: definitive ? { kind: 'exhausted' } : noAccountReason(balances) };
        }
        const picked = byId.get(first.id);
        if (picked === undefined)
            return { ok: false, reason: { kind: 'exhausted' } };
        return { ok: true, account: picked.account, balance: picked.balance };
    }
}
/**
 * 判定「为什么没有可用账号」：区分**真的用尽**与**查不到**。
 *
 * 只要有任何一个候选是查询失败，就不能断言"额度都已用尽"—— 我们对它的余额
 * 其实一无所知。混报会让用户去解锁或白等一天，而号其实有钱。
 */
function noAccountReason(balances) {
    const errors = balances.filter(b => !b.ok).map(b => b.error ?? '未知原因');
    // ⚠️ `degraded` 标记**先算**：只要池里有一个「降级读数」，本档就**不是**「纯查不到」
    // （2026-11-05 对抗审计 P2-1）⇒ 调用方不得据此放宽永久积分锁定。
    const hasDegraded = balances.some((b) => b.ok && b.degraded === true);
    if (errors.length > 0)
        return { kind: 'unknown', errors, ...(hasDegraded ? { degraded: true } : {}) };
    /**
     * ⚠️⚠️ **「明细不可达」也不能断言 `exhausted`**（2026-10-21 二轮审计 P1）。
     *
     * `ok: false` 只覆盖「连总额都没拿到」。还有一类更隐蔽的：
     * **总额拿到了、明细丢了**（`balance.degraded === true`）—— 例如 AutoClaw
     * 的流水端点抖动时静默回退钱包包，回退包**没有 `deductionEndTime`**。
     *
     * 而 `splitBuddyCreditsByExpiry` 把「没有到期时刻」判成**永久桶**（对真·永久是对的）
     * ⇒ 一次明细抖动会让「有临期积分的账号」被判成**只剩永久积分** ⇒
     * 锁定时报「积分都已用尽」—— **那句会把用户推向不可撤回的解锁**。
     *
     * 实测（AutoClaw，同一账号同一 5000 余额，只改流水端点是否 500）：
     * ```
     * 流水正常 → split={expiring:5000} tier=expiring（可用）✅
     * 流水 500 → split={permanent:5000} tier=none（「积分都已用尽」）❌
     * ```
     * ⇒ **降级必须与失败同等对待**：都归 `unknown`（「无法确认」），不归 `exhausted`。
     */
    const degraded = balances.filter((b) => b.ok && b.degraded === true);
    if (degraded.length > 0) {
        return {
            kind: 'unknown',
            degraded: true,
            errors: [`${degraded.length} 个账号的**逐包明细**不可用（总额已读到，但没有到期时刻）`],
        };
    }
    return { kind: 'exhausted' };
}
/** 构造一个「查询失败」的余额条目。 */
function failedEntry(id, error) {
    return { id, ok: false, error };
}
/**
 * 选号 + 取凭据的完整编排（供 `src/index.ts` 的 buddy 系 provider 调用）。
 *
 * ## 为什么需要这一层
 *
 * `select()` 只保证「档位最优」，**不保证那个账号的凭据能解析出来**。凭据损坏 /
 * 未配置时必须换下一个候选，否则一次抖动就会让请求失败。而循环放在池里做不了
 * （池不知道余额），放在适配器里又会让两个 provider 各写一遍 —— 故收敛成本函数。
 *
 * ⚠️ **锁定与未锁定的收尾不同**（这是本函数的全部复杂度来源）：
 * - 锁定：候选耗尽即 `kind: 'locked'`，调用方**必须报错**，绝不能退回
 *   `getAvailableAccount` —— 那会绕过锁定、照样消耗永久积分，使锁定形同虚设。
 * - 未锁定：候选耗尽（通常是凭据都坏了）时返回 `kind: 'exhausted'` 并带上
 *   `tried`，调用方据此把同一批账号传给 `getAvailableAccount` 的排除集合，
 *   从而**继续尝试池里的其余账号**（既有行为）。
 *
 * @param selector - 该 provider 专属的选号器（缓存不能跨站共用）。
 *   ⚠️ 只要求 {@link BuddySelectorLike} 这个**结构**形状，不要求具体类 ——
 *   具体类带 `private` 成员（名义类型），会让 `credential-resolver.ts` 的
 *   测试替身无法传入。真实例天然满足该接口，既有调用点不受影响。
 * @param candidates - 已按 `enabled` + 模型限流过滤的候选。
 * @param options - 锁定标志与凭据解析器。
 */
export async function pickBuddyAccount(selector, candidates, options) {
    const tried = new Set();
    let allowPermanent = options.allowPermanent !== false;
    /**
     * ⚠️ **候选为空必须当场定因**（真实报障 2026-10-13，CodeBuddy）：
     * 下面的循环上界是候选数，空候选时**一次都不执行**，`reason` 会保持
     * `undefined`；调用方的 `?? { kind: 'exhausted' }` 于是把「候选被模型限流
     * 筛空」**凭空**断言成「积分都已用尽」，用户据此去解锁永久积分 ——
     * 而解禁时刻其实就写在 `modelRateLimits` 里。
     */
    let reason = candidates.length === 0 ? { kind: 'no-candidates' } : undefined;
    // 循环上界取候选数：每次迭代至少排除一个账号，故必然终止。
    for (let remaining = candidates; remaining.length > 0;) {
        const picked = await selector.select(remaining, { ...options.tierOptions, allowPermanent });
        if (!picked.ok) {
            /**
             * ⚠️⚠️ **「余额查不到」≠「没有可用积分」，锁定时必须降级放行**（2026-11-04 真机报障）。
             *
             * 症状（用户原话「模型都选不了了」）：面板上「永久积分」锁定开着，而余额接口
             * 被上游网关拒（真机 HTTP 403/405）⇒ 每个账号都 `ok:false` ⇒ `noAccountReason`
             * 给出 `unknown` ⇒ 调用方 `plan.lockedError(reason)` 抛错 ⇒ **整个 provider
             * 的模型列表被清空**，模型选择器里只剩一大段错误文案，用户一个模型都选不了。
             *
             * 语义上 `unknown` 只说明「**我们不知道**这个号有没有积分」，它既不等于
             * 「积分用尽」（`exhausted`），也不等于「全是永久积分」（`locked` 的本意）。
             * 把它当成硬拒绝，等于让一次网关抖动把整条渠道打掉 —— 代价远大于收益：
             * 降级只是「可能消耗**永久**积分」，而不降级是「完全用不了」。
             *
             * ⚠️⚠️ **风险是「永久」不是「临期」**（2026-11-05 三审回归面 P2-1，本文件与
             * `src/index.ts` 原先三处都写反了）：`expiring > 0` 的账号在 `allowPermanent
             * = false` 时 `buddyBalanceTier` **先判 `expiring`** ⇒ 本来就可用 ⇒ 永远不会
             * 进这条降级分支。能进本分支的只可能是 `expiring = 0` 的账号，即
             * 「只剩永久积分」或「余额完全为 0」—— 正是用户锁定时要防的那件事。
             *
             * ⇒ 锁定态遇到 `unknown` 时**放宽一次**（`allowPermanent = true`）重跑同一个
             * 候选集：只要余额是查得到的，档位判定照旧生效，锁定语义不变；只有在
             * 「查不到」这一格才退化成「允许消耗永久积分」。
             *
             * ⚠️⚠️ **但「明确只剩永久积分」的账号绝不能被这样放行**：`noAccountReason`
             * 是池级判据（任一账号查不到即 `unknown`），若池里同时有「查不到」与
             * 「明确只剩永久」，全局置 `allowPermanent` 会把后者放行 ⇒ 烧永久积分。
             * 故 `select` 在进入本分支前已先判 `definitive`（存在明确只剩永久的账号
             * ⇒ 报 `exhausted`）。
             *
             * ⚠️⚠️ **「降级读数」也不能被这样放行**（2026-11-05 对抗审计 P2-1）：
             * `noAccountReason` 把「纯查不到」与「总额读到、明细丢了（`degraded`）」都归
             * `unknown`，而 `definitive` 守卫刻意 `&& entry.degraded !== true` 把降级账号
             * **排除在** `definitive` **之外** ⇒ 降级读数恰好落进本分支 ⇒ 放宽后按
             * 「永久积分」烧。而明细丢失时「有临期积分」本就可能被误判成「只剩永久积分」
             * ⇒ 这正是 `noAccountReason` 那段注释要防的事。
             * ⇒ 本分支必须再加一条腿：`reason.degraded !== true`。
             *
             * ⚠️ 不会死循环：`allowPermanent` 置真后 `!allowPermanent` 恒假，本分支只进一次。
             * ⚠️ 放开后若仍失败，`kind` 由 `allowPermanent` 决定 ⇒ 变 `exhausted`
             *    （走池兜底），不再是「锁定拒绝」—— 与「真的没有可用账号」如实对应。
             */
            if (!allowPermanent && picked.reason.kind === 'unknown'
                && picked.reason.degraded !== true
                && options.degradeOnUnknown === true) {
                allowPermanent = true;
                continue;
            }
            reason = picked.reason;
            break;
        }
        const credential = await options.resolveCredential(picked.account.credentialRef);
        if (credential !== undefined) {
            return { kind: 'account', account: picked.account, balance: picked.balance, credential, tried };
        }
        tried.add(picked.account.id);
        remaining = remaining.filter(c => c.id !== picked.account.id);
    }
    // 锁定时的「无可用账号」是**用户要的确定性结果**，与凭据无关；
    // 未锁定时的失败只可能是凭据问题，交给调用方继续走池的兜底。
    //
    // ⚠️ `reason` 仍缺席 ⇒ **是「凭据全坏」而不是「积分用尽」**（2026-10-14 审计
    //    实测打穿的漏网路径）。走到这里只有两种情形：
    //    ① 候选为空 —— 开头已预置 `no-candidates`，故此时 `reason` 非空；
    //    ② 候选非空、每次 `select()` 都返回 `ok:true`，但那些号的凭据都解析不出来
    //       ⇒ 循环耗尽候选，`reason` 一次都没被赋值。
    //    而 `ok:true` **本身就证明**该号落在「可用档」（锁定时只有 `expiring` 可用）
    //    ⇒ 明知它有钱却报「积分都已用尽」是**自相矛盾**，且会把用户推向
    //    「解锁永久积分」（不可撤回地烧钱）。故必须如实归到 `credential-only`。
    //    ⚠️ 不能省着不填让调用方的 `?? { kind: 'exhausted' }` 兜底 —— 那正是缺陷本体。
    if (reason === undefined)
        reason = { kind: 'credential-only' };
    return { kind: allowPermanent ? 'exhausted' : 'locked', tried, reason };
}
//# sourceMappingURL=buddy-balance-selector.js.map