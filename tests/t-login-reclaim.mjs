/**
 * 控制台「放弃授权 → 回收占位账号」这条路的回归测试。
 *
 * 两个都是 2026-10-29 二审抓出来的真实缺陷，且都是**我自己刚引入的**：
 *
 * 1. 900ms 收尾定时器无条件 `closeLogin()`。HEAD 版无害，但加上占位回收之后
 *    就致命：这 900ms 里用户完全可能又点了一次「添加账号」，那时
 *    `loginAccountId` / `loginTimer` 已经是下一次的了 —— 定时器一响就把新弹窗
 *    关掉、把新轮询 clearInterval 掉、还把新登录的占位账号当「放弃授权」删掉。
 *    实测现象是「新弹窗闪一下就没了」。
 *
 * 2. `isPlaceholder` 的四字段判据挡不住 `finishLogin` 的两步窗口。本体先
 *    `persistLogin` 落凭据、之后才 `fillAccountEntry` 回填池条目（回填失败只
 *    warn 不抛），而 `login.poll` 的成功判据是「凭据能 resolve」——所以在
 *    「凭据已写、池条目未回填」那段时间里四字段会判成占位并删号，随后本体才
 *    把凭据写进来，终态「池里没账号 + 凭据库一条孤儿凭据」，不可逆。
 *    修法是删之前再问一次 `login.poll`。
 *
 * 跑法：`magpie-bun tests/t-login-reclaim.mjs`（不联网、不碰真实 ~/.dsh）
 *
 * 判据直接取自 `console/console.js` 源码文本（`new Function` 求值），不是
 * 复制粘贴 —— 源码改了这里就跟着改，不会出现「测试绿但代码早变了」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SRC = path.join(ROOT, 'console', 'console.js')

let bad = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) bad++
}

const src = fs.readFileSync(SRC, 'utf8')

/* ── 1. 从源码里截出 isPlaceholder + reclaimPlaceholder 原样求值 ── */

const START = 'const PLACEHOLDER_MAX_AGE_MS'
const END = '\nfunction closeLogin() {'
const from = src.indexOf(START)
const to = src.indexOf(END)
if (from < 0 || to < 0) {
  console.error('✗ 从 console/console.js 截不到占位回收那一段（函数被改名或挪位置了？）')
  process.exit(1)
}
const BODY = src.slice(from, to)

const NOW = Date.now()

/** 造一个假 rpc + 假 loadAccounts，把截出来的函数跑起来。 */
function harness({ accounts, poll, listThrows = false, pollThrows = false }) {
  const calls = { deleted: [], polls: 0, loads: 0 }
  const rpc = async (method, arg) => {
    if (method === 'account.list') {
      if (listThrows) throw new Error('account.list 炸了')
      return { accounts }
    }
    if (method === 'login.poll') {
      calls.polls++
      if (pollThrows) throw new Error('login.poll 炸了')
      return poll
    }
    if (method === 'account.delete') {
      calls.deleted.push(arg.accountId)
      return {}
    }
    throw new Error(`未预期的 rpc：${method}`)
  }
  const loadAccounts = async () => {
    calls.loads++
  }
  const fn = new Function('rpc', 'loadAccounts', `${BODY}\nreturn { isPlaceholder, reclaimPlaceholder }`)
  const api = fn(rpc, loadAccounts)
  return { ...api, calls }
}

// 夹具：占位条目（nickname === id、无 expiresAt、refreshable !== true、刚建）
const GHOST = { id: 'g1', nickname: 'g1', expiresAt: undefined, refreshable: false, createdAt: NOW - 60_000 }
// 夹具：真账号
const REAL = { id: 'r1', nickname: 'user-g7h8', expiresAt: NOW + 1e9, refreshable: true, createdAt: NOW - 60_000 }
// 夹具：autoclaw 的占位条目 —— 昵称是固定文案，不是 id
// （vendor/lib/jet-hub-rpc.js 的 autoclaw 短信路径 `nickname: 'AutoClaw (登录中...)'`）
const GHOST_AUTOCLAW = {
  id: 'ac1',
  nickname: 'AutoClaw (登录中...)',
  expiresAt: undefined,
  refreshable: false,
  createdAt: NOW - 60_000,
}
// 夹具：历史怪号（nickname === id 但建于 30 分钟前，超出时间窗）
const OLD = { id: 'o1', nickname: 'o1', expiresAt: undefined, refreshable: false, createdAt: NOW - 30 * 60_000 }

console.log("三态判据（yes / no / unknown，对齐本体 loginCredentialLanded 的惯例）：")
{
  const t = harness({ accounts: [GHOST] })
  ok((await t.isPlaceholder('g1', 'p')) === 'yes', '占位条目 → yes')
}
{
  const t = harness({ accounts: [REAL] })
  ok((await t.isPlaceholder('r1', 'p')) === 'no', '真账号 → no')
}
{
  // 三审发现的真实漏删：autoclaw 占位昵称是 'AutoClaw (登录中...)' 不是 id，
  // 只按「昵称 === id」判会判成 'no' ⇒ 用户关掉弹窗后幽灵账号永久留在池里。
  const t = harness({ accounts: [GHOST_AUTOCLAW] })
  ok((await t.isPlaceholder('ac1', 'autoclaw')) === 'yes', 'autoclaw 固定文案占位 → yes（昵称白名单）')
}
{
  const t = harness({ accounts: [GHOST_AUTOCLAW], poll: { done: false, state: 'pending' } })
  await t.reclaimPlaceholder('ac1', 'autoclaw')
  ok(t.calls.deleted.length === 1 && t.calls.deleted[0] === 'ac1', 'autoclaw 占位且凭据未落地 → 真的删掉')
}
{
  const t = harness({ accounts: [OLD] })
  ok((await t.isPlaceholder('o1', 'p')) === 'no', '超 10 分钟时间窗的历史怪号 → no（一律不碰）')
}
{
  const t = harness({ accounts: [], listThrows: true })
  ok((await t.isPlaceholder('x', 'p')) === 'unknown', 'account.list 抛错 → unknown，不是 no（读不到 ≠ 确证没有）')
}
{
  const t = harness({ accounts: [] })
  ok((await t.isPlaceholder('gone', 'p')) === 'no', '池里已没有这条 → no')
}

console.log('回收路径：')
{
  // 必修 2 的核心用例：池条目还像占位，但凭据其实已经落地了
  const t = harness({ accounts: [GHOST], poll: { done: true, success: true } })
  await t.reclaimPlaceholder('g1', 'p')
  ok(t.calls.deleted.length === 0, '占位但 login.poll 说 done=true → 不删（挡住 finishLogin 两步窗口）')
}
{
  const t = harness({ accounts: [GHOST], poll: { done: false, state: 'pending' } })
  await t.reclaimPlaceholder('g1', 'p')
  ok(t.calls.deleted.length === 1 && t.calls.deleted[0] === 'g1', '占位且凭据未落地 → 删掉')
}
{
  const t = harness({ accounts: [GHOST], poll: {}, pollThrows: true })
  await t.reclaimPlaceholder('g1', 'p')
  ok(t.calls.deleted.length === 0, 'login.poll 抛错 → 保守不删')
}
{
  const t = harness({ accounts: [REAL], poll: { done: false } })
  await t.reclaimPlaceholder('r1', 'p')
  ok(t.calls.deleted.length === 0 && t.calls.polls === 0, '真账号 → 连 login.poll 都不问')
}
{
  const t = harness({ accounts: [GHOST], poll: {}, listThrows: true })
  await t.reclaimPlaceholder('g1', 'p')
  ok(t.calls.deleted.length === 0, 'unknown 态 → 不删')
}

/* ── 2. 900ms 收尾定时器的竞态 ──
 *
 * 这段逻辑内联在 `startLogin` 的轮询闭包里，截不出来，所以分两步：
 * (a) 断言源码里确实有身份校验（改回去就红）；
 * (b) 用等价复刻跑新旧两版，证明旧版真的会误删下一次登录。
 */

console.log('900ms 收尾定时器：')
ok(
  /const settledId = loginAccountId/.test(src),
  '源码里先快照 settledId（收尾要认准是哪一次登录）',
)
ok(
  /if \(loginAccountId !== undefined\) return/.test(src),
  '源码里定时器开头有「期间又开了新登录就直接返回」的校验',
)
ok(
  !/setTimeout\(\(\) => \{\s*closeLogin\(\)\s*loadAccounts\(\)\s*\}, 900\)/.test(src),
  '源码里没有「无条件 closeLogin() 的无校验版本」',
)
// 三审指出的盲区：把 closeLogin → reclaimPlaceholder 这整条删掉，上面 19 项全绿。
// 那条链是第一轮 P1「幽灵账号堆积」的修复本体，必须有存在性锚点。
ok(
  // 必须匹配「未被注释掉的那一行」—— 只测 /reclaimPlaceholder\(abandoned, provider\)/
  // 会把 `// reclaimPlaceholder(...)` 也算命中（实测：注释掉整条调用，断言仍绿）。
  /^\s{2}reclaimPlaceholder\(abandoned, provider\)\s*$/m.test(src),
  'closeLogin() 真的把放弃的占位交给 reclaimPlaceholder（否则幽灵账号会回归）',
)
ok(
  (() => {
    // 必须切出 closeLogin 的函数体再断言 —— 这两个字符串在源码里各出现 4 次以上
    // （其它分支也在清），用全文件 includes 的话，closeLogin 完全不清理也是绿的
    // （2026-10-29 四审的 M-H 变异实测证实）。
    const at = src.indexOf('function closeLogin() {')
    if (at < 0) return false
    // 不用 '\n}' 这种转义：经过 heredoc 与 python 两层转义太容易写崩，
    // 改用 String.fromCharCode(10) 拼出来，可读性一样但不会出错。
    const body = src.slice(at, src.indexOf(String.fromCharCode(10) + '}', at))
    return /loginAccountId = undefined/.test(body) && /loginProvider = undefined/.test(body)
  })(),
  'closeLogin() 清掉 loginAccountId 与 loginProvider（不留到下一次误回收）',
)
// 四审建议 5：失败分支也要把定时器句柄置 undefined，与成功/超时分支写法一致
// （只 clearInterval 不置 undefined 时功能上无害，但下次重构会被顺手删掉）。
ok(
  (() => {
    const at = src.indexOf('if (s.success === false) {')
    if (at < 0) return false
    const body = src.slice(at, src.indexOf(String.fromCharCode(10) + '        }', at))
    return /clearInterval\(loginTimer\)/.test(body) && /loginTimer = undefined/.test(body)
  })(),
  'login.poll 失败分支清掉定时器并把句柄置 undefined',
)
// 三审必修 2：throw 之前必须收干净状态，否则弹窗永远停在「等待授权…」
// 用 indexOf 定位而不是正则 —— 这段里有引号与 $，正则转义太容易写错
ok(
  (() => {
    const at = src.indexOf("throw new Error('本体没有返回 loginUrl")
    if (at < 0) return false
    const before = src.slice(Math.max(0, at - 400), at)
    // 三项都要查：只查后两项的话，漏掉 loginAccountId 那行仍然全绿
    // （2026-10-29 四审的 M-D 变异实测证实），而 loginAccountId 残留正是这条缺陷的核心后果。
    return ['loginAccountId = undefined', 'loginProvider = undefined', 'hidden = true'].every(
      (s) => before.includes(s),
    )
  })(),
  '「没返回 loginUrl」的 throw 之前先关弹窗、清状态（三审必修 2）',
)

/** 等价复刻新旧两版收尾逻辑（只保留与本缺陷相关的状态）。 */
function timerHarness(version) {
  const st = { loginAccountId: undefined, loginTimer: undefined, modalHidden: false, deleted: [], loads: 0 }
  const clearTimer = (t) => {
    if (t === st.loginTimer) st.loginTimer = undefined
  }
  st.closeLogin = () => {
    clearTimer(st.loginTimer)
    st.loginTimer = undefined
    st.modalHidden = true
    const abandoned = st.loginAccountId
    st.loginAccountId = undefined
    if (abandoned) st.deleted.push(abandoned)
  }
  st.onSuccess = () => {
    if (version === 'old') {
      st.loginAccountId = undefined
      setTimeout(() => {
        st.closeLogin()
        st.loads++
      }, 900)
      return
    }
    const settledId = st.loginAccountId
    st.loginAccountId = undefined
    setTimeout(() => {
      if (st.loginAccountId !== undefined) return
      if (settledId !== undefined) {
        clearTimer(st.loginTimer)
        st.loginTimer = undefined
        st.modalHidden = true
      }
      st.loads++
    }, 900)
  }
  return st
}

async function runTimer(version, race) {
  const st = timerHarness(version)
  st.loginAccountId = 'acct-A'
  st.loginTimer = 'timer-A'
  st.onSuccess()
  if (race) {
    // 900ms 内用户又点了一次「添加账号」，已经 create 出新占位
    st.loginAccountId = 'acct-B'
    st.loginTimer = 'timer-B'
    st.modalHidden = false
  }
  await new Promise((r) => setTimeout(r, 1100))
  return st
}

console.log('  无竞态（正常收尾，两版行为应一致）：')
{
  // 两个版本并发跑：各等 900ms+，串行会让整个测试白等 2 秒。
  const [a, b] = await Promise.all([runTimer('old', false), runTimer('new', false)])
  ok(a.modalHidden === true && a.loads === 1, '旧版：关弹窗 + 刷新')
  ok(b.modalHidden === true && b.loads === 1, '新版：关弹窗 + 刷新')
  ok(a.deleted.length === 0 && b.deleted.length === 0, '两版都不删账号（成功分支已清 loginAccountId）')
}
console.log('  有竞态（900ms 内又开了一次登录）：')
{
  const [a, b] = await Promise.all([runTimer('old', true), runTimer('new', true)])
  ok(a.modalHidden === true, '旧版：把**新**弹窗关掉了（缺陷）')
  ok(a.loginTimer === undefined, '旧版：把新轮询定时器 clearInterval 了（缺陷）')
  ok(a.deleted.includes('acct-B'), '旧版：把新登录的占位账号删了（必修 1 复现）')
  ok(b.modalHidden === false, '新版：新弹窗仍开着')
  ok(b.loginTimer === 'timer-B', '新版：新轮询定时器还在')
  ok(b.deleted.length === 0, '新版：没删任何账号')
}

console.log(bad === 0 ? '\n✓ 全部通过（26 项）' : `\n✗ ${bad} 项失败`)
process.exit(bad === 0 ? 0 : 1)
