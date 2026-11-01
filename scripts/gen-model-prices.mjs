/**
 * 生成 `src/model-prices.mjs`：把 models.dev 的目录价压成「模型名 → 单价」。
 *
 * 为什么需要它：magpie 的用量页要算费用，`priceOf()` 会依次试
 * ①用户手设的价格 ②`provider.ListPrice(model)` ③`MakerPrice(model)`。
 * 而 `pricedNames()` 只按**整串**模型名查目录（不剥 `provider/` 前缀），
 * 我们的模型 id 是 `workbuddy/deepseek-v4.1-flash` 这种带前缀的形状 ⇒ 全都查不到
 * ⇒ 用量页「费用」列一律是「—」（2026-11-01 用户报）。
 *
 * 插件的解法：在 `provider.models()` 返回的条目里带 `cost`（magpie 的
 * `pluginListPrice` → `pluginPrice` 会读它，单位 USD / 1M tokens，与目录价同口径）。
 *
 * ## 取价策略（2026-11-01 二审要求）
 *
 * 目录里同一个模型名往往有十几家在卖，价格差 2–10 倍（官方 vs 转售商）。第一版
 * 「按 JSON 键序先到先得」会把随便哪个转售商的价贴上来 —— 实测 `auto` 这个路由名
 * 只被一家叫 `morph` 的第三方收录，于是 loomy / qoder 的 `auto` 全被算成 morph 的价。
 * 现在的顺序是：
 *
 * 1. **路由名直接跳过**（`auto` / `standard` / `professional` …）——它们不是型号名，
 *    在目录里撞上的都是巧合，宁可没有价也不贴错价。
 * 2. **官方 integration 优先**：目录里是官方直营价就先用它（`google` 1.5/9 而不是
 *    某转售商的 0.1857/1.1142）。
 * 3. 官方不收录这个型号时，取该名字**所有来源的逐字段中位数**，并在
 *    `MODEL_PRICE_SRC` 里记成 `median(3)`，让「这条价是谁的」在 diff 里看得见。
 *
 * ## 可复现
 *
 * - 枚举顺序按 provider id 排序，输出按模型名排序 ⇒ 同输入同输出；
 * - 时间戳取**目录文件的 mtime**（不是 `new Date()`）⇒ 目录没变就不会产生假变更。
 *
 * ⚠️ 这是**参考价**，不是账单：这些渠道多数是订阅制（月费/额度），实际并不按
 * token 付费。用量页把它当「等效零售价」看，用来横向比较各家消耗量级即可。
 *
 * 跑法：`node scripts/gen-model-prices.mjs`
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * magpie 的 models.dev 缓存。
 *
 * 实测（2026-11-01，Windows）：它走的是 XDG 路径，即 `~/.cache/magpie/models.json`；
 * `%APPDATA%` / `%LOCALAPPDATA%` 两个候选是**兜底**（某些安装方式会落在那里）。
 */
const CACHE_CANDIDATES = [
  path.join(os.homedir(), '.cache', 'magpie', 'models.json'),
  path.join(process.env.APPDATA ?? '', 'magpie', 'models.json'),
  path.join(process.env.LOCALAPPDATA ?? '', 'magpie', 'models.json'),
]

function readCatalog() {
  for (const p of CACHE_CANDIDATES) {
    try {
      const raw = fs.readFileSync(p, 'utf8')
      return { path: p, data: JSON.parse(raw), mtime: fs.statSync(p).mtime }
    } catch { /* 换下一个 */ }
  }
  return null
}

/** 官方 integration 的 provider id。目录里以这些 id 出现的就是厂商直营价。 */
const OFFICIAL = new Set([
  'deepseek', 'openai', 'anthropic', 'google', 'zhipuai', 'zai', 'moonshotai',
  'minimax', 'minimax-cn', 'qwen', 'alibaba', 'xai', 'mistral', 'meta',
  'mistralai', 'cohere', 'perplexity', 'groq', 'x-ai',
])

/**
 * 不是型号名的「路由/档位名」。它们在目录里出现的同名条目属于别家产品的巧合，
 * 拿它给我们的同名路由定价就是编数字。
 */
const NOT_MODEL_NAMES = new Set([
  'auto', 'standard', 'professional', 'default', 'chat', 'fast', 'balanced',
  'thinking', 'reasoning', 'smart', 'lite', 'basic', 'plus', 'ultimate',
])

const cat = readCatalog()
if (cat === null) {
  console.error('✗ 找不到 magpie 的 models.dev 缓存（试过：' + CACHE_CANDIDATES.join(' / ') + '）')
  console.error('  这是 magpie 自己下载的目录；先跑一次 magpie（或让它刷新模型目录）再重试。')
  process.exit(1)
}
/**
 * 把绝对路径换成可跨机器复现的写法。
 *
 * 表头会进入 `src/model-prices.mjs`（要提交），写绝对路径会带来两个问题：
 * ① 换用户名或换机器重跑，表头就变、价格一条没变 ⇒ `git diff` 出现假变更；
 * ② 把主机用户名写进要发布的文件。
 * 所以三个候选目录各自换成它们的“环境变量名”，都对不上就宁可不写路径。
 */
function shownPath(p) {
  // 顺序有讲究：Windows 上 `%APPDATA%` = `C:\Users\<u>\AppData\Roaming`、
  // `%LOCALAPPDATA%` = `...\AppData\Local`，**本就落在 home 之下**。先判 home 的话，
  // 这两支永远走不到，表头会写成 `~\AppData\Roaming\magpie\models.json`（虽然也没用户名，
  // 但不如 `%APPDATA%` 直白）。
  for (const name of ['APPDATA', 'LOCALAPPDATA']) {
    const dir = process.env[name]
    if (dir && (p === dir || p.startsWith(dir + path.sep))) return '%' + name + '%' + p.slice(dir.length)
  }
  const HOME = os.homedir()
  if (p === HOME || p.startsWith(HOME + path.sep)) return '~' + p.slice(HOME.length)
  return '<magpie 的 models.dev 缓存>'
}
const catalogPath = shownPath(cat.path)
console.log('目录来源：' + catalogPath)

// ---- 1) 目录里「模型名 → 各来源报价」------------------------------------------
/**
 * @type {Map<string, Array<{provider: string, price: [number, number, number, number]}>>}
 */
const offers = new Map()
// 按 provider id 排序遍历：Map 的插入顺序会进分发逻辑，固定住才可复现。
for (const pid of Object.keys(cat.data).sort()) {
  const provider = cat.data[pid]
  for (const mid of Object.keys(provider?.models ?? {}).sort()) {
    const c = provider.models[mid]?.cost
    if (c === undefined || !(Number(c.input) > 0 || Number(c.output) > 0)) continue
    const list = offers.get(mid) ?? []
    list.push({
      provider: pid,
      price: [Number(c.input) || 0, Number(c.output) || 0, Number(c.cache_read) || 0, Number(c.cache_write) || 0],
    })
    offers.set(mid, list)
  }
}

const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y)
  const mid = a.length >> 1
  return a.length % 2 === 1 ? a[mid] : (a[mid - 1] + a[mid]) / 2
}

/**
 * 从一家或多家的报价里定出这条模型的价。
 * @returns {{price: [number,number,number,number], src: string} | null}
 */
function pickPrice(mid) {
  if (NOT_MODEL_NAMES.has(mid)) return null
  const list = offers.get(mid)
  if (list === undefined || list.length === 0) return null
  // 2) 官方直营优先
  const official = list.find((o) => OFFICIAL.has(o.provider))
  if (official !== undefined) return { price: official.price, src: 'official:' + official.provider }
  // 3) 官方没有 ⇒ 所有来源的逐字段中位数
  const cols = [0, 1, 2, 3].map((i) => median(list.map((o) => o.price[i])))
  const price = /** @type {[number,number,number,number]} */ (cols.map((n) => Math.round(n * 1e6) / 1e6))
  if (!(price[0] > 0 || price[1] > 0)) return null
  return { price, src: `median(${list.length})` }
}

// ---- 2) 我们快照里有哪些模型 ---------------------------------------------------
const snapPath = path.join(ROOT, 'page', 'models.js')
let snapIds = []
try {
  const snap = fs.readFileSync(snapPath, 'utf8')
  const fromDetail = [...snap.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1])
  const fromList = [...snap.matchAll(/"(jet-hub-[^"]*\/[^"]+)"/g)].map((m) => m[1])
  snapIds = fromDetail.length > 0 ? fromDetail : fromList
} catch {
  console.error('✗ 读不到 page/models.js（先跑 node scripts/snapshot-models.mjs）')
  process.exit(1)
}
const tails = [...new Set(snapIds.map((id) => String(id).split('/').slice(1).join('/')).filter(Boolean))].sort()
console.log(`快照里有 ${snapIds.length} 个模型 / ${tails.length} 个唯一尾名`)

// ---- 3) 匹配 -------------------------------------------------------------------
const out = {}
const src = {}
const missed = []
const skippedNames = []
for (const t of tails) {
  if (NOT_MODEL_NAMES.has(t)) { skippedNames.push(t); continue }
  const hit = pickPrice(t)
  if (hit === null) { missed.push(t); continue }
  out[t] = hit.price
  src[t] = hit.src
}

const officialCount = Object.values(src).filter((s) => s.startsWith('official:')).length
console.log(`匹配上 ${Object.keys(out).length} / ${tails.length}（官方直营价 ${officialCount} 条，其余取中位数）`)
if (skippedNames.length > 0) console.log(`跳过路由/档位名 ${skippedNames.length} 个：${skippedNames.join(', ')}`)
if (missed.length > 0) console.log(`查不到价格的 ${missed.length} 个（多半是渠道自造的型号名）：${missed.slice(0, 10).join(', ')}${missed.length > 10 ? ' …' : ''}`)

const keys = Object.keys(out).sort()
const priceLines = keys.map((k) => `  ${JSON.stringify(k)}: [${out[k].join(', ')}],`)
const srcLines = keys.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(src[k])},`)
const body = `/**
 * 模型目录价（USD / 1M tokens）—— **自动生成，别手改**。
 *
 * 生成：\`node scripts/gen-model-prices.mjs\`
 * 目录快照：${cat.mtime.toISOString()}（取的是 models.dev 缓存文件的 mtime，不是生成时刻）
 * 数据来源：magpie 缓存的 models.dev 目录（${catalogPath}）
 *
 * ## 为什么需要这张表
 *
 * magpie 用量页算费用时会调 \`provider.ListPrice(model)\`，而它内部的
 * \`pricedNames()\` 只按**整串**模型名查目录、不剥 \`provider/\` 前缀。本插件的
 * 模型 id 是 \`workbuddy/deepseek-v4.1-flash\` 这种形状 ⇒ 目录里查不到 ⇒
 * 费用列一律显示「—」。
 *
 * 插件在 \`provider.models()\` 的条目里带上 \`cost\`（magpie 的
 * \`pluginListPrice\` → \`pluginPrice\` 读的就是它）就能算了。
 *
 * ## ⚠️ 这是参考价，不是账单
 *
 * 这些渠道（CodeBuddy / TRAE / Qoder / MiniMax Code …）多数是**订阅制**
 * （月费或额度包），实际并不按 token 计费。用量页显示的钱是「按零售目录价折算
 * 的等效金额」，用来横向比较各家各模型的消耗量级，不是你会被扣的钱。
 *
 * ## 取价规则
 *
 * 模型 id 去掉 \`<渠道>/\` 后的**尾名**与目录里的模型名逐字相等才算匹配。同一个名字
 * 目录里常有多家在卖、价格能差 2–10 倍，所以：
 *
 * 1. \`auto\` / \`standard\` / \`professional\` 这类**路由名、档位名**一律跳过 ——
 *    它们在目录里撞上的同名条目属于别家产品，贴过来就是编数字；
 * 2. 目录里有**厂商直营**（official）报价就用它（多家都是直营时取 provider id 最小的
 *    那家，结果确定且可复现）；
 * 3. 官方没收录时取所有来源的**逐字段中位数**，来源记在 \`MODEL_PRICE_SRC\` 里；
 * 4. 都没有就不写进这张表，magpie 那边继续显示「—」。
 */
export const MODEL_PRICES = {
${priceLines.join('\n')}
}

/**
 * 每条价的来源，供人工核对（不参与运行时逻辑）：
 * \`official:<provider>\` = 厂商直营价；\`median(n)\` = n 家来源的逐字段中位数。
 */
export const MODEL_PRICE_SRC = {
${srcLines.join('\n')}
}
`
fs.writeFileSync(path.join(ROOT, 'src', 'model-prices.mjs'), body)
console.log(`✓ 写出 src/model-prices.mjs（${keys.length} 条，${(body.length / 1024).toFixed(1)} KB）`)
