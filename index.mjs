/**
 * magpie 插件入口 —— 每个本体 provider 一个插件工厂。
 *
 * ⚠️⚠️ **只导出插件工厂，绝不导出工具函数/常量对象**（2026-10-27 实测真缺陷）。
 *
 * magpie 宿主加载插件时会**遍历模块的全部导出**并探测性调用 —— 只要有一个
 * 导出不是「插件工厂」形状，就会被无参调用后抛错，**整个插件加载失败**
 * （`plugin list` 报 failed）。
 *
 * 所以这里**只有 19 个具名工厂 + 1 个旧名别名之外什么都不导出**；常量表
 * （`PROVIDER_IDS` / `DSH_PROVIDERS` / `idOf`）都留在 `src/plugin.mjs` 里，
 * 需要时从那里 import。
 */
import { PLUGINS, PROVIDER_IDS } from './src/plugin.mjs'

const byId = new Map(PLUGINS)

/** 少一个 id 就是导出契约漏了 —— 加载即抛，别让它静默变成 18 个 provider。 */
for (const id of PROVIDER_IDS) {
  if (typeof byId.get(id) !== 'function') throw new Error(`magpie-jet-hub: 缺少 provider 工厂 ${id}`)
}

/** 本体 `aggregate`（magpie id `jet-hub-aggregate`）。 */
export const JetHubAggregatePlugin = byId.get('jet-hub-aggregate')

/** 本体 `astudio`（magpie id `jet-hub-astudio`）。 */
export const JetHubAstudioPlugin = byId.get('jet-hub-astudio')

/** 本体 `autoclaw`（magpie id `jet-hub-autoclaw`）。 */
export const JetHubAutoclawPlugin = byId.get('jet-hub-autoclaw')

/** 本体 `buddy`（magpie id `jet-hub-buddy`）。 */
export const JetHubBuddyPlugin = byId.get('jet-hub-buddy')

/** 本体 `cline`（magpie id `jet-hub-cline`）。 */
export const JetHubClinePlugin = byId.get('jet-hub-cline')

/** 本体 `codearts`（magpie id `jet-hub-codearts`）。 */
export const JetHubCodeartsPlugin = byId.get('jet-hub-codearts')

/** 本体 `jet-hub-auto`（magpie id `jet-hub`）。 */
export const JetHubJetHubAutoPlugin = byId.get('jet-hub')

/** 本体 `lobsterai`（magpie id `jet-hub-lobsterai`）。 */
export const JetHubLobsteraiPlugin = byId.get('jet-hub-lobsterai')

/** 本体 `loomy`（magpie id `jet-hub-loomy`）。 */
export const JetHubLoomyPlugin = byId.get('jet-hub-loomy')

/** 本体 `minimaxintl`（magpie id `jet-hub-minimaxintl`）。 */
export const JetHubMinimaxintlPlugin = byId.get('jet-hub-minimaxintl')

/** 本体 `modelscope`（magpie id `jet-hub-modelscope`）。 */
export const JetHubModelscopePlugin = byId.get('jet-hub-modelscope')

/** 本体 `officeace`（magpie id `jet-hub-officeace`）。 */
export const JetHubOfficeacePlugin = byId.get('jet-hub-officeace')

/** 本体 `opencode`（magpie id `jet-hub-opencode`）。 */
export const JetHubOpencodePlugin = byId.get('jet-hub-opencode')

/** 本体 `qoder`（magpie id `jet-hub-qoder`）。 */
export const JetHubQoderPlugin = byId.get('jet-hub-qoder')

/** 本体 `qodercn`（magpie id `jet-hub-qodercn`）。 */
export const JetHubQodercnPlugin = byId.get('jet-hub-qodercn')

/** 本体 `raccoon`（magpie id `jet-hub-raccoon`）。 */
export const JetHubRaccoonPlugin = byId.get('jet-hub-raccoon')

/** 本体 `trae`（magpie id `jet-hub-trae`）。 */
export const JetHubTraePlugin = byId.get('jet-hub-trae')

/** 本体 `workbuddy`（magpie id `jet-hub-workbuddy`）。 */
export const JetHubWorkbuddyPlugin = byId.get('jet-hub-workbuddy')

/** 本体 `zcode`（magpie id `jet-hub-zcode`）。 */
export const JetHubZcodePlugin = byId.get('jet-hub-zcode')
