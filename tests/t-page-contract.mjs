/**
 * 侧栏页（`page/`）的**结构性契约**测试。
 *
 * 为什么需要它：侧栏页跑在 magpie 的窗口沙箱 iframe 里，CSP 是 `connect-src 'none'`
 * + opaque origin。也就是说 —— **任何网络调用都是静默失败**：按钮点了没反应，
 * 只有开发者工具里多一行 CSP 报错，用户看到的现象是「这个页面坏了」。同理，
 * `data-tab` 与 `data-panel` 对不上、`data-copy` 指向一个不存在的 id、
 * `data-snippet` 加了一项却没实现，全都是**零报错**的哑掉。
 *
 * 而这个页面原来**一条自动化断言都没有**（`tests/ui-check.cjs` 要真跑 magpie web，
 * 不进单测）。这里把「静默失效」的那几类钉死：
 *
 *   1. `page/page.js` 里不许出现 `fetch` / `XMLHttpRequest` / `WebSocket` /
 *      `EventSource` / `eval` / `new Function` —— 沙箱里全是死代码；
 *   2. `page/index.html` 里不许有内联事件处理器（`on*=`）—— 项目约定一律
 *      `addEventListener`，内联写法在 CSP 下可能被直接拦；
 *   3. 每个 `data-tab="x"` 都有 `data-panel="x"`（反之亦然）—— 对不上时点标签
 *      什么都不会发生；
 *   4. 每个 `data-copy="#id"` 的 id 在 HTML 里真的存在 —— 否则复制按钮点了没反应；
 *   5. 每个 `data-snippet="x"` 在 `snippetFor()` 里都有分支（抽真函数求值），
 *      且片段里带网关地址；
 *   6. 控制台地址**优先取快照**（`JET_HUB_CATALOG.console`），只有快照没有时
 *      才退回 `18500` —— 页面拿不到运行时端口，猜端口必错。
 *
 * 跑法：`node tests/t-page-contract.mjs`（不联网、不起浏览器）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const HTML = path.join(ROOT, 'page', 'index.html')
const JS = path.join(ROOT, 'page', 'page.js')

let bad = 0
let total = 0
const ok = (cond, msg, extra) => {
  total++
  console.log(`  ${cond ? '✓' : '✗'} ${msg}${cond || extra === undefined ? '' : ` — ${extra}`}`)
  if (!cond) bad++
}

// 行尾归一化：源码里混着 CRLF 时，按 \n 写的定位串会全部对不上
const html = fs.readFileSync(HTML, 'utf8').replace(/\r\n/g, '\n')
const js = fs.readFileSync(JS, 'utf8').replace(/\r\n/g, '\n')

/** 按大括号配对截出整个函数声明。 */
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

const attrs = (name) => [...html.matchAll(new RegExp(`\\b${name}="([^"]+)"`, 'g'))].map((m) => m[1])

/* ── 1. 沙箱里不许有网络 API ────────────────────────────────────────── */

console.log('--- 1) CSP 契约：沙箱里没有网络调用 ---')
for (const api of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'eval(', 'new Function']) {
  ok(!js.includes(api), `page.js 不含 \`${api}\`（\`connect-src 'none'\` 下是静默死代码）`)
}
ok(!/importScripts|navigator\.sendBeacon/.test(js), 'page.js 不含 importScripts / sendBeacon')

console.log('--- 2) 没有内联事件处理器 ---')
{
  // `on*=` 只在标签属性里出现才算（`b.onclick = ...` 是 JS 赋值，不在 HTML 里）
  const inline = [...html.matchAll(/\son[a-z]+\s*=/g)].map((m) => m[0].trim())
  ok(inline.length === 0, 'index.html 没有 `on*=` 内联处理器（一律 addEventListener）', inline.join(', '))
  ok(/\.on(?:click|change|input|keydown)\s*=/.test(js) || /addEventListener\(/.test(js),
    'page.js 在 JS 里绑事件（`el.onclick =` 或 addEventListener 都行，只是不许写进 HTML）')
}

/* ── 3. tab ↔ panel 一一对应 ───────────────────────────────────────── */

console.log('--- 3) 标签与面板一一对应 ---')
{
  const tabs = attrs('data-tab')
  const panels = attrs('data-panel')
  ok(tabs.length > 0, `HTML 里找到 ${tabs.length} 个 data-tab`, tabs.join(', '))
  ok(
    tabs.length === panels.length && tabs.every((t) => panels.includes(t)),
    `data-tab（${tabs.join(',')}）与 data-panel（${panels.join(',')}）集合相等`,
  )
}

/* ── 4. 复制按钮的目标必须存在 ─────────────────────────────────────── */

console.log('--- 4) data-copy 的目标元素存在 ---')
{
  const copies = attrs('data-copy')
  ok(copies.length > 0, `找到 ${copies.length} 个复制按钮`, copies.join(', '))
  for (const sel of copies) {
    const id = sel.replace(/^#/, '')
    ok(new RegExp(`\\bid="${id}"`).test(html), `复制目标 ${sel} 在 HTML 里存在`)
  }
}

/* ── 5. 每个代码片段都有实现 ──────────────────────────────────────── */

console.log('--- 5) data-snippet 都有实现，且带网关地址 ---')
{
  // 抽真函数求值；`modelId` / `bare` 是纯格式化函数，这里各自桩掉（它们有自己的关切）
  const GW = 'http://127.0.0.1:3425'
  const snippetSrc = sliceFn(js, 'function snippetFor(lang)')
  // eslint-disable-next-line no-new-func
  const snippetFor = new Function(
    'CATALOG',
    'state',
    'DEFAULT_USER_GATEWAY',
    'modelId',
    'bare',
    `${snippetSrc}\nreturn snippetFor`,
  )(
    { gateway: GW, models: ['workbuddy/deepseek-v4.1-flash'] },
    { options: { prefix: false, model: '' } },
    GW,
    (m) => String(m || '').split('/').slice(1).join('/'),
    (id) => String(id || '').split('/').slice(1).join('/'),
  )

  const langs = attrs('data-snippet')
  ok(langs.length > 0, `找到 ${langs.length} 个代码片段标签`, langs.join(', '))
  // ⚠ 只断言「非空 + 带网关」不够：删掉某个分支会**落回 curl 默认分支**，
  //    同样非空、同样带网关 —— 实测这条变异曾经骗过本文件（2026-11-10）。
  //    所以每种语言再钉一个**它独有**的标记。
  const MARK = {
    curl: /^curl /,
    python: /from openai import OpenAI/,
    node: /import OpenAI from 'openai'/,
    dsh: /cordis\.patch\.yml/,
  }
  for (const lang of langs) {
    const text = snippetFor(lang)
    ok(typeof text === 'string' && text.length > 0, `snippetFor('${lang}') 有实现（非空）`)
    ok(String(text).includes(`${GW}/v1`), `… 且带网关地址 ${GW}/v1`)
    ok(MARK[lang]?.test(String(text)), `… 且是 ${lang} 专用的写法（没落回 curl 默认分支）`)
  }
  // 未知语言必须落回 curl 分支，而不是 undefined（否则文本框一片空白）
  ok(String(snippetFor('__unknown__')).startsWith('curl '), '未知语言落回 curl 分支（不是空白）')
  // 四项两两不同 —— 防止「全都返回同一个模板」
  const all = langs.map((l) => String(snippetFor(l)))
  ok(new Set(all).size === all.length, '四种语言的片段两两不同', `${new Set(all).size}/${all.length}`)
}

/* ── 6. 控制台地址：快照优先 ──────────────────────────────────────── */

console.log('--- 6) 控制台地址优先取快照 ---')
{
  const catalogSrc = sliceFn(js, 'function catalog()')
  const conUrlSrc = sliceFn(js, 'function conUrl()')
  const otherHostsSrc = sliceFn(js, 'function otherHosts()')
  const build = (snapshot) => {
    
    const w = { JET_HUB_CATALOG: snapshot }
    // eslint-disable-next-line no-new-func
    return new Function(
      'window',
      'CON_PORT_DEFAULT',
      `${catalogSrc}\n${conUrlSrc}\n${otherHostsSrc}\nreturn { catalog, conUrl, otherHosts }`,
    )(w, '18500')
  }

  const snap = build({ console: 'http://127.0.0.1:18502/', consolePort: '18502', hosts: [{ port: '18502' }, { port: '18503' }] })
  ok(snap.conUrl() === 'http://127.0.0.1:18502/', '快照里的地址原样用（不是写死 18500）', snap.conUrl())
  ok(JSON.stringify(snap.otherHosts()) === JSON.stringify([{ port: '18503' }]),
    'otherHosts 排除自己那台（只报别的宿主）', JSON.stringify(snap.otherHosts()))

  const noSnap = build(undefined)
  ok(noSnap.conUrl() === 'http://127.0.0.1:18500/', '快照缺失时退回默认 18500', noSnap.conUrl())
  ok(noSnap.otherHosts().length === 0, '快照缺失时没有「别的宿主」')

  const badSnap = build({ console: 'not-a-url', consolePort: '' })
  ok(badSnap.conUrl() === 'http://127.0.0.1:18500/', '快照地址不是 http(s) 时不认，退回默认', badSnap.conUrl())
}

/* ── 7. `flash()` 失败时不能继承上一次的绿色 ────────────────────── */

console.log('--- 7) flash() 的两条边（成功变绿 / 失败必须清绿） ---')
{
  // 为什么值得单独一条：`flash()` 的注释（「只有成功才变绿……无条件设 data-done
  // 会让失败看起来像成功」）说得很清楚，但**失败那一侧没人删** —— `data-done`
  // 是个布尔态，只给 `ok === true` 设、不给 `ok === false` 清，状态机就少了一条边。
  // 1.6 秒窗口内第一次点成功、第二次点失败，按钮会同时是「绿色成功态」+「复制失败」
  // 文案 —— 正是这段注释要避免的形态。（2026-11-11 审计实测复现。）
  const flashSrc = sliceFn(js, 'function flash(btn, text, ok = false)')
  // 假定时器：只要句柄，不真等 1.6 秒。`flash` 里只用到 `setTimeout` / `clearTimeout`
  // 和 `btn.dataset`，全部可由参数注入。
  let seq = 0
  const timers = new Map()
  const build = () => {
    const btn = { textContent: '复制', innerHTML: '复制', dataset: {} }
    // eslint-disable-next-line no-new-func
    const fn = new Function(
      'setTimeout',
      'clearTimeout',
      `${flashSrc}\nreturn flash`,
    )((cb) => { const id = ++seq; timers.set(id, cb); return id }, (id) => { timers.delete(id) })
    return { btn, fn }
  }

  const { btn, fn } = build()
  fn(btn, '已复制', true)
  ok(btn.dataset.done === '1', '成功 ⇒ 按钮变绿（data-done 置位）')
  fn(btn, '复制失败', false)
  ok(!Object.prototype.hasOwnProperty.call(btn.dataset, 'done'),
    '紧接着失败 ⇒ **必须**清掉 data-done（否则「绿色 + 复制失败」自相矛盾）')
}

console.log(`\n${bad === 0 ? '✓ 全部通过' : `✗ ${bad} 项失败`}（${total} 项：CSP 契约 + 结构对齐 + 片段实现 + 控制台地址 + flash 状态机）`)
process.exit(bad === 0 ? 0 : 1)
