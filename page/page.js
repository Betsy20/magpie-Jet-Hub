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

const PROVIDER = 'jet-hub'
const PREFIX = PROVIDER + '/'
const CATALOG = window.JET_HUB_CATALOG || { models: [], providers: {}, generatedAt: '', gateway: 'http://127.0.0.1:3425' }

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

// jet-hub/workbuddy/x → workbuddy/x
function bare(id) {
  const s = String(id || '')
  return s.startsWith(PREFIX) ? s.slice(PREFIX.length) : s
}

// 复制时用不用带前缀，看设置
function modelId(m) {
  const id = String(m || '')
  if (id.startsWith(PREFIX)) return state.options.prefix ? id : bare(id)
  return state.options.prefix ? PREFIX + id : id
}

function providerOf(model) {
  const seg = String(model || '').split('/')[0]
  return CATALOG.providers?.[seg] || null
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

  for (const [seg, list] of rows) {
    const hit = q ? list.filter((m) => m.toLowerCase().includes(q) || seg.includes(q)) : list
    const name = CATALOG.providers?.[seg]?.name || seg
    const nameHit = q && (name.toLowerCase().includes(q) || seg.includes(q))
    if (!hit.length && !nameHit) continue
    shown += hit.length || list.length

    const detail = el('details', 'group')
    detail.open = state.allOpen || Boolean(q)
    const sum = el('summary')
    sum.append(el('span', '', name), el('span', 'pid', seg), el('span', 'n', `${list.length}`))
    detail.append(sum)
    const wrap = el('div', 'mlist')
    for (const m of (hit.length ? hit : list)) {
      const chip = el('button', 'mid')
      chip.type = 'button'
      chip.title = '点一下复制 ' + modelId(m)
      const pfx = el('span', 'pfx', state.options.prefix ? PREFIX : '')
      chip.append(pfx, document.createTextNode(m))
      chip.onclick = () => copy(modelId(m), chip).then((ok) => {
        if (ok) { const old = chip.textContent; chip.dataset.done = '1'; chip.textContent = '已复制 ' + modelId(m); setTimeout(() => { chip.replaceChildren(pfx, document.createTextNode(m)); delete chip.dataset.done }, 1400) }
      })
      wrap.append(chip)
    }
    detail.append(wrap)
    box.append(detail)
  }

  if (!shown) box.append(el('p', 'wait', `没有匹配「${state.query}」的模型`))

  const when = CATALOG.generatedAt ? new Date(CATALOG.generatedAt).toLocaleString('zh-CN', { hour12: false }) : '未知'
  $('#modelsHint').textContent = `已知 ${models.length} 个模型，快照于 ${when}。账号变动后跑 node scripts/snapshot-models.mjs 刷新；实时列表以「供应商 → Jet Hub」为准。`
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
    if (isMine(m.model)) name.append(el('span', 'tag', 'jet-hub'))
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

function showTab(name) {
  for (const b of $$('#tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name))
  for (const p of $$('.panel')) p.hidden = p.dataset.panel !== name
  if (name === 'usage') drawUsage()
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
    const mine = (Array.isArray(list) ? list : []).find((p) => String(p?.id) === PROVIDER)
    if (!mine) setState('网关里还没有这个供应商', 'bad')
    else if (mine.name && mine.name !== 'Jet Hub') $('.hero h1').textContent = mine.name
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
  $('#prefix').textContent = PREFIX
  $('#ver').textContent = 'magpie-jet-hub'

  /* 事件 */
  for (const b of $$('#tabs button')) b.onclick = () => showTab(b.dataset.tab)

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
