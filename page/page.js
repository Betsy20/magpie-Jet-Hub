// Jet Hub 的 magpie 插件页。
//
// 跑在 magpie 窗口的沙箱 iframe 里（sandbox allow-scripts，connect-src 'none'）：
// 不能联网，也不能碰 magpie 的 /api。能拿到的只有 bridge 铺好的这几样：
//
//   await magpie.ready            窗口答上话后拿到主题 {dark, lang, tokens}
//   magpie.onTheme(fn)            主题或语言变了就调一次
//   await magpie.read(name, p)    只有 package.json 里 magpie.permissions 声明的
//                                 · providers:list → [{id, name}]
//                                 · usage:summary  {period: today|7d|30d}
//                                   → {calls, errors, input, output, cacheRead, cost, models:[…]}
//   await magpie.options.get()    本插件自己的选项
//   await magpie.options.set(o)   写回（窗口限 1 秒 1 次）
//
// 模型目录读不到（页面不能联网，providers:list 也不给模型），所以用
// page/models.js 里的快照，由 scripts/snapshot-models.mjs 生成。

const CATALOG = window.JET_HUB_CATALOG || { models: [], providers: {}, generatedAt: '', gateway: 'http://127.0.0.1:3425' }

/* 每个本体 provider 都是独立的 magpie provider：jet-hub / jet-hub-codearts / …
   模型 id 形如 `jet-hub-codearts/deepseek-v4.1-flash`（第一段是 provider id）。 */
const isOurs = (seg) => seg === 'jet-hub' || String(seg).startsWith('jet-hub-')
const providerSeg = (id) => String(id || '').split('/')[0]

const state = {
  options: { model: '', period: 'today', prefix: true },
  period: 'today',
  snippet: 'curl',
  query: '',
  allOpen: false,
  onlyMine: true,
}

/* ── 小工具 ───────────────────────────── */

const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => [...document.querySelectorAll(sel)]

function el(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

function setState(text, tone) {
  const s = $('#state')
  s.textContent = text
  s.dataset.tone = tone
}

function num(n) {
  if (n == null) return '—'
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}
const comma = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'))

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text)
    if (btn) {
      const old = btn.textContent
      btn.dataset.done = '1'
      btn.textContent = '已复制'
      setTimeout(() => { btn.textContent = old; delete btn.dataset.done }, 1400)
    }
    return true
  } catch {
    if (btn) { btn.textContent = '复制失败'; setTimeout(() => { btn.textContent = '复制' }, 1400) }
    return false
  }
}

/* `jet-hub-codearts/deepseek-v4.1-flash` → `codearts/deepseek-v4.1-flash`
   （直接打插件内部网关时才用得上；走 magpie 必须用完整 id）。 */
function bare(id) {
  const s = String(id || '')
  const seg = s.split('/')[0]
  if (!isOurs(seg)) return s
  const magpieId = seg === 'jet-hub' ? 'jet-hub' : seg.slice('jet-hub-'.length)
  const upstream = magpieId === 'jet-hub' ? 'jet-hub-auto' : magpieId
  return `${upstream}/${s.slice(seg.length + 1)}`
}

function modelId(m) {
  const id = String(m || '')
  return state.options.prefix ? id : bare(id)
}

function providerOf(model) {
  return CATALOG.providers?.[providerSeg(model)] || null
}

const providerName = (model) => providerOf(model)?.name || String(model || '').split('/')[0]

/* ── 接入：代码片段 ───────────────────── */

function snippetFor(lang) {
  const gw = CATALOG.gateway || 'http://127.0.0.1:3425'
  const model = modelId(state.options.model || CATALOG.models[0] || 'workbuddy/deepseek-v4.1-flash')
  if (lang === 'python') {
    return `# pip install openai
from openai import OpenAI

client = OpenAI(base_url="${gw}/v1", api_key="not-needed")
r = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "你好"}],
)
print(r.choices[0].message.content)`
  }
  if (lang === 'node') {
    return `// npm i openai
import OpenAI from 'openai'

const client = new OpenAI({ baseURL: '${gw}/v1', apiKey: 'not-needed' })
const r = await client.chat.completions.create({
  model: '${model}',
  messages: [{ role: 'user', content: '你好' }],
})
console.log(r.choices[0].message.content)`
  }
  if (lang === 'dsh') {
    return `# ~/.dsh/profiles/web/cordis.patch.yml
- id: llm-openai-compat   # Jet Hub
  config:
    providers:
      jet-hub:
        api: openai-completions
        baseURL: ${gw}/v1
        apiKey: not-needed
        models:
          - ${bare(state.options.model || CATALOG.models[0] || 'workbuddy/deepseek-v4.1-flash')}`
  }
  return `curl ${gw}/v1/chat/completions \\
  -H 'Content-Type: application/json' \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "你好"}]
  }'`
}

function drawSnippet() {
  $('#snippet').textContent = snippetFor(state.snippet)
  for (const b of $$('#langs button')) {
    b.setAttribute('aria-selected', String(b.dataset.snippet === state.snippet))
  }
}

/* ── 模型 ─────────────────────────────── */

function drawModels() {
  const box = $('#groups')
  box.replaceChildren()
  const models = CATALOG.models || []
  const q = state.query.trim().toLowerCase()

  if (!models.length) {
    box.append(el('p', 'wait', '快照里一个模型都没有。账号登录后跑一次 node scripts/snapshot-models.mjs。'))
    $('#modelsHint').textContent = ''
    return
  }

  // 按 provider 分组
  const groups = new Map()
  for (const m of models) {
    const seg = m.split('/')[0]
    if (!groups.has(seg)) groups.set(seg, [])
    groups.get(seg).push(m)
  }

  const rows = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
  let shown = 0
  let closed = 0

  for (const [seg, list] of rows) {
    const hit = q ? list.filter((m) => m.toLowerCase().includes(q) || seg.includes(q)) : list
    const name = CATALOG.providers?.[seg]?.name || seg
    const nameHit = q && (name.toLowerCase().includes(q) || seg.includes(q))
    if (!hit.length && !nameHit) continue
    shown += hit.length || list.length

    const detail = el('details', 'group')
    // ⚠️ 全量目录可能一家 540 条（cline 实测）。默认全展开会把页面撑爆，
    //    所以只在搜索时自动展开；点「全部展开」才全开。
    detail.open = Boolean(q) || state.allOpen
    const sum = el('summary')
    sum.append(el('span', '', name), el('span', 'pid', seg), el('span', 'n', `${list.length}`))
    detail.append(sum)
    const wrap = el('div', 'mlist')
    for (const m of (hit.length ? hit : list)) {
      const info = CATALOG.detail?.[m]
      if (info?.disabled) closed += 1
      const chip = el('button', 'mid')
      chip.type = 'button'
      chip.title = '点一下复制 ' + modelId(m) + (info?.disabled ? '（已在 Jet Hub 关闭，需在控制台打开才能用）' : '')
      if (info?.disabled) chip.dataset.off = '1'
      const label = state.options.prefix ? m : bare(m)
      chip.append(document.createTextNode(label))
      chip.onclick = () => copy(modelId(m), chip).then((ok) => {
        if (ok) { chip.dataset.done = '1'; chip.textContent = '已复制 ' + modelId(m); setTimeout(() => { chip.replaceChildren(document.createTextNode(label)); delete chip.dataset.done }, 1400) }
      })
      wrap.append(chip)
    }
    detail.append(wrap)
    box.append(detail)
  }

  if (!shown) box.append(el('p', 'wait', `没有匹配「${state.query}」的模型`))

  const when = CATALOG.catalogAt ? new Date(CATALOG.catalogAt).toLocaleString('zh-CN', { hour12: false }) : '未知'
  // 报清楚「这份目录是从哪台宿主的哪个端口取的」——P1 就是模型和地址错配到两个宿主上，
  // 所以端口必须写出来，且和「控制台」标签里的地址是同一个端口。
  const port = String(CATALOG.consolePort || '').trim()
  const others = otherHosts()
  $('#modelsHint').textContent =
    `上游全量 ${models.length} 个模型 / ${rows.length} 个供应商，目录取自 ${when}（${CATALOG.source || '快照'}）。` +
    (port ? ` 这份目录属 :${port} 那台宿主，和「控制台」标签里的地址同一台。` : '') +
    (others.length ? ` ⚠ 另有 ${others.length} 个宿主在跑（:${others.map((h) => h.port).join('、:')}），它们的模型数和开关状态可能不同。` : '') +
    (closed ? `其中 ${closed} 个在 Jet Hub 里是关闭状态（灰的），要先去控制台打开。` : '') +
    ' 上游新上模型后跑 node scripts/snapshot-models.mjs 刷新。'
}

/* ── 用量 ─────────────────────────────── */

function tile(k, v, unit) {
  const t = el('div', 'tile')
  t.append(el('span', 'k', k))
  const val = el('span', 'v', v)
  if (unit) val.append(el('span', 'u', unit))
  t.append(val)
  return t
}

function isMine(name) {
  const seg = String(name || '').split('/')[0]
  return Object.prototype.hasOwnProperty.call(CATALOG.providers || {}, seg)
}

async function drawUsage() {
  const box = $('#tiles')
  let data
  try {
    data = await magpie.read('usage:summary', { period: state.period })
  } catch (err) {
    box.replaceChildren(el('span', 'wait', '读不到用量：' + (err?.message || err)))
    $('#utable').hidden = true
    return
  }

  box.replaceChildren(
    tile('请求', comma(data.calls)),
    tile('失败', comma(data.errors)),
    tile('输入 token', num(data.input)),
    tile('输出 token', num(data.output)),
    tile('缓存命中', num(data.cacheRead)),
    tile('费用', data.cost ? '$' + Number(data.cost).toFixed(2) : '$0'),
  )

  const all = Array.isArray(data.models) ? data.models : []
  const list = state.onlyMine ? all.filter((m) => isMine(m.model)) : all
  const tbody = $('#ubody')
  tbody.replaceChildren()

  if (!list.length) {
    $('#utable').hidden = true
    $('#usageHint').textContent = state.onlyMine
      ? '这个周期里还没有走过 Jet Hub 模型的请求（取消下面「只看 Jet Hub 的模型」可看全部）。'
      : '这个周期里还没有请求。'
    return
  }

  $('#utable').hidden = false
  const max = Math.max(...list.map((m) => m.calls || 0), 1)
  for (const m of list) {
    const tr = el('tr')
    const name = el('td', 'mname', m.model)
    if (isMine(m.model)) name.append(el('span', 'tag', providerSeg(m.model)))
    tr.append(name)
    tr.append(el('td', 'num', comma(m.calls)))
    tr.append(el('td', 'num', num(m.input)))
    tr.append(el('td', 'num', num(m.output)))
    tr.append(el('td', 'num', m.cost ? '$' + Number(m.cost).toFixed(3) : '—'))
    const barCell = el('td')
    const bar = el('div', 'bar')
    bar.style.width = Math.max(2, Math.round(((m.calls || 0) / max) * 100)) + '%'
    barCell.append(bar)
    tr.append(barCell)
    tbody.append(tr)
  }

  const since = data.since ? new Date(data.since).toLocaleString('zh-CN', { hour12: false }) : ''
  $('#usageHint').textContent = `周期 ${data.period}${since ? '，从 ' + since + ' 起' : ''}；最多列 20 个模型。用量是整个 magpie 网关的，按模型名归集；费用是 magpie 自己按价格表算的，没配价格的模型排不上价，显示 —。`
}

/* ── 供应商 ───────────────────────────── */

function drawProviders() {
  const box = $('#provs')
  box.replaceChildren()
  const have = new Set((CATALOG.models || []).map((m) => m.split('/')[0]))
  const entries = Object.entries(CATALOG.providers || {})
  // 有模型的排前面
  entries.sort((a, b) => Number(have.has(b[0])) - Number(have.has(a[0])) || a[1].name.localeCompare(b[1].name))
  for (const [id, p] of entries) {
    const card = el('div', 'prov')
    const pn = el('div', 'pn')
    if (have.has(id)) pn.append(el('span', 'dot'))
    pn.append(el('span', '', p.name))
    card.append(pn, el('div', 'pi', id))
    const n = (CATALOG.models || []).filter((m) => m.split('/')[0] === id).length
    card.append(el('div', 'pd', n ? `${n} 个模型` : (p.desc || '未登录 / 无模型')))
    box.append(card)
  }
}

/* ── 设置 ─────────────────────────────── */

function drawSettings() {
  const sel = $('#optModel')
  sel.replaceChildren(new Option('（不设置）', ''))
  for (const m of CATALOG.models || []) sel.append(new Option(modelId(m), m))
  sel.value = state.options.model || ''
  $('#optPeriod').value = state.options.period || 'today'
  $('#optPrefix').checked = state.options.prefix !== false
}

async function saveSettings() {
  const out = {
    model: $('#optModel').value || '',
    period: $('#optPeriod').value || 'today',
    prefix: $('#optPrefix').checked,
  }
  const note = $('#saveState')
  try {
    const got = await magpie.options.set(out)
    state.options = Object.assign({}, state.options, got || out)
    note.textContent = '已保存'
    note.dataset.tone = 'ok'
    drawSnippet()
    drawModels()
  } catch (err) {
    note.textContent = '保存失败：' + (err?.message || err)
    note.dataset.tone = 'bad'
  }
  setTimeout(() => { note.textContent = ''; delete note.dataset.tone }, 2000)
}

/* ── tabs ─────────────────────────────── */

/* 控制台地址：页面拿不到插件运行时端口（沙箱，connect-src 'none'），
   所以地址由快照脚本一并写进 models.js（`JET_HUB_CATALOG.console`）；
   快照里没有时才退回默认 18500。
   
   ⚠️ 快照里**模型目录和控制台地址出自同一个宿主**（脚本从活宿主的 /__meta 一次性
   取），所以这里的端口就是模型数对应那台的端口。页面别再自己猜端口：猜必错，
   实测有两个宿主同时在跑、地址文件指向第三台死端口的情况。 */
const CON_PORT_DEFAULT = '18500'

function catalog() {
  return (typeof window.JET_HUB_CATALOG === 'object' && window.JET_HUB_CATALOG) ? window.JET_HUB_CATALOG : {}
}

function conUrl() {
  const fromSnap = catalog().console
  if (typeof fromSnap === 'string' && /^https?:\/\//.test(fromSnap)) return fromSnap
  return `http://127.0.0.1:${CON_PORT_DEFAULT}/`
}

/** 快照里除控制台宿主外还有别的宿主在跑时，返回它们的端口列表（没有就是空）。 */
function otherHosts() {
  const c = catalog()
  const mine = String(c.consolePort || '')
  return (Array.isArray(c.hosts) ? c.hosts : []).filter((h) => String(h?.port || '') && String(h.port) !== mine)
}

function fillConsole() {
  const box = $('#conUrlBox')
  const url = conUrl()
  if (box) box.value = url
  // 快照里的地址可能不是 18500，提示文案要跟着走，别让用户以为写死了
  const note = $('#conUrlNote')
  if (!note) return
  const c = catalog()
  const at = c.generatedAt ? String(c.generatedAt).slice(0, 19).replace('T', ' ') : ''
  const port = String(c.consolePort || '').trim()
  const where = port ? `端口 ${port}` : '端口未知'
  const how = c.consoleFrom === 'probe'
    ? '这台是实测在跑的宿主'
    : c.consoleFrom === 'file'
      ? '⚠ 一个宿主都没探通，地址退回 jet-hub-console.json（可能是死端口）'
      : '⚠ 快照里没有地址，退回默认值'
  const others = otherHosts()
  const extra = others.length
    ? ` ⚠ 另有 ${others.length} 个宿主在跑（:${others.map((h) => h.port).join('、:')}）—— 本页的模型数属 :${port}，连另一台看到的账号会不同。`
    : ''
  note.textContent = at
    ? `${where}（${how}）；模型目录与这个地址出自同一宿主，快照时间 ${at}。${extra}`
    : `${where}（${how}）。模型目录与这个地址出自同一宿主。${extra}`
}

function showTab(name) {
  for (const b of $$('#tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name))
  for (const p of $$('.panel')) p.hidden = p.dataset.panel !== name
  if (name === 'usage') drawUsage()
  if (name === 'console') fillConsole()
}

/* ── 启动 ─────────────────────────────── */

async function main() {
  let theme
  try {
    theme = await magpie.ready
  } catch (err) {
    setState('没连上窗口', 'bad')
    throw err
  }
  setState('已连上 magpie', 'ok')

  const paint = (t) => {
    const lang = $('#lang')
    if (lang) lang.textContent = t?.lang ? '界面语言 ' + t.lang : ''
  }
  paint(theme)
  magpie.onTheme(paint)

  // 自己的选项
  try {
    const got = await magpie.options.get()
    if (got && typeof got === 'object') state.options = Object.assign({}, state.options, got)
  } catch { /* 用默认值 */ }
  state.period = state.options.period || 'today'
  $('#periods') && [...$$('#periods button')].forEach((b) => b.setAttribute('aria-selected', String(b.dataset.period === state.period)))

  // 供应商在不在
  try {
    const list = await magpie.read('providers:list')
    const mine = (Array.isArray(list) ? list : []).filter((p) => isOurs(String(p?.id)))
    if (mine.length === 0) setState('网关里还没有 Jet Hub 的供应商', 'bad')
  } catch { /* 只影响这一行提示 */ }

  // 模型数 / 供应商数
  const n = (CATALOG.models || []).length
  $('#count').textContent = n ? `${n} 个模型` : '暂无模型'
  const pn = Object.keys(CATALOG.providers || {}).length
  if ($('#provCount')) $('#provCount').textContent = pn ? String(pn) : '—'

  // 静态部分
  drawSnippet()
  drawModels()
  drawProviders()
  drawSettings()

  const reads = {
    'providers:list': '供应商的 id 和名字',
    'usage:summary': '用量总计与前 20 个模型',
  }
  const ul = $('#reads')
  ul.replaceChildren()
  for (const name of ['providers:list', 'usage:summary']) {
    const li = el('li')
    li.append(el('code', '', name), el('span', '', '— ' + reads[name]))
    ul.append(li)
  }

  $('#gateway').textContent = CATALOG.gateway || 'http://127.0.0.1:3425'
  $('#prefix').textContent = 'jet-hub-<provider>/'
  $('#ver').textContent = 'magpie-jet-hub'

  /* 事件 */
  for (const b of $$('#tabs button')) b.onclick = () => showTab(b.dataset.tab)

  fillConsole()

  for (const b of $$('#langs button')) b.onclick = () => { state.snippet = b.dataset.snippet; drawSnippet() }

  for (const b of $$('button[data-copy]')) {
    b.onclick = () => {
      const target = $(b.dataset.copy)
      if (target) copy(target.textContent, b)
    }
  }

  $('#q').oninput = (e) => { state.query = e.target.value; drawModels() }

  $('#expand').onclick = () => {
    state.allOpen = !state.allOpen
    for (const d of $$('#groups details')) d.open = state.allOpen
    $('#expand').textContent = state.allOpen ? '全部折叠' : '全部展开'
  }

  $('#copyAll').onclick = () => {
    const ids = (CATALOG.models || []).map(modelId).join('\n')
    copy(ids, $('#copyAll'))
  }

  for (const b of $$('#periods button')) {
    b.onclick = () => {
      state.period = b.dataset.period
      for (const x of $$('#periods button')) x.setAttribute('aria-selected', String(x === b))
      drawUsage()
    }
  }

  $('#onlyMine').onchange = (e) => { state.onlyMine = e.target.checked; drawUsage() }

  $('#save').onclick = saveSettings
  $('#optPrefix').onchange = () => { /* 保存后生效 */ }

  // 首次进入看用法
  showTab('start')
}

main().catch((err) => {
  try {
    parent.postMessage({ magpie: 1, method: 'error', params: { message: String(err?.message || err) } }, '*')
  } catch {}
})
