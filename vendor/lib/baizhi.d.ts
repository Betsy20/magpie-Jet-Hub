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
import { type BaizhiModelEntry, type BaizhiProduct } from './baizhi-product.js';
/**
 * 百智云凭据。
 *
 * `access_token` 是长期静态 API Key（实测形如 `sk-` + 64 位，共 67 字符）。
 * `expires_at` 是**毫秒字符串**，但百智云本身不下发过期时间 ⇒ 通常不存在。
 */
export interface BaizhiCredential {
    access_token: string;
    nickname?: string;
    /** 毫秒时间戳字符串（秒级旧数据在 `baizhiCredentialExpiresAtMs` 里乘 1000 归一化）。 */
    expires_at?: string;
    /**
     * 百智云**控制台**的网页登录态（`sl-session` + `baizhi_session`，domain `baizhi.cloud`）。
     *
     * 与 `access_token` 是**两套凭据**：
     * - `access_token`（`sk-…`）只够调模型网关 `ai-models.app.baizhi.cloud`；
     * - 控制台接口（积分余额 `/api/v1/user/wallet/balance`、用量
     *   `/api/v1/user/wallet/app-credit-usage`、API Key 列表 `/api/v1/user/api-keys`）
     *   **只认 cookie**，用 `x-api-key` 一律 401。
     *
     * 所以「只有 sk- 的账号」能发消息但**查不到积分** —— 这与实测一致
     * （2026-11-02 用户截图：控制台钱包页有 235.05 积分，而网关侧没有任何余额接口）。
     */
    session_cookie?: string;
    /** 控制台用户 id（`/api/v1/user/profile` 的 `data.id`，数字）。 */
    user_id?: string;
}
/**
 * 把 `expires_at` 归一化成毫秒时间戳。
 *
 * 三段判定与 `qiniu.ts`/`monkeycode.ts` 完全一致（损失信息的地方只有一处，
 * 就是这里）：
 * 1. 非字符串 / 空串 ⇒ `undefined`；
 * 2. 非有限数 / ≤0 ⇒ `undefined`；
 * 3. `> 1e12` 视为已经是毫秒，否则视为秒并乘 1000。
 */
export declare function baizhiCredentialExpiresAtMs(credential: BaizhiCredential): number | undefined;
/**
 * 是否已过期。
 *
 * ⚠️ **没有 `expires_at` 时恒为 `false`**：静态 Key 没有过期时间，
 * 谎报「已过期」会让上游把它当失效凭据摘掉（qiniu/modelscope 同规则）。
 */
export declare function isBaizhiExpired(credential: BaizhiCredential): boolean;
/**
 * 是否存在刷新端点。
 *
 * 百智云只有长期静态 Key，没有 refresh 端点 ⇒ 恒 `false`。
 * **不要**实现「按有效期假装可续期」的逻辑。
 */
export declare function isBaizhiRefreshable(_credential?: BaizhiCredential): false;
/**
 * 凭据身份（用于在账号池里按凭据反查账号）。
 *
 * 返回 `''` 而不是 `undefined`：`syncAccountExpiry` 的 `identityOf` 要 string，
 * 且 `findAccountIdByCredential` 对 `''` 直接返回 `''`（视为查不到）。
 */
export declare function baizhiIdentityOf(credential: Pick<BaizhiCredential, 'access_token'> | undefined): string;
/**
 * 掩码显示 API Key。
 *
 * 与 `maskQiniuKey` 同口径：形状不像 Key 的一律返回 `''`（宁可不显示，
 * 也不要把一段乱码当 Key 展示），合法 Key 显示 `sk-a…wxyz`。
 */
export declare function maskBaizhiKey(apiKey: string): string;
/** Messages 端点 URL。 */
export declare function baizhiMessagesUrl(product?: BaizhiProduct): string;
/** 模型目录端点 URL。 */
export declare function baizhiModelsUrl(product?: BaizhiProduct): string;
/** `baizhiHeaders` 的选项。 */
export interface BaizhiHeaderOptions {
    /** 期望的响应类型。默认 `text/event-stream`（Messages 端点）。 */
    readonly accept?: 'application/json' | 'text/event-stream';
    readonly product?: BaizhiProduct;
}
/**
 * Anthropic 协议请求头。
 *
 * 百智云的 Anthropic 端点只认 `x-api-key`（**不是** `Authorization: Bearer`，
 * Bearer 是它另一条 OpenAI 兼容路由的鉴权方式）；`anthropic-version` 必须带。
 */
export declare function baizhiHeaders(credential: Pick<BaizhiCredential, 'access_token'>, options?: BaizhiHeaderOptions): Record<string, string>;
/** 模型 id 归一化：百智云的 id 大小写敏感，只去首尾空白，**不**改写大小写。 */
export declare function normalizeBaizhiModelId(raw: string): string;
/**
 * 解析 `GET /api/anthropic/v1/models` 的响应体。
 *
 * 远端只提供 `id` / `display_name` / `created_at`，没有任何能力字段 ⇒
 * 能力（窗口、图片）只从本地已知表补；**未知就不写**，不编 `contextWindow`，
 * 也不把「未知」写成「不支持图片」。
 *
 * 容错：非对象、`data` 非数组、元素缺 `id` ⇒ 跳过该条；`display_name` 为空 ⇒ 用 id。
 */
export declare function parseBaizhiModelList(raw: unknown): readonly BaizhiModelEntry[];
/** `fetchBaizhiModels` 的选项。 */
export interface FetchBaizhiModelsOptions {
    readonly product?: BaizhiProduct;
    readonly signal?: AbortSignal;
    readonly fetchImpl?: typeof fetch;
    /** 超时（毫秒）。默认取 `product.catalogTimeoutMs`（10s）。 */
    readonly timeoutMs?: number;
}
/**
 * 拉远端模型目录。
 *
 * 失败（非 2xx / 空目录）一律**抛错**，让调用方决定回退到内置兜底表 ——
 * 这里不吞错，否则「远端挂了」和「远端就是这 0 个模型」会混为一谈。
 */
export declare function fetchBaizhiModels(apiKey: string, options?: FetchBaizhiModelsOptions): Promise<readonly BaizhiModelEntry[]>;
/** 失败类别。命名与 `classifyModelscopeError`/`classifyMonkeycodeFailure` 对齐。 */
export type BaizhiFailureKind = 'auth' | 'rate_limit' | 'quota' | 'invalid_request' | 'server' | 'transport';
/** 分类结果。`detail` 保留**原文前若干字符**，便于报错与排查。 */
export interface BaizhiFailureInfo {
    readonly kind: BaizhiFailureKind;
    /** 上游 `Retry-After` 换算出的毫秒数（若有）。 */
    readonly retryAfterMs?: number;
    readonly detail: string;
}
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
export declare function classifyBaizhiError(status: number, body: string, retryAfterMs?: number): BaizhiFailureInfo;
/**
 * 把抛出来的错误（`LlmError` 带 `failure.status`，或裸 fetch 异常）归类。
 *
 * `LlmError` 的 `failure` 里带 `status` / `providerRetryAfterMs`；
 * 裸 `TypeError('fetch failed')` 之类没有 status ⇒ 落到 transport。
 */
export declare function classifyBaizhiFailure(error: unknown): BaizhiFailureInfo;
/**
 * 是否应该换下一个账号。
 *
 * `invalid_request`（400/422）是**请求本身**有问题，换号只会 4 次都失败并
 * 拖慢用户 —— 直接抛给 harness。
 */
export declare function shouldRotateBaizhiAccount(kind: BaizhiFailureKind): boolean;
/**
 * 是否应该往账号池写限流标记（`modelRateLimits[model] = resetAtMs`）。
 *
 * 只写 quota / rate_limit：auth 失败**不写**，否则用户改好 Key 后仍要等冷却
 * 才能用（qiniu/monkeycode 同规则）。
 */
export declare function recordsBaizhiRateLimit(kind: BaizhiFailureKind): boolean;
/** 冷却上限：30 分钟（避免上游 `Retry-After` 写个一天把账号锁死）。 */
export declare const BAIZHI_MAX_COOLDOWN_MS: number;
/**
 * 换号前应该把该账号-模型冷却多久。
 *
 * 1. 上游给了 `Retry-After` ⇒ 照它，但夹在 `[0, 30min]`；
 * 2. 额度耗尽 ⇒ 到 **UTC+8 次日 0 点**（与 `modelscope`/`account-pool` 同口径；
 *    百智云按量计费，余额补上后次日自然重试，不必永久拉黑）；
 * 3. 其它（限流）：1min × 2^(attempt-1)，上限 30min。
 */
export declare function baizhiRetryAfterMs(kind: BaizhiFailureKind, retryAfterMs: number | undefined, attempt: number, nowMs?: number): number;
/**
 * 是否是「上下文超长」错误。
 *
 * 实测原文：`This model's maximum context length is 1048576 tokens`。
 * 这类错误换号没用（账号级上限是同一个数），必须原样抛给 harness，
 * 让它把错误码升级成 `CONTEXT_WINDOW_EXCEEDED`。
 */
export declare function isBaizhiContextOverflow(detail: string): boolean;
//# sourceMappingURL=baizhi.d.ts.map