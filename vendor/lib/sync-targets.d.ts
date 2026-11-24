/**
 * 「把网关模型目录同步到外部 agent」的**纯计划层**。
 *
 * ## 职责边界（接线 RPC 时不许越界）
 *
 * - 输入：目标文件的**当前内容**（已 parse 的对象）+ 网关模型目录 + 网关地址；
 * - 输出：新文件内容 + diff；
 * - **不碰磁盘**：不读路径、不备份、不写文件（那是 `sync-apply.ts` 的事）。
 *
 * 这样所有行为都能用内存对象断言，不需要临时目录，也不会在单测里写用户的真实配置。
 *
 * ## 为什么按 baseUrl 定位而不是写死 providerId
 *
 * 两边的网关 provider 都是**用户手工加的**：pi 里叫 `dsh-gateway`、ZCode 里叫
 * `dsh-openai-gateway`，但用户随时可能改名。写死 id 会在改名后静默匹配失败
 * （表现为「同步成功但什么都没变」）。因此按端点匹配，改名免疫。
 *
 * ## 目标文件的结构差异（这是本模块存在的根本原因）
 *
 * | 目标 | 模型能力信息存在哪 |
 * |---|---|
 * | pi | **自描述**：`providers.<k>.models[]` 每项自带 contextWindow/maxTokens |
 * | ZCode | **不自描述**：provider 里只有 id 列表，能力来自 `modelConfigRules.providerModelRules` 的匹配 |
 *
 * ⇒ ZCode 侧只写 id 列表**是不够的**：规则里没有 contextWindow 时，ZCode 读目录会报
 * `Missing token limits`。所以 {@link planZcodeSync} 必须同时 upsert 规则。
 *
 * @module src/sync-targets.ts
 */
/** 一条要同步出去的模型（由调用方从 `ctx.llm.listModels()` 归一化而来）。 */
export interface SyncModel {
    /** 模型 id（网关返回的 `<provider>/<model>` 形式，转发时用它）。 */
    id: string;
    /** 展示名；缺省用 id。 */
    name?: string;
    contextWindow: number;
    /**
     * 输出上限。**可选**：网关的适配器普遍不声明它（实测 `/v1/models` 369 个模型
     * 无一带 `max_tokens`）。缺失表示「不知道」，此时**省略该字段**让目标用自己的
     * 默认值，而不是拿一个猜出来的数写进别人的配置。
     */
    maxTokens?: number;
    /** 输入模态，如 `['text', 'image']`。 */
    input: readonly string[];
}
/** 支持同步的目标。 */
export type SyncTargetId = 'pi' | 'zcode';
/** 一次同步的变更摘要（UI 用它渲染预览）。 */
export interface SyncDiff {
    /** 新增到目标的模型 id。 */
    added: string[];
    /** 从目标移除的模型 id。 */
    removed: string[];
    /** 已存在但能力值（contextWindow / maxTokens）发生变化的模型 id。 */
    updated: string[];
    /** 因能力值非法而被跳过的模型 id（目录侧数据问题，需显式暴露给用户）。 */
    skipped: string[];
    /**
     * 因所属渠道**本次采集失败**而被原样保留的模型 id。
     *
     * ⚠️ 这些模型**不在**本次目录里（渠道没读到），但**刻意不删**：
     * 渠道临时失败（token 过期、网络抖动）与渠道真下架在目录上长得一模一样，
     * 一律判 `removed` 会造成「一次登录失效就把用户两个工具的模型删光」。
     */
    protectedModels: string[];
}
/** 计划选项。 */
export interface SyncPlanOptions {
    /**
     * 本次目录采集**失败**的 provider id。
     *
     * 这些渠道下的模型一律保留为目标现状（既不新增也不删除）——
     * 见 {@link SyncDiff.protectedModels}。
     */
    failedProviders?: readonly string[];
}
/** 从模型 id 里取 provider 段（`<provider>/<model>`；模型名本身可含 `/`，故只切首个）。 */
export declare function providerOfModelId(id: string): string;
/** 计划阶段的失败（目标 provider 不存在、文件结构不认识等）。 */
export declare class SyncPlanError extends Error {
    constructor(message: string);
}
/** pi models.json 的最小形状（只声明本模块真正读写的字段）。 */
interface PiConfig {
    providers?: Record<string, any>;
}
/**
 * 在 pi 的 models.json 里按端点找到网关 provider 的键名。
 *
 * @throws {SyncPlanError} 找不到时抛错并点名端点（不擅自新建 provider —— 那需要 apiKey）
 */
export declare function findPiProvider(config: PiConfig, gatewayBaseUrl: string): string;
/** ZCode provider_config.json 的最小形状。 */
interface ZcodeConfig {
    config?: {
        providerOrder?: string[];
        providerConfigRules?: {
            providerRules?: any[];
        };
        modelConfigRules?: {
            providerModelRules?: any[];
            manualProviderModelRules?: any[];
        };
    };
}
/**
 * 在 ZCode 的 provider_config.json 里按 `config.api.baseUrl` 找网关 provider。
 *
 * @throws {SyncPlanError} 找不到时抛错（同样不擅自新建）
 */
export declare function findZcodeProvider(config: ZcodeConfig, gatewayBaseUrl: string): string;
/**
 * 规划 pi 侧同步：刷新网关 provider 的 `models[]`。
 *
 * ## 三条不变量
 *
 * 1. **按模型 id 保留 pi 本地字段**：`reasoning` / `thinkingLevelMap` / `compat` 是 pi
 *    独有配置，网关目录里没有对应来源。不保留会让用户手调的思考档位与兼容开关归零。
 * 2. **不搬运密钥**：`apiKey` / `baseUrl` / `api` 原样保留（两边本来就有）。
 * 3. **外科手术**：同文件里其它 provider 一个字节都不动。
 */
export declare function planPiSync(config: PiConfig, models: readonly SyncModel[], gatewayBaseUrl: string, options?: SyncPlanOptions): {
    config: PiConfig;
    diff: SyncDiff;
};
/** 渠道 id → 它在 ZCode 里对应的 provider id（如 `codearts` → `dsh-codearts`）。 */
export declare function zcodeProviderIdFor(channel: string): string;
/**
 * `zcodeProviderIdFor` 的逆运算：从 providerId 反推渠道名。
 * 不带前缀的 provider 返回 `''`（它不是本功能生成的）。
 */
export declare function channelOfZcodeProviderId(providerId: string): string;
/**
 * 规划 ZCode 侧同步：**每个网关渠道一个 provider**。
 *
 * ## 为什么不是「一个 provider 装全部模型」
 *
 * 初版沿用用户的既有形态（`dsh-openai-gateway` 一条 + 168 个带渠道前缀的模型），
 * 结果 ZCode 的模型选择器里所有渠道的模型都折叠在 `dsh` 一个条目下，与 pi 里
 * 「按渠道铺开」的观感不一致。现改为每渠道一条，provider 的 group / access（含
 * apiKey）/ api（含 baseUrl）/ 启用状态全部继承原条目。
 *
 * ## 三条不变量
 *
 * 1. **模型 id 仍带渠道前缀**（`codearts/GLM-5.2`）：网关靠首个 `/` 之前做路由，
 *    去掉前缀它就不认了；
 * 2. **受保护渠道整条不动**：采集失败 / 用户未勾选的渠道，其 provider 与能力规则
 *    原样保留（只把 id 迁成 `dsh-<渠道>` 以统一结构）；
 * 3. **外科手术**：非管理范围的 provider 与其能力规则一个字节都不动。
 */
export declare function planZcodeSync(config: ZcodeConfig, models: readonly SyncModel[], gatewayBaseUrl: string, options?: SyncPlanOptions): {
    config: ZcodeConfig;
    diff: SyncDiff;
};
/**
 * 读出 pi 配置里网关 provider 当前已配置的模型 id。
 *
 * 找不到网关 provider 时返回**空数组而不抛错**：本函数服务于「UI 展示哪些渠道
 * 已在目标里」这种附加信息，目标还没配网关是正常状态（用户尚未加过），
 * 不该让整个预览因此失败。
 */
export declare function existingPiModelIds(config: PiConfig, gatewayBaseUrl: string): string[];
/**
 * 读出 ZCode 配置里**所有**网关 provider 当前已配置的模型 id（汇总，跨渠道）。
 *
 * 找不到网关 provider 时返回空数组而不抛错：本函数服务于「UI 展示哪些渠道已在
 * 目标里」这种附加信息，目标还没配网关是正常状态。
 */
export declare function existingZcodeModelIds(config: ZcodeConfig, gatewayBaseUrl: string): string[];
/** diff 是否为空（UI 用它决定「无需同步」而不是让用户点一个什么都没做的按钮）。 */
export declare function isDiffEmpty(diff: SyncDiff): boolean;
/**
 * 对外暴露「可写入模型」的拆分结果。
 *
 * 调用方（`sync-service.ts`）必须用它在落盘前判定「可写列表是否为空」：
 * 目录里**有模型但能力值全都非法**时，`models.length !== 0` 却同样会算出
 * 一份空列表 ⇒ 把目标现有模型全部判为已删除。两种情形必须同样拒绝。
 */
export declare function splitUsableModels(models: readonly SyncModel[]): {
    ok: SyncModel[];
    skipped: string[];
};
export {};
//# sourceMappingURL=sync-targets.d.ts.map