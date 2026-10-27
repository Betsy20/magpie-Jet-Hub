/**
 * magpie-jet-hub —— 把 deepseek-harness-codearts 插件**本体**装进 magpie，
 * 并且**按本体里的每个供应商分别注册成 magpie 的供应商**。
 *
 * ## 为什么要「一个供应商一个 provider id」
 *
 * magpie 的「模型 / 供应商」页面是按 provider 分组的。整个本体只注册一个
 * `jet-hub` 的话，页面上只有一张卡片、所有模型挤在一个前缀下；用户要的是
 * 每个供应商各占一行（这样能单独看模型数、单独签入、单独看用量）。
 *
 * magpie 宿主 `servers(mod)` 会取模块导出的**每一个函数**，`auths()` 再按
 * `hooks.auth.provider` 建映射 —— 所以一个插件包导出 N 个插件工厂，就能注册
 * N 个 provider id。本文件对本体里的 19 个 provider 各生成一个工厂。
 *
 * ## 架构
 *
 * ```
 * magpie 网关 (3425)
 *   ├─ provider `jet-hub-codearts`   ┐
 *   ├─ provider `jet-hub-workbuddy`  │  N 个 provider，各自一个 id
 *   ├─ provider `jet-hub-qoder`      ├─ 全部共用同一个容器实例
 *   └─ …（19 个）                     ┘
 *        └─ auth.loader().fetch → JetHubContainer（内嵌 cordis + 本体 lib/index.js）
 *             └─ 本体自带网关 127.0.0.1:<动态端口>
 *                  └─ 各 provider 的真实上游
 * ```
 *
 * ⚠️ 容器**必须模块级共享**：19 个插件工厂各自 new 一个容器的话，会拉起 19 个
 * cordis + 19 个网关端口，冷启动直接炸。
 *
 * ## 凭据从哪来
 *
 * 不向用户要任何新凭据：DSH 已经把账号写在 `~/.dsh/.credentials.yaml` 的
 * `refs:` 段里，本插件用 `FileCredentialProvider` 把它桥成容器的 `credentials`
 * 服务。DSH 里登录过的账号，在 magpie 里立刻可用，反之亦然。
 */

import { JetHubContainer } from './container.mjs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** provider id 前缀。 */
export const PROVIDER_PREFIX = 'jet-hub-'

/** 列表里显示的供应商名。 */
export const DISPLAY_NAME = 'Jet Hub'

/**
 * 本体里的 provider（顺序即页面上的顺序）。
 *
 * `jet-hub-auto` 是本体自己的自动选号路由，它的 magpie id 直接用 `jet-hub`
 * （否则会变成 `jet-hub-jet-hub-auto`，太绕）。
 */
export const DSH_PROVIDERS = [
  'aggregate',
  'astudio',
  'autoclaw',
  'buddy',
  'cline',
  'codearts',
  'jet-hub-auto',
  'lobsterai',
  'loomy',
  'minimaxintl',
  'modelscope',
  'officeace',
  'opencode',
  'qoder',
  'qodercn',
  'raccoon',
  'trae',
  'workbuddy',
  'zcode',
]

/**
 * provider → 卡片上显示的名字。
 * 没登记的退回原始 id（宁可显示 `foo` 也别显示空白）。
 */
const NAMES = {
  aggregate: '聚合路由',
  astudio: 'AStudio（讯飞）',
  autoclaw: 'AutoClaw（智谱）',
  buddy: 'Buddy',
  cline: 'Cline',
  codearts: 'CodeArts（华为云）',
  'jet-hub-auto': '自动选号',
  lobsterai: 'LobsterAI',
  loomy: 'Loomy',
  minimaxintl: 'MiniMax 国际',
  modelscope: 'ModelScope（魔搭）',
  officeace: 'OfficeAce（华为云）',
  opencode: 'OpenCode',
  qoder: 'Qoder',
  qodercn: 'Qoder 国内',
  raccoon: 'Raccoon',
  trae: 'Trae',
  workbuddy: 'WorkBuddy',
  zcode: 'ZCode（GLM）',
}

/** 本体 provider → magpie provider id。 */
export function idOf(dshProvider) {
  return dshProvider === 'jet-hub-auto' ? 'jet-hub' : `${PROVIDER_PREFIX}${dshProvider}`
}

/** 供外部（脚本 / 测试）用的一组 id。 */
export const PROVIDER_IDS = DSH_PROVIDERS.map(idOf)

/**
 * 按长度降序排的「可能出现在模型 id 前面的前缀」。
 * 长的先匹配，否则 `jet-hub-auto/` 会被 `jet-hub/` 抢在前面。
 */
const PREFIXES = [...new Set([...DSH_PROVIDERS, ...PROVIDER_IDS])].sort((a, b) => b.length - a.length)

/**
 * loader 的占位 baseURL。
 * ⚠️ 不能是空串：magpie 会据此判「无处可发」（`nowhere to send its requests`）。
 */
const PLACEHOLDER_BASE = 'https://jet-hub.invalid/v1'

/**
 * 未登录时给 magpie 看的静态目录（完整目录要等容器起来）。
 * 键是全 id `<provider>/<model>`，按 provider 过滤。
 */
const FALLBACK_MODELS = {
  'workbuddy/deepseek-v4.1-flash': { name: 'WorkBuddy · DeepSeek V4.1 Flash' },
  'qoder/qfmodel': { name: 'Qoder · qfmodel' },
  'qodercn/dfmodel': { name: 'Qoder CN · dfmodel' },
  'zcode/GLM-5.3': { name: 'ZCode · GLM-5.3' },
  'codearts/deepseek-v4.1-flash': { name: 'CodeArts · DeepSeek V4.1 Flash' },
  'buddy/deepseek-v4.1-flash': { name: 'Buddy · DeepSeek V4.1 Flash' },
  'trae/deepseek-v4.1-flash': { name: 'Trae · DeepSeek V4.1 Flash' },
  'autoclaw/zai_glm-5.3-flash': { name: 'AutoClaw · GLM-5.3 Flash' },
  'loomy/DeepSeek-V4.1-Flash': { name: 'Loomy · DeepSeek V4.1 Flash' },
  'lobsterai/deepseek-flash': { name: 'LobsterAI · DeepSeek Flash' },
  'officeace/deepseek-v4.1-flash': { name: 'OfficeAce · DeepSeek V4.1 Flash' },
  'astudio/xopdsv4flash0731in': { name: 'AStudio · DeepSeek V4 Flash' },
  'modelscope/deepseek-ai/DeepSeek-V4.1-Flash': { name: 'ModelScope · DeepSeek V4.1 Flash' },
  'raccoon/sn-deepseek-v4-1-flash-1017': { name: 'Raccoon · DeepSeek V4.1 Flash' },
  'opencode/beam-free': { name: 'OpenCode · Beam (free)' },
  'cline/deepseek-v4.1-flash': { name: 'Cline · DeepSeek V4.1 Flash' },
  'minimaxintl/MiniMax-M2': { name: 'MiniMax 国际 · M2' },
  'aggregate/auto': { name: '聚合 · auto' },
  'jet-hub-auto/auto': { name: 'Jet Hub · 自动选号' },
}

/** DSH 家目录（凭据所在处）。可用插件 options 的 `home` 覆盖。 */
function resolveHome(optionHome) {
  if (typeof optionHome === 'string' && optionHome !== '') return optionHome
  return homedir()
}

/** 本体入口：优先用插件自带副本，其次退回 DSH 安装目录里的那份。 */
function resolveEntry(optionEntry) {
  if (typeof optionEntry === 'string' && optionEntry !== '') return optionEntry
  // ⚠️ 本文件在 src/ 下，vendor 在包根 —— 必须 '../vendor'。
  return fileURLToPath(new URL('../vendor/lib/index.js', import.meta.url))
}

/** 把请求体解析成对象；非 JSON 一律放过。 */
function parseJsonBody(body) {
  const toObj = (text) => {
    try {
      const parsed = JSON.parse(text)
      return typeof parsed === 'object' && parsed !== null ? parsed : undefined
    } catch {
      return undefined
    }
  }
  if (typeof body === 'string') return toObj(body)
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    try {
      return toObj(new TextDecoder().decode(body))
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * 把 magpie 传来的模型名换成上游要的 `<本体provider>/<model>`。
 *
 * magpie 展示的是 `<magpie id>/<model>`，请求回来时可能带、也可能不带那些前缀，
 * 所以先把已知前缀剥掉一层，再补上本 provider 的前缀。剥之前按长度降序匹配，
 * 避免 `jet-hub/` 抢掉 `jet-hub-auto/`。
 */
export function toUpstreamModel(model, dshProvider) {
  let m = String(model ?? '')
  if (m.startsWith(`${dshProvider}/`)) return m
  for (const p of PREFIXES) {
    if (m.startsWith(`${p}/`)) {
      m = m.slice(p.length + 1)
      break
    }
  }
  return `${dshProvider}/${m}`
}

/** 静态目录里属于某个 provider 的那些（键已剥前缀）。 */
function fallbackFor(dshProvider) {
  const out = {}
  for (const [id, def] of Object.entries(FALLBACK_MODELS)) {
    if (!id.startsWith(`${dshProvider}/`)) continue
    const bare = id.slice(dshProvider.length + 1)
    out[bare] = modelEntry(bare, def)
  }
  return out
}

function modelEntry(id, def) {
  return {
    name: def?.name ?? id,
    limit: { context: def?.limit?.context ?? 128_000, output: def?.limit?.output ?? 8192 },
    tool_call: def?.tool_call ?? true,
  }
}

// ---- 共享容器与模型缓存 -------------------------------------------------------

/** 模块级单例：19 个 provider 共用同一个容器。 */
let shared = null

function containerFor(options, log) {
  if (shared !== null) return shared
  shared = new JetHubContainer({
    home: resolveHome(options?.home),
    entryPath: resolveEntry(options?.entryPath),
    log,
  })
  return shared
}

/** 模型缓存文件（落盘，下次启动首屏就是真实目录）。 */
const cacheFile = join(homedir(), '.config', 'magpie', 'jet-hub-models.json')

/** 最近一次拿到的全量模型 id（`<provider>/<model>` 形态）。 */
let allModels = undefined

function readCache() {
  try {
    const j = JSON.parse(readFileSync(cacheFile, 'utf8'))
    if (Array.isArray(j?.models) && j.models.length > 0) return j.models
  } catch { /* 没有缓存是正常情况 */ }
  return undefined
}

function writeCache(list, log) {
  try {
    mkdirSync(dirname(cacheFile), { recursive: true })
    writeFileSync(cacheFile, JSON.stringify({ at: new Date().toISOString(), models: list }, null, 2))
  } catch (e) {
    log?.(`写模型缓存失败（不影响使用）：${e?.message ?? e}`)
  }
}

/**
 * 拿全量目录，**绝不阻塞**。
 *
 * magpie 给 `provider.models` 的超时是 20 秒，而本体冷启动要 20–30 秒；
 * 直接 await 必然超时。故：有缓存立刻给，同时后台刷新；冷启动只预热。
 */
function currentAll(container, log) {
  if (allModels === undefined) {
    container.start()
      .then(() => container.refreshModels())
      .then((list) => {
        if (Array.isArray(list) && list.length > 0) {
          allModels = list.slice()
          writeCache(allModels, log)
        }
      })
      .catch((e) => log?.(`后台启动容器失败：${e?.message ?? e}`))
    const seed = readCache()
    if (seed !== undefined) allModels = seed
  }
  return allModels
}

/** 允许长时间等待的路径（authorize / usage）用这个。 */
async function liveAll(container, log) {
  const list = await container.refreshModels()
  if (Array.isArray(list) && list.length > 0) {
    allModels = list.slice()
    writeCache(allModels, log)
  }
  return allModels ?? []
}

/** 从全量目录里取某个 provider 的部分，返回 magpie 的 models 形状。 */
function modelsOf(dshProvider, list) {
  const out = {}
  const prefix = `${dshProvider}/`
  for (const id of list ?? []) {
    if (!id.startsWith(prefix)) continue
    const bare = id.slice(prefix.length)
    out[bare] = modelEntry(bare, undefined)
  }
  return out
}

// ---- 插件工厂 ---------------------------------------------------------------

/**
 * 为一个本体 provider 生成 magpie 插件工厂。
 *
 * ⚠️ magpie 宿主会遍历模块全部导出并探测性调用，故这些工厂必须对任何入参
 * 都不抛错（`input`/`options` 都按可空处理）。
 */
export function makePlugin(dshProvider) {
  const id = idOf(dshProvider)
  return async (input = {}, options = {}) => {
    const log = (msg) => {
      try {
        input?.client?.app?.log?.({ service: id, level: 'info', message: String(msg) })
      } catch { /* 日志失败不影响业务 */ }
    }
    const container = containerFor(options, log)

    /** 本 provider 的模型表（不阻塞）。 */
    function currentModels(provider) {
      const all = currentAll(container, log)
      const got = modelsOf(dshProvider, all)
      if (Object.keys(got).length > 0) return got
      return provider?.models ?? fallbackFor(dshProvider)
    }

    return {
      async config(cfg) {
        cfg.provider ??= {}
        cfg.provider[id] ??= {}
        const p = cfg.provider[id]
        p.name = `${DISPLAY_NAME} · ${NAMES[dshProvider] ?? dshProvider}`
        p.npm = '@ai-sdk/openai-compatible'
        p.api = PLACEHOLDER_BASE
        // 静态目录：让卡片先有内容，不显示「0 models」
        p.models = fallbackFor(dshProvider)
      },

      auth: {
        provider: id,

        /**
         * 一个 provider 一个账号槽：重复「连接」只复用同一个槽，
         * 不会在 magpie 里堆出 `<id>#a1b2c3` 这种重复账号。
         */
        single: true,

        /**
         * 免输入签入：凭据早就在 `~/.dsh/.credentials.yaml` 里，容器启动即读到。
         * `keyless: true` 是 magpie 自己的字段，GUI/CLI 会跳过 personal-key 输入。
         */
        methods: [
          {
            type: 'api',
            keyless: true,
            label: `连接本机 DSH 账号（${dshProvider}，无需输入）`,
            async authorize() {
              const all = await liveAll(container, log)
              const mine = modelsOf(dshProvider, all)
              const n = Object.keys(mine).length
              if (n === 0) {
                throw new Error(
                  `本体里的 ${dshProvider} 没有可用模型：确认这个账号在 DSH 里已登录，或先在 /v1/models 里看它是否有模型`,
                )
              }
              return {
                type: 'success',
                // magpie 的 api 型账号要存一个 key；真正发请求用的是容器自己的 apiKey。
                key: `jet-hub-local:${dshProvider}:${container.port ?? 'pending'}`,
                accountId: `DSH · ${dshProvider} · ${n} 个模型`,
                metadata: { via: 'jet-hub', provider: dshProvider },
              }
            },
          },
        ],

        /** 发请求：把 magpie 转来的 OpenAI 请求投给容器网关，只改模型名。 */
        async loader() {
          return {
            baseURL: PLACEHOLDER_BASE,
            async fetch(fetchInput, init = {}) {
              const url = typeof fetchInput === 'string' ? fetchInput : fetchInput?.url ?? ''
              const method = String(init?.method ?? 'POST').toUpperCase()
              const isChat = method === 'POST' && /\/chat\/completions(\?|$)/.test(url)
              const parsed = isChat ? parseJsonBody(init?.body) : undefined

              await container.start()

              // 非 chat 或解析不了：原样投给容器（容器网关有 /v1/models 等）
              if (parsed === undefined) {
                const path = url.replace(/^https?:\/\/[^/]+/i, '') || '/v1/chat/completions'
                return container.forward(path, init)
              }

              const upstream = { ...parsed, model: toUpstreamModel(parsed.model, dshProvider) }
              return container.forward('/chat/completions', { ...init, body: JSON.stringify(upstream) })
            },
          }
        },

        /** 用量卡：只报本 provider 的模型数（不伪造积分数字）。 */
        async usage() {
          try {
            const all = await liveAll(container, log)
            const n = Object.keys(modelsOf(dshProvider, all)).length
            return {
              plan: `${DISPLAY_NAME} · ${dshProvider}`,
              windows: [
                {
                  name: '可用模型',
                  used: 0,
                  display: `${n} 个模型 · 容器 127.0.0.1:${container.port}`,
                },
              ],
            }
          } catch (e) {
            return { error: e?.message ?? String(e), windows: [] }
          }
        },
      },

      provider: {
        id,
        async models(provider) {
          return currentModels(provider)
        },
      },

      _internal: { container, dshProvider, toUpstreamModel },
    }
  }
}

/** 全部 19 个工厂（`index.mjs` 逐个具名导出）。 */
export const PLUGINS = DSH_PROVIDERS.map((p) => [idOf(p), makePlugin(p)])
