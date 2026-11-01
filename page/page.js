// Jet Hub 的 magpie 插件页。
//
// 跑在 magpie 窗口的沙箱 iframe 里（sandbox allow-scripts，connect-src 'none'）：
// 不能联网，也不能碰 magpie 的 /api。能拿到的只有 bridge 铺好的这几样：
//
//   await magpie.ready            窗口答上话后拿到主题 {dark, lang, tokens}
//   magpie.onTheme(fn)            主题或语言变了就调一次
//   await magpie.read(name, p)    只有 package.json 里 magpie.permissions 声明的
//                                 · providers:list → [{id, name}]
//                                   （只用来数有几家、判断本体装没装进来；
//                                     用量不在这里读 —— 那是 magpie 自己 Usage 页的事）
//   await magpie.options.get()    本插件自己的选项
//   await magpie.options.set(o)   写回（窗口限 1 秒 1 次）
//
// 模型目录读不到（页面不能联网，providers:list 也不给模型），所以用
// page/models.js 里的快照，由 scripts/snapshot-models.mjs 生成。快照只用于
// 三件事：设置页的默认模型下拉、顶部的模型计数、控制台地址（快照里一并写了）。

// 对外网关的**兜底**地址：真值来自 page/models.js 快照的 `gateway` 字段，而那个
// 字段由 scripts/snapshot-models.mjs 写入（可用 JET_HUB_USER_GATEWAY 覆盖，与
// src/container.mjs 的 DEFAULT_USER_GATEWAY 同一个值）。这里只兜「快照还没生成
// 或字段缺失」的情况，别在三处各写一份裸字面量。
const DEFAULT_USER_GATEWAY = 'http://127.0.0.1:3425'

const CATALOG = window.JET_HUB_CATALOG || { models: [], providers: {}, generatedAt: '', gateway: DEFAULT_USER_GATEWAY }

/* 每个本体 provider 都是独立的 magpie provider：jet-hub / jet-hub-codearts / …
   模型 id 形如 `jet-hub-codearts/deepseek-v4.1-flash`（第一段是 provider id）。 */
const isOurs = (seg) => seg === 'jet-hub' || String(seg).startsWith('jet-hub-')

const state = {
  options: { model: '', prefix: true },
  snippet: 'curl',
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
  // 两个路由组（本体 `aggregate` / `jet-hub-auto`）不注册成 magpie provider，
  // 所以这里只有 `jet-hub-<本体名>` 一种形态，剥掉前缀就是本体 id。
  const upstream = seg.slice('jet-hub-'.length)
  return `${upstream}/${s.slice(seg.length + 1)}`
}

function modelId(m) {
  const id = String(m || '')
  return state.options.prefix ? id : bare(id)
}

/* ── 接入：代码片段 ───────────────────── */

function snippetFor(lang) {
  const gw = CATALOG.gateway || DEFAULT_USER_GATEWAY
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

/* ── 设置 ─────────────────────────────── */

function drawSettings() {
  const sel = $('#optModel')
  sel.replaceChildren(new Option('（不设置）', ''))
  for (const m of CATALOG.models || []) sel.append(new Option(modelId(m), m))
  sel.value = state.options.model || ''
  $('#optPrefix').checked = state.options.prefix !== false
}

async function saveSettings() {
  const out = {
    model: $('#optModel').value || '',
    prefix: $('#optPrefix').checked,
  }
  const note = $('#saveState')
  try {
    const got = await magpie.options.set(out)
    state.options = Object.assign({}, state.options, got || out)
    note.textContent = '已保存'
    note.dataset.tone = 'ok'
    drawSnippet()
    drawSettings()
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
  drawSettings()

  const reads = {
    'providers:list': '供应商的 id 和名字（只用来数有几家、判断有没有装进来）',
  }
  const ul = $('#reads')
  ul.replaceChildren()
  for (const name of ['providers:list']) {
    const li = el('li')
    li.append(el('code', '', name), el('span', '', '— ' + reads[name]))
    ul.append(li)
  }

  $('#gateway').textContent = CATALOG.gateway || DEFAULT_USER_GATEWAY
  $('#prefix').textContent = 'jet-hub-<provider>/'
  $('#ver').textContent = 'magpie-jet-hub'

  /* 事件 */
  for (const b of $$('#tabs button')) b.onclick = () => showTab(b.dataset.tab)

  fillConsole()

  for (const b of $$('#langs button')) b.onclick = () => { state.snippet = b.dataset.snippet; drawSnippet() }

  for (const b of $$('button[data-copy]')) {
    b.onclick = () => {
      const target = $(b.dataset.copy)
      // <input readonly> 的 textContent 恒为空，值在 value 上（控制台地址框就是这种）
      if (target) copy(target.value ?? target.textContent, b)
    }
  }

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
