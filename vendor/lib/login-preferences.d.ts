/**
 * 「新建账号时自动打开浏览器授权页」的用户偏好（**独立文档**，跨重启保持）。
 *
 * ## 存的是什么
 *
 * 2026-11-23 的用户功能：Jet Hub 设置里一个开关，控制「+ 新建账号」时是否
 * **自动打开**授权页。
 *
 * - **开（默认）**：宿主 / 客户端照旧自动开窗（= 本功能上线前的行为）；
 * - **关**：不自动开窗，把授权链接**复制到剪贴板**并显示在账号面板里，
 *   由用户手动打开。
 *
 * 本文件只存**一个布尔**：开 = 自动打开（默认），关 = 复制链接。
 *
 * ## 为什么拆成独立文档，而不是塞进 state.json
 *
 * 与 `badge-preferences.ts` / `reasoning-preferences.ts` 同因：`state.json` 是
 * **dsh home 级、多 profile 共享**、且**整体替换**语义的文档。同机上另一条
 * 工作区里的旧版本代码不认识新字段，它做任何一次整体写入（加删账号、改模型
 * 开关）都会把新字段静默抹掉 —— 而「偏好被抹掉」的症状是**功能悄悄失效**，
 * 用户只会觉得「怎么又自动开窗了」，无法归因。
 *
 * 独立文档的读写者只有本文件，跨工作区天然互不干扰。
 *
 * ## 缺键语义：**开**
 *
 * 与 `sanitizeStrongestReasoningEnabled` / `sanitizeNativeWebSearchEnabled`
 * 同一取向（`raw !== false`）：文档不存在 / 损坏 / 字段非法 / 被老版本代码
 * 重写时丢键 ⇒ 都回到**开**。
 *
 * ⚠️ 方向不能反。反过来（只认 `true`）会让**任何一次读取失败**都变成
 * 「自动开窗被静默关掉」，而用户根本没有关过它 —— 那正是「新建账号不跳登录页」
 * 这类报障的形态。
 */
import type { Context } from '@deepseek-ai/cordis';
/** 独立文档的文件名（与 `state.json` / `ui-preferences.json` 同目录）。 */
export declare const LOGIN_PREFERENCES_FILE = "login-preferences.json";
/**
 * 归一化「自动打开浏览器授权页」开关。
 *
 * 判据与 `sanitizeStrongestReasoningEnabled` **逐字同构**：**只有显式 `false`
 * 才算关闭**，其余（缺键 / `true` / 字符串 / 对象 / 数组）一律按开启处理。
 *
 * ⚠️ 字符串 `'false'` **不算** `false`（与 `panelEntry` 那条同款）：那是脏数据，
 * 不是用户意图。
 *
 * @param raw - 文档里的原始值。
 * @returns 归一化后的开关值。
 */
export declare function sanitizeAutoOpenBrowserEnabled(raw: unknown): boolean;
/** 偏好文档后端的种类：文件（正常）或内存（无法定位 dsh home 时的显式降级）。 */
export type LoginPreferenceStoreKind = 'file' | 'memory';
/** 偏好文档的读写接口（同步读、异步写，与 `ReasoningPreferenceStore` 同款约定）。 */
export interface LoginPreferenceStore {
    readonly kind: LoginPreferenceStoreKind;
    /** 载入偏好；文档不存在 / 损坏 / 字段非法时返回默认值（开）。 */
    load(): boolean;
    /** 写入偏好（原子写）。 */
    save(enabled: boolean): Promise<void>;
}
/** 清空进程内缓存（供单测模拟「重启后重读」与「外部改文件」两种情形）。 */
export declare function resetLoginPreferenceCache(): void;
/**
 * 文件后端：`$DSH_HOME/jet-hub/login-preferences.json`（原子写：tmp + rename）。
 *
 * ⚠️ **导出只为单测注入接缝**：RPC 层承诺「响应回**落盘值**而不是回传入参」，
 * 而那条承诺只在「`save()` 静默失败」时才可见 —— 单测要能把 `save` 换成
 * 「不抛错但不落盘」的桩态。生产代码**不要**直接 new 它，走
 * {@link createLoginPreferenceStore}。
 */
export declare class FileLoginPreferenceStore implements LoginPreferenceStore {
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
 * home 的解析与账号池 / 徽标偏好 / 锁表 / 思考档偏好**同一个函数**
 * （`resolveJetHubHome`），保证几份文档永远落在同一目录 —— 否则会出现
 * 「账号池在 A 处、偏好文档在 B 处」的分裂。
 */
export declare function createLoginPreferenceStore(ctx: Context): LoginPreferenceStore;
/**
 * 接线「自动打开浏览器」偏好的读取来源（`src/index.ts` 的 `apply()` 调用）。
 *
 * 传 `undefined` 可清空来源（单测复位用）。
 */
export declare function configureAutoOpenBrowserEnabled(next: (() => boolean) | undefined): void;
/**
 * 此刻是否应当**自动打开浏览器授权页**（缺省 = 开）。
 *
 * - 未接线（单测 / 非 Web profile）：返回 `true` —— 与功能上线前逐字节相同；
 * - 来源抛错：返回 `true`（**绝不让读取失败静默关闭功能**）；
 * - 来源返回值不是布尔：按开启处理（`!== false`）。
 */
export declare function autoOpenBrowserEnabled(): boolean;
//# sourceMappingURL=login-preferences.d.ts.map