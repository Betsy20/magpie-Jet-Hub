import { TtlCache } from '../ttl-cache.js';
import { effortView } from './effort-view.js';
export function toOpenAiModelId(provider, model) {
    return `${provider}/${model}`;
}
/**
 * 采集全量模型目录，**逐个 provider 兜住**。
 *
 * ⚠️ 不能直接 `Promise.all` 全部 provider：任一 provider 抛错（未登录、远端
 * 目录拉取失败）会让整个目录变成失败 —— 用户看到的是「网关坏了」，而真实原因
 * 只是某一个 provider 没登录。逐个跳过也让「无凭据的 provider 不出现在目录里」
 * 天然成立。
 *
 * ⚠️ **本函数承诺永不抛出**。它是「网关面板顺带展示的目录」，是附加信息，
 * 不该有能力把调用方（设置页状态读取、请求失败后的纠错建议）一起拖垮。
 * 故对下列畸形输入全部降级为空：方法缺失、`listProviders()` 返回非数组、
 * 某个 `listModels()` 返回非数组、provider 条目缺 id。
 * （`llm` 来自 DSH 的 service，真实形态与类型声明可能不一致，故不假设它守规矩。）
 */
export async function collectGatewayModels(llm, onError, 
/**
 * 覆盖 provider 列表（省略则用 `llm.listProviders()`）。
 *
 * 给设置页用：它有一条「`listProviders` 取不到时用已注册适配器的 key 兜底」
 * 的策略（`src/jet-hub-rpc.ts` 的 `providerIdsOf`），兜底结果必须能传进来。
 * ⚠️ 传了它就用它，**不再**调 `llm.listProviders()` —— 两处各算一份会让
 * 「设置页显示的渠道」与「实际采集的渠道」漂移。
 */
providersOverride) {
    let providers = [];
    try {
        const raw = providersOverride ?? llm?.listProviders?.();
        if (Array.isArray(raw))
            providers = raw.filter((entry) => typeof entry?.id === 'string');
    }
    catch (error) {
        onError?.('listProviders', error);
    }
    if (providers.length === 0)
        return [];
    const groups = await Promise.all(providers.map(async ({ id: provider }) => {
        try {
            const models = await llm.listModels(provider);
            if (!Array.isArray(models)) {
                onError?.(provider, new Error('listModels 未返回数组'));
                return undefined;
            }
            return { provider, models: models };
        }
        catch (error) {
            onError?.(provider, error);
            return undefined;
        }
    }));
    return groups.filter((group) => group !== undefined);
}
/**
 * 采集成设置页可直接渲染的 `{ id, name, input }` 列表。
 *
 * 与 {@link toOpenAiModels} 共用同一份采集逻辑与容错口径 —— 用户在设置页看到的
 * 与 `/v1/models` 返回的**必须**是同一批 ID 与同一份能力声明，两处各算一遍必然
 * 漂移，而漂移的症状是「照着设置页选的模型却不支持图片」。
 *
 * ⚠️ `input` 原样透传**不归一化**：它决定用户能否给该模型发图片，而各 provider
 * 的能力声明才是权威（`/v1/models` 的 HTTP 路径同样直接输出它）。
 * 缺失时归一化为 `['text']`，与各适配器「不声明即按 text 保守处理」一致
 * （见 lobsterai-adapter.ts）——宁可少报能力，也不要让用户发一张
 * 注定被上游拒绝的图。
 */
export async function collectGatewayModelIds(llm, onError, effortViews) {
    const groups = await collectGatewayModels(llm, onError);
    return toGatewayModelIds(groups, effortViews);
}
/**
 * 分组目录 → 扁平行（设置页/面板用）。
 *
 * ⚠️ 抽成**纯函数**是为了让「已经采集过分组与档位」的调用方直接复用，
 * 而不是再走一遍 `collectGatewayModelIds` 把目录拉第二次
 * （重复采集的症状是同一份清单里两次出现不同的档位）。
 */
export function toGatewayModelIds(groups, effortViews) {
    return groups.flatMap(({ provider, models }) => models.map((model) => {
        const id = toOpenAiModelId(provider, model.id);
        const reasoning = effortViews?.get(id);
        return {
            id,
            // ⚠️ 这两个字段**必须由这里给出**（见 `GatewayModelIdEntry` 的注释）：
            // 前端没有别的地方能拿到权威拆分。
            provider,
            model: model.id,
            name: model.name,
            input: Array.isArray(model.inputModalities) && model.inputModalities.length > 0
                ? [...model.inputModalities]
                : ['text'],
            ...reasoning === undefined ? {} : { reasoning },
        };
    }));
}
/**
 * 逐个模型解析档位与窗口（一次 `resolveModelInfo` 同时取两者）。
 *
 * 容错口径与旧实现一致：单个模型解析失败只让它没有附加字段，不影响整份目录；
 * 宿主没提供 `resolveModelInfo` 时返回两张空表。
 */
export async function collectGatewayModelDetails(llm, groups, onError) {
    const effortViews = new Map();
    const contextWindows = new Map();
    const resolve = llm?.resolveModelInfo;
    if (typeof resolve !== 'function')
        return { effortViews, contextWindows };
    await Promise.all(groups.flatMap(({ provider, models }) => models.map(async (model) => {
        const key = toOpenAiModelId(provider, model.id);
        try {
            const info = await resolve.call(llm, provider, model.id);
            const view = effortView(info?.reasoning?.efforts, info?.reasoning?.defaultEffort);
            if (view !== undefined)
                effortViews.set(key, view);
            const window = info?.context?.contextWindow;
            if (typeof window === 'number' && Number.isInteger(window) && window > 0) {
                contextWindows.set(key, window);
            }
        }
        catch (error) {
            onError?.(provider, new Error(`${model.id} 的附加信息解析失败（该模型不带档位/窗口，目录本身照常返回）：`
                + `${error instanceof Error ? error.message : String(error)}`));
        }
    })));
    return { effortViews, contextWindows };
}
/** 把解析到的窗口合并进目录项（未解析到的不写，不猜）。 */
export function applyGatewayContextWindows(groups, contextWindows) {
    if (contextWindows.size === 0)
        return [...groups];
    return groups.map(({ provider, models }) => ({
        provider,
        models: models.map((model) => {
            const window = contextWindows.get(toOpenAiModelId(provider, model.id));
            return window === undefined
                ? model
                : { ...model, contextWindow: model.contextWindow ?? window };
        }),
    }));
}
/**
 * 逐个模型解析**档位视图**（key = `provider/model`）。
 *
 * ## 为什么要单独解析
 *
 * DSH 的 `LlmModelInfo`（`listModels` 的产物）**不带**档位，档位只在
 * `resolveModelInfo` 的 `LlmResolvedModelInfo.reasoning` 里。而档位正是本网关
 * 最需要公开的东西 —— 各 provider 的档位 id 私有（`light` / `extra_high` /
 * `xhigh` / `on`），客户端不查就只能猜，猜错就是 400。
 *
 * ## 成本与容错
 *
 * 每个模型一次 `resolveModelInfo`：它读的是适配器**已缓存**的远端目录
 * （`listModels` 刚拉过），故不产生额外网络请求；DSH 自己的 `buildModelCatalog`
 * 也是「每个 provider listModels 后逐个 resolveModelInfo」的同一形状。
 * 逐模型 catch：单个模型解析失败只是**它**没有档位字段，不影响整个目录。
 */
export async function collectGatewayEffortViews(llm, groups, onError) {
    // 与窗口解析共用同一次逐模型 `resolveModelInfo`（见 GatewayModelDetails）。
    const { effortViews } = await collectGatewayModelDetails(llm, groups, onError);
    return effortViews;
}
/**
 * 网关目录缓存的有效期（毫秒）。
 *
 * ⚠️ 与 `src/model-catalog.ts` 的 20 分钟**刻意不同**：那里是「用户在 Jet Hub
 * 改完开关 ⇒ 该渠道目录必须立即失效」的交互目录（带 `invalidatedAt` 主动失效
 * 表）；这里是只读展示，30 秒的滞后不可感知，而每次命中省掉几百次
 * `resolveModelInfo`。
 */
const GATEWAY_CATALOG_TTL_MS = 30_000;
/**
 * 按 `llm` 实例分桶的目录缓存。
 *
 * ⚠️ 为什么 key 是 `llm` 而不是模块级单例：不同 ctx（不同会话）可能给不同
 * `llm` 对象，而它们的 provider 登录状态可能完全不同。模块级单例会让 A 会话
 * 的目录串到 B 会话 —— 症状是「明明没登录的渠道却出现在目录里」。
 */
const catalogCacheSlots = new WeakMap();
function catalogSlotFor(llm) {
    const existing = catalogCacheSlots.get(llm);
    if (existing !== undefined)
        return existing;
    const created = {
        cache: new TtlCache({
            ttlMs: GATEWAY_CATALOG_TTL_MS,
            load: () => loadGatewayCatalog(llm, created),
        }),
    };
    catalogCacheSlots.set(llm, created);
    return created;
}
async function loadGatewayCatalog(llm, slot) {
    const failedProviders = [];
    const markFailed = (provider, error) => {
        if (!failedProviders.includes(provider))
            failedProviders.push(provider);
        slot.onError?.(provider, error);
    };
    const groups = await collectGatewayModels(llm, markFailed, slot.providers);
    // ⚠️ 逐模型 `resolveModelInfo` 失败**不算渠道级失败**：渠道本身是好的，只是
    //    某几个模型拿不到窗口。这些模型会缺 `contextWindow`、被计划层判为
    //    `skipped`，而「skipped 的模型如果目标里已有就必须保留」由
    //    `src/sync-targets.ts` 的 skip 分支负责（保护粒度 = **单个模型**）。
    //    若在这里把整条渠道塞进 `failedProviders`，一个模型抖动会冻结整条渠道
    //    （新模型也进不来），反而更差。
    //
    //    但诊断信息仍要透出 —— 故这里把调用方的 `onError` 原样传下去。
    const details = await collectGatewayModelDetails(llm, groups, slot.onError);
    return { groups, details, failedProviders };
}
/**
 * 采集（或复用 30 秒内的）网关目录快照。
 *
 * ## 为什么必须缓存（真实缺陷）
 *
 * `collectGatewayModels` + `collectGatewayModelDetails` 每次都是**全量采集**：
 * 12 个 `listModels` 并发 + **每个模型**一次 `resolveModelInfo`（实测 369 次，
 * 全并发且无上限）。而这条链路上有四个**各自独立采集**的调用点：
 *
 * - `GET /v1/models`（`server.ts` 的 `handleModels`）
 * - `GET /v1/reasoning-efforts`（`server.ts` 的 `handleReasoningEfforts`）
 * - 设置页 `gateway.getEnabled`（`jet-hub-rpc.ts`）
 * - `sync.preview`（`sync-service.ts` 的 `collectSyncCatalog`）
 *
 * 后果（真实报障）：打开「同步模型」面板时组件挂载连发两次 preview
 * ⇒ **738 次** `resolveModelInfo`；每勾选一个渠道再 +369 次。
 *
 * ## 为什么 `details` 与 `groups` 必须**一起**缓存
 *
 * `collectGatewayModelDetails` 的入参就是 `groups`。分开缓存会让「第二次拿到的
 * `groups` 与 `details` 对不上」，症状是同一份清单里两次出现不同的档位/窗口。
 *
 * ## 为什么「部分失败」也缓存
 *
 * 两个采集函数都承诺**永不抛错**（失败走 `onError` 并降级为空/缺字段），故
 * `TtlCache` 的 `load` 不会抛错，缓存里存的是「一致的部分失败快照」。这正确：
 * 保护集（`failedProviders`）与目录**必须**来自同一次采集。
 *
 * @param options.force 强制重新采集。⚠️ UI 的「刷新」按钮**必须**传 `true`，
 *   否则点刷新会命中 30 秒缓存、看起来「没反应」。
 * @param options.onError 采集失败的诊断回调（**仅真正采集的那一次**触发）。
 */
export async function collectGatewayCatalogSnapshot(llm, options) {
    const slot = catalogSlotFor(llm);
    if (options?.onError !== undefined)
        slot.onError = options.onError;
    if (options?.providers !== undefined)
        slot.providers = options.providers;
    return slot.cache.get({ force: options?.force === true });
}
/**
 * 丢弃某个 `llm` 实例的目录缓存。
 *
 * 用于「用户刚登录/退出某渠道」这类**已知目录变化**的场景，以及单测清理。
 * 不需要手动调用的场景（绝大多数）靠 30 秒 TTL 自愈。
 */
export function clearGatewayCatalogCache(llm) {
    catalogCacheSlots.get(llm)?.cache.clear();
}
/** 将 DSH 的 provider 分组目录转换为 OpenAI models 响应中的 data 项。 */
export function toOpenAiModels(groups, effortViews) {
    return groups.flatMap(({ provider, models }) => models.map((model) => {
        const reasoning = effortViews?.get(toOpenAiModelId(provider, model.id));
        return {
            id: toOpenAiModelId(provider, model.id),
            object: 'model',
            created: 0,
            owned_by: provider,
            name: model.name,
            ...model.description === undefined ? {} : { description: model.description },
            ...model.contextWindow === undefined ? {} : { context_window: model.contextWindow },
            ...model.maxTokens === undefined ? {} : { max_tokens: model.maxTokens },
            ...model.inputModalities === undefined ? {} : { input: model.inputModalities },
            ...reasoning === undefined ? {} : { reasoning },
        };
    }));
}
//# sourceMappingURL=models.js.map