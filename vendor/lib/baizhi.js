/**
 * 百智云（BaiZhiCloud）纯函数层：凭据归一化、请求头、模型目录解析、失败分类。
 *
 * **无副作用**：不发请求、不碰 cordis、不写盘。网络访问只在
 * `fetchBaizhiModels()` 里，且可注入 `fetchImpl` 便于单测。
 *
 * 协议事实（实测）：
 * - `POST https://ai-models.app.baizhi.cloud/api/anthropic/v1/messages`
 *   头 `x-api-key: sk-…` + `anthropic-version: 2023-06-01`，返回标准 Anthropic SSE；
 * - `GET …/api/anthropic/v1/models` ⇒ `{"data":[{"id":"deepseek-v4-pro","type":"model",
 *   "display_name":"…","created_at":"…"}]}`（实测 45 个 id）；
 * - 凭据是**长期静态 Key**（无 refresh 端点、无 `expires_at`）⇒ 与 `qiniu`/`modelscope` 同型。
 *
 * @module src/baizhi.ts
 */
import { isContextWindowExceededError } from '@deepseek-ai/dsh-llm';
import { nextUtc8DayStartMs } from './model-queue.js';
import { isTransportError } from './openai-compat.js';
import { BAIZHI, baizhiCapabilityOf, } from './baizhi-product.js';
/**
 * 把 `expires_at` 归一化成毫秒时间戳。
 *
 * 三段判定与 `qiniu.ts`/`monkeycode.ts` 完全一致（损失信息的地方只有一处，
 * 就是这里）：
 * 1. 非字符串 / 空串 ⇒ `undefined`；
 * 2. 非有限数 / ≤0 ⇒ `undefined`；
 * 3. `> 1e12` 视为已经是毫秒，否则视为秒并乘 1000。
 */
export function baizhiCredentialExpiresAtMs(credential) {
    const raw = credential.expires_at;
    if (typeof raw !== 'string' || raw.length === 0)
        return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return undefined;
    return parsed > 1e12 ? parsed : parsed * 1000;
}
/**
 * 是否已过期。
 *
 * ⚠️ **没有 `expires_at` 时恒为 `false`**：静态 Key 没有过期时间，
 * 谎报「已过期」会让上游把它当失效凭据摘掉（qiniu/modelscope 同规则）。
 */
export function isBaizhiExpired(credential) {
    const expiresAt = baizhiCredentialExpiresAtMs(credential);
    if (expiresAt === undefined)
        return false;
    return expiresAt <= Date.now();
}
/**
 * 是否存在刷新端点。
 *
 * 百智云只有长期静态 Key，没有 refresh 端点 ⇒ 恒 `false`。
 * **不要**实现「按有效期假装可续期」的逻辑。
 */
export function isBaizhiRefreshable(_credential) {
    return false;
}
/**
 * 凭据身份（用于在账号池里按凭据反查账号）。
 *
 * 返回 `''` 而不是 `undefined`：`syncAccountExpiry` 的 `identityOf` 要 string，
 * 且 `findAccountIdByCredential` 对 `''` 直接返回 `''`（视为查不到）。
 */
export function baizhiIdentityOf(credential) {
    const token = credential?.access_token;
    return typeof token === 'string' ? token : '';
}
/**
 * 掩码显示 API Key。
 *
 * 与 `maskQiniuKey` 同口径：形状不像 Key 的一律返回 `''`（宁可不显示，
 * 也不要把一段乱码当 Key 展示），合法 Key 显示 `sk-a…wxyz`。
 */
export function maskBaizhiKey(apiKey) {
    if (typeof apiKey !== 'string')
        return '';
    const trimmed = apiKey.trim();
    if (!/^[A-Za-z0-9_.-]{16,}$/.test(trimmed))
        return '';
    return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}
/** Messages 端点 URL。 */
export function baizhiMessagesUrl(product = BAIZHI) {
    return `${product.baseUrl}${product.messagesPath}`;
}
/** 模型目录端点 URL。 */
export function baizhiModelsUrl(product = BAIZHI) {
    return `${product.baseUrl}${product.modelsPath}`;
}
/**
 * Anthropic 协议请求头。
 *
 * 百智云的 Anthropic 端点只认 `x-api-key`（**不是** `Authorization: Bearer`，
 * Bearer 是它另一条 OpenAI 兼容路由的鉴权方式）；`anthropic-version` 必须带。
 */
export function baizhiHeaders(credential, options = {}) {
    const product = options.product ?? BAIZHI;
    return {
        'content-type': 'application/json',
        accept: options.accept ?? 'text/event-stream',
        'anthropic-version': product.anthropicVersion,
        'x-api-key': credential.access_token,
    };
}
/** 模型 id 归一化：百智云的 id 大小写敏感，只去首尾空白，**不**改写大小写。 */
export function normalizeBaizhiModelId(raw) {
    return raw.trim();
}
/**
 * 解析 `GET /api/anthropic/v1/models` 的响应体。
 *
 * 远端只提供 `id` / `display_name` / `created_at`，没有任何能力字段 ⇒
 * 能力（窗口、图片）只从本地已知表补；**未知就不写**，不编 `contextWindow`，
 * 也不把「未知」写成「不支持图片」。
 *
 * 容错：非对象、`data` 非数组、元素缺 `id` ⇒ 跳过该条；`display_name` 为空 ⇒ 用 id。
 */
export function parseBaizhiModelList(raw) {
    if (typeof raw !== 'object' || raw === null)
        return [];
    const data = raw.data;
    if (!Array.isArray(data))
        return [];
    const models = [];
    const seen = new Set();
    for (const item of data) {
        if (typeof item !== 'object' || item === null)
            continue;
        const record = item;
        if (typeof record.id !== 'string')
            continue;
        const id = normalizeBaizhiModelId(record.id);
        if (id.length === 0 || seen.has(id))
            continue;
        seen.add(id);
        const displayName = typeof record.display_name === 'string' ? record.display_name.trim() : '';
        const capability = baizhiCapabilityOf(id);
        const contextWindow = capability?.contextWindow;
        const supportsImage = capability?.supportsImage;
        models.push({
            id,
            name: displayName.length > 0 ? displayName : id,
            ...contextWindow === undefined ? {} : { contextWindow },
            ...supportsImage === undefined ? {} : { supportsImage },
        });
    }
    return models;
}
/**
 * 拉远端模型目录。
 *
 * 失败（非 2xx / 空目录）一律**抛错**，让调用方决定回退到内置兜底表 ——
 * 这里不吞错，否则「远端挂了」和「远端就是这 0 个模型」会混为一谈。
 */
export async function fetchBaizhiModels(apiKey, options = {}) {
    const product = options.product ?? BAIZHI;
    const fetchImpl = options.fetchImpl ?? fetch;
    const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? product.catalogTimeoutMs);
    const response = await fetchImpl(baizhiModelsUrl(product), {
        method: 'GET',
        headers: baizhiHeaders({ access_token: apiKey }, { accept: 'application/json', product }),
        signal,
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`baizhi: 模型目录请求失败（HTTP ${response.status}）${detail === '' ? '' : `：${detail.slice(0, 300)}`}`);
    }
    const models = parseBaizhiModelList(await response.json());
    if (models.length === 0)
        throw new Error('baizhi: 模型目录为空');
    return models;
}
const RATE_LIMIT_WORDING = ['rate limit', 'too many requests', 'ratelimit', 'throttl', '限流', '请求过于频繁'];
const QUOTA_WORDING = ['quota', 'insufficient', '余额', '额度', '积分', '欠费', 'balance', 'arrears'];
const AUTH_WORDING = ['invalid api key', 'invalid x-api-key', 'unauthorized', 'authentication', '鉴权', '未授权'];
/**
 * 按 HTTP 状态（附文案兜底）给失败分类。
 *
 * 判定顺序与仓库其它 provider 一致：**状态码优先**，状态码表达不出语义时
 * （200 带回 JSON 错误体、404、状态 0）再看文案。
 *
 * | 状态 | 类别 | 换号 | 写限流标记 |
 * | --- | --- | --- | --- |
 * | 401/403 | auth | ✓ | ✗ |
 * | 402 | quota | ✓ | ✓ |
 * | 429 | rate_limit | ✓ | ✓ |
 * | 400/422 | invalid_request | ✗ | ✗ |
 * | ≥500 | server | ✓ | ✗ |
 * | 0（fetch 抛错） | transport | ✓ | ✗ |
 */
export function classifyBaizhiError(status, body, retryAfterMs) {
    const detail = body.trim();
    const withRetry = retryAfterMs === undefined ? {} : { retryAfterMs };
    if (status === 401 || status === 403)
        return { kind: 'auth', detail, ...withRetry };
    if (status === 402)
        return { kind: 'quota', detail, ...withRetry };
    if (status === 429)
        return { kind: 'rate_limit', detail, ...withRetry };
    if (status === 400 || status === 422)
        return { kind: 'invalid_request', detail, ...withRetry };
    if (status >= 500)
        return { kind: 'server', detail, ...withRetry };
    if (status === 0)
        return { kind: 'transport', detail, ...withRetry };
    // 状态码 2xx/3xx/404 等：看文案（Anthropic 协议偶尔把错误塞进 200 的 JSON 体）
    const wording = classifyBaizhiWording(detail, retryAfterMs);
    if (wording !== undefined)
        return wording;
    // 404/405 等：换号也没用，直接当不可重试的坏请求
    return { kind: 'invalid_request', detail, ...withRetry };
}
/** 只按响应原文判断类别；判断不出返回 `undefined`。 */
function classifyBaizhiWording(detail, retryAfterMs) {
    const lower = detail.toLowerCase();
    const withRetry = retryAfterMs === undefined ? {} : { retryAfterMs };
    if (RATE_LIMIT_WORDING.some((word) => lower.includes(word)))
        return { kind: 'rate_limit', detail, ...withRetry };
    if (QUOTA_WORDING.some((word) => lower.includes(word)))
        return { kind: 'quota', detail, ...withRetry };
    if (AUTH_WORDING.some((word) => lower.includes(word)))
        return { kind: 'auth', detail, ...withRetry };
    if (isBaizhiContextOverflow(detail))
        return { kind: 'invalid_request', detail, ...withRetry };
    return undefined;
}
/**
 * 把抛出来的错误（`LlmError` 带 `failure.status`，或裸 fetch 异常）归类。
 *
 * `LlmError` 的 `failure` 里带 `status` / `providerRetryAfterMs`；
 * 裸 `TypeError('fetch failed')` 之类没有 status ⇒ 落到 transport。
 */
export function classifyBaizhiFailure(error) {
    const failure = error
        ?.failure;
    const status = typeof failure?.status === 'number' ? failure.status : undefined;
    const retryAfterMs = typeof failure?.providerRetryAfterMs === 'number' ? failure.providerRetryAfterMs : undefined;
    const detail = error instanceof Error ? error.message : String(error);
    if (status !== undefined)
        return classifyBaizhiError(status, detail, retryAfterMs);
    // 没有状态码：先看文案（流内 error 帧就是这样，比如 Anthropic 的
    // `event: error` 里塞一个额度用尽），再看是不是网络层错误。
    const wording = classifyBaizhiWording(detail, retryAfterMs);
    if (wording !== undefined)
        return wording;
    const withRetry = retryAfterMs === undefined ? {} : { retryAfterMs };
    return { kind: isTransportError(error) ? 'transport' : 'server', detail, ...withRetry };
}
/**
 * 是否应该换下一个账号。
 *
 * `invalid_request`（400/422）是**请求本身**有问题，换号只会 4 次都失败并
 * 拖慢用户 —— 直接抛给 harness。
 */
export function shouldRotateBaizhiAccount(kind) {
    return kind !== 'invalid_request';
}
/**
 * 是否应该往账号池写限流标记（`modelRateLimits[model] = resetAtMs`）。
 *
 * 只写 quota / rate_limit：auth 失败**不写**，否则用户改好 Key 后仍要等冷却
 * 才能用（qiniu/monkeycode 同规则）。
 */
export function recordsBaizhiRateLimit(kind) {
    return kind === 'quota' || kind === 'rate_limit';
}
/** 冷却上限：30 分钟（避免上游 `Retry-After` 写个一天把账号锁死）。 */
export const BAIZHI_MAX_COOLDOWN_MS = 30 * 60_000;
/**
 * 换号前应该把该账号-模型冷却多久。
 *
 * 1. 上游给了 `Retry-After` ⇒ 照它，但夹在 `[0, 30min]`；
 * 2. 额度耗尽 ⇒ 到 **UTC+8 次日 0 点**（与 `modelscope`/`account-pool` 同口径；
 *    百智云按量计费，余额补上后次日自然重试，不必永久拉黑）；
 * 3. 其它（限流）：1min × 2^(attempt-1)，上限 30min。
 */
export function baizhiRetryAfterMs(kind, retryAfterMs, attempt, nowMs = Date.now()) {
    if (retryAfterMs !== undefined)
        return Math.max(0, Math.min(retryAfterMs, BAIZHI_MAX_COOLDOWN_MS));
    if (kind === 'quota')
        return Math.max(0, nextUtc8DayStartMs(nowMs) - nowMs);
    const exponent = Math.max(0, attempt - 1);
    return Math.min(60_000 * 2 ** exponent, BAIZHI_MAX_COOLDOWN_MS);
}
/**
 * 是否是「上下文超长」错误。
 *
 * 实测原文：`This model's maximum context length is 1048576 tokens`。
 * 这类错误换号没用（账号级上限是同一个数），必须原样抛给 harness，
 * 让它把错误码升级成 `CONTEXT_WINDOW_EXCEEDED`。
 */
export function isBaizhiContextOverflow(detail) {
    if (isContextWindowExceededError(detail))
        return true;
    return /context (?:length|window)|maximum context|上下文(?:长度|窗口|超长)/i.test(detail);
}
//# sourceMappingURL=baizhi.js.map