/**
 * 腾讯 Marvis 的 DSH 适配器。
 *
 * ## 与其余 16 家的同构点
 *
 * 目录（黑名单 / 关闭供应商 / 无账号门控）、错误分类、槽轮换、Token 账本
 * 全部走仓库的共享实现，**本文件不重写任何一条**：
 *
 * | 关注点 | 落点 |
 * | --- | --- |
 * | 目录门控与黑名单 | `model-catalog.ts` 的 `createModelCatalog` |
 * | 请求体（工具包装 / `include_usage`） | `marvis-messages.ts` |
 * | 流帧解析（思考 / 工具增量 / usage） | `openai-compat.ts` 的 `consumeOpenAiSse` |
 * | 取消判定 | `aggregate-adapter.ts` 的 `isAbortLike`（**共享唯一一份**） |
 * | 限流冷却终点 | `model-queue.ts` 的 `nextUtc8DayStartMs` |
 *
 * ## 本家独有的三处
 *
 * 1. **目录只有一条且没有远端端点**（实测 9 个候选端点全 404）⇒ `catalog()`
 *    恒返回静态表；保留 `createModelCatalog` 是为了黑名单/门控与其余家同源。
 * 2. **槽里是完整凭据对象**（`MarvisSlot.credential`），不是裸 Key ——
 *    请求头需要 `openid` / `guid` / `login_type` 三格。
 * 3. **`content-type` 闸门必须放行 `text/plain`**：实测上游对 `stream:true`
 *    回 `text/plain; charset=utf-8`，而 body 是标准 SSE。照抄 modelscope 的
 *    `includes('text/event-stream')` 会把**每一次正常请求**都当成风控页。
 *
 * @module marvis-adapter
 */
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { AccountPool } from './account-pool.js';
import { type MarvisCredential } from './marvis.js';
import { type MarvisErrorInfo, type MarvisProduct } from './marvis-product.js';
/** 一个可用的账号槽（接线层按账号池手动顺序产出）。 */
export interface MarvisSlot {
    /** 账号 id（`marvis-xxxxxxxx`）。 */
    readonly id: string;
    /** 解析好的凭据。 */
    readonly credential: MarvisCredential;
}
/** 适配器选项。 */
export interface MarvisAdapterOptions {
    /**
     * 单凭据回退 ref（无账号池条目时用）。
     *
     * ⚠️ 类型是 `unknown` —— 本适配器不用它做解析（凭据一律经 `slots()`
     * 由接线层解析好传进来），保留只为与其余 `registerXxxLlm` 的选项形状一致。
     */
    credentialRef?: unknown;
    /**
     * 取当前可用槽序列（按账号池的手动顺序）。
     *
     * @param modelId 目标模型。**推理路径必须传**，接线层据此过滤掉
     *   「该模型正处于限流窗口」的账号。
     *   ⚠️ **目录路径刻意不传**：目录与「哪个账号此刻被限流」无关。
     */
    slots: (modelId?: string) => Promise<readonly MarvisSlot[]>;
    /**
     * 账号池（**黑名单、关闭意图、目录门控的唯一数据源**）。
     *
     * ⚠️ 省略时（单测 / 嵌入方）行为退回「不过滤、不判关闭意图」；
     * **生产接线必须传**。
     */
    accountPool?: AccountPool;
    /** 给某账号的某模型写限流标记（到 `resetAtMs` 为止）。 */
    markLimited?: (slotId: string, modelId: string, resetAtMs: number) => void | Promise<void>;
    /** 警告出口（上游故障 / 换号原因）。 */
    warn?: (message: string) => void;
    /** 读取图片附件（`analyzeImage` 工具用）。 */
    readImage?: (ref: unknown) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    /** 产品配置；默认 {@link MARVIS}。 */
    product?: MarvisProduct;
}
/**
 * 限流/额度的冷却时长。
 *
 * ⚠️ 额度类**必须是「到次日 UTC+8 零点」**，不是「撞墙 +24h」：Marvis 的
 * 免费额度是**按自然日**重置的（钱包 `total_tokens` 每天回满），滑动窗口会让
 * 23:50 烧光的账号被封到**次日 23:50**，用户看到「0 点后上游已能用、插件仍说
 * 没到重置时间」（与 loomy 的 IKL80H 同型）。
 */
export declare function marvisRetryAfterMs(kind: MarvisErrorInfo['kind'], retryAfterMs: number | undefined, attempt: number, nowMs?: number): number;
/** Marvis 适配器。 */
export declare class MarvisAdapter extends LlmAdapter {
    private readonly product;
    private readonly options;
    private readonly skeletonCatalog;
    constructor(options: MarvisAdapterOptions);
    private toCatalogEntry;
    private catalogEntries;
    /**
     * 目录（**无远端端点**）。
     *
     * 门控：没有任何已登录账号 ⇒ 空目录（与其余家同源，`createModelCatalog`
     * 读池；这里只补「槽为空」这一格）。
     */
    private loadCatalogEntries;
    /** `listAllModels` 用的同步目录（**绝不能 async**）。 */
    private syncCatalogEntries;
    providerInfo(provider: string): LlmProviderInfo;
    /**
     * **同步**全量目录。
     *
     * ⚠️ 消费者**不 await**（`jet-hub-rpc.ts` 的 `catalog = [...all]`），返回
     * Promise 会抛 `TypeError: all is not iterable`（minimax 的同款真实缺陷）。
     */
    listAllModels(): readonly {
        id: string;
        name: string;
    }[];
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    private resolveImageUrls;
    /**
     * 轮换：失败按「语义」标记该槽 → 换下一槽重发。
     *
     * 三条硬规则（与其余家同源）：
     * 1. `tried` **跨迭代保留** —— 每次重置会让两个槽之间无限来回；
     * 2. **已交付内容的流不重放**；
     * 3. **认证类不写限流标记**（写它会放大成「全池被封」）。
     */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /** 指定槽发一次请求（轮换循环的复用单元）。 */
    protected streamVia(slot: MarvisSlot, options: GenerateOptions): AsyncIterable<StreamChunk>;
}
/**
 * 从 `LlmError` 还原成语义化分类。
 *
 * ⚠️ 事实挂在 `error.failure` 上（`LlmFailure` 契约），**不是**展开在 error
 * 自身 —— 早期版本误按「自身属性」读响应头，`retry-after` 因此永远读不到。
 */
export declare function classifyMarvisFailure(error: unknown): MarvisErrorInfo;
/** 在 `ctx.llm` 上注册 marvis 路由。 */
export declare function registerMarvisLlm(ctx: Context, options: MarvisAdapterOptions): MarvisAdapter;
//# sourceMappingURL=marvis-adapter.d.ts.map