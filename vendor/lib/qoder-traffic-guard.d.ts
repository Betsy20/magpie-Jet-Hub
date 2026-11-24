/**
 * 这个错误是不是「**名额被占**」？（{@link SLOT_BUSY} 的结构化判定）
 *
 * ⚠️ 只认自家抛的那个对象：`instanceof LlmError` + Symbol 标记双判，避免把
 * 上游随便一个带同名属性的错误当成名额冲突。
 */
export declare function isQoderSlotBusy(error: unknown): boolean;
export type QoderTrafficProvider = 'qoder' | 'qodercn';
/** 未在面板设置时的默认值。 */
export declare function qoderTrafficGuardEnabled(): boolean;
/** 预留整个流的并发名额。账号忙时直接报告本地排队，避免积压请求。 */
export declare function acquireQoderRequest(provider: string, uid: string, signal?: AbortSignal): Promise<Disposable>;
//# sourceMappingURL=qoder-traffic-guard.d.ts.map