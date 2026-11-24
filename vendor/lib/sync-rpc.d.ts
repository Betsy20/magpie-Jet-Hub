/**
 * 「同步模型到外部工具」的 RPC 方法处理函数（**不是自注册端点**）。
 *
 * ## ⚠️ 为什么是被主 switch 调用，而不是自己 `rpc.register`
 *
 * 与 `opencode-rpc.ts` 完全同因（见那里的模块头与 2026-10-02 真实事故）：
 * Jet Hub 只有一条 RPC 通道，`jet-hub-rpc.ts` 的 `handleMethod` 用穷举 `switch`
 * 分发，`default` 直接回 `unknown method` 且**不让路**。自己注册的路径从来收不到请求。
 *
 * ⇒ 本文件只导出 {@link handleSyncRpc}，由 `handleMethod` 在 `switch` **之前**按
 * `sync.` 前缀调用；对不认识的方法返回 `undefined` 让主 switch 继续匹配。
 *
 * ## 返回约定
 *
 * 与 `opencode-rpc.ts` 一致：成功 `{ ok: true, value }`，失败 `{ ok: false, error }`。
 * 失败**一律不抛**：同步涉及"写别人的配置文件"，把异常留给上层会丢掉具体原因
 * （哪个目标、为什么），而用户需要的正是这句话。
 *
 * @module src/sync-rpc.ts
 */
import type { Context } from '@deepseek-ai/cordis';
import { type SyncOptions } from './sync-service.js';
/**
 * 可注入的同步选项。
 *
 * 生产调用（`jet-hub-rpc.ts` 的前缀改道）**不传**，走 `resolveSyncPaths()` 的默认路径；
 * 单测传 `{ home }` 把两个目标指到临时目录 —— 否则用例会读写用户真实的
 * `~/.pi` 与 `~/.zcode`。这层注入是刻意的：隐藏的全局 home 依赖会让
 * 「测试通过但删了用户配置」这种事变得可能。
 */
export type SyncRpcOptions = SyncOptions;
/**
 * 处理 `sync.*` 方法。
 *
 * @returns 处理结果；**方法不属于本前缀时返回 `undefined`**（交给主 switch）
 */
export declare function handleSyncRpc(ctx: Context, method: string, payload: unknown, options?: SyncRpcOptions): Promise<unknown>;
//# sourceMappingURL=sync-rpc.d.ts.map