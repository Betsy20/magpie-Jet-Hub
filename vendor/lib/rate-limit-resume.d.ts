import type { Context } from '@deepseek-ai/cordis';
import { type AccountPool } from './account-pool.js';
/** 续跑消息**自有**的来源标识（理由见模块头）。 */
export declare const RATE_LIMIT_RESUME_SOURCE_KIND = "rate-limit-resume";
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        /**
         * 「限流解禁后自动继续」投出的续跑指令。
         *
         * ⚠️ 它不是人类输入 —— `tool-goal` 的人类授权判据（`source.kind === 'user'`）
         * 因此**不会**被它命中，这正是本标识存在的意义。
         */
        'rate-limit-resume': {
            readonly kind: 'rate-limit-resume';
        };
    }
}
/**
 * 续跑消息正文（模型可见、会落盘）。
 *
 * 按「给模型的指令」写：说清 ① 继续未完成的任务；② 上一轮为什么停了
 * （限流，**不是**任务做完）；③ 不要重复已完成的部分。不写 harness 内部
 * 词汇（「钩子」「解禁时刻」）—— 那是给用户看的诊断。
 */
export declare const RATE_LIMIT_RESUME_PROMPT: string;
/** 落盘文件名（与 `ui-preferences.json` 同目录）。 */
export declare const RATE_LIMIT_RESUME_FILE = "rate-limit-resume.json";
/**
 * 总开关环境变量。
 *
 * 与 `DSH_RATE_LIMIT_SINK` 同一约定：**默认开启**，只有显式写
 * `0` / `false` / `off` / `no` 才算关（`Boolean(env[...])` 会把「未设置」判成
 * 关闭 —— 那是本仓库反复登记的同类坑）。设置页里那个开关用的是同一份语义，
 * 两边**都关**才真的不续跑：环境变量是「这个宿主根本不要这个功能」，
 * 落盘值是「用户在界面上关过」。
 *
 * @param env - 环境变量来源，默认 `process.env`（单测注入用）。
 * @returns 是否允许自动继续。
 */
export declare function rateLimitResumeEnabled(env?: NodeJS.ProcessEnv): boolean;
/** 失败类别：限流（429 / RATE_LIMIT / 号池全限流）。 */
export type RateLimitResumeClass = 'rate' | 'quota';
/** 解禁时刻三条来源都拿不到时的兜底等待（1 小时，与 providers-hub 的 429 冷却同档）。 */
export declare const FALLBACK_WAIT_MS: number;
/**
 * 判一次失败是不是「限流 / 额度」造成的。
 *
 * @param failure - `turn/end` 的 `reason.error`（未知形状按「不是」处理）。
 * @returns `'rate'` / `'quota'`；不是这类失败时 `undefined`。
 */
export declare function classifyRateLimitFailure(failure: unknown): RateLimitResumeClass | undefined;
/**
 * 从失败文案里读「解禁时刻」。
 *
 * 真机原文：`… 的可用账号均在限流中，最近一个将于 2026/11/19 18:25:51 解禁。…`
 * （实测 57/61 条限流失败带这句话）。时间按**本地时区**理解 —— 文案是给人看的，
 * 宿主 `toLocaleString` 产出的就是本地时间。
 *
 * ⚠️ 解析必须**锚定整句**（`将于` + `解禁` 夹住时间），只认时间戳会把文案里
 * 别的日期（例如资源包到期日）吃进来，排出一个毫无意义的远未来时刻。
 *
 * @param text - 失败文案。
 * @returns 绝对时刻（ms）；文案里没有解禁时刻时 `undefined`。
 */
export declare function unlockAtFromText(text: string): number | undefined;
/**
 * 解析**这一次中断**应当等到什么时候。
 *
 * 三条来源取**最早**：越早到点越安全 —— 到点会先复核号池，仍受限就顺延；
 * 反过来（取最晚）会让用户在本可续跑的时刻干等。
 *
 * @param input.failure - `turn/end` 的 `reason.error`。
 * @param input.now - 当前时刻。
 * @param input.poolResetAt - 号池给出的解禁时刻（可选）。
 * @returns 绝对时刻（ms），永远有值（最差是 `now + FALLBACK_WAIT_MS`）。
 */
export declare function resolveUnlockAt(input: {
    readonly failure: unknown;
    readonly now: number;
    readonly poolResetAt?: number | undefined;
}): {
    at: number;
    source: 'retry-after' | 'text' | 'pool' | 'fallback';
};
/** 一条待续跑记录（落盘与 RPC 共用同一形状）。 */
export interface RateLimitResumeHook {
    readonly sessionId: string;
    readonly turn: number;
    readonly provider: string;
    readonly model: string;
    readonly kind: RateLimitResumeClass;
    /** 解禁时刻（面板展示、`noteAgentLive` 判「该不该抢跑」都读它）。 */
    readonly unlockAtMs: number;
    /** 下一次尝试时刻（解禁前 = 解禁时刻；投递失败后 = 现在 + 重试间隔）。 */
    readonly resetAtMs: number;
    readonly armed: boolean;
    readonly deferrals: number;
}
/** 一条决策流水（面板诊断用；只进内存）。 */
export interface RateLimitResumeDecision {
    readonly at: number;
    readonly sessionId: string;
    readonly message: string;
}
/** 引擎对外的可注入副作用（单测据此完整驱动「中断 → 等待 → 解禁 → 续跑」）。 */
export interface RateLimitResumeEngineOptions {
    readonly now?: () => number;
    readonly schedule?: (task: () => void, delayMs: number) => unknown;
    readonly cancel?: (handle: unknown) => void;
    /**
     * 落盘回调。
     *
     * ⚠️ 第三个参数 `resumes`（`sessionId → 已自动续跑次数`）**必须一起落盘**：
     * 那是跨钩子的寿命上限的计数，只存内存的话**重启就是绕过上限的后门**
     * （2026-11-21 对抗审计 P0 的配套要求）。
     */
    readonly persist?: (hooks: readonly RateLimitResumeHook[], enabled: boolean, resumes: Readonly<Record<string, number>>) => void;
    readonly readPoolReset?: (provider: string, model: string) => number | undefined;
    readonly deliver?: (hook: RateLimitResumeHook) => {
        ok: true;
    } | {
        ok: false;
        reason: string;
    };
    readonly note?: (decision: RateLimitResumeDecision) => void;
    readonly enabled?: boolean;
    /**
     * **环境变量级硬闸门**（`DSH_RATE_LIMIT_RESUME=0`）。为真时**界面也开不起来**。
     *
     * 审计实测（对抗 P1）：env=0 + 落盘 `enabled:true` 时，原生行为是「UI 一开就生效」
     * ⇒ 用户在宿主层面明确说「不要这个功能」，界面上点一下就能越过 —— 那不是开关，
     * 那是建议。语义上 env 是「这个宿主根本不要它」，用户开关是「我要不要」，
     * 两者必须取**与**，且 env 不可被 UI 覆盖。
     */
    readonly lockedOff?: boolean;
    readonly maxHooks?: number;
}
/**
 * 创建引擎（纯逻辑，不依赖 cordis）。
 *
 * @param options - 注入的副作用；省略即真实时钟 / `setTimeout`。
 * @returns 引擎。
 */
export declare function createRateLimitResumeEngine(options?: RateLimitResumeEngineOptions): {
    /**
     * 记录一次限流中断。
     *
     * @param input - 失败载荷、账号池给出的解禁时刻与目标会话。
     * @returns 新建的钩子快照；无法记录时 `undefined`。
     */
    noteInterruption(input: {
        readonly sessionId: string;
        readonly turn: number;
        readonly provider: string;
        readonly model: string;
        readonly kind: RateLimitResumeClass;
        readonly failure: unknown;
        readonly poolResetAt?: number | undefined;
    }): RateLimitResumeHook | undefined;
    /**
     * 会话真的开了新回合 ⇒ 这个中断已经没人在等，撤掉。
     *
     * ⚠️ 只由「非本次投递」的 `turn/start` 调用（接线层自己判）。
     */
    noteTurnStart(sessionId: string): void;
    /** 人类亲手发了消息 ⇒ 用户已经自己接了手，撤掉。 */
    noteUserMessage(sessionId: string): void;
    /** 某个会话的 agent 真的被销毁：**不撤钩子**（见模块头第 2 条），只记一笔。 */
    noteAgentGone(sessionId: string): void;
    /** 会话重新变成 live ⇒ 立刻补一次投递（用户一打开就续上）。 */
    noteAgentLive(sessionId: string): void;
    /**
     * 切换某个会话的 armed。
     *
     * @returns 更新后的快照；没有待续跑记录时 `undefined`（客户端据此收按钮）。
     */
    setArmed(sessionId: string, armed: boolean): RateLimitResumeHook | undefined;
    /** 立刻试一次（面板上的「立即继续」）。 */
    fireNow(sessionId: string): {
        ok: boolean;
        reason: string;
    };
    /** 改全局默认（只影响**之后**的中断）。 */
    setEnabled(value: boolean): boolean;
    /** 读当前状态（RPC 与持久化都走它）。 */
    status(): {
        enabled: boolean;
        hooks: readonly RateLimitResumeHook[];
        recent: readonly RateLimitResumeDecision[];
    };
    /** 按各自解禁时刻重排全部定时器（agents 就绪 / 宿主启动恢复后调用）。 */
    rearm(): void;
    /** 从持久化文档恢复。 */
    restore(list: unknown, savedResumes?: unknown): void;
    /** 丢掉某个会话的钩子（面板「移除」用）。 */
    forget(sessionId: string): void;
    /** 关闭引擎：清掉全部定时器（fiber 卸载时调用，必须幂等且不抛错）。 */
    dispose(): void;
};
/** 引擎类型（install 与 RPC 共用）。 */
export type RateLimitResumeEngine = ReturnType<typeof createRateLimitResumeEngine>;
/** 读 RPC 状态（客户端按钮与设置开关都走它）。 */
export declare function readRateLimitResumeState(sessionId?: string): {
    enabled: boolean;
    available: boolean;
    hooks: readonly RateLimitResumeHook[];
    recent: readonly RateLimitResumeDecision[];
};
/** 切换某个会话的 armed（RPC 用）。 */
export declare function setRateLimitResumeArmed(sessionId: string, armed: boolean): RateLimitResumeHook | undefined;
/** 改全局默认（RPC 用）。 */
export declare function setRateLimitResumeEnabled(enabled: boolean): boolean | undefined;
/** 立刻续跑一次（RPC 用）。 */
export declare function fireRateLimitResumeNow(sessionId: string): {
    ok: boolean;
    reason: string;
};
/** 移除某个会话的待续跑（RPC 用）。 */
export declare function forgetRateLimitResume(sessionId: string): void;
/**
 * 装上「限流中断后解禁再继续」。
 *
 * ⚠️ `agents` 用 `ctx.inject(['agents'], …)` 而**不**写进静态 `inject`：没有
 * agent-loop 的 profile 里静态 inject 会让本插件永久 pending、整个 profile
 * 起不来（与 `index.ts` 的 `inject` 注释同因）。缺席时只是投不出去。
 *
 * @param ctx - 插件上下文。
 * @param pool - 账号池（读限流标记；可选）。
 */
export declare function installRateLimitResume(ctx: Context, pool: AccountPool): void;
//# sourceMappingURL=rate-limit-resume.d.ts.map