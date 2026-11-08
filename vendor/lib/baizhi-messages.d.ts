/**
 * 百智云的 Anthropic Messages 请求体构造 + SSE 消费。
 *
 * ## 为什么单独成模块
 *
 * 协议解析**复用** `src/minimax-messages.ts`（本仓唯一的 Anthropic Messages 实现），
 * 只在这里补百智云的两点差异：
 * 1. `max_tokens` 的上限（逐模型实测：deepseek/minimax/glm/kimi 100,000、
 *    qwen 65,536 / qwen-flash 32,768）与默认值（4096）；
 * 2. 思考参数：百智云用 `thinking: {type:'enabled', budget_tokens:N}`，
 *    **不支持** Anthropic 的 `output_config.effort`（顶层 `effort` 实测无作用：
 *    low/xhigh 各 2 次思考长度无差异）⇒ 这里**不做 effort 透传**，
 *    只把 effort 档位换算成 budget。
 *
 * ⚠️ **硬约束：`budget_tokens` 必须严格小于 `max_tokens`**（Anthropic 协议要求
 * `budget_tokens < max_tokens`，百智云遵循该规则；写成 ≥ 会被 400 拒绝）。
 * 所以预算一律按 `min(档位值, max_tokens - 余量)` 夹，构造 payload 时再夹一次
 * `max_tokens - 1`，两道保险。
 *
 * @module src/baizhi-messages.ts
 */
import type { RequestMessage, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm';
import { mapMinimaxStopReason, readMinimaxUsage, type ConsumeMinimaxSseOptions, type MinimaxInlineImage } from './minimax-messages.js';
/** 内联图片（裸 base64，交给 `serializeMinimaxMessages` 拼 Anthropic `image` 块）。 */
export type BaizhiInlineImage = MinimaxInlineImage;
/** 未指定时的 `max_tokens`（与 monkeycode/messages 保持同一默认值）。 */
export declare const BAIZHI_DEFAULT_MAX_TOKENS = 4096;
/** 思考预算下限（低于它上游不收）。 */
export declare const BAIZHI_MIN_THINKING_BUDGET = 1024;
/**
 * 思考预算与 `max_tokens` 之间必须留的余量。
 *
 * `budget_tokens` 要**严格小于** `max_tokens`，而思考本身还要产出少许
 * `max_tokens` 之外的正文，留 1024 是「够正文喘口气」的经验值
 * （默认 4096 ⇒ high 档 8192 会被夹到 3072）。
 */
export declare const BAIZHI_THINKING_HEADROOM = 1024;
/** 思考配置；`undefined` = 不发该字段。 */
export type BaizhiThinking = {
    readonly type: 'enabled';
    readonly budgetTokens: number;
} | {
    readonly type: 'disabled';
};
/**
 * 归一化 `max_tokens`：非正/非有限 ⇒ 默认 4096；超过该模型的输出上限 ⇒ 夹到上限。
 *
 * ⚠️ 上限是**逐模型**的（qwen 系列比 deepseek 低，实测 65,536 / 32,768），
 * 传 `model` 才会按模型夹；不传时按服务级默认 `BAIZHI_MAX_OUTPUT_TOKENS` 夹。
 *
 * ⚠️ 这是本仓**唯一**一条「按模型夹出站上限」的实现（全仓另一个 clamp 点是
 *    `monkeycodeMaxTokensFor`，它**没有**按模型夹 —— 两家策略刻意不同，见下）。
 *
 * ## 与 `monkeycode` 的口径差异（2026-11-08 审计提出，**有意保留**）
 *
 * | | baizhi（本文件） | monkeycode（`monkeycode-messages.ts`） |
 * | --- | --- | --- |
 * | 语义 | 逐模型**硬限**（超了上游 400） | 只挡**荒谬值**（1_048_576） |
 * | 手填 500,000 | 夹到 100,000 | 原样上行 |
 * | 依据 | qwen 三兄弟 100,000 实测 400 | 该模型 100,000 / 1,000,000 实测都能回 |
 *
 * 差异是**证据驱动**的，不是漏写：baizhi 的上限是「上游会拒绝」的硬边界，
 * 不夹就是把 400 发给用户；monkeycode 只观测到「能接受」，没有可夹的真实边界，
 * 夹了反而会静默削掉用户明确要的预算。**不要为了「统一」把两者合并。**
 *
 * ## ⚠️ 与「刻意不声明 maxTokens」定案的区别（别当成回归）
 *
 * 本仓有两处**明确决定不声明** `maxTokens` 的定案：
 * `src/models.ts:105-124`（2026-10-30 第二轮审计 D-4，AgentCenter）与
 * `src/llm-adapter.ts:2004-2029`（同批四路审计 P1-1，codearts）。理由是
 * **声明会改变宿主的自动压缩触发点**（`dsh-compaction-basic` 的
 * `reservedCompletionTokens` 直接读 `maxTokens`）：窗口 131,072 的模型若声明
 * 100,000，`pressureBudgetTokens` 会算成负、抛 `TargetPressureConfigError`，
 * 而它被 `agent/pre-step` 吞成一条 warn ⇒ **自动压缩静默关闭**。
 *
 * 这两条定案**不适用于本文件**：codearts 的出站预算已由
 * `CODEARTS_MAX_OUTPUT_TOKENS = 65_536` 单点决定，不声明也不改 wire 值；
 * 而 baizhi / monkeycode 的兜底是 `*_DEFAULT_MAX_TOKENS = 4096`，
 * **不声明就真的发 4096** ⇒ 长回答被静默截断。两边的「不声明」后果相反。
 *
 * 算术核对（本文件的声明值不会踩到压缩坑）：baizhi 的窗口 1,048,576 +
 * 输出 100,000 ⇒ `pressureBudgetTokens = 1,048,576 - 100,000 - 65,536 = 883,040`
 * > `thresholdTokens = 838,860` ⇒ **触发点完全不变**；monkeycode 同型
 * （余量 16,180）。只有当 `maxTokens > 144,180` 时阈值才开始下降，
 * 只有 `contextWindow <= maxTokens + 65,536` 才会抛错。
 */
export declare function baizhiMaxTokensFor(maxTokens: number | undefined, model?: string): number;
/**
 * 把 harness 的 effort 档位换算成思考预算。
 *
 * | effort | 档位预算 |
 * | --- | --- |
 * | `none` | 关闭思考 |
 * | `low` | 2048 |
 * | `medium` | 4096 |
 * | `high` | 8192 |
 * | 其它/`undefined` | 不发 `thinking` 字段（交给上游默认） |
 *
 * 回到「预算必须 < max_tokens」：先按 `max_tokens - 1024` 夹，
 * 夹完低于 1024 就直接关掉（发不出合法预算，只能不发）。
 */
export declare function baizhiThinkingFor(effort: unknown, maxTokens: number): BaizhiThinking | undefined;
/** {@link buildBaizhiMessagesPayload} 的入参。 */
export interface BuildBaizhiMessagesPayloadOptions {
    model: string;
    messages: readonly RequestMessage[];
    system?: string;
    tools?: readonly ToolSchema[];
    temperature?: number;
    maxTokens?: number;
    stop?: readonly string[];
    /** 思考配置；`undefined` = 不发该字段。 */
    thinking?: BaizhiThinking;
    /** 已内联的图片；缺失时遇图**抛错**（不静默丢图）。 */
    images?: ReadonlyMap<string, BaizhiInlineImage>;
}
/**
 * 构造 Anthropic Messages 请求体。
 *
 * `stream: true` **恒真**：本插件的适配器只有流式一条路径。
 * `max_tokens` **必带**（Anthropic 协议必填；百智云同样必填）。
 */
export declare function buildBaizhiMessagesPayload(options: BuildBaizhiMessagesPayloadOptions): Record<string, unknown>;
/** 序列化历史消息为 Anthropic 形状（转发 `serializeMinimaxMessages`）。 */
export declare function serializeBaizhiMessages(messages: readonly RequestMessage[], images?: ReadonlyMap<string, BaizhiInlineImage>): Array<Record<string, unknown>>;
/**
 * 消费 Anthropic SSE 流。
 *
 * ⚠️ 用 `yield*` 包一层 `try/catch` 而不是直接 re-export：流中途抛出的错误
 * 也带 `minimax:` 前缀，必须一并改写；错误**原样抛出**（半截流重发会重复输出，
 * 与 minimax 自己的「`yieldedAny` 之后不重发」口径一致）。
 */
export declare function consumeBaizhiSse(options: ConsumeMinimaxSseOptions): AsyncGenerator<StreamChunk>;
/** `stop_reason` 映射（纯字段映射，直接复用）。 */
export declare const mapBaizhiStopReason: typeof mapMinimaxStopReason;
/** `usage` 映射（`input_tokens` / `output_tokens` / cache 两类 / thinking）。 */
export declare const readBaizhiUsage: typeof readMinimaxUsage;
//# sourceMappingURL=baizhi-messages.d.ts.map