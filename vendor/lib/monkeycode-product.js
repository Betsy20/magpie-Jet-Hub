/**
 * MonkeyCode 产品配置（国内站 `monkeycode-ai.com` 与国际站 `monkeycode-ai.net`）。
 *
 * ## 为什么只有一个推理通道
 *
 * 2026-11-02 的实测把三套服务彻底分开了（用户当场指出「既然是独立的你为什么
 * 只做一个供应商账号」，这场改造就是答复）：
 *
 * | 服务 | 平台 | 模型网关 | 凭据 | 计费 |
 * |---|---|---|---|---|
 * | 国内 MonkeyCode | `monkeycode-ai.com` | `proxy.monkeycode-ai.com/v1` | `oma_…` + `signing_secret` | 每日额度 + 积分 |
 * | 国际 MonkeyCode | `monkeycode-ai.net` | `proxy.monkeycode-ai.net/v1` | 同构（独立账号池） | 同构 |
 * | 百智云 | `baizhi.cloud` | `ai-models.app.baizhi.cloud` | `sk-…` | 按量计费 |
 *
 * 三者**账号不互通**（实测：百智云 cookie 打 `monkeycode-ai.com` 是 401；
 * 国内 cookie 不认国际站；网关只认 `x-api-key` 不认 cookie）。所以本模块
 * 只描述 **MonkeyCode 系**（国内 + 国际），百智云是独立 provider（`baizhi-*.ts`）。
 *
 * ## ⚠️ 网关没有模型列表接口（实测 `GET /v1/models` 返回 405）
 *
 * 两个站都是 405（行为完全一致，这也是「同一个程序的两套部署」的证据）。
 * 所以目录**只有**内置常量 {@link MONKEYCODE_GATEWAY_MODELS}，没有远端来源。
 *
 * 这份清单是从平台侧 `GET /api/v1/users/models`（cookie 认证，非推理端点）
 * 抓下来的快照，**不是**猜的 —— 但它是快照，上游加模型后这里不会自动更新。
 * 命名规律（见 SPEC §3）：
 * - 带 `monkeycode-basic/` `monkeycode-pro/` `monkeycode-ultra/` 前缀 ⇒ 走**每日额度**，
 *   前缀即订阅档位；basic 账号请求 pro/ultra 前缀 ⇒ 403；
 * - 不带前缀（`deepseek-flash`、`glm-5`…）⇒ **直接扣积分**。
 *
 * ## ⚠️ 凭据 ref 前缀不能互相吃
 *
 * `MONKEYCODE_ACCESS_TOKEN` 与 `MONKEYCODEINTL_ACCESS_TOKEN` 是**超串关系**
 * （后者以前者开头）。`src/jet-hub-store.ts` 的 `ACCOUNT_REF_RE` 按**长度降序**
 * 匹配，故两者能各自归位；但新增站点时仍必须给不同的 `defaultCredentialRef`，
 * 否则账号在 `state.json` 缺失时会认错 provider（静默）。
 *
 * @module src/monkeycode-product.ts
 */
/** MonkeyCode 国内站的产品常量。 */
export const MONKEYCODE = {
    id: 'monkeycode',
    displayName: 'MonkeyCode',
    gatewayBaseUrl: 'https://proxy.monkeycode-ai.com/v1',
    gatewayMessagesPath: '/messages',
    platformBaseUrl: 'https://monkeycode-ai.com',
    walletPath: '/api/v1/users/wallet',
    subscriptionPath: '/api/v1/users/subscription',
    profilePath: '/api/v1/users/status',
    checkinPath: '/api/v1/users/wallet/checkin',
    transactionPath: '/api/v1/users/wallet/transaction',
    captchaChallengePath: '/api/v1/public/captcha/challenge',
    captchaRedeemPath: '/api/v1/public/captcha/redeem',
    apiKeysPath: '/api/v1/users/ohmyagent/api-keys',
    anthropicVersion: '2023-06-01',
    defaultCredentialRef: 'MONKEYCODE_ACCESS_TOKEN',
    catalogTimeoutMs: 10_000,
};
/**
 * MonkeyCode 国际站的产品常量。
 *
 * ⚠️ **契约同构但未真机验证**：`proxy.monkeycode-ai.net/v1/models` 实测同样
 * 返回 405（与国内站逐字节一致的行为），`/api/v1/users/models` 同样要求登录，
 * 说明是「同一个程序的两套部署」。但国际站的 `apiKeysPath` 与凭据格式
 * **没有用真实账号跑通过**（本机只有国内账号）—— 若将来 404/字段不同，
 * 改这一个常量即可，不要动 `monkeycode.ts` 的逻辑。
 */
export const MONKEYCODE_INTL = {
    id: 'monkeycodeintl',
    displayName: 'MonkeyCode 国际版',
    gatewayBaseUrl: 'https://proxy.monkeycode-ai.net/v1',
    gatewayMessagesPath: '/messages',
    platformBaseUrl: 'https://monkeycode-ai.net',
    walletPath: '/api/v1/users/wallet',
    subscriptionPath: '/api/v1/users/subscription',
    profilePath: '/api/v1/users/status',
    checkinPath: '/api/v1/users/wallet/checkin',
    transactionPath: '/api/v1/users/wallet/transaction',
    captchaChallengePath: '/api/v1/public/captcha/challenge',
    captchaRedeemPath: '/api/v1/public/captcha/redeem',
    apiKeysPath: '/api/v1/users/ohmyagent/api-keys',
    anthropicVersion: '2023-06-01',
    defaultCredentialRef: 'MONKEYCODEINTL_ACCESS_TOKEN',
    catalogTimeoutMs: 10_000,
};
/** 全部站点（注册表按此列表展开）。 */
export const MONKEYCODE_PRODUCTS = [MONKEYCODE, MONKEYCODE_INTL];
/**
 * **deepseek 系**的账号级上下文硬上限（tokens）。
 *
 * 证据：SPEC 实测，服务端 400 原文
 * `This model's maximum context length is 1048576 tokens. However, you requested
 *  3186133 tokens …`；450 万字符 → `input_tokens 604,931` 成功。
 *
 * ⚠️⚠️ **这个数字只对 deepseek 成立，不能当成「整个网关所有模型的窗口」**
 * （2026-11-02 复审发现）：
 * 1. 网关目录里还有 `glm-5` 等别家模型，它们的窗口**各不相同**、彼此无关 ——
 *    照抄 deepseek 的数字就是**谎报**，而本文件的既定原则是「未知就省略，
 *    省略比谎报更安全」（见 {@link MonkeycodeModelEntry.contextWindow}）。
 * 2. 这个值不是只用于显示：适配器经 `createModelCatalog` 透传给宿主，
 *    **DSH 压缩模块（`dsh-compaction-basic`）拿它算压缩阈值** ⇒ 声明越大压缩接得越晚。
 *    给 glm-5 标 1,048,576 会让它在 90 万 token 才压缩 —— 那时单次请求的
 *    计费 token 已经高到不可接受（本产品按 `input + cache_read + 10×output`
 *    折算，见 SPEC §5）。
 * 3. 桌面端自己只敢播报 200,000（`config.json` 的 `context_window`）——即同一个
 *    上游，产品侧口径比硬上限小 5 倍。本插件在**有实测证据**的 deepseek 上
 *    播报硬上限（用户能真正用满），在**没有证据**的模型上不播报。
 */
export const MONKEYCODE_MAX_CONTEXT = 1_048_576;
/**
 * 网关的内置目录 —— 也是**唯一**的目录来源。
 *
 * ⚠️ **没有远端来源**（`GET /v1/models` 返回 405），这份表就是全量事实。
 * 来源：平台侧 `GET /api/v1/users/models` 的快照。上游加模型后需手工同步。
 *
 * ⚠️ 上下文窗口的声明策略：**有实测证据的 deepseek 系**统一声明
 * `MONKEYCODE_MAX_CONTEXT`（服务端 400 原文作证）；`glm-5` 等**未实测**的模型
 * 一律省略 —— 本文件的既定原则是「未知就省略，省略比谎报更安全」。
 *
 * 省略的代价要认下来：DSH 的上下文占用条只在声明了 `contextWindow` 时渲染，
 * 所以 `glm-5` 那几条没有占用条（2026-11-02 审查 A🟡-9 提出的「整条消失」）。
 * 反过来给没证据的模型标 1M，会让溢出压缩推迟到根本到不了的 token 数，
 * 而压缩阈值正是由这个字段算的 —— 谎报的代价比少一条进度条大得多。
 */
export const MONKEYCODE_GATEWAY_MODELS = [
    { id: 'monkeycode-basic/deepseek-flash', name: 'DeepSeek Flash（basic 额度）', contextWindow: MONKEYCODE_MAX_CONTEXT },
    { id: 'monkeycode-basic/deepseek-v4-flash', name: 'DeepSeek V4 Flash（basic 额度）', contextWindow: MONKEYCODE_MAX_CONTEXT },
    { id: 'monkeycode-pro/deepseek-flash', name: 'DeepSeek Flash（pro 额度）', contextWindow: MONKEYCODE_MAX_CONTEXT },
    { id: 'monkeycode-pro/deepseek-v4-pro', name: 'DeepSeek V4 Pro（pro 额度）', contextWindow: MONKEYCODE_MAX_CONTEXT },
    { id: 'monkeycode-ultra/deepseek-v4-pro', name: 'DeepSeek V4 Pro（ultra 额度）', contextWindow: MONKEYCODE_MAX_CONTEXT },
    // 不带前缀的 = 直接扣积分（不走每日额度），与订阅档位无关。
    { id: 'deepseek-flash', name: 'DeepSeek Flash（按积分计费）', contextWindow: MONKEYCODE_MAX_CONTEXT },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash（按积分计费）', contextWindow: MONKEYCODE_MAX_CONTEXT },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro（按积分计费）', contextWindow: MONKEYCODE_MAX_CONTEXT },
    // ⚠️ `glm-5` **刻意不声明** `contextWindow`：它不是 deepseek，窗口与
    //    {@link MONKEYCODE_MAX_CONTEXT} 毫无关系，照抄就是谎报（且会把 DSH 的
    //    溢出压缩推迟到不可能达到的 token 数）。未知就省略。
    { id: 'glm-5', name: 'GLM-5（按积分计费）' },
];
/** 兜底目录（供适配器的 `loadCatalog` / `syncCatalog` 用）。 */
export function monkeycodeFallbackModels() {
    return MONKEYCODE_GATEWAY_MODELS;
}
/**
 * 每日额度的档位 → token 上限。
 *
 * ⚠️ 单位是**计费 token**（`(input + cache_read + 10 × output) × 1.5`），
 * 不是原始 token —— 拿它跟 `usage.input_tokens + usage.output_tokens` 比会
 * 得出完全错误的「还剩多少」（差 1.5~15 倍）。这是 SPEC §3 的实测口径。
 */
export const MONKEYCODE_PLAN_DAILY_LIMIT = {
    basic: 10_000_000,
    pro: 100_000_000,
    ultra: 300_000_000,
};
//# sourceMappingURL=monkeycode-product.js.map