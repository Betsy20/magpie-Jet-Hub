/**
 * 控制台「积分摊到账号卡片」的契约测试。
 *
 * 背景：2026-11-05 把「积分」标签并进账号页后，`loadBalances()` 负责把
 * `credits.balances` 的回包摊成 `accountId → 读数`。这个函数有两个**静默失败**的
 * 坑，都不会让任何断言变红 ——
 *
 *   1. **回包形状**：handler 返回 `{ ok: true, value: { accounts: [...] } }`，
 *      不是裸数组。按裸数组取，循环体 0 次执行，每张卡渲染成「—」，
 *      而 29 个测试全绿。
 *   2. **三个额度字段方向相反**：`expiringTotal` 是「`total` 中即将到期」
 *      （仍可用），`expiredTotal` 是「已失效」（不可用）。把后者当临期算，
 *      `长期 = total - expiredTotal` 会重复扣减。
 *
 * 所以这里专门盯这两点：**从真源码抽函数求值**（不复制粘贴），
 * 再用**真实回包形状**喂进去。跑法：`node tests/t-console-credits.mjs`
 * （不联网、不碰真实 ~/.dsh）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SRC = path.join(ROOT, 'console', 'console.js')
const RPC = path.join(ROOT, 'vendor', 'lib', 'jet-hub-rpc.js')

let bad = 0
// 断言条数自己数，不写死 —— 写死会随每次加断言漂
let total = 0
const ok = (cond, msg) => {
  total++
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) bad++
}

// 行尾归一化成 \n，否则 indexOf 的定位串一个都对不上
const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n')
const rpcSrc = fs.readFileSync(RPC, 'utf8').replace(/\r\n/g, '\n')

/* ── 1. 回包形状的真值源 ──────────────────────────────────────────────
 *
 * ⚠️ 这里**不能**自己写一份 `{ accounts: [...] }` 字面量当判据：那样测试和实现
 * 一起错就永远发现不了（2026-11-05 二审就是这样漏掉的 —— 实现改成了裸数组，
 * 而 mock 也返回裸数组，截图看着全对）。判据必须从 handler 源码里取。
 */

console.log('--- 1) credits.balances 的回包形状 ---')
{
  // handler 里那两行：`const value = usesWindow ? {...} : {...}` 然后 `return { ok: true, value }`
  const iValue = rpcSrc.indexOf('const value = usesWindow')
  ok(iValue > 0, '找到 credits.balances handler 里的 `const value = usesWindow`')
  const tail = rpcSrc.slice(iValue, iValue + 400)
  ok(
    /\{\s*accounts:\s*values\s*\}/.test(tail),
    'value 是 `{ accounts: values }` 对象（不是裸的 values）',
  )
  ok(
    /windowDays:\s*buddyExpiringWindowDays\(\)/.test(tail),
    '带窗口的渠道额外带 windowDays（说明 value 是对象而不是数组）',
  )
  const iReturn = rpcSrc.indexOf('return { ok: true, value }', iValue)
  ok(iReturn > 0, 'handler 返回 `{ ok: true, value }`')

  // 消费端必须按 .accounts 取。两个独立消费者都这么写，可交叉对照。
  const pluginSrc = fs.readFileSync(path.join(ROOT, 'src', 'plugin.mjs'), 'utf8')
  ok(
    /Array\.isArray\(v\?\.accounts\)\s*\?\s*v\.accounts\s*:\s*\[\]/.test(pluginSrc),
    'src/plugin.mjs 按 `.accounts` 取（对照实现）',
  )
  ok(
    /Array\.isArray\(v\?\.accounts\)\s*\?\s*v\.accounts\s*:\s*\[\]/.test(src),
    'console/console.js 的 loadBalances 也按 `.accounts` 取',
  )
}

/* ── 2. 抽出真实的 loadBalances 求值 ──────────────────────────────── */

function sliceFn(prefix) {
  const start = src.indexOf(prefix)
  if (start < 0) throw new Error(`截不到源码片段：找不到 ${JSON.stringify(prefix)}`)
  const end = src.indexOf('\n}\n', start)
  if (end < 0) throw new Error(`截不到源码片段的结尾：${JSON.stringify(prefix)}`)
  return src.slice(start, end + 3)
}

const loadBalancesSrc = sliceFn('async function loadBalances(')

// `BAL` 是模块级 `let`，`rpc` 是模块级 `function` —— 用同名局部变量顶替，
// 让抽出来的源码原样跑（不改一个字符）。
function makeHarness() {
  let BAL = new Map()
  let rpc = async () => {
    throw new Error('测试没设置 rpc 桩')
  }
  const factory = new Function(
    'BAL_INIT',
    `
    let BAL = BAL_INIT
    let rpc
    ${loadBalancesSrc}
    // ⚠️ loadBalances 现在**返回**新 Map 而不是直接写全局 BAL
    //    （修 P1-A：旧实现先清空 BAL 再 await，切渠道时旧回包会覆盖新渠道）。
    //    抽出来的源码一个字符没改，只在外面补上「调用方把返回值写回」这一步。
    const load = async (...args) => { BAL = await loadBalances(...args); return BAL }
    return {
      loadBalances: load,
      getBAL: () => BAL,
      setRpc: (fn) => { rpc = fn },
    }
    `,
  )
  return factory(new Map())
}

/* ── 3. 行为：真实形状能摊开，裸数组摊不开 ─────────────────────────── */

console.log('--- 3) 真实回包形状 ---')
{
  const h = makeHarness()
  h.setRpc(async () => ({
    accounts: [
      {
        accountId: 'acc_01',
        balance: { total: 5100, expiringTotal: 1400, expiredTotal: 200 },
      },
      // 「临期」口径没下发（CodeBuddy / AStudio / MiniMax 等都这样）
      { accountId: 'acc_02', balance: { total: 800, expiredTotal: 0 } },
      // 单账号查不到：balance 为 null 且带 error
      { accountId: 'acc_03', balance: null, error: '登录态失效，请重新登录' },
      // 兼顶旧读数：**balance 有值 + error 也有值**（jet-hub-rpc.js:905-925）
      {
        accountId: 'acc_04',
        balance: { total: 4200, expiringTotal: 300 },
        error: '本次查询失败，显示的是 2026-11-05 13:04:20 的数据（上游不可达）',
      },
    ],
  }))
  await h.loadBalances('buddy')
  const bal = h.getBAL()
  ok(bal.size === 4, `四张账号都摊开了（实际 ${bal.size} 条）`)
  ok(
    ['acc_01', 'acc_02', 'acc_03', 'acc_04'].every((k) => bal.has(k)),
    'accountId 作键',
  )

  const a1 = bal.get('acc_01')
  ok(a1.total === 5100, `acc_01 合计 5100（实际 ${a1.total}）`)
  ok(a1.temp === 1400, `acc_01 临期 1400（实际 ${a1.temp}）`)
  ok(a1.long === 3700, `acc_01 其余 = 5100 - 1400 = 3700（实际 ${a1.long}）`)
  ok(a1.expired === 200, `acc_01 已失效 200（实际 ${a1.expired}）`)
  ok(a1.error === null && a1.stale === null, 'acc_01 是正常读数，error / stale 都为 null')

  const a2 = bal.get('acc_02')
  ok(a2.temp === null, 'acc_02 没下发 expiringTotal ⇒ 临期是 null 而不是 0（「不知道」≠「确认没有」）')
  ok(a2.long === null, 'acc_02 其余也是 null（没有临期口径就谈不上「其余部分」）')

  const a3 = bal.get('acc_03')
  ok(typeof a3.error === 'string' && a3.error.length > 0, 'acc_03 落 error 分支（单账号失败不连坐）')
  ok(a3.stale === null, 'acc_03 是「查不到」，不是「旧数据」（两者别混）')

  // ⚠️ 最关键的一条：有 balance + 有 error 的兼顶行，error 不能丢
  const a4 = bal.get('acc_04')
  ok(a4.total === 4200, `acc_04 读数照常摊开（实际 ${a4.total}）`)
  ok(a4.error === null, 'acc_04 不算「查不到」（它有读数）')
  ok(
    typeof a4.stale === 'string' && /查询失败/.test(a4.stale),
    'acc_04 带 stale 说明 —— 否则用户看到过期积分却以为是最新的',
  )
  ok(
    bal.get('acc_01').stale === null && a4.stale !== null,
    'stale 只落在兼顶行上，正常行不受影响',
  )
}

console.log('--- 4) 回归：裸数组形状必须摊不开（记录这个坑为什么致命）---')
{
  const h = makeHarness()
  // 故意喂**错的**形状：如果实现退回 `Array.isArray(v) ? v : []`，这里就会摊出 3 条
  h.setRpc(async () => [
    { accountId: 'acc_01', balance: { total: 5100 } },
    { accountId: 'acc_02', balance: { total: 800 } },
    { accountId: 'acc_03', balance: { total: 0 } },
  ])
  await h.loadBalances('buddy')
  ok(
    h.getBAL().size === 0,
    '裸数组喂进去摊出 0 条 —— 实现一旦退回裸数组判断，本轮截图会全对、测试会全绿，但线上每张卡都是「—」',
  )
}

console.log('--- 5) prefetched：同一个回包不要发两次 RPC ---')
{
  // 「查余额」按钮先自己发一次 `credits.balances` 渲染结果表，再拿同一份回包
  // 刷卡片 —— 别为了刷卡片再发一次（省往返，也避免两次结果不一致）。
  const h = makeHarness()
  let calls = 0
  h.setRpc(async () => {
    calls += 1
    return { accounts: [{ accountId: 'acc_01', balance: { total: 5100, expiringTotal: 1400 } }] }
  })
  const prefetched = { accounts: [{ accountId: 'acc_09', balance: { total: 42 } }] }
  await h.loadBalances('buddy', prefetched)
  ok(calls === 0, `传了 prefetched 就不再发 RPC（实际发了 ${calls} 次）`)
  ok(h.getBAL().size === 1 && h.getBAL().get('acc_09')?.total === 42, '用的是 prefetched 那份回包')
}

console.log('--- 6) 异常降级 ---')
{
  // `unsupported provider` 是「这家没得查」，不该打 warn 也不该抛
  const h = makeHarness()
  h.setRpc(async () => {
    throw new Error('unsupported provider: accio')
  })
  let threw = null
  const warns = []
  const origWarn = console.warn
  console.warn = (...a) => warns.push(a.join(' '))
  try {
    await h.loadBalances('accio')
  } catch (e) {
    threw = e
  } finally {
    console.warn = origWarn
  }
  ok(threw === null, 'unsupported provider 不抛（否则整张账号列表渲染不出来）')
  ok(warns.length === 0, `unsupported provider 静默，不打 warn（实际 ${warns.length} 条）`)
  ok(h.getBAL().size === 0, '降级后 BAL 是空 Map（渲染成「—」）')

  // 其它错误：打 warn 但不抛
  const h2 = makeHarness()
  h2.setRpc(async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:443')
  })
  const warns2 = []
  console.warn = (...a) => warns2.push(a.join(' '))
  let threw2 = null
  try {
    await h2.loadBalances('buddy')
  } catch (e) {
    threw2 = e
  } finally {
    console.warn = origWarn
  }
  ok(threw2 === null, '网络错误也不抛')
  ok(warns2.length === 1, `网络错误打一条 warn（实际 ${warns2.length} 条）`)
}

console.log("--- 7) 每次调用重置（换渠道不能沿用上一家的读数）---")
{
  const h = makeHarness()
  h.setRpc(async () => ({ accounts: [{ accountId: 'a', balance: { total: 1 } }] }))
  await h.loadBalances('buddy')
  ok(h.getBAL().size === 1, '第一次摊出 1 条')
  h.setRpc(async () => ({ accounts: [] }))
  await h.loadBalances('qoder')
  ok(h.getBAL().size === 0, '换渠道后 BAL 清空（不残留上一家的账号）')
}

console.log(`\n${bad === 0 ? '✓ 全部通过' : `✗ ${bad} 项失败`}（${total} 项）`)
if (bad > 0) process.exit(1)
