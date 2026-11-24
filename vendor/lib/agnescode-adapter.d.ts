/**
 * AgnesCode LLM 适配器（OpenAI 兼容直连 BFF）。
 *
 * ## 协议
 *
 * `POST {bffBase}/chat/completions`，纯 OpenAI 协议 —— 消息序列化、SSE 解帧、
 * 工具增量合并、截断判定全部复用共享实现，本文件不重写任何一条。
 *
 * ## 目录是**账号级**的
 *
 * `/v2/models` 按**当前请求的账号**下发（不同订阅档看到不同条目）。因此：
 *
 * - 目录缓存按 `bff_base` 分桶（不按 provider id 分），否则切号后看到的还是
 *   上一个号的目录；
 * - `listModels` 没有可用账号时返回 `[]`（骨架语义 = 目录为空 ⇒ 整家 provider
 *   被隐藏）；这正是「没登录就不该出现在选择器里」的门控。
 *
 * ## 轮换语义
 *
 * | 类别 | 换号？ | 写限流？ | 抛什么 |
 * |---|---|---|---|
 * | `auth`（401/403） | 换 | 不写 | 全试完抛 `AUTH`（**保留原文**与「重新导入」指路） |
 * | `rate_limit`（429） | 换 | 写（服务端 `retry-after` 优先） | 全试完抛 `QUOTA_EXCEEDED` |
 * | `context_window`（超限） | **不换** | 不写 | 直接抛（请求太大，换号无用；且要触发溢出压缩） |
 * | `invalid_request`（其余 400） | **不换** | 不写 | 抛 `BAD_REQUEST` + 原文 |
 * | `server`（5xx）/ 传输 | 换 | 不写 | 全试完抛原错误 |
 *
 * ⚠️ 已产出内容的流**不重放**（用户会看到两份输出）。
 *
 * ## 图片：一律拒绝，不静默丢弃
 *
 * 目录里没有任何条目声明能收图（`model_type` 恒 `"text"`）⇒ 带图请求直接抛
 * `UNSUPPORTED_CONTENT`。静默丢图会让模型「看不见却照常回答」，用户拿到幻觉
 * （Qoder 图片事故的教训）。
 *
 * @module src/agnescode-adapter.ts
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import type { AccountPool } from './account-pool.js';
import { type CatalogEntry } from './model-catalog.js';
import { type AgnescodeProduct } from './agnescode-product.js';
import { type AgnescodeCredential } from './agnescode.js';
/** 单槽（接线层解析好的账号 + 凭据）。 */
export interface AgnescodeSlot {
    accountId: string;
    credential: AgnescodeCredential;
}
/** 适配器选项。 */
export interface AgnescodeAdapterOptions {
    /** 产品配置；默认 {@link AGNESCODE}。 */
    product?: AgnescodeProduct;
    /**
     * 取当前可用槽序列。`modelId` **推理路径必传**（据此过滤处于限流窗口的账号）；
     * **目录路径不传**（那会让被限流的账号把整个目录拖空）。
     */
    slots: (modelId?: string) => Promise<readonly AgnescodeSlot[]>;
    /** 账号池（黑名单 / 关闭意图 / 门控的唯一数据源）。生产接线必须传。 */
    accountPool?: AccountPool;
    /** 记录某账号在某模型上的冷却截止时刻。 */
    markLimited?: (accountId: string, modelId: string, resetAtMs: number) => Promise<void>;
    /** 诊断日志。 */
    warn?: (message: string) => void;
    /**
     * 网络出口（目录 / 余额 / 推理共用）。
     *
     * ⚠️ 必须可注入：否则单测会**真的**打上游 —— 本家端点对伪造凭据也可能回 200
     *（Qoder 那次已经踩过：测试静默变成随机真值）。生产不传 ⇒ 全局 `fetch`。
     */
    fetchImpl?: typeof fetch;
}
export declare class AgnescodeAdapter extends LlmAdapter {
    private readonly options;
    private readonly product;
    private readonly skeletonCatalog;
    /**
     * 最近一次拉到的**各账号**目录（每个账号一条，失败的也在里面）。
     *
     * ⚠️ 2026-11-19 由「单条」改成「按账号的数组」：单条装不下多账号的并集，
     * 也无法按账号分桶（`bff_base` 是站点级常量，不含账号身份）。
     */
    private lastCatalog;
    /** 正在进行的预热（反重入；见 {@link warmCatalog} 的两道闸门）。 */
    private warming?;
    /** 上一次预热开始时刻（节流）。 */
    private lastWarmAt;
    /** 上一次目录拉取失败时刻（失败也节流，避免过期凭据被反复重打）。 */
    private lastCatalogFailAt;
    constructor(options: AgnescodeAdapterOptions);
    providerInfo(provider: string): LlmProviderInfo;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    /**
     * 同步全量目录（`listAllModels()` 用）。
     *
     * ⚠️ **不能 async**：`jet-hub-rpc` 的 `ModelCatalogSource` 是同步接口且消费者
     * 不 await，返回 Promise 会 `TypeError: all is not iterable`（minimax 的真实缺陷）。
     *
     * ⚠️ **必须委托给骨架**（2026-11-19 自查）：本方法原先自己从 `lastCatalog`
     * 重新摊一遍，**丢掉了 `isFree`**（骨架那份是 `{id, name, isFree?}`，
     * 而 Jet Hub 的免费桶只认该字段）；同时那也是「一判据两份实现」——
     * 骨架的 `cached ?? syncCatalog()` 与本地的 `lastCatalog` 迟早会分叉。
     * 语义完全一致（骨架的 `cached` 就是本适配器 `loadCatalog()` 的产物，
     * 未暖时回落到 `syncCatalogEntries()`，同样会触发一次受节流的预热）。
     */
    listAllModels(): readonly {
        id: string;
        name: string;
        isFree?: boolean;
    }[];
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    /** 异步目录 → 骨架中间结构；**没有可用账号时返回 `[]`**（隐藏整家 provider）。 */
    /**
     * 强制走一次 `catalog()`（无视骨架的 `cached`）。
     *
     * ⚠️ 存在的理由：共享骨架 `src/model-catalog.ts` 的 `cached` 一旦写入就只由
     * `refresh()` 更新 ⇒ **凭据换代**这类「适配器侧状态变了、骨架不知道」的变化，
     * 走 `listModels()` 看不到。本方法把适配器那一层的真实判据暴露出来，
     * 供 `refresh` 与用例使用（单测里 `listModels()` 会命中骨架旧 `cached`）。
     */
    refreshCatalog(): Promise<readonly CatalogEntry[]>;
    private loadCatalogEntries;
    private syncCatalogEntries;
    /** 兜底目录（本家**刻意留空**，见 `agnescode-product.ts`）。 */
    private fallbackEntries;
    /**
     * 后台预热一次目录；失败静默（没有账号时本来就不该有目录）。
     *
     * ⚠️⚠️ 两道闸门缺一不可（2026-11-19 提交前自查）：
     *   1. **反重入**（`warming`）：`syncCatalogEntries()` 会触发本函数，而它自己
     *      又是 `catalog()` 的失败回落（本次已把那条回落改成直接返回兜底表，
     *      但闸门必须留着 —— 否则任何一次「预热里再触发预热」的接线改动都会
     *      重新变成自激）；
     *   2. **节流**（`lastWarmAt` / `lastCatalogFailAt`）：`listAllModels()` 是同步
     *      接口、每次调用都会触发预热 ⇒ 面板刷新快时会连打上游；失败的目录同样
     *      要吃掉 60s 窗口，否则凭据过期时等于拿插件当压测工具。
     *
     * 自激的具体形态（已实测）：预热 → `catalog()` → 拉失败 → 回落 → 预热 → …
     * 每轮一次 HTTP、永不停止，而用户看到的现象只是「面板卡」。
     */
    private warmCatalog;
    /**
     * 当前生效的目录（远端优先、失败回落兜底表）。
     *
     * ## ⚠️⚠️ 2026-11-19 两处修正（双审计实测，PR #128 原实现的两个真缺陷）
     *
     * **① 多账号目录只取了 `slots[0]`**（原实现 `const slot = slots[0]`）。
     * 推理是**按池轮换**的，而目录只反映第一个账号 ⇒ 第二个账号独有的模型
     * 在模型选择器里**永久选不到**（对抗审计实测：两账号各持一份目录，B 的
     * `b-only` 永远不出现）。本家的目录是**上行级**下发的（不同订阅档看到不同条目），
     * 这与 Qoder「目录按账号下发」是同型坑，而那边的结论也是**并集**。
     *
     * **② 缓存键只有 `bffBase`，不含账号身份**（原实现）。而 `bff_base` 是
     * **站点级常量**（本 PR 自己把它钉扎成 `product.fallbackBffBase`）⇒ 同站两账号
     * 恒等 ⇒ 切号后**照样**看到上一个账号的目录，正是 PR 注释声称要消灭的那个症状
     * （`src/agnescode-adapter.ts:13` 与 `:253` 两处注释都写着「按 bff_base 分桶，
     * 否则切号后看到上一个号的目录」）。对抗审计 M08 实测：把这行比较整个删掉，
     * 行为**逐字节相同** ⇒ 那道「守卫」对被测症状从未生效。
     * ⇒ 缓存键改为 **`账号 id + bff_base`**（再加上索引里该账号的凭据指纹，
     * 见下方 `credentialKey`：手工改完凭据不必等 TTL 到期就重取）。
     *
     * ## 失败结果也缓存
     *
     * 原实现只缓存成功（`lastCatalogFailAt` 是个全局时刻）。多账号下「A 成功、B 失败」
     * 会让 B 每调一次 `listModels()` 都重打一次上游（面板刷新快时等于压测）。
     * ⇒ 失败也写一条 60s 的缓存（与 `WARM_THROTTLE_MS` 同窗口），键同样含账号身份。
     *
     * @returns 各账号目录的**并集**（按 id 去重、保持首次出现顺序）；无账号 ⇒ `[]`
     */
    private catalog;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /** 指定槽发一次请求。 */
    private streamVia;
    /**
     * 发推理请求：出口走注入的 `fetchImpl`，且**只对「等响应头」这一段**设上限。
     *
     * ⚠️ 为什么必须两件事一起做（2026-11-19 自查）：
     *   1. 选项注释承诺「目录 / 余额 / 推理共用」`fetchImpl`，而推理腿原先直接用
     *      全局 `fetch` ⇒ 注释与实现不一致，且推理路径在单测里**无法拦截**
     *     （本仓红线：注释必须与实际一致）；
     *   2. `product.fetchTimeoutMs` 此前只喂给 `consumeOpenAiSse` 的
     *      `firstTokenTimeoutMs`，而那是**拿到响应头之后**的空闲超时 ⇒「等头」这段
     *      没人负责，只能吃 undici 默认（约 300s）：网关卡在排队时用户看到的是
     *      「永远转圈」（magicrew 的同型修法）。
     *
     * ⚠️ 拿到头**立即** `clearTimeout`：这条定时器只管等头，绝不能误杀后面的长回答。
     */
    private fetchChat;
}
/** 在 `ctx.llm` 上注册 AgnesCode 路由（幂等）。 */
export declare function registerAgnescodeLlm(ctx: Context, options: AgnescodeAdapterOptions): AgnescodeAdapter;
//# sourceMappingURL=agnescode-adapter.d.ts.map