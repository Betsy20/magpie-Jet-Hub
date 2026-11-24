/**
 * **模型目录的磁盘缓存**（2026-11-20，用户要求「重启后无感加载」）。
 *
 * ## 它解决什么
 *
 * 冷启动时宿主 `buildModelCatalog` 会对**每个** provider `await listModels()`，
 * 而目录只能从上游现拉 ⇒ 实测首屏 **~2 秒**（各家网络往返里最慢那家决定）。
 *
 * ⚠️ 这不是可选优化：`resolveModel` 也会 `await loadCatalog()`，宿主会对
 * **每个模型**再调一次 —— 目录没落地时这条路径同样等网络。
 *
 * ## 方案：stale-while-revalidate（用户原话「先使用缓存的数据，等远端拉取
 * 完成后就无感使用远端真实数据替换缓存数据」）
 *
 * ```
 * listModels()
 *   ├─ ① 同步读磁盘缓存（<10ms）⇒ **立即返回**（可能是上次的目录）
 *   ├─ ② 后台拉远端（不阻塞 ①）
 *   └─ ③ 成功 ⇒ 写盘 + 广播 `llm/adapters-updated` ⇒ 宿主重读 ⇒ **无感替换**
 * ```
 *
 * ⚠️ 第 ③ 步的「无感替换」**不需要本模块做任何事** —— 各适配器早已在目录落地时
 * 调 `onCatalogLoaded` → `broadcastCatalogChanged(ctx)`，那正是宿主的重读信号。
 * 本模块只负责「读盘」与「写盘」两件事。
 *
 * ## ⚠️⚠️ 只在 `complete === true` 时写盘（硬约束）
 *
 * `RemoteCatalogGate` 把 `got`（拿到非空）与 `complete`（**所有来源**拿全）
 * 分开了。写盘必须判后者：
 *
 * - cline 有 **3 个来源**（`recommended-models` + `/api/v1/models` + models.dev）；
 * - 若只拿到 2 个就落盘 ⇒ **残缺目录被固化成「上次的好缓存」**；
 * - 下次启动读到它 ⇒ 那 466 条按量计费模型**永久消失**（只能删缓存文件才能恢复）。
 *
 * 这条与 `RemoteCatalogGate` 的既有语义**完全一致**（它也只按 `complete` 清冷却），
 * 由 `tests/unit/model-catalog-cache.spec.ts` 的「残缺不落盘」一组用例钉住。
 *
 * ## ⚠️ 磁盘格式与原子写
 *
 * 与 `models-dev-cache.ts` 同款（那套已验证过）：
 * - **先写 `.tmp` 再 `rename`**：直接 `writeFile` 时进程中途被杀会留下半截 JSON，
 *   下次冷启动解析失败 ⇒ 缓存彻底失效**且静默**；
 * - `version` 字段：格式演进时旧文件被**丢弃**而不是被当成有效数据；
 * - 解析失败一律 `try/catch` 回退（**缓存坏了不能影响功能**）。
 *
 * ## 为什么不设 TTL 上限
 *
 * 用户的取舍原话：「有缓存就先返回，后台会自动远端拉取，然后自动替换缓存，
 * 所以没必要丢弃缓存，加快展示是目标」。
 *
 * ⇒ 本模块**不判 `at` 是否太旧**：任何能解析出来的缓存都会先返回，
 * 新鲜度由各适配器的 `isCatalogFresh` + 后台刷新负责。最坏情况是用户看到
 * 一天前的模型列表**几百毫秒**，随后被真实目录替换 —— 比空白或等 2 秒好。
 *
 * ⚠️ 但**必须有「不新鲜就触发后台刷新」的判据**，否则会永远停在缓存上。
 * 那由调用方（骨架）用 `isCatalogFresh` 判，本模块只管存取。
 */
import type { CatalogEntry } from './model-catalog.js';
/**
 * 开关磁盘缓存（**只给测试用**，生产路径不要调）。
 *
 * ⚠️ 关闭后 {@link readCatalogCache} 恒返回 `undefined`、{@link writeCatalogCache}
 * 恒返回 `false` —— 即「完全没有缓存」的形态，调用方行为回到加缓存前。
 */
export declare function setCatalogCacheEnabledForTest(enabled: boolean): void;
/** 当前是否启用（诊断与单测用）。 */
export declare function isCatalogCacheEnabled(): boolean;
/**
 * 缓存目录（`$DSH_HOME/jet-hub/cache/model-catalog`）。
 *
 * ## ⚠️ 2026-11-21：从 `$DSH_HOME/cache/model-catalog` 移到这里（用户要求）
 *
 * 用户原话：「缓存路径我觉得不对，应该路径中要有一级是以插件命名的文件夹，
 * 这样才方便知道是本插件的缓存」。
 *
 * 改前放在 `$DSH_HOME/cache/` 下，与**上游第三方**的缓存（`models-dev.json`、
 * `opencode-capabilities.json`）混在一起 —— 用户在那个目录里根本分不清
 * 「哪些是插件自己的、哪些是上游数据的镜像」。
 *
 * ⇒ 移进 **`$DSH_HOME/jet-hub/`**（本插件既有的持久化目录，`state.json` /
 * `permanent-locks.json` / `auto-checkin.json` 都在这里）下的 `cache/` 子目录。
 *
 * ⚠️ **为什么不直接放 `jet-hub/` 根下**：根下的文件是**状态**（丢了会影响
 * 功能，比如账号池、锁定表）；缓存是**纯优化**（丢了只是慢一次）。
 * 分开放让「可以安全删除」这件事一眼可见。
 *
 * ⚠️ **旧路径的孤儿由人工清理一次**（不做进代码）：迁移是一次性运维动作，
 * 把它写成启动钩子会让插件永久背一段只对老用户有用的死代码，
 * 且每次启动都要 `existsSync` 一次。
 */
export declare function modelCatalogCacheDir(): string;
/**
 * 某 provider 的缓存文件路径。
 *
 * ⚠️ **provider id 必须过一遍白名单净化**：它来自 `product.id`，正常形态是
 * `[a-z]+`，但缓存路径直接拼字符串 ⇒ 一个含 `../` 的 id 会写到目录外。
 * 这里不抛错（那是调用方的问题），只把非法字符替换成 `_`，保证**路径不逃逸**。
 */
export declare function modelCatalogCacheFile(provider: string): string;
/**
 * **同步**读某 provider 的磁盘目录缓存。
 *
 * 同步是刻意的（与 `models-dev-cache.ts` 的 `loadDiskCacheSync` 同因）：
 * 它跑在 `listModels` 的**渲染路径前置**，异步会让首屏多等一个 microtask 轮次，
 * 而文件只有几十 KB。实测 readFileSync + parse ≈ 1~5ms。
 *
 * @returns 目录条目；**没有缓存 / 解析失败 / 版本不符 / 形状非法**一律 `undefined`
 *（调用方据此走「无缓存」路径，即原来的兜底表 + 立即拉远端）。
 */
export declare function readCatalogCache(provider: string): readonly CatalogEntry[] | undefined;
/**
 * 写某 provider 的目录缓存（原子写：`tmp` → `rename`）。
 *
 * ## ⚠️ 两条必须守的不变式
 *
 * 1. **`complete` 必须为 `true`** —— 残缺目录不得落盘（模块头的硬约束）。
 *    本函数把它做成**必填参数**且只接受字面量 `true`，让「传 false」在类型层
 *    就不可能（调用方若确实拿到残缺目录，应当**根本不调用**本函数）。
 * 2. **空目录不写盘** —— 那会把磁盘上已有的好数据覆盖成空文件 ⇒ 下次冷启动
 *    真的什么都没有。这与 `models-dev-cache` 的
 *    「空结果不写盘」是同一条不变式。
 *
 * ## ⚠️ 写盘失败**不抛错**
 *
 * 缓存是**纯优化**：写不进去（磁盘满 / 权限 / 杀毒软件锁文件）只该少一次加速，
 * 绝不能让 `listModels` 因此失败。故整段 `try/catch` 并返回布尔。
 *
 * @returns 是否真的写成功（供诊断与单测；调用方通常忽略）
 */
export declare function writeCatalogCache(provider: string, entries: readonly CatalogEntry[], complete: true, now?: number): boolean;
/** 删掉某 provider 的缓存（诊断 / 单测用；生产路径不需要）。 */
export declare function clearCatalogCache(provider: string): void;
/**
 * 读某 provider 缓存的写入时刻（`0` = 没有缓存）。
 *
 * ⚠️ 只给**诊断与单测**用。生产路径**不判过期**（见模块头），故没有
 * 「超过 X 就丢弃」的判据读它。
 */
export declare function readCatalogCacheAt(provider: string): number;
//# sourceMappingURL=model-catalog-cache.d.ts.map