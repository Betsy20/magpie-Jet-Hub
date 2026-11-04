/**
 * MonkeyCode 模型适配器。
 *
 * 走 **Anthropic Messages** 协议（请求体构造与 SSE 消费在
 * `src/monkeycode-messages.ts`，其中大部分**复用 minimax 的实现**）。
 *
 * ## 一家两通道，适配器只认凭据
 *
 * 通道差异（端点 + 鉴权头）全部收在 `monkeycode.ts` 的
 * {@link monkeycodeMessagesUrl} / {@link monkeycodeHeaders} 里。本文件**不做**
 * 通道分支判断 —— 唯一的例外是 `monkeycode-{basic,pro,ultra}/…` 前缀的模型
 * 只能在网关通道用（白泽账号选中它时给一条可读错误，而不是让上游回一个
 * 含糊的 4xx）。
 *
 * ## 目录：白泽动态 + 网关常量，**必然合并**
 *
 * `listAllModels()` 契约要求**同步**返回，而同步路径上拿不到「当前凭据是哪个
 * 通道」的异步信息。故目录 = `远端白泽目录 ∪ 网关内置常量`。
 * 代价是用户可能选中当前账号调不通的模型（会得到一个明确的 HTTP 错误），
 * 比「目录随账号漂移、且冷启动时为空」好得多（空目录会让面板误显示
 * 「已关闭且无模型可关」）。
 *
 * ## ⚠️ 刻意不声明 `reasoning` 档位表
 *
 * MonkeyCode 没有下发「每个模型支持哪些思考档位」的元数据。凭空编一张表
 * 就是假能力（Qoder 的教训：UI 给了选项、请求却被丢弃）。
 * - 目录条目**不带** `reasoning` ⇒ UI 不出现档位选择器；
 * - 但如果 harness 自己传了 `reasoningEffort`（例如用户在别处设过），
 *   仍会映射成 `thinking.budget_tokens` —— 见 `monkeycodeThinkingFor`。
 *
 * ## 错误码纪律（与 minimax 同口径）
 *
 * - 非 SSE 的 200 ⇒ `INVALID_REQUEST`（**不能**用 `SERVER`：那会命中
 *   `dsh-llm-retry` 的 `DEFAULT_RETRYABLE_CODES`，被自动重试 5 次，
 *   把一个「端点返回了 JSON」的错误放大成 5 个）；
 * - 402 ⇒ `QUOTA_EXCEEDED`；
 * - 其余按 `httpErrorCode(status)`。
 *
 * @module src/monkeycode-adapter.ts
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import type { AccountPool } from './account-pool.js';
import { type MonkeycodeProduct } from './monkeycode-product.js';
import { type MonkeycodeCredential } from './monkeycode.js';
/** 一个可用账号（凭据 + 它在账号池里的 id）。 */
export interface MonkeycodeSlot {
    readonly accountId: string;
    readonly credential: MonkeycodeCredential;
}
/** {@link MonkeycodeAdapter} 的构造选项。 */
export interface MonkeycodeAdapterOptions {
    /** 默认凭据 ref（供 `provider.status` 等处展示，不参与请求）。 */
    readonly credentialRef: CredentialRef;
    /**
     * 取**当前可用**的账号列表（按池内顺序）。
     *
     * ⚠️ 由 `index.ts` 注入而不是适配器自己读池：池的过滤规则（`enabled`、
     * 模型级冷却）是**账号池的语义**，散到适配器里会变成第二份判据。
     */
    readonly slots: (modelId?: string) => Promise<readonly MonkeycodeSlot[]>;
    readonly accountPool?: AccountPool;
    readonly readImage?: (attachment: unknown) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    readonly product?: MonkeycodeProduct;
    readonly onCatalogLoaded?: () => void;
    readonly warn?: (message: string) => void;
    readonly now?: () => number;
    readonly fetchImpl?: typeof fetch;
}
/**
 * MonkeyCode 适配器。
 *
 * ⚠️ 与 minimax 的差别：**没有 refresh 重试**。凭据是静态材料，
 * 401 只意味着「key 错了/被吊销」，重取一次还是同一份字符串 —— 重试纯属浪费。
 */
export declare class MonkeycodeAdapter extends LlmAdapter {
    private readonly options;
    private readonly product;
    private readonly catalogGate;
    private readonly catalog;
    constructor(options: MonkeycodeAdapterOptions);
    providerInfo(provider: string): LlmProviderInfo;
    /**
     * 取目录。
     *
     * ⚠️ **没有远端来源**：网关的 `GET /v1/models` 实测返回 405（国内站与国际站
     * 行为逐字节一致），所以目录只可能是内置常量。这里刻意**不**保留
     * 「失败 ⇒ 回退」的远端分支：一个永远 405 的端点只会让每次冷启动多一次
     * 注定失败的往返，并把 `RemoteCatalogGate` 的失败冷却搅浑。
     */
    private loadModels;
    /**
     * ★ 后台目录刷新器入口（`src/index.ts` 的 `refreshOf` 调 `adapter.refresh?.()`）。
     *
     * ⚠️ 必须由适配器**显式转发** `catalog.refresh`：`ModelCatalog` 上的这个成员
     * 不会自动变成适配器的成员（`pruned()` 的 Proxy 只透传适配器自己的成员）。
     * 漏转发 ⇒ 刷新器「已武装」却对这家**空转**，且零日志。
     *
     * ⚠️ 与「凭据续期」**不是同一件事**，两者同名纯属巧合，不得合并。
     */
    refresh(): Promise<void>;
    /** 完整目录（**不套黑名单**），供 Jet Hub「显示列表」用。**必须同步**。 */
    listAllModels(): readonly {
        id: string;
        name: string;
    }[];
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /**
     * 兼容 0.1.1-rc.2 的 `prepareCall` shim。
     *
     * ⚠️ **必须包装**（不能只实现 `stream`）：harness 的生产路径走 `prepareCall`，
     * 只在 `stream` 里做的校验在测试里可以看到、在生产里永远不生效。
     */
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    /**
     * 发一次流式请求。
     *
     * 结构：**逐账号尝试** → 失败分类 → 可换号则下一个 → 全失败抛错。
     * 已经产出过任何块之后**不再换号**（重发会造成重复输出）。
     */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /** 用某个账号发一次请求。 */
    private send;
    /** 给失败账号写模型级冷却（`auth` 不写，见 `recordsMonkeycodeRateLimit`）。 */
    private markLimited;
    /**
     * 内联图片。
     *
     * ⚠️ 顺序很重要：**先判模型是否支持，再读字节**。反过来会让一次不支持图片
     * 的请求先把附件全读进内存、再抛错（大图场景下浪费且可能 OOM）。
     *
     * ⚠️ 不支持时**显式抛 `UNSUPPORTED_CONTENT`**，不静默丢图：静默丢弃会让
     * 用户以为图片被模型看到了（本仓库铁律）。
     */
    private inlineImages;
    private toCatalogEntry;
    private loadCatalogEntries;
    private syncCatalogEntries;
    /**
     * 记一条警告。
     *
     * ⚠️ 适配器**不自带 logger**（选项里没有 `ctx`）：`warn` 由
     * `registerMonkeycodeLlm` 注入；单测里不注入时**静默** —— 让「没接 logger」
     * 的测试不用为了消警告而 mock 一个。
     */
    private warn;
}
/**
 * 注册适配器（与其余 provider 同款）。
 *
 * ⚠️ `registerAdapterIdempotent` 内部会做「同一 provider 只注册一次」的幂等，
 * 热重载时不会抛「already registered」。
 */
export declare function registerMonkeycodeLlm(ctx: Context, options: MonkeycodeAdapterOptions): MonkeycodeAdapter;
//# sourceMappingURL=monkeycode-adapter.d.ts.map