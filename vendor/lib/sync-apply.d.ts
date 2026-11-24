/**
 * 「同步到外部工具」的**磁盘层**：备份 → 写入 → 复读校验 → 失败回滚。
 *
 * ## 为什么备份和回滚必须在这里，而不是交给调用方
 *
 * 目标文件是**别人的应用配置**（pi 的 models.json、ZCode 的 provider_config.json）。
 * 写坏它们等于砸掉用户另外两个工具的模型列表。所以：
 * - 写之前先把原字节存成备份（回滚的唯一依据）；
 * - 写完立刻复读校验，失败就用原字节整体还原；
 * - 回滚发生时**备份仍保留**，用户可人工比对。
 *
 * ## 与 ZCode 侧 skill 的一致性
 *
 * 备份目录沿用 `backups/before-*-<时间戳>/` 的既有约定与 `indent 2 + 末尾换行` 的
 * 书写格式，使两处产出的文件字节风格一致。
 *
 * @module src/sync-apply.ts
 */
/** 同步涉及的绝对路径。 */
export interface SyncPaths {
    /** pi 的 provider/模型表。 */
    piModels: string;
    /** ZCode 的个人 provider 规则（含模型 id 列表与能力规则）。 */
    zcodeProviderConfig: string;
}
/** 磁盘层失败（读不到、写不了、格式不认识）。 */
export declare class SyncApplyError extends Error {
    constructor(message: string);
}
/**
 * 解析两个目标文件的路径。
 *
 * ## 为什么必须读环境变量，而不是只按 `homedir()` 拼
 *
 * 两个目标都有**官方支持**的目录覆盖点，写死默认路径会在用户设了它们之后
 * 悄悄写错文件（表现是「同步成功但目标里什么都没变」）：
 *
 * | 目标 | 覆盖变量 | 默认 |
 * |---|---|---|
 * | pi | `PI_CODING_AGENT_DIR`（pi 官方文档 environment-variables 明列） | `~/.pi/agent` |
 * | ZCode | `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`（官方 CLI 启动脚本自己就在设） | `~/.zcode/v2/provider_config.json` |
 *
 * `homedir()` 是**运行时**取的，所以换机器、换用户名都能用；这里只补上
 * 「同一个用户在别处覆盖过」这条路径。
 *
 * @param home 家目录（单测注入）
 * @param env 环境变量来源（默认 `process.env`）
 */
export declare function resolveSyncPaths(home?: string, env?: NodeJS.ProcessEnv): SyncPaths;
/**
 * 读取目标 JSON 配置。
 *
 * 用 `utf-8` 解码后手工剥掉 BOM：Windows 上被记事本/VS Code 保存过的文件常带 BOM，
 * `JSON.parse` 遇到它会直接抛「Unexpected token」。
 */
export declare function readJsonConfig<T = any>(path: string): T;
/**
 * 目标文件原有的书写风格（BOM + 换行符）。
 *
 * ## 为什么必须逐字节保留
 *
 * 这两个配置文件是**别人的应用**在读的，重写风格会带来两种真实伤害：
 * - **吞掉 BOM**：部分 Windows 工具（PowerShell 5 的 `Get-Content`、
 *   .NET 默认解码器）按系统 ANSI 代码页读，没 BOM 时中文模型名会变乱码；
 * - **把 CRLF 改成 LF**：用户的 `git diff` 从此显示整文件改动，
 *   下次手工合并冲突时无法分辨哪一行是真的变了。
 *
 * 两者都不是「格式偏好」，而是**别人文件的破坏性变更**，所以只能原样保留。
 */
export interface JsonFileStyle {
    /** 原文件是否带 UTF-8 BOM。 */
    bom: boolean;
    /** 原文件的换行符（整文件统一取「是否出现过 CRLF」）。 */
    eol: '\n' | '\r\n';
}
/** 从原文件的原始字节里读出书写风格。 */
export declare function detectJsonFileStyle(original: Buffer): JsonFileStyle;
/**
 * 按给定风格把 `config` 编码回字节。
 *
 * `JSON.stringify` 产出的换行符只可能是 `\n`（字符串值里的换行会被转义成字面量
 * `\n`），所以整体替换是安全的。
 */
export declare function encodeJsonConfig(config: unknown, style: JsonFileStyle): Buffer;
/**
 * 把 `config` 写入 `path`，并保证可回滚。
 *
 * @param validate 写入后的复读校验；抛错即触发回滚。缺省只验证「能解析回对象」。
 * @returns `backupDir`：本次备份目录（UI 要把它显示给用户）；
 *          `original`：写入前的原始字节（跨目标事务回滚用）
 */
export declare function applyJsonPlan(path: string, config: unknown, validate?: (path: string) => void | Promise<void>): Promise<{
    backupDir: string;
    backupFile: string;
    original: Buffer;
}>;
//# sourceMappingURL=sync-apply.d.ts.map