import type { RaccoonProduct } from './raccoon-product.js';
import { type RaccoonCredential } from './raccoon.js';
/** 仅供测试：清空去重集合（生产路径不会调用）。 */
export declare function resetRaccoonIamConfirmCacheForTest(): void;
/**
 * 确保该凭据的业务会话已确认。**永不抛错**，返回是否「已确认」。
 *
 * ⚠️ 调用点应当**忽略返回值**直接继续（确认失败时业务 API 会给出更准的错误），
 *    只有需要诊断时才读它。
 */
export declare function ensureRaccoonSessionConfirmed(product: RaccoonProduct, credential: RaccoonCredential, fetcher: typeof fetch, 
/**
 * ★★★ **调用方的取消信号**（2026-11-23 五改，对抗审计 P1-⑥）。
 *
 * 第一版只用了 `AbortSignal.timeout(...)` ⇒ 实测 `iam/confirm` 的 signal
 * **不是** `stream()` 的 `options.signal` ⇒ 用户点「停止」**取消不了这条握手**，
 * 而它挂在对话请求**前面** ⇒ 停止键在最需要它的场景里失效。
 *
 * ⚠️ 与超时**合并**（`AbortSignal.any`）而不是二选一：两者都要生效。
 */
signal?: AbortSignal): Promise<boolean>;
//# sourceMappingURL=raccoon-iam-confirm.d.ts.map