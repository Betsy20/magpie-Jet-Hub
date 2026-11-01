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


/* 按钮文案临时改一下，1.6 秒后还原。原文存在 dataset 里，连点不会串。 */
function flash(btn, text, ok = false) {
  if (!btn) return
  // ⚠️ 用 hasOwnProperty 判「存过没」而不是 `if (!dataset.label)`：按钮文案为空串时
  // 后者会把 "" 再存一次、还原时又因空串 falsy 而不还原 ⇒ 按钮永久停在「已复制」。
  if (!Object.prototype.hasOwnProperty.call(btn.dataset, 'label')) {
    btn.dataset.label = btn.textContent
    btn.dataset.html = btn.innerHTML
  }
  btn.textContent = text
  // 只有成功才变绿：失败文案（「复制失败」「没有可复制的内容」）也走这个函数，
  // 无条件设 data-done 会让失败看起来像成功。
  if (ok) btn.dataset.done = '1'
  clearTimeout(Number(btn.dataset.flashTimer) || 0)
  btn.dataset.flashTimer = String(setTimeout(() => {
    // 用 innerHTML 还原：按钮里若有 <span class="ico"> 之类子元素，textContent 会把它们拍平
    if (btn.dataset.html !== undefined) btn.innerHTML = btn.dataset.html
    else btn.textContent = btn.dataset.label
    delete btn.dataset.done
  }, 1600))
}

/* 老办法写剪贴板：造一个屏幕外的 textarea，选中后 execCommand('copy')。
   不需要权限、不需要安全上下文，在沙箱 iframe 里也能用。 */
function copyByExecCommand(text) {
  let ok = false
  let ta
  // 造 textarea 会把焦点抢走（原焦点变成 body）。记下来，结束时还回去 ——
  // magpie 自己的 copyByCommand 也是这么做的（internal/gui/assets/app.js）。
  const was = document.activeElement
  try {
    ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0'
    document.body.append(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    ok = document.execCommand('copy')
  } catch {
    ok = false
  } finally {
    if (ta) ta.remove()
    if (was && typeof was.focus === 'function' && was !== document.body) {
      try { was.focus({ preventScroll: true }) } catch { /* 焦点还回去失败不影响复制结果 */ }
    }
  }
  return ok === true
}

/* 直接对当前选区执行 copy —— 配合 selectTextOf 用。 */
function copySelection() {
  try {
    return document.execCommand('copy') === true
  } catch {
    return false
  }
}

/* 前两级都失败时，把目标内容选中，让用户自己按 Ctrl+C。 */
function selectTextOf(node) {
  if (!node) return false
  try {
    if (typeof node.select === 'function') {
      node.focus()
      node.select()
      return true
    }
    const range = document.createRange()
    range.selectNodeContents(node)
    const sel = window.getSelection()
    if (!sel) return false
    sel.removeAllRanges()
    sel.addRange(range)
    return true
  } catch {
    return false
  }
}

/* 复制走三级降级。下面这条是实测出来的（CDP 起真 Edge，复刻 magpie 的加载条件：
   <iframe sandbox="allow-scripts" allow="" referrerpolicy="no-referrer"> + pagePolicy() 的完整 CSP）。

   ⚠️ 根因是 **Permissions Policy**，不是「文档没有焦点」：
   magpie 给插件页 iframe 设了 allow=""（internal/gui/assets/pluginpages.js 里
   f.setAttribute("allow", "")），等于把 clipboard-write 从本页彻底关掉 ⇒
     writeText 抛 NotAllowedError: The Clipboard API has been blocked because of a
     permissions policy applied to the current document.
   对照实验证实了因果：allow="" + CSP → 该错误；去掉 sandbox 指令仍是该错误；
   而 allow="clipboard-write; clipboard-read" → writeText 直接成功。
   （所以别去调「焦点」——那不是在 magpie 里失败的原因。）

   顺带纠正一个易混点：sandbox 没有 allow-same-origin 时，不透明源体现在
   self.origin === "null"，而 location.origin 仍是正常 URL；两者不要混着说。

   三级降级：
   ① navigator.clipboard —— 普通网页（含控制台 http://127.0.0.1:18500）最稳；
   ② execCommand('copy') —— 先选中真实目标再 copy，不依赖权限与安全上下文，
      沙箱 iframe 里也能用（实测四个按钮全走这一级成功）；
   ③ 选中目标文本 + 提示手动复制 —— 万一浏览器连 execCommand 也禁了。 */
async function copy(text, btn, target) {
  const val = String(text ?? '')
  if (val === '') {
    flash(btn, '没有可复制的内容')
    return false
  }
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(val)
      flash(btn, '已复制', true)
      return true
    } catch {
      /* 沙箱 iframe 里必定走到这里，继续降级 */
    }
  }
  // 先试「选中真实目标 → copy」：选区落在用户看得见的元素上，比临时 textarea 稳。
  // 实测（真 Edge + 真实鼠标点击）：这一级返回 true，剪贴板真的写进去了。
  if (selectTextOf(target) && copySelection()) {
    flash(btn, '已复制', true)
    return true
  }
  if (copyByExecCommand(val)) {
    flash(btn, '已复制', true)
    return true
  }
  if (selectTextOf(target)) {
    flash(btn, '已选中，按 Ctrl+C', true)
    return true
  }
  flash(btn, '复制失败')
  return false
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
      // <input readonly> 的 textContent 恒为空，值在 value 上（控制台地址框就是这种）；
      // 第三个参数是降级用的目标节点 —— 前面两级都写不进剪贴板时选中它让用户手动复制
      if (target) copy(target.value ?? target.textContent, b, target)
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
