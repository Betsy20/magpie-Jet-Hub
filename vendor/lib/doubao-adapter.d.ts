/**
 * 豆包（Doubao，字节跳动）模型适配器。
 *
 * ## 为什么有这个文件
 *
 * 上游把豆包登记成**纯签到渠道**（`provider-registry.ts` 的 `channel: false`），
 * 没有任何适配器 ⇒ 模型选择器里选不到豆包、也发不出消息。
 * 本适配器复用已有扫码登录会话，接入额度、模型目录与对话。
 *
 * ## 协议要点（详见 src/doubao-upstream.ts）
 *
 * - **目录**：POST /alice/slot/action_bar_v3/brief_list，`{bot_id, language_code}`；
 *   响应是一棵嵌套树，模型散在 `model_item_key` 节点里，按 key 去重。
 * - **对话**：POST /chat/completion，响应不是标准 SSE，
 *   是三行帧 `id:` / `event:` / `data:` + 空行；正文在 STREAM_CHUNK 的
 *   `patch_op[].patch_value` 及通知里，另有 `CHUNK_DELTA`；`10040` 下面的 `10000` 是思考文本。
 * - **路由**：`mode_id=1` + `agent_mode=2` = 普通对话；
 *   `mode_id=3` + `agent_mode=1` = 工作任务（会员付费额度）。
 *
 * ## 能力边界（不编造）
 *
 * 本适配器只声明 **文本输入**：没有实测豆包网页端的多模态上传路径，
 * 故 `inputModalities: ['text']`（明确否定），不谎报图片能力。
 * 工具调用同理：本适配器不向模型声明 tools，避免让模型「以为能调用」而实际不能。
 * 这两条是保守方向（少报能力），与仓库其它家的纪律一致。
 *
 * @module src/doubao-adapter.ts
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import type { AccountPool } from './account-pool.js';
import { type DoubaoCredential } from './doubao.js';
import { type DoubaoRemoteModel } from './doubao-upstream.js';
/** provider id（必须是纯小写字母，registry 的要求）。 */
export declare const DOUBAO_PROVIDER = "doubao";
/** 展示名。 */
export declare const DOUBAO_DISPLAY_NAME = "\u8C46\u5305\uFF08Doubao\uFF09";
/**
 * 兜底目录：2026-11-22 真机从 brief_list 抓到的 14 条。
 *
 * ⚠️ **只在远端读取失败时使用**，且这是快照（上游加模型后不会自动更新）。
 * 值来自实测响应，不是猜的。
 */
export declare const DOUBAO_FALLBACK_MODELS: readonly DoubaoRemoteModel[];
/** 一个可用账号。 */
export interface DoubaoSlot {
    readonly accountId: string;
    readonly credential: DoubaoCredential;
}
/** 适配器构造选项。 */
export interface DoubaoAdapterOptions {
    readonly credentialRef: CredentialRef;
    readonly slots: () => Promise<readonly DoubaoSlot[]>;
    readonly accountPool?: AccountPool;
    readonly onCatalogLoaded?: () => void;
    readonly warn?: (message: string) => void;
    /** 仅单测注入。 */
    readonly fetchImpl?: typeof fetch;
}
/** 解析一个字节流为 ByteDance 三行帧的事件序列。 */
export interface DoubaoFrame {
    readonly event: string;
    readonly data: string;
}
/**
 * 逐帧解析 `id:` / `event:` / `data:` + 空行的变体流。
 *
 * ⚠️ 这是**纯函数**：把整段响应文本切帧，单测可以直接喂抓包样本。
 * 真机上 `data:` 可能是多行 JSON（prettified），这里按「一个事件块内所有
 * `data:` 行拼起来」处理，与浏览器 EventSource 的行为一致。
 */
export declare function parseDoubaoFrames(raw: string): readonly DoubaoFrame[];
/** Extract answer data from one standalone patch frame. */
export declare function doubaoTextDeltaOf(data: string): string;
/**
 * 从一帧里抽业务错误码（流内错误也在 200 的响应里）。
 */
export declare function doubaoStreamErrorOf(data: string): {
    code: number;
    message: string;
} | undefined;
/** 构造对话请求体。 */
export declare function buildDoubaoChatBody(options: GenerateOptions, remote: DoubaoRemoteModel): string;
export declare class DoubaoAdapter extends LlmAdapter {
    private readonly options;
    private readonly catalogGate;
    private readonly catalog;
    private remoteModels;
    private remoteModelsLoaded;
    constructor(options: DoubaoAdapterOptions);
    providerInfo(provider: string): LlmProviderInfo;
    /** 远端目录读取（失败时回退到实测快照，不让冷启动目录为空）。 */
    private refreshRemoteModels;
    refresh(): Promise<void>;
    listAllModels(): readonly {
        id: string;
        name: string;
    }[];
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    private modelForCall;
    private resolvedModel;
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    private streamWithModel;
    private toCatalogEntry;
    private loadCatalogEntries;
    private syncCatalogEntries;
}
/** 注册适配器。 */
export declare function registerDoubaoLlm(ctx: Context, options: DoubaoAdapterOptions): DoubaoAdapter;
//# sourceMappingURL=doubao-adapter.d.ts.map