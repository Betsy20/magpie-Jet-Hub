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
/** 单次输出上限（`max_tokens=100000` 实测可成功）。 */
export const BAIZHI_MAX_OUTPUT_TOKENS = 100_000;
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
 */
const BAIZHI_KNOWN_CAPABILITIES = [
    // deepseek 系列（4 条，窗口与 monkeycode-product.ts 保持一致）
    { id: 'deepseek-v4-pro', contextWindow: BAIZHI_MAX_CONTEXT },
    { id: 'deepseek-v4-flash', contextWindow: BAIZHI_MAX_CONTEXT },
    { id: 'deepseek-v4-flash-vision-exp', contextWindow: BAIZHI_MAX_CONTEXT, supportsImage: true },
    { id: 'deepseek-flash', contextWindow: BAIZHI_MAX_CONTEXT },
    // 其余已知 id：窗口未知、是否支持图片未逐一实测 ⇒ 只列 id
    { id: 'minimax-m2.7', supportsImage: true },
    { id: 'minimax-m2.5' },
    { id: 'glm-5.1', supportsImage: true },
    { id: 'glm-5' },
    { id: 'glm-4.7' },
    { id: 'kimi-k2.6', supportsImage: true },
    { id: 'kimi-k2.5' },
    { id: 'qwen3.6-plus' },
    { id: 'qwen3.5-plus', supportsImage: true },
    { id: 'qwen3.5-flash' },
    { id: 'qwen-flash' },
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
}));
/** 查某个模型 id 的已知能力；未知 id 返回 `undefined`（**不要**返回空对象假装知道）。 */
export function baizhiCapabilityOf(modelId) {
    const id = modelId.trim();
    if (id.length === 0)
        return undefined;
    const found = BAIZHI_KNOWN_CAPABILITIES.find((capability) => capability.id === id);
    if (found === undefined)
        return undefined;
    // 剥掉内部的 `id`：`BaizhiCapability` 只描述**能力**，身份由调用方手里的 id 表达。
    // 不剥的话返回的其实是「能力和 id 混在一起」的条目，调用方做深比较/序列化时会多出字段。
    return {
        ...found.contextWindow === undefined ? {} : { contextWindow: found.contextWindow },
        ...found.supportsImage === undefined ? {} : { supportsImage: found.supportsImage },
    };
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