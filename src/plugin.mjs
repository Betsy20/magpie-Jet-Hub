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
 * N 个 provider id。本文件对本体里的 24 个 provider 各生成一个工厂。
 *
 * ## 架构
 *
 * ```
 * magpie 网关（默认 3425，可用 JET_HUB_USER_GATEWAY 覆盖）
 *   ├─ provider `jet-hub-codearts`   ┐
 *   ├─ provider `jet-hub-workbuddy`  │  N 个 provider，各自一个 id
 *   ├─ provider `jet-hub-qoder`      ├─ 全部共用同一个容器实例
 *   └─ …（24 个）                     ┘
 *        └─ auth.loader().fetch → JetHubContainer（内嵌 cordis + 本体 lib/index.js）
 *             └─ 直连本体 llm：ctx.llm.stream()（src/llm-bridge.mjs）
 *                  └─ 各 provider 的真实上游
 * ```
 *
 * ⚠️ **没有内嵌 HTTP 网关**：本体自己也开一个 OpenAI 兼容网关，但那层只是
 * `ctx.llm` 的 HTTP 外壳。插件在本进程里直接握着 `ctx.llm`，所以
 * `container.forward()` 在进程内就完成了整件事 —— 不占端口、不需要 apiKey。
 *
 * ⚠️ 容器**必须模块级共享**：24 个插件工厂各自 new 一个容器的话，会拉起 24 个
 * cordis（24 份账号池 + 24 份模型目录），冷启动直接炸。
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
  'accio',
  'astudio',
  'autoclaw',
  'autoclawintl',
  'buddy',
  'cline',
  'codearts',
  'codely',
  'gemini',
  'jet-hub-auto',
  'lobsterai',
  'loomy',
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
  aggregate: '聚合路由',
  accio: 'Accio（阿里）',
  astudio: 'AStudio（讯飞）',
  autoclaw: 'AutoClaw（智谱）',
  autoclawintl: 'AutoClaw 国际',
  buddy: 'Buddy',
  cline: 'Cline',
  codearts: 'CodeArts（华为云）',
  codely: 'Codely',
  gemini: 'Gemini',
  'jet-hub-auto': '自动选号',
  lobsterai: 'LobsterAI',
  loomy: 'Loomy',
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
 * magpie 供应商列表里的图标（契约 `_mp_host.js:1890` 的 `iconOf`）。
 * 只认 `https://` 或 `data:image/`，且不超过 1 MB。这里内联一个 SVG，
 * 免得依赖外部图床（离线也要能显示）。
 */
const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
  '<rect width="64" height="64" rx="14" fill="#5b5bd6"/>' +
  '<circle cx="32" cy="32" r="7" fill="#fff"/>' +
  '<g stroke="#fff" stroke-width="4" stroke-linecap="round" opacity=".85">' +
  '<path d="M32 10v9"/><path d="M32 45v9"/><path d="M10 32h9"/><path d="M45 32h9"/>' +
  '<path d="M17 17l6 6"/><path d="M41 41l6 6"/><path d="M47 17l-6 6"/><path d="M23 41l-6 6"/>' +
  '</g></svg>'
const ICON_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(ICON_SVG).toString('base64')}`

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
  'minimax/MiniMax-M2.7-highspeed': { name: 'MiniMax · M2.7 Highspeed' },
  'autoclawintl/zai_glm-5.3-flash': { name: 'AutoClaw 国际 · GLM-5.3 Flash' },
  'gemini/gemini-3.8-flash': { name: 'Gemini · 3.8 Flash' },
  'accio/glm-5-3-flash': { name: 'Accio · GLM-5.3 Flash' },
  'codely/codely-flash': { name: 'Codely · Flash' },
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

/** 模块级单例：24 个 provider 共用同一个容器。 */
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

function readCache() {
  try {
    const j = JSON.parse(readFileSync(cacheFile, 'utf8'))
    const out = {}
    if (Array.isArray(j?.models) && j.models.length > 0) out.live = j.models
    if (Array.isArray(j?.full) && j.full.length > 0) out.full = j.full
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
    // 路由组（aggregate / jet-hub-auto）本体里没有自己的账号池，`credits.balances`
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
  //    workbuddy-669bbcf6 一个坏，盲取第一条会把整张卡变成一句内部报错。
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
 * 把本体的余额读数翻译成 magpie 的 `auth.usage` 返回形状。
 */
function toMagpieUsage(reading, provider) {
  const plan = `${DISPLAY_NAME} · ${provider}`
  if (reading?.error) return { plan, error: humanizeUsageError(reading.error), windows: [] }

  const b = reading?.balance
  if (b === undefined || b === null) return { plan, windows: [] }

  // ⚠️ 过滤 total=0 的空套餐：本体照样会返回 `{total:0, remaining:0}` 的条目
  //    （astudio 的「会员积分」实测就是这样），画成卡片就是「0/0、可用 100%」，
  //    纯误导。有 remaining 没有 total 的（按量计费）保留。
  const packages = (Array.isArray(b.packages) ? b.packages : []).filter(
    (p) => (Number(p?.total) || 0) > 0 || (Number(p?.remaining) || 0) > 0,
  )
  const windows = packages.map((p) => {
    const total = Number(p?.total) || 0
    const remaining = Number(p?.remaining) || 0
    const used = Number(p?.used) || (total > 0 ? Math.max(0, total - remaining) : 0)
    const w = {
      name: String(p?.name ?? '积分'),
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
    const until = Number(p?.deductionEndTime)
    if (Number.isFinite(until) && until > 0) w.resetsAt = until
    // 过期/未生效的套餐不算「用完就停」，标 aside 让 magpie 别当主额度
    if (p?.active === false) w.aside = true
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
      return container.refreshFullCatalog(DSH_PROVIDERS)
    })
    .then((rows) => {
      if (Array.isArray(rows) && rows.length > 0) fullModels = rows
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
  }
  return { live: allModels, full: fullModels }
}

/** 允许长时间等待的路径（authorize / usage）用这个。 */
async function liveAll(container, log) {
  const list = await container.refreshModels()
  if (Array.isArray(list) && list.length > 0) {
    allModels = list.slice()
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
    out[bare] = modelEntry(row?.disabled === true ? `${base} · 已在 Jet Hub 关闭` : base, undefined)
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
        p.name = `${DISPLAY_NAME} · ${NAMES[dshProvider] ?? dshProvider}`
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
         * 一个 provider 一个账号槽：重复「连接」只复用同一个槽，
         * 不会在 magpie 里堆出 `<id>#a1b2c3` 这种重复账号。
         */
        single: true,

        /**
         * magpie 供应商编辑器里的开关（契约 `_mp_host.js:1833` 的 `optionsOf`）。
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
         * 用 SVG 内联成 data URI，免得依赖外部图床。
         */
        icon: ICON_DATA_URI,

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
              return {
                type: 'success',
                // magpie 的 api 型账号要存一个 key；直连模式下它只是个标记，
                // 发请求时不带它、也不校验它（进程内调用，没有 HTTP 边界）。
                key: `jet-hub-local:${dshProvider}:direct`,
                accountId: `DSH · ${dshProvider} · 上游 ${wide} 个模型（当前可用 ${n}）`,
                metadata: { via: 'jet-hub', provider: dshProvider },
              }
            },
          },
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
        async loader() {
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
              return container.forward('/chat/completions', { ...init, body: JSON.stringify(upstream) })
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
            const want = String(account?.uid ?? account?.metadata?.dshAccountId ?? '')
            const reading = await balanceOf(container, dshProvider, want, log)
            if (reading === undefined) {
              // 路由组 / 本体里没有账号的渠道：说清「这里没有可查的积分」，别编数字
              const { live, full } = currentAll(container, log)
              const wide = Object.keys(modelsOfFull(dshProvider, full)).length
              const n = Object.keys(modelsOf(dshProvider, live)).length
              return {
                plan: `${DISPLAY_NAME} · ${dshProvider}`,
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
            const want = String(account?.uid ?? account?.metadata?.dshAccountId ?? '')
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

/** 全部 24 个工厂（`index.mjs` 逐个具名导出）。 */
export const PLUGINS = DSH_PROVIDERS.map((p) => [idOf(p), makePlugin(p)])
