/**
 * 「默认思考档」的用户偏好（**独立文档**，跨重启保持）。
 *
 * ## 存的是什么
 *
 * 2026-11-11 的用户功能：在模型选择器里选完模型后，思考强度自动落在该模型
 * 支持的最高档（`max` / `extra_high` …），而不是各家适配器写死的 `high`。
 * 实现见 `src/reasoning-default.ts`（模块头有完整证据链）。
 *
 * 本文件只存**一个布尔**：开 = 取最强档（默认），关 = 逐字节回到改动前的行为。
 *
 * ## 为什么拆成独立文档，而不是塞进 state.json
 *
 * 与 `badge-preferences.ts` / `permanent-lock-store.ts` 同因：`state.json` 是
 * **dsh home 级、多 profile 共享**、且**整体替换**语义的文档。同机上另一条
 * 工作区里的旧版本代码不认识新字段，它做任何一次整体写入（加删账号、改模型
 * 开关）都会把新字段静默抹掉 —— 而「偏好被抹掉」的症状是**功能悄悄失效**，
 * 用户只会觉得「怎么又变回 high 了」，无法归因。
 *
 * 独立文档的读写者只有本文件，跨工作区天然互不干扰。
 *
 * ## 缺键语义：**开**
 *
 * 与 `sanitizeNativeWebSearchEnabled` 同一取向（`raw !== false`）：
 * 文档不存在 / 损坏 / 字段非法 / 被老版本代码重写时丢键 ⇒ 都回到**开**。
 *
 * ⚠️ 方向不能反。反过来（只认 `true`）会让**任何一次读取失败**都变成
 * 「功能被静默关掉」，而用户根本没有关过它。
 */
import type { Context } from '@deepseek-ai/cordis';
/** 独立文档的文件名（与 `state.json` / `ui-preferences.json` 同目录）。 */
export declare const REASONING_PREFERENCES_FILE = "reasoning-preferences.json";
/**
 * 归一化「默认取最强档」开关。
 *
 * 判据与 `sanitizeNativeWebSearchEnabled` **逐字同构**：**只有显式 `false` 才算关闭**，
 * 其余（缺键 / `true` / 字符串 / 对象 / 数组）一律按开启处理。
 *
 * ⚠️ 字符串 `'false'` **不算** `false`（与 `panelEntry` 那条同款）：那是脏数据，
 * 不是用户意图。
 *
 * @param raw - 文档里的原始值。
 * @returns 归一化后的开关值。
 */
export declare function sanitizeStrongestReasoningEnabled(raw: unknown): boolean;
/** 偏好文档后端的种类：文件（正常）或内存（无法定位 dsh home 时的显式降级）。 */
export type ReasoningPreferenceStoreKind = 'file' | 'memory';
/** 偏好文档的读写接口（同步读、异步写，与 `BadgePreferenceStore` 同款约定）。 */
export interface ReasoningPreferenceStore {
    readonly kind: ReasoningPreferenceStoreKind;
    /** 载入偏好；文档不存在 / 损坏 / 字段非法时返回默认值（开）。 */
    load(): boolean;
    /** 写入偏好（原子写）。 */
    save(enabled: boolean): Promise<void>;
}
/** 清空进程内缓存（供单测模拟「重启后重读」与「外部改文件」两种情形）。 */
export declare function resetReasoningPreferenceCache(): void;
/** 文件后端：`$DSH_HOME/jet-hub/reasoning-preferences.json`（原子写：tmp + rename）。 */
/**
 * 落盘实现。
 *
 * ⚠️ **导出只为单测注入接缝**（2026-11-13 对抗审计 P1-①）：RPC 层承诺「响应回**落盘值**
 * 而不是回传入参」，而那条承诺只在「`save()` 静默失败」时才可见 —— 单测要能把
 * `save` 换成「不抛错但不落盘」的桩，否则该条承诺永远无法被验证（实测把实现改成
 * 回传入参，165 条定向用例全绿）。生产代码**不要**直接 new 它，走
 * {@link createReasoningPreferenceStore}。
 */
export declare class FileReasoningStore implements ReasoningPreferenceStore {
    private readonly path;
    private readonly logger;
    readonly kind: "file";
    constructor(path: string, logger: {
        warn(message: string): void;
    } | undefined);
    load(): boolean;
    private readFromDisk;
    save(enabled: boolean): Promise<void>;
}
/**
 * 创建偏好后端。
 *
 * home 的解析与账号池 / 徽标偏好 / 锁定表**同一个函数**（`resolveJetHubHome`），
 * 保证几份文档永远落在同一目录 —— 否则会出现「账号池在 A 处、偏好文档在 B 处」的分裂。
 */
export declare function createReasoningPreferenceStore(ctx: Context): ReasoningPreferenceStore;
//# sourceMappingURL=reasoning-preferences.d.ts.map