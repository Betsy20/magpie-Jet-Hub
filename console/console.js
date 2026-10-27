// Jet Hub 控制台前端。全部能力走插件本体注册的 Jet Hub 管理 API：
//   POST /api/jet-hub  {type:'client-request', rpcId, method:'jet-hub', payload:{method, payload}}
//   ← {type:'server-response', rpcId, result:{ok:true, value} | {ok:false, error}}
// 方法名与字段取自 vendor/lib/jet-hub-rpc.js 的 switch（已逐个核对）。
'use strict'

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]

/** HTML 转义：所有来自本体/账号数据的字符串都要过这一道。 */
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

let META = { providers: [], gateway: {}, models: 0 }

async function rpc(method, payload = {}) {
  const body = {
    type: 'client-request',
    rpcId: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    method: 'jet-hub',
    payload: { method, payload },
  }
  const res = await fetch('/api/jet-hub', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  const result = json?.result
  if (!result) throw new Error('本体没有返回 result')
  if (result.ok === false) throw new Error(result.error?.message ?? result.error?.code ?? '调用失败')
  return result.value
}

/** 给按钮挂一个「执行中…」状态，避免连点。 */
async function busy(btn, fn) {
  const old = btn?.textContent
  if (btn) {
    btn.disabled = true
    btn.textContent = '…'
  }
  try {
    return await fn()
  } finally {
    if (btn) {
      btn.disabled = false
      btn.textContent = old
    }
  }
}

function say(el, text, kind = '') {
  if (!el) return
  el.textContent = text
  el.className = `msg ${kind}`
}

function relTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
  const d = ms - Date.now()
  const abs = Math.abs(d)
  const min = Math.round(abs / 60000)
  const unit = min < 60 ? `${min} 分钟` : min < 1440 ? `${Math.round(min / 60)} 小时` : `${Math.round(min / 1440)} 天`
  return d >= 0 ? `剩 ${unit}` : `已过 ${unit}`
}

function fmtTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 通用渲染：数组套对象渲染成表，对象渲染成键值行，其余进 pre。 */
function renderGeneric(host, value) {
  host.innerHTML = ''
  if (value === undefined || value === null) {
    host.innerHTML = '<p class="muted">（无返回）</p>'
    return
  }
  if (Array.isArray(value) && value.length && typeof value[0] === 'object') {
    const cols = [...new Set(value.flatMap((r) => Object.keys(r ?? {})))]
    const t = document.createElement('div')
    t.className = 'tablewrap'
    t.innerHTML = `<table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${value
      .map((r) => `<tr>${cols.map((c) => `<td class="mono">${esc(typeof r?.[c] === 'object' ? JSON.stringify(r[c]) : r?.[c])}</td>`).join('')}</tr>`)
      .join('')}</tbody></table>`
    host.appendChild(t)
    return
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const rows = Object.entries(value)
    host.innerHTML = `<div class="tablewrap"><table><tbody>${rows
      .map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td class="mono">${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</td></tr>`)
      .join('')}</tbody></table></div>`
    return
  }
  host.innerHTML = `<div class="code">${esc(String(value))}</div>`
}

/* ---------------- 概览 ---------------- */

function renderOverview() {
  const cards = [
    ['provider', META.providers.length, '本体带来的渠道数'],
    ['模型', META.models, '网关 /v1/models 当前条数'],
    ['网关端口', META.gateway?.port ?? '—', '只监听回环'],
    ['本体版本', META.version ?? '—', 'deepseek-harness-codearts'],
  ]
  $('#cards').innerHTML = cards
    .map(([k, v, s]) => `<div class="cardc"><span>${esc(k)}</span><b>${esc(v)}</b><span>${esc(s)}</span></div>`)
    .join('')
  $('#provList').innerHTML = META.providers
    .map((p) => `<span class="chip" title="${esc(p.name ?? p.id)}"><b>${esc(p.id)}</b><i>${p.models?.length ?? 0}</i></span>`)
    .join('')
  const base = META.gateway?.baseURL ?? '—'
  $('#gwCode').textContent = [
    `OpenAI 兼容地址（magpie 内部使用）：${base}`,
    `模型 id 前缀：jet-hub/<provider>/<model>`,
    ``,
    `# 直接验证`,
    `curl -s ${base}/models -H "Authorization: Bearer <插件内部 key>" | head -c 400`,
  ].join('\n')
  $('#gw').textContent = base
}

/* ---------------- 账号 ---------------- */

let ACC = []

async function loadAccounts() {
  const provider = $('#accProvider').value
  if (!provider) return
  say($('#accMsg'), '读取中…')
  try {
    ACC = (await rpc('account.list', { provider }))?.accounts ?? []
    renderAccounts()
    say($('#accMsg'), `${ACC.length} 个账号`, 'ok')
  } catch (e) {
    say($('#accMsg'), String(e.message ?? e), 'err')
  }
}

function renderAccounts() {
  const rows = ACC.map((a, i) => {
    const dead = a.refreshable === false && typeof a.expiresAt === 'number' && a.expiresAt < Date.now()
    const status = a.enabled === false ? '<span class="pill off">停用</span>' : '<span class="pill on">启用</span>'
    return `<tr>
      <td>${esc(a.nickname ?? a.id)}<div class="muted mono">${esc(a.id)}</div></td>
      <td>${status}${dead ? ' <span class="pill warn">死号</span>' : ''}</td>
      <td class="mono">${esc(fmtTime(a.expiresAt))}<div class="muted">${esc(relTime(a.expiresAt))}</div></td>
      <td>${a.refreshable === false ? '<span class="pill off">否</span>' : '<span class="pill on">是</span>'}</td>
      <td><div class="ops">
        <button data-act="toggle" data-id="${esc(a.id)}">${a.enabled === false ? '启用' : '停用'}</button>
        <button data-act="refresh" data-id="${esc(a.id)}">续期</button>
        <button data-act="test" data-id="${esc(a.id)}">测试</button>
        <button data-act="reset" data-id="${esc(a.id)}">重置</button>
        <button data-act="up" data-id="${esc(a.id)}" ${i === 0 ? 'disabled' : ''}>上移</button>
        <button data-act="down" data-id="${esc(a.id)}" ${i === ACC.length - 1 ? 'disabled' : ''}>下移</button>
        <button data-act="del" data-id="${esc(a.id)}">删除</button>
      </div></td>
    </tr>`
  })
  $('#accTable').innerHTML = `<thead><tr><th>账号</th><th>状态</th><th>到期</th><th>可续期</th><th>操作</th></tr></thead><tbody>${
    rows.join('') || '<tr><td colspan="5" class="muted">这个 provider 下还没有账号</td></tr>'
  }</tbody>`
}

async function onAccAction(e) {
  const btn = e.target.closest('button[data-act]')
  if (!btn) return
  const provider = $('#accProvider').value
  const id = btn.dataset.id
  const act = btn.dataset.act
  try {
    await busy(btn, async () => {
      if (act === 'toggle') {
        const a = ACC.find((x) => x.id === id)
        await rpc('account.update', { accountId: id, patch: { enabled: a?.enabled === false } })
      } else if (act === 'refresh') {
        await rpc('account.refresh', { accountId: id })
      } else if (act === 'test') {
        const v = await rpc('account.test', { accountId: id })
        say($('#accMsg'), `测试结果：${JSON.stringify(v).slice(0, 200)}`, 'ok')
        return
      } else if (act === 'reset') {
        await rpc('account.reset', { accountId: id })
      } else if (act === 'del') {
        if (!confirm(`删除账号 ${id}？凭据也会一起清掉。`)) return
        await rpc('account.delete', { accountId: id })
      } else if (act === 'up' || act === 'down') {
        const ids = ACC.map((x) => x.id)
        const i = ids.indexOf(id)
        const j = act === 'up' ? i - 1 : i + 1
        if (j < 0 || j >= ids.length) return
        ;[ids[i], ids[j]] = [ids[j], ids[i]]
        await rpc('account.reorder', { provider, orderedIds: ids })
      }
    })
    await loadAccounts()
  } catch (err) {
    say($('#accMsg'), String(err.message ?? err), 'err')
  }
}

/* --- 登录流程 --- */
let loginTimer

function closeLogin() {
  clearInterval(loginTimer)
  loginTimer = undefined
  $('#loginModal').hidden = true
}

async function startLogin(provider) {
  const v = await rpc('account.create', { provider })
  const { accountId, loginUrl } = v ?? {}
  if (!loginUrl) throw new Error('本体没有返回 loginUrl')
  $('#lmProvider').textContent = provider
  $('#lmUrl').textContent = loginUrl
  $('#lmOpen').href = loginUrl
  $('#lmState').textContent = '等待授权…'
  $('#lmState').className = 'msg'
  $('#loginModal').hidden = false
  try {
    window.open(loginUrl, '_blank', 'noreferrer')
  } catch {
    /* 沙箱里可能被拦，界面里已经给了地址与按钮 */
  }
  const started = Date.now()
  clearInterval(loginTimer)
  loginTimer = setInterval(async () => {
    if (Date.now() - started > 5 * 60 * 1000) {
      $('#lmState').textContent = '超时（5 分钟），可关闭后重试'
      $('#lmState').className = 'msg err'
      clearInterval(loginTimer)
      return
    }
    try {
      const s = await rpc('login.poll', { accountId })
      if (s?.done === true) {
        clearInterval(loginTimer)
        if (s.success === false) {
          $('#lmState').textContent = `登录失败：${s.error ?? '未知原因'}`
          $('#lmState').className = 'msg err'
        } else {
          $('#lmState').textContent = '✓ 登录成功'
          $('#lmState').className = 'msg ok'
          setTimeout(() => {
            closeLogin()
            loadAccounts()
          }, 900)
        }
      }
    } catch (e) {
      $('#lmState').textContent = `轮询出错：${e.message ?? e}`
      $('#lmState').className = 'msg err'
    }
  }, 2000)
}

/* ---------------- 积分 ---------------- */

async function creditsStatus(btn) {
  const provider = $('#credProvider').value
  try {
    await busy(btn, async () => {
      const v = await rpc('credits.status', { provider })
      renderGeneric($('#credOut'), v)
      say($('#credMsg'), '已查询', 'ok')
    })
  } catch (e) {
    say($('#credMsg'), String(e.message ?? e), 'err')
  }
}

async function creditsBalances(btn) {
  const provider = $('#credProvider').value
  try {
    await busy(btn, async () => {
      const v = await rpc('credits.balances', { provider })
      renderGeneric($('#credOut'), v)
      say($('#credMsg'), '已查询余额', 'ok')
    })
  } catch (e) {
    say($('#credMsg'), String(e.message ?? e), 'err')
  }
}

async function creditsClaim(btn) {
  const provider = $('#credProvider').value
  try {
    await busy(btn, async () => {
      const v = await rpc('credits.claimAll', { provider })
      renderGeneric($('#credOut'), v)
      say($('#credMsg'), '已执行领取', 'ok')
    })
  } catch (e) {
    say($('#credMsg'), String(e.message ?? e), 'err')
  }
}

/* ---------------- 模型 ---------------- */

async function loadModels(btn) {
  const provider = $('#modProvider').value
  try {
    await busy(btn, async () => {
      const v = await rpc('model.list', { provider })
      const models = v?.models ?? []
      $('#modTable').innerHTML = `<thead><tr><th>模型</th><th>显示名</th><th>状态</th><th>开关</th></tr></thead><tbody>${
        models
          .map(
            (m) => `<tr>
          <td class="mono">${esc(m.id)}</td>
          <td>${esc(m.name ?? '')}</td>
          <td>${m.disabled ? '<span class="pill off">已关闭</span>' : '<span class="pill on">可用</span>'}${m.dead ? ' <span class="pill warn">deleted</span>' : ''}</td>
          <td><button data-model="${esc(m.id)}" data-disabled="${m.disabled ? '1' : ''}">${m.disabled ? '打开' : '关闭'}</button></td>
        </tr>`,
          )
          .join('') || '<tr><td colspan="4" class="muted">这个 provider 没有模型</td></tr>'
      }</tbody>`
      say($('#modMsg'), `${models.length} 个模型`, 'ok')
    })
  } catch (e) {
    say($('#modMsg'), String(e.message ?? e), 'err')
  }
}

async function onModelToggle(e) {
  const btn = e.target.closest('button[data-model]')
  if (!btn) return
  const provider = $('#modProvider').value
  const modelId = btn.dataset.model
  const disabled = btn.dataset.disabled !== '1'
  try {
    await busy(btn, () => rpc('model.setDisabled', { provider, modelId, disabled }))
    await loadModels()
  } catch (err) {
    say($('#modMsg'), String(err.message ?? err), 'err')
  }
}

/* ---------------- 备份 ---------------- */

async function loadBackup() {
  try {
    const v = await rpc('backup.status')
    $('#bkCards').innerHTML = [
      ['账号总数', v?.accounts ?? '—'],
      ['缺有效期', v?.withoutExpiry ?? '—'],
    ]
      .map(([k, n]) => `<div class="cardc"><span>${esc(k)}</span><b>${esc(n)}</b></div>`)
      .join('')
  } catch (e) {
    say($('#bkMsg'), String(e.message ?? e), 'err')
  }
}

async function doExport(btn) {
  try {
    await busy(btn, async () => {
      const v = await rpc('backup.export', {})
      const text = JSON.stringify(v, null, 2)
      const blob = new Blob([text], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      const d = new Date()
      const p = (n) => String(n).padStart(2, '0')
      a.download = `jet-hub-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 4000)
      say($('#bkMsg'), `已导出（${text.length} 字节）`, 'ok')
    })
  } catch (e) {
    say($('#bkMsg'), String(e.message ?? e), 'err')
  }
}

async function doImport(btn) {
  const file = $('#bkFile').files?.[0]
  if (!file) {
    say($('#bkMsg'), '先选一个备份文件', 'err')
    return
  }
  const mode = $('#bkMode').value
  if (mode === 'replace' && !confirm('覆盖模式会清掉现有账号池，确认？')) return
  try {
    await busy(btn, async () => {
      const text = await file.text()
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error('文件不是合法 JSON')
      }
      const v = await rpc('backup.import', { payload: parsed, mode })
      renderGeneric($('#bkOut'), v)
      say($('#bkMsg'), '导入完成', 'ok')
    })
    await loadBackup()
  } catch (e) {
    say($('#bkMsg'), String(e.message ?? e), 'err')
  }
}

/* ---------------- 设置 ---------------- */

async function loadSettings() {
  try {
    const [gw, ns, pe] = await Promise.all([
      rpc('gateway.getEnabled').catch(() => ({})),
      rpc('nativeSearch.getEnabled').catch(() => ({})),
      rpc('panelEntry.get').catch(() => ({})),
    ])
    $('#setGateway').checked = (gw?.enabled ?? gw?.desired ?? false) === true
    $('#setSearch').checked = ns?.enabled === true
    if (pe?.entry) $('#setPanel').value = pe.entry
    say($('#setMsg'), '')
  } catch (e) {
    say($('#setMsg'), String(e.message ?? e), 'err')
  }
}

async function saveSetting(what, value) {
  try {
    if (what === 'gateway') await rpc('gateway.setEnabled', { enabled: value })
    if (what === 'search') await rpc('nativeSearch.setEnabled', { enabled: value })
    if (what === 'panel') await rpc('panelEntry.set', { entry: value })
    say($('#setMsg'), '已保存', 'ok')
  } catch (e) {
    say($('#setMsg'), String(e.message ?? e), 'err')
  }
}

/* ---------------- 启动 ---------------- */

function fillProviderSelects() {
  const opts = META.providers.map((p) => `<option value="${esc(p.id)}">${esc(p.id)}（${p.models?.length ?? 0}）</option>`).join('')
  for (const sel of ['#accProvider', '#credProvider', '#modProvider']) {
    const el = $(sel)
    el.innerHTML = opts
  }
  if (META.providers.length) {
    // 默认选一个有账号的：先用第一个有模型的
    const first = META.providers.find((p) => (p.models?.length ?? 0) > 0) ?? META.providers[0]
    for (const sel of ['#accProvider', '#credProvider', '#modProvider']) $(sel).value = first.id
  }
}

function wireTabs() {
  $('#nav').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]')
    if (!b) return
    $$('#nav button').forEach((x) => x.classList.toggle('on', x === b))
    $$('.tab').forEach((t) => t.classList.toggle('on', t.id === `tab-${b.dataset.tab}`))
    if (b.dataset.tab === 'accounts') loadAccounts()
    if (b.dataset.tab === 'backup') loadBackup()
    if (b.dataset.tab === 'settings') loadSettings()
  })
}

async function boot() {
  try {
    const res = await fetch('/__meta')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    META = await res.json()
  } catch (e) {
    $('#boot').textContent = `连不上插件本体的本地服务：${e.message ?? e}`
    return
  }
  $('#boot').hidden = true
  $('#app').hidden = false
  $('#health').className = 'dot ok'

  fillProviderSelects()
  renderOverview()
  wireTabs()

  $('#accReload').addEventListener('click', () => loadAccounts())
  $('#accProvider').addEventListener('change', () => loadAccounts())
  $('#accTable').addEventListener('click', onAccAction)
  $('#accAdd').addEventListener('click', async () => {
    const provider = $('#accProvider').value
    try {
      await busy($('#accAdd'), () => startLogin(provider))
    } catch (e) {
      say($('#accMsg'), String(e.message ?? e), 'err')
    }
  })
  $('#lmCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#lmUrl').textContent)
      $('#lmState').textContent = '已复制'
    } catch {
      $('#lmState').textContent = '复制失败，请手动选中'
    }
  })
  $('#lmClose').addEventListener('click', closeLogin)

  $('#credLoad').addEventListener('click', (e) => creditsStatus(e.currentTarget))
  $('#credBalances').addEventListener('click', (e) => creditsBalances(e.currentTarget))
  $('#credClaim').addEventListener('click', (e) => creditsClaim(e.currentTarget))
  $('#credProvider').addEventListener('change', () => ($('#credOut').innerHTML = ''))

  $('#modLoad').addEventListener('click', (e) => loadModels(e.currentTarget))
  $('#modProvider').addEventListener('change', () => loadModels())
  $('#modTable').addEventListener('click', onModelToggle)

  $('#bkExport').addEventListener('click', (e) => doExport(e.currentTarget))
  $('#bkImport').addEventListener('click', (e) => doImport(e.currentTarget))

  $('#setGateway').addEventListener('change', (e) => saveSetting('gateway', e.target.checked))
  $('#setSearch').addEventListener('change', (e) => saveSetting('search', e.target.checked))
  $('#setPanel').addEventListener('change', (e) => saveSetting('panel', e.target.value))

  loadAccounts()
}

boot()
