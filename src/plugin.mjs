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
 * N 个 provider id。本文件对本体里**除两个路由组之外**的 23 个 provider 各生成一个工厂。
 *
 * ## 架构
 *
 * ```
 * magpie 网关（默认 3425，可用 JET_HUB_USER_GATEWAY 覆盖）
 *   ├─ provider `jet-hub-codearts`   ┐
 *   ├─ provider `jet-hub-workbuddy`  │  N 个 provider，各自一个 id
 *   ├─ provider `jet-hub-qoder`      ├─ 全部共用同一个容器实例
 *   └─ …（23 个）                     ┘
 *        └─ auth.loader().fetch → JetHubContainer（内嵌 cordis + 本体 lib/index.js）
 *             └─ 直连本体 llm：ctx.llm.stream()（src/llm-bridge.mjs）
 *                  └─ 各 provider 的真实上游
 * ```
 *
 * ⚠️ **没有内嵌 HTTP 网关**：本体自己也开一个 OpenAI 兼容网关，但那层只是
 * `ctx.llm` 的 HTTP 外壳。插件在本进程里直接握着 `ctx.llm`，所以
 * `container.forward()` 在进程内就完成了整件事 —— 不占端口、不需要 apiKey。
 *
 * ⚠️ 容器**必须模块级共享**：23 个插件工厂各自 new 一个容器的话，会拉起 23 个
 * cordis（23 份账号池 + 23 份模型目录），冷启动直接炸。
 *
 * ## 凭据从哪来
 *
 * 不向用户要任何新凭据：DSH 已经把账号写在 `~/.dsh/.credentials.yaml` 的
 * `refs:` 段里，本插件用 `FileCredentialProvider` 把它桥成容器的 `credentials`
 * 服务。DSH 里登录过的账号，在 magpie 里立刻可用，反之亦然。
 */

import { JetHubContainer } from './container.mjs'
import { iconFor } from './icons.mjs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** provider id 前缀。 */
export const PROVIDER_PREFIX = 'jet-hub-'

/**
 * `ask()` 收集「选哪个 DSH 账号」用的 inputs 键名。
 *
 * 宿主会把用户答过的 `inputs` 原样回传给 `authorize(inputs)`，同时
 * `save()` 会把它并进账号记录的 `metadata`（宿主 `save()` 的
 * `const md = { ...inputs, ...result.metadata }`）—— 所以这个键名会出现在
 * `plugin-auth.json` 里，改它等于让老记录的 `metadata` 多一个孤儿键（无害）。
 */
export const ACCOUNT_INPUT = 'dshAccount'

/** 列表里显示的供应商名。 */
export const DISPLAY_NAME = 'Jet Hub'

/**
 * 本体里的 provider（顺序即页面上的顺序）。
 *
 * ⚠️ 这里**不含** `aggregate`（聚合路由）与 `jet-hub-auto`（自动选号）这两个路由组。
 * 它们不是真渠道：没有自己的账号池、没有自己的模型目录，`account.list` /
 * `credits.balances` 一律回 `unknown provider`，在 magpie 里只能是一张永远没有
 * 账号、也永远选不了具体模型的空卡，所以不注册。
 *
 * 本体内部照样用它们做择优路由，只是本插件不再把它们注册成 magpie provider ——
 * 真渠道的请求仍然由本体按到期 / 额度在池内自动挑选，行为不受影响。
 */
export const DSH_PROVIDERS = [
  'accio',
  'astudio',
  'autoclaw',
  'autoclawintl',
  'buddy',
  'cline',
  'codearts',
  'codely',
  'gemini',
  'lobsterai',
  'loomy',
  'magicrew',
  'minimax',
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
  accio: 'Accio（阿里）',
  astudio: 'AStudio（讯飞）',
  autoclaw: 'AutoClaw（智谱）',
  autoclawintl: 'AutoClaw 国际',
  buddy: 'Buddy',
  cline: 'Cline',
  codearts: 'CodeArts（华为云）',
  codely: 'Codely',
  gemini: 'Gemini',
  lobsterai: 'LobsterAI',
  loomy: 'Loomy',
  magicrew: '超级麦吉',
  minimax: 'MiniMax',
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
  return `${PROVIDER_PREFIX}${dshProvider}`
}

/** 供外部（脚本 / 测试）用的一组 id。 */
export const PROVIDER_IDS = DSH_PROVIDERS.map(idOf)

/**
 * 按长度降序排的「可能出现在模型 id 前面的前缀」。
 * 长的先匹配：`jet-hub-codearts/` 不能被 `jet-hub-codely/` 之类的短前缀抢走。
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
  'opencode/deepseek-v4.1-flash-free': { name: 'OpenCode · DeepSeek V4.1 Flash (free)' },
  'cline/cline-pass/deepseek-v4.1-flash': { name: 'Cline · DeepSeek V4.1 Flash' },
  'minimaxintl/MiniMax-M3': { name: 'MiniMax 国际 · M3' },
  'minimax/MiniMax-M2.7-highspeed': { name: 'MiniMax · M2.7 Highspeed' },
  'autoclawintl/zai_glm-5.3-flash': { name: 'AutoClaw 国际 · GLM-5.3 Flash' },
  'gemini/gemini-3.8-flash': { name: 'Gemini · 3.8 Flash' },
  'accio/glm-5-3-flash': { name: 'Accio · GLM-5.3 Flash' },
  'codely/codely-flash': { name: 'Codely · Flash' },
  'magicrew/deepseek-v4.1-flash': { name: 'Magicrew · DeepSeek V4.1 Flash' },
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
 * 避免短前缀抢掉长前缀（`jet-hub-qoder/` vs `jet-hub-qodercn/`）。
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

/**
 * 未申报输出上限时的兜底值。
 *
 * ⚠️ **绝不能再兜底成 8192**（历史遗留的硬编码）。magpie 的路由组会按**选中成员**
 * 的 `limit.output` 夹请求里的 `max_tokens`，实证在 `~/.config/magpie/routing/`：
 *
 * | 渠道 | 走组时最大输出 | 直连时最大输出 |
 * |---|---|---|
 * | `jet-hub-lobsterai/deepseek-flash`（未申报 → 曾被兜底 8192） | **8192**（623 次全 ≤8192） | 40000 |
 * | `jet-hub-workbuddy/deepseek-v4.1-flash`（申报 128000） | 40000 | — |
 *
 * 也就是同一 provider/模型、「走组」永远出不了 8192，而「直连」同一参数能到 40000。
 * 被夹到 8192 的推理模型会把整个预算烧在 reasoning 上、`content` 为空、
 * `finish_reason=length` ⇒ 客户端（DSH）报「已达到输出 token 上限」，用户看到的是
 * 每几轮就被截断一次。
 *
 * 真值来源（见 `vendor/lib/officeace-product.js` 的注释）：DeepSeek-V4.1/V4-Flash 是
 * `max_tokens range is [1, 393216]`，GLM-5.x 是 `[0, 131072]`。
 * 系列认不出就**不申报**（省略 `limit.output`）—— 少一个字段只是让 magpie 按「未声明」
 * 处理，编一个 8192 却会让每次落到该成员的请求都被无端夹断。
 */
const OUTPUT_FALLBACKS = [
  // 不限 `$`：同族还有带后缀的变体（`deepseek-v4.1-flash-1017`、`deepseek-v4-flash-0731`、
  // `deepseek-v4-flash-vision-exp`），它们的真实上限与主型号一致。宁可报大一点
  // （报大只是不夹，上游自己会截），也不能报小 —— 报小就是这次的故障。
  [/deepseek.*flash/i, 393_216],
  // 同样不限行首：AutoClaw / Accio 的 id 是 `zai_glm-5.3-flash`、`glm-5-3-flash`。
  [/glm-5/i, 131_072],
]

/**
 * 解析单次输出上限：显式申报优先，其次按模型系列兜底，都不认识就返回 `undefined`
 * （调用方据此**省略** `limit.output`，而不是编一个值）。
 *
 * @param {string} id 模型名（已剥 provider 前缀）
 * @param {number|null|undefined} declared 本体/静态表申报的值
 * @returns {number|undefined}
 */
function outputLimit(id, declared) {
  if (typeof declared === 'number' && Number.isFinite(declared) && declared > 0) return declared
  for (const [pattern, value] of OUTPUT_FALLBACKS) {
    if (pattern.test(id)) return value
  }
  return undefined
}

/** 供回归测试直接验兜底口径（`tests/t-plugin.mjs`），不参与插件契约。 */
export { outputLimit }

/**
 * magpie 的模型条目。
 *
 * ⚠️ 宿主 `provider.models` 钩子的返回是**整体替换**（`out.models =
 * Object.fromEntries(...)`，见宿主 `host-*.js` 的 `info()`），不跟 models.dev
 * 的 capabilities 合并。所以**能力字段必须由这里给全**，少一个 magpie 界面上
 * 就少一样：不给 `limit.context` 就按 `0`/默认显示、不给
 * `capabilities.reasoning` 就显示「跟随分组推理」、不给
 * `capabilities.input.image` 就没有图片标记。
 *
 * 实测（2026-10-29，用户报「推理强度/支持图片输出/上下文没正确取到」）：修复前
 * 这里只有 `name` / `limit`（硬编码 128K / 8192）/ `tool_call`，于是 53 个模型
 * 全显示 128K，真窗口是 1M。
 *
 * ⚠️ **`limit.output` 与 `limit.context` 口径必须一致：不知道就别编。**
 * 2026-10-29 那次只把 `context` 改成真值，`output` 的 `?? 8192` 留了下来 ——
 * 这个 8192 会被 magpie 的路由组当成「该成员单次最多出 8192」，成为
 * 「已达到输出 token 上限」的根因（详见 {@link OUTPUT_FALLBACKS}）。
 *
 * @param {string} id 模型名（已剥 provider 前缀）
 * @param {{name?:string, limit?:{context?:number, output?:number}, tool_call?:boolean}} [def] 静态兜底表里的声明
 * @param {{context?:number, output?:number, input?:string[], reasoning?:boolean}} [meta] 从本体现采的能力元数据
 */
function modelEntry(id, def, meta) {
  const context = meta?.context ?? def?.limit?.context
  const output = outputLimit(id, meta?.output ?? def?.limit?.output)
  const input = Array.isArray(meta?.input) && meta.input.length > 0 ? meta.input : ['text']
  // 上游没声明模态时保守按纯文本（与本体各适配器「不声明即 text」同口径）：
  // 宁可少报能力，也别让用户发一张注定被上游拒绝的图。
  const hasImage = input.includes('image')
  const reasoning = meta?.reasoning ?? def?.reasoning ?? false
  const toolCall = def?.tool_call ?? true
  // magpie 界面的「上下文」列直接读 limit.context；`output` 只在知道真实上限时才发
  // （发 0 会被读成「确认不能输出」，发编造的 8192 会让路由组把请求夹断）。
  const limit = { context: context ?? 0 }
  if (output !== undefined) limit.output = output
  const entry = {
    name: def?.name ?? id,
    limit,
    tool_call: toolCall,
    capabilities: {
      temperature: true,
      reasoning,
      attachment: hasImage,
      toolcall: toolCall,
      input: {
        text: true,
        image: hasImage,
        audio: input.includes('audio'),
        video: input.includes('video'),
        pdf: input.includes('pdf'),
      },
      output: { text: true },
      interleaved: false,
    },
  }
  // 未声明就**不发**这几个字段（发 0 / false 会被读成「确认不支持」）。
  if (Array.isArray(meta?.input) && meta.input.length > 0) entry.modalities = { input: [...input], output: ['text'] }
  if (reasoning) entry.reasoning = true
  // magpie 的推理强度下拉只认插件给的档位列表：宿主对模型对象取
  // `Object.keys(m.variants ?? {})` 交给 magpie，magpie 再把它当 `Entry.Efforts`。
  // 没有 `variants` 就等于「会思考但一档都挑不了」——所以有档位才发、没档位不发。
  const efforts = Array.isArray(meta?.efforts) ? meta.efforts : []
  if (reasoning && efforts.length > 0) entry.variants = Object.fromEntries(efforts.map((e) => [e, {}]))
  return entry
}

// ---- 共享容器与模型缓存 -------------------------------------------------------

/** 模块级单例：23 个 provider 共用同一个容器。 */
let shared = null

/**
 * 预热容器的「开始时刻」。
 *
 * ## 为什么要预热（真实缺陷，2026-10-29 用户实测）
 *
 * magpie GUI 里点供应商的「连接」后，界面停在「请在浏览器中完成 … 登录 /
 * 正在开始登录…」不动 —— 因为 `signing.state` 一直是 `starting`，而它只在
 * `POST /api/plugin-signin` 返回后才推进。那条路径会调本插件的 `authorize()`，
 * 而 `authorize()` 第一句就是 `await liveAll(container, log)` = `container.start()`
 * —— **冷启动要 20–30 秒**（本体要拉账号池、注册全部 provider、采模型目录）。
 *
 * 后端不是坏了：用 `magpie web` 的 HTTP 面实测同一条链路 0.7 秒返回 done
 * （因为那时宿主进程已经跑过一轮、容器是热的）；CLI `magpie plugin login`
 * 也能 14 秒成功。**只有 GUI 冷启那一次会卡**。
 *
 * 修法：工厂被宿主加载时（`containerFor` 第一次调用）就在后台把容器起起来，
 * 等用户真的去点「连接」时它多半已经就绪。预热失败不影响任何功能 ——
 * 真正的 `start()` 调用会重试（`container.start()` 失败会把 `ready` 清掉）。
 */
let warmedUp = false

/**
 * 丢掉已建的单例，下次 `containerFor()` 重新建。
 *
 * 给测试用：单例一旦建立就按第一个 `options.home` 钉死，而
 * `tests/t-usage.mjs` 这类文件要先跑隔离段（假 home）再跑真实段（真
 * `~/.dsh`）—— `iso.restore()` 只能恢复环境变量，换不掉已经建好的容器，于是真
 * 实段读到的还是隔离目录（没凭据 ⇒ 余额为空、`user` 为 undefined）。
 *
 * ⚠️ 只给测试用，不要在生产路径里调。
 */
export function __resetContainerForTest() {
  shared = null
  warmedUp = false
}

function containerFor(options, log) {
  if (shared !== null) return shared
  shared = new JetHubContainer({
    home: resolveHome(options?.home),
    entryPath: resolveEntry(options?.entryPath),
    log,
  })
  return shared
}

/**
 * 后台预热容器（幂等，只跑一次）。
 *
 * ⚠️ 必须 `.catch()` 掉：预热失败是正常情况（比如 DSH 从没登录过），
 * 未处理的 promise rejection 会让宿主进程报错。真正的调用方会自己重试。
 */
function warmUp(container, log) {
  if (warmedUp) return
  warmedUp = true
  container
    .start()
    .then(() => log?.('容器预热完成（冷启动不再阻塞「连接」）'))
    .catch((e) => log?.(`容器预热失败（不影响后续调用，会重试）：${e?.message ?? e}`))
}

/**
 * 本体 provider 名 → 「是否跳过死号」的判定函数。
 *
 * 容器层（`container.mjs` 的 `_filterDeadAccounts`）不知道 magpie 开关的存在，
 * 只认 `container.deadSkipCheck(provider)` 这个回调；这里把每个 provider 在
 * magpie 里拨的 `dead_account_skip` 开关注册进去。工厂每次被调用都覆盖一次，
 * 最后一次（宿主最终加载的那份 input）生效 —— 同一宿主下 input 是同一份。
 */
const DEAD_SKIP = new Map()

/** 模型缓存文件（落盘，下次启动首屏就是真实目录）。 */
const cacheFile = join(homedir(), '.config', 'magpie', 'jet-hub-models.json')

/** 最近一次拿到的**实时可用**模型 id（`<provider>/<model>`，从 `ctx.llm` 现采）。 */
let allModels = undefined

/**
 * 最近一次拿到的**上游全量**目录（来自本体 `model.list` RPC）。
 *
 * ⚠️ 与 `allModels` 的区别（实测数据，别混用）：
 *   - `allModels` = 此刻**能用**的 —— astudio 1 / cline 1 / workbuddy 2
 *   - `fullModels` = 上游**全量** —— astudio 9 / cline 540 / workbuddy 32
 * 用户要的是后者出现在 magpie 的模型列表里（m06921）。
 */
let fullModels = undefined

/**
 * 能力元数据：`<本体 provider>/<model>` → `{ context, output, input, reasoning }`。
 *
 * `allModels` / `fullModels` 都只是 id（全量那份多 name/disabled），magpie 要的
 * 上下文窗口、能不能发图、有没有思考档位只能单独记。来源两处：
 * 本体 `ctx.llm` 现采（`container.modelMeta`）与落盘缓存的 `meta` 字段。
 */
let metaById = new Map()

/** 取某个 `<provider>/<model>` 的能力元数据（没有就 undefined）。 */
function metaOf(fullId) {
  return metaById.get(fullId)
}

/** 把容器刚采到的能力元数据同步进模块级表（缓存写盘也读它）。 */
function absorbMeta(container) {
  const got = container?.modelMeta
  if (got instanceof Map && got.size > 0) metaById = new Map(got)
}

function readCache() {
  try {
    const j = JSON.parse(readFileSync(cacheFile, 'utf8'))
    const out = {}
    if (Array.isArray(j?.models) && j.models.length > 0) out.live = j.models
    if (Array.isArray(j?.full) && j.full.length > 0) out.full = j.full
    if (j?.meta !== null && typeof j?.meta === 'object' && !Array.isArray(j.meta)) out.meta = j.meta
    return out
  } catch { /* 没有缓存是正常情况 */ }
  return {}
}

/* ── 积分余额 ────────────────────────────────────────────────────────────
 *
 * 本体 `credits.balances` 一次返回**整家渠道所有账号**的余额：
 *
 *   { accounts: [ { accountId, nickname,
 *       balance?: { total, expiredTotal,
 *         packages: [ { name, unit, remaining, total, used, active,
 *                       cycleStartTime, cycleEndTime, expiredTime,
 *                       deductionEndTime } ] },
 *       error?: string } ] }
 *
 * 实测（2026-10-28）：workbuddy 20 账号 / cline 6 / buddy 3，其余 1–2；
 * 部分渠道返回的是**错误字符串而不是 balance**（codearts `APIG.0301`、
 * accio `NOT_LOGIN`、buddy `余额查询失败`），这些要原样报给用户，
 * 不能吞掉当成 0 积分。
 *
 * 结果按 `<provider>|<accountId>` 缓存 90 秒：magpie 会把同一家渠道下
 * 每个账号的用量卡都问一遍，逐个打上游会被限流。
 */

const BALANCE_TTL_MS = 90_000
/** @type {Map<string, {at:number, reading:object|undefined}>} */
const balanceCache = new Map()

/* ── 按账号：列出 / 解析 ──────────────────────────────────────────────────
 *
 * magpie 侧「一个 provider 多个账号」要求插件能做两件事：
 *  ① 签入时**列出**本家渠道在 DSH 里的全部账号，让用户挑一个（`ask()`）；
 *  ② 每次请求时**认回**用户当初挑的是哪一个（`loader(getAuth)`）。
 *
 * 两件事都靠本体 `account.list` RPC（`vendor/lib/jet-hub-rpc.js:3188`，
 * 返回 `{ accounts: [{ id, provider, nickname, enabled, credentialRef,
 * refreshable, expiresAt, modelRateLimits }] }`，且已做 identity 富化）。
 */

/** 账号列表的短缓存：签入流程里 `ask()` 与 `authorize()` 会连着问两次。 */
const ACCOUNTS_TTL_MS = 15_000
/** @type {Map<string, {at:number, rows:Array<object>}>} */
const accountsCache = new Map()

/**
 * 列某家渠道在本体里的全部账号。
 *
 * ⚠️ `account.list` **必须带 provider**：不带会返回空数组（本体把它当
 * 「列全部」但实现只按 provider 过滤，实测 56 个账号的家返回 `{accounts:[]}`）。
 */
async function listAccountsOf(container, provider, log) {
  const hit = accountsCache.get(provider)
  if (hit !== undefined && Date.now() - hit.at < ACCOUNTS_TTL_MS) return hit.rows
  let rows = []
  try {
    const v = await container.rpc('account.list', { provider })
    rows = Array.isArray(v?.accounts) ? v.accounts : []
  } catch (e) {
    // 少数渠道本机没登录过时 `account.list` 也可能失败；这不是错误，
    // 是「这家没有账号可选」，返回空数组让调用方走「整家一个槽」。
    //
    // ⚠️ **失败不进缓存**（2026-10-30 修）。原先这里 `rows = []` 之后照样落到
    // 下面那行 `accountsCache.set`，于是「容器刚起、账号池还没加载完」时的一次
    // 失败会把空数组缓存满 `ACCOUNTS_TTL_MS`（15 秒）。这 15 秒里 `ask()` 的
    // `rows.length === 0` 命中 ⇒ 用户点「连接」**根本看不到账号选择列表**，被
    // 静默签成「整家一个槽」—— 正是用户最初报的「我选了 B 却走了 A」。
    // `warmUp()` 只是降低概率（异步、不保证 `ask()` 时预热已完成），兜不住。
    // 空数组只在**成功但确实没账号**时才值得缓存。
    log?.(`[${provider}] 列账号失败：${e?.message ?? e}`)
    return []
  }
  accountsCache.set(provider, { at: Date.now(), rows })
  return rows
}

/**
 * 把用户挑的账号 id 解析回池里那一条。
 *
 * 找不到（账号在 DSH 里被删了 / magpie 记录陈旧）返回 undefined —— 调用方
 * 应当退回「整家一个槽」的行为，而不是让请求 502。
 */
async function accountById(container, provider, id, log) {
  const want = String(id ?? '').trim()
  if (want === '') return undefined
  const rows = await listAccountsOf(container, provider, log)
  return rows.find((a) => String(a?.id ?? '') === want)
}

/* ── 新建账号：把本体的登录流程包成 magpie 的 oauth 型签入方法 ────────────
 *
 * magpie 只认两种签入方法（`internal/plugin/providers.go` 的
 * `type Method struct { Type, Label ... }`，`Type` 只有 `"oauth"` / `"api"`）：
 *   · `api`   —— 插件直接给一个 key（本插件的「接已有账号」走这条）；
 *   · `oauth` —— 插件给一个授权页地址，用户在浏览器里完成，插件自己收口。
 *
 * 用户报「只能添加已有账号，不能新建账号」（2026-10-29）：因为此前只声明了
 * 一个 `api` 型方法，magpie 供应商页里就只能「接一个已经在 DSH 里的号」。
 * 要让用户在 magpie 里真的**新建** DSH 账号，必须再声明一个 `oauth` 型方法，
 * 把本体那条 `account.create` → `login.poll` →（失败/放弃则）`account.delete`
 * 的登录流程包进去。
 *
 * 契约（宿主 `authorize()` / `callback()`）：
 *   · `authorize()` 返回 `{ url, instructions?, opened?, callback(code?) }`；
 *     宿主把它存进 `sessions` map，并把 `url` 交给 magpie 打开；
 *   · magpie 随后（非 `"code"` 型）**立刻**在后台调宿主 `callback({session})`，
 *     宿主转而调我们返回的 `callback()` —— 它要**阻塞**到用户授权完成；
 *   · `callback()` 返回 `{ type: 'success', key, accountId, metadata }` 才算
 *     签入成功（宿主 `save()` 据此落一条 `api` 型账号记录）。
 *
 * ⚠️ `authorize()` 有 **1 分钟**硬超时（magpie 侧
 * `pluginBegin()` 用 `context.WithTimeout(..., time.Minute)` 包
 * `plugin.Authorize`），所以里面只能等 `account.create`，**不能等用户** ——
 * 等用户是 `callback()` 的事。
 */

/**
 * 本体里**没有** `account.create` 分支的两家（`unknown provider: xxx`）：
 * 都是 Key 型渠道，走各自的 `*.addAccount`，不接受 `account.create`。
 * 对它们不声明「新建账号」方法，免得用户点了才看到 `unknown provider`。
 * 不能 `export`：`index.mjs` 只许导出插件工厂（多导一个就整个插件加载失败），
 * 且 `tests/t-new-account.mjs` 会把本文件切段丢进 `new Function` 求值，
 * 段内出现 `export` 直接 SyntaxError。测试侧从源码文本里解析它。 */
const NO_NEW_ACCOUNT = new Set(['modelscope', 'opencode'])

/**
 * 超级麦吉（magicrew）`account.create` 要走的 `mode`，按顺序试。
 *
 * 这一家的 `account.create` **必须**带 `mode`，不带会被本体直接拒：
 * `'超级麦吉请用「从本机浏览器导入」或「网页登录」，不支持手机号密码登录'`
 * （`vendor/lib/jet-hub-rpc.js` 的 `case 'account.create'` 里 magicrew 兜底分支）。
 *
 * ① `local-browser` —— 读本机 Edge/Chrome 里已登录 `www.letsmagic.cn` 的登录态
 *    （leveldb，只读不碰 cookie）：毫秒级、不开窗、按 **jwt 指纹**幂等判重，
 *    同一账号反复导入只会刷新那一条、不会变出多张卡。读不到时本体回
 *    `ok: false`（不是抛错），`container.rpc()` 会把它转成一句人话错误。
 * ② `browser` —— ①读不到时退它：本体登记占位条目后**自己**开一个独立 profile
 *    的可见窗口等用户登录，立刻返回 `{ accountId, loginUrl: '' }`；
 *    进度由 `login.poll` 经 `magicrewBrowserLoginInFlight` 报终态。
 *
 * 先试 ① 的理由：它是零门槛那条（用户只要在浏览器里登录过就成），而 ② 要用户
 * 真的再登一次、还要等几分钟。
 */
const MAGICREW_CREATE_MODES = ['local-browser', 'browser']

/** 轮询 `login.poll` 的间隔（本体登录流程最短也要一两秒，2 秒够用且不吵）。 */
const LOGIN_POLL_MS = 2_000

/**
 * 等用户在浏览器里完成授权的上限。
 *
 * 取 9 分钟而不是更久：magpie 自己的插件签入超时是 **10 分钟**
 * （magpie 的 `signInTimeout`，`internal/provider/signin.go`），我们必须在它
 * 之前收口并返回可读的失败原因，否则用户只会看到一句「超时」而不知道是
 * 自己没登录完。
 */
const NEW_ACCOUNT_WAIT_MS = 9 * 60 * 1000

/**
 * 单次 `login.poll` 的上限。
 *
 * 为什么必须有：`container.rpc()` 本身**没有超时**（它只是 `route.fetch()`），
 * 而 `login.poll` 内部会去 `credentials.resolve()`，officeace / astudio 还有
 * 「凭据不可用时现换一次」的分支 —— 那是会走网络的。一次轮询如果挂住，
 * `waitForLogin()` 就永远不返回：magpie 那边 10 分钟到点报超时，插件这边还
 * 卡在 await 上，占位账号永远不会被收掉。
 *
 * 取 15 秒：正常轮询是毫秒级（实测全部渠道 `model.list` 全量也才 1.2 秒），
 * 15 秒只会在真出问题时触发，届时当作「这一次没问到」继续等。
 */
const LOGIN_POLL_TIMEOUT_MS = 15_000

/**
 * 单次 `account.create` 的上限。
 *
 * 为什么也要有：本体 `account.create` 里**先**登记占位账号、**再** await 各家的
 * `startLogin()`（qoder / loomy / raccoon / minimaxintl / gemini / officeace /
 * autoclaw / astudio 都是这个形状）。某家 `startLogin` 如果长时间不返回，占位已经
 * 进池、`rpc()` 却不返回 —— `authorize()` 就卡在那儿，magpie 侧 1 分钟硬超时到点
 * 取消，插件这边还在 await，占位就没人收。
 *
 * 取 45 秒：必须小于 magpie 给 `authorize()` 的 1 分钟
 * （magpie 的 `pluginBegin()` 里 `context.WithTimeout(..., time.Minute)`），
 * 又要给各家起登录流程留足余量（实测最慢的 workbuddy 也就 2 秒级）。
 */
const CREATE_TIMEOUT_MS = 45_000

/**
 * `container.start()` 的上限。
 *
 * 为什么也要有：`authorize()` 整个被 magpie 的 1 分钟硬超时包着
 * （`pluginBegin()` 的 `context.WithTimeout(..., time.Minute)`），而
 * `container.start()` 自己允许等到 40 秒（`src/container.mjs` 的 `hardDeadline`）。
 * 40 秒 + 45 秒（`CREATE_TIMEOUT_MS`）= 85 秒，早就撞穿那 1 分钟了 ——
 * 这条预算以前没算进来（2026-10-29 二审指出）。
 *
 * 取 12 秒：实测冷启动 1.4 秒，正常情况 `warmUp()` 早已起好，这里只是兜底。
 * 注意 `start()` 是**幂等共享 promise**，在外面 race 掉它只是让本次 `authorize()`
 * 尽快失败，不会取消真正在跑的启动，下一次调用照样复用同一个 promise。
 */
const START_TIMEOUT_MS = 12_000

/**
 * 给一个 promise 套上限，超时抛可读错误。
 *
 * 注意**不要**给这个定时器加 `unref()`：被等的 promise 真挂住时，事件循环里就只剩
 * 这个定时器了，`unref()` 会让 Node 判定「无事可做」直接退出（表现为
 * `Warning: Detected unsettled top-level await` + 退出码 13），超时错误永远抛不出来。
 * 收口靠 `finally` 里的 `clearTimeout`，正常路径不会让进程多活。
 */
async function withDeadline(promise, ms, what) {
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} ${ms}ms 没有返回`)), ms)
  })
  try {
    return await Promise.race([promise, guard])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 给一次 `container.rpc()` 套上上限，超时抛可读错误。
 *
 * `container.rpc()` 本身没有超时（见 `src/container.mjs` 的 `rpc()`），所以凡是
 * 「本体可能长时间不返回」的调用都得自己套一层。
 */
async function withRpcDeadline(container, method, payload, ms, what) {
  return withDeadline(container.rpc(method, payload), ms, what)
}

/**
 * 让本体起一个登录流程，拿到「登录页地址 + 占位账号 id」。
 *
 * 本体是**两步式**：先同步写好一条占位账号（无凭据、`nickname === id`、
 * `refreshable: false`）再返回 `loginUrl`，登录成功后由后台流程回填昵称与
 * 有效期。所以这里返回的 `accountId` 此时还只是个占位，不能当成「已登录」。
 */
async function startNewAccount(container, provider, log, mode) {
  // 只有超级麦吉要带 `mode`（见下方 `MAGICREW_CREATE_MODES` 的说明），
  // 其余 22 家多传一个未知字段会被本体忽略，但没必要冒这个险 —— 不传就不带。
  const v = await withRpcDeadline(
    container,
    'account.create',
    mode === undefined ? { provider } : { provider, mode },
    CREATE_TIMEOUT_MS,
    'account.create',
  )
  const accountId = String(v?.accountId ?? '').trim()
  const loginUrl = String(v?.loginUrl ?? '').trim()
  if (accountId === '') {
    throw new Error(
      `本体没能为 ${provider} 起一个登录流程（account.create 返回 ${JSON.stringify(v).slice(0, 160)}）`,
    )
  }
  // 新占位已进池：下次 ask() / accountById() 必须看到它，别拿旧缓存
  accountsCache.delete(provider)

  // ⚠️ 有一种**成功**返回也带空 loginUrl：本体 astudio 分支在「登录方式不是 web
  // 且导入本机会话成功」时回 `{ accountId, loginUrl: '', reused: true }`
  // （vendor/lib/jet-hub-rpc.js 的 `case 'account.create'` astudio 段），此时账号
  // 条目**已登记**、凭据**已写入**，只是不需要授权页。早前这里把空 URL 一律当失败
  // 抛错（2026-10-29 审查发现）：用户看到「新建失败」，池里却多了一个凭据齐全的
  // 可用账号，而且没人清理它。
  // 另两种**成功**的空 loginUrl：
  // · 超级麦吉 `local-browser` —— 从本机浏览器导入登录态，凭据在 `create` 返回前
  //   就已写进该账号自己的 ref（`vendor/lib/jet-hub-rpc.js` 的 `mode === 'local-browser'`
  //   段），同样没有授权页可等 ⇒ 按 `reused` 收口。
  // · 超级麦吉 `browser` —— 占位已登记、**本体自己在后台开窗**等用户登录，
  //   `login.poll` 经 `magicrewBrowserLoginInFlight` 报终态 ⇒ 必须照常走
  //   `waitForLogin()`，绝不能当 `reused`（那会把一张还没填凭据的卡报成已添加）。
  if (loginUrl === '') {
    if (v?.reused === true || mode === 'local-browser') {
      log?.(`[${provider}] 已导入本机会话 ${accountId}（无需授权页）`)
      return { accountId, loginUrl: '', reused: true, incognitoOpened: false }
    }
    if (mode === 'browser') {
      log?.(`[${provider}] 新建账号 ${accountId}，本体自己开窗等登录`)
      return { accountId, loginUrl: '', reused: false, incognitoOpened: true }
    }
    throw new Error(
      `本体没能为 ${provider} 起一个登录流程（account.create 返回 ${JSON.stringify(v).slice(0, 160)}）`,
    )
  }

  log?.(`[${provider}] 新建账号 ${accountId}，登录页 ${loginUrl}`)
  return { accountId, loginUrl, reused: false, incognitoOpened: v?.incognitoOpened === true }
}

/**
 * 起一个登录流程，按 provider 决定要不要按顺序试多种 `mode`。
 *
 * 除超级麦吉外都是单次调用（`mode === undefined`，payload 里不带这个字段）。
 * 超级麦吉两条腿都失败时，**报第二条腿的错误**：`local-browser` 的失败是
 * 「本机浏览器里没有登录态」这种预期内的话，用户真正会撞上的失败是 `browser`
 * 那条（窗口起不来 / 授权被拒），报它才定位得到问题。
 */
async function startNewAccountSmart(container, provider, log) {
  if (provider !== 'magicrew') return startNewAccount(container, provider, log)

  let firstError
  for (const mode of MAGICREW_CREATE_MODES) {
    try {
      return await startNewAccount(container, provider, log, mode)
    } catch (error) {
      if (firstError === undefined) {
        firstError = error
        log?.(`[${provider}] ${mode} 没成（${error?.message ?? error}），退下一个 mode`)
      } else {
        throw error
      }
    }
  }
  // 兜底：`MAGICREW_CREATE_MODES` 若被改成空数组，循环一次都不进，
  // `firstError` 会是 `undefined` —— 那样 `throw undefined` 会丢成
  // 「Uncaught undefined」，用户在 magpie 里只看到一句空白失败。
  throw firstError ?? new Error(`${provider}：没有任何可用的新建方式`)
}

/**
 * 摸一次登录进度。三种终态都要认：
 * · `{done:false}` —— 还在等（含「占位已被删但没记失败」的情形，靠超时兜）；
 * · `{done:true, success:true}` —— 成功；
 * · `{done:true, success:false, error}` —— 失败，`error` 是本体给的人话。
 */
async function pollLoginOnce(container, accountId) {
  // 单次轮询必须有上限，否则一次挂住的 rpc 会让整个等待永不返回（见上方常量注释）。
  let timer
  // ⚠️ 这里**不能** `timer.unref()`：unref 过的定时器不算活跃句柄，一旦 `rpc()`
  // 真的挂住，事件循环里就只剩这一个「不算数」的定时器，Node 会判定无事可做
  // 直接退出（实测：`Warning: Detected unsettled top-level await` + 进程空转退出）。
  // 正常的收口靠下面的 finally clearTimeout，不会让进程多活 15 秒。
  const guard = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`login.poll ${LOGIN_POLL_TIMEOUT_MS}ms 没有返回`)),
      LOGIN_POLL_TIMEOUT_MS,
    )
  })
  try {
    const v = await Promise.race([container.rpc('login.poll', { accountId }), guard])
    return { done: v?.done === true, success: v?.success, error: v?.error }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 阻塞等本体那边登录完成。
 * @returns `{ ok: true }` 或 `{ ok: false, error }`
 */
async function waitForLogin(container, provider, accountId, log) {
  const deadline = Date.now() + NEW_ACCOUNT_WAIT_MS
  let lastError = ''
  for (;;) {
    try {
      const s = await pollLoginOnce(container, accountId)
      if (s.done) {
        if (s.success === false) {
          return { ok: false, error: String(s.error || '浏览器里没有完成授权') }
        }
        accountsCache.delete(provider)
        log?.(`[${provider}] 新账号 ${accountId} 已登录`)
        return { ok: true }
      }
    } catch (e) {
      // 单次轮询失败不算终态（容器刚起来 / 路由短暂不可用），接着等
      lastError = String(e?.message ?? e)
    }
    if (Date.now() >= deadline) {
      // 不足 1 分钟时说秒 —— 直接 Math.round(ms/60000) 会得到「等了 0 分钟」
      const waited = NEW_ACCOUNT_WAIT_MS >= 60_000
        ? `${Math.round(NEW_ACCOUNT_WAIT_MS / 60_000)} 分钟`
        : `${Math.round(NEW_ACCOUNT_WAIT_MS / 1_000)} 秒`
      return {
        ok: false,
        error: `等了 ${waited}还没在浏览器里完成授权${lastError === '' ? '' : `（最后一次轮询失败：${lastError}）`}`,
      }
    }
    await new Promise((r) => setTimeout(r, LOGIN_POLL_MS))
  }
}

/**
 * 放弃这次新建：把本体留下的占位账号收掉。
 *
 * ⚠️ 删之前**再摸一次** `login.poll`：本体 `account.create` 一返回就把占位写进
 * 池里了，而用户可能恰在超时那一刻登录完成 —— 那次凭据是真金白银，删账号会
 * 连带 `credentials.unset`，**不可逆**。轮询都问不出来时也按「保守不删」处理
 * （宁可留一条占位让用户在控制台删，也不误删一个刚登录好的号）。
 */
async function abandonAccount(container, provider, accountId, log) {
  // 返回三态而不是布尔：
  // · 'kept'    —— 再摸一次 poll 发现「其实已经登录成功了」，账号**没删**；
  // · 'unknown' —— 状态问不出来，保守不删；
  // · 'deleted' —— 确认没登录，占位已清掉（或清失败了，两者对调用方等价）。
  // 为什么必须是三态：早前这里返回 undefined，调用方一律 `throw new Error(waited.error)`
  // ⇒ 用户明明在超时那一刻登录成功了、账号也真留在池里，magpie 里那条记录却是红的，
  // 下一次「接已有账号」的 `ask()` 里会突然冒出一个陌生号（2026-10-29 审查发现）。
  try {
    const s = await pollLoginOnce(container, accountId)
    // ⚠️ 判据必须与 `waitForLogin()` 里那条**逐字一致**：`done === true` 不等于成功。
    // 本体 `login.poll` 里 `loginFailureOf()` 优先于一切进度判据 —— 用户关掉授权页、
    // 点拒绝、设备码输错超时，都会记下终态失败，此后每次 poll 都回
    // `{ done: true, success: false, error: '授权页被关掉了' }`。
    // 早前这里只判 `done === true` ⇒ 用户**任何**主动放弃都被当成「其实登录成功了」，
    // magpie 里留下一条绿色的「已新建」记录，而账号根本不存在（2026-10-29 二审发现）。
    if (s.done === true && s.success !== false) {
      log?.(`[${provider}] 放弃新建时发现 ${accountId} 其实已登录成功，保留它`)
      return 'kept'
    }
  } catch {
    log?.(`[${provider}] 放弃新建时问不到 ${accountId} 的状态，保守起见不删`)
    return 'unknown'
  }
  try {
    await container.rpc('account.delete', { accountId })
    accountsCache.delete(provider)
    log?.(`[${provider}] 放弃新建，已清掉占位账号 ${accountId}`)
  } catch (e) {
    log?.(`[${provider}] 清占位账号 ${accountId} 失败：${e?.message ?? e}`)
  }
  return 'deleted'
}

/**
 * 账号在 magpie 里显示成什么。
 *
 * 昵称优先（用户认得 `user-g7h8`，不认得 `workbuddy-9c0d1e2f`），后接 id 尾巴
 * 便于与 DSH / 控制台对上；已停用的标出来（否则用户会奇怪「为什么挑了它却 502」）。
 */
function accountLabel(a) {
  const nick = String(a?.nickname ?? '').trim()
  const id = String(a?.id ?? '')
  const tail = id.includes('-') ? id.slice(id.lastIndexOf('-') + 1) : id
  const base = nick !== '' && nick !== id ? `${nick}（${tail}）` : id
  return a?.enabled === false ? `${base} · 已停用` : base
}

/**
 * magpie 账号记录里的「这是哪个 DSH 账号」。
 *
 * 三个来源都认，顺序不能反：
 * 1. `metadata.dshAccountId` —— **实际生效的那一个**。宿主 `save()` 只落
 *    `metadata`（把 `ask()` 收上来的 inputs 与 `result.metadata` 并进去），
 *    `result.uid` 会被丢弃；
 * 2. `uid` —— 宿主目前不写，但 `scripts/seed-auth.mjs` 直接写 auth.json 的
 *    那条带它，所以照样认（将来宿主若开始写，这里自然生效）；
 * 3. `key` 尾巴 —— 最后的退路（`jet-hub-local:<provider>/<accountId>`）。
 *
 * ⚠️ 用 `||` 不用 `??`：`uid: ''` 是「有字段但没值」，`??` 会让它遮蔽后面
 * 有效的 `metadata.dshAccountId`，静默退化成「不钉」（用户会看到「我明明选
 * 了账号却按池内顺序选号」）。
 */
function dshAccountIdOf(record, provider) {
  const direct = String(record?.metadata?.dshAccountId || record?.uid || '').trim()
  if (direct !== '') return direct
  const key = String(record?.key || record?.metadata?.key || '')
  const prefix = `jet-hub-local:${provider}/`
  if (key.startsWith(prefix)) return key.slice(prefix.length)
  return ''
}

/**
 * 取某家渠道的余额读数，**按账号 id 精确匹配**。
 * @returns 该账号那一条；渠道里找不到这个账号（路由组 / 未登录）返回 undefined
 */
async function balanceOf(container, provider, wantAccountId, log) {
  const stamp = `${provider}|${wantAccountId}`
  const hit = balanceCache.get(stamp)
  if (hit !== undefined && Date.now() - hit.at < BALANCE_TTL_MS) return hit.reading

  let accounts = []
  try {
    const v = await container.rpc('credits.balances', { provider })
    accounts = Array.isArray(v?.accounts) ? v.accounts : []
  } catch (e) {
    const msg = String(e?.message ?? e)
    // 少数渠道本机没登录过时 `credits.balances`
    // 直接抛 `unsupported provider`。这不是错误，是「这里没有可查的积分」。
    if (/unsupported provider/i.test(msg)) {
      balanceCache.set(stamp, { at: Date.now(), reading: undefined })
      return undefined
    }
    log?.(`[${provider}] 余额查询失败：${msg}`)
    // 失败也落缓存，避免同一轮里 magpie 把失败重打 N 次
    const reading = { provider, accountId: wantAccountId, error: String(e?.message ?? e) }
    balanceCache.set(stamp, { at: Date.now(), reading })
    return reading
  }

  // 整家渠道的读数一次拿全，顺手给每个账号都写进缓存
  let mine
  for (const a of accounts) {
    const reading = {
      provider,
      accountId: String(a?.accountId ?? ''),
      nickname: a?.nickname,
      balance: a?.balance,
      error: a?.error,
    }
    balanceCache.set(`${provider}|${reading.accountId}`, { at: Date.now(), reading })
    if (reading.accountId === wantAccountId) mine = reading
  }
  // 账号 id 对不上时（老记录没有 uid）退回一条，总比空白好。
  // ⚠️ 但别盲取 `accounts[0]`：本体是**逐账号兜错**的（vendor/lib/jet-hub-rpc.js 的
  //    collectCreditBalances 把单账号的异常塞进该条的 error 字段，其余账号照常返回），
  //    所以第一条可能正好是坏账号 —— 实测 workbuddy 20 个账号里只有
  //    workbuddy-7e8f9a0b 一个坏，盲取第一条会把整张卡变成一句内部报错。
  //    优先挑一条没有 error 的，全都坏才退回第一条。
  if (mine === undefined && wantAccountId === '' && accounts.length > 0) {
    const pick = accounts.find((a) => a?.error === undefined) ?? accounts[0]
    mine = balanceCache.get(`${provider}|${String(pick?.accountId ?? '')}`)?.reading
  }
  balanceCache.set(stamp, { at: Date.now(), reading: mine })
  return mine
}

/**
 * 把本体的签到结果翻译成 magpie 的 `auth.checkin` 返回形状。
 *
 * 本体的 `kind` 与 magpie 的 `outcome` 不是一一对应：
 *   - `claimed`          → `claimed`（并带上 credit / streak）
 *   - `already-claimed`  → `done`（今天已经领过了）
 *   - `inactive`         → `inactive`（活动没开）
 *   - `exhausted`        → `done`（额度已经领完，等同于今天无事可做）
 *   - 其它 / `failed`    → `failed`，把原文塞进 message
 */
function toMagpieCheckin(row) {
  const o = row?.outcome ?? {}
  const kind = String(o?.kind ?? '')
  const credit = Number(o?.credit)
  const message = o?.message === undefined ? undefined : String(o.message)
  const base = {
    ...(Number.isFinite(credit) && credit > 0 ? { credit } : {}),
    ...(message !== undefined ? { message } : {}),
  }
  switch (kind) {
    case 'claimed':
      return { outcome: 'claimed', ...base }
    case 'already-claimed':
      return { outcome: 'done', ...base }
    case 'inactive':
      return { outcome: 'inactive', ...base }
    case 'exhausted':
      return { outcome: 'done', ...base }
    case 'captcha':
      return { outcome: 'captcha', ...base }
    default:
      return { outcome: 'failed', message: message ?? (kind === '' ? '本体未返回签到结果' : kind) }
  }
}

/**
 * 把本体透出来的余额错误文案翻成人话。
 *
 * 本体的 `credits.balances` 是逐账号兜错的，单账号失败时会把**原始异常 message**
 * 塞进 `error` 字段（`vendor/lib/jet-hub-rpc.js` 的 collectCreditBalances）。于是
 * 用户会在 magpie 的用量卡上看到 `Cannot read properties of undefined (reading 'id')`
 * 这种内部堆栈文案 —— 对使用者零信息量，看着像插件崩了。
 *
 * 这里只做**文案层**的翻译：认得出的内部错误换成人话，认不出的原样透传
 * （不吞信息 —— 真出问题还得靠原文定位）。
 */
function humanizeUsageError(error) {
  const text = String(error ?? '')
  if (/^Cannot read propert(y|ies) of/.test(text)) {
    return `该账号的余额查询内部出错（${text}），换个账号或重新登录后重试`
  }
  if (/refresh token/i.test(text)) {
    return `该账号的登录已过期（${text}），到 DSH 里重新登录一次即可`
  }
  return text
}

/**
 * 同名同单位的积分包合并成一条。
 *
 * 本体（以及上游）会把「签到奖励」这类小额包**逐次**列出来：实测 trae 一个账号
 * 有 31 条 `{name:'签到奖励', total:100}`，每条都变成一个 window，
 * magpie 就把卡片撑成一长列 —— 用户看到的是「积分包占比太大」，整块用量页被
 * 一堆 100/100 淹没，真正的「每月登录赠送 500」反而找不到。
 *
 * 合并语义：`total` / `remaining` 求和，`resetsAt` 取**最早**到期的那一份
 * （最近要过期的先提醒），只有整组都 `active === false` 才标 `aside`。
 * 合并后 `count > 1` 的条在名字后面加 `×N`，让人知道它代表几个包。
 *
 * ⚠️ 「最早到期」会抹掉组内其余包的日期（实测 trae 的 31 条签到奖励到期日
 * 分散在 10-31 到 11-30 整整一个月），所以这里把**每一份的到期时间都留下**
 * （`untils`），交给 `toMagpieUsage` 在排序和文案里用 —— 用户 m07331 要的是
 * 「看到每个积分包的过期时间，并按到期顺序展示」。
 */
function mergePackages(list) {
  const byKey = new Map()
  for (const p of list) {
    const name = String(p?.name ?? '积分')
    const unit = String(p?.unit ?? '')
    const total = Number(p?.total) || 0
    const remaining = Number(p?.remaining) || 0
    const used = Number(p?.used) || (total > 0 ? Math.max(0, total - remaining) : 0)
    const until = Number(p?.deductionEndTime)
    const hasUntil = Number.isFinite(until) && until > 0
    const key = `${name}\u0000${unit}`
    const cur = byKey.get(key)
    if (cur === undefined) {
      byKey.set(key, {
        name,
        unit,
        total,
        remaining,
        used,
        count: 1,
        // 组内**单个包**的最大额度 —— 排序用它而不是平均值，见 toMagpieUsage 的注释
        each: total,
        allInactive: p?.active === false,
        until: hasUntil ? until : undefined,
        // 组内每个包的到期时间（去重升序）。合并后仍要能逐个报出来。
        untils: hasUntil ? [until] : [],
      })
      continue
    }
    cur.total += total
    cur.remaining += remaining
    cur.used += used
    cur.count += 1
    if (total > cur.each) cur.each = total
    cur.allInactive = cur.allInactive && p?.active === false
    if (hasUntil) {
      cur.untils.push(until)
      if (cur.until === undefined || until < cur.until) cur.until = until
    }
  }
  for (const g of byKey.values()) g.untils.sort((a, b) => a - b)
  return [...byKey.values()]
}

/**
 * 把毫秒时间戳写成卡片一行放得下的日期（本地时区）。
 *
 * 平时只写 `10-30`；但**不是今年的必须带年份** —— 否则 `2034-12-28` 会显示成
 * `12-28`，用户会当成一个多月后到期。这不是假想：workbuddy 的
 * `Free Plan Subscription` 实测到期就是 2034-12-28。
 *
 * `now` / `forceYear` 两个参数只为可测与跨年区间对称（同一组的首尾跨年时，
 * 两端都带年份，读起来才不会一半有一半没有）。
 */
function dateLabel(ms, now = Date.now(), forceYear = false) {
  const d = new Date(ms)
  if (!Number.isFinite(d.getTime())) return ''
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const showYear = forceYear === true || d.getFullYear() !== new Date(now).getFullYear()
  return showYear ? `${d.getFullYear()}-${md}` : md
}

/**
 * 一条 window 的显示名 —— 名字里带上到期信息。
 *
 * 为什么塞进 name 而不是只靠 resetsAt：magpie 的卡片行只渲染 `name` + 进度条
 * + 额度（`app.js` 的 `accountQuotaLine`），`resetsAt` 只进 tooltip，且只有
 * 用量 ≥80% 时才在行内补一句「resets in …」。想让用户**看一眼就知道哪个包
 * 先过期**，只能写进 name。
 *
 * 文案分三种：
 * · 组内只有一个到期日 → `10-30 到期`
 * · 组内到期日分散 → `10-31~11-30 到期`（实测 trae 的 31 条签到奖励正好横跨
 *   整整一个月，只报最早那一天会让用户以为其余的一起在 10-30 消失）
 * · 没有到期时间 → 不写（astudio 的星火积分、qoder 的资源包实测都没有）
 */
function windowName(pkg) {
  const base = pkg.count > 1 ? `${pkg.name} ×${pkg.count}` : pkg.name
  const days = Array.isArray(pkg.untils) ? pkg.untils : []
  if (days.length === 0) return base
  const firstMs = days[0]
  const lastMs = days[days.length - 1]
  const now = Date.now()
  // 同一组的首尾跨年 ⇒ 两端都带年份，避免 `11-04~04-01` 这种看着像倒着走的写法
  const crossYear = new Date(firstMs).getFullYear() !== new Date(lastMs).getFullYear()
  const first = dateLabel(firstMs, now, crossYear)
  if (first === '') return base
  const last = dateLabel(lastMs, now, crossYear)
  if (last === '' || last === first) return `${base} · ${first} 到期`
  return `${base} · ${first}~${last} 到期`
}

/**
 * 把本体的余额读数翻译成 magpie 的 `auth.usage` 返回形状。
 */
function toMagpieUsage(reading, provider) {
  // 用量卡标题同样不带前缀（与供应商卡片名一致，见 config() 里那处说明）。
  const plan = NAMES[provider] ?? provider
  if (reading?.error) return { plan, error: humanizeUsageError(reading.error), windows: [] }

  const b = reading?.balance
  if (b === undefined || b === null) return { plan, windows: [] }

  // ⚠️ 过滤 total=0 的空套餐：本体照样会返回 `{total:0, remaining:0}` 的条目
  //    （astudio 的「会员积分」实测就是这样），画成卡片就是「0/0、可用 100%」，
  //    纯误导。有 remaining 没有 total 的（按量计费）保留。
  const packages = mergePackages(
    (Array.isArray(b.packages) ? b.packages : []).filter(
      (p) => (Number(p?.total) || 0) > 0 || (Number(p?.remaining) || 0) > 0,
    ),
  )
  // 排序：**快到期的排前面**，aside（已失效）压到最后。
  //
  // 首判据是到期时间（用户 m07331：「按到期顺序展示」）—— 先过期的先花，
  // 让用户一眼看到「哪个包马上要浪费」。magpie 的卡片行**只画前 2 条**
  // （`app.js` 的 `accountQuotaLine` 里 `ws.slice(0, 2)`），所以排序不是装饰：
  // 排在第三位之后的包连名字都只能进 tooltip。
  //
  // 无到期时间的（astudio 的「星火积分」、qoder 的「资源包」实测都没有）
  // 排在**有到期的之后**：它们不会被浪费，不着急。
  //
  // 同档再按**组内单包最大额度**（`each`）降序 —— 既不是合并后的总余额，
  // 也不是平均值：
  // · 总余额不行：「签到奖励 ×20 = 2000」按总额会排到「每月登录赠送 = 500」前面，
  //   但前者是 20 个 100 的小包，后者才是真正的主套餐。
  // · 平均值不行：某家返回「1 个 500 的大包 + 19 个 1 的小包」时平均被稀释到 25，
  //   主套餐会被压到小包后面（2026-10-29 三审指出的脆弱点）。
  // · 最大值天然把「至少有一个大包」的组排在「全是一堆小包」的组前面。
  const untilRank = (p) => (Number.isFinite(p.until) && p.until > 0 ? p.until : Number.POSITIVE_INFINITY)
  packages.sort((a, b2) => {
    const aAside = a.allInactive ? 1 : 0
    const bAside = b2.allInactive ? 1 : 0
    if (aAside !== bAside) return aAside - bAside
    const au = untilRank(a)
    const bu = untilRank(b2)
    if (au !== bu) return au < bu ? -1 : 1
    if (a.each !== b2.each) return b2.each - a.each
    return b2.remaining - a.remaining
  })
  const windows = packages.map((p) => {
    const total = Number(p.total) || 0
    const remaining = Number(p.remaining) || 0
    const used = Number(p.used) || (total > 0 ? Math.max(0, total - remaining) : 0)
    const w = {
      // 名字带到期日（`签到奖励 ×31 · 10-30 到期`），理由见 windowName 的注释
      name: windowName(p),
      // used 是**已用百分比**（0–100），magpie 用它画进度条并写「剩余 100%」。
      // ⚠️ 别填 remaining —— 实测 astudio 会变成「0 / 6,200 · 剩余 100%」这种
      //    自相矛盾的卡片（显示剩余 0、进度条却是满的）。
      used: total > 0 ? Math.round((used / total) * 100) : 0,
      // display 是**剩余 / 总额**（magpie 自己的文案就是「剩余 x%」，这里对齐它）
      display: `${remaining} / ${total} ${p?.unit ?? ''}`.trim(),
      amount: remaining,
      limit: total,
      unit: String(p?.unit ?? ''),
    }
    // 到期：`deductionEndTime` 是毫秒时间戳，`cycleEndTime` 是本地时间串
    if (Number.isFinite(p.until) && p.until > 0) w.resetsAt = p.until
    // 过期/未生效的套餐不算「用完就停」，标 aside 让 magpie 别当主额度
    if (p.allInactive) w.aside = true
    return w
  })

  // 全部套餐都是 0/0 时 windows 为空，magpie 会显示一张没有内容的卡；
  // 这种情况退回 balance 文本，至少让人看见「0 积分」而不是空白。
  if (windows.length === 0) {
    const unit0 = packages[0]?.unit ?? '积分'
    return { plan, user: reading?.nickname !== undefined ? String(reading.nickname) : '', balance: `0 ${unit0}`.trim(), windows: [] }
  }

  const total = Number(b.total) || 0
  const unit = packages[0]?.unit ?? '积分'
  // 最早到期的那一份：magpie 用它显示「订阅到 X 到期」
  const untils = windows.map((w) => w.resetsAt).filter((t) => Number.isFinite(t) && t > 0)
  return {
    plan,
    user: reading?.nickname !== undefined ? String(reading.nickname) : '',
    balance: `${total} ${unit}`.trim(),
    ...(untils.length ? { until: Math.min(...untils) } : {}),
    windows,
  }
}

function writeCache(log) {
  try {
    mkdirSync(dirname(cacheFile), { recursive: true })
    // ⚠️ 只写**有值**的那份：全量目录要 20+ 秒才拉得到，先到的实时目录
    //    若把 `full: undefined` 写进去，会把上一次落盘的全量覆盖掉 ——
    //    实测踩过（缓存被写成只剩 models，861 条全量丢失）。
    const prev = (() => {
      try {
        return JSON.parse(readFileSync(cacheFile, 'utf8'))
      } catch {
        return {}
      }
    })()
    const out = {
      at: new Date().toISOString(),
      models: allModels ?? prev.models,
      full: fullModels ?? prev.full,
      // 能力元数据跟目录一起落盘：否则冷启动首屏只能按无上下文显示，
      // 要等本体 20–30 秒起来才有真实窗口。
      meta: metaById.size > 0 ? Object.fromEntries(metaById) : prev.meta,
    }
    writeFileSync(cacheFile, JSON.stringify(out, null, 2))
  } catch (e) {
    log?.(`写模型缓存失败（不影响使用）：${e?.message ?? e}`)
  }
}

/** 后台把两个目录都刷一遍（实时可用 + 上游全量）。 */
function refreshInBackground(container, log) {
  container
    .start()
    .then(() => container.refreshModels())
    .then((list) => {
      if (Array.isArray(list) && list.length > 0) allModels = list.slice()
      // 能力元数据跟 id 一起来自这一次 `_absorbModels`，必须同时同步。
      absorbMeta(container)
      return container.refreshFullCatalog(DSH_PROVIDERS)
    })
    .then((rows) => {
      if (Array.isArray(rows) && rows.length > 0) fullModels = rows
      // 全量目录那一趟也会用 `resolveModelInfo` 补能力（`model.list` 本身不带），
      // 所以这里要再同步一次 —— 只同步第一次的话落盘的就只有实时那几十条。
      absorbMeta(container)
      writeCache(log)
    })
    .catch((e) => log?.(`后台刷新模型目录失败：${e?.message ?? e}`))
}

/**
 * 目录的**重读间隔**。
 *
 * ⚠️ 必须有 TTL（实测踩过）：插件进程是常驻的，`allModels` / `fullModels`
 * 一旦有值就永不重读 —— 在别的进程里刷新了盘上缓存（`node scripts/snapshot-models.mjs`
 * 或另一次容器启动），这个进程仍然报旧数字，直到 magpie 重启。
 * 表现：`plugin list`（新进程）显示 cline 540，界面（常驻进程）仍显示 1。
 */
const CACHE_TTL_MS = 60_000
let lastReadAt = 0

/**
 * 拿目录，**绝不阻塞**。
 *
 * magpie 给 `provider.models` 的超时是 20 秒，而本体冷启动要 20–30 秒；
 * 直接 await 必然超时。故：有缓存立刻给，同时后台刷新；冷启动只预热。
 */
function currentAll(container, log) {
  const stale = Date.now() - lastReadAt > CACHE_TTL_MS
  if (allModels === undefined || fullModels === undefined || stale) {
    lastReadAt = Date.now()
    refreshInBackground(container, log)
    const seed = readCache()
    if (seed.live !== undefined) allModels = seed.live
    if (seed.full !== undefined) fullModels = seed.full
    if (seed.meta !== undefined) metaById = new Map(Object.entries(seed.meta))
  }
  return { live: allModels, full: fullModels }
}

/** 允许长时间等待的路径（authorize / usage）用这个。 */
async function liveAll(container, log) {
  const list = await container.refreshModels()
  if (Array.isArray(list) && list.length > 0) {
    allModels = list.slice()
    absorbMeta(container)
    writeCache(log)
  }
  return allModels ?? []
}

/** 全量目录里属于某个 provider 的那些，返回 magpie 的 models 形状。 */
function modelsOfFull(dshProvider, rows) {
  const out = {}
  const prefix = `${dshProvider}/`
  for (const row of rows ?? []) {
    const id = String(row?.id ?? '')
    if (!id.startsWith(prefix)) continue
    const bare = id.slice(prefix.length)
    const base = row?.name ?? bare
    // 已在上游关掉的模型照样列出（用户要全量），但把状态写进名字，
    // 免得选中后打不通却不知道为什么。
    // ⚠️ 第 1 参必须是**模型 id**（`bare`）而不是展示名：`modelEntry` 用它做
    // 系列兜底（{@link OUTPUT_FALLBACKS}）。以前这里传的是展示名，于是
    // `deepseek-flash` 这类 id 根本匹配不到兜底表，「未申报 output」的渠道
    // 一直是漏的。展示名走 `def.name`。
    const label = row?.disabled === true ? `${base} · 已在 Jet Hub 关闭` : base
    out[bare] = modelEntry(bare, label === bare ? undefined : { name: label }, metaOf(id))
  }
  return out
}

/** 实时可用目录里属于某个 provider 的那些（`list` 是 id 数组）。 */
function modelsOf(dshProvider, list) {
  const out = {}
  const prefix = `${dshProvider}/`
  for (const id of list ?? []) {
    if (!id.startsWith(prefix)) continue
    const bare = id.slice(prefix.length)
    out[bare] = modelEntry(bare, undefined, metaOf(id))
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
    // 后台起容器：用户点「连接」时它多半已经就绪，GUI 不会卡在「正在开始登录…」
    warmUp(container, log)

    /**
     * 读 magpie 里用户拨的开关（`auth.options` 声明的那些）。
     *
     * 契约：`input.magpie.option(provider, key) → boolean`，插件没声明过的 key 一律 false。
     * 宿主每次调用都现读，所以用户在 magpie 里拨完开关**不用重启**就生效。
     * 宿主没给 `input.magpie`（老版本 / 别的宿主）时退回默认值。
     */
    function optionOn(key, fallback = false) {
      try {
        if (typeof input?.magpie?.option === 'function') return input.magpie.option(id, key) === true
      } catch { /* 读不到就用默认 */ }
      return fallback
    }

    // 把「跳过死号」开关交给容器层（容器在 _filterDeadAccounts 里回调它）
    DEAD_SKIP.set(dshProvider, () => optionOn('dead_account_skip', true))
    container.deadSkipCheck = (p) => (DEAD_SKIP.get(p) ?? (() => true))()

    /**
     * 本 provider 的模型表（不阻塞）。
     *
     * 优先级：**上游全量** > 实时可用 > 静态兜底。
     * 用户要的是「供应商上游全部模型」（m06921），所以全量排第一；
     * 全量还没拉到时退回实时可用，保证首屏至少有东西可选。
     */
    function currentModels(provider) {
      const { live, full } = currentAll(container, log)
      // 用户可以在 magpie 里拨「模型列表用上游全量」这个开关关掉全量
      if (optionOn('prefer_full', true)) {
        const wide = modelsOfFull(dshProvider, full)
        if (Object.keys(wide).length > 0) return wide
      }
      const got = modelsOf(dshProvider, live)
      if (Object.keys(got).length > 0) return got
      return provider?.models ?? fallbackFor(dshProvider)
    }

    return {
      async config(cfg) {
        cfg.provider ??= {}
        cfg.provider[id] ??= {}
        const p = cfg.provider[id]
        // 卡片名直接用渠道自己的名字。magpie 的供应商列表本身就在本插件分组下，
        // 再给每家挂一遍 `Jet Hub · ` 只是把每行都顶掉一截、还让 `WorkBuddy` 这类
        // 本来一眼能认的名字变得要往右扫才看得见（用户 2026-10-30 要求去掉）。
        p.name = NAMES[dshProvider] ?? dshProvider
        p.npm = '@ai-sdk/openai-compatible'
        p.api = PLACEHOLDER_BASE
        // 目录：优先用**上游全量**缓存（同步读盘，不阻塞），没有缓存才退回静态表。
        // ⚠️ 别只写 fallbackFor：那样 magpie 的供应商详情页永远只显示 1 个模型，
        //    用户要的上游全量（cline 540 / workbuddy 32）看不到。
        p.models = currentModels(p)
      },

      auth: {
        provider: id,

        /**
         * **一个 provider 多个账号槽**（2026-10-29 改，原为 `single: true`）。
         *
         * 改的原因（用户实测报「在 magpie 中无法新建账号」）：`single: true` 让
         * 宿主的 `signInKey()` 每次都返回 `accountsOf(provider)[0]`，于是「连接」
         * 永远覆盖同一条记录 —— magpie 里看起来
         * 就是「加不出第二个账号」。
         *
         * 但单改这一行不够：本体选号只看**池内数组顺序**（`account-pool.js:1961`
         * 注释原文「账号列表的数组顺序就是候选优先级」），池里没有「钉住某号」
         * 的字段。所以本插件配套做了两件事：
         *  ① `authorize(inputs)` 把用户挑的 DSH 账号 id 编进 key 与 uid；
         *  ② `loader(getAuth)` 读当前账号，请求前在 `container.runPinned()` 的
         *     作用域里转发 —— 选号被收窄到那一个账号（见 `container.mjs` 的
         *     `_pinAccounts`）。
         * 三条合起来，「在 magpie 里挑哪个账号，请求就真的走哪个」才成立。
         */
        single: false,

        /**
         * magpie 供应商编辑器里的开关（契约 `optionsOf()`）。
         *
         * 用户在 magpie 里拨开关 → magpie 存起来 → 插件用
         * `input.magpie.option(provider, key)` 读（不重启就生效）。
         * key 必须是 `[a-z0-9_-]{1,40}`，最多 16 个；没有 key 或 label 的会被丢掉。
         *
         * 这里只放**真正被本插件读取**的开关，不放装饰性项。
         */
        options: [
          {
            key: 'prefer_full',
            label: '模型列表用上游全量',
            description: '打开：列出上游全量模型（含已关闭）；关闭：只列此刻真正可用的模型。',
            default: true,
          },
          {
            key: 'dead_account_skip',
            label: '跳过已过期且不可续期的账号',
            description: '关掉后，过期且 refreshable=false 的账号也会参与选号（会 502）。',
            default: true,
          },
        ],

        /**
         * magpie 的 provider 图标：https URL 或 data:image。
         * 每家一个（`PROVIDER_SVG`），别所有 provider 都用插件自己那个。
         */
        icon: iconFor(dshProvider),

        /**
         * 免输入签入：凭据早就在 `~/.dsh/.credentials.yaml` 里，容器启动即读到。
         * `keyless: true` 是 magpie 自己的字段，GUI/CLI 会跳过 personal-key 输入。
         */
        methods: [
          {
            type: 'api',
            keyless: true,
            label: `连接本机 DSH 账号（${NAMES[dshProvider] ?? dshProvider}，无需输入）`,

            /**
             * 签入前先问「哪一个是你要的账号」。
             *
             * 契约（宿主 `nextPrompt()`）：返回
             * `{ type, key, message, placeholder, options }` 或 null；返回非 null
             * 时 magpie 会把它渲染成选择框/输入框，用户答完再带着
             * `inputs[key]` 重调 `authorize()`。
             *
             * `type: 'select'` 会被前端渲染成一排按钮（magpie 前端渲染 prompt 的
             * `renderPluginAsk`，前端版本相关、行号会漂移，故不写具体行号），
             * 每个 `options[].value` 通过
             * `POST /api/plugin-signin/prompt` 回填进 `inputs`。
             *
             * ⚠️ **必须能返 null**：一家渠道只有一个账号（或本体里查不到账号）时
             * 不该弹选择框 —— 那会让「就一个号」的用户多点一次。也正因为如此，
             * `inputs[ACCOUNT_INPUT]` 已经答过时不能再问（否则死循环）。
             */
            async ask(inputs = {}) {
              if (typeof inputs?.[ACCOUNT_INPUT] === 'string') return null
              const rows = await listAccountsOf(container, dshProvider, log)
              if (rows.length === 0) return null // 路由组 / 未登录：没有可选账号
              if (rows.length === 1) return null // 只有一个号：直接签它，别多点一次
              return {
                type: 'select',
                key: ACCOUNT_INPUT,
                message: `选一个要接进 magpie 的 ${dshProvider} 账号（DSH 里共 ${rows.length} 个）`,
                options: rows.map((a) => ({
                  label: accountLabel(a),
                  value: String(a?.id ?? ''),
                  hint: a?.enabled === false ? '在 DSH 里已停用，接进来后请求会 502' : undefined,
                })),
              }
            },

            async authorize(inputs = {}) {
              // 这里可以等（用户点了按钮），所以把两个目录都拉全。
              const all = await liveAll(container, log)
              const n = Object.keys(modelsOf(dshProvider, all)).length
              let wide = 0
              try {
                fullModels = await container.refreshFullCatalog(DSH_PROVIDERS)
                wide = Object.keys(modelsOfFull(dshProvider, fullModels)).length
                writeCache(log)
              } catch { /* 全量拉不到不影响签入，退回实时可用 */ }
              if (n === 0 && wide === 0) {
                throw new Error(
                  `本体里的 ${dshProvider} 没有可用模型：确认这个账号在 DSH 里已登录，或先在 /v1/models 里看它是否有模型`,
                )
              }

              // 用户挑的账号（`ask()` 收上来的）。没挑 / 挑的那个已经不在了 ⇒ 不钉，
              // 退回「整家一个槽」的老行为 —— 陈旧记录不该让整家渠道不可用。
              // 用户挑的账号（`ask()` 收上来的）。没挑 ⇒ 不钉，退回「整家一个槽」的
              // 老行为。**挑了但找不到 ⇒ 抛错让用户重选**（2026-10-30 修）。
              //
              // 原先这里是「找不到就 log 一行、照样按整家签入」，后果是：用户以为
              // 自己钉了 A，实际走的是池内顺序（可能是 B）—— 与 `ask()` 那次静默
              // 退化是同一类故障，只是换了个触发点（账号在 DSH 里被删、或
              // `account.list` 那 15 秒缓存里刚好没有它）。用户看不到任何异常，
              // 只会觉得「怎么又走了别的号」。宁可让这一次签入失败并说清原因。
              const picked = String(inputs?.[ACCOUNT_INPUT] ?? '').trim()
              const hit = picked === '' ? undefined : await accountById(container, dshProvider, picked, log)
              if (picked !== '' && hit === undefined) {
                throw new Error(
                  `你选的账号 ${picked} 已经不在 ${dshProvider} 的账号池里了（可能刚在 DSH 里被删除，或那次列账号没成功）。`
                  + `请重新点「连接」，在弹出的列表里重新选一个。`,
                )
              }

              const key = hit === undefined
                // 没有具体账号：老形状的标记 key（不钉号，按池内顺序选）
                ? `jet-hub-local:${dshProvider}:direct`
                // 有具体账号：key 里带上账号 id，`dshAccountIdOf()` 靠它认回来
                : `jet-hub-local:${dshProvider}/${hit.id}`

              return {
                type: 'success',
                // magpie 的 api 型账号要存一个 key；直连模式下它只是个标记，
                // 发请求时不带它、也不校验它（进程内调用，没有 HTTP 边界）。
                key,
                accountId: hit === undefined
                  ? `DSH · ${dshProvider} · 上游 ${wide} 个模型（当前可用 ${n}）`
                  : `${accountLabel(hit)} · 上游 ${wide} 个模型（当前可用 ${n}）`,
                // `uid` 与 `metadata.dshAccountId` 都写，但**真正生效的是 metadata**：
                // 宿主 `save()` 的 api 分支只落 `{type, key, metadata}`，`result.uid`
                // 与 `result.accountId` 都会被丢弃。所以
                //   · 判重靠 `settle()` 的 secret 分支（`secretOf` 对 api 型取 `key`，
                //     即 key 字符串相等）—— 这也是为什么 key 里必须编进账号 id，
                //     否则同一账号再点一次「连接」会堆出第二条；
                //   · `usage(getAuth)` 定位账号靠 `metadata.dshAccountId`；
                //   · `uid` 留着是给「直接编辑 auth.json / 用 scripts/seed-auth.mjs
                //     导入」的场景对齐字段。
                ...(hit === undefined ? {} : { uid: String(hit.id) }),
                metadata: {
                  via: 'jet-hub',
                  provider: dshProvider,
                  ...(hit === undefined ? {} : { dshAccountId: String(hit.id) }),
                },
              }
            },
          },

          /**
           * 在 magpie 里**新建**一个 DSH 账号（浏览器授权）。
           *
           * 上面那个 `api` 型方法只能「接一个已经在 DSH 里的号」；用户要的是
           * 「在 magpie 里也能新建」，所以再声明这一条。magpie 看到一个 provider
           * 有**两个**方法时，`startPluginSignIn` 会先弹「How do you sign in to <name>?」
           * 让用户选方法（magpie 前端渲染在 `signing.state === 'method'` 分支），
           * 选完才走对应流程 —— 不需要 magpie 侧任何改动。
           *
           * ⚠️ 这个方法**没有 `ask()`**：新建账号没得选。
           */
          ...(NO_NEW_ACCOUNT.has(dshProvider)
            ? []
            : [{
              type: 'oauth',
              label: `在浏览器里新建一个 ${NAMES[dshProvider] ?? dshProvider} 账号（授权后自动接入）`,

              /**
               * 起一次登录流程，把登录页交给 magpie 打开。
               *
               * 只能做到「拿到 URL 就返回」：这里有 1 分钟硬超时（见上面段注释），
               * 等用户登录是 `callback()` 的任务 —— 宿主拿到这个对象后会 **立刻**在
               * 后台调 `callback()`（magpie 侧 `pluginBegin()` 里的
               * `go func() { saved, err := plugin.Finish(...) }`）。
               *
               * `opened` 从本体拿：代码仓（codearts）那家会自己拉起无痕窗，
               * 此时必须说 `opened: true`，否则 magpie 会再开一个带旧 cookie 的窗口。
               */
              async authorize() {
                // 容器可能还没起（用户在 magpie 里第一次点「新建」）——
                // `account.create` 内部走 `rpc()`，那条路径自己 `start()`，这里先等更稳。
                //
                // 必须套上限：`start()` 允许等到 40 秒，加上 `CREATE_TIMEOUT_MS` 的
                // 45 秒就是 85 秒，早撞穿 magpie 给 `authorize()` 的 1 分钟硬超时
                // （2026-10-29 二审指出预算没算这一段）。12 + 45 = 57 秒，留 3 秒余量。
                //
                // 超级麦吉会连试两条腿，纸面上最坏是 12 + 45 + 45 = 102 秒 —— 但走不满：
                // `local-browser` 受 vendor 自己的网络超时约束（`MAGICREW.requestTimeoutMs`
                // 30 秒 + `MAGICREW_PROFILE_TIMEOUT_MS` 6 秒 ⇒ 最坏约 36 秒），`browser` 腿
                // 起完后台任务**立刻**返回（不等用户登录）⇒ 现实最坏约 12 + 36 ≈ 48 秒，仍在闸内。
                await withDeadline(container.start(), START_TIMEOUT_MS, '本体容器启动')
                const { accountId, loginUrl, reused, incognitoOpened } = await startNewAccountSmart(
                  container,
                  dshProvider,
                  log,
                )

                return {
                  url: loginUrl,
                  // magpie 会在 spinner 卡片里显示这句话
                  instructions:
                    `在打开的页面里登录要新建的 ${NAMES[dshProvider] ?? dshProvider} 账号。`
                    + '完成后这一行会自动变成已签入，不需要回来点什么。',
                  opened: incognitoOpened,
                  /**
                   * 阻塞到用户授权完成。
                   *
                   * 成功：拿到那个新账号的真实记录（昵称 / 已回填的有效期），
                   * 返回 `{ type: 'success', key, accountId, uid, metadata }` 交给宿主 `save()`。
                   * 失败：把本体给的人话原样丢回去（宿主 `failed()` 会截前
                   * 500 字显示在 magpie 里），并把占位账号收掉。
                   */
                  async callback() {
                    // 「导入本机会话」那条路（astudio 且登录方式不是 web）：账号与凭据
                    // 在 `account.create` 返回时就都齐了，没有授权页可等，直接收口。
                    if (reused) {
                      accountsCache.delete(dshProvider)
                      log?.(`[${dshProvider}] 新账号 ${accountId} 走的是本机会话导入`)
                    } else {
                      const waited = await waitForLogin(container, dshProvider, accountId, log)
                      if (!waited.ok) {
                        // 没登成：把占位收掉（内部会先再摸一次 poll，防止误删刚登录好的号）
                        const fate = await abandonAccount(container, dshProvider, accountId, log)
                        // 'kept' = 收尾时发现用户其实已经登录成功了 —— 那就当成功处理，
                        // 别让 magpie 把一条可用的账号标成失败。
                        if (fate !== 'kept') throw new Error(waited.error)
                      }
                    }

                    const hit = await accountById(container, dshProvider, accountId, log)
                    let wide = 0
                    try {
                      fullModels = await container.refreshFullCatalog(DSH_PROVIDERS)
                      wide = Object.keys(modelsOfFull(dshProvider, fullModels)).length
                      writeCache(log)
                    } catch { /* 全量拉不到不影响签入 */ }

                    return {
                      type: 'success',
                      // key 里编进账号 id：`dshAccountIdOf()` 靠它认回「这条 magpie 账号是哪个
                      // DSH 账号」，同时宿主 `settle()` 的 secret 分支（比 key 字符串）据此判重。
                      key: `jet-hub-local:${dshProvider}/${accountId}`,
                      accountId: `${accountLabel(hit ?? { id: accountId })}·已新建`
                        + (wide > 0 ? `·上游 ${wide} 个模型` : ''),
                      uid: accountId,
                      metadata: { via: 'jet-hub', provider: dshProvider, dshAccountId: accountId },
                    }
                  },
                }
              },
            }]),
          ],

        /**
         * 发请求：把 magpie 转来的 OpenAI 请求**进程内**直连投给本体 llm 服务，
         * 只改模型名。
         *
         * 直连模式下 `container.forward()` 不再发 HTTP —— 它直接调本体的
         * `ctx.llm.stream()`，所以这里不需要 baseURL、不需要 apiKey，
         * 也没有本机端口要探活。（`PLACEHOLDER_BASE` 仍然要留：magpie 会拿它判
         * 「这个 provider 有没有地方可发」，空串会被判成 `nowhere to send`。）
         */
        async loader(getAuth) {
          /**
           * 这个 loader 实例属于哪个 DSH 账号（空串 = 整家一个槽，不钉）。
           *
           * 宿主按 key 缓存 loader（宿主 `loaders.set(key, opts)`），
           * 且第一个参数 `getAuth` 就是「取本账号记录」的函数 —— 所以每个
           * magpie 账号各拿一个 loader 实例，能各自知道自己是谁。
           *
           * ⚠️ 不 await：`getAuth` 每次调用都读一次 `plugin-auth.json`（宿主
           * `authCopy(key)`），放在请求热路径上会变成每次请求多一次同步读盘。
           * 账号在签入后不会变，第一次解析成功就缓存住。
           */
          let pinnedId
          const pinnedAccount = async () => {
            if (pinnedId !== undefined) return pinnedId
            if (typeof getAuth !== 'function') return (pinnedId = '')
            try {
              const record = await getAuth()
              return (pinnedId = dshAccountIdOf(record, dshProvider))
            } catch {
              // 读不到就**不缓存**（下次还有机会），本次按整家选号
              return ''
            }
          }

          return {
            baseURL: PLACEHOLDER_BASE,
            async fetch(fetchInput, init = {}) {
              const url = typeof fetchInput === 'string' ? fetchInput : fetchInput?.url ?? ''
              const method = String(init?.method ?? 'POST').toUpperCase()
              const isChat = method === 'POST' && /\/chat\/completions(\?|$)/.test(url)
              const parsed = isChat ? parseJsonBody(init?.body) : undefined

              await container.start()

              // 非 chat 或解析不了（`/v1/models` 等）：交给直连层按路径分发
              if (parsed === undefined) {
                const path = url.replace(/^https?:\/\/[^/]+/i, '') || '/v1/chat/completions'
                return container.forward(path, init)
              }

              const upstream = { ...parsed, model: toUpstreamModel(parsed.model, dshProvider) }
              // 把选号收窄到「这个 magpie 账号对应的 DSH 账号」——
              // 见 `container.mjs` 的 `_pinAccounts`：本体选号只看池内顺序、
              // 没有钉住字段，所以只能在请求作用域里把候选集换成那一个。
              const pin = await pinnedAccount()
              return container.runPinned(pin, () =>
                container.forward('/chat/completions', { ...init, body: JSON.stringify(upstream) }),
              )
            },
          }
        },

        /**
         * 用量卡：把本体 `credits.balances` 的**真实积分**报给 magpie。
         *
         * 签名（`_mp_host.js` 的 `usageOf`）：
         *   auth.usage(getAuth, provider) → { plan?, user?, until?, renew?,
         *     balance?, error?, resets?, windows?, signIn? }
         * 第一个参数是**取凭据的函数**（`await getAuth()` 拿这个账号存的记录），
         * 不是凭据本身 —— 这里正是靠它知道「现在是哪个账号」。
         *
         * ⚠️ 一个 magpie provider = 本体里的一个渠道，但一个渠道下有**多个账号**。
         *    卡片点开是某个具体账号，所以必须按 `uid`（= 本体账号 id）挑那一条，
         *    不能把整家渠道的余额加起来。
         */
        async usage(getAuth) {
          try {
            const account = typeof getAuth === 'function' ? await getAuth() : undefined
            // 统一走 `dshAccountIdOf`（2026-10-30 修）：原先这里手写
            // `account?.uid ?? account?.metadata?.dshAccountId`，与 `dshAccountIdOf`
            // 有两处不一致 —— ① 用 `??` 不用 `||`，`uid: ''` 会遮蔽后面有效的
            // `metadata.dshAccountId`；② 优先序相反（这里 uid 优先，那边
            // metadata 优先）；③ 少了「key 尾巴」这条退路。真实数据目前 0 条
            // `uid: ''`、0 条两者冲突，所以还没炸，但那是运气不是设计。
            const want = dshAccountIdOf(account, dshProvider)
            const reading = await balanceOf(container, dshProvider, want, log)
            if (reading === undefined) {
              // 路由组 / 本体里没有账号的渠道：说清「这里没有可查的积分」，别编数字
              const { live, full } = currentAll(container, log)
              const wide = Object.keys(modelsOfFull(dshProvider, full)).length
              const n = Object.keys(modelsOf(dshProvider, live)).length
              return {
                plan: NAMES[dshProvider] ?? dshProvider,
                windows: [
                  {
                    name: '上游模型 / 当前可用',
                    used: 0,
                    // 直连模式下没有本地端口（container.port 已不存在），别再拼端口号：
                    // 那会让用量卡显示「容器 127.0.0.1:undefined」。
                    display: `${wide} / ${n} 个 · 直连本体（无本地端口）`,
                  },
                ],
              }
            }
            return toMagpieUsage(reading, dshProvider)
          } catch (e) {
            return { error: humanizeUsageError(e?.message ?? e), windows: [] }
          }
        },

        /**
         * 每日签到：把本体 `credits.claimAll` 的**真实领取结果**报给 magpie。
         *
         * 签名（`_mp_host.js` 的 `checkinOf`）：
         *   auth.checkin(getAuth, provider) → {
         *     outcome: 'claimed' | 'done' | 'ineligible' | 'inactive' | 'captcha' | 'failed',
         *     credit?, streak?, message? }
         *
         * 本体侧的 `credits.claimAll` 一次领取**整家渠道所有账号**，返回
         * `{ results: [{accountId, nickname, outcome: {kind, credit?, message?}}],
         *    summary: {claimed, totalCredit, alreadyClaimed, inactive, failed, ...} }`。
         * 所以这里同样要按账号 id 挑出属于本账号的那一条 —— 不能报整家渠道的合计。
         */
        async checkin(getAuth) {
          try {
            const account = typeof getAuth === 'function' ? await getAuth() : undefined
            // 与 `usage()` 同源，统一走 `dshAccountIdOf`（理由见那边注释）
            const want = dshAccountIdOf(account, dshProvider)
            const v = await container.rpc('credits.claimAll', { provider: dshProvider })
            const rows = Array.isArray(v?.results) ? v.results : []
            const mine = rows.find((r) => String(r?.accountId ?? '') === want) ?? (want === '' ? rows[0] : undefined)
            if (mine === undefined) {
              return { outcome: 'ineligible', message: `本体里没有 ${dshProvider} 的可签到账号` }
            }
            return toMagpieCheckin(mine)
          } catch (e) {
            // 抛异常在 magpie 里等同 failed，但带上原文更有用
            return { outcome: 'failed', message: String(e?.message ?? e) }
          }
        },
      },

      provider: {
        id,
        async models(provider) {
          return currentModels(provider)
        },
      },

      _internal: { container, dshProvider, toUpstreamModel, toMagpieCheckin, toMagpieUsage },
    }
  }
}

/** 全部 23 个工厂（`index.mjs` 逐个具名导出）。 */
export const PLUGINS = DSH_PROVIDERS.map((p) => [idOf(p), makePlugin(p)])
