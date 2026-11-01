/**
 * `src/auth-sync.mjs` 的行为测试。
 *
 * 起因（2026-11-01 用户报障）：超级麦吉在 DSH 里只有 1 个账号，magpie 却显示 3 个
 * —— `plugin-auth.json` 里留着指向已删除账号的记录，还有早期 provider id 的残留。
 * 那个文件以前只由 `scripts/seed-auth.mjs` 手动同步，账号一删就永远歪着。
 * 现在插件启动后自动对齐，这个测试守住三件事：
 *
 * 1. 摊平规则（谁先谁后、key 长什么样、没账号时的占位）；
 * 2. 只动自己的键 —— 别的插件的记录一条都不能少；
 * 3. 幂等 —— 内容没变就不写盘（否则每次启动都刷一个备份文件）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { idOf } from '../src/plugin.mjs'
import {
  isOurKey,
  isRealUserConfig,
  legacyKeysOf,
  planAuthRecords,
  suffixOf,
  syncAuthQuietly,
  syncPluginAuth,
} from '../src/auth-sync.mjs'

let total = 0
let failed = 0
function ok(cond, msg) {
  total++
  if (cond) return
  failed++
  console.log(`  ✗ ${msg}`)
}

// 真渠道里挑三家：一家 3 个账号（含停用）、一家 1 个、一家 0 个
const providers = ['workbuddy', 'magicrew', 'codedearts-not-exist']
const accounts = [
  { provider: 'workbuddy', id: 'wb-1', nickname: 'betsy50', enabled: false },
  { provider: 'workbuddy', id: 'wb-2', nickname: 'betsy52', enabled: true },
  { provider: 'workbuddy', id: 'wb-3', nickname: 'betsy54' },
  { provider: 'magicrew', id: 'magicrew-262e40d5', nickname: 'Betsy' },
]

// ── 1. 摊平规则 ────────────────────────────────────────────────────────────
{
  const { next, report } = planAuthRecords(accounts, { providers, idOf })

  // 启用的排前面：`enabled:false` 的 wb-1 不能占第一行（第一行是 magpie 的默认账号）
  ok(next['jet-hub-workbuddy'].key === 'jet-hub-local:workbuddy/wb-2', '第一行是启用中的账号')
  ok(next['jet-hub-workbuddy'].accountId === 'betsy52', '第一行显示昵称')
  const tailKeys = Object.keys(next).filter((k) => k.includes('#'))
  ok(
    tailKeys.length === 2 && tailKeys.every((k) => /#[0-9a-z]{6}$/.test(k)),
    `后续键的后缀是 6 位 36 进制（实际 ${JSON.stringify(tailKeys)}）`,
  )

  const wbKeys = Object.keys(next).filter((k) => k.startsWith('jet-hub-workbuddy'))
  ok(wbKeys.length === 3, `3 个账号 → 3 条记录（实际 ${wbKeys.length}）`)
  ok(wbKeys[0] === 'jet-hub-workbuddy', '第一条用 provider 本身当键')
  ok(wbKeys.slice(1).every((k) => k.includes('#')), '后续记录带 # 后缀')
  ok(wbKeys[0] === `jet-hub-workbuddy` && next[wbKeys[0]].uid === 'wb-2', 'uid 是 DSH 账号 id')

  // 停用账号要标出来，否则用户不知道它为什么被排到最后
  const off = Object.values(next).find((v) => v.uid === 'wb-1')
  ok(off?.accountId === 'betsy50（已停用）', `停用账号要标注（实际 ${JSON.stringify(off?.accountId)}）`)
  ok(off?.metadata?.enabled === false, '停用账号的 metadata.enabled 是 false')

  // 没账号的渠道必须有占位记录，否则 magpie 报 `no plugin signs in to <id>`
  ok(next['jet-hub-codedearts-not-exist'] !== undefined, '无账号的渠道也要写占位')
  ok(
    String(next['jet-hub-codedearts-not-exist'].key) === 'jet-hub-local:codedearts-not-exist',
    '占位记录的 key 不带 /账号 id（挑它等于不钉号）',
  )
  ok(report.length === providers.length, '报告按 provider 逐条给')
}

// ── 2. suffix 稳定 ────────────────────────────────────────────────────────
{
  ok(suffixOf('magicrew-262e40d5') === suffixOf('magicrew-262e40d5'), '同一个 id 每次算出同一个后缀')
  ok(suffixOf('a') !== suffixOf('b'), '不同 id 后缀不同')
  ok(/^[0-9a-z]{6}$/.test(suffixOf('x')), '后缀是 6 位 36 进制')
}

// ── 3. legacy 判定：只认「我们写的那种 api 记录」 ─────────────────────────
//
// 2026-11-01 事故教训：早先按「键名归一化后等于某个 DSH provider 名」判，结果把
// **别的插件**的登录态整批删了（本机 `plugin-auth.json` 里同时装着
// `magpie-magicrew-auth` / `opencode-autoclaw-auth` / `opencode-codearts-auth`
// 等插件的 provider，id 与 DSH 的 provider 名一模一样）。现在只认内容特征：
// `{ type:'api', key:'jet-hub-local:…' }` 且键名不是 `jet-hub-*`。
{
  const all = {
    'jet-hub-workbuddy': { type: 'api', key: 'jet-hub-local:workbuddy/wb-2' },
    'jet-hub-workbuddy#a1b2c3': { type: 'api', key: 'jet-hub-local:workbuddy/wb-3' },
    // 本插件极早期直接拿 DSH provider 名当 magpie id 时写的 api 记录 ⇒ 该清
    'old-workbuddy': { type: 'api', key: 'jet-hub-local:workbuddy/GONE' },
    // 别人的 oauth 记录：一条都不能删
    workbuddy: { type: 'oauth', refresh: 'r', access: 'a' },
    'workbuddy#8tvrsa': { type: 'oauth', refresh: 'r' },
    'magicrew-intl': { type: 'oauth', refresh: 'r', jwt: 'j', org: 'o' },
    'magicrew-intl#ekw7xb': { type: 'oauth', refresh: 'r' },
    'autoclaw-cn': { type: 'oauth', refresh: 'r' },
    codearts: { type: 'oauth', refresh: 'r' },
    'providers-hub': { type: 'api', key: 'someone-else' },
    'wps-lingxi': { type: 'api', key: 'x' },
  }
  const legacy = legacyKeysOf(all).sort()
  ok(
    JSON.stringify(legacy) === JSON.stringify(['old-workbuddy']),
    `只清「我们写的 api 记录」（实际 ${JSON.stringify(legacy)}）`,
  )
  ok(!legacy.includes('workbuddy') && !legacy.includes('magicrew-intl'), '别人的 oauth 登录态绝不能删')
  ok(!legacy.includes('autoclaw-cn') && !legacy.includes('codearts'), '别人的同名 provider 记录也不能删')
  ok(!legacy.includes('jet-hub-workbuddy'), 'jet-hub-* 不算 legacy（由 isOurKey 替换）')
  ok(!legacy.includes('providers-hub') && !legacy.includes('wps-lingxi'), '别的插件的键永远不删')
  ok(isOurKey('jet-hub') && isOurKey('jet-hub-x#y') && !isOurKey('jet-hubby'), 'isOurKey 的边界')
}

// ── 4. 写盘：保留别人的、幂等、读不动就拒绝 ────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jetsync-'))
  const authPath = path.join(dir, 'plugin-auth.json')
  const foreign = { 'providers-hub': { type: 'api', key: 'x' }, 'wps-lingxi': { type: 'api', key: 'y' } }
  const stale = {
    ...foreign,
    'jet-hub-workbuddy': { type: 'api', key: 'jet-hub-local:workbuddy/GONE' },
    'jet-hub-workbuddy#zzzzzz': { type: 'api', key: 'jet-hub-local:workbuddy/ALSO-GONE' },
    // 别人家的 oauth 登录态：任何情况下都得留着
    'magicrew-intl': { type: 'oauth', refresh: 'r', access: 'a' },
    workbuddy: { type: 'oauth', refresh: 'r' },
  }
  fs.writeFileSync(authPath, JSON.stringify(stale, null, 2))

  const r1 = syncPluginAuth({ accounts, providers, idOf, authPath })
  ok(r1.wrote === true, '第一次要真写')
  ok(r1.backup !== undefined && fs.existsSync(r1.backup), '写之前先备份')
  const after1 = JSON.parse(fs.readFileSync(authPath, 'utf8'))
  ok(after1['providers-hub'] !== undefined && after1['wps-lingxi'] !== undefined, '别的插件记录必须留着')
  ok(after1.workbuddy !== undefined, '别人家的 oauth 记录必须留着（2026-11-01 误删过 18 条）')
  ok(after1['magicrew-intl'] !== undefined, 'magicrew-intl 是别的插件的，也要留着')
  ok(after1['jet-hub-workbuddy#zzzzzz'] === undefined, '指向已删账号的旧记录被替换掉')
  ok(after1['jet-hub-workbuddy']?.key === 'jet-hub-local:workbuddy/wb-2', '本插件记录重建正确')

  // 幂等：同样的输入不能再写一次（否则每次启动都多一个 .bak）
  const before = fs.readFileSync(authPath, 'utf8')
  const r2 = syncPluginAuth({ accounts, providers, idOf, authPath })
  ok(r2.changed === false && r2.wrote === false, `内容没变就不写盘（changed=${r2.changed} wrote=${r2.wrote}）`)
  ok(fs.readFileSync(authPath, 'utf8') === before, '文件一个字节都没动')

  // 账号被删掉：记录必须跟着消失（这正是用户报的那个 bug）
  const r3 = syncPluginAuth({
    accounts: accounts.filter((a) => a.provider !== 'magicrew'),
    providers,
    idOf,
    authPath,
  })
  ok(r3.wrote === true, '账号删掉后要重写')
  const after3 = JSON.parse(fs.readFileSync(authPath, 'utf8'))
  ok(after3['jet-hub-magicrew']?.key === 'jet-hub-local:magicrew', '账号没了要退回占位记录，不能留着旧 id')

  // 首次启动：文件根本不存在 —— 不能因为备份就 ENOENT（2026-11-01 一审必修 4）
  {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'jetsync-new-'))
    const p2 = path.join(dir2, 'plugin-auth.json')
    let threw = false
    try {
      const r = syncPluginAuth({ accounts, providers, idOf, authPath: p2 })
      ok(r.wrote === true, '文件不存在时也要能写出来')
      ok(r.backup === undefined, '文件不存在时不该产生备份')
      ok(JSON.parse(fs.readFileSync(p2, 'utf8'))['jet-hub-workbuddy'] !== undefined, '写出的内容正确')
    } catch {
      threw = true
    }
    ok(!threw, '文件不存在时不能抛 ENOENT')
    fs.rmSync(dir2, { recursive: true, force: true })
  }

  // 读不动时拒绝改写（否则会把别的插件的登录态整个覆盖掉）
  fs.writeFileSync(authPath, '{ 这不是 JSON')
  let threw = false
  try {
    syncPluginAuth({ accounts, providers, idOf, authPath })
  } catch {
    threw = true
  }
  ok(threw, '文件读不动时必须抛错，不能默默覆盖')
  ok(fs.readFileSync(authPath, 'utf8') === '{ 这不是 JSON', '拒绝改写后文件原样')

  fs.rmSync(dir, { recursive: true, force: true })
}

// ── 5. 闸门：测试态绝不写真实用户配置 ────────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jetsync-gate-'))
  const authPath = path.join(dir, 'plugin-auth.json')

  // `syncAuthQuietly` 认 `JET_HUB_NO_AUTH_SYNC=1`
  const saved = process.env.JET_HUB_NO_AUTH_SYNC
  process.env.JET_HUB_NO_AUTH_SYNC = '1'
  const r = await syncAuthQuietly({ accounts, providers, idOf, authPath })
  ok(r === null, '设了 JET_HUB_NO_AUTH_SYNC 时 syncAuthQuietly 直接返回 null')
  ok(!fs.existsSync(authPath), '设了闸门后一个字节都不写')
  if (saved === undefined) delete process.env.JET_HUB_NO_AUTH_SYNC
  else process.env.JET_HUB_NO_AUTH_SYNC = saved

  // `NODE_ENV=test` + 落在真实 `~/.config/magpie` 下 ⇒ 拒写（抛错）
  const realPath = path.join(os.homedir(), '.config', 'magpie', 'plugin-auth.json')
  ok(isRealUserConfig(realPath), '真实路径能被识别出来')
  ok(!isRealUserConfig(authPath), '临时路径不被误判成真实路径')
  const savedEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'test'
  let threw = false
  try {
    syncPluginAuth({ accounts, providers, idOf, authPath: realPath })
  } catch {
    threw = true
  }
  ok(threw, '测试态写真实路径必须抛错')
  process.env.NODE_ENV = savedEnv
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── 6. 某家读不到账号：保留它原有的行，不写占位 ──────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jetsync-skip-'))
  const authPath = path.join(dir, 'plugin-auth.json')
  const before = {
    'jet-hub-workbuddy': { type: 'api', key: 'jet-hub-local:workbuddy/wb-2' },
    'jet-hub-workbuddy#a': { type: 'api', key: 'jet-hub-local:workbuddy/wb-3' },
    'jet-hub-magicrew': { type: 'api', key: 'jet-hub-local:magicrew/magicrew-262e40d5' },
    // 这家没失败 ⇒ 它下面那条指向已删账号的旧键必须被清掉
    'jet-hub-zcode': { type: 'api', key: 'jet-hub-local:zcode/dead-account' },
    'jet-hub-zcode#zzzzzz': { type: 'api', key: 'jet-hub-local:zcode/gone-account' },
    // legacy 垃圾（键名是别人的、值是我们的 key）必须被清掉
    legacyJunk: { type: 'api', key: 'jet-hub-local:old/style' },
  }
  fs.writeFileSync(authPath, JSON.stringify(before, null, 2))
  // workbuddy 这次列账号失败（accounts 里没有它），但旧行必须留着
  const r = syncPluginAuth({
    accounts: accounts.filter((a) => a.provider !== 'workbuddy'),
    providers,
    idOf,
    authPath,
    failedProviders: ['workbuddy'],
  })
  const after = JSON.parse(fs.readFileSync(authPath, 'utf8'))
  ok(r.wrote === true, '其它家仍要同步（不能整轮放弃）')
  ok(
    after['jet-hub-workbuddy']?.key === 'jet-hub-local:workbuddy/wb-2',
    `读不到账号的那家要保留原行（实际 ${JSON.stringify(after['jet-hub-workbuddy']?.key)}）`,
  )
  ok(
    after['jet-hub-workbuddy']?.accountId !== '（本机 DSH 未登录该渠道）',
    '绝不能把它写成占位（一次瞬时失败就会抹掉 20 个账号）',
  )
  // 但保留只该对失败的那几家生效：别家该清的旧键、legacy 垃圾必须照常清掉。
  // 否则本机常年有 4 家零账号失败 ⇒ 本插件旧记录永远清不掉。
  // （fixture 里没有 zcode 账号，所以它名下那两条旧键应当被清掉，而不是被保留）
  ok(
    after['jet-hub-zcode'] === undefined && after['jet-hub-zcode#zzzzzz'] === undefined,
    `没失败的家该清掉的旧键要清掉（实际 ${JSON.stringify(Object.keys(after).filter((k) => k.startsWith('jet-hub-zcode')))})`,
  )
  ok(after.legacyJunk === undefined, 'legacy 垃圾照常清，不被失败家拖住')
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('')
if (failed === 0) {
  console.log(`✓ auth-sync 契约正确（${total} 项）`)
  process.exit(0)
}
console.log(`✗ ${failed}/${total} 项失败`)
process.exit(1)
