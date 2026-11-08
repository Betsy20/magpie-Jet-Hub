/**
 * 百智云（BaiZhiCloud）产品配置与内置兜底模型表。
 *
 * **纯数据 + 纯常量，无副作用**：不读环境变量、不发网络请求、不写日志。
 * 单测可以直接 import 而不需要搭 cordis 运行时。
 *
 * 只记录**实测过**的事实：
 * - Anthropic 兼容端点 `https://ai-models.app.baizhi.cloud/api/anthropic/v1/messages`，
 *   头 `x-api-key` + `anthropic-version: 2023-06-01`，返回标准 Anthropic SSE；
 * - 凭据是**长期静态 Key**（无 refresh 端点、无 expires_at），与 MonkeyCode
 *   平台完全独立（独立账号、独立凭据、按量计费）；主站控制台另有积分体系，
 *   每日临时积分需过 Cap 验证码领取（见 `src/baizhi-credits.ts`）；
 * - 账号级上下文硬上限 1,048,576 tokens（400 原文
 *   `This model's maximum context length is 1048576 tokens`）；
 * - `max_tokens=100000` 实测可成功；
 * - 思考 `{type:'enabled', budget_tokens}` 生效、`{type:'disabled'}` 生效；
 *   顶层 `effort` 参数**无实际作用**（low/xhigh 各 2 次思考长度无差异）
 *   ⇒ 本产品**不暴露** effort 档位；
 * - 支持图片输入（Anthropic `image` 块 + `source.base64`，实测 1x1 PNG 能描述）。
 *
 * @module src/baizhi-product.ts
 */
/** 百智云（BaiZhiCloud）常量。 */
export const BAIZHI = {
    id: 'baizhi',
    displayName: '百智云',
    baseUrl: 'https://ai-models.app.baizhi.cloud/api/anthropic',
    messagesPath: '/v1/messages',
    modelsPath: '/v1/models',
    anthropicVersion: '2023-06-01',
    catalogTimeoutMs: 10_000,
    defaultCredentialRef: 'BAIZHI_ACCESS_TOKEN',
    platformBaseUrl: 'https://baizhi.cloud',
    walletBalancePath: '/api/v1/user/wallet/balance',
    walletUsagePath: '/api/v1/user/wallet/app-credit-usage',
    profilePath: '/api/v1/user/profile',
    dailyTemporaryCreditPath: '/api/v1/user/wallet/daily-temporary-credit',
    captchaChallengePath: '/api/v1/public/captcha/challenge',
    captchaRedeemPath: '/api/v1/public/captcha/redeem',
    consoleBaseUrl: 'https://ai-models.app.baizhi.cloud',
    consoleApiKeysPath: '/api/console/api-keys',
};
/**
 * 账号级上下文硬上限。
 *
 * 这是**服务级**硬上限（实测 400 原文 `This model's maximum context length is 1048576 tokens`），
 * 不是逐模型窗口；单条模型没实测过窗口时不要拿它冒充 per-model 窗口。
 */
export const BAIZHI_MAX_CONTEXT = 1_048_576;
/**
 * 单次输出上限的服务级默认值（`max_tokens=100000` 实测可成功）。
 *
 * ⚠️ 不是所有模型都吃这个值：qwen 系列有更低的上游硬限
 * （100,000 时 400 原文 `Range of max_tokens should be [1, 65536]` / `[1, 32768]`）。
 * 逐模型上限见 `BAIZHI_KNOWN_CAPABILITIES` 的 `maxTokens`，夹取用 `baizhiMaxOutputTokensFor`。
 */
export const BAIZHI_MAX_OUTPUT_TOKENS = 100_000;
/** qwen3.6-plus / qwen3.5-plus / qwen3.5-flash 的上游硬限（实测 65,536 可成功，100,000 被 400）。 */
export const BAIZHI_QWEN_MAX_OUTPUT_TOKENS = 65_536;
/** qwen-flash 的上游硬限（实测 32,768 可成功，100,000 被 400）。 */
export const BAIZHI_QWEN_FLASH_MAX_OUTPUT_TOKENS = 32_768;
/**
 * 已知模型能力表（**只写实测/明确知道的部分**）。
 *
 * 来源：`GET /api/anthropic/v1/models` 实测快照（45 个 id）中的这些 id。
 * 窗口只在**有实测证据**的 4 条 deepseek 上声明（值 `BAIZHI_MAX_CONTEXT`
 * = 1,048,576，与 `src/monkeycode-product.ts` 的 `MONKEYCODE_MAX_CONTEXT`
 * 同源同值 —— 都是「上游服务端 400 原文 `maximum context length is 1048576
 * tokens`」这条实测事实）；其余模型没有逐模型窗口证据 ⇒ 省略。
 *
 * ⚠️ 2026-11-02 审查修正：本注释原写「只在 `MONKEYCODE_BAIZHI_MODELS` 已声明过的
 *    那 4 条上重复声明」，而那个常量在拆站（白泽独立成 `baizhi` provider）时就
 *    删掉了 —— 照着找会扑空。
 *
 * `supportsImage` 同样保守：只有明确知道能看图的才写 true，
 * 其余省略 —— 适配器对「省略」的模型收到图片时会抛 `UNSUPPORTED_CONTENT`，
 * 不会静默丢图。
 *
 * `maxTokens` 的来源是 2026-11-07 对 `POST /v1/messages` 的**真机探测**
 * （账号 `BAIZHI_ACCOUNT_6E40BB58`，body 带 `stream:true` + 短消息，看到
 * `message_start` 即断开）：100,000 对 deepseek/minimax/glm/kimi 全部 200；
 * qwen 三兄弟 100,000 被 400（`[1, 65536]`）、65,536 通过；qwen-flash 上限 32,768。
 * 参数探测只证明「网关接受该值」；另对 deepseek-v4-flash 做了长文实测
 * （`max_tokens=20000` + 数数提示词）⇒ 实际 `output_tokens=20000`、
 * `stop_reason=max_tokens`，没有被静默夹到 8k/16k。没探测过的 id 一律省略。
 */
const BAIZHI_KNOWN_CAPABILITIES = [
    // deepseek 系列（4 条，窗口与 monkeycode-product.ts 保持一致）
    { id: 'deepseek-v4-pro', contextWindow: BAIZHI_MAX_CONTEXT, maxTokens: BAIZHI_MAX_OUTPUT_TOKENS },
    { id: 'deepseek-v4-flash', contextWindow: BAIZHI_MAX_CONTEXT, maxTokens: BAIZHI_MAX_OUTPUT_TOKENS },
    {
        id: 'deepseek-v4-flash-vision-exp',
        contextWindow: BAIZHI_MAX_CONTEXT,
        supportsImage: true,
        maxTokens: BAIZHI_MAX_OUTPUT_TOKENS,
    },
    { id: 'deepseek-flash', contextWindow: BAIZHI_MAX_CONTEXT, maxTokens: BAIZHI_MAX_OUTPUT_TOKENS },
    // 其余已知 id：窗口未知、是否支持图片未逐一实测 ⇒ 只列 id
    { id: 'minimax-m2.7', supportsImage: true, maxTokens: BAIZHI_MAX_OUTPUT_TOKENS },
    { id: 'minimax-m2.5', maxTokens: BAIZHI_MAX_OUTPUT_TOKENS },
    // 远端目录独有（不在 45 条快照里，但会话实测在用）；补进能力表才能下发 maxTokens。
    // ⚠️ 它**没有** `contextWindow`（无实测证据，不编）⇒ 宿主
    //    `dsh-compaction-basic` 在 `info.context === void 0` 时抛
    //    `TargetPressureConfigError`，被 `agent/pre-step` 吞成一条 warn ⇒
    //    **该模型的自动压缩是静默关闭的**。这是**已登记债务**，不是「忘了写」：
    //    编一个窗口（例如 1,048,576）会让它在 90 万 token 才压缩，比静默关闭更糟。
    //    同型条目见 `tests/unit/baizhi.spec.ts` 的「未声明 contextWindow」用例。
    { id: 'minimax-m3.1-flash', maxTokens: BAIZHI_MAX_OUTPUT_TOKENS },
    { id: 'glm-5.1', supportsImage: true, maxTokens: BAIZHI_MAX_OUTPUT_TOKENS },
    { id: 'glm-5', maxTokens: BAIZHI_MAX_OUTPUT_TOKENS },
    { id: 'glm-4.7', maxTokens: BAIZHI_MAX_OUTPUT_TOKENS },
    { id: 'kimi-k2.6', supportsImage: true, maxTokens: BAIZHI_MAX_OUTPUT_TOKENS },
    { id: 'kimi-k2.5', maxTokens: BAIZHI_MAX_OUTPUT_TOKENS },
    { id: 'qwen3.6-plus', maxTokens: BAIZHI_QWEN_MAX_OUTPUT_TOKENS },
    { id: 'qwen3.5-plus', supportsImage: true, maxTokens: BAIZHI_QWEN_MAX_OUTPUT_TOKENS },
    { id: 'qwen3.5-flash', maxTokens: BAIZHI_QWEN_MAX_OUTPUT_TOKENS },
    { id: 'qwen-flash', maxTokens: BAIZHI_QWEN_FLASH_MAX_OUTPUT_TOKENS },
];
/**
 * 内置兜底模型表（远端目录拉不到时用）。
 *
 * `name` 一律用 id：远端 `display_name` 拿不到时**不编**展示名，
 * 与 `parseBaizhiModelList` 的降级规则保持一致。
 */
export const BAIZHI_FALLBACK_MODELS = BAIZHI_KNOWN_CAPABILITIES.map((capability) => ({
    id: capability.id,
    name: capability.id,
    ...capability.contextWindow === undefined ? {} : { contextWindow: capability.contextWindow },
    ...capability.supportsImage === undefined ? {} : { supportsImage: capability.supportsImage },
    ...capability.maxTokens === undefined ? {} : { maxTokens: capability.maxTokens },
}));
/**
 * 查某个模型 id 的已知能力；未知 id 返回 `undefined`（**不要**返回空对象假装知道）。
 *
 * ⚠️ **大小写不敏感**（2026-11-08 审计实测的零守卫路径）：原实现是精确 `===`，
 *    上游若把 id 改成 `Qwen3.6-Plus`，能力表就查不到 ⇒
 *    `baizhiMaxOutputTokensFor('Qwen3.6-Plus')` 静默回落 100,000，
 *    而 qwen 的上游硬限是 65,536 ⇒ 用户手填大预算时**上游 400**。
 *    这里只**放宽**匹配（不改写 id 本身），不会让两个不同模型相撞。
 */
export function baizhiCapabilityOf(modelId) {
    const id = modelId.trim();
    if (id.length === 0)
        return undefined;
    const key = id.toLowerCase();
    const found = BAIZHI_KNOWN_CAPABILITIES.find((capability) => capability.id.toLowerCase() === key);
    if (found === undefined)
        return undefined;
    // 剥掉内部的 `id`：`BaizhiCapability` 只描述**能力**，身份由调用方手里的 id 表达。
    // 不剥的话返回的其实是「能力和 id 混在一起」的条目，调用方做深比较/序列化时会多出字段。
    return {
        ...found.contextWindow === undefined ? {} : { contextWindow: found.contextWindow },
        ...found.supportsImage === undefined ? {} : { supportsImage: found.supportsImage },
        ...found.maxTokens === undefined ? {} : { maxTokens: found.maxTokens },
    };
}
/**
 * 某个模型的单次输出上限（`max_tokens` 能用多大）。
 *
 * 已知模型走 `maxTokens`（实测值）；未知模型回落 `BAIZHI_MAX_OUTPUT_TOKENS`。
 * ⚠️ 必须按**模型**夹取，不能一律夹到 100,000 —— qwen 系列会被上游 400。
 */
export function baizhiMaxOutputTokensFor(modelId) {
    if (modelId === undefined)
        return BAIZHI_MAX_OUTPUT_TOKENS;
    return baizhiCapabilityOf(modelId)?.maxTokens ?? BAIZHI_MAX_OUTPUT_TOKENS;
}
/** 是否在已知清单里。 */
export function isKnownBaizhiModel(modelId) {
    return baizhiCapabilityOf(modelId) !== undefined;
}
/** 在兜底表里查模型条目。 */
export function findBaizhiFallback(modelId) {
    const id = modelId.trim();
    if (id.length === 0)
        return undefined;
    return BAIZHI_FALLBACK_MODELS.find((model) => model.id === id);
}
/**
 * 兜底表快照。
 *
 * 返回新数组而不是内部常量，避免调用方 `sort`/`push` 污染全局状态
 * （表格是模块级常量，被意外改写会影响所有测试）。
 */
export function baizhiFallbackModels() {
    return BAIZHI_FALLBACK_MODELS.map((model) => ({ ...model }));
}
//# sourceMappingURL=baizhi-product.js.map