/**
 * 活动徽标的**边界播报器**（GitHub issue #101 的保鲜腿）。
 *
 * ## 为什么必须有它
 *
 * 徽标是「此刻」的函数：一条夜间折扣的窗口是 23:00–7:50，7:50 一到它就该消失。
 * 而宿主模型选择器缓存的是**一次目录读取**的结果（客户端 ModelCatalogDirectory
 * 只在宿主事件上重读，见 catalog-broadcast.ts 的头注），本仓后台刷新器又是 20 分钟一轮。
 *
 * ⇒ 没有这条，「活动过期而徽标还在」最长持续 20 分钟；而**过期了却仍显示优惠**正是
 * issue #101 点名的事故形态（用户按优惠期选择、实际被按原价计费）。
 *
 * ## ⚠️ 播报为什么是零网络的
 *
 * 播报之后宿主重读目录 ⇒ 适配器 listModels ⇒ loadCatalog ⇒ ensureRemoteModels。
 * 最后一步在「目录完整且 20 分钟内读过」时**短路**（isCatalogFreshFor），于是这次重读
 * 只是**用新时钟把候选表重新求值一遍**，不打上游。这条是「边界一到就播报」可以常驻
 * 开启的前提 —— 若将来有人把徽标改成「必须重拉目录」，前提就破了，代价是每天最多
 * 两次真实的上游请求（一开一关各一次），那时本注释要跟着改。
 *
 * ## 三条判据
 *
 * 1. **只排最近的那一枚**：多个渠道各有一个边界，取最小值；播报后**重新问一次**
 *    边界（用播报之后的新状态），绝不复用旧值 —— 否则一条「窗口已关、徽标已消失」的
 *    活动会让定时器按同一个时刻反复空转。
 * 2. **Node 定时器上限**：setTimeout 的 delay 超过 2^31-1 毫秒（约 24.85 天）会
 *    **立刻触发**并打一条 TimeoutOverflowWarning。活动可以排在几个月后，所以必须
 *    **分片推进时钟**（每片不超过上限，逐片重算剩余），而不是「超过就不排」——
 *    后者等于把功能关掉，而症状是「几个月后的活动到时候不会自己消失」。
 * 3. **取不到边界就停表**，不是「退化成定时轮询」：上游没活动、未登录（目录还没落地）、
 *    时区读不懂 ⇒ 都返回 undefined。此时静默停表，等下一次目录落地由既有的
 *    catalog-broadcast 那条路把徽标带出来。拿「每 N 分钟醒一次」当兜底会让**所有**
 *    无活动的用户都在空转 —— 与 catalog-prewarm.ts 刻意「有界、不轮询」同一条理由。
 */
/** Node setTimeout 的安全上限（2^31-1 毫秒 ≈ 24.85 天）。超出会**立刻触发**。 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
/**
 * 两次播报之间的最小间隔（毫秒）。
 *
 * 防的是这一种自旋：边界恰好落在「已经过去几毫秒」时剩余时间为负，照排就立刻触发
 * ⇒ 播报 ⇒ 重算 ⇒ 若那时钟没有真正推进（假定时器、或同一毫秒内重入）⇒ 同一个边界
 * 再次胜出 ⇒ 广播风暴。一个真实的窗口边界一天只出现两次，5 秒下限不影响任何正常形态。
 */
export const MIN_EDGE_FIRE_GAP_MS = 5_000;
/** 全部来源里最近的边界；都没有 ⇒ undefined。单个来源抛错按「没有」处理。 */
export function nearestPromotionEdge(sources, nowMs) {
    let best;
    for (const source of sources) {
        let value;
        try {
            value = source();
        }
        catch {
            // 一家渠道的边界判据抛错不该让其余渠道失去保鲜（与后台刷新器「单家失败
            // 不得中断其余」同一条约束）。**不**因此停掉整张表。
            continue;
        }
        if (typeof value !== 'number' || !Number.isFinite(value))
            continue;
        // 过去的边界不排：那已经是「现在」，交给最小间隔那一腿处理。
        if (value <= nowMs)
            continue;
        if (best === undefined || value < best)
            best = value;
    }
    return best;
}
/**
 * 造一个边界播报器。
 *
 * 全部依赖注入 ⇒ 可完全离线单测（本仓约定：接线零守卫 = 删掉照样全绿）。
 */
export function createPromotionEdgeBroadcaster(options) {
    const now = options.now ?? (() => Date.now());
    let handle;
    let nextAt;
    /** 上一次真正播报的时刻（MIN_EDGE_FIRE_GAP_MS 的防自旋闸门）。 */
    let lastFiredAt;
    const clear = () => {
        // ⚠️ nextAt 与句柄**必须一起清**：只清句柄会让 nextFireAt() 继续报一个
        // 「已经没有定时器」的时刻 —— 而它是诊断面唯一的读数（stop() 之后仍显示
        // 「下一次在 T」，读的人据此以为功能还活着）。
        nextAt = undefined;
        if (handle !== undefined) {
            try {
                options.clearTimeoutImpl?.(handle);
            }
            catch {
                // 停表失败也要清引用：留着只会让下一次 clear 再抛一次，而句柄已无价值。
            }
            handle = undefined;
        }
    };
    const startTimer = (fn, delayMs) => {
        if (options.setTimeoutImpl !== undefined)
            return options.setTimeoutImpl(fn, delayMs);
        const timer = setTimeout(fn, delayMs);
        // 与既有定时器同款：不拦进程退出（插件释放后不该拖住宿主）。
        timer.unref?.();
        return timer;
    };
    const warn = (message) => {
        try {
            options.warn?.(message);
        }
        catch { /* 日志不该让功能失败 */ }
    };
    const schedule = () => {
        clear();
        const nowMs = now();
        let edge;
        try {
            edge = nearestPromotionEdge(options.edgeSources(), nowMs);
        }
        catch (error) {
            // 判据 3：连「有没有边界」都判不出来 ⇒ 停表，不猜一个时刻。
            warn('[jet-hub] 活动边界计算失败，本次不排定时器：' + String(error));
            return;
        }
        if (edge === undefined)
            return;
        const remaining = edge - nowMs;
        if (remaining > MAX_TIMER_DELAY_MS) {
            // 判据 2：分片**只推进时钟**（不播报），到点重新计算剩余。
            nextAt = edge;
            handle = startTimer(() => {
                handle = undefined;
                schedule();
            }, MAX_TIMER_DELAY_MS);
            return;
        }
        const delayMs = remaining < MIN_EDGE_FIRE_GAP_MS ? MIN_EDGE_FIRE_GAP_MS : remaining;
        nextAt = edge;
        handle = startTimer(() => {
            handle = undefined;
            const fireAt = now();
            if (lastFiredAt !== undefined && fireAt - lastFiredAt < MIN_EDGE_FIRE_GAP_MS) {
                // 防自旋：不播，但**必须重排**（直接 return 会让此后再也没有定时器，
                // 徽标永久停在旧的那一枚 —— 比不修更糟）。
                schedule();
                return;
            }
            lastFiredAt = fireAt;
            nextAt = undefined;
            // ⚠️ `fire` 的签名是 `void | Promise<void>`：`void` **不接 rejection**。
            // 只写 `void options.fire()` 时同步 throw 会被 catch 兜住，但**异步 reject
            // 会变成 unhandled rejection**（Node 默认终止进程）。当前生产 fire 是
            // `broadcastCatalogChanged`（同步 + queueMicrotask）⇒ 结构可达、零触发，
            // 但只要有人把它改成 async，这里就是一条「一播报就崩」的暗雷。
            try {
                const fired = options.fire();
                if (fired !== undefined && typeof fired.then === 'function') {
                    void fired.catch((error) => {
                        warn('[jet-hub] 活动边界播报失败（异步，照常继续排下一次）：' + String(error));
                    });
                }
            }
            catch (error) {
                warn('[jet-hub] 活动边界播报失败（照常继续排下一次）：' + String(error));
            }
            // ⚠️ 用播报**之后**的新状态重算：目录可能已被客户端重读、活动可能已下架。
            schedule();
        }, delayMs);
    };
    return {
        schedule,
        // 判据「stop 幂等」：第二次 stop 不得再调 clearTimeoutImpl（句柄已清）。
        stop() { clear(); },
        nextFireAt: () => nextAt,
    };
}
//# sourceMappingURL=promotion-edge-broadcast.js.map