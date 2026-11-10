/**
 * 控制台「严格手动顺序」开关的契约测试。
 *
 * 背景：2026-11-09 同步上游 `1d12f80` 时接进来的开关（`#accStrict`）。它回答的是
 * 「拖拽排序到底算不算数」：**关着**的时候，走余额分档的渠道会**盖过**卡片顺序 ——
 * 这正是「拖拽时灵时不灵」那条报障的根。所以它不是一个装饰性开关，接错方向用户
 * 得到的结论正好相反。而它有三个**静默失败**的坑，全都不报错：
 *
 *   1. **按供应商存**。取值时必须带当前 provider；`setProvider()` 切家要重读一遍，
 *      否则开关停在上家的值 —— 用户在 A 家看到「已开启」，实际 B 家是关的。
 *   2. **await 期间用户可能已经切走**。`loadStrictOrder` 的回包回来时如果 provider
 *      变了还照写，就会把 A 家的值盖到 B 家的开关上（`setProvider` 是同步切 DOM 的，
 *      这个窗口真实存在）。
 *   3. **问不出来就置灰**，而不是留一个「点了没反应」的开关（那是能力缺失，不是故障）。
 *
 * 判据一律从**真源码**取（不复制粘贴），运行时用假 `$` / `rpc` / `say` 求值 ——
 * 与 `t-console-credits.mjs` 同一手法。跑法：`node tests/t-console-strict-order.mjs`
 * （不联网、不碰真实 ~/.dsh）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SRC = path.join(ROOT, 'console', 'console.js')
const HTML = path.join(ROOT, 'console', 'index.html')
const RPC = path.join(ROOT, 'vendor', 'lib', 'jet-hub-rpc.js')

let bad = 0
let total = 0
const ok = (cond, msg) => {
  total++
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) bad++
}

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const src = read(SRC)
const rpcSrc = read(RPC)
const html = read(HTML)

/**
 * 从源码里按大括号配对截出整个函数声明（含函数体）。
 *
 * ⚠ 起始大括号必须取**参数表之后**那个 —— `function setProvider(id, { silent = false } = {})`
 * 的参数里就有花括号，从第一个 `{` 起算会把它自己截断（`{ silent = false }` 配平后 depth 归零）。
 */
function sliceFn(text, prefix) {
  const start = text.indexOf(prefix)
  if (start < 0) throw new Error(`找不到源码片段：${JSON.stringify(prefix)}`)
  const open = text.indexOf(') {', start)
  if (open < 0) throw new Error(`找不到函数体起始：${JSON.stringify(prefix)}`)
  let depth = 0
  for (let i = open + 2; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  throw new Error(`大括号没配对：${JSON.stringify(prefix)}`)
}

/* ── 1. 本体侧的契约（回包形状 / 参数名 / 不猜默认值） ─────────────── */

console.log('--- 1) 本体侧：strictManualOrder 的 RPC 契约 ---')
{
  const iGet = rpcSrc.indexOf("case 'strictManualOrder.getEnabled'")
  ok(iGet > 0, '找到 strictManualOrder.getEnabled 的 handler')
  const getBlock = rpcSrc.slice(iGet, iGet + 600)
  ok(/const value = \{\s*enabled: pool\.strictManualOrder\(req\.provider\),?\s*\}/.test(getBlock),
    'getEnabled 回 `{ enabled: pool.strictManualOrder(provider) }`（值是对象，不是裸布尔）')
  ok(/return \{ ok: true, value \};/.test(getBlock), 'getEnabled 走 `{ ok: true, value }` 外壳')

  const iSet = rpcSrc.indexOf("case 'strictManualOrder.setEnabled'")
  ok(iSet > 0, '找到 strictManualOrder.setEnabled 的 handler')
  const setBlock = rpcSrc.slice(iSet, iSet + 900)
  // ⚠ 非布尔一律 bad-request（与 sessionBalance 同约定），不给默认值
  ok(/typeof req\.enabled !== 'boolean'/.test(setBlock), 'setEnabled 只接布尔 `enabled`（非布尔直接 bad-request）')
  // ⚠ 默认值猜测会静默打开用户特意关掉的开关（本开关改变选号策略，后果是「拖拽又不灵了」）
  ok(!/req\.enabled\s*\?\?\s*true/.test(setBlock), 'setEnabled **不**给 enabled 猜默认 true')
  ok(/await pool\.setStrictManualOrder\(req\.provider, req\.enabled\)/.test(setBlock),
    'setEnabled 落到 `pool.setStrictManualOrder(provider, enabled)`（两参，顺序不能反）')
}

/* ── 2. 控制台侧的接线（参数形状 / 切家重读 / change 绑定） ────────── */

console.log('--- 2) 控制台侧：接线与参数形状 ---')
{
  ok(html.includes('id="accStrict"'), 'index.html 里有 `#accStrict`')
  ok(/<input type="checkbox" id="accStrict">/.test(html), '`#accStrict` 是 checkbox（不是按钮）')

  // 取值必须带 provider（按供应商存），且参数名与 handler 读的 `req.provider` 一致
  ok(/rpc\('strictManualOrder\.getEnabled', \{ provider \}\)/.test(src),
    "loadStrictOrder 调 `rpc('strictManualOrder.getEnabled', { provider })`")
  ok(/rpc\('strictManualOrder\.setEnabled', \{ provider, enabled \}\)/.test(src),
    "saveStrictOrder 调 `rpc('strictManualOrder.setEnabled', { provider, enabled })`")

  // 切家必须重读 —— 否则开关停在上家的值
  const iSetProvider = src.indexOf('function setProvider(')
  const setProvider = sliceFn(src, 'function setProvider(')
  ok(iSetProvider > 0, '找到 setProvider 函数')
  ok(/loadStrictOrder\(id\)/.test(setProvider), 'setProvider 里切家时重读 `loadStrictOrder(id)`')

  // 勾选立刻落盘（change 事件，不是 click —— click 也会在只读态触发）
  ok(/\$\('#accStrict'\)\.addEventListener\('change', \(e\) => saveStrictOrder\(e\.target\.checked\)\)/.test(src),
    "`#accStrict` 绑的是 change 事件（不是 click），值取 `e.target.checked`")
}

/* ── 3. 运行时行为：把真函数抽出来喂假 DOM ─────────────────────────── */

console.log('--- 3) 运行时行为 ---')

const loadSrc = sliceFn(src, 'async function loadStrictOrder(provider)')
const saveSrc = sliceFn(src, 'async function saveStrictOrder(enabled)')

/**
 * 造一个沙箱：`$` 只认 `#accStrict` / `#accProvider` / `#accMsg` 三个选择器，
 * `rpc` 由用例给，`say` 记调用。返回的 `fn` 就是源码里那两个真函数。
 */
function sandbox({ provider = 'buddy', rpcImpl, checkboxChecked = false } = {}) {
  const el = { checked: checkboxChecked, disabled: false }
  const msg = { textContent: '', className: '' }
  const state = { provider, say: [] }
  const $ = (sel) => {
    if (sel === '#accStrict') return el
    if (sel === '#accProvider') return { value: state.provider }
    if (sel === '#accMsg') return msg
    return null
  }
  const rpc = (...args) => rpcImpl(...args)
  const say = (sel, text, kind) => state.say.push({ sel, text, kind })
  // eslint-disable-next-line no-new-func
  const factory = new Function('$', 'rpc', 'say', `${loadSrc}\n${saveSrc}\nreturn { loadStrictOrder, saveStrictOrder }`)
  return { ...factory($, rpc, say), el, state, msg }
}

console.log('· 3.1 成功：按回包写勾选态、解掉置灰')
{
  const calls = []
  const sb = sandbox({
    rpcImpl: async (method, payload) => {
      calls.push({ method, payload })
      return { enabled: true }
    },
  })
  await sb.loadStrictOrder('buddy')
  ok(calls.length === 1 && calls[0].payload.provider === 'buddy', '按当前 provider 问了一次')
  ok(sb.el.checked === true, '回包 enabled:true ⇒ 勾上')
  ok(sb.el.disabled === false, '可交互（不是置灰态）')
}

console.log('· 3.2 严格只认 `=== true`（1 / "yes" 不算开启）')
{
  for (const v of [1, 'yes', {}, null, undefined]) {
    const sb = sandbox({ rpcImpl: async () => ({ enabled: v }) })
    await sb.loadStrictOrder('buddy')
    ok(sb.el.checked === false, `回包 enabled=${JSON.stringify(v)} ⇒ 不勾（只认严格 true）`)
  }
}

console.log('· 3.3 竞态：回包回来时用户已切走 ⇒ 不许把上家的值盖到新渠道')
{
  const sb = sandbox({
    rpcImpl: async () => {
      // 模拟 await 期间用户点了别家：DOM 的 #accProvider 已经是 zcode
      sb.state.provider = 'zcode'
      return { enabled: true }
    },
  })
  await sb.loadStrictOrder('buddy')
  ok(sb.el.checked === false, '切走后不写 checked（保持原值 false）')
  ok(sb.el.disabled === false, '也不解置灰（新渠道自己那次请求会负责）')
}

console.log('· 3.4 问不出来 ⇒ 置灰 + 不勾（「没有这个能力」而不是「点了没反应」）')
{
  const sb = sandbox({ rpcImpl: async () => { throw new Error('unknown method') } })
  await sb.loadStrictOrder('buddy')
  ok(sb.el.checked === false, '失败时不勾')
  ok(sb.el.disabled === true, '失败时置灰')
}

console.log('· 3.5 没有 provider ⇒ 一个请求都不发')
{
  let n = 0
  const sb = sandbox({ provider: '', rpcImpl: async () => { n += 1; return { enabled: true } } })
  await sb.loadStrictOrder('')
  ok(n === 0, '空 provider 直接 return（不查也不写）')
}

console.log('· 3.6 落盘成功：消息带「已开启 / 已关闭」与 provider 名')
{
  const calls = []
  const sb = sandbox({ rpcImpl: async (method, payload) => { calls.push({ method, payload }); return {} } })
  await sb.saveStrictOrder(true)
  ok(calls[0]?.method === 'strictManualOrder.setEnabled', '调的是 setEnabled')
  ok(calls[0]?.payload.enabled === true, '把勾选态原样传下去（true）')
  ok(/已开启/.test(sb.state.say[0]?.text ?? '') && /buddy/.test(sb.state.say[0]?.text ?? ''),
    '提示「已开启（buddy）」，kind=ok', sb.state.say[0]?.text)
  ok(sb.state.say[0]?.kind === 'ok', '走 ok 通道')

  const sb2 = sandbox({ rpcImpl: async () => ({}) })
  await sb2.saveStrictOrder(false)
  ok(/已关闭/.test(sb2.state.say[0]?.text ?? ''), '传 false 时提示「已关闭」', sb2.state.say[0]?.text)
}

console.log('· 3.7 落盘失败 ⇒ 报错 + **回读**（把开关拨回真实状态，不留假状态）')
{
  let getCount = 0
  const sb = sandbox({
    rpcImpl: async (method) => {
      if (method === 'strictManualOrder.setEnabled') throw new Error('写盘失败')
      getCount += 1
      return { enabled: false }
    },
    checkboxChecked: true,
  })
  await sb.saveStrictOrder(true)
  ok(/写盘失败/.test(sb.state.say[0]?.text ?? ''), '把失败原因报给用户', sb.state.say[0]?.text)
  ok(sb.state.say[0]?.kind === 'err', '走 err 通道')
  ok(getCount === 1, '失败后回读了一次真实状态（getEnabled）', String(getCount))
  ok(sb.el.checked === false, '回读结果把勾选态拨回去了')
}

console.log(`\n${bad === 0 ? '✓ 全部通过' : `✗ ${bad} 项失败`}（${total} 项：RPC 契约 + 接线 + 六个运行时行为）`)
process.exit(bad === 0 ? 0 : 1)
