/**
 * 「一键同步模型到 pi / ZCode」的**服务层**：目录采集 → 计划 → 落盘。
 *
 * ## 分层（为什么拆三个文件）
 *
 * | 文件 | 职责 | 是否碰磁盘 |
 * |---|---|---|
 * | `sync-targets.ts` | 纯计划：算新配置 + diff | 否 |
 * | `sync-apply.ts` | 备份 / 写入 / 复读校验 / 回滚 | 是 |
 * | 本文件 | 组装：取网关目录、逐目标兜错、编排 preview 与 apply | 是（经由上面两层） |
 *
 * ## 两条硬约定（沿用网关目录的既有口径）
 *
 * 1. **逐目标兜错**：一个目标解析失败（文件不存在、格式不认识）不能让另一个目标
 *    也报错——用户需要看到的正是「哪个目标有问题、为什么」。
 * 2. **不搬运密钥**：本模块只刷新模型列表与能力规则，`apiKey` 由 `plan*` 原样保留。
 *
 * @module src/sync-service.ts
 */
import { type GatewayModelSource } from './openai-gateway/models.js';
import { type SyncPaths } from './sync-apply.js';
import { type SyncDiff, type SyncModel, type SyncPlanOptions, type SyncTargetId } from './sync-targets.js';
/** 供本模块使用的最小 llm 形态（与网关目录采集接口同源，便于单测替身）。 */
export type SyncModelSource = GatewayModelSource;
/**
 * 外部工具实际要填的本机网关地址。
 *
 * ⚠️ 用 `127.0.0.1` 而**不是**网关的监听地址：开了「允许局域网访问」时监听地址是
 * `0.0.0.0`，但外部工具在本机连接必须写回环地址。端口仍跟随解析结果，
 * 避免用户改过端口后同步到旧端口。
 */
export declare function localGatewayBaseUrl(env?: NodeJS.ProcessEnv): string;
/**
 * 采集网关当前对外暴露的模型目录，归一成 {@link SyncModel}。
 *
 * id 采用 `<provider>/<model>` 形式：与 `/v1/models` 输出、以及 pi / ZCode 里
 * 现有条目的写法**逐字一致**（否则同步会造出一份对不上的新列表）。
 */
export declare function collectSyncModels(llm: SyncModelSource): Promise<SyncModel[]>;
/** 目录采集结果：模型 + 本次**读失败**的渠道。 */
export interface SyncCatalog {
    models: SyncModel[];
    /**
     * 本次 `listModels` 抛错的 provider。
     *
     * ⚠️ 必须一路透传到计划层：这些渠道的模型会从目录里消失，若照常判「已删除」，
     * **一次 token 过期就会把用户另外两个工具的该渠道模型全删掉**。
     */
    failedProviders: string[];
}
/**
 * 采集网关目录并记录失败渠道。
 *
 * ## ⚠️ 走 30 秒缓存，不要在这里裸采集
 *
 * `collectGatewayCatalogSnapshot` 是全链路唯一的采集入口（`/v1/models`、
 * `/v1/reasoning-efforts`、设置页 `gateway.getEnabled`、本模块四个调用点共用）。
 * 不缓存时一次采集 = 12 个 `listModels` + **每个模型**一次 `resolveModelInfo`
 * （实测 369 次）—— 而打开一次「同步模型」面板，组件挂载就连发两次 preview
 * ⇒ 738 次。
 *
 * 缓存对**保护集**尤其重要：`failedProviders` 与目录必须是同一份快照，
 * 否则 `previewSync` 与 `applySync` 各采一次、两次之间目录一变，
 * 保护集就漂移（旧缺陷：预览说「保留」、落盘却「删除」）。
 *
 * ## ⚠️⚠️ 必须补全 contextWindow（2026-11-11 真实报障）
 *
 * `llm.listModels()` 只保证返回 `{ id, name }` —— `contextWindow` 不在其中。
 * 网关的 `/v1/models` 之所以能给出 `context_window`，是因为它额外走了
 * `collectGatewayModelDetails()`（逐个 `resolveModelInfo`）+ `applyGatewayContextWindows()`。
 * 初版直接拿 `listModels` 的裸结果，于是 361 个模型**全部缺 contextWindow**
 * ⇒ 全被判为「不可写」⇒ 用户看到「已勾选 19/19」却「本次同步 0 个模型」。
 * 这里复用与网关**完全相同**的那条补全路径，两边才不会漂。
 *
 * ⚠️ 逐模型解析失败**不算渠道级失败**（渠道本身是好的，只是某几个模型
 * 拿不到窗口）：这些模型只会缺 `contextWindow` → 被下游判为 `skipped`，而
 * 「skipped 的模型如果目标里已有就必须保留」由 `planPiSync` / `planZcodeSync`
 * 负责（见 `src/sync-targets.ts` 的 skip 分支，保护粒度 = **单个模型**）。
 * 若把整条渠道塞进 `failedProviders`，一个模型抖动会冻结整条渠道
 * （新模型也进不来），反而更差。
 *
 * @param options.force 强制重新采集。⚠️ UI 的「刷新」按钮**必须**传 `true`，
 *   否则点刷新会命中缓存、看起来「没反应」。
 */
export declare function collectSyncCatalog(llm: SyncModelSource, options?: {
    readonly force?: boolean;
}): Promise<SyncCatalog>;
/** 单个目标的预览结果。 */
export interface SyncTargetPreview {
    target: SyncTargetId;
    path: string;
    /** 目标是否可用（文件存在且结构认得）。 */
    ok: boolean;
    /** `ok: false` 时的原因（直接展示给用户）。 */
    error?: string;
    diff?: SyncDiff;
}
/** 网关侧一个渠道的概况（UI 用它渲染「同步哪些渠道」的勾选列表）。 */
export interface SyncProviderInfo {
    id: string;
    /** 该渠道在网关目录里的模型数。 */
    modelCount: number;
    /** 该渠道的模型是否已出现在各目标里（决定默认勾选状态）。 */
    inTargets: Record<SyncTargetId, boolean>;
}
/** 预览结果（UI 据此渲染「将新增/移除/更新哪些模型」）。 */
export interface SyncPreviewResult {
    gatewayBaseUrl: string;
    /** 本次参与同步的模型数（已按 `providers` 过滤）。 */
    modelCount: number;
    /**
     * 其中**真正可写入**的模型数（contextWindow 齐全）。
     *
     * ⚠️ 与 `modelCount` 分开暴露是刻意的：两者不等时，说明目录里有一批模型
     * 因能力值缺失被跳过，而不是「没勾选渠道」—— 两者用一个数字表达，用户对着
     * 「已选 19/19、本次同步 0 个」完全无从判断到底哪里出了问题。
     */
    usableModelCount: number;
    /** 网关目录里的模型总数（未过滤，用于告诉用户「你只选了 30 / 369」）。 */
    totalModelCount: number;
    /** 本次请求实际收到的渠道白名单（未提供时为 `undefined`）。用于自证「勾了却匹配不到」。 */
    requestedProviders?: readonly string[];
    /** 网关侧全部渠道（**不受** `providers` 过滤，供 UI 勾选）。 */
    providers: SyncProviderInfo[];
    /** 本次采集失败的渠道（UI 必须显示：它们的模型是被保留而非"确认仍存在"）。 */
    failedProviders: string[];
    targets: SyncTargetPreview[];
}
/** 同步选项（单测用 home / env 覆盖，生产走默认）。 */
export interface SyncOptions {
    paths?: SyncPaths;
    home?: string;
    env?: NodeJS.ProcessEnv;
    /**
     * 强制重新采集网关目录（忽略 30 秒缓存）。
     *
     * ⚠️ 只有 UI 的「刷新」按钮该传 `true`。`sync.preview` 与 `sync.apply`
     * **必须看到同一份**目录，否则保护集会漂移（一个是 30 秒前的快照、
     * 一个是现在的，`failedProviders` 一变就「预览说保留、落盘却删除」）。
     */
    force?: boolean;
    /**
     * 只同步这些渠道（provider id）。缺省 = 目录里的全部渠道。
     *
     * ⚠️ 空数组表示「一个都没选」，与缺省**语义不同**：空数组会被当成
     * 「没有可写入的模型」而拒绝同步（否则等于把目标清空）。
     */
    providers?: readonly string[];
    /**
     * 只处理这些目标 agent。缺省 = 全部（pi 与 ZCode 都写）。
     *
     * ⚠️ 空数组与缺省**语义不同**：空数组 = 一个目标都没选，会被拒绝
     *（否则按钮看起来「成功」但什么都没发生）。
     */
    targets?: readonly SyncTargetId[];
}
/**
 * 计算预览：读取两个目标的当前配置，算出各自的 diff。
 *
 * **不写任何文件**。每个目标独立兜错：某个文件缺失只标记该目标 `ok:false`。
 */
export declare function previewSync(llm: SyncModelSource, options?: SyncOptions): Promise<SyncPreviewResult>;
/** 单个目标的落盘结果。 */
export interface SyncApplyEntry {
    target: SyncTargetId;
    path: string;
    /** 备份目录（回滚用，UI 必须显示给用户）。 */
    backupDir: string;
    diff: SyncDiff;
}
/** 落盘结果。 */
export interface SyncApplyResult {
    gatewayBaseUrl: string;
    modelCount: number;
    applied: SyncApplyEntry[];
    /** 未落盘的目标及原因（无变更 / 预览失败）。这些不是错误，但要说清楚。 */
    skipped: {
        target: SyncTargetId;
        path: string;
        reason: string;
    }[];
}
/**
 * `applySync` 的选项：在 `SyncOptions` 之上加两个**单测注入点**。
 *
 * 两个注入点都不是「为测试而存在」的抽象 —— 它们各自对应一条**无法从外部观测**
 * 的防御（写后幂等复算、写入失败回滚），只能靠替换协作者来证明它真的会拦。
 */
export interface SyncApplyOptions extends SyncOptions {
    /** 注入点：写入后的复读校验；生产用缺省幂等复算；单测可注入必失败函数验证回滚。 */
    validate?: (target: SyncTargetId, path: string) => void | Promise<void>;
    /**
     * 注入点：替换「目标 → 计划器」的装配。
     *
     * 生产用缺省。单测可以包一层，让 `plan` 在**第二次**调用（写后幂等复算）
     * 时返回非空 diff —— 这是唯一能验证那条防御真的生效的方式：正常实现下
     * `plan` 对刚写入的配置必然返回空 diff，删掉复算也不会影响任何用例（审计 M09）。
     */
    targetOps?: (target: SyncTargetId, paths: SyncPaths, models: readonly SyncModel[], gatewayBaseUrl: string) => {
        path: string;
        plan: (config: any, options?: SyncPlanOptions) => {
            config: any;
            diff: SyncDiff;
        };
    };
}
/**
 * 执行同步：逐目标重新读盘 → 重新算计划 → 备份 → 写入 → 复读校验。
 *
 * ⚠️ **不复用 preview 的结果**：preview 与 apply 之间用户可能手改过配置文件，
 * 用旧计划落盘会覆盖掉那次手改。这里重新读、重新算。
 *
 * ⚠️ diff 为空的目标**不写文件**：否则每次点按钮都会产生一份无意义的备份目录。
 *
 * ⚠️ **多目标是「全有或全无」**：任一目标写入失败，前面已写成功的目标会被
 *    逐个还原到原字节。用户点一次「同步」是一个原子意图，留下半改状态比失败更糟
 *    （见 `written` 的注释）。
 */
export declare function applySync(llm: SyncModelSource, options?: SyncApplyOptions): Promise<SyncApplyResult>;
//# sourceMappingURL=sync-service.d.ts.map