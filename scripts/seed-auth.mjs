/**
 * 把**本体账号池里的真实账号**逐个写进 magpie，做到「每个 provider 名下显示
 * 它自己的账号」。
 *
 * ## 为什么要它
 *
 * magpie 的账号就是 `plugin-auth.json` 里的键：`<provider>` 是第一个，
 * `<provider>#<随机>` 是后续的（见宿主 `accountsOf()`）。插件自己是
 * 「免输入签入」，但账号池在本体里（`~/.dsh/jet-hub/state.json`，实测 56 个
 * 账号、19 个 provider），magpie 看不到。所以这里把池子摊平写过去：
 *
 *   jet-hub-workbuddy            → user-a1b2
 *   jet-hub-workbuddy#a1b2c3     → user-e5f6
 *   jet-hub-codearts             → codearts-5e6f7a8b
 *   …
 *
 * ## 挑哪一行就真的走哪个账号（2026-10-29 起）
 *
 * 本体内部选号走 `getAvailableAccount(provider, modelId, excludeAccountIds)`
 * （vendor/lib/account-pool.js:2249），它按**池内数组顺序**取第一个可用账号。
 * 插件因此在请求作用域里钉号（`src/container.mjs` 的 `_pinAccounts` +
 * `AsyncLocalStorage`）：magpie 里点哪一行，那一行对应的 DSH 账号就会被顶成
 * 该次请求的唯一候选。所以这些行不再只是「看得见」—— 挑某一行**就是**换用
 * 哪个账号发请求。
 *
 * 占位行例外：本机没登录过的那几家（见下面 `ROUTE_GROUPS` 的说明）与 3 家未登录的
 * 渠道（autoclawintl / codely / gemini）没有对应账号，它们的 `key` 不带
 * `/id` 后缀、也没有 `uid`，挑它们等于不钉号（按池内顺序走）。
 *
 *   node scripts/seed-auth.mjs            # 写入（先备份）
 *   node scripts/seed-auth.mjs --dry-run  # 只报告会改什么
 *
 * 只动本插件自己的键（`jet-hub` / `jet-hub-*` 及它们的 `#` 分支），
 * 别的插件记录一律不碰。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DSH_PROVIDERS, idOf } from '../src/plugin.mjs'

const dry = process.argv.includes('--dry-run')
const authPath = path.join(os.homedir(), '.config', 'magpie', 'plugin-auth.json')
const statePath = process.argv.find((a) => a.endsWith('.json') && a !== authPath)
  ?? path.join(os.homedir(), '.dsh', 'jet-hub', 'state.json')

/** 本插件管辖的 magpie 键。 */
const isOurs = (k) => k === 'jet-hub' || k.startsWith('jet-hub-')

/** 稳定短后缀：同一个 DSH 账号每次跑都落到同一个 magpie 键。 */
function suffix(id) {
  let h = 0
  const s = String(id)
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h.toString(36).slice(0, 6).padStart(6, '0')
}

// ---- 读两边 ----------------------------------------------------------------

let all = {}
let raw = null
try {
  raw = fs.readFileSync(authPath, 'utf8')
  all = JSON.parse(raw)
  if (!all || typeof all !== 'object' || Array.isArray(all)) throw new Error('不是对象')
} catch (e) {
  if (raw !== null) {
    console.error(`plugin-auth.json 读不动（${e.message}）—— 拒绝改写`)
    process.exit(1)
  }
}

let pool = { accounts: [] }
try {
  pool = JSON.parse(fs.readFileSync(statePath, 'utf8'))
} catch (e) {
  console.error(`账号池读不动（${statePath}）：${e.message}`)
  console.error('  本体还没起过？先让 magpie 里这个插件跑一次再重试。')
  process.exit(1)
}
const accounts = Array.isArray(pool?.accounts) ? pool.accounts : []

const byProvider = new Map()
for (const a of accounts) {
  const p = String(a?.provider ?? '')
  if (!p) continue
  if (!byProvider.has(p)) byProvider.set(p, [])
  byProvider.get(p).push(a)
}

// ---- 组装新记录 -------------------------------------------------------------

const next = {}
const report = []
for (const dsh of DSH_PROVIDERS) {
  const magpieId = idOf(dsh)
  const mine = (byProvider.get(dsh) ?? [])
    .slice()
    .sort((a, b) => Number(b?.enabled !== false) - Number(a?.enabled !== false))

  if (mine.length === 0) {
    // 本体里没有这个渠道的账号：仍给一条占位记录，否则 magpie 会报
    // `no plugin signs in to <id>`，卡片点不动。
    //
    // ⚠️ 2026-10-31：路由组（`aggregate` / `jet-hub-auto`）已不再注册成 magpie
    // provider，所以这里只剩「真渠道但本机没登录」一种情况 —— 文案不再需要分支。
    const why = '（本机 DSH 未登录该渠道）'
    next[magpieId] = {
      type: 'api',
      key: `jet-hub-local:${dsh}`,
      accountId: why,
      metadata: { via: 'jet-hub', dshProvider: dsh },
    }
    report.push([magpieId, 0, why])
    continue
  }

  mine.forEach((a, i) => {
    const key = i === 0 ? magpieId : `${magpieId}#${suffix(a.id)}`
    const off = a.enabled === false ? '（已停用）' : ''
    next[key] = {
      type: 'api',
      key: `jet-hub-local:${dsh}/${a.id}`,
      accountId: `${a.nickname || a.id}${off}`,
      uid: String(a.id),
      metadata: { via: 'jet-hub', dshProvider: dsh, dshAccountId: a.id, enabled: a.enabled !== false },
    }
  })
  report.push([magpieId, mine.length, mine.map((a) => a.nickname || a.id).join(' / ')])
}

// ---- 差异 ------------------------------------------------------------------

const kept = Object.fromEntries(Object.entries(all).filter(([k]) => !isOurs(k)))
const removed = Object.keys(all).filter(isOurs)
const added = Object.keys(next)

console.log(`文件: ${authPath}`)
console.log(`账号池: ${statePath}（${accounts.length} 个账号 / ${byProvider.size} 个 provider）`)
console.log('')
console.log('按 provider 摊平（magpie 键 ← 本体账号）:')
for (const [id, n, names] of report) console.log(`  ${id.padEnd(22)} ${String(n).padStart(2)} 个  ${names}`)
console.log('')
console.log(`本插件旧键将被替换: ${removed.length}`)
console.log(`写入键: ${added.length}；其它插件记录保留: ${Object.keys(kept).length}`)

if (dry) {
  console.log('（--dry-run，未写盘）')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
const bak = `${authPath}.bak-lead-${stamp}`
fs.copyFileSync(authPath, bak)
console.log(`已备份: ${bak}`)

const merged = { ...kept, ...next }
const tmp = `${authPath}.tmp-${process.pid}`
fs.writeFileSync(tmp, JSON.stringify(merged, null, 2))
fs.renameSync(tmp, authPath)

const after = JSON.parse(fs.readFileSync(authPath, 'utf8'))
const missing = added.filter((k) => after[k] === undefined)
const lost = Object.keys(kept).filter((k) => after[k] === undefined)
console.log(
  missing.length === 0 && lost.length === 0
    ? `✓ 写回校验通过：${Object.keys(after).length} 条记录（本插件 ${added.length}）`
    : `✗ 缺: ${missing.join(',')} / 丢: ${lost.join(',')}`,
)
process.exit(missing.length === 0 && lost.length === 0 ? 0 : 1)
