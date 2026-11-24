/**
 * **余额读数的磁盘缓存**（2026-11-20，用户要求「重启后积分窗口也快」）。
 *
 * ## 与 `balance-cache.ts` 的分工（**两层，不要混**）
 *
 * | 层 | 生命周期 | 谁负责 |
 * |---|---|---|
 * | **内存**（15 分钟 TTL） | 进程内 | `balance-cache.ts`（已存在，未改动） |
 * | **磁盘**（本模块） | 跨进程 | 本模块 |
 *
 * 内存层解决「同一会话内别重复打上游」；本模块解决「**重启后**第一眼别等 1 秒」。
 *
 * ## 写盘时机（用户 2026-11-20 明确指定，**只有这三个**）
 *
 * | 时机 | 由谁触发 | 作用 |
 * |---|---|---|
 * | ① **启动后首次拉取成功** | `markDirty()` 后由 flush 调度器写 | 保证下次启动**立刻**有缓存可读（最关键的一次） |
 * | ② **每隔 30 分钟** | 定时器 | 覆盖长会话，防止退出钩子失效丢太多 |
 * | ③ **插件卸载（退出）时** | `ctx.effect` 清理钩子 | 补最后一次读数 |
 *
 * ⚠️ **不在每次读数后写盘**：徽标每 60 秒轮询一次，那是**每天上千次**写盘，
 * 而余额的变化频率远低于此 —— 用户明确要求「减少不必要的缓存写盘」。
 *
 * ## 读盘时机
 *
 * **只在启动时读一次**（`primeFromDisk()`），把读数灌进内存层。
 * 之后所有读取都走内存层（15 分钟 TTL），与加本模块前完全一致。
 *
 * ## ⚠️ 静默（用户明确要求「前端不显示任何信息」）
 *
 * 本模块**不产生任何 UI 提示**、不记录「这是缓存读数」。用户看到的数字就是
 * 上次读到的值，后台会在几百毫秒内换成真实值（走既有 `broadcastCatalogChanged`
 * 之外的那条路径 —— 余额本来就有 60 秒轮询，下次轮询自然拿到新值）。
 *
 * ## ⚠️ 磁盘格式与原子写
 *
 * 与 `model-catalog-cache.ts` / `models-dev-cache.ts` 同款：
 * `version` 版本号 + **先写 `.tmp` 再 `rename`**（防半截 JSON）+ 解析失败一律降级。
 *
 * ## ⚠️ 为什么「写盘失败」必须静默
 *
 * 缓存是**纯优化**：磁盘满 / 权限 / 杀毒软件锁文件都只该少一次加速，
 * 绝不能让「读余额」因此失败。故所有写盘路径整段 `try/catch`。
 */
/** 开关磁盘缓存（**只给测试用**，生产路径不要调）。 */
export declare function setBalanceDiskCacheEnabledForTest(enabled: boolean): void;
/** 当前是否启用（诊断与单测用）。 */
export declare function isBalanceDiskCacheEnabled(): boolean;
/**
 * 缓存文件路径（`$DSH_HOME/jet-hub/cache/balance-readings.json`）。
 *
 * ## ⚠️ 2026-11-21：从 `$DSH_HOME/cache/balance-readings.json` 移到这里（用户要求）
 *
 * 用户原话：「缓存路径我觉得不对，应该路径中要有一级是以插件命名的文件夹，
 * 这样才方便知道是本插件的缓存」。
 *
 * ⇒ 移进本插件既有的持久化目录 `$DSH_HOME/jet-hub/` 下的 `cache/` 子目录
 *（与 `model-catalog-cache.ts` 同款）。理由与「为什么不放根下」见那边注释。
 *
 * ⚠️ **旧路径的孤儿由人工清理一次**（不做进代码，理由同 `model-catalog-cache.ts`）。
 */
export declare function balanceDiskCacheFile(): string;
/**
 * **写盘间隔**（用户 2026-11-20 明确指定为 30 分钟）。
 *
 * ## 为什么是 30 分钟（而不是「每次读数后」）
 *
 * 徽标每 **60 秒**轮询一次（`BADGE_POLL_MS`）⇒ 「每次读数后写盘」= 每天
 * **上千次**写盘。而余额变化频率远低于此，且内存层已有 15 分钟 TTL
 * ⇒ 30 分钟落一次盘（≈ 每 2 个 TTL 周期）足够覆盖变化。
 *
 * 用户原话：「每隔 30 分钟写盘就行。期间都是后台静默完成」。
 *
 * ⚠️ **改小它不会更快**（读数本来就来自内存层），只会增加写盘次数；
 * 改大则「强杀场景」丢的数据更多。30 分钟是用户定的取舍。
 */
export declare const BALANCE_DISK_FLUSH_INTERVAL_MS: number;
/**
 * **启动时读一次磁盘**，把读数灌回内存。
 *
 * ⚠️ 幂等（第二次调用直接返回）：它由 `balance-cache.ts` 的 `read()` 惰性触发，
 * 而 `read()` 会被高频调用。
 *
 * @returns 实际读到的条数（诊断与单测用）
 */
export declare function primeFromDisk(): number;
/**
 * 取某账号的**磁盘**缓存读数（没有则 `undefined`）。
 *
 * ⚠️ 调用方（`balance-cache.ts`）只在**内存未命中**时才问本函数，
 * 故这里不需要 TTL 判据 —— 用户明确要求「有缓存就先返回」。
 */
export declare function readDiskReading(provider: string, accountId: string): unknown | undefined;
export declare function noteDiskReading(provider: string, accountId: string, reading: unknown): void;
/** 本进程是否写过盘（诊断与单测用）。 */
export declare function hasFlushedThisProcess(): boolean;
/**
 * **真的把内存镜像写到磁盘**（原子写）。
 *
 * 调用点：**每次读数变化**（`noteDiskReading` 内部立即调）+ **30 分钟定时器**
 * （兜底）+ **退出钩子**。
 *
 * ⚠️ 2026-11-21 二次修订：原文写的是「启动首次成功 / 每 30 分钟 / 退出时」——
 * 那条口径已被推翻（用户实测重启后看到 50~176 分钟前的旧值：30 分钟没到就不写、
 * 而强杀时退出钩子根本不跑）。现在的主路径是「变化即写」，定时器与退出钩子只作兜底。
 *
 * @returns 是否写了（`false` = 没脏数据 / 被开关关掉 / 写失败）
 */
export declare function flushDisk(now?: number): boolean;
/** 是否有未落盘的读数（单测与诊断用）。 */
export declare function isDiskDirty(): boolean;
/** 清空内存与磁盘缓存（单测用）。 */
export declare function clearBalanceDiskCache(): void;
/**
 * 重置**模块级状态**（单测用，不动磁盘）。
 *
 * ⚠️ 与 {@link clearBalanceDiskCache} 的区别：那个连文件一起删。本函数只把
 * 「已读过盘 / 有脏数据」这两个标志复位，用于「同一个测试文件内换 `DSH_HOME`」
 * 的场景（不换会读到上一个用例的内存镜像）。
 */
export declare function resetBalanceDiskCacheStateForTest(): void;
//# sourceMappingURL=balance-disk-cache.d.ts.map