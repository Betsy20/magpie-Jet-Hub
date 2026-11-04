/**
 * 百智云（BaiZhiCloud）模型适配器。
 *
 * 走 **Anthropic Messages** 协议（请求体构造与 SSE 消费在
 * `src/baizhi-messages.ts`，协议实现**复用** `src/minimax-messages.ts`）。
 *
 * ## 与 modelscope 同型：静态 Key，**没有 refresh 重试**
 *
 * 百智云凭据是长期静态 `sk-` Key（无 refresh 端点、无 `expires_at`）。
 * 401 只意味着「Key 错了/被吊销」，重取一次还是同一份字符串 ——
 * 换号重试没有意义，只有**换号**（池里另一个账号）有意义。
 *
 * ## 目录：远端 45 条 + 内置兜底表
 *
 * `GET /api/anthropic/v1/models` 实测可用（45 个 id），但只给
 * `id`/`display_name`/`created_at`，没有能力字段 ⇒ 窗口/图片能力从
 * `src/baizhi-product.ts` 的已知表补，**未知就不写**。
 * 远端失败（含 10s 超时）⇒ 回退内置兜底表（至少 12 条实测 id）。
 * `listAllModels()` 契约要求**同步**返回，故走 `ModelCatalog` 的缓存快照。
 *
 * ## 失败分类（见 `classifyBaizhiError` 的表）
 *
 * | 类别 | 换号 | 写冷却 |
 * | --- | --- | --- |
 * | auth 401/403 | ✓ | ✗ |
 * | rate_limit 429 | ✓ | ✓（60s 起指数退避，封顶 30 分钟） |
 * | quota 402 | ✓ | ✓（到 UTC+8 次日 0 点） |
 * | server 5xx / transport | ✓ | ✗ |
 * | invalid_request 400/422 | ✗（直接抛 BAD_REQUEST） | ✗ |
 *
 * 已经向调用方产出过任何块之后**不再换号**（`yieldedAny`，重发会造成重复输出）。
 *
 * @module src/baizhi-adapter.ts
 */
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import { createModelCatalog, isCatalogFresh, isCatalogFreshFor, } from './model-catalog.js';
import { RemoteCatalogGate } from './remote-catalog-gate.js';
import { broadcastCatalogChanged } from './catalog-broadcast.js';
import { collectImages } from './openai-compat.js';
import { isAbortLike } from './aggregate-adapter.js';
import { registerAdapterIdempotent } from './llm-register-compat.js';
import { retryAfterMsFromResponse } from './retry-after.js';
import { reportLedgerAccount } from './token-ledger.js';
import { BAIZHI, baizhiFallbackModels, } from './baizhi-product.js';
import { baizhiHeaders, baizhiMessagesUrl, baizhiRetryAfterMs, classifyBaizhiError, classifyBaizhiFailure, fetchBaizhiModels, isBaizhiContextOverflow, recordsBaizhiRateLimit, shouldRotateBaizhiAccount, } from './baizhi.js';
import { baizhiMaxTokensFor, baizhiThinkingFor, buildBaizhiMessagesPayload, consumeBaizhiSse, } from './baizhi-messages.js';
/** 单次请求允许最多换几个账号（防止池里 20 个坏 Key 时打满上游）。 */
export const BAIZHI_MAX_ROTATE = 4;
/**
 * 百智云适配器。
 *
 * ⚠️ 与 minimax 的差别：**没有 refresh 重试**。静态 Key 出错只需换号，
 * 不需要「续期再试一次」。
 */
export class BaizhiAdapter extends LlmAdapter {
    options;
    product;
    /** 上次成功拉到的远端目录（`undefined` = 还没成功过）。 */
    remoteModels;
    /** 上次成功拉到目录的时刻（毫秒）。 */
    catalogAt = 0;
    catalogGate;
    catalog;
    constructor(options) {
        super();
        this.options = options;
        this.product = options.product ?? BAIZHI;
        this.catalogGate = new RemoteCatalogGate(options.onCatalogLoaded === undefined ? {} : { onLoaded: options.onCatalogLoaded });
        this.catalog = createModelCatalog({ ...options.accountPool === undefined ? {} : { accountPool: options.accountPool } }, {
            product: this.product,
            loadCatalog: () => this.loadCatalogEntries(),
            syncCatalog: () => this.syncCatalogEntries(),
            // ⚠️ **刻意不提供 `unknownModelInputModalities`**：
            // 百智云实测支持图片（Anthropic `image` 块），但「哪些模型能看图」只对少数
            // 几个明确知道。给未知模型谎报 `['text']` 会把图片能力**静默关掉**；
            // 省略 = 「未知」⇒ DSH 放行图片，由 `inlineImages` 在真收到图片时抛
            // `UNSUPPORTED_CONTENT`（不静默丢图）。
            refresh: async () => {
                this.catalogAt = 0;
                await this.loadModels();
            },
        });
    }
    providerInfo(provider) {
        const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id;
        return { id, name: this.product.displayName };
    }
    /**
     * ★ 后台目录刷新器入口（`index.ts` 的 `refreshOf` 调 `adapter.refresh?.()`）。
     *
     * ⚠️ 必须**显式转发** `catalog.refresh`：`ModelCatalog` 的成员不会自动变成
     * 适配器的成员（`pruned()` 的 Proxy 只透传适配器自己的成员）。
     * 漏转发 ⇒ 刷新器「已武装」却对这家**空转**，且零日志。
     */
    async refresh() {
        await this.catalog.refresh?.();
    }
    /** 完整目录（**不套黑名单**），供 Jet Hub「显示列表」用。**必须同步**。 */
    listAllModels() {
        return this.catalog.listAllModels();
    }
    async listModels(provider) {
        return this.catalog.listModels(provider);
    }
    async resolveModel(provider, model, signal) {
        return this.catalog.resolveModel(provider, model, signal);
    }
    /**
     * 兼容 0.1.1-rc.2 的 `prepareCall` shim。
     *
     * ⚠️ **必须包装**（不能只实现 `stream`）：harness 的生产路径走 `prepareCall`，
     * 只在 `stream` 里做的校验在测试里可以看到、在生产里永远不生效。
     */
    async prepareCall(provider, model, signal) {
        return {
            model: await this.resolveModel(provider, model, signal),
            stream: (options) => this.stream(options),
        };
    }
    /**
     * 取目录：远端优先、失败回退内置兜底表。
     *
     * 与 monkeycode 不同，百智云**有**可用的远端目录，所以保留完整的
     * 「缓存 → `RemoteCatalogGate` → 新鲜度判断 → 兜底」链路。
     */
    async loadModels() {
        const now = this.options.now?.() ?? Date.now();
        if (this.remoteModels !== undefined && isCatalogFreshFor(this.product.id, this.catalogAt, now)) {
            return this.remoteModels;
        }
        const fetchRemote = this.options.fetchRemoteModels ?? this.fetchRemoteModelsDefault;
        await this.catalogGate.run(async () => {
            const slots = await this.options.slots();
            const slot = slots[0];
            if (slot === undefined)
                return false;
            const fetched = await fetchRemote(slot.apiKey);
            // ⚠️ 空目录视为**失败**：否则一次可疑的空响应会把兜底表清空，
            // 面板会显示「已关闭且无模型可关」。
            if (fetched.length === 0)
                return false;
            this.remoteModels = fetched;
            this.catalogAt = this.options.now?.() ?? Date.now();
            return true;
        });
        if (this.remoteModels !== undefined && isCatalogFresh(this.catalogAt, this.options.now?.() ?? Date.now())) {
            return this.remoteModels;
        }
        return baizhiFallbackModels();
    }
    /** 默认远端目录拉取（10s 超时，见 `BAIZHI.catalogTimeoutMs`）。 */
    fetchRemoteModelsDefault = (apiKey, signal) => fetchBaizhiModels(apiKey, {
        product: this.product,
        ...signal === undefined ? {} : { signal },
        ...this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl },
    });
    /**
     * 发一次流式请求。
     *
     * 结构：**逐账号尝试** → 失败分类 → 可换号则下一个 → 全失败抛错。
     * 已经产出过任何块之后**不再换号**（重发会造成重复输出）。
     */
    async *stream(options) {
        const slots = await this.options.slots(options.model);
        if (slots.length === 0) {
            throw new LlmError('百智云：还没有可用的 API Key。请在 Jet Hub 的「百智云」面板粘贴一个 sk- 开头的 Key。', 'MISSING_CREDENTIAL');
        }
        // ⚠️ 目录与图片判定的先后：**先拿到能力条目再读图字节**，
        // 否则一次「模型不支持图片」的请求会先把所有附件读进内存再抛错。
        const entry = (await this.loadModels()).find((model) => model.id === options.model);
        const images = await this.inlineImages(options, entry);
        const maxTokens = baizhiMaxTokensFor(options.maxTokens);
        /**
         * 思考配置。
         *
         * ⚠️ 会话自动命名（`purpose: 'session-title'`）**强制关掉思考**：
         * DSH 用 ~64 token 发标题请求，若服务端默认思考会把预算吃满、正文 0 字符
         * ⇒ 标题永远停在 fallback（issue IKKVDH 的同一形态）。
         */
        const thinking = options.purpose === 'session-title'
            ? { type: 'disabled' }
            : baizhiThinkingFor(options.reasoningEffort, maxTokens);
        const payload = buildBaizhiMessagesPayload({
            model: options.model,
            messages: options.messages,
            maxTokens,
            ...options.system === undefined ? {} : { system: options.system },
            ...options.tools === undefined ? {} : { tools: options.tools },
            ...options.temperature === undefined ? {} : { temperature: options.temperature },
            ...options.stop === undefined ? {} : { stop: options.stop },
            ...thinking === undefined ? {} : { thinking },
            ...images === undefined ? {} : { images },
        });
        // ⚠️ 序列化**一次**、所有账号共用（body 与账号无关）。
        const body = JSON.stringify(payload);
        let lastError;
        let lastInfo;
        let lastStatus = 0;
        /** 是否已经向调用方产出过块 —— 产出过就**不能**再换号重发。 */
        let yieldedAny = false;
        const tried = new Set();
        for (const slot of slots) {
            if (tried.has(slot.id))
                continue;
            tried.add(slot.id);
            if (tried.size > BAIZHI_MAX_ROTATE)
                break;
            reportLedgerAccount(this.product.id, slot.id);
            let response;
            try {
                response = await this.send(slot, body, options);
            }
            catch (error) {
                // ⚠️ 用户主动中止：原样抛，不当成「账号坏了」（否则会白写冷却）。
                if (options.signal?.aborted === true || isAbortLike(error))
                    throw error;
                lastError = error;
                lastInfo = classifyBaizhiFailure(error);
                this.warn(`[baizhi] 账号 ${slot.id} 请求失败：${describeError(error)}（${lastInfo.kind}）`);
                continue;
            }
            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                const retryAfterMs = retryAfterMsFromResponse(response.headers);
                const info = classifyBaizhiError(response.status, errorText, retryAfterMs);
                lastStatus = response.status;
                lastInfo = info;
                lastError = new LlmError(`百智云：HTTP ${response.status}${errorText === '' ? '' : ` — ${errorText.slice(0, 500)}`}`, baizhiErrorCode(info), {
                    status: response.status,
                    ...retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs },
                });
                this.warn(`[baizhi] 账号 ${slot.id} 返回 HTTP ${response.status}（${info.kind}）：${errorText.slice(0, 200)}`);
                // ⚠️ invalid_request（400/422）是请求本身的问题，换号只会 4 次都失败并
                // 拖慢用户 ⇒ 直接抛。
                if (!shouldRotateBaizhiAccount(info.kind))
                    throw lastError;
                await this.markLimited(slot, info, options.model, tried.size);
                continue;
            }
            // ⚠️ 200 但不是 SSE：上游偶尔回一段 JSON 错误体（配额/签名/模型不存在）。
            // 用 INVALID_REQUEST 而不是 SERVER（后者会被 dsh-llm-retry 自动重试 5 次）。
            const contentType = response.headers.get('content-type') ?? '';
            if (!contentType.includes('text/event-stream')) {
                const errorText = await response.text().catch(() => '');
                const info = classifyBaizhiError(response.status, errorText);
                lastStatus = response.status;
                lastInfo = info;
                lastError = new LlmError(`百智云：推理端点返回了非 SSE 响应（HTTP ${response.status}）：${errorText.slice(0, 500)}`, isBaizhiContextOverflow(info.detail) ? CONTEXT_WINDOW_EXCEEDED_CODE : 'INVALID_REQUEST', { status: response.status });
                this.warn(`[baizhi] 账号 ${slot.id} 返回非 SSE 响应（${info.kind}）`);
                if (!shouldRotateBaizhiAccount(info.kind))
                    throw lastError;
                await this.markLimited(slot, info, options.model, tried.size);
                continue;
            }
            if (response.body === null) {
                lastError = new LlmError('百智云：响应缺少 body', 'EMPTY_RESPONSE');
                lastInfo = undefined;
                continue;
            }
            try {
                for await (const chunk of consumeBaizhiSse({
                    body: response.body,
                    ...options.signal === undefined ? {} : { signal: options.signal },
                })) {
                    yieldedAny = true;
                    yield chunk;
                }
                return;
            }
            catch (error) {
                if (options.signal?.aborted === true || isAbortLike(error))
                    throw error;
                lastError = error;
                lastInfo = classifyBaizhiFailure(error);
                /**
                 * ⚠️⚠️ 冷却与告警必须排在 `yieldedAny` 判断**之前**（2026-11-02 三审 F🔴-1）。
                 *
                 * 原先这里是 `if (yieldedAny) throw error` 在最前面、`markLimited` 在最后 ⇒
                 * 用户已经看到部分输出、随后账号撞额度/限流（长回答最可能发生）时，
                 * 那个号**连冷却都不写**，下一轮仍被优先选中、继续撞墙。
                 * `monkeycode-adapter.ts` 早就把顺序摆正了（注释逐字写着「『不重发』只约束
                 * 重试，不约束记账」），两个实现写在不同轮次 ⇒ 语义分叉。
                 *
                 * 「不重发」这条不变量只约束**重试**（下面那句 throw），不约束记账。
                 */
                // 流内错误若其实是额度/限流（`event: error` 帧），照样记冷却。
                if (lastInfo !== undefined)
                    await this.markLimited(slot, lastInfo, options.model, tried.size);
                this.warn(`[baizhi] 账号 ${slot.id} 流式消费失败：${describeError(error)}（${lastInfo.kind}）`);
                // ⚠️ 已经产出过块：**原样抛**，不换号重发（会造成重复输出）。
                if (yieldedAny)
                    throw error;
            }
        }
        // 全部账号都失败：把「最后一类失败」翻译成对外错误码。
        if (lastError !== undefined) {
            const kind = lastInfo?.kind;
            if (kind === 'quota' || kind === 'rate_limit' || kind === 'auth') {
                const code = kind === 'rate_limit' ? 'RATE_LIMIT' : kind === 'auth' ? 'AUTH' : 'QUOTA_EXCEEDED';
                throw new LlmError(`百智云：模型 ${options.model} 所有账号均不可用（${kind}）：${describeError(lastError)}`, code, lastStatus === 0 ? {} : { status: lastStatus });
            }
            throw lastError;
        }
        throw new LlmError(`百智云：模型 ${options.model} 没有可用账号`, 'MISSING_CREDENTIAL');
    }
    /** 用某个账号发一次请求。 */
    async send(slot, body, options) {
        const fetcher = this.options.fetchImpl ?? fetch;
        return fetcher(baizhiMessagesUrl(this.product), {
            method: 'POST',
            headers: baizhiHeaders({ access_token: slot.apiKey }, { accept: 'text/event-stream', product: this.product }),
            body,
            ...options.signal === undefined ? {} : { signal: options.signal },
        });
    }
    /**
     * 给失败账号写模型级冷却（`auth` 不写，见 `recordsBaizhiRateLimit`）。
     *
     * 优先用**注入的** `markLimited`（仅单测注入），没有就回退到
     * 直接调 `accountPool.updateModelRateLimit`。
     *
     * ⚠️ 2026-11-02 四审自查：本处原写「`index.ts` 用它写账号池」——
     * 实际生产工厂只传 `accountPool`（见 `src/index.ts` 的 baizhi 工厂），
     * 运行期**恒走回退分支**。两条路必须幂等。
     */
    async markLimited(slot, info, modelId, attempt) {
        if (!recordsBaizhiRateLimit(info.kind))
            return;
        const now = this.options.now?.() ?? Date.now();
        // ⚠️ `attempt` 用「已试账号数+1」而不是固定的 1：池里多个账号连续 429 时
        // 后一个账号的冷却应该更长，否则会以同样节奏继续撞墙。
        const resetAtMs = now + baizhiRetryAfterMs(info.kind, info.retryAfterMs, attempt, now);
        try {
            if (this.options.markLimited !== undefined) {
                await this.options.markLimited(slot.id, modelId, resetAtMs);
                return;
            }
            const pool = this.options.accountPool;
            if (pool === undefined)
                return;
            await pool.updateModelRateLimit(slot.id, modelId, resetAtMs);
        }
        catch (error) {
            // 冷却写失败不该把「已经失败的请求」变成另一种失败原因。
            this.warn(`[baizhi] 写冷却失败：${describeError(error)}`);
        }
    }
    /**
     * 内联图片。
     *
     * ⚠️ 顺序很重要：**先判模型是否支持，再读字节**（见 `stream` 里的注释）。
     *
     * ⚠️ 不支持时**显式抛 `UNSUPPORTED_CONTENT`**，不静默丢图：静默丢弃会让
     * 用户以为图片被模型看到了（本仓库铁律）。
     */
    async inlineImages(options, entry) {
        const refs = new Map();
        for (const message of options.messages) {
            if (Array.isArray(message.content))
                collectImages(message.content, refs);
        }
        if (refs.size === 0)
            return undefined;
        if (entry?.supportsImage !== true) {
            throw new LlmError(`百智云：模型 "${options.model}" 不支持图片输入（能力未知时不冒险丢图）`, 'UNSUPPORTED_CONTENT');
        }
        if (this.options.readImage === undefined) {
            throw new LlmError('百智云：图片输入需要附件服务（readImage 未提供）', 'UNSUPPORTED_CONTENT');
        }
        const readImage = this.options.readImage;
        const images = new Map();
        for (const [id, ref] of refs) {
            const inline = await readImage(ref);
            if (inline === undefined)
                continue;
            // ⚠️ Anthropic 的 `source.data` 要**裸 base64**（不带 `data:…;base64,` 前缀）。
            images.set(id, {
                mediaType: inline.mediaType,
                data: Buffer.from(inline.data).toString('base64'),
            });
        }
        return images;
    }
    toCatalogEntry(model) {
        return {
            id: model.id,
            name: model.name,
            // ⚠️ 省略 `inputModalities` = 「未知」（不是「明确不支持」）。
            // 写 `['text']` 会把图片能力**静默关掉**；两种语义在 DSH 侧不同。
            ...model.supportsImage === true ? { inputModalities: ['text', 'image'] } : {},
            ...model.contextWindow !== undefined && model.contextWindow > 0
                ? { contextWindow: model.contextWindow }
                : {},
        };
    }
    async loadCatalogEntries() {
        const all = await this.loadModels();
        return all.map((model) => this.toCatalogEntry(model));
    }
    syncCatalogEntries() {
        return baizhiFallbackModels().map((model) => this.toCatalogEntry(model));
    }
    /**
     * 记一条警告。
     *
     * ⚠️ 适配器**不自带 logger**（选项里没有 `ctx`）：`warn` 由
     * `registerBaizhiLlm` 注入；单测里不注入时**静默**。
     */
    warn(message) {
        this.options.warn?.(message);
    }
}
/**
 * 失败类别 → 对外错误码（沿用本仓既有字面量，**不要**发明新码）。
 *
 * `dsh-llm-retry` 的 `DEFAULT_RETRYABLE_CODES` 含 `SERVER`/`RATE_LIMIT` 一类，
 * 所以「不该重试」的错误绝不能报成 `SERVER`。
 */
function baizhiErrorCode(info) {
    switch (info.kind) {
        case 'quota':
            return 'QUOTA_EXCEEDED';
        case 'rate_limit':
            return 'RATE_LIMIT';
        case 'auth':
            return 'AUTH';
        case 'transport':
            return 'SERVER';
        case 'server':
            return 'SERVER';
        case 'invalid_request':
            return isBaizhiContextOverflow(info.detail) ? CONTEXT_WINDOW_EXCEEDED_CODE : 'BAD_REQUEST';
    }
}
/** 错误 → 可读文本（`catch` 到非 Error 值时也不丢信息）。 */
function describeError(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
/**
 * 注册适配器（与其余 provider 同款）。
 *
 * ⚠️ `registerAdapterIdempotent` 内部做「同一 provider 只注册一次」的幂等，
 * 热重载时不会抛「already registered」。
 */
export function registerBaizhiLlm(ctx, options) {
    const product = options.product ?? BAIZHI;
    const adapter = new BaizhiAdapter({
        ...options,
        onCatalogLoaded: () => broadcastCatalogChanged(ctx),
        warn: options.warn ?? ((message) => { ctx.logger.warn(message); }),
    });
    registerAdapterIdempotent(ctx.llm, [product.id], adapter);
    return adapter;
}
//# sourceMappingURL=baizhi-adapter.js.map