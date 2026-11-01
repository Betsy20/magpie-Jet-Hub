#!/usr/bin/env node
/**
 * 手动把**本体账号池**摊平进 magpie 的 `plugin-auth.json`。
 *
 * ## 什么时候需要手动跑
 *
 * 插件启动后（容器预热完成时）会**自动对齐一次** —— 见 `src/auth-sync.mjs` 的
 * `syncAuthQuietly()`。所以这个脚本现在只剩两个用途：
 *
 * 1. 不重启 magpie 就想同步（比如刚在 DSH 里删了账号）；
 * 2. `--dry-run` 看一眼「会写成什么样」。
 *
 * ## 它在干什么
 *
 * magpie 的账号就是 `plugin-auth.json` 里的键：`<provider>` 是第一行，
 * `<provider>#<随机>` 是后续的（宿主 `accountsOf()`）。插件本身是「免输入签入」，
 * 但账号池在本体里（`~/.dsh/jet-hub/state.json`），magpie 看不到，所以要把池子
 * 摊平写过去：
 *
 *   jet-hub-workbuddy            → betsy52
 *   jet-hub-workbuddy#a1b2c3     → betsy50
 *   jet-hub-codearts             → codearts-5e6f7a8b
 *
 * ## 挑哪一行就真的走哪个账号
 *
 * 本体选号走 `getAvailableAccount(provider, modelId, excludeAccountIds)`
 * （`vendor/lib/account-pool.js`），按**池内数组顺序**取第一个可用账号。插件在
 * 请求作用域里钉号（`src/container.mjs` 的 `_pinAccounts` + `AsyncLocalStorage`）：
 * magpie 里点哪一行，那一行对应的 DSH 账号就会被顶成该次请求的唯一候选。
 *
 * 占位行例外：本机没登录过的那几家没有对应账号，它们的 `key` 不带 `/id` 后缀、
 * 也没有 `uid`，挑它们等于不钉号（按池内顺序走）。
 *
 *   node scripts/seed-auth.mjs            # 写入（内容没变就不写）
 *   node scripts/seed-auth.mjs --dry-run  # 只报告，不动盘
 *
 * 只动本插件自己的键（`jet-hub` / `jet-hub-*` 及 `#` 分支）与旧版 provider id
 * 的残留键，别的插件记录一律不碰。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DSH_PROVIDERS, idOf } from '../src/plugin.mjs'
import { defaultAuthPath, syncPluginAuth } from '../src/auth-sync.mjs'

const dry = process.argv.includes('--dry-run')
const authPath = defaultAuthPath()
const statePath = process.argv.find((a) => a.endsWith('.json') && a !== authPath)
  ?? path.join(os.homedir(), '.dsh', 'jet-hub', 'state.json')

let pool
try {
  pool = JSON.parse(fs.readFileSync(statePath, 'utf8'))
} catch (e) {
  console.error(`账号池读不动（${statePath}）：${e.message}`)
  console.error('  本体还没起过？先让 magpie 里这个插件跑一次再重试。')
  process.exit(1)
}
const accounts = Array.isArray(pool?.accounts) ? pool.accounts : []

const providers = new Set()
for (const a of accounts) {
  const p = String(a?.provider ?? '')
  if (p) providers.add(p)
}

console.log(`文件: ${authPath}`)
console.log(`账号池: ${statePath}（${accounts.length} 个账号 / ${providers.size} 个 provider）`)
console.log('')

let result
try {
  result = syncPluginAuth({ accounts, providers: DSH_PROVIDERS, idOf, authPath, dryRun: dry })
} catch (e) {
  console.error(`✗ ${e?.message ?? e}`)
  process.exit(1)
}

console.log('按 provider 摊平（magpie 键 ← 本体账号）:')
for (const [id, n, names] of result.report) {
  console.log(`  ${id.padEnd(22)} ${String(n).padStart(2)} 个  ${names}`)
}
console.log('')
console.log(`本插件旧键将被替换: ${result.removed.length}`)
if (result.removed.length > 0) {
  // 旧版 provider id（magicrew / workbuddy …）的残留记录：插件改名前留下的，
  // 现在没有任何 provider 卡片引用它们，删掉不影响任何东西。
  const legacy = result.removed.filter((k) => !k.startsWith('jet-hub'))
  if (legacy.length > 0) console.log(`  其中旧版 provider id 残留: ${legacy.join(', ')}`)
}
console.log(`写入键: ${result.keys} 条`)

if (dry) {
  console.log('（--dry-run，未写盘）')
  process.exit(0)
}
if (!result.changed) {
  console.log('✓ 已经是最新的，没有改动')
  process.exit(0)
}
console.log(`已备份: ${result.backup}`)
console.log(`✓ 写回校验通过：本插件 ${result.keys} 条`)
process.exit(0)
