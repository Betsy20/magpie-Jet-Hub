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
 * N 个 provider id。本文件对本体里**除两个路由组之外**的 29 个 provider 各生成一个工厂。
 *
 * ## 架构
 *
 * ```
 * magpie 网关（默认 3425，可用 JET_HUB_USER_GATEWAY 覆盖）
 *   ├─ provider `jet-hub-codearts`   ┐
 *   ├─ provider `jet-hub-workbuddy`  │  N 个 provider，各自一个 id
 *   ├─ provider `jet-hub-qoder`      ├─ 全部共用同一个容器实例
 *   └─ …（29 个）                     ┘
 *        └─ auth.loader().fetch → JetHubContainer（内嵌 cordis + 本体 lib/index.js）
 *             └─ 直连本体 llm：ctx.llm.stream()（src/llm-bridge.mjs）
 *                  └─ 各 provider 的真实上游
 * ```
 *
 * ⚠️ **没有内嵌 HTTP 网关**：本体自己也开一个 OpenAI 兼容网关，但那层只是
 * `ctx.llm` 的 HTTP 外壳。插件在本进程里直接握着 `ctx.llm`，所以
 * `container.forward()` 在进程内就完成了整件事 —— 不占端口、不需要 apiKey。
 *
 * ⚠️ 容器**必须模块级共享**：29 个插件工厂各自 new 一个容器的话，会拉起 29 个
 * cordis（29 份账号池 + 29 份模型目录），冷启动直接炸。
 *
 * ## 凭据从哪来
 *
 * 不向用户要任何新凭据：DSH 已经把账号写在 `~/.dsh/.credentials.yaml` 的
 * `refs:` 段里，本插件用 `FileCredentialProvider` 把它桥成容器的 `credentials`
 * 服务。DSH 里登录过的账号，在 magpie 里立刻可用，反之亦然。
 */

import { JetHubContainer } from './container.mjs'
import { parseRefs } from './credentials.mjs'
// 上游的**积分/签到能力表** —— 由它直接回答「这家有没有签到」，
// 而不是在插件里再抄一份名单（抄了必然漂移）。
import { createProviderCredits, creditsOf } from '../vendor/lib/provider-credits.js'
// 腾讯 Marvis 的授权页地址 + 设备 guid：两个**纯函数**，不碰浏览器。
// 登录因此能走宿主 `mode: 'code'`（给链接 + 收粘贴的 code）那条通道，
// 不依赖本机有没有 Chromium —— 见 `marvisOauthMethod()` 的长注释。
import { authorizeUrlOf } from '../vendor/lib/marvis-browser-login.js'
import { newMarvisDeviceGuid } from '../vendor/lib/marvis-device.js'
import { iconFor } from './icons.mjs'
import { syncAuthQuietly } from './auth-sync.mjs'
// 模型目录价（USD / 1M tokens）。由 `node scripts/gen-model-prices.mjs` 生成，
// 数据来自 magpie 缓存的 models.dev 目录——见那个文件的头注释（含「参考价不是账单」的声明）。
import { MODEL_PRICES } from './model-prices.mjs'
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
/**
 * Key 型渠道「新建账号」时问用户要 API Key 的 inputs 键。
 *
 * 与 `ACCOUNT_INPUT` 分开：一个是「挑一个已有账号」，一个是「贴一把新 Key」。
 * 两条方法的 prompt 不共用键 —— 否则用户在一条方法里答过的值，会让另一条
 * 的 `ask()` 误以为已经答过而直接跳过提问。
 */
export const KEY_INPUT = 'apiKey'

/**
 * Key 输入框的占位提示，按渠道给一句「去哪拿」。
 *
 * 只是占位文案，**不参与校验** —— Key 形状校验在本体（`vendor/lib/modelscope-rpc.js`
 * 的 `KEY_PATTERN` = `^ms-[A-Za-z0-9_-]{16,}$`，`vendor/lib/opencode-rpc.js` 的
 * `^[A-Za-z0-9_.-]{20,}$`）。本插件不抄一份：抄了就会在魔搭/OpenCode 改令牌
 * 格式时把合法 Key 挡在门外，而那是用户完全无法自救的一类失败。
 */
const KEY_PLACEHOLDER = {
  modelscope: 'ms-…（在 https://modelscope.cn/my/myaccesstoken 生成）',
  opencode: '20 位以上的密钥串（在 https://opencode.ai/console/account 生成）',
  qiniu: '七牛云的 API Key（在 https://portal.qiniu.com/ai-inference/api-key 生成）',
}

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
 * ⚠️ 限定：magpie 直连的请求**不经过**这两个路由组（模型 id 一律是
 * `jet-hub-<provider>/<model>`，没有任何入口解析到 `aggregate/*` 或
 * `jet-hub-auto/*`）；上面那句「照样用」指的是 DSH 界面内部仍可能选到它们。
 */
export const DSH_PROVIDERS = [
  'accio',
  'astudio',
  'autoclaw',
  'autoclawintl',
  'baizhi',
  'buddy',
  'cline',
  'codearts',
  'codely',
  'gemini',
  'lobsterai',
  'loomy',
  'magicrew',
  'magicrewintl',
  'marvis',
  'minimax',
  'minimaxintl',
  'modelscope',
  'monkeycode',
  'monkeycodeintl',
  'officeace',
  'opencode',
  'qiniu',
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
  accio: 'Accio (阿里)',
  astudio: 'AStudio (讯飞)',
  autoclaw: 'AutoClaw (智谱)',
  autoclawintl: 'AutoClaw (国际版)',
  baizhi: '百智云 (Baizhi)',
  buddy: 'CodeBuddy (腾讯)',
  cline: 'Cline (开源)',
  codearts: 'CodeArts (华为云)',
  codely: 'Codely (Unity 团结引擎)',
  gemini: 'Gemini Code Assist (谷歌)',
  lobsterai: 'LobsterAI (有道)',
  loomy: 'Loomy (讯飞)',
  magicrew: '超级麦吉 (MagiCrew)',
  // 上游 `displayName` 就叫 `MagiCrew`；加「（国际版）」是为了在列表里与国内站区分。
  magicrewintl: 'MagiCrew (国际版)',
  marvis: '腾讯 Marvis',
  minimax: 'MiniMax Code (中国版)',
  minimaxintl: 'MiniMax Code (国际版)',
  modelscope: 'ModelScope (魔搭)',
  monkeycode: 'MonkeyCode',
  // 上游 `displayName` 就叫 `MonkeyCode国际站`；这里统一成「英文名 + 括注中文性质」的写法。
  monkeycodeintl: 'MonkeyCode (国际站)',
  // 上游 `displayName` 只有英文；括注补的是中文名/性质，让搜中文的人也找得到。
  officeace: 'OfficeAce (果办)',
  opencode: 'OpenCode (开源)',
  qiniu: 'Qiniu (七牛云)',
  qoder: 'Qoder (国际版)',
  qodercn: 'Qoder (中国版)',
  raccoon: 'Raccoon (商汤)',
  trae: 'TRAE (字节)',
  workbuddy: 'WorkBuddy (国际版)',
  zcode: 'ZCode (智谱)',
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
  'lobsterai/deepseek-v4-flash': { name: 'LobsterAI · DeepSeek V4 Flash' },
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
  'magicrewintl/deepseek-v4.1-flash': { name: 'MagiCrew 国际 · DeepSeek V4.1 Flash' },
  'qiniu/qwen3-max': { name: 'Qiniu · Qwen3 Max' },
  // 2026-11-04 上游新增三家。百智云目录走远端（45 条）+ 内置兜底；MonkeyCode
  // 两站的网关 `GET /v1/models` 恒 405，目录**只能是**内置常量，故这里的 id
  // 与 `src/monkeycode-product.ts` 的 `MONKEYCODE_GATEWAY_MODELS` 同形。
  'baizhi/deepseek-v4-flash': { name: '百智云 · DeepSeek V4 Flash' },
  'monkeycode/monkeycode-basic/deepseek-flash': { name: 'MonkeyCode · DeepSeek Flash (basic)' },
  'monkeycodeintl/monkeycode-basic/deepseek-flash': { name: 'MonkeyCode 国际 · DeepSeek Flash (basic)' },
  // 2026-11-10 并入腾讯 Marvis。它**没有**远端模型目录（9 个目录端点全 404），
  // 目录就是 vendor 里那条静态常量（`vendor/lib/marvis-product.js` 的
  // `MARVIS_FALLBACK_MODELS`），所以这条 id 不会随上游变、也不会出现在
  // `page/models.js` 快照里（快照是历史产物，见 t-new-account 的白名单）。
  'marvis/main-auto': { name: 'Marvis · DeepSeek V4.1 Flash' },
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
    out[bare] = modelEntry(bare, def, undefined, MODEL_PRICES[bare])
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

/**
 * 供回归测试直接验兜底口径，不参与插件契约。
 *
 * - `outputLimit`：单次输出上限的三层兜底（`tests/t-plugin.mjs`）
 * - `fallbackFor`：静态目录兜底（两份目录都空时才走到），
 *   导出它是为了让 `tests/t-model-prices.mjs` 能直接验「这条腿也挂价」
 *   —— 不导出就只能靠真启动且目录全空才走得到，那一条路径就没人守。
 */
export { outputLimit, fallbackFor }

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
 * ⚠️ **`capabilities.reasoning` 不等于「能改推理强度」。** magpie 的下拉只认
 * 条目里的 `variants` 键列表（宿主 `Object.keys(m.variants ?? {})` → magpie
 * `plugin.Model.Variants` → `Entry.Efforts`），而 `reasoning: true` 只决定
 * 「会思考」那个标记。2026-10-31 用户报「使用插件模型无法修改推理强度」就是
 * 只发了布尔、一个档位都没发 ⇒ 「会思考，但一档都挑不了」。
 *
 * @param {string} id 模型名（已剥 provider 前缀）
 * @param {{name?:string, limit?:{context?:number, output?:number}, tool_call?:boolean}} [def] 静态兜底表里的声明
 * @param {{context?:number, output?:number, input?:string[], reasoning?:boolean, efforts?:string[]}} [meta] 从本体现采的能力元数据
 * @param {[number, number, number, number] | undefined} [price] 目录价
 *   `[输入, 输出, 缓存读, 缓存写]`（USD / 1M tokens，来自 `MODEL_PRICES`）。
 *   传空、`undefined` 或全 0 时**不发** `cost` 字段—— magpie 的判据是
 *   不发就不会被当成有价；而**发一个全 0 的对象**会被 magpie 当成「声明免费」
 *   （`pluginFree` 分支），等于把「不知道」说成 0。两者判据分别在
 *   `pluginPrice` 与 `pluginFree`，不要混。
 *
 * 为什么是参数而不是函数内部查 `MODEL_PRICES`：两个测试（`t-model-efforts` / `t-model-prices`）
 * 会用 `new Function` 把本函数截段求值，段内引用模块级常量会 ReferenceError。
 *
 * 发出的字段形状（与 magpie `internal/provider/plugins.go` 的 `pluginPrice()` 对齐）：
 * `cost: { input, output, cache: { read, write } }`。
 */
function modelEntry(id, def, meta, price) {
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
  // 目录价：magpie 的 `pluginListPrice()` → `pluginPrice()` 读这个字段算用量页的费用
  // （USD / 1M tokens，与它内部的 catalog.Price 同口径）。
  //
  // 为什么必须由插件给：magpie 自己查价时走 `pricedNames()`，那个函数只按**整串**
  // 模型名查目录、不剥 `provider/` 前缀，而本插件的模型 id 是
  // `workbuddy/deepseek-v4.1-flash` 这种形状 ⇒ 一律查不到 ⇒ 用量页「费用」列永远是「—」。
  //
  // ⚠️ 表里没有就**不发**这个字段：magpie 的判据是 `Cost == nil || (Input <= 0 && Output <= 0)`
  // ⇒ 发一个空对象等于「确认不收费」，把「不知道」说成 0；不发才落回它自己的兜底链。
  if (Array.isArray(price) && (Number(price[0]) > 0 || Number(price[1]) > 0)) {
    entry.cost = {
      input: Number(price[0]) || 0,
      output: Number(price[1]) || 0,
      cache: { read: Number(price[2]) || 0, write: Number(price[3]) || 0 },
    }
  }
  return entry
}

// ---- 共享容器与模型缓存 -------------------------------------------------------

/** 模块级单例：29 个 provider 共用同一个容器。 */
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
    // 控制台侧栏/下拉框要显示 `CodeBuddy (腾讯)` 这种名字，`meta()` 里查这张表
    providerNames: NAMES,
    log,
  })
  return shared
}

/**
 * 把 29 家的账号池汇总成一个数组（`[{provider, id, nickname, enabled}]`）。
 *
 * 给 `syncAuthQuietly()` 用：它要的是「全量账号」，而 `account.list` 必须按
 * provider 逐家问。失败一律当「这家没有账号」——未登录的渠道本来就该失败，
 * 不是错误（理由见 `listAccountsOf` 的注释）。
 */
async function collectAllAccounts(container) {
  const out = []
  const failedProviders = []
  for (const dsh of DSH_PROVIDERS) {
    // ⚠️ 直接调 RPC 而不是 `listAccountsOf`：后者把失败吞成 `[]`，而「这家 0 个
    // 账号」与「列账号失败」会导出完全不同的写盘结果 —— 后者会把这家已有的 20 行
    // 记录整批换成一条占位（2026-11-01 实测）。所以这里要能分辨。
    try {
      const v = await container.rpc('account.list', { provider: dsh })
      const rows = Array.isArray(v?.accounts) ? v.accounts : []
      for (const a of rows) {
        if (a === null || typeof a !== 'object') continue
        out.push({ ...a, provider: a.provider ?? dsh })
      }
    } catch {
      failedProviders.push(dsh)
    }
  }
  return { accounts: out, failedProviders }
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
    .then(async () => {
      log?.('容器预热完成（冷启动不再阻塞「连接」）')
      // 账号被删掉或重新登录换了 id 之后，magpie 里会留着指向旧 id 的记录
      // （界面上表现为「一个渠道显示 3 个账号，其中两个叫 API key ...」）。
      // 这里在容器刚起好、账号池已加载完的时间点静默对齐一次 —— 失败只记日志。
      //
      // 静默收集：未登录的渠道 `account.list` 会失败，那是常态，不该刷屏。
      // 测试环境绝不写真实 magpie 配置：`defaultAuthPath()` 读的是
      // `os.homedir()`，而测试用临时 home 起容器 —— 账号集是空的或假的，
      // 写进去就把用户真实的账号列表塌成占位（2026-11-01 事故）。
      if (process.env.NODE_ENV === 'test') return
      const got = await collectAllAccounts(container)
      if (got.failedProviders.length > 0) {
        // 读不到账号的那几家**保留原记录不动**（不能写成占位 —— 一次瞬时失败就会把
        // 20 个账号换成一条「未登录该渠道」）。本机的 accio / autoclawintl /
        // codely / gemini 常年零账号，`account.list` 对它们报错是常态，所以这里
        // 不能整轮放弃，否则自动对齐永远不生效。
        log?.(`magpie 登录记录：${got.failedProviders.join(' / ')} 列账号失败，这几家保持原样`)
      }
      syncAuthQuietly({
        accounts: got.accounts,
        providers: DSH_PROVIDERS,
        idOf,
        failedProviders: got.failedProviders,
        log,
      })
    })
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

/**
 * 模型缓存文件（落盘，下次启动首屏就是真实目录）。
 *
 * ⚠️ 必须是**每次现算**，不能在模块求值时定死：`os.homedir()` 读的是
 * `USERPROFILE` / `HOME`，而测试的隔离（`tests/_iso.mjs`）是在 import 之后才
 * 改这两个环境变量 —— 定死的话隔离全部失效，测试会读写真实用户目录里的缓存
 * （实测：t-options 跑一趟就把 `~/.config/magpie/jet-hub-models.json` 的 `at`
 * 改掉了，且干净机器上因为读不到种子而假红）。
 *
 * `JET_HUB_MODELS_CACHE` 供测试/排障把缓存指到任意路径。
 */
const cacheFileOf = () =>
  process.env.JET_HUB_MODELS_CACHE || join(homedir(), '.config', 'magpie', 'jet-hub-models.json')

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
 * 能力元数据：`<本体 provider>/<model>` → `{ context, output, input, reasoning, efforts }`。
 *
 * `allModels` / `fullModels` 都只是 id（全量那份多 name/disabled），magpie 要的
 * 上下文窗口、能不能发图、有没有思考档位只能单独记。来源两处：
 * 本体 `ctx.llm` 现采（`container.modelMeta`）与落盘缓存的 `meta` 字段。
 *
 * `efforts` 是**规范档位名数组**（`low` / `high` / `max` …），`modelEntry()` 拿它
 * 拼成 magpie 的 `variants`；`reasoning` 只是个布尔，单独它挑不动档位。
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
    const j = JSON.parse(readFileSync(cacheFileOf(), 'utf8'))
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

/* ── 每日额度基线（当天首见额度当分母）────────────────────────────────────
 *
 * 用户 2026-11-09 定的口径：「每日限时的积分以首次获取的额度作为窗口」。
 *
 * 为什么需要它：百智云的每日积分发放额**不是固定 100** —— 实测同一时刻
 * 梨花不写诗 100、其余 4 个账号 200（上游 `temporary_credit_cents: 19996`）。
 * 而 `vendor/lib/baizhi-credits.js:259` 把分母写死成
 * `Math.max(100, temporary)` ⇒ 200 的账号显示 `199.96 / 199.96`，
 * 分母还是等于余额 ⇒ 进度条永远 100%，与「分母跟着余额跑」是同一个病。
 *
 * 解法：每天第一次读到某个每日额度包时，把那一刻的 `remaining` 记下来当分母，
 * 当天后续都按它算。跨天（本地日期变了）基线重置 —— 因为每日额度是零点重置的。
 *
 * ⚠️ 只对**每日桶**生效（名字精确等于「每日积分/每日赠送/每日额度」之一，
 * 与上游客户端 `DAILY_POOL_NAMES` 同口径）。充值/长期包不走这里 ——
 * 它们没有周期重置，首见值不是分母（那是钱包，交给 balance 语义）。
 *
 * 存储位置：与模型缓存同目录的 `jet-hub-daily-baseline.json`（容器层，
 * 丢了最多让当天第一次读数退化成钱包语义，不影响正确性）。
 */
const DAILY_POOL_NAMES = ['每日积分', '每日赠送', '每日额度', '每日签到奖励']
/**
 * 哪些渠道的哪些**钱包型**池子可以用「历史最高余额」当下限分母。
 *
 * ## 为什么需要（用户 m01511「总额度也要有窗口」）
 *
 * 百智云的「充值积分」（`permanent_credit_cents`）是长期积分：上游 `/balance`
 * 只回当前值，**没有初始总额、没有累计充值**（45 个候选流水/订单端点全 404，
 * 控制台 SPA 分包里也没有充值流水 API 字面量，2026-11-09 实证）。所以它只能
 * 按钱包显示「剩余 500 credit」—— 没有分母、没有进度条，用户看不到消耗比例。
 *
 * 又不能像 MonkeyCode 那样用「近 30 天收入」：百智云没有流水接口。唯一可算的
 * `app-credit-usage?period=month` 是**整月总消耗**（每日桶也含在内），拿它反推
 * 期初会把其余天的每日消耗算进充值桶（`vendor/lib/baizhi-credits.js` 里
 * 2026-11-05 审计 P0-1/P0-2 已否决这条路）。
 *
 * ⇒ 只能插件侧自采**水位**（每天首次见到的余额里取历史最高）：充值时余额上涨
 * ⇒ 水位跟着涨 ⇒ 分母变大，等价于用户说的「充值会让窗口扩大」；长期积分不过期，
 * 所以水位**永不回落**。首见当天是 `500 / 500 · 剩余 100%`，之后每笔消耗都能
 * 算出真实百分比（这正是用户否掉的「分母跟着余额跑、永远 100%」的反面）。
 *
 * ⚠️ 只对**白名单里的池子**生效：其它渠道的「积分余额 / 奖励积分 / 魔粒」语义
 * 各异（有的每日重置、有的按包过期），拿水位当分母会把它们全部改出进度条，
 * 属于没人要求的连带改动。要加渠道就往这里加一行。
 */
const WALLET_WINDOW_POOLS = { baizhi: ['充值积分'] }
/** @type {Map<string, {kind:'daily'|'peak', day:string, total:number}>} */
const dailyBaseline = new Map()
let dailyBaselineLoaded = false

const dailyBaselineFileOf = () =>
  process.env.JET_HUB_DAILY_BASELINE
  || join(homedir(), '.config', 'magpie', 'jet-hub-daily-baseline.json')

/** 本地日历日（YYYY-MM-DD）。每日额度按**本地**零点重置，不能用 UTC。 */
function localDay(now = Date.now()) {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function loadDailyBaseline() {
  if (dailyBaselineLoaded) return
  dailyBaselineLoaded = true
  try {
    const j = JSON.parse(readFileSync(dailyBaselineFileOf(), 'utf8'))
    if (j !== null && typeof j === 'object' && !Array.isArray(j)) {
      for (const [k, v] of Object.entries(j)) {
        if (v && typeof v.day === 'string' && Number.isFinite(Number(v.total))) {
          // ⚠️ 老文件没有 `kind`（第一版只存每日基线）⇒ 一律按 daily 解析，
          // 否则升级后已经把 199.96 采下来的 4 个百智云账号基线会全部丢失，
          // 当天的每日窗口立刻退回「分母==余额 · 永远 100%」。
          const kind = v.kind === 'peak' ? 'peak' : 'daily'
          dailyBaseline.set(k, { kind, day: v.day, total: Number(v.total) })
        }
      }
    }
  } catch { /* 没有文件是正常情况（首次运行） */ }
}

function saveDailyBaseline() {
  try {
    const out = {}
    const today = localDay()
    for (const [k, v] of dailyBaseline) {
      // 每日基线只留今天的（每日额度零点重置，昨天的必然失效）；
      // 水位**永久保留** —— 长期积分不过期，昨天的高水位今天照样是上限下限，
      // 删掉就等于把分母退回余额，「永远 100%」立刻复发。
      if (v.kind === 'peak' || v.day === today) out[k] = v
    }
    mkdirSync(dirname(dailyBaselineFileOf()), { recursive: true })
    writeFileSync(dailyBaselineFileOf(), JSON.stringify(out, null, 2))
  } catch { /* 写不进去不影响读数正确性，下次重新采基线即可 */ }
}

/**
 * 取（或采）某个每日额度包今天的基线分母。
 *
 * @param {string} key  `<provider>|<accountId>|<包名>`
 * @param {number} remaining 当下余额
 * @returns {number} 今天的分母（≥ remaining，保证「已用」不会是负数）
 */
function dailyTotalOf(key, remaining) {
  loadDailyBaseline()
  const today = localDay()
  const hit = dailyBaseline.get(key)
  // 跨天 ⇒ 重置：今天第一次读到就是今天的新基线
  if (hit === undefined || hit.day !== today) {
    dailyBaseline.set(key, { kind: 'daily', day: today, total: remaining })
    saveDailyBaseline()
    return remaining
  }
  // 余额**超过**首见值（当天中途补发/叠加活动）⇒ 抬高基线，
  // 否则会出现「剩余 120 / 基线 100」这种已用为负的倒挂。
  if (remaining > hit.total) {
    hit.total = remaining
    saveDailyBaseline()
  }
  return hit.total
}

/** 这条包名是不是「每日额度」桶（精确匹配，与上游 DAILY_POOL_NAMES 同口径）。 */
function isDailyPool(name) {
  return DAILY_POOL_NAMES.includes(String(name ?? '').trim())
}

/** 这个渠道的这个池子是否允许用「历史水位」当分母（见 WALLET_WINDOW_POOLS 注释）。 */
function isWalletWindowPool(provider, name) {
  const list = WALLET_WINDOW_POOLS[String(provider ?? '')]
  if (!Array.isArray(list)) return false
  return list.includes(String(name ?? '').trim())
}

/**
 * 取（或抬）某个钱包型池子的历史水位 —— 只在**涨**的时候更新，永不回落。
 *
 * 与 `dailyTotalOf` 的区别：那个按天重置（每日额度零点清零），这个永久保留
 * （长期积分不过期）。水位只增不减，所以消耗多少都能算出真实百分比；充值把
 * 余额顶上去，水位跟着上抬 —— 用户说的「充值会让窗口扩大」就是这一条。
 *
 * @param {string} key  `<provider>|<accountId>|<包名>`
 * @param {number} remaining 当下余额（调用方已保证 > 0）
 * @returns {number} 水位（≥ remaining）
 */
function walletPeakOf(key, remaining) {
  loadDailyBaseline()
  const hit = dailyBaseline.get(key)
  // 老版本可能把同一个 key 存成了 daily（不会 —— 白名单是新增的包名），
  // 但即便撞上也要以「取大值」为准，不然分母会比余额小、进度条溢出。
  if (hit === undefined || hit.kind !== 'peak') {
    const total = hit !== undefined && Number(hit.total) > remaining ? Number(hit.total) : remaining
    dailyBaseline.set(key, { kind: 'peak', day: localDay(), total })
    saveDailyBaseline()
    return total
  }
  if (remaining > hit.total) {
    hit.total = remaining
    saveDailyBaseline()
  }
  return hit.total
}

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
 * 本体里**没有** `account.create` 分支的三家（`unknown provider: xxx`）：
 * 都是 Key 型渠道，走各自的 `*.addAccount`，不接受 `account.create`。
 * 对它们不声明「新建账号」方法，免得用户点了才看到 `unknown provider`；
 * 它们的「新建」走 `KEY_ACCOUNT_RPC` 那条贴 Key 的路子。
 * 不能 `export`：`index.mjs` 只许导出插件工厂（多导一个就整个插件加载失败），
 * 且 `tests/t-new-account.mjs` 会把本文件切段丢进 `new Function` 求值，
 * 段内出现 `export` 直接 SyntaxError。测试侧从源码文本里解析它。 */
const NO_NEW_ACCOUNT = new Set(['modelscope', 'opencode', 'qiniu'])

/**
 * 上游 `credits.claimAll` 里**走特例分支**的渠道 —— 它们的签到能力**不在**能力表里。
 *
 * 真源（`vendor/lib/jet-hub-rpc.js` 的 `case 'credits.claimAll'`）：
 *   · `if (isQoderFamily(req.provider))` —— qoder / qodercn 走 `claimQoderDailyCheckin`
 *     （国际版还要按账号取出口代理），表里**刻意**没有它们；
 *   · `if (req.provider === ZCODE.id)` —— zcode 走 `claimDailyFor`（每个 plan 现产 captcha），
 *     同样不在表里。
 * 其余渠道才是「表里有 `impl.claim` 才算支持」。
 *
 * ⚠️ 这三个 id 是**照抄**上游分支条件的（不是抄一份签到能力名单）—— 上游把某家
 * 挪进/挪出特例分支时这里会失真，所以 `tests/t-checkin.mjs` 有一条守卫：
 * 如果这三家**开始**在 vendor 表里出现 `claim`，测试会红，提示把这行删掉。
 */
const SPECIAL_CLAIM_PROVIDERS = new Set(['qoder', 'qodercn', 'zcode'])

/**
 * 上游的积分能力表（构造一次即可：里面全是配置与函数引用，不联网、不读盘）。
 *
 * `createProviderCredits({})` 的入参是**可选注入**（MiniMax 国际站的按账号代理等），
 * 空对象就是上游在单测里的用法；我们只读它的键与 `claim` 是否存在，不调任何实现。
 */
let creditsTableMemo
/** 能力表读不到时只警告一次（`canCheckin()` 每个 provider 都会调一遍）。 */
let creditsTableWarned = false
/**
 * 惰性构造能力表（**不能写成模块级常量**）。
 *
 * 一是有 `tests/*.mjs` 会把本文件的区段切出来丢进 `new Function` 求值，
 * 那些段里没有 `createProviderCredits` 的绑定 —— 模块级调用会让它们一启动就
 * `ReferenceError`（2026-11-01 实测 t-model-efforts / t-new-account 双双变红）。
 * 二来这张表只在注册 provider 时才用得上，没必要在 import 阶段就建。
 */
function creditsTable() {
  if (creditsTableMemo === undefined) creditsTableMemo = createProviderCredits({})
  return creditsTableMemo
}

/**
 * 这家渠道在上游到底支不支持「每日签到」？
 *
 * 为什么要在插件侧也判一次：magpie 的签到开关**只看插件有没有声明 `auth.checkin`**
 * （宿主 `host.js` 的 `checkin: typeof a.auth.checkin === "function"`，Go 侧
 * `Provider.Checkin` 再决定 Settings 里显不显示）。给 29 家都声明，就等于给
 * 「后端根本没有签到接口」的 9 家也画了一个开关 —— 用户点了只能看到失败，
 * 而那是**能力缺失**，不是故障（2026-11-01 用户报「部分供应商签到失败」的根因）。
 *
 * ⇒ 不支持的渠道**根本不声明** `checkin`，magpie 那边连开关都不出现。
 * 判据直接问上游的能力表，不维护第二份名单。
 */
function canCheckin(dshProvider) {
  if (SPECIAL_CLAIM_PROVIDERS.has(dshProvider)) return true
  let table
  try {
    // ⚠️ `try` 只包**构造表**这一步。`creditsOf()` 也包进来的话，
    // 「表造出来了、但我们自己查错了字段」这种代码 bug 会被一起吞成「支持」，
    // 那就不是能力缺失而是掩盖缺陷了（2026-11-01 补审指出）。
    table = creditsTable()
  } catch (e) {
    // 表造不出来（上游改了结构）：保守地当作「支持」，走 `isCheckinUnsupported()`
    // 的 ineligible 兜底 —— 而不是悄悄把签到能力关掉（关掉了用户连点都点不了，更难发现）。
    // 只警告一次：这个函数每个 provider 都会调一遍。
    if (!creditsTableWarned) {
      creditsTableWarned = true
      console.warn(
        `[jet-hub] 读不到上游积分能力表（${String(e?.message ?? e)}）：`
        + '签到能力一律按「支持」处理，不支持的渠道会显示成 ineligible 而不是从 Settings 里消失。',
      )
    }
    return true
  }
  return typeof creditsOf(table, dshProvider)?.claim === 'function'
}

/**
 * Key 型渠道「贴 Key 建号」的本体 RPC —— **上游 UI 就是这么建的**。
 *
 * 上游客户端（`vendor/lib/client/jet-hub.js` 的 `submitOpencodeEntry`）对这两家
 * 弹一个输入框、粘贴 Key、提交到下面这个方法：
 *   · `modelscope.addAccount` —— `{ apiKey, nickname? }`；
 *   · `opencode.addAccount` —— `{ apiKey, nickname? }`。
 *
 * 两家都**按 Key 尾段派生账号 id**（同一把 Key 反复贴只会落到同一条），所以这里
 * 不需要自己去重。形状校验也由本体做。
 *
 * ⚠️ 两家的 `existed` 语义**不一样**：modelscope 命中同 id 直接回 `existed: true`，
 * opencode 在同 id 但凭据读不出来（坏槽）时会覆盖写并回 `existed: false`。
 * 所以插件侧**不把它写进 metadata**（写了反而语义相反）。
 *
 * ⚠️ 值里带 `provider` 是为了让测试能从源码文本里解析出「哪几家是 Key 型」，
 * 不必在测试里再抄一份名单。
 */
const KEY_ACCOUNT_RPC = new Map([
  ['modelscope', 'modelscope.addAccount'],
  ['opencode', 'opencode.addAccount'],
  ['qiniu', 'qiniu.addAccount'],
])

/**
 * 超级麦吉两站（`magicrew` 国内 / `magicrewintl` 国际）`account.create` 要走的 `mode`，按顺序试。
 *
 * 这一家的 `account.create` **必须**带 `mode`，不带会被本体直接拒：
 * `'超级麦吉请用「从本机浏览器导入」或「网页登录」，不支持手机号密码登录'`
 * （`vendor/lib/jet-hub-rpc.js` 的 `case 'account.create'` 里 magicrew 兜底分支）。
 *
 * 第一条腿 `browser` —— 本体登记占位条目后**自己**开一个一次性独立 profile 的
 *    可见窗口等你登录（不是 `--incognito`：`vendor/lib/chromium-session.js` 只传
 *    `--user-data-dir`），立刻返回 `{ accountId, loginUrl: '' }`；进度由
 *    `login.poll` 经 `magicrewBrowserLoginInFlight` 报终态。→ 这才是「新建账号」。
 * 第二条腿 `local-browser` —— 读本机 Edge/Chrome 里已登录 `www.letsmagic.cn` 的
 *    登录态（leveldb，只读不碰 cookie）：毫秒级、不开窗、按 **jwt 指纹**幂等判重，
 *    同一账号反复导入只会刷新那一条、不会变出多张卡。读不到时本体回
 *    `ok: false`（不是抛错），`container.rpc()` 会把它转成一句人话错误。
 *    → 它是「认一个已经登过的号」，不是新建。
 *
 * 顺序是 `browser` 在前、`local-browser` 在后（2026-11-02 改）。理由：`local-browser`
 * 从本机浏览器**导入已有登录态**，它不是「新建账号」而是「认一个已经登过的号」——
 * 放在第一位会让用户在 magpie 里点「新建」时永远只捞到本机那个老号（还可能凭空
 * 多一张别人的卡），新号根本建不出来。`browser` 才是真开一个窗口让用户登新号。
 *
 * `local-browser` 的兜底面比看上去窄得多（2026-11-02 审查实证）：`browser` 是
 * 「先返回、后开窗」—— 它把真正的 `loginViaBrowser()` 塞进一个**不 await** 的
 * 后台 IIFE，自己立刻 `return { ok: true, value: { accountId, loginUrl: '' } }`。
 * 所以本机没有浏览器时 `account.create` **照样返回 ok**，`BrowserDeploymentError`
 * 只在后台被收成 `login.poll` 的终态错误。⇒ `local-browser` 真正可达的条件只有
 * 「`account.create` 这个 RPC 本身没给出可用结果」：账号池写不进去 / RPC 超时 /
 * 容器异常 / 返回体里 `accountId` 是空串（`startNewAccount` 会当场抛）。
 *
 * 为什么不把它做成「开窗失败再退回导入」的真兜底：导入认回的是一个旧号（还可能是
 * 别人的卡），用户点的是「新建」，拿回旧号比看到一句「开窗失败」更糟。
 */
const MAGICREW_CREATE_MODES = ['browser', 'local-browser']

/**
 * **必须**带 `mode: 'browser'` 才会进自家分支的渠道：
 * `monkeycode` / `monkeycodeintl` / `baizhi`。
 *
 * ⚠️⚠️ 这是一个**真缺陷**的修法（2026-11-11 真机踩到）。本体 `case 'account.create'`
 * 里这几家的分支条件都把 `mode` 当成**分支判据**而不是可选参数：
 *
 * ```js
 * // vendor/lib/jet-hub-rpc.js:4345
 * if (monkeycodeProduct !== undefined && monkeycodeAuthOf !== undefined && req.mode === 'browser')
 * // vendor/lib/jet-hub-rpc.js:4510
 * if (provider === BAIZHI.id && req.mode === 'browser')
 * ```
 *
 * 而 `startNewAccountSmart()` 此前**只**给超级麦吉两站传 `mode`，其余一律裸传
 * `{ provider }`。
 *
 * 后果链（用户在 magpie 面板点「新建账号 → MonkeyCode」实测）：
 *
 * 1. `account.create` 不带 `mode` ⇒ MonkeyCode 分支被跳过 ⇒ 落到 `case` 末尾的
 *    `return { ok: false, error: { message: 'unknown provider: monkeycode' } }`；
 * 2. 面板弹出「登录未完成 / unknown provider: monkeycode」，而**日志里什么都没有**
 *    （分支根本没进，没有任何 warn）—— 这就是为什么这个 bug 藏了这么久；
 * 3. ⇒ 永远没法重新抓 `monkeycode_ai_session` ⇒ 老会话一路 401 过期 ⇒ 面板读不到
 *    积分、签到失败、模型被按「额度耗尽」打冷却标签；
 * 4. ⇒ 用户看到的是「MonkeyCode 用不了 / 显示不出积分」，而根因是「加不了账号」。
 *
 * 这几家都只有「开一次性独立 profile 的浏览器窗口让用户自己登」这一条路（与超级
 * 麦吉的 `browser` 腿同型），没有 `local-browser` 那样的第二条腿可退，所以只传
 * `browser`、不重试别的 mode。
 *
 * ⚠️ 国际站（`monkeycodeintl`）与国内站共用同一段分支判据（`:4345` 对两个 product
 * 都生效），漏一个就是国际站面板同样弹出 `unknown provider: monkeycodeintl`。
 *
 * ⚠️ `baizhi`（百智云）在 2026-11-11 一并纳入：它 `account.create` 的判据与上面
 * 逐字同型（`:4510`），不传 `mode` 就是 `unknown provider: baizhi` —— 面板上
 * 「新建账号 → 百智云」同样是死路。纳入后不影响 `baizhi.startSession`（那是给
 * **已有**账号补 cookie 的另一条入口，走自己的 RPC，与本表无关）。
 */
const BROWSER_MODE_PROVIDERS = new Set(['monkeycode', 'monkeycodeintl', 'baizhi'])

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
  // 只有三类 provider 需要 `mode`：
  //  · 超级麦吉两站 —— 必须是 `browser` 或 `local-browser`（见 `MAGICREW_CREATE_MODES`）；
  //  · `monkeycode` / `monkeycodeintl` —— 必须是 `browser`
  //    （见 `BROWSER_MODE_PROVIDERS`，漏传就是那句 `unknown provider: monkeycode`）。
  // 其余各家多传一个未知字段会被本体忽略，但没必要冒这个险 —— 不传就不带。
  //
  // 腾讯 Marvis 不走这里：它不需要本机浏览器，走宿主 `mode: 'code'` 那条通道，
  // 见 `marvisOauthMethod()` 的长注释。
  const payload = mode === undefined ? { provider } : { provider, mode }
  const v = await withRpcDeadline(
    container,
    'account.create',
    payload,
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
      // `incognitoOpened: true` 不是说我们开了窗：这条路没有授权页，凭据已落在
      // 本机（本机浏览器，或 AStudio 桌面客户端的 astron-session.json）。
      // 它的作用是**纯防御** —— 当前 magpie 版本下它与 false
      // 渲染完全相同（`internal/gui/api.go` 的 `openError` 对空 URL 直接
      // `return ""`，注释原话「"" when it did, or when there is no url」；
      // `app.js` 的 `:12106`/`:12210` 两处都 `&& signing.url` 短路）。真正让用户
      // 看到正确提示的是 `authorize()` 里按 `reused` 分叉的 instructions。
      return { accountId, loginUrl: '', reused: true, incognitoOpened: true }
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
 * 腾讯 Marvis 是第三种形状：单次调用、但**必须**带 `mode: 'browser'`（另有
 * `marvisLoginType`），见下面那条分支的注释。
 *
 * 除超级麦吉两站外都是单次调用（`mode === undefined`，payload 里不带这个字段）。
 * 超级麦吉两站两条腿都失败时，**报第一条腿（`browser`）的错误**，并把其余腿的
 * 原因附在括号里 —— 用户点的是「新建」，先看到那条腿为什么不行才定位得到问题。
 *
 * 腾讯 Marvis 也不走这里：它不用本机浏览器，走宿主 `mode: 'code'` 那条通道，

 *
 * ⚠️ 这里的「失败」只指 `startNewAccount` 抛出来的**`account.create` RPC 错误**
 * （超时 / 账号池写失败 / 返回体里 `accountId` 缺失或为空）。**不包括**「窗口起不来」「授权
 * 被拒」：那两条发生在 vendor 的后台任务里（`mode: 'browser'` 是「先返回、后开窗」），
 * 只会变成 `login.poll` 的终态，根本不在本函数的 errors 数组里。
 */
async function startNewAccountSmart(container, provider, log) {
  // ⚠️⚠️ 这里曾漏了 monkeycode / monkeycodeintl（2026-11-11 真机踩到）：
  //    它们的 `account.create` 分支判据里带着 `req.mode === 'browser'`，不传 `mode`
  //    就直接掉进 `unknown provider: xxx`。详见 `BROWSER_MODE_PROVIDERS` 的长注释。
  //    这两家只有一条腿，所以要**先**判，别落到下面重试 `local-browser` 的循环里。
  if (BROWSER_MODE_PROVIDERS.has(provider)) return startNewAccount(container, provider, log, 'browser')

  if (provider !== 'magicrew' && provider !== 'magicrewintl') return startNewAccount(container, provider, log)

  const errors = []
  for (const mode of MAGICREW_CREATE_MODES) {
    try {
      return await startNewAccount(container, provider, log, mode)
    } catch (error) {
      errors.push({ mode, error })
      log?.(`[${provider}] ${mode} 没成（${error?.message ?? error}），退下一个 mode`)
    }
  }
  // 报**第一条**腿（browser）的错误：那才是用户点「新建」想走的路（真开窗登新号）。
  // 这里的「失败」只指 `account.create` 这个 RPC 自己没给出可用结果（超时 /
  // 账号池写失败 / 返回体里 `accountId` 是空串）；「窗口起不来」「授权被拒」发生在
  // vendor 的后台任务里（`mode: 'browser'` 是「先返回、后开窗」），只会变成
  // `login.poll` 的终态，根本不会进这个数组。`local-browser` 的失败多是
  // 「本机浏览器里没有登录态」这种预期内的话，报它反而误导。
  // 但把后面几条腿的原因也捎上 —— 否则用户只看到一半真相（2026-11-02 审查建议）。
  const [first, ...rest] = errors
  // 兜底：`MAGICREW_CREATE_MODES` 若被改成空数组，循环一次都不进，
  // `first` 会是 `undefined` —— 那样 `throw undefined` 会丢成
  // 「Uncaught undefined」，用户在 magpie 里只看到一句空白失败。
  if (first === undefined) throw new Error(`${provider}：没有任何可用的新建方式`)
  const restNote = rest.length === 0
    ? ''
    : `（另 ${rest.length} 条方式也不行：${rest.map((r) => `${r.mode} → ${r.error?.message ?? r.error}`).join('；')}）`
  if (restNote === '') throw first.error ?? new Error(`${first.mode}：没有可用的新建方式`)
  throw new Error(`${first.error?.message ?? first.error}${restNote}`)
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
 * 这个账号的凭据还在不在（不知道就放行）。
 *
 * 拿不到判断能力时返回 `true`，理由同 `container.credentialAlive` 的注释：
 * 宁可不拦，也不能因为「查不了」就把所有账号判成空壳。测试里的假容器就是这种情况。
 */
function credentialAliveOf(container, ref) {
  if (typeof container?.credentialAlive !== 'function') return true
  try {
    return container.credentialAlive(ref) !== false
  } catch {
    return true
  }
}

/**
 * 这次新建的账号，最后该把哪一条签进 magpie。
 *
 * ## 为什么不能直接用新建的那个 id
 *
 * 容器层登录成功后会按云端身份判重（`jet-hub-rpc.js` 的 officeace / zcode 分支）：
 * 同一个云号已经在池里 ⇒ 新凭据**转写给老卡**、新卡的凭据被 `unset`、新卡标成
 * `…（重复，已停用）`。而 `login.poll` 只回 `{done:true,success:true}`，不告诉插件
 * 「存活的是哪一条」。于是老写法把新壳卡的 id 编进 key/uid 交给宿主 `save()`：
 * magpie 里就多出一张指向空壳的登录卡 —— 显示成 `API key …eae7`（宿主拿不到名字
 * 时的兜底），点它必报「积分查询失败（凭据已失效）」，删了插件池的壳卡也清不掉它
 * （2026-11-09 实测，用户连着踩了三次）。
 *
 * ## 判据与找法
 *
 * 壳卡有两个同时成立的特征：`enabled === false` **且**凭据已不在。只看 `enabled`
 * 会把用户自己停用的号也算进来；只看凭据会把「凭据文件一时读不到」误判成壳。
 *
 * 存活卡靠**昵称里的云号前缀**认：容器层给壳卡写的是
 * `OfficeAce <云号前 8 位>（重复，已停用）`，存活卡是 `OfficeAce <同一前 8 位>`。
 * 前缀相同且凭据还在的那条就是它。认不出来（云号不足 8 位、昵称被用户改过、
 * 存活卡凭据也读不到）⇒ 退回新卡 id：宁可留一张壳卡，也不能把登录签给**别的号**。
 *
 * ⚠️ 判重的「反转形态」（老卡原本是停用的）里，容器层把**新卡**留成存活卡、
 * 老卡标重复停用 —— 那时新卡 `enabled:true` 且凭据在，这里的判据不成立，原样返回。
 */
async function landedAccountOf(container, provider, accountId, hit, log) {
  const fallback = { id: accountId, hit }
  if (hit === undefined || hit.enabled !== false) return fallback
  if (credentialAliveOf(container, hit.credentialRef)) return fallback

  // 壳卡昵称形如 `OfficeAce 01a0a421（重复，已停用）`：取「（」之前那截的最后一段。
  const nick = String(hit.nickname ?? '').trim()
  const head = nick.split('（')[0].trim()
  const cloud = head.includes(' ') ? head.slice(head.lastIndexOf(' ') + 1) : ''
  if (cloud.length < 8) return fallback

  const rows = await listAccountsOf(container, provider, log)
  const alive = rows.filter(
    (a) =>
      a !== null &&
      typeof a === 'object' &&
      String(a.id ?? '') !== accountId &&
      a.enabled !== false &&
      credentialAliveOf(container, a.credentialRef) &&
      // 整段相等，不是 `endsWith`：`…101a0a421` 也以 `01a0a421` 收尾，那是**另一个号**。
      String(a.nickname ?? '').split('（')[0].trim().split(' ').pop() === cloud,
  )
  // 只认唯一命中：两条都像 ⇒ 分不清是哪条，退回新卡（不猜）。
  if (alive.length !== 1) return fallback
  const survivor = alive[0]
  log?.(
    `[${provider}] 新账号 ${accountId} 被判重转写给了 ${survivor.id}（同一个云号 ${cloud}…）` +
      '，签入改用存活的那条 —— 否则 magpie 里会留一张没有凭据的空壳登录卡',
  )
  return { id: String(survivor.id), hit: survivor }
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
 * 本体的**「这家渠道没有签到功能」**这类回答 —— 都该报 `ineligible`，不是 `failed`。
 *
 * 为什么必须单独认出来：magpie 的六种 outcome 里 `failed` 是**红旗**（用户会以为
 * 插件坏了、要去排查），而「这家后端压根没有签到接口」是**能力缺失**，用户什么
 * 也做不了，标红只会制造噪音。2026-11-01 用户报「部分供应商签到失败」，实测
 * `~/.config/magpie/plugin-checkin.json` 里的 `failed` 绝大多数属于这一类
 * （2026-11-01 现场快照：workbuddy 21 / cline 6 / magicrew 5 / raccoon 1 /
 * modelscope+opencode+officeace+aggregate 各 1；具体条数会随账号增减变，别把它当常量）：
 *
 *   workbuddy ×21  `WorkBuddy 国际版不支持每日签到（其后端没有签到接口）`
 *   cline ×6       `Cline 不支持每日签到（其后端没有签到接口）`
 *   magicrew ×5    `超级麦吉暂不支持每日签到（本插件未接该端点）`
 *   raccoon ×1     `Raccoon Work 不支持每日签到（每日积分由服务端自动发放…）`
 *   modelscope/opencode/officeace  `unsupported provider: <id>`
 *
 * 两种来源（`vendor/lib/jet-hub-rpc.js` 的 `credits.claimAll`）：
 *   ① 能力表里有专属文案 ⇒ 回 `claimUnavailableReason`（上面那些中文）；
 *   ② 表里没有专属文案（gemini / opencode / aggregate 等）⇒ 回旧的
 *      `unsupported provider: <id>`。
 *
 * ⚠️ 这里**不维护一份「哪家支持签到」的名单**：那份名单在 vendor 的能力表里
 * （`runtime.credits`），抄一份就会漂移（上游加一家签到，插件继续把它标成不支持）。
 * 只按**错误的措辞族**判定 —— 这正是本体区分「不支持」与「真失败」的方式。
 * 真失败（HTTP 401 / 网络错误 / 上游报错）不含这些词，仍走 `failed`。
 */
const CHECKIN_UNSUPPORTED_PATTERNS = [
  /^unsupported provider:/i, // ② 能力表里没有专属文案的已登记渠道
  /不支持每日签到/, // ① workbuddy / cline / raccoon / buddy 系
  /暂不支持每日签到/, // ① magicrew
  /其后端没有签到接口/, // ① 与上面重合，但单独列出免得改文案时静默失效
  /未接该端点/, // ① magicrew 的另一半措辞
  /每日积分由服务端自动发放/, // ① raccoon 的专属说明
]

/** 这条签到错误是「这家没有签到功能」还是「真的失败了」？ */
function isCheckinUnsupported(message) {
  const text = String(message ?? '')
  if (text === '') return false
  return CHECKIN_UNSUPPORTED_PATTERNS.some((re) => re.test(text))
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
      // 同一条判据也覆盖「结果走 results、不抛错」的形态（例如某家 claim 内部
      // 自己回了一句「不支持每日签到」而不是在入口就拒）。
      if (isCheckinUnsupported(message)) return { outcome: 'ineligible', ...base }
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
  // JSC（Bun）风格的同类报错：上游 `collectCreditBalances` 在「凭据解析不出来」时
  // 会去读 `product.id`，而那条路上的 `product` 恒为 undefined。上游 `1b03f33` 已改成
  // `product?.id`（本仓库原先那道补丁因此退役），这里保留兜底是为了旧产物与宿主缓存里
  // 的旧文案仍可能带这个形状。
  // ⚠️ 两种引擎形状都要兜：`package.json` 的 engines 是 node（V8），而 magpie 侧
  //    跑的是 Bun（JavaScriptCore）。只兜 JSC 等于在 node 宿主上什么都没做。
  //    V8 的形状**不带对象名**（只有 `(reading 'id')`），所以措辞只能是「可能」。
  if (/evaluating 'product\.id'/.test(text)) {
    return `这个账号在账号池里，但它的登录凭据已经不在了（${text}）—— 到 DSH 或 magpie 里重新登录一次，或者删掉它`
  }
  if (/Cannot read propert(y|ies) of undefined \(reading 'id'\)/.test(text)) {
    return `这个账号可能没有可用的登录凭据了（${text}）—— 到 DSH 或 magpie 里重新登录一次，或者删掉它`
  }
  if (/^Cannot read propert(y|ies) of/.test(text)) {
    return `该账号的余额查询内部出错（${text}），换个账号或重新登录后重试`
  }
  if (/refresh token/i.test(text)) {
    return `该账号的登录已过期（${text}），到 DSH 里重新登录一次即可`
  }
  return text
}

/**
 * 合并用的分组名：把「用来区分单笔」的日期段剥掉。
 *
 * 上游 minimax 的包名是 `积分包 2026/10/9`（发放日，每笔都不同）—— 那是给人对上
 * 「哪一笔」的标识，不是箱子的种类。若按原名分组，30 笔赠送就是 30 行一模一样的
 * `0 / 400 credit · 剩余 100%`，把整张卡撑成流水账（2026-11-01 用户截图）。
 * 剥掉日期后它们归成一类，显示成 `积分包 ×30 · 10-09~12-01 到期`。
 *
 * 只剥**结尾**的完整日期段（`积分包 2026/10/9`、`名字 2026-10-09`）；剥完为空就
 * 保留原名 —— 别把本来就叫这个的箱子改坏。
 */
function groupName(name) {
  // 先 trim 再剥：上游若给了 `积分包 2026/10/9 `（尾随空格），
  // 结尾锚点 `$` 会落在空格上，日期就剥不掉了。
  const raw = String(name).trim()
  const cut = raw
    .replace(/(?:\s+\d{4}\/\d{1,2}\/\d{1,2})+$/, '')
    .replace(/(?:\s+\d{4}-\d{1,2}-\d{1,2})+$/, '')
    .trim()
  return cut === '' ? raw : cut
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
    // 分组与显示都用剥掉日期的名字（见 groupName 的注释），否则一笔一个组。
    const name = groupName(String(p?.name ?? '积分'))
    const unit = String(p?.unit ?? '')
    const total = Number(p?.total) || 0
    const remaining = Number(p?.remaining) || 0
    const used = Number(p?.used) || (total > 0 ? Math.max(0, total - remaining) : 0)
    const until = Number(p?.deductionEndTime)
    const hasUntil = Number.isFinite(until) && until > 0
    // 这一份包**有没有周期/到期**信息（三者任一非空即算有）。
    // 它是「这是配额还是钱包」的关键判据之一，见下面 wallet 的注释。
    const hasCycle =
      hasUntil ||
      String(p?.cycleStartTime ?? '').trim() !== '' ||
      String(p?.cycleEndTime ?? '').trim() !== '' ||
      String(p?.expiredTime ?? '').trim() !== ''
    // ⚠️ `totalKnown === false` 是**上游明说**「只有余额、没有初始总额」。
    // `vendor/lib/credits.d.ts:184-196` 的契约原文：此时 `total` 只能冗余填
    // `remaining`，面板**不得**把两者并列显示，否则每次消耗后都是 `100/100 →
    // 98/98` 这种「分母跟着余额跑」的假读数（用户 2026-11-05 报障）。
    const totalKnownFalse = p?.totalKnown === false
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
        // 组内**任一份**是钱包 ⇒ 整组按钱包显示（合并只会让 total/remaining 更不可信）
        anyTotalUnknown: totalKnownFalse,
        // 组内**每一份**都没有周期信息 ⇒ 才有可能是钱包（见 toMagpieUsage）
        allCycleless: !hasCycle,
      })
      continue
    }
    cur.total += total
    cur.remaining += remaining
    cur.used += used
    cur.count += 1
    if (total > cur.each) cur.each = total
    cur.allInactive = cur.allInactive && p?.active === false
    cur.anyTotalUnknown = cur.anyTotalUnknown || totalKnownFalse
    cur.allCycleless = cur.allCycleless && !hasCycle
    if (hasUntil) {
      cur.untils.push(until)
      if (cur.until === undefined || until < cur.until) cur.until = until
    }
  }
  for (const g of byKey.values()) g.untils.sort((a, b) => a - b)
  return [...byKey.values()]
}

/**
 * 额度的显示文本：最多两位小数，整数不带 `.00`。
 *
 * 上游给的是**原始浮点**（officeace 实测 `4584.442685714286`），直接拼进
 * `balance` 就是卡片上那串 12 位小数（2026-11-01 用户截图）。magpie 对
 * `windows[].display` 会自己按数字格式化，但 `balance` 是**纯文本**原样贴上去，
 * 所以这一处必须由我们收敛。
 *
 * 为什么不四舍五入到整数：额度确实可能是小数（实测 `8.064516129032259`），
 * 抹成整数会让「0.5 → 1」这种小额度失真。
 */
function fmtNum(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return String(n)
  // 先截到两位，再去掉末尾的 0 与孤立的小数点（`100.00` → `100`、`8.50` → `8.5`）
  return v.toFixed(2).replace(/\.?0+$/, '')
}

/**
 * 按**量级**收敛：`token` 计的大数字压成 `9.93M` / `945.39K`，其余仍走 `fmtNum`。
 *
 * 为什么光有 `fmtNum` 不够：它只收敛小数位、不压缩量级，于是 Marvis 的
 * 千万级令牌被逐位写全 —— 卡片上就是 `余额 9999976 token`（2026-11-11 用户
 * 报障「我这里显示的不是1m而是每个数字都写出来了」）。位数差三个数量级，
 * 一眼读不出这号还剩多少。
 *
 * ⚠️ **只对 `unit === 'token'` 生效**。积分（credit）实测都是两位数
 * （`146.341` / `4584.44`），压成 `0.15K` 只会让读数更难核对。
 *
 * 阈值与 `vendor/lib/credits.js` 的 `formatTokenAmount`（进而与客户端
 * `formatTokens`）一致：`>= 1e6` → M、`>= 1e3` → K、其余取整。两处刻意的差别：
 *
 * ① **向下截断，不四舍五入**。剩余量舍入会向上虚报，最坏情况是把
 *    `9999976 / 10000000`（已用 24，几乎没动）渲染成 `10M / 10M · 剩余 100%`
 *    —— 读数与「满额未用」逐字相同，等于把用掉的量抹掉。截断最多少报到
 *    一个 0.01 单位，方向永远是「我不比实际多」。
 * ② **去掉末尾的 0**，沿用 `fmtNum` 那条卡片惯例（`10000000` → `10M` 而不是
 *    `10.00M`），跟同一行里的其余读数写法对齐。
 *
 * `unit` 比较**不分大小写**：OfficeAce 那家报的是 `'Token'`（首字母大写），
 * 而 `claimUnitLabel` 也同时认 `'token'` / `'Token'` 两种写法。
 */
function fmtScaled(n, unit) {
  const v = Number(n)
  if (!Number.isFinite(v)) return String(n)
  if (String(unit ?? '').trim().toLowerCase() !== 'token') return fmtNum(v)
  const abs = Math.abs(v)
  // 只去**小数**尾部的 0：`10.00` → `10`，但 `10` 必须原样留下
  // （`/\.?0+$/` 那种写法会把整数的尾零也吃掉，`10` 变成 `1`）。
  const trim = (s) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s)
  // 先放大 100 倍再截断，等价于「保留两位、向零取整」
  if (abs >= 1e6) return `${trim(String(Math.trunc((v / 1e6) * 100) / 100))}M`
  if (abs >= 1e3) return `${trim(String(Math.trunc((v / 1e3) * 100) / 100))}K`
  return fmtNum(v)
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
 * MonkeyCode 两站：上游**只有收支净额**，没有「积分包 + 有效期」。
 *
 * ## 为什么不能照 MiniMax 那套做
 *
 * MiniMax 的 `credit/details` 会回 `details[]`，**每笔发放各带 `expire_at_ms`**，
 * 余额 = Σ 各包 `remaining_amount` ⇒ 过期的包自动退出累加，窗口自然收缩
 *（`vendor/lib/minimax-credits.js:590-650`）。这正是理想的「有效积分累积」模型。
 *
 * MonkeyCode 没有这条路（2026-11-09 实测）：
 *  - `/wallet/credits`、`/wallet/credit`、`/users/credits`、`/credit/details`、
 *    `/wallet/details`、`/wallet/packages`、`/wallet/grants` → **全部 404**
 *  - 唯一可用的是 `/wallet/transaction`（流水），字段只有
 *    `inout_type / kind / amount / amount_balance / amount_daily / remark / created_at`
 *    ——**没有任何到期时间**
 *  - `/wallet` 只给一个标量 `balance`（单位千分之一积分），且**可以是负数**
 *
 * ## 用户定的口径（2026-11-09）
 *
 * 「近 30 天的收入之和为总窗口」+「余额为负时显示 0」+「实时拉流水」。
 * 账目实测吻合：4 个负余额账号的 `wallet.balance` 与
 * 「30 天收入 − 30 天支出」**逐位相等**（-16.616 / -10.402 / -10.402 / -39.721），
 * 说明这个 balance 就是收支滚出来的净额，不是「欠费」而是「滚到负数」。
 *
 * ⇒ 剩信用 `max(0, balance)`（负的按 0 即「已用尽」），分母用 30 天收入之和。
 *
 * ## 开销
 *
 * 流水必须翻页（默认一页 10 条，`?page=N&size=100` 才给 100 条；实测单账号
 * 最多 103 条）。这里限制**最多 5 页**并把结果按 60 秒缓存 —— 与
 * `BALANCE_TTL_MS`（90 秒）同一量级，避免 magpie 反复重绘卡片时打爆上游。
 * 拉取失败**不当作错误**：退回原有的钱包语义（只报余额），绝不因为「算不出
 * 分母」让整个用量卡变成错误。
 */
const MONKEYCODE_PROVIDERS = new Set(['monkeycode', 'monkeycodeintl'])
/** 30 天窗口（秒）。 */
const MONKEYCODE_WINDOW_SEC = 30 * 86400
/** 单账号最多翻几页流水（每页 100 条，5 页 = 500 条，实测最多 103 条）。 */
const MONKEYCODE_MAX_PAGES = 5
/** 窗口读数的缓存时长 —— 与 `BALANCE_TTL_MS` 同量级。 */
const MONKEYCODE_WINDOW_TTL_MS = 60_000
/** @type {Map<string, {at:number, income:number|undefined}>} */
const monkeycodeWindowCache = new Map()

/** 取该渠道的平台根地址（`monkeycode` / `monkeycodeintl` 两套部署）。 */
function monkeycodeBaseUrl(provider) {
  return provider === 'monkeycodeintl' ? 'https://monkeycode-ai.net' : 'https://monkeycode-ai.com'
}

/**
 * 取该渠道的**产品常量**（`MONKEYCODE` / `MONKEYCODE_INTL`）。
 *
 * ⚠️ 必须按渠道给对：两个站的 `platformBaseUrl` / `apiKeysPath` 都不同 ——
 * 拿错一个就是「国内站登录态打到国际站恒 401」。兑换 Key、读资料、读钱包
 * 都吃这个对象，所以只在建号入口处取一次往下传。
 */
async function monkeycodeProductOf(provider) {
  const { MONKEYCODE, MONKEYCODE_INTL } = await import('../vendor/lib/monkeycode-product.js')
  return provider === 'monkeycodeintl' ? MONKEYCODE_INTL : MONKEYCODE
}

/** 从凭据对象里取会话 cookie（与 vendor 的归一化规则同源）。 */
async function monkeycodeCookieOf(credential) {
  if (credential === null || typeof credential !== 'object') return undefined
  const raw = credential.session_cookie
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const { MONKEYCODE_SESSION_COOKIE_NAME } = await import('../vendor/lib/monkeycode-browser-login.js')
  const { normalizeSessionCookie } = await import('../vendor/lib/session-cookie.js')
  return normalizeSessionCookie(raw, [MONKEYCODE_SESSION_COOKIE_NAME], MONKEYCODE_SESSION_COOKIE_NAME)
}

/**
 * 拉近 30 天的收入合计（千分之一积分）。
 *
 * @returns {Promise<number|undefined>} 拿不到（会话失效/网络失败）时 undefined，
 *   调用方据此退回钱包语义 —— **不编造分母**。
 */
async function monkeycodeIncome30d(provider, credential, log) {
  const cookie = await monkeycodeCookieOf(credential)
  if (cookie === undefined) return undefined
  const baseUrl = monkeycodeBaseUrl(provider)
  const headers = {
    cookie,
    accept: 'application/json',
    referer: `${baseUrl}/`,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  }
  const cutoff = Math.floor(Date.now() / 1000) - MONKEYCODE_WINDOW_SEC
  let income = 0
  let seen = 0
  try {
    for (let page = 1; page <= MONKEYCODE_MAX_PAGES; page += 1) {
      const res = await fetch(
        `${baseUrl}/api/v1/users/wallet/transaction?page=${page}&size=100`,
        { headers, signal: AbortSignal.timeout(15_000) },
      )
      if (!res.ok) return undefined
      const body = await res.json()
      const txs = Array.isArray(body?.data?.transactions) ? body.data.transactions : []
      if (txs.length === 0) break
      seen += txs.length
      let crossedWindow = false
      for (const t of txs) {
        const at = Number(t?.created_at)
        if (!Number.isFinite(at) || at < cutoff) {
          // 流水按时间倒序：一旦越过窗口边界，后面的都不用看了
          if (Number.isFinite(at)) crossedWindow = true
          continue
        }
        // 收入 = 非 model_consumption 的一切（实测有 checkin）。金额单位与
        // wallet.balance 一致，都是千分之一积分。
        if (t?.kind !== 'model_consumption') {
          const amount = Number(t?.amount)
          if (Number.isFinite(amount) && amount > 0) income += amount
        }
      }
      if (crossedWindow || txs.length < 100) break
    }
  } catch (e) {
    log?.(`[${provider}] 流水拉取失败（退回钱包语义）：${e?.message ?? e}`)
    return undefined
  }
  // 一条流水都没读到 ⇒ 不是「收入 0」，而是「读不到」⇒ 不编分母
  if (seen === 0) return undefined
  return income
}

/**
 * 取某账号的真实凭据（含 `session_cookie`）。
 *
 * ⚠️ `getAuth()` 给的记录**不含凭据**：实测 `plugin-auth.json` 里 MonkeyCode
 * 记录只有 `{type, key, accountId, uid, metadata}` —— `key` 是引用串
 * （`jet-hub-local:monkeycode/monkeycode-xxxx`），不是 cookie 本体。
 * 真正的 cookie 在 DSH 的 `.credentials.yaml` 里，要按
 * `metadata.dshAccountId` → 池条目的 `credentialRef` → 凭据文件取值 这条链拿。
 *
 * ⚠️ 不走 `ctx.credentials.resolve()`：那个 ctx 只在容器内部账号池包装闭包里，
 * 插件侧拿不到（`usage()` 闭包里的 `container` 是 `JetHubContainer` 实例，
 * 只暴露 `rpc` / `credentialFile` / `credentialAlive`）。
 * ⇒ 直接读凭据文件 + `parseRefs`（与 `credentialAlive` 同一条读法）。
 * 任何一环断掉都返回 undefined（调用方退回钱包语义，不编分母）。
 */
async function credentialOfAccount(container, provider, accountId, log) {
  const want = String(accountId ?? '').trim()
  if (want === '') return undefined
  try {
    const rows = await listAccountsOf(container, provider, log)
    const hit = rows.find((a) => String(a?.id ?? '') === want)
    const ref = hit?.credentialRef
    if (typeof ref !== 'string' || ref.trim() === '') return undefined
    const refs = parseRefs(readFileSync(container.credentialFile(), 'utf8'))
    const raw = refs.get(ref)
    if (typeof raw !== 'string' || raw.trim() === '') return undefined
    return JSON.parse(raw)
  } catch (e) {
    log?.(`[${provider}] 取账号 ${want} 的凭据失败（退回钱包语义）：${e?.message ?? e}`)
    return undefined
  }
}

/**
 * 把 MonkeyCode 的用量读数改成「剩余 / 30 天收入」。
 *
 * 只在拿到收入合计时才改写；拿不到就**原样返回** `base`（钱包语义：
 * 只报「N credit left」），保证「算不出分母」不会污染读数。
 *
 * @param {object} base `toMagpieUsage` 的结果
 * @param {string} provider
 * @param {object} container 用来解析账号凭据
 * @param {string} accountId DSH 账号 id（`usage(getAuth)` 里认出来的那个）
 */
async function withRollingIncomeWindow(base, provider, container, accountId, log) {
  const packages = Array.isArray(base?.windows) ? base.windows : []
  if (packages.length === 0) return base
  const key = `${provider}\u0000${String(accountId ?? '')}`
  let income
  const hit = monkeycodeWindowCache.get(key)
  if (hit !== undefined && Date.now() - hit.at < MONKEYCODE_WINDOW_TTL_MS) {
    income = hit.income
  } else {
    const credential = await credentialOfAccount(container, provider, accountId, log)
    income = credential === undefined ? undefined : await monkeycodeIncome30d(provider, credential, log)
    monkeycodeWindowCache.set(key, { at: Date.now(), income })
  }
  if (!Number.isFinite(income) || income <= 0) return base

  const totalCredit = income / 1000
  return {
    ...base,
    windows: packages.map((w) => {
      // 只改「积分余额」那条（单位 credit）；每日额度（token）有上游真总额，不动
      if (String(w?.unit ?? '') !== 'credit') return w
      /**
       * 取「剩余」原值。
       *
       * ⚠️ `text` 形态（负数包被 `toMagpieUsage` 转成「已欠费 10.4 credit」）里
       * **负号已经丢了** —— 那串文字是 `已欠费 <绝对值>`。这里若直接 parseFloat
       * 会得到 +10.4，把「透支」误读成「还剩 10.4」。
       * ⇒ 先判文案里有没有「欠费」，有就返回负数。
       */
      let rawLeft
      if (typeof w.balance === 'number') {
        rawLeft = w.balance
      } else if (typeof w.text === 'string') {
        const num = Number.parseFloat(w.text.replace(/[^\d.-]/g, ''))
        rawLeft = Number.isFinite(num) && /欠费/.test(w.text) ? -Math.abs(num) : num
      } else {
        rawLeft = Number.NaN
      }
      // 负余额按 0 处理（用户口径：显示 0 = 已用尽，不显示成欠费）
      const left = Number.isFinite(rawLeft) ? Math.max(0, rawLeft) : 0
      const used = Math.min(100, Math.round(((totalCredit - left) / totalCredit) * 100))
      return {
        name: w.name,
        unit: 'credit',
        // 分母 = 近 30 天收入之和（滚动窗口：老收入自然退出，等价于 minimax 的包过期）
        used,
        // `fmtNum` 会把 `700` 渲染成 `700`（整数不带 .00），所以这里统一两位小数，
        // 免得出现「0 / 700 credit」这种一边有小数一边没有的读法。
        display: `${left.toFixed(2)} / ${totalCredit.toFixed(2)} credit`,
        amount: left,
        limit: totalCredit,
      }
    }),
  }
}

/**
 * 把本体的余额读数翻译成 magpie 的 `auth.usage` 返回形状。
 */
function toMagpieUsage(reading, provider) {
  // 用量卡标题同样不带前缀（与供应商卡片名一致，见 config() 里那处说明）。
  const plan = NAMES[provider] ?? provider
  // ⚠️ `reading.error` 不等于「没有数据」。上游对「本次查询失败但还有上一次快照」的情形是
  // 故意把快照一起回传的（`vendor/lib/jet-hub-rpc.js` 的注释：「`stale` 照样回传
  // （用户宁可看到『昨天 12:00 的 6493』也不要空白）但必须带 `error` 说明这是历史数据」）。
  //
  // 但 magpie 一见 `error` 就整块只画错误、不画 `windows`（`app.js` 的 `accountQuota`：
  // `if (!q || q.error || !q.windows?.length) { …只画一句错误文案 … }`）。两边相加的结果就是
  // 截图里那个自相矛盾的卡片：一个数字都没显示，只显示一句「本次查询失败，
  // 显示的是上一次成功读到的数据」—— 说自己显示了旧数据，而画面上什么都没有。
  //
  // 所以：有快照就照常画 `windows`，并把「本次没刷新到」写进条目名字（magpie 的
  // window 没有 tooltip 位，只能放名字）；真没快照才回 `error`。
  const staleNote = reading?.error ? humanizeUsageError(reading.error) : undefined

  const b = reading?.balance
  if (b === undefined || b === null) {
    // 连快照都没有（上游返回 `balance: null` + 错误）—— 这个时候才真的只能报错。
    return staleNote !== undefined ? { plan, error: staleNote, windows: [] } : { plan, windows: [] }
  }

  // ⚠️ 过滤 total=0 的空套餐：本体照样会返回 `{total:0, remaining:0}` 的条目
  //    （astudio 的「会员积分」实测就是这样），画成卡片就是「0/0、可用 100%」，
  //    纯误导。有 remaining 没有 total 的（按量计费）保留。
  //
  // ⚠️⚠️ **负数必须保留**（2026-11-09 用户报「都变成负数了，还不如之前的」）：
  //    MonkeyCode 欠费账号的「积分余额」上游给的是 `total=-10.402,
  //    remaining=-10.402`（实测 3 个账号：-10.402 / -39.721 / -16.616）。
  //    旧过滤式只留 `> 0`，把这条**整个丢掉** ⇒ 卡片上一点欠费痕迹都没有，
  //    用户反而看不到「这个号已经透支了」。⇒ 改成只掐掉「恰好都是 0」的空包。
  const packages = mergePackages(
    (Array.isArray(b.packages) ? b.packages : []).filter((p) => {
      const t = Number(p?.total) || 0
      const r = Number(p?.remaining) || 0
      // 空包判定：total 与 remaining **都为 0** 才丢（负数是真实欠费，要留）
      return t !== 0 || r !== 0
    }),
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
  // 渲染期过期重算：上游的 `active`/`expired` 在快照路径会冻结（officeace 的
  // stale 缓存原样返回，过期每日桶仍 active=true；trae 干脆硬编码 true），
  // 只有 `deductionEndTime` 是「这批积分何时作废」的硬事实（credits.d.ts:245-263）。
  // 在这里按当前时间重算，过期组与 allInactive 一样压后、改 text 窗口，
  // 否则过期桶会画成「100 / 100 · 剩余 100%」还占住卡片前两行（2026-11-09 用户截图）。
  const now = Date.now()
  for (const g of packages) g.expired = Number.isFinite(g.until) && g.until > 0 && g.until <= now
  packages.sort((a, b2) => {
    const aAside = a.allInactive || a.expired ? 1 : 0
    const bAside = b2.allInactive || b2.expired ? 1 : 0
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
    /**
     * 这一条是**钱包**（只知道还剩多少）还是**配额**（知道总量、能算百分比）？
     *
     * ## 为什么必须分（2026-11-09 用户截图：所有渠道「剩余永远 100%」）
     *
     * magpie 画进度条用的是 `limit`（总量）当分母，文案是「剩余 N%」。当上游
     * **只给余额、没有初始总额**时，我们把 `remaining` 冗余填进 `total` ⇒
     * 分母 == 余额 ⇒ 刚查完就是 100%，消耗完又变 100%，**永远 100%**
     * （截图里的 `817.04 / 817.04 · 剩余 100%`、`0 / 500` 全是这一条）。
     *
     * `vendor/lib/credits.d.ts:184-196` 早写死了这条契约：`totalKnown:false`
     * 时面板**不得**把 `remaining` 与 `total` 并列。magpie 自己也有对应语义：
     * 窗口给 `balance` 就只显示「N left」，**不画进度条**
     * （`quotaNoShare(w)` 里 `w.balance != null` 即成立）。
     *
     * 判定（三者满足其一即钱包）：
     *  ① 上游明说 `totalKnown === false`（百智充值积分、MonkeyCode 积分余额）；
     *  ② 组内**每一份**都没有任何周期/到期字段（`cycleStart/End/expired/deductionEnd`
     *     全空）—— 有周期的是配额（WorkBuddy Free Plan、Cline 的日额度等都有）；
     *  ③ `total === remaining` 且 `used` 为 0 且无周期：从没扣减过的「总量=余额」
     *     只可能是余额型（Cline 账户余额、ModelScope 魔粒、Raccoon 奖励积分…）。
     *
     * ⚠️ 反过来**不能**一刀切「无周期就当钱包」：codearts 的「赠送积分包」
     * `cycleEndTime` 为空但有 `used=4.48`，那是真配额（`17100` 里扣了 4.48），
     * 误判成钱包会让它丢掉进度条。
     */
    const wallet =
      p.anyTotalUnknown === true ||
      (total > 0 && p.allCycleless === true && used === 0 && total === remaining)
    const w = {
      // 名字带到期日（`签到奖励 ×31 · 10-30 到期`），理由见 windowName 的注释
      name: windowName(p),
      unit: String(p?.unit ?? ''),
    }
    /**
     * 每日额度桶：分母用**当天首见额度**，不用上游那个不可信（或缺失）的 total。
     *
     * 用户 2026-11-09 定的口径：「每日限时的积分以首次获取的额度作为窗口」。
     * 例：百智云每日发放 200 的账号，`buildBaizhiBalance` 给的是
     * `total = max(100, 199.96) = 199.96` ⇒ 分母==余额 ⇒ 永远 100%。
     * 这里改用那天第一次看到的余额（199.96）当分母，之后消耗才算得出百分比。
     *
     * ⚠️ 只对**每日桶**（名字精确匹配 DAILY_POOL_NAMES）生效；充值/长期包
     * 没有周期重置，首见值不是分母 —— 那是钱包，走上面的 balance 语义。
     * ⚠️ 基线 key 必须带账号：同家渠道多个账号各有各的发放额（100 / 200 不等）。
     */
    const acctId = String(reading?.accountId ?? reading?.id ?? '')
    const dailyKey = `${provider}\u0000${acctId}\u0000${p.name}`
    const isDaily = isDailyPool(p.name)
    /**
     * 只有**上游没给可信总额**的每日桶才需要自采基线。
     *
     * ⚠️⚠️ 2026-11-09 回归（用户报「都变成负数了，还不如之前的」）：
     * 第一版对**所有**每日桶都采基线 ⇒ MonkeyCode 的「每日额度」（上游给了真总额
     * `10000000`、已用 439414）被写成基线 `9560586`（当时的**残值**）⇒ 显示
     * `9560586 / 9560586 · 剩余 0%` —— 比修复前的
     * `9560586 / 10000000 · 剩余 4%` 更糟，是我引入的回归。
     *
     * 判据：**上游 total 可信**（`total > 0` 且没被标 `totalKnown:false`）
     * ⇒ 直接用上游的，**不采基线**。只有上游没给真总额（百智云那种
     * `total = max(100, 余额)` 的假分母）才需要自采当天首见值。
     */
    const upstreamTotalTrusted = total > 0 && p.anyTotalUnknown !== true
    if (isDaily && remaining > 0 && !upstreamTotalTrusted) {
      // 采/取当天基线；它必然 ≥ remaining（见 dailyTotalOf 的抬高逻辑）
      p.dailyTotal = dailyTotalOf(dailyKey, remaining)
    }
    /**
     * 长期积分（百智云「充值积分」）用**历史水位**当分母 —— 用户 m01511
     * 「总额度也要有窗口」。上游不给初始总额，只能自采；白名单见
     * `WALLET_WINDOW_POOLS`，理由见那段注释。
     */
    const isWalletWindow = isWalletWindowPool(provider, p.name)
    if (isWalletWindow && remaining > 0) {
      p.walletPeak = walletPeakOf(dailyKey, remaining)
    }
    /**
     * 欠费（余额为负）：上游真的会下发负数 —— MonkeyCode 实测
     * `total=-10.402, remaining=-10.402`（透支扣费）。
     *
     * 这种包**不能**按金额画进度条（负的 amount/limit 会让 magpie 的百分比
     * 计算失控），也不该被隐藏（用户要知道这个号已经透支）。用 magpie 的
     * `text` 窗口：它只显示这行文字，不画进度条、不参与百分比。
     * ⚠️ `text` 优先于一切（`quotaNoShare` 的 `!!w.text` 第一条件），
     * 所以这里必须**提前返回**，不要再去填 amount/limit。
     */
    if (remaining < 0) {
      const u = String(p?.unit ?? '').trim()
      const w = {
        name: windowName(p),
        unit: u,
        // 「-10.4 credit」+ 说明，别写 left（负数说 left 读着是反的）
        text: `已欠费 ${fmtScaled(Math.abs(remaining), u)} ${u}`.trim(),
      }
      if (Number.isFinite(p.until) && p.until > 0) w.resetsAt = p.until
      return w
    }
    /**
     * 已过期作废：`deductionEndTime` 已过，这批积分（哪怕快照里 remaining>0）
     * 已经花不出去。画进度条就是谎报「还有 100% 可用」—— 2026-11-09 用户截图
     * 里 11-06 到期的每日签到有礼被 stale 快照冻成 `100 / 100 · 剩余 100%`。
     * 与欠费同款处置：`text` 窗口只报事实，不画条、不参与百分比；aside 压后。
     */
    if (p.expired) {
      const w = {
        name: windowName(p),
        unit: String(p?.unit ?? ''),
        text: '已过期作废',
        aside: true,
      }
      if (Number.isFinite(p.until) && p.until > 0) w.resetsAt = p.until
      return w
    }
    if (isWalletWindow && p.walletPeak > 0) {
      // 长期积分：分母 = 历史水位（≥ 余额）。这里**不能**填 balance ——
      // magpie 见到 balance 就退回「N left」、不画进度条，等于白改
      // （`quotaNoShare(w)` 的 `w.balance != null` 分支）。
      const base = p.walletPeak
      w.used = Math.min(100, Math.max(0, Math.round(((base - remaining) / base) * 100)))
      w.display = `${fmtScaled(remaining, p?.unit)} / ${fmtScaled(base, p?.unit)} ${p?.unit ?? ''}`.trim()
      w.amount = remaining
      w.limit = base
    } else if (wallet && !isDaily) {
      // 钱包：只报「还剩多少」，不给 limit/used —— magpie 见到 balance 就不画
      // 进度条，只写「N left」。这是唯一诚实的显示：没有总量就不该编分母。
      w.balance = remaining
    } else if (isDaily && p.dailyTotal > 0) {
      // 每日桶：分母 = 当天首见额度（不是上游那个可能等于余额的 total）
      const base = p.dailyTotal
      const dayUsed = Math.max(0, Math.round((base - remaining) * 100) / 100)
      w.used = Math.min(100, Math.round((dayUsed / base) * 100))
      w.display = `${fmtScaled(remaining, p?.unit)} / ${fmtScaled(base, p?.unit)} ${p?.unit ?? ''}`.trim()
      w.amount = remaining
      w.limit = base
    } else {
      // used 是**已用百分比**（0–100），magpie 用它画进度条并写「剩余 100%」。
      // ⚠️ 别填 remaining —— 实测 astudio 会变成「0 / 6,200 · 剩余 100%」这种
      //    自相矛盾的卡片（显示剩余 0、进度条却是满的）。
      w.used = total > 0 ? Math.round((used / total) * 100) : 0
      // display 是**剩余 / 总额**（magpie 自己的文案就是「剩余 x%」，这里对齐它）
      w.display = `${fmtScaled(remaining, p?.unit)} / ${fmtScaled(total, p?.unit)} ${p?.unit ?? ''}`.trim()
      w.amount = remaining
      w.limit = total
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
    // 有快照但全是 0/0 且本次失败：没有可画的数字，就照实报错，
    // 别把「0 积分」当成健康读数（那比空白更误导）。
    if (staleNote !== undefined) return { plan, error: staleNote, windows: [] }
    return { plan, user: reading?.nickname !== undefined ? String(reading.nickname) : '', balance: `0 ${unit0}`.trim(), windows: [] }
  }

  // 有快照但本次没刷新到：把它标在第一条名字后（magpie 行内只画前 2 条，
  // 标第一条最容易被看到）。不能放进 `error`—— 那会让 magpie 整块只画错误。
  // （windows 非空在这里是必然的：上面 1479 已经把空的情况早退掉了）
  if (staleNote !== undefined) {
    windows[0].name = `${windows[0].name} · 本次未刷新，显示上次数据`
  }

  const total = Number(b.total) || 0
  const unit = packages[0]?.unit ?? '积分'
  // 最早到期的那一份：magpie 用它显示「订阅到 X 到期」
  const untils = windows.map((w) => w.resetsAt).filter((t) => Number.isFinite(t) && t > 0)
  /**
   * 合计行：`balance` 是 magpie 卡片右上那行「余额 N 单位」。
   *
   * ⚠️⚠️ 2026-11-09 回归（用户报「都变成负数了」）：MonkeyCode 的
   * `balance.total` 是上游逐账号汇总值，**欠费账号本来就是负的**
   * （实测 -10.402 / -39.721 / -16.616，上游原样下发）。这不是我们算错，
   * 但直接把负号铺在最显眼的合计行上，用户会以为整个渠道坏了。
   *
   * 处置：合计行**不再单列一个可能为负的汇总数**，改成按包逐个报 ——
   * 这正是用户当初要的「看得懂」：MonkeyCode 卡片显示
   * `积分余额 -10.4 credit`、`每日额度 0 / 10,000,000 token · 剩余 0%`，
   * 负数只出现在**它真正所属的那个包**上，不再冒充整家渠道的总余额。
   *
   * ⚠️ 单位也别拿 `packages[0].unit` 硬套历史合计（MonkeyCode 第一个包是
   * `credit`、合计却是 token 计的数字，旧码因此显示成「146.34 token」）。
   * 合计为 0/负时干脆不写 balance，交给 windows 各行自己带单位。
   */
  const balanceText = total > 0 ? `${fmtScaled(total, unit)} ${unit}`.trim() : ''
  /**
   * 合计行也带分母（用户 m01511 选的「总额度 + 充值积分 都加」）。
   *
   * magpie 的行内配额只画**前 2 条**窗口（`ws.slice(0, 2)`），其余进 tooltip ——
   * 所以硬塞一个「总额度」窗口当第三条，会被挤进 tooltip 并把「每日积分」
   * 从行内顶掉。改在这里：合计行本来就是「整家渠道一眼看多少」，给它加分母
   * 等价于「总额度窗口」，且不占配额行的名额。
   *
   * 口径：**每个窗口都必须有可信分母**（`limit > 0`）才加。百智云是
   * `充值积分（水位）+ 每日积分（当天首见）` 恰好两条都有；将来某家渠道出现
   * 「只有余额、没分母」的窗口就整体跳过 —— 拿部分分母拼总和就是编数字。
   */
  const windowedTotal = (() => {
    if (!Object.hasOwn(WALLET_WINDOW_POOLS, provider)) return ''
    // aside 的是冻结/过期作废之类，本就不算「可用额度」，不进分子分母
    const counted = windows.filter((w) => w.aside !== true)
    if (counted.length === 0) return ''
    if (!counted.every((w) => Number.isFinite(w.limit) && w.limit > 0)) return ''
    if (!counted.every((w) => Number.isFinite(w.amount) && w.amount >= 0)) return ''
    const den = counted.reduce((s, w) => s + w.limit, 0)
    const amt = counted.reduce((s, w) => s + w.amount, 0)
    if (!(den > 0) || !(amt <= den)) return ''
    return `${fmtNum(amt)} / ${fmtNum(den)} ${unit}`.trim()
  })()
  return {
    plan,
    user: reading?.nickname !== undefined ? String(reading.nickname) : '',
    ...(windowedTotal !== ''
      ? { balance: windowedTotal }
      : balanceText === '' ? {} : { balance: balanceText }),
    ...(untils.length ? { until: Math.min(...untils) } : {}),
    windows,
  }
}

function writeCache(log) {
  try {
    const cacheFile = cacheFileOf()
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
    out[bare] = modelEntry(bare, label === bare ? undefined : { name: label }, metaOf(id), MODEL_PRICES[bare])
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
    out[bare] = modelEntry(bare, undefined, metaOf(id), MODEL_PRICES[bare])
  }
  return out
}

/**
 * 从两份目录里挑出某个 provider 该显示的模型表 —— 纯函数，不碰容器、不读盘。
 *
 * 优先级：**上游全量** > 实时可用。用户要的是「供应商上游全部模型」（m06921），
 * 所以全量排第一；全量还没拉到时退回实时可用；两份都空返回 `null`，由调用方
 * 决定退静态兜底。
 *
 * 抽出来的原因是可测：`prefer_full` 这个 magpie 开关以前只有容器级的间接断言，
 * 而上游「此刻恰好没有不可用模型」时全量与可用是同一个集合（2026-10-31 清空
 * 黑名单后就是 32/32），那条断言等于没跑过。这里喂固定数据就能逐条钉死语义。
 *
 * @param {string} dshProvider 本体 provider 名
 * @param {{live?: string[], full?: Array<{id: string, name?: string, disabled?: boolean}>}} [catalogs] 两份目录
 * @param {boolean} [preferFull] magpie 里 `prefer_full` 开关的值
 * @returns {{models: Record<string, unknown>, from: 'full'|'live'} | null}
 */
export function pickModels(dshProvider, { live, full } = {}, preferFull = true) {
  if (preferFull === true) {
    const wide = modelsOfFull(dshProvider, full)
    if (Object.keys(wide).length > 0) return { models: wide, from: 'full' }
  }
  const got = modelsOf(dshProvider, live)
  if (Object.keys(got).length > 0) return { models: got, from: 'live' }
  return null
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
      const picked = pickModels(dshProvider, { live, full }, optionOn('prefer_full', true))
      return picked?.models ?? provider?.models ?? fallbackFor(dshProvider)
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
                options: rows.map((a) => {
                  // 凭据丢了的账号**照样列出来**（用户可能就想看到它），但必须标明白：
                  // 签进来的会是一个查不到额度、请求也走不通的空壳。
                  const alive = credentialAliveOf(container, a?.credentialRef)
                  return {
                    label: alive ? accountLabel(a) : `${accountLabel(a)}（无登录凭据）`,
                    value: String(a?.id ?? ''),
                    hint: !alive
                      ? '这个账号在账号池里，但它的凭据已经不在凭据文件里了 —— 签进来查不到额度、请求也走不通。建议改用「新建账号」重新登一次，或把它从 DSH 里删掉'
                      : a?.enabled === false
                        ? '在 DSH 里已停用，接进来后请求会 502'
                        : undefined,
                  }
                }),
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
              // 账号在、凭据不在 ⇒ 签进去只会得到一个空壳：magpie 显示「已登录」，
              // 查额度报错、请求也抛 MISSING_CREDENTIAL（2026-11-01 真机：9 月建的
              // buddy 账号就是这么被签进去的，用户以为登录成功，实际什么都用不了）。
              if (hit !== undefined && !credentialAliveOf(container, hit.credentialRef)) {
                throw new Error(
                  `你选的账号 ${picked} 在账号池里，但它的登录凭据已不可用了（凭据文件里没有这条、或者它的值是空的）——`
                  + ` 到 DSH 里重新登录这个账号，或者改用「新建账号」重新登一次。`,
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
            : dshProvider === 'marvis'
              // 腾讯 Marvis 给两条腿（QQ / 微信），各一个方法：面板上直接是两个可点的
              // 选项，不用先去开关里选。两条腿的凭据不通用，所以必须让用户当场挑。
              ? [marvisOauthMethod(dshProvider, container, log)]
              // MonkeyCode 两站：**不再走「宿主开浏览器抓 cookie」那条腿**。
              // 那条腿要求 magpie 所在机器上有一个可见的 Chromium 窗口、并且真人
              // 就坐在那台机器前（见 `monkeycode-browser-login.js` 的「窗口必须可见」），
              // 装在服务器上时永远走不通 —— 2026-11-11 真机报的就是
              // 「找不到可用的浏览器（网页版登录需要本机有一个 Chromium 内核浏览器）」。
              // 改成「打开官网 + 粘贴 Key」：只要用户手里有 Key，任何机器都能加号。
              : MONKEYCODE_PROVIDERS.has(dshProvider)
                ? [monkeycodePasteMethod(dshProvider, container, log)]
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
                  // 导入那条腿没有授权页可等，说「在打开的页面里登录」会让人去找一个
                  // 永远不出现的窗口（2026-11-02 实测用户报「无法启动浏览器」）。
                  // ⚠️ `reused` 有两个来源，不能说成同一句话：超级麦吉走本机浏览器
                  // 的登录态；AStudio 走桌面客户端落盘的 `astron-session.json`
                  // （`astudio.importLocalSession`）。
                  instructions: reused
                    ? (dshProvider === 'astudio'
                      ? `已经从 ${NAMES[dshProvider] ?? dshProvider} 桌面客户端的登录态回填了这个账号；`
                        + '不需要在页面上做任何操作。'
                      : `已经从本机浏览器读到 ${NAMES[dshProvider] ?? dshProvider} 的登录态，`
                        + '正在回填这个账号；不需要在页面上做任何操作。')
                    : `在打开的页面里登录要新建的 ${NAMES[dshProvider] ?? dshProvider} 账号。`
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
                    // 判重可能把凭据转写给了老卡、把这条新卡留成空壳。签入必须跟着
                    // **存活的那条**走，否则 magpie 里多一张点不动的 `API key …` 卡。
                    const landed = await landedAccountOf(container, dshProvider, accountId, hit, log)
                    const signedId = landed.id
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
                      key: `jet-hub-local:${dshProvider}/${signedId}`,
                      accountId: `${accountLabel(landed.hit ?? { id: signedId })}·已新建`
                        + (wide > 0 ? `·上游 ${wide} 个模型` : ''),
                      uid: signedId,
                      metadata: { via: 'jet-hub', provider: dshProvider, dshAccountId: signedId },
                    }
                  },
                }
              },
            }]),

          /**
           * Key 型渠道的「新建」：贴一把 API Key 就建号。
           *
           * 为什么单独一条、而不是并进上面那个 `oauth` 方法：那条的 `authorize()`
           * 调 `account.create`，而这三家对 `account.create` 一律回
           * `unknown provider`（`vendor/lib/jet-hub-rpc.js` 里没有它们的分支）。
           * 上游 UI 走的是本家的 `*.addAccount`，这里照抄同一条路。
           *
           * 为什么 `keyless: true`：magpie 对 `api` 型方法会**先**弹它自己的
           * personal-key 输入框，粘完它把值放进 `key` 字段、**不会**传给
           * `authorize(inputs)`（宿主 `save()` 只把 `inputs` 当 metadata 合并）。
           * 而我们要把 Key 交给本体的 `*.addAccount` —— 只能自己用 `ask()` 收。
           * `keyless: true` 让 magpie 跳过它那个框（`PluginAPIKey` 里
           * `strings.TrimSpace(key) == ""` 时只有 keyless 才放行），于是用户看到
           * 的是我们 `ask()` 返回的输入框，答完带 `inputs` 进 `authorize()`。
           *
           * ⚠️ 这条排在 `api` 那条之后：magpie 前端在 `methods.length > 1` 时弹
           * 「怎么登录」选择器，第一项是默认选中的「接已有账号」，符合多数人的动作。
           */
          ...(KEY_ACCOUNT_RPC.has(dshProvider)
            ? [{
              type: 'api',
              keyless: true,
              label: `新建一个 ${NAMES[dshProvider] ?? dshProvider} 账号（粘贴 API Key）`,

              /**
               * 问用户要 API Key。
               *
               * 契约同上面那条的 `ask()`：返回 `{type,key,message,placeholder}`
               * 或 null；非 null 时 magpie 渲染成输入框，答完带 `inputs[key]` 重调。
               * 已经答过就返回 null，否则死循环。
               *
               * `type: 'password'` —— Key 是敏感材料，别在屏幕上明文显示
               * （magpie 前端支持这个类型，见 `internal/plugin/providers.go` 的
               * `Prompt.Type` 注释：「text, select, password (text typed unseen)」）。
               */
              async ask(inputs = {}) {
                // ⚠️ 必须 trim 后再判空：authorize() 用的是 `String(...).trim()`，
                // 这里若不 trim，用户粘了一串空格（复制时带上空白很常见）就会被当成
                // 「已经答过」⇒ ask() 永远返 null、authorize() 永远抛「没有填 API Key」，
                // 界面上再也回不到输入框，只能关掉重开（2026-11-01 二审实测）。
                if (typeof inputs?.[KEY_INPUT] === 'string' && inputs[KEY_INPUT].trim() !== '') return null
                return {
                  type: 'password',
                  key: KEY_INPUT,
                  message: `粘贴 ${NAMES[dshProvider] ?? dshProvider} 的 API Key（在本体账号池里新建一条）`,
                  placeholder: KEY_PLACEHOLDER[dshProvider] ?? 'API Key',
                }
              },

              /**
               * 把 Key 交给本体的 `*.addAccount`，拿回账号 id。
               *
               * 返回形状与上面那条一致（`{type:'success', key, accountId, uid,
               * metadata}`），这样 `loader(getAuth)` 认号、`usage(getAuth)` 定位
               * 账号、`scripts/seed-auth.mjs` 摊平都走同一套逻辑，不需要分支。
               *
               * `key` 里编进账号 id 的理由同上：宿主 `save()` 的 api 分支只落
               * `{type, key, metadata}`，判重靠 `settle()` 的 secret 分支（key 字符串
               * 相等）—— 不编 id 的话，同一个人再贴一次同一把 Key 会堆出第二条记录。
               */
              async authorize(inputs = {}) {
                const apiKey = String(inputs?.[KEY_INPUT] ?? '').trim()
                if (apiKey === '') {
                  throw new Error(`没有填 API Key：新建 ${NAMES[dshProvider] ?? dshProvider} 账号需要先粘贴一把 Key`)
                }

                // 建号本身只是一次本地写盘，很快；但容器可能还没起 ——
                // `rpc()` 自己会 `start()`，冷启动 20–30 秒，故套 45 秒上限
                // （与 `CREATE_TIMEOUT_MS` 同一个预算；magpie 给 authorize() 1 分钟）。
                const v = await withRpcDeadline(
                  container,
                  KEY_ACCOUNT_RPC.get(dshProvider),
                  { apiKey },
                  CREATE_TIMEOUT_MS,
                  `新建 ${dshProvider} 账号`,
                )
                const accountId = String(v?.accountId ?? '')
                if (accountId === '') {
                  throw new Error(`本体没有返回账号 id（${dshProvider}.addAccount 回：${JSON.stringify(v)}）`)
                }
                // 新建的号一定还没被 `account.list` 那 15 秒缓存看见，不然后面
                // `usage(getAuth)` / `ask()` 会拿旧列表，表现为「刚建的号查不到」。
                accountsCache.delete(dshProvider)

                // 建完再拉一次目录：Key 刚生效时模型列表可能刚变。
                //
                // ⚠️ 必须套上限：`liveAll` / `refreshFullCatalog` 内部走 `container.rpc()`，
                // 那条路径不会自己超时（`route.fetch(req)` 没有 AbortSignal），实测上游挂住
                // 时 authorize() 能一直不返回（二审把 refreshModels 打桩成挂 120 秒，60 秒没回）。
                // 建号本身已经成功，目录拉不到不该把这一行签入也卡死。
                try {
                  await withDeadline(
                    (async () => {
                      await liveAll(container, log)
                      fullModels = await container.refreshFullCatalog(DSH_PROVIDERS)
                      writeCache(log)
                    })(),
                    START_TIMEOUT_MS,
                    '建号后刷新目录',
                  )
                } catch { /* 目录拉不到不影响建号 */ }

                return {
                  type: 'success',
                  key: `jet-hub-local:${dshProvider}/${accountId}`,
                  // accountId 与上面那条 oauth 方法一样传**显示文案**（宿主 `save()` 的 api
                  // 分支只落 `{type,key,metadata}`，这个字段会被丢弃；写文案是为了两条方法
                  // 语义一致，别让后来人以为它真会生效）。真正的账号 id 在 metadata.dshAccountId。
                  accountId: `${NAMES[dshProvider] ?? dshProvider} · ${accountId}`,
                  uid: accountId,
                  metadata: {
                    // ⚠️ **必须**用同名键把宿主并进来的 inputs.apiKey 盖掉。
                    // 宿主 `save()` 是 `{ ...inputs, ...result.metadata }`（inputs 在前、
                    // metadata 在后），而我们的 inputs 就是 `{ apiKey: <明文> }` ——
                    // 不给同名键，那把 Key 会原样落进 magpie 的 `plugin-auth.json`，
                    // 与「只存在本体的 .credentials.yaml」的预期相反（2026-11-01 审查实测）。
                    // 赋 undefined 而不是删键：JSON.stringify 会丢弃值为 undefined 的键，
                    // 于是最终落盘里连 `apiKey` 这个名字都不出现。
                    apiKey: undefined,
                    via: 'jet-hub',
                    provider: dshProvider,
                    dshAccountId: accountId,
                    // 不记 `existed`：全仓没有消费方，且 opencode 新建时回 existed:false、
                    // 命中已有账号时回 true，写成 `existed === true` 落盘反而语义相反。
                  },
                }
              },
            }]
            : []),
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
            const base = toMagpieUsage(reading, dshProvider)
            // MonkeyCode 两站：上游只给「收支净额」，没有积分包/有效期
            //（`/wallet/credits` 等包接口全 404，交易流水也只有
            // `inout_type/kind/amount/amount_balance/amount_daily/remark/created_at`）
            // ⇒ 用**近 30 天收入之和**当总窗口，balance 当剩余。用户 2026-11-09 定的口径。
            if (MONKEYCODE_PROVIDERS.has(dshProvider)) {
              return await withRollingIncomeWindow(base, dshProvider, container, want, log)
            }
            return base
          } catch (e) {
            return { error: humanizeUsageError(e?.message ?? e), windows: [] }
          }
        },

        // ⚠️ **不支持签到的渠道根本不声明这个方法** —— magpie 的签到开关只看
        // `typeof auth.checkin === "function"`（宿主 host.js），声明了就等于给用户
        // 画一个点了必然失败的开关。判据见 `canCheckin()`（直接问上游的积分能力表）。
        ...(canCheckin(dshProvider)
          ? {
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
              const msg = String(e?.message ?? e)
              // 「这家没有签到功能」是能力缺失，不是故障 ⇒ `ineligible`。
              // 判据见 `isCheckinUnsupported()` 的长注释（那类文案占了 `failed` 的绝大多数）。
              if (isCheckinUnsupported(msg)) return { outcome: 'ineligible', message: msg }
              // 其余（401 / 网络 / 上游报错）在 magpie 里等同 failed，但带上原文更有用
              return { outcome: 'failed', message: msg }
            }
          },
          }
          : {}),
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

/**
 * MonkeyCode 两站的新建方法：**打开官网 + 粘贴 Key**，走宿主的「code 型」签入。
 *
 * ## 为什么不用 vendor 自带的「浏览器登录」
 *
 * `monkeycode-browser-login.js` 的整条思路是「在 magpie 那台机器上开一个**可见**
 * Chromium 窗口，让真人在那里登录，再用 CDP 读 HttpOnly 的 `monkeycode_ai_session`」
 * （文件头注释原文：「⚠️⚠️ 窗口必须可见（`hideWindow: false`）：用户要在这个窗口里
 * 自己登录」）。这个前提在服务器上直接不成立：
 *
 *   1. 绝大多数 Linux 服务器上没有 Chromium —— 2026-11-11 真机报
 *      「MonkeyCode: 找不到可用的浏览器（网页版登录需要本机有一个 Chromium 内核
 *      浏览器）」，9 条候选路径全落空；
 *   2. 就算装上了，也没有人坐在那台机器前点「同意」；
 *   3. `chromium-session.js` 的实测表写明 `--headless=new` 一律 `F001` ⇒ 无头替不了。
 *
 * 而 MonkeyCode 的推理凭据本来就**是用户能自己拿到的两串文本**：`oma_…` +
 * `signing_secret`，在平台站内「OhMyAgent」页面同一次生成（见
 * `vendor/lib/client/jet-hub.js` 的弹窗文案：「signing_secret 与 API Key 同时生成
 * （48 位随机串）」）。所以让用户在自己的浏览器里打开官网、复制两串、粘回来，
 * 就完全绕开了「magpie 那台机器上必须有浏览器」这个死结。
 *
 * ## 为什么是 `method: 'code'` 而不是 `ask()`
 *
 * 宿主的 `authorize()` 返回对象里那个字段叫 `method`（`Authorization.Method`，
 * `host.js` 按 `a.method === "code"` 判定），取 `"code"` 时 GUI 会把 `url` 渲染成
 * **一段带复制按钮的链接**，并给一个粘贴框；用户粘进去后宿主调
 * `callback(code)`（2 分钟预算，比 authorize 的 1 分钟宽）。这正是要的形态：
 * 一个链接 + 一个输入框，不依赖任何本地程序。
 *
 * ⚠️ 字段名是 `method`，不是 `mode` —— 写成 `mode: 'code'` 宿主不认（会当成
 * auto 型，去等一个永远不来的回调）。腾讯 Marvis 那条踩过同一个坑。
 *
 * ## 粘贴框收两个值怎么办
 *
 * 粘贴框是**单行 input**（`internal/gui/assets/app.js` 里 `input(...)`，`type` 只
 * 在 pasteKey 时才是 password），但它是普通文本框 —— 用户在浏览器里从官网那页
 * 连续复制两行、粘进来的就是一串带换行/空白的文本。`monkeycodePastedPaire()` 按
 * 「先 Key 后 signing_secret」的顺序认，也容忍 `API Key: xxx` 这种带标签的写法。
 * 只粘了一把 Key 时照样建号 —— 能发消息，只是查不到余额/积分（`fetchMonkeycodeWallet`
 * 会明确说「未配置会话」）；之后可以用面板上的「改 Key」补 session cookie。
 *
 * ## 为什么不做「新建 + 立刻验一把」
 *
 * 建号只是一次本地写盘（`monkeycode.addAccount` 不访问上游）。真去发一次请求会
 * 在 Key 有误时把错误推迟到用户第一次聊天时，但也会让「刚建完就想改」变得很别扭：
 * 验失败要不要回滚？回滚掉用户刚粘的 Key 吗？这里选择**不回滚、不预验** ——
 * 与仓库里 modelscope / opencode / qiniu 那三条贴 Key 的路径保持同一纪律
 * （它们同样只在建号时校验形状）。
 */
function monkeycodePasteMethod(dshProvider, container, log) {
  const name = NAMES[dshProvider] ?? dshProvider
  const base = monkeycodeBaseUrl(dshProvider)
  return {
    type: 'oauth',
    label: `打开 ${name} 官网，粘贴 API Key 建号`,

    /**
     * 只做一件事：把官网地址交出去。
     *
     * 没有任何网络调用，所以不需要 `container.start()`，也不受 authorize()
     * 那 1 分钟硬超时影响（这里就是一次赋值）。
     */
    async authorize() {
      return {
        // ⚠️ 不写「OhMyAgent」之类子路径：那不是独立路由（实测一律回 200，是
        // SPA 的 catch-all 吐同一个壳）。给站根最稳 —— 用户登录完自然停在 console。
        url: base,
        instructions: `在打开的 ${name} 页面里登录。登录完成后，把这个账号的网页登录态粘到下面，`
          + '插件会自己换出网关 Key（不用你去找 Key）：'
          + '① 按 F12 打开开发者工具 → Application（应用）→ Cookies → 选中该站点，'
          + '找到 monkeycode_ai_session 那一行，双击它的 Value 复制；'
          + '② 或者从开发者工具的 Network 里任意一条请求把整条 Cookie 复制过来，也认。'
          + '手里已经有 oma_ 开头的 API Key 时，也可以直接粘 Key（可与 signing_secret 用空格隔开），'
          + '但只有 Key 读不到积分。',
        method: 'code',
        callback: (pasted) => monkeycodeFinishPaste({
          container, log, dshProvider, pasted: monkeycodeTextOf(pasted),
        }),
      }
    },
  }
}

/**
 * 收下用户粘回来的内容，落成一个 MonkeyCode 账号。
 *
 * ## 两种粘贴形态，一条路径
 *
 * 用户可能粘的是**网页登录态**（`monkeycode_ai_session=…`，或整条 Cookie 头），
 * 也可能已经自己拿到了**网关 Key**（`oma_…`，可带 `signing_secret`）。前者的
 * 处理更好，所以优先按 Cookie 认：
 *
 * ```
 *   粘的是 cookie  → POST /api/v1/users/api-keys 兑换出 oma_… + signing_secret
 *                    （`exchangeMonkeycodeSessionForKey`，body {}、Cookie 认证），
 *                    同时把 cookie 一起落进凭据 ⇒ 积分/额度/签到全都读得出来
 *   粘的是 Key     → 直接建号（能发消息，但查不到积分，面板「改 Key」可后补 cookie）
 * ```
 *
 * ## 为什么优先走 cookie 兑换，而不是让用户自己去抄 Key
 *
 * ① 用户手上通常只有登录态，没有 Key —— 「OhMyAgent」页要自己找，而 console
 *    里随手一开 F12 就有 cookie；
 * ② **只有 cookie 才读得到积分**：平台的 `/api/v1/users/*` 一律只认网页登录态，
 *    带 API Key 会 401（`monkeycode-credits.js` 模块头写得很清楚）。让用户抄
 *    Key 等于亲手把「面板显示不了积分」这个原始痛点留在了原地；
 * ③ 兑换是平台自己的接口，Key 由平台签发，用户不用理解 `signing_secret` 是什么。
 *
 * ⚠️ 兑换**每次签发新的一对**（上游无幂等键），只在建号时调一次 ——
 * 不要在续期里反复调，那会在用户账号下堆一长串 key。
 */
async function monkeycodeFinishPaste({ container, log, dshProvider, pasted }) {
  const raw = String(pasted ?? '').trim()
  if (raw === '') {
    throw new Error('没收到任何内容：请把网页登录态（monkeycode_ai_session 的值）或 API Key 粘到框里')
  }

  const product = await monkeycodeProductOf(dshProvider)
  // 先看是不是 Key：`oma_` / `sk-` 前缀很显眼，粘 Key 的人不会被当成 cookie。
  const byKey = monkeycodePastedPairOf(raw)
  let apiKey = byKey.apiKey
  let signingSecret = byKey.signingSecret
  let sessionCookie = ''

  if (apiKey === '' || !/^(oma_|sk-)/i.test(apiKey)) {
    // 当登录态处理。`normalizeSessionCookie` 认整条 Cookie 头，也认裸的 cookie 值
    // （缺名字时补 `monkeycode_ai_session=`）。
    const { normalizeSessionCookie } = await import('../vendor/lib/session-cookie.js')
    const { MONKEYCODE_SESSION_COOKIE_NAME } = await import('../vendor/lib/monkeycode-browser-login.js')
    const normalized = normalizeSessionCookie(raw, [MONKEYCODE_SESSION_COOKIE_NAME], MONKEYCODE_SESSION_COOKIE_NAME)
    if (normalized === undefined) {
      throw new Error(
        '这段内容既不像 API Key（oma_ 开头），也不像网页登录态。'
          + '请到站内按 F12 → Application → Cookies 复制 monkeycode_ai_session 的值，'
          + '或直接粘贴整条 Cookie。',
      )
    }
    const { exchangeMonkeycodeSessionForKey } = await import('../vendor/lib/monkeycode-credits.js')
    log?.(`[${dshProvider}] 收到网页登录态，正在向平台兑换网关 Key…`)
    const issued = await exchangeMonkeycodeSessionForKey(normalized, {}, product)
    if (issued.ok !== true) {
      // 兑换失败最常见的原因就是会话过期 —— 把平台原话带上，别自己编。
      throw new Error(
        `换取网关 Key 失败：${issued.error}。`
          + '如果是登录态过期，请在浏览器里重新登录后再复制一次 cookie。',
      )
    }
    apiKey = issued.key.apiKey
    signingSecret = issued.key.signingSecret
    sessionCookie = normalized
    log?.(`[${dshProvider}] 平台已签发网关 Key（尾 4 位 ${apiKey.slice(-4)}）`
      + (issued.key.keyId === undefined ? '' : `，记录 id ${issued.key.keyId}`))
  } else {
    log?.(`[${dshProvider}] 收到粘贴的 API Key（尾 4 位 ${apiKey.slice(-4)}）`
      + (signingSecret === '' ? '，没有 signing_secret' : '，含 signing_secret'))
  }

  // 昵称：优先问平台（登录态在手就能读），读不到再用粘贴里显式写的，
  // 都没有就交给本体自己的 `accountLabel()` 兜底。
  let nickname = nicknameOfPaste(raw)
  const { fetchMonkeycodeProfile } = await import('../vendor/lib/monkeycode-credits.js')
  const cookieForProfile = sessionCookie === '' ? undefined : sessionCookie
  if (cookieForProfile !== undefined) {
    const profile = await fetchMonkeycodeProfile(cookieForProfile, product, {}).catch(() => undefined)
    if (typeof profile?.nickname === 'string' && profile.nickname.trim() !== '') {
      nickname = profile.nickname.trim()
    }
  }

  // 建号是一次本地写盘，但容器可能还没起（冷启动 20–30 秒）——
  // 与 `KEY_ACCOUNT_RPC` 那条同预算（magpie 给 code 型 callback 2 分钟）。
  await withDeadline(container.start(), START_TIMEOUT_MS, '本体容器启动')
  const v = await withRpcDeadline(
    container,
    `${dshProvider}.addAccount`,
    {
      apiKey,
      ...(signingSecret === '' ? {} : { signingSecret }),
      ...(nickname === undefined ? {} : { nickname }),
      ...(sessionCookie === '' ? {} : { sessionCookie }),
    },
    CREATE_TIMEOUT_MS,
    `新建 ${dshProvider} 账号`,
  )
  const accountId = String(v?.accountId ?? '').trim()
  if (accountId === '') {
    throw new Error(`本体没有返回账号 id（${dshProvider}.addAccount 回：${JSON.stringify(v)}）`)
  }
  // 新建的号还没进 `account.list` 的 15 秒缓存，不然后面用量卡会拿旧列表。
  accountsCache.delete(dshProvider)

  // 建完拉一次目录：Key 刚生效时模型列表可能刚变。拉不到不影响建号。
  try {
    await withDeadline(
      (async () => {
        await liveAll(container, log)
        fullModels = await container.refreshFullCatalog(DSH_PROVIDERS)
        writeCache(log)
      })(),
      START_TIMEOUT_MS,
      '建号后刷新目录',
    )
  } catch { /* 目录拉不到不影响建号 */ }

  const hit = await accountById(container, dshProvider, accountId, log)
  const landed = await landedAccountOf(container, dshProvider, accountId, hit, log)
  const signedId = landed.id
  let wide = 0
  try {
    wide = Object.keys(modelsOfFull(dshProvider, fullModels)).length
  } catch { /* 缓存没读到就当 0 */ }

  return {
    type: 'success',
    key: `jet-hub-local:${dshProvider}/${signedId}`,
    accountId: `${accountLabel(landed.hit ?? { id: signedId })}·已新建`
      + (wide > 0 ? `·上游 ${wide} 个模型` : '')
      + (signingSecret === '' ? '·缺 signing_secret' : ''),
    uid: signedId,
    metadata: { via: 'jet-hub', provider: dshProvider, dshAccountId: signedId },
  }
}

/**
 * 归一化粘贴内容 —— 宿主给的一般是字符串，但契约没写死（Marvis 那条同理）。
 */
function monkeycodeTextOf(pasted) {
  if (typeof pasted === 'string') return pasted
  if (pasted === undefined || pasted === null) return ''
  if (typeof pasted === 'object') {
    // 宿主可能把粘贴框的值包成 `{ code }` / `{ value }`；也可能直接给整个 payload。
    for (const key of ['code', 'value', 'text', 'input', 'url', 'apiKey']) {
      const v = pasted[key]
      if (typeof v === 'string' && v.trim() !== '') return v
    }
    // 兜底：把对象里的字符串值拼起来（用户在 UI 里分两个框填时是这种形态）。
    const parts = [pasted.apiKey, pasted.signingSecret, pasted.signing_secret]
      .filter((x) => typeof x === 'string' && x.trim() !== '')
    return parts.join(' ')
  }
  return String(pasted)
}

/**
 * 从一段自由文本里认出 `{ apiKey, signingSecret }`。
 *
 * 逐 token 扫：带 `oma_` / `sk-` 前缀的当 Key，剩下的第一段「够长且不是标签词」
 * 当 secret。标签词（`apikey` / `signing_secret` 等）只是跳过，不参与判定 ——
 * 用户从网页复制时常把标签一起带进来。
 */
function monkeycodePastedPairOf(raw) {
  const tokens = String(raw)
    .split(/[\s,，、;；]+/u)
    .map((t) => t.replace(/^[\s"'`「」【】()（）<>]+|[\s"'`「」【】()（）<>]+$/gu, ''))
    .map((t) => t.replace(/[:：=]+$/u, ''))
    .filter((t) => t !== '')
  const labels = new Set([
    'api', 'key', 'apikey', 'api_key', 'signing', 'secret', 'signing_secret',
    'signingsecret', '密钥', '签名', '签名密钥', '令牌',
  ])
  const useful = tokens.filter((t) => !labels.has(t.toLowerCase()))
  // 按前缀认 Key：`oma_` 是官方形态，`sk-` 是本体错误文案里也提到的另一种。
  const keyed = useful.find((t) => /^(oma_|sk-)/i.test(t))
  if (keyed !== undefined) {
    const rest = useful.filter((t) => t !== keyed)
    return { apiKey: keyed, signingSecret: rest.find((t) => t.length >= 8) ?? '' }
  }
  // 没有带前缀的：只有一段时当 Key（让本体给出「形状不对」的原话，比我们猜更准）；
  // 有两段时按「先 Key 后 secret」的位置约定。
  if (useful.length === 1) return { apiKey: useful[0], signingSecret: '' }
  if (useful.length >= 2) {
    const [first, second] = useful
    return { apiKey: first, signingSecret: second.length >= 8 ? second : '' }
  }
  return { apiKey: '', signingSecret: '' }
}

/**
 * 从粘贴内容里猜一个昵称（可选）。
 *
 * 只认显式的 `nickname: xxx` / `昵称: xxx` —— 绝不拿 Key 的任何片段当昵称，
 * 卡上显示一串密钥字符既难看也泄露信息。猜不到就返回 undefined，
 * 由本体自己的 `accountLabel()` 兜底。
 */
function nicknameOfPaste(raw) {
  const m = /(?:nickname|昵称)\s*[:：=]\s*([^\s,，;；]{1,32})/iu.exec(String(raw ?? ''))
  return m === null ? undefined : m[1]
}

/**
 * 腾讯 Marvis 的新建方法：**一条 oauth 方法**，走宿主原生的「code 型」签入。
 *
 * ## 为什么是 `method: 'code'`，而不是自己用 `ask()` 收粘贴
 *
 * 宿主 `authorize()` 的返回值有一个字段 `method`（`Authorization.Method`，
 * `host.js` 里按 `a.method === "code"` 判定），取 `"code"` 时：
 *   · GUI 把 `url` 渲染成**一段带复制按钮的链接**（`signlink` + `copyBtn`），
 *   · 并给一个粘贴框（`pasteCode`），用户把地址粘进去 ⇒ 宿主回调
 *     `signin/<id>/callback` ⇒ `callback(code)`（**2 分钟**预算，比 authorize 的 60 秒宽）。
 *
 * 这正好对上 Marvis 的现实：`redirect_uri` 被腾讯固定在
 * `yybadaccess.3g.qq.com`（换域名微信侧直接拒绝），插件也不可能在用户自己的
 * 浏览器上起回调端口 ⇒ 「auto 型」（插件自己等回调）永远等不到。早先这里把
 * 地址写进 `ask()` 的题干当纯文本，用户看到的是一串不能一键复制的 URL ——
 * 2026-11-11 用户反馈「没有复制连接的按钮」。`mode: 'code'` 是错的字段名
 * （宿主不认，会当成 auto 型），必须写 `method`。
 *
 * ## guid / state 怎么传
 *
 * 宿主把 `authorize()` 返回的**整个对象**存在它的 `sessions` Map 里，之后
 * `callback` 就是在**这个对象**上调的 —— 所以 `callback` 直接用闭包捕获本次
 * 登录的 `plan`（guid / state），不需要模块级 Map：宿主重启时那次签入本来就
 * 已经没了，不存在「用户粘好的地址作废」这个场景。
 *
 * 用户粘回来的可能是整条地址、半截 query、或裸 code，`marvisCodeOf()` 三种都认
 * （那个页面不带 `Ual-Access-Guid` 头恒 `-109`，所以浏览器是真停在那儿的）。
 */
function marvisOauthMethod(dshProvider, container, log) {
  const name = NAMES[dshProvider] ?? dshProvider
  return {
    type: 'oauth',
    label: `扫码新建一个 ${name} 账号（QQ / 微信）`,
    /**
     * 只为让宿主把 `inputs` 递给 `authorize()` 而声明，真正的问题由下面的
     * `ask()` 出（宿主 `nextPrompt()` 先看 `ask`，有就直接返回，不会走到这里）。
     *
     * 宿主调 `authorize` 是这么写的：
     *   m.authorize(m.prompts?.length ? inputs ?? {} : undefined, { signal })
     * —— 只有声明了 `prompts` 的方法才拿得到 inputs。本方法问的是 `ask()`，
     * 早先没有 `prompts` ⇒ 宿主递 `undefined` ⇒ `authorize` 里
     * `inputs?.marvis_login_type === '2'` 恒假 ⇒ 面板上点「微信扫码」也落 QQ
     * （2026-11-11 真机报障：两个按钮都是 QQ 登录页）。
     */
    prompts: [{ type: 'select', key: 'marvis_login_type', message: '登录方式', options: [] }],
    async ask(inputs = {}) {
      // 唯一一问：登录方式。两条腿的凭据不通用（login_type 不同、续期端点不认
      // 另一边的 refresh），必须让用户当场挑 —— 这就是面板上的「选择登录方式」屏。
      // ⚠️ 答过就返回 null：宿主会拿 `inputs` 再问一轮，不返 null 就死循环。
      if (inputs?.marvis_login_type !== undefined) return null
      return {
        type: 'select',
        key: 'marvis_login_type',
        message: `用哪种方式登录 ${name}？`,
        options: [
          { value: '1', label: 'QQ 授权' },
          { value: '2', label: '微信扫码' },
        ],
      }
    },
    async authorize(inputs = {}) {
      const loginType = inputs?.marvis_login_type === '2' ? '2' : '1'
      const plan = marvisSignInPlan(loginType)
      log?.(`[marvis] 登录页已生成（${loginType === '2' ? '微信' : 'QQ'}）：${plan.url}`)
      return {
        url: plan.url,
        // 宿主对 code 型签入会先把它当正文显示，再把 url 渲染成带「复制链接」按钮的
        // 一行 —— 这里只写「下一步做什么」，别再重复贴一遍地址（那会重复显示）。
        instructions: `在浏览器里打开上面的链接，用${loginType === '2' ? '微信扫码' : ' QQ'}登录。`
          + '授权完成后浏览器会停在一个 JSON（或「抱歉，出错了」）页面，这是正常的 —— '
          + '把那时地址栏里的整条地址粘到下面（只粘授权码那串也行）。',
        method: 'code',
        callback: (pasted) => marvisFinishSignIn({
          container, log, plan, loginType, pasted: marvisTextOf(pasted),
        }),
      }
    },
  }
}

/**
 * 用用户粘回来的那段文本换凭据，并把账号落进本体。
 *
 * 抽出来只是为了 `authorize()` 保持「给页面」这一件事；兑换与建号的纪律都在这里。
 */
async function marvisFinishSignIn({ container, log, plan, loginType, pasted }) {
  const raw = String(pasted ?? '').trim()
  const code = marvisCodeOf(raw)
  if (code === '') {
    throw new Error('没在这段文本里找到授权码：请把登录后那个页面的整条地址栏粘过来')
  }
  // state 优先取地址里的回显值 —— 那正是 authorize 时发出去的那个（微信就是
  // guid）；用户只粘裸 code 时用本地生成的同款。
  const state = (() => {
    const echoed = /[?&#]state=([^&#\s]+)/.exec(raw)
    if (echoed === null) return plan.state
    try {
      return decodeURIComponent(echoed[1])
    } catch {
      return echoed[1]
    }
  })()
  // 容器可能还没起；兑换与建号实测都在秒级，但冷启动是 20–30 秒。
  // code 型签入的 callback 宿主给 2 分钟（`pluginCode` 的 ctx），比 authorize 宽。
  await withDeadline(container.start(), START_TIMEOUT_MS, '本体容器启动')
  const auth = container.ctx?.get('marvisAuth')
  if (auth === undefined || typeof auth.exchangeCode !== 'function') {
    throw new Error('本体没有可用的 Marvis 登录服务（容器没起来？），请重新点一次「新建账号」')
  }
  const credential = await withDeadline(
    auth.exchangeCode({ code, loginType, guid: plan.guid, state }),
    20_000,
    'Marvis 授权码兑换',
  )
  log?.(`[marvis] 授权码已兑换成凭据（${loginType === '2' ? '微信' : 'QQ'}，openid ${String(credential.openid).slice(0, 8)}…）`)

  /**
   * 补昵称（2026-11-11 真机报障）：本腿走的是 `mode: 'code'`，不是 vendor 的
   * `loginViaBrowser()` —— 后者在兑换之后还会做「资料接口 + openid 前 8 位」两级
   * 兜底（`marvis-auth.js:382-392`），而 `exchangeCode()` **只**带出回调 cookie 里的
   * `nickname`。cookie 没给时 `marvisAccountLabel(undefined,'1')` 退化成字面量
   * `"QQ"`（`marvis.js:269`）⇒ 面板上一排账号全叫「QQ」，无法区分。
   *
   * ⚠️ **必须在这里补，不能指望别处回填**：全仓 `pool.updateAccount({nickname})`
   *    只在建号 / 判重合并时写一次，续期（`refreshAccountCredential`）只更新
   *    `access_token` / `expiresAt` ⇒ 昵称在**建号那一刻**定型，之后永远是它。
   *
   * ⚠️ `fetchUserProfile` **失败返回空对象、绝不抛**（vendor 的纪律），但这里仍
   *    再包一层 `.catch(() => ({}))`：容器里拿到的 `marvisAuth` 是宿主注入的实例，
   *    不能假设它一定是 vendor 那个实现（缺方法时 `undefined is not a function`
   *    会挡掉整个登录）。昵称只是展示名，取不到不该挡登录。
   *
   * ⚠️ 兜底顺序与 vendor 同一条纪律：资料接口 → cookie → **openid 前 8 位**。
   *    最后那一级不能省 —— 它就是为「多个 QQ 账号无法区分」而写的。
   */
  const profile = typeof auth.fetchUserProfile === 'function'
    ? await auth.fetchUserProfile(credential).catch(() => ({}))
    : {}
  const nickname = (() => {
    if (typeof profile?.nickname === 'string' && profile.nickname.trim() !== '') return profile.nickname.trim()
    if (typeof credential.nickname === 'string' && credential.nickname.trim() !== '') return credential.nickname.trim()
    if (typeof credential.openid === 'string' && credential.openid !== '') return credential.openid.slice(0, 8)
    return undefined
  })()
  log?.(`[marvis] 昵称：${nickname === undefined ? '（上游未提供，卡片将显示平台名）' : nickname}`)

  // 形状必须与 `importCredentialFromMagpie()` 逐字对上：`access`/`refresh` 为非空
  // 字符串、`metadata.openid` + `metadata.guid` 必填、`loginType` 是 `'1'`/`'2'`、
  // `expires` 是**数字**（vendor 只认 number，字符串会被当成「没有有效期」丢掉）。
  const expires = Number(credential.expires_at)
  const payload = {
    access: credential.access_token,
    refresh: credential.refresh_token,
    metadata: {
      openid: credential.openid,
      guid: credential.guid ?? plan.guid,
      loginType: credential.login_type ?? loginType,
      ...(nickname === undefined ? {} : { nickname }),
    },
    ...(Number.isFinite(expires) ? { expires } : {}),
  }
  const created = await withRpcDeadline(
    container,
    'account.create',
    { provider: 'marvis', mode: 'magpie-import', magpieCredential: JSON.stringify(payload) },
    CREATE_TIMEOUT_MS,
    'account.create',
  )
  const accountId = String(created?.accountId ?? '').trim()
  if (accountId === '') throw new Error('本体没回账号 id（Marvis 凭据可能没被接受）')
  accountsCache.delete('marvis')

  const hit = await accountById(container, 'marvis', accountId, log)
  // 判重命中时会话可能被转写给老卡、新卡留成空壳 —— 与别的家同样签给存活的那条。
  const landed = await landedAccountOf(container, 'marvis', accountId, hit, log)
  const signedId = landed.id
  let wide = 0
  try {
    fullModels = await container.refreshFullCatalog(DSH_PROVIDERS)
    wide = Object.keys(modelsOfFull('marvis', fullModels)).length
    writeCache(log)
  } catch { /* 全量拉不到不影响签入 */ }

  return {
    type: 'success',
    // key 里编进账号 id：`dshAccountIdOf()` 靠它认回「这条 magpie 账号是哪个
    // DSH 账号」，宿主 `settle()` 的 secret 分支据此判重。
    key: `jet-hub-local:marvis/${signedId}`,
    accountId: `${accountLabel(landed.hit ?? { id: signedId })}·已新建`
      + (wide > 0 ? `·上游 ${wide} 个模型` : ''),
    uid: signedId,
    metadata: {
      via: 'jet-hub',
      provider: 'marvis',
      dshAccountId: signedId,
      // ⚠️ 宿主 `save()` 会把 ask() 收上来的 inputs 并进 metadata —— 这里只剩
      // 「选的是哪条腿」这一项，留着无妨；授权码根本不进 inputs（它在 callback
      // 的参数里），所以没有一次性凭据落盘的风险。
    },
  }
}

/**
 * 纯计算：一次 Marvis 登录的 guid / state / 授权页地址。
 * QQ 的 `state` 必须是小数字符串（上游同款）；微信直接拿 guid 当 state。
 */
function marvisSignInPlan(loginType) {
  const guid = newMarvisDeviceGuid()
  const state = loginType === '1' ? `0.${String(Math.random()).slice(2)}` : guid
  return { loginType, guid, state, url: authorizeUrlOf(loginType, guid, state) }
}

/**
 * 从用户粘回来的那段文本里抠出授权码。
 *
 * 宿主那条通道的文案是「请将页面显示的代码粘贴到下方」，但 Marvis 的授权页**停不下来**：
 * QQ / 微信把浏览器跳到 `yybadaccess.3g.qq.com/marvis_client_login/marvis_oauth?…&code=…`，
 * 那个地址没带 `Ual-Access-Guid` 头 ⇒ 恒 `-109 RC_PARAMS_INVALID`，页面上只有一段
 * JSON（或微信那句「抱歉，出错了」）。用户真正能复制的是**地址栏整条 URL**，
 * 所以这里两种都认：整条地址、半截 query、以及裸 code。
 */
/**
 * 归一化用户粘回来的内容：宿主给的一般是字符串，但契约上没有写死 ——
 * 对象形态按 url/code/text/value/input/callbackUrl 取第一个非空字符串。
 */
function marvisTextOf(pasted) {
  if (typeof pasted === 'string') return pasted
  if (pasted === undefined || pasted === null) return ''
  if (typeof pasted === 'object') {
    for (const key of ['url', 'code', 'text', 'value', 'input', 'callbackUrl']) {
      const v = pasted[key]
      if (typeof v === 'string' && v.trim() !== '') return v
    }
    return ''
  }
  return String(pasted)
}

function marvisCodeOf(pasted) {
  const text = marvisTextOf(pasted).trim()
  if (text === '') return ''
  // 整条地址或半截 query：`...?login_type=QC&code=XXXX&state=0.123`
  const m = /[?&#]code=([^&#\s]+)/.exec(text)
  if (m !== null) {
    try {
      return decodeURIComponent(m[1])
    } catch {
      return m[1]
    }
  }
  // 只粘了 code 本身（也可能带引号 —— 页面 JSON 里是 `"code":"…"`）
  const bare = text.replace(/^["']|["']$/g, '')
  if (/^[A-Za-z0-9._~+/=%-]{8,}$/.test(bare)) return bare
  return ''
}

/** 全部 29 个工厂（`index.mjs` 逐个具名导出）。 */
export const PLUGINS = DSH_PROVIDERS.map((p) => [idOf(p), makePlugin(p)])
