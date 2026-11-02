#!/usr/bin/env node
/**
 * 超级麦吉两站的「多 mode 新建」回归测试。
 *
 * 为什么单列一个文件：`startNewAccountSmart()` 是唯一按 provider 分支决定
 * 「试几条腿」的地方。上游 `magicrewintl` 与 `magicrew` 在
 * `vendor/lib/jet-hub-rpc.js` 里共用同一个 `magicrewSite` 分支（`provider ===
 * 'magicrew' || provider === magicrewIntlId`），所以插件侧也必须两家都走
 * `MAGICREW_CREATE_MODES`。
 *
 * 2026-11-02 三审指出：这条判断原本**没有任何回归测试** —— 把
 * `provider !== 'magicrew' && provider !== 'magicrewintl'` 改回
 * `provider !== 'magicrew'`，全套测试仍然全绿，等于国际版点了新建必失败却无人发现。
 *
 * 做法：从 `src/plugin.mjs` 截出 `startNewAccountSmart` 的源码段，用
 * `new Function` 注入假的 `startNewAccount` / `MAGICREW_CREATE_MODES` 求值，
 * 只测「调了谁、按什么顺序、抛哪个错」，不碰容器。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src', 'plugin.mjs')

let total = 0
let failed = 0
function ok(cond, name) {
  total++
  if (cond) return
  failed++
  console.log(`  ✗ ${name}`)
}

// ⚠️ 仓库是 CRLF，截取前统一成 LF，否则 indexOf 全都为 -1。
const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n')

/* ── 1. 截出 startNewAccountSmart 原样求值 ── */

const FROM = '/**\n * 起一个登录流程，按 provider 决定要不要按顺序试多种 `mode`。'
const TO = '\n/**\n * 摸一次登录进度。'
const i = src.indexOf(FROM)
const j = src.indexOf(TO)
if (i < 0 || j < 0 || j <= i) {
  console.error('✗ 截不出 startNewAccountSmart：', { i, j })
  process.exit(1)
}
let body = src.slice(i, j)
// 段内若带 `export`，`new Function` 会 SyntaxError。
body = body.replace(/^export\s+(?:async\s+)?function\s+/gm, 'async function ')
if (/^\s*export\s/m.test(body)) {
  console.error('✗ 截出的段里还有 export，new Function 会报 SyntaxError')
  process.exit(1)
}

const factory = new Function(
  'startNewAccount',
  'MAGICREW_CREATE_MODES',
  `${body}\nreturn startNewAccountSmart`,
)
const smart = factory

/* ── 2. 假容器：记录每次调用的 (provider, mode)，按脚本抛错 ── */

function harness(script) {
  const calls = []
  const logs = []
  const startNewAccount = async (container, provider, log, mode) => {
    calls.push({ provider, mode })
    const step = script[calls.length - 1]
    if (step instanceof Error) throw step
    return step
  }
  return { calls, logs, startNewAccount }
}

const MODES = ['local-browser', 'browser']

/* ── 3. 断言 ── */

// 3a. 国内站：第一条腿成功 ⇒ 只调一次，mode 是 local-browser
{
  const h = harness([{ accountId: 'a', loginUrl: '' }])
  const smartFn = smart(h.startNewAccount, MODES)
  const got = await smartFn({}, 'magicrew', () => {})
  ok(h.calls.length === 1, `magicrew 第一条腿成功时只调一次（实际 ${h.calls.length}）`)
  ok(h.calls[0]?.mode === 'local-browser', `magicrew 首个 mode 是 local-browser（实际 ${h.calls[0]?.mode}）`)
  ok(got?.accountId === 'a', 'magicrew 返回第一条腿的结果')
}

// 3b. ✅ 核心：国际站必须也走多 mode —— 这条就是防「只认 magicrew」的回归
{
  const h = harness([new Error('本机浏览器里没有登录态'), { accountId: 'b', incognitoOpened: true }])
  const smartFn = smart(h.startNewAccount, MODES)
  // 变异「provider !== 'magicrew'」时这里会直接抛错 —— 必须兜住，否则测试崩栈而不是记一条红。
  let got
  try {
    got = await smartFn({}, 'magicrewintl', () => {})
  } catch (e) {
    ok(false, `magicrewintl 不应在第一条腿失败时就抛错（实际抛：${String(e?.message ?? e)}）`)
  }
  ok(
    h.calls.length === 2,
    `magicrewintl 第一条腿失败后必须退第二条腿（实际调了 ${h.calls.length} 次；若为 1 次说明 provider 判断漏了 magicrewintl）`,
  )
  ok(h.calls[1]?.mode === 'browser', `magicrewintl 第二条腿的 mode 是 browser（实际 ${h.calls[1]?.mode}）`)
  ok(got?.accountId === 'b', 'magicrewintl 返回第二条腿的结果')
}

// 3c. 国际站两条腿都失败 ⇒ 抛**第二条腿**的错误（用户真正会撞上的那条）
{
  const first = new Error('本机浏览器里没有登录态')
  const second = new Error('窗口起不来')
  const h = harness([first, second])
  const smartFn = smart(h.startNewAccount, MODES)
  let err
  try {
    await smartFn({}, 'magicrewintl', () => {})
  } catch (e) {
    err = e
  }
  ok(err === second, `magicrewintl 两条腿都挂时报第二条腿的错误（实际 ${err?.message}）`)
  ok(h.calls.length === 2, `magicrewintl 两条腿都试过（实际 ${h.calls.length} 次）`)
}

// 3d. 别家（workbuddy）：只调一次、不带 mode
{
  const h = harness([{ accountId: 'c', loginUrl: 'https://x' }])
  const smartFn = smart(h.startNewAccount, MODES)
  await smartFn({}, 'workbuddy', () => {})
  ok(h.calls.length === 1, `workbuddy 只调一次（实际 ${h.calls.length}）`)
  ok(h.calls[0]?.mode === undefined, `workbuddy 的 mode 是 undefined（实际 ${String(h.calls[0]?.mode)}）`)
}

// 3e. 别家失败：不重试、直接抛
{
  const boom = new Error('boom')
  const h = harness([boom])
  const smartFn = smart(h.startNewAccount, MODES)
  let err
  try {
    await smartFn({}, 'qiniu', () => {})
  } catch (e) {
    err = e
  }
  ok(err === boom, 'qiniu 失败时原样抛出，不退第二条腿')
  ok(h.calls.length === 1, `qiniu 只调一次（实际 ${h.calls.length}）`)
}

// 3f. mode 顺序 = MAGICREW_CREATE_MODES 的顺序（不是写死的）
{
  const h = harness([new Error('a'), new Error('b')])
  const smartFn = smart(h.startNewAccount, ['browser', 'local-browser'])
  try {
    await smartFn({}, 'magicrew', () => {})
  } catch {
    /* 两条腿都挂，只看调用顺序 */
  }
  ok(
    h.calls.map((c) => c.mode).join(',') === 'browser,local-browser',
    `mode 顺序跟随 MAGICREW_CREATE_MODES（实际 ${h.calls.map((c) => c.mode).join(',')}）`,
  )
}

// 3g. MAGICREW_CREATE_MODES 为空数组时不能 throw undefined
{
  const h = harness([])
  const smartFn = smart(h.startNewAccount, [])
  let err
  try {
    await smartFn({}, 'magicrew', () => {})
  } catch (e) {
    err = e
  }
  ok(err instanceof Error, `空 mode 表时抛的是 Error 而不是 undefined（实际 ${String(err)}）`)
  ok(h.calls.length === 0, `空 mode 表时一次都不调（实际 ${h.calls.length}）`)
}

/* ── 4. 静态锚点：源码里确实写了两家 ── */

ok(
  /provider !== 'magicrew' && provider !== 'magicrewintl'/.test(src),
  '源码里 startNewAccountSmart 的 provider 判断同时含 magicrew 与 magicrewintl',
)

console.log(
  failed === 0
    ? `✓ 全部通过（${total} 项：超级麦吉两站多 mode 新建 —— 顺序/退腿/报错/空表兜底）`
    : `✗ ${failed}/${total} 项失败`,
)
process.exit(failed === 0 ? 0 : 1)
