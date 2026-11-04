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
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import type { AccountPool } from './account-pool.js';
import { type BaizhiModelEntry, type BaizhiProduct } from './baizhi-product.js';
import { type BaizhiFailureKind } from './baizhi.js';
/** 一个可用账号（凭据 + 它在账号池里的 id）。 */
export interface BaizhiSlot {
    readonly id: string;
    readonly apiKey: string;
}
/** {@link BaizhiAdapter} 的构造选项。 */
export interface BaizhiAdapterOptions {
    /** 默认凭据 ref（仅供展示/诊断，不参与请求）。 */
    readonly credentialRef?: CredentialRef;
    /**
     * 取**当前可用**的账号列表（按池内顺序）。
     *
     * ⚠️ 由 `index.ts` 注入而不是适配器自己读池：池的过滤规则（`enabled`、
     * 模型级冷却）是**账号池的语义**，散到适配器里会变成第二份判据。
     */
    readonly slots: (modelId?: string) => Promise<readonly BaizhiSlot[]>;
    readonly accountPool?: AccountPool;
    /**
     * 写模型级冷却。
     *
     * ⚠️ **单测注入通道，生产接线层不注入**（2026-11-02 三审 F🟡-3）：
     * `src/index.ts` 的 baizhi 工厂只传 `accountPool`，故运行期恒走下面的
     * `pool.updateModelRateLimit` 回退分支。两条路径必须保持幂等（入参单位、
     * 错误吞掉行为），否则单测绿而生产不写。
     */
    readonly markLimited?: (slotId: string, modelId: string, resetAtMs: number) => Promise<void>;
    readonly readImage?: (attachment: unknown) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    /** 拉远端目录；默认用 `fetchBaizhiModels`（可注入以便单测完全不联网）。 */
    readonly fetchRemoteModels?: (apiKey: string, signal?: AbortSignal) => Promise<readonly BaizhiModelEntry[]>;
    readonly product?: BaizhiProduct;
    readonly onCatalogLoaded?: () => void;
    readonly warn?: (message: string) => void;
    readonly now?: () => number;
    readonly fetchImpl?: typeof fetch;
}
/** 单次请求允许最多换几个账号（防止池里 20 个坏 Key 时打满上游）。 */
export declare const BAIZHI_MAX_ROTATE = 4;
/**
 * 百智云适配器。
 *
 * ⚠️ 与 minimax 的差别：**没有 refresh 重试**。静态 Key 出错只需换号，
 * 不需要「续期再试一次」。
 */
export declare class BaizhiAdapter extends LlmAdapter {
    private readonly options;
    private readonly product;
    /** 上次成功拉到的远端目录（`undefined` = 还没成功过）。 */
    private remoteModels;
    /** 上次成功拉到目录的时刻（毫秒）。 */
    private catalogAt;
    private readonly catalogGate;
    private readonly catalog;
    constructor(options: BaizhiAdapterOptions);
    providerInfo(provider: string): LlmProviderInfo;
    /**
     * ★ 后台目录刷新器入口（`index.ts` 的 `refreshOf` 调 `adapter.refresh?.()`）。
     *
     * ⚠️ 必须**显式转发** `catalog.refresh`：`ModelCatalog` 的成员不会自动变成
     * 适配器的成员（`pruned()` 的 Proxy 只透传适配器自己的成员）。
     * 漏转发 ⇒ 刷新器「已武装」却对这家**空转**，且零日志。
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
     * 取目录：远端优先、失败回退内置兜底表。
     *
     * 与 monkeycode 不同，百智云**有**可用的远端目录，所以保留完整的
     * 「缓存 → `RemoteCatalogGate` → 新鲜度判断 → 兜底」链路。
     */
    private loadModels;
    /** 默认远端目录拉取（10s 超时，见 `BAIZHI.catalogTimeoutMs`）。 */
    private readonly fetchRemoteModelsDefault;
    /**
     * 发一次流式请求。
     *
     * 结构：**逐账号尝试** → 失败分类 → 可换号则下一个 → 全失败抛错。
     * 已经产出过任何块之后**不再换号**（重发会造成重复输出）。
     */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /** 用某个账号发一次请求。 */
    private send;
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
    private markLimited;
    /**
     * 内联图片。
     *
     * ⚠️ 顺序很重要：**先判模型是否支持，再读字节**（见 `stream` 里的注释）。
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
     * `registerBaizhiLlm` 注入；单测里不注入时**静默**。
     */
    private warn;
}
/**
 * 注册适配器（与其余 provider 同款）。
 *
 * ⚠️ `registerAdapterIdempotent` 内部做「同一 provider 只注册一次」的幂等，
 * 热重载时不会抛「already registered」。
 */
export declare function registerBaizhiLlm(ctx: Context, options: BaizhiAdapterOptions): BaizhiAdapter;
/** 失败类别（导出便于 `index.ts` 做日志分流；本文件内也已用上）。 */
export type { BaizhiFailureKind };
//# sourceMappingURL=baizhi-adapter.d.ts.map