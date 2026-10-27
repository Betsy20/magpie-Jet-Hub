/**
 * magpie-jet-hub —— 把 deepseek-harness-codearts 插件**本体**装进 magpie。
 *
 * ## 与 magpie-codearts-auth 的区别（很重要）
 *
 * `magpie-codearts-auth` 只搬了 CodeArts 一家，是「重写一份」。
 * 本插件是「原样装本体」：把 npm 包 `deepseek-harness-codearts`
 * （= 仓库 dsh-providers-hub，24 个 provider 的路由中枢）丢进一个**内嵌的
 * cordis 容器**里跑起来，让它自己开一个只监听回环的 OpenAI 兼容网关，
 * magpie 侧只把请求转发进去。
 *
 * 好处：本体的账号池、静默续期、积分选号、模型目录、路由组（`group/*`、
 * `auto/*`）全部原样复用，一行都不重写；本体升级时本插件跟着升级。
 *
 * ## 架构
 *
 * ```
 * magpie 网关 (3425)
 *   └─ provider `jet-hub`  ← 本插件
 *        └─ auth.loader().fetch  ← 只改这一层
 *             └─ JetHubContainer（内嵌 cordis + 本体 lib/index.js）
 *                  └─ 本体自带网关 127.0.0.1:<动态端口>
 *                       └─ 24 个 provider 的真实上游
 * ```
 *
 * ## 凭据从哪来
 *
 * 不向用户要任何新凭据：DSH 已经把 18 个账号写在
 * `~/.dsh/.credentials.yaml` 的 `refs:` 段里，本插件用一个
 * `FileCredentialProvider` 把它桥成容器的 `credentials` 服务，本体读到的
 * 就是它平时读到的那份（含多行 YAML 标量折叠那种坑，已处理）。
 *
 * ⇒ 用户在 DSH 里登录过的账号，在 magpie 里**立刻可用**，反之亦然。
 * 这正是「兼容适配」的实质：不是再登一次，是共用同一份凭据。
 */

import { JetHubContainer } from './container.mjs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** magpie 侧的 provider id。 */
export const PROVIDER = 'jet-hub'

/** magpie 列表里显示的供应商名。 */
export const DISPLAY_NAME = 'Jet Hub'

/**
 * loader 的占位 baseURL。
 *
 * ⚠️ 不能是空串：magpie 会据此判「无处可发」（`nowhere to send its requests`）。
 * 真实上游在 `fetch` 里改写 —— 本插件从不真的访问这个域名。
 */
const PLACEHOLDER_BASE = 'https://jet-hub.invalid/v1'

/**
 * 未登录时给 magpie 看的静态目录（本体拉不到时会退回这里）。
 *
 * 只挑每个 provider 一个代表模型：完整目录要等容器起来才有（本体按账号
 * 真实目录拉），这里的作用是让插件卡片先有内容、不显示「0 models」。
 */
const FALLBACK_MODELS = {
  'workbuddy/deepseek-v4.1-flash': { name: 'WorkBuddy · DeepSeek V4.1 Flash', limit: { context: 128_000, output: 8192 }, tool_call: true },
  'qoder/qfmodel': { name: 'Qoder · qfmodel', limit: { context: 128_000, output: 8192 }, tool_call: true },
  'qodercn/dfmodel': { name: 'Qoder CN · dfmodel', limit: { context: 128_000, output: 8192 }, tool_call: true },
  'zcode/GLM-5.3': { name: 'ZCode · GLM-5.3', limit: { context: 200_000, output: 8192 }, tool_call: true },
  'codearts/deepseek-v4.1-flash': { name: 'CodeArts · DeepSeek V4.1 Flash', limit: { context: 128_000, output: 8192 }, tool_call: true },
  'buddy/deepseek-v4.1-flash': { name: 'Buddy · DeepSeek V4.1 Flash', limit: { context: 128_000, output: 8192 }, tool_call: true },
  'trae/deepseek-v4.1-flash': { name: 'Trae · DeepSeek V4.1 Flash', limit: { context: 128_000, output: 8192 }, tool_call: true },
  'autoclaw/zai_glm-5.3-flash': { name: 'AutoClaw · GLM-5.3 Flash', limit: { context: 128_000, output: 8192 }, tool_call: true },
  'loomy/DeepSeek-V4.1-Flash': { name: 'Loomy · DeepSeek V4.1 Flash', limit: { context: 128_000, output: 8192 }, tool_call: true },
  'lobsterai/deepseek-flash': { name: 'LobsterAI · DeepSeek Flash', limit: { context: 128_000, output: 8192 }, tool_call: true },
  'officeace/deepseek-v4.1-flash': { name: 'OfficeAce · DeepSeek V4.1 Flash', limit: { context: 128_000, output: 8192 }, tool_call: true },
  'astudio/xopdsv4flash0731in': { name: 'AStudio · DeepSeek V4 Flash', limit: { context: 128_000, output: 8192 }, tool_call: true },
  'modelscope/deepseek-ai/DeepSeek-V4.1-Flash': { name: 'ModelScope · DeepSeek V4.1 Flash', limit: { context: 128_000, output: 8192 }, tool_call: true },
  'raccoon/sn-deepseek-v4-1-flash-1017': { name: 'Raccoon · DeepSeek V4.1 Flash', limit: { context: 128_000, output: 8192 }, tool_call: true },
  'opencode/beam-free': { name: 'OpenCode · Beam (free)', limit: { context: 128_000, output: 8192 }, tool_call: true },
  'jet-hub-auto/auto': { name: 'Jet Hub · 自动选号', limit: { context: 128_000, output: 8192 }, tool_call: true },
}

/** DSH 家目录（凭据所在处）。可用 `magpie plugin options jet-hub '{"home":"..."}'` 覆盖。 */
function resolveHome(optionHome) {
  if (typeof optionHome === 'string' && optionHome !== '') return optionHome
  return homedir()
}

/** 本体入口：优先用插件自带的副本，其次退回 DSH 安装目录里的那份。 */
function resolveEntry(optionEntry) {
  if (typeof optionEntry === 'string' && optionEntry !== '') return optionEntry
  // 本插件自带的副本（随包分发，保证不依赖本机 DSH 安装路径）
  // ⚠️ 本文件在 src/ 下，vendor 在包根 —— 必须 '../vendor'，写 './vendor' 会解析成 src/vendor。
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
 * 模型 id 归一：magpie 会把它展示成 `<provider>/<model>`，但请求回来时
 * 可能带也可能不带 provider 前缀 —— 两种都认，只把 provider 前缀剥掉。
 */
function stripProviderPrefix(modelId) {
  const raw = String(modelId ?? '')
  const prefix = `${PROVIDER}/`
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw
}

/**
 * 插件工厂。
 *
 * magpie 宿主会**遍历模块的全部导出并探测性调用**（实测过一次真缺陷：
 * 导出工具函数导致 `plugin list` 报 failed），故 `index.mjs` 只导出本函数
 * 与两个常量，其余全部收在 `src/` 内。
 */
export const JetHubPlugin = async (input = {}, options = {}) => {
  const home = resolveHome(options.home)
  const entryPath = resolveEntry(options.entryPath)
  const log = (msg) => {
    try {
      input?.client?.app?.log?.({ service: 'jet-hub', level: 'info', message: String(msg) })
    } catch { /* 日志失败不影响业务 */ }
  }

  const container = new JetHubContainer({ home, entryPath, log })

  /** 静态目录 + 已拉到的真实目录，合并成 magpie 的 provider.models 形状。 */
  const modelEntry = (id, def) => ({
    name: def?.name ?? id,
    limit: { context: def?.limit?.context ?? 128_000, output: def?.limit?.output ?? 8192 },
    tool_call: def?.tool_call ?? true,
  })

  /**
   * 拿容器里真实的模型目录。
   *
   * ⚠️ **绝不能在 models() 里等冷启动**（2026-10-27 实测真缺陷）：magpie 给
   * `provider.models` 的超时是 **20 秒**，而本体冷启动要先建容器、拉 21 个
   * 账号的凭据链、预热目录，实测 20–30 秒 —— 直接 await 必然超时，日志里
   * 刷 `provider.models: the plugin's model list didn't finish in 20s`，
   * 插件卡片上的模型数也就一直停在静态表。
   *
   * 故分三档：
   *  1. 已有缓存目录 → 立刻返回（顺手在后台刷新，不阻塞）
   *  2. 容器已在启动中 → 返回缓存/静态表（不 await）
   *  3. 完全冷启动 → 返回静态表，并把启动甩到后台
   */
  let cachedModels

  /**
   * 目录缓存文件。
   *
   * 为什么需要：magpie 每次重启都会重新加载插件，若不落盘，首屏永远是静态表
   * （因为 models() 不许阻塞），用户看到 16 个而不是真实的 22+ 个。
   * 落盘后下次启动首屏即真实目录，后台再刷新。
   */
  const cacheFile = join(homedir(), '.config', 'magpie', 'jet-hub-models.json')

  /** 从磁盘读上次的目录（不存在/损坏就返回 undefined）。 */
  function readCache() {
    try {
      const j = JSON.parse(readFileSync(cacheFile, 'utf8'))
      if (Array.isArray(j?.models) && j.models.length > 0) return j.models
    } catch { /* 没有缓存是正常情况 */ }
    return undefined
  }

  /** 把目录写回磁盘（失败不影响业务）。 */
  function writeCache(list) {
    try {
      mkdirSync(dirname(cacheFile), { recursive: true })
      writeFileSync(cacheFile, JSON.stringify({ at: new Date().toISOString(), models: list }, null, 2))
    } catch (e) {
      log(`写模型缓存失败（不影响使用）：${e?.message ?? e}`)
    }
  }

  async function currentModels() {
    // 1) 有缓存：直接给，同时在后台刷新（失败也无所谓，下次还会试）
    if (cachedModels !== undefined) {
      if (container.ready === undefined) {
        container.start().then(() => container.refreshModels()).then((list) => {
          if (list.length > 0) {
            cachedModels = list.slice()
            writeCache(cachedModels)
          }
        }).catch(() => {})
      }
      const out = {}
      for (const id of cachedModels) out[id] = modelEntry(id, undefined)
      return out
    }
    // 2) 冷启动：只做「预热」，不阻塞；本次先交上次落盘的目录，再退静态表
    if (container.ready === undefined) {
      container.start().then(() => container.refreshModels()).then((list) => {
        if (list.length > 0) {
          cachedModels = list.slice()
          writeCache(cachedModels)
        }
      }).catch((e) => log(`后台启动容器失败：${e?.message ?? e}`))
    }
    const seed = readCache()
    if (seed !== undefined) {
      const out = {}
      for (const id of seed) out[id] = modelEntry(id, undefined)
      return out
    }
    const out = {}
    for (const [id, def] of Object.entries(FALLBACK_MODELS)) out[id] = modelEntry(id, def)
    return out
  }

  /** 只在 authorize / usage 这类允许长时间的路径上等真目录。 */
  async function liveModels() {
    const list = await container.refreshModels()
    if (Array.isArray(list) && list.length > 0) {
      cachedModels = list.slice()
      writeCache(cachedModels)
    }
    const out = {}
    for (const id of cachedModels ?? []) out[id] = modelEntry(id, undefined)
    return out
  }

  return {
    /**
     * 声明 provider。magpie 在插件加载后立刻调用 config，这里必须给出
     * 一个非空 `api` 与非空模型表，否则卡片显示「无处可发」/「0 models」。
     */
    async config(cfg) {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {}
      const p = cfg.provider[PROVIDER]
      p.name = DISPLAY_NAME
      p.npm = '@ai-sdk/openai-compatible'
      p.api = PLACEHOLDER_BASE
      p.models = Object.fromEntries(
        Object.entries(FALLBACK_MODELS).map(([id, def]) => [id, modelEntry(id, def)]),
      )
    },

    auth: {
      provider: PROVIDER,

      /**
       * 只声明一个身份：本机 DSH 账号池是一份，重复「连接」复用同一个账号槽，
       * 不会在 magpie 里堆出 `jet-hub#a1b2c3` 这种重复账号。
       * 依据：官方 provider-plugins.md「Fixed-credential sign-in」段
       * —— `auth.single: true` declares one provider identity。
       */
      single: true,

      /**
       * 登录方式：**不需要输任何东西**。
       *
       * 凭据早就在 `~/.dsh/.credentials.yaml` 里（DSH 那边登录过的账号），
       * 容器启动即读到。这里用一个 `api` + `keyless` 的方法，让用户在
       * magpie 卡片上点一下「连接」就建立账号槽 —— 不弹输入框、不跳浏览器。
       *
       * `keyless: true` 是 magpie 自己的字段（见官方 provider-plugins.md
       * 「Fixed-credential sign-in」）：GUI/CLI 都会跳过 personal-key 输入。
       */
      methods: [
        {
          type: 'api',
          keyless: true,
          label: '连接本机 DSH 账号（无需输入）',
          async authorize() {
            // 启动容器并拉一次目录，确认凭据链真的能用；失败要如实抛出，
            // 而不是建一个「看起来登录了但发不出去」的空账号槽。
            // authorize 由用户点「连接」触发，慢一点可以等（实测冷启动 3–30s）。
            const live = await liveModels()
            const accounts = Object.keys(live).length
            if (accounts === 0) {
              throw new Error('找不到任何可用账号：请先在 DSH 里登录至少一个 provider')
            }
            return {
              type: 'success',
              // magpie 的 api 型账号把 key 存进 auth 记录；这里给个本机占位值，
              // 真正发请求用的是容器自己的 apiKey（见 loader().fetch）。
              key: `jet-hub-local:${container.port ?? 'pending'}`,
              accountId: `DSH 本机账号 · ${accounts} 个模型`,
              metadata: { via: 'jet-hub', home },
            }
          },
        },
      ],

      /**
       * 发请求：把 magpie 转过来的 OpenAI 请求原样投给容器网关。
       *
       * 只在 chat 上动模型名（剥 provider 前缀），其余路径（/models 等）直接透传。
       */
      async loader() {
        return {
          baseURL: PLACEHOLDER_BASE,
          async fetch(fetchInput, init = {}) {
            const url = typeof fetchInput === 'string' ? fetchInput : fetchInput?.url ?? ''
            const method = String(init?.method ?? 'POST').toUpperCase()
            const isChat = method === 'POST' && /\/chat\/completions(\?|$)/.test(url)
            const parsed = isChat ? parseJsonBody(init?.body) : undefined

            // 非 chat 或解析不了：原样投给容器（容器网关有 /v1/models 等）
            if (parsed === undefined) {
              await container.start()
              const path = url.replace(/^https?:\/\/[^/]+/i, '') || '/v1/chat/completions'
              return container.forward(path, init)
            }

            const upstream = { ...parsed, model: stripProviderPrefix(parsed.model) }
            await container.start()
            return container.forward('/chat/completions', { ...init, body: JSON.stringify(upstream) })
          },
        }
      },

      /** 用量卡：容器自带 24 家的积分/额度，但 magpie 的 usage 契约要具体形状，
       *  这里先返回容器能给的模型数量作为健康信号（不伪造积分数字）。
       *  usage 由 magpie 在后台按需调用，允许长时间等待，故用 liveModels()。 */
      async usage() {
        try {
          const models = await liveModels()
          return {
            plan: DISPLAY_NAME,
            windows: [
              {
                name: '可用路由',
                used: 0,
                display: `${Object.keys(models).length} 个模型 · 容器 127.0.0.1:${container.port}`,
              },
            ],
          }
        } catch (e) {
          return { error: e?.message ?? String(e), windows: [] }
        }
      },
    },

    /**
     * 模型目录：优先用容器真实目录（本体按各账号拉），拿不到退回静态表。
     */
    provider: {
      id: PROVIDER,
      async models(provider) {
        const live = await currentModels()
        return Object.keys(live).length > 0 ? live : provider.models
      },
    },

    _internal: { container, resolveHome, resolveEntry, stripProviderPrefix, parseJsonBody },
  }
}

// 兼容按旧名找插件的宿主（不改行为，只是别名）
export const CodeArtsAuthPlugin = JetHubPlugin
