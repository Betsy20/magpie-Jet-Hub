/**
 * AgnesCode 系的站点常量（国内站 + 国际版）。
 *
 * ## 为什么是**两个 provider id**，而不是一个 id 带站点参数
 *
 * AgnesCode 的两站（`*.agnes-ai.cn` / `*.agnes-ai.com`）是两套账号体系，
 * 且本仓的**模型目录按 provider 缓存一份**（`model-catalog.ts`）——
 * 单 id 下另一站的模型要么不进列表、要么被静默回退成本站模型。
 * 与 `minimax` / `minimaxintl`、`qoder` / `qodercn` 同构，两站各占一个 id。
 *
 * ⚠️ `provider-registry.ts` 要求 id **纯小写字母**（`^[a-z]+$`），
 * 故国际版只能是 `agnescodeintl`，不能带连字符/下划线。
 *
 * ## 为什么这里**没有** base URL 常量
 *
 * 推理与 BFF 的 base 是**每账号数据**：它来自桌面端会话文件里的
 * `bffPublicBaseUrl`，并经过 {@link ./agnescode.ts} 的 origin 钉扎。
 * 把一个 base 写成常量就等于「所有账号都打到同一个站」——这正是国际版
 * 凭据被发到国内站的成因。本文件的 `fallbackBffBase` 只服务一种场景：
 * 用户**手工粘贴 token** 且没给 base（自动采集路径永远用会话里的那份）。
 *
 * @module src/agnescode-product.ts
 */
/** AgnesCode 国内站。 */
export const AGNESCODE = {
    id: 'agnescode',
    domain: 'cn',
    displayName: 'AgnesCode',
    defaultCredentialRef: 'AGNESCODE_ACCESS_TOKEN',
    fallbackBffBase: 'https://api-agnes-code.agnes-ai.cn/v1',
    fetchTimeoutMs: 30_000,
};
/** AgnesCode 国际版。 */
export const AGNESCODE_INTL = {
    id: 'agnescodeintl',
    domain: 'intl',
    displayName: 'AgnesCode (国际版)',
    defaultCredentialRef: 'AGNESCODEINTL_ACCESS_TOKEN',
    fallbackBffBase: 'https://api-agnes-code.agnes-ai.com/v1',
    fetchTimeoutMs: 30_000,
};
/** 两站的产品常量（唯一真相源）。 */
export const AGNESCODE_PRODUCTS = Object.freeze([AGNESCODE, AGNESCODE_INTL]);
/**
 * 目录里显示的名字：倍率挂在名字后面（` · x6.00`），缺字段则原样。
 *
 * ⚠️ 为什么倍率必须进 `name`（2026-11-19 真机取证 + 参考实现同款）：本仓的模型
 * 选择器**没有**展示价格的通道（宿主 `LlmModelInfo` 只有 `description` / `badge`），
 * 而 `points_cost_multiplier` 是**计费事实**：`kimi-k3` 是 6×、`gpt-6-astra` 是 25×，
 * 不标出来用户会在「看起来一样」的两行里选中贵 25 倍的那个。参考实现用的正是
 * ` · x{n.toFixed(2)}` 这个写法（与 SenseNova / WorkBuddy 选择器一致）。
 * ⚠️ `0` 要显示成 `x0.00`（它是「免费」这条真实报价），不能当缺值吞掉。
 */
export function agnescodeDisplayName(entry) {
    const multiplier = entry.multiplier;
    if (typeof multiplier !== 'number' || !Number.isFinite(multiplier))
        return entry.name;
    return `${entry.name} · x${multiplier.toFixed(2)}`;
}
/** 订阅门控的说明文字（不需要订阅时 `undefined`）。 */
export function agnescodeSubscriptionNote(entry) {
    const tiers = entry.subscriptions;
    if (tiers === undefined || tiers.length === 0)
        return undefined;
    return `需要 ${tiers.join(' / ')} 订阅；免费档请求会被上游 403（subscription_required）`;
}
/** 「免费模型」判据：倍率为 **0**（这正是上游报价的含义，不是缺值）。 */
export function agnescodeIsFree(entry) {
    return entry.multiplier === 0 ? true : undefined;
}
/**
 * 兜底目录（**刻意留空**）。
 *
 * ⚠️⚠️ 本仓红线：静态兜底表必然腐坏（Qoder 那次把「0.1×」写死在表里，
 * 上游早改成免费，插件还按老价展示）。更关键的是本 provider 的目录行为
 * **只有远端一个来源**：`{apiRoot}/v2/models` 是账号级下发（不同订阅档
 * 看到不同条目），任何一行写死在这里都可能与用户账号的真实目录冲突。
 *
 * 留空的代价是**可控的**：没有可用账号时注册表侧的目录门控本来就隐藏
 * 整家 provider（`providerCatalogVisible()` + `DSH_HIDE_MODELS_WITHOUT_ACCOUNT`
 * 默认开启，见 `account-pool.ts`），所以「空目录」只会出现在「不该显示」的时刻，
 * 不会出现「登录了却选不到模型」。
 *
 * 若将来要补表，**必须**先有真机取证（`test/live-agnescode.mjs` 同款探针），
 * 不接受按印象编 id / 窗口 / 上限。
 */
export const AGNESCODE_FALLBACK_MODELS = Object.freeze([]);
/**
 * 取该站的兜底目录。
 *
 * 目前两站同表（理由见 {@link AGNESCODE_FALLBACK_MODELS}），保留函数形态是
 * 为了让「国际版有一天取证到自己的表」时只改本函数，不改所有调用点。
 */
export function agnescodeFallbackModels(_product) {
    return AGNESCODE_FALLBACK_MODELS;
}
//# sourceMappingURL=agnescode-product.js.map