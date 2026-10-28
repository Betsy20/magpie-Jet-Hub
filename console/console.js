// Jet Hub 控制台前端。全部能力走插件本体注册的 Jet Hub 管理 API：
//   POST /api/jet-hub  {type:'client-request', rpcId, method:'jet-hub', payload:{method, payload}}
//   ← {type:'server-response', rpcId, result:{ok:true, value} | {ok:false, error}}
// 方法名与字段取自 vendor/lib/jet-hub-rpc.js 的 switch（已逐个核对）。
// 覆盖：account.* / credits.* / cline.quota / officeace.status / model.* / provider.* /
//       aggregate.* / gateway.* / nativeSearch.* / panelEntry.* / minimax.* / captcha.* /
//       usage.* / backup.* / login.* / onboarding.*
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
  el = typeof el === 'string' ? $(el) : el
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
  host = typeof host === 'string' ? $(host) : host
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

/* ═══════════════════ 概览 ═══════════════════ */

function renderOverview() {
  // `META.models` 现在是上游全量（含已关闭），`liveModels` 是网关此刻能用的
  const full = Number(META.models) || 0
  const live = Number(META.liveModels) || 0
  const cards = [
    ['provider', META.providers.length, '本体带来的渠道数'],
    ['模型', full, live > 0 && live !== full ? `上游全量（网关可用 ${live}）` : '上游全量目录'],
    ['连接方式', META.gateway?.mode === 'direct' ? '直连本体' : (META.gateway?.port ?? '—'), META.gateway?.mode === 'direct' ? '进程内调 ctx.llm，无本地端口' : '只监听回环'],
    ['本体版本', META.version ?? '—', 'deepseek-harness-codearts'],
  ]
  $('#cards').innerHTML = cards
    .map(([k, v, s]) => `<div class="cardc"><span>${esc(k)}</span><b>${esc(v)}</b><span>${esc(s)}</span></div>`)
    .join('')
  $('#provList').innerHTML = META.providers
    .map((p) => `<span class="chip" title="${esc(p.name ?? p.id)}"><b>${esc(p.id)}</b><i>${p.models?.length ?? 0}</i></span>`)
    .join('')
  const base = META.gateway?.baseURL ?? '—'
  // 直连模式下**没有**本地网关端口，别再让用户去找 1839x（那是老版本的事）。
  const direct = META.gateway?.mode === 'direct'
  $('#gwCode').textContent = direct
    ? [
        '直连模式：本插件不开本地 OpenAI 网关端口，',
        '请求在进程内直接交给本体 llm 服务（ctx.llm）。',
        '',
        '对外统一走 magpie 网关（模型 id 前缀 jet-hub/<provider>/<model>）：',
        '  http://127.0.0.1:3425/v1',
        '',
        '# 直接验证（需 magpie 在跑）',
        'curl -s http://127.0.0.1:3425/v1/models | head -c 400',
      ].join('\n')
    : [
        `OpenAI 兼容地址（magpie 内部使用）：${base}`,
        `模型 id 前缀：jet-hub/<provider>/<model>`,
        ``,
        `# 直接验证`,
        `curl -s ${base}/models -H "Authorization: Bearer <插件内部 key>" | head -c 400`,
      ].join('\n')
  $('#gw').textContent = direct ? 'http://127.0.0.1:3425/v1' : base
  loadGatewayCards()
  loadAutoCheckin($('#acOut'))
}

async function loadGatewayCards() {
  try {
    const g = await rpc('gateway.getEnabled')
    const rows = [
      ['启用', g?.enabled === true ? '是' : '否'],
      ['运行中', g?.running === true ? '是' : '否'],
      ['被环境变量挡住', g?.blockedByEnv === true ? '是（DSH_OPENAI_GATEWAY_* 优先）' : '否'],
      ['允许局域网', g?.allowLan === true ? '是' : '否'],
      ['监听', `${g?.address?.host ?? '—'}:${g?.address?.port ?? '—'}`],
      ['最近错误', g?.lastError ?? '无'],
    ]
    $('#gwCards').innerHTML = rows
      .map(([k, v]) => `<div class="cardc"><span>${esc(k)}</span><b class="mono">${esc(v)}</b></div>`)
      .join('')
  } catch (e) {
    say('#gwCards', String(e.message ?? e), 'err')
  }
}

async function loadAutoCheckin(host) {
  host = typeof host === 'string' ? $(host) : host
  if (!host) return
  try {
    const v = await rpc('usage.autoCheckin')
    const ac = v?.autoCheckin ?? {}
    // 本体 channels 的形状是 {provider, text}（text 是「今天的情况」一句话），
    // 不是 {enabled, lastDate, lastResult} —— 按字面读会渲染出一列空。
    const channels = Array.isArray(ac.channels) ? ac.channels : []
    host.innerHTML = `<div class="cards">${[
      ['开关', ac.enabled === true ? '开' : '关'],
      ['今天已跑', ac.ranToday === true ? '是' : '否'],
      ['运行中', ac.running === true ? '是' : '否'],
      ['上次', ac.lastDate ?? '—'],
    ]
      .map(([k, v]) => `<div class="cardc"><span>${esc(k)}</span><b>${esc(v)}</b></div>`)
      .join('')}</div>
      ${ac.lastResult ? `<p class="muted">${esc(ac.lastResult)}</p>` : ''}
      ${
        channels.length
          ? `<div class="tablewrap"><table><thead><tr><th>渠道</th><th>今天</th></tr></thead><tbody>${channels
              .map((c) => `<tr><td class="mono">${esc(c.provider)}</td><td class="muted">${esc(c.text ?? '')}</td></tr>`)
              .join('')}</tbody></table></div>`
          : ''
      }`
  } catch (e) {
    host.innerHTML = `<p class="msg err">${esc(String(e.message ?? e))}</p>`
  }
}

/* ═══════════════════ 账号 ═══════════════════ */

let ACC = []

async function loadAccounts() {
  const provider = $('#accProvider').value
  if (!provider) return
  say('#accMsg', '读取中…')
  try {
    ACC = (await rpc('account.list', { provider }))?.accounts ?? []
    renderAccounts()
    syncProxyButtons()
    say('#accMsg', `${ACC.length} 个账号`, 'ok')
  } catch (e) {
    say('#accMsg', String(e.message ?? e), 'err')
  }
}

function renderAccounts() {
  const provider = $('#accProvider').value
  const px = PROXY_CHANNELS[provider]
  const rekey = REKEY_CHANNELS[provider]
  const rows = ACC.map((a, i) => {
    const dead = a.refreshable === false && typeof a.expiresAt === 'number' && a.expiresAt < Date.now()
    const status = a.enabled === false ? '<span class="pill off">停用</span>' : '<span class="pill on">启用</span>'
    // 代理值直接从 account.list 透传的池字段读（不需要额外的读端点）。
    // 四家的字段名不同，所以由 PROXY_CHANNELS[provider].field 决定读哪个。
    const proxyVal = px && typeof a[px.field] === 'string' ? a[px.field] : ''
    const proxyCell = !px
      ? '<td class="muted">—</td>'
      : `<td class="mono">${proxyVal ? esc(proxyVal) : '<span class="muted">直连</span>'}</td>`
    // opencode 指纹代次：`account.list` 透传池字段 `opencodeFingerprintGeneration`，
    // 未设过就是 0（读的是同一个 normalizeOpencodeGeneration，见 pool:2883）。
    const gen = provider === 'opencode' ? Number(a.opencodeFingerprintGeneration ?? 0) : null
    return `<tr>
      <td>${esc(a.nickname ?? a.id)}<div class="muted mono">${esc(a.id)}</div>${
        gen === null ? '' : `<div class="muted">指纹代次 ${gen}</div>`
      }</td>
      <td>${status}${dead ? ' <span class="pill warn">死号</span>' : ''}</td>
      <td class="mono">${esc(fmtTime(a.expiresAt))}<div class="muted">${esc(relTime(a.expiresAt))}</div></td>
      <td>${a.refreshable === false ? '<span class="pill off">否</span>' : '<span class="pill on">是</span>'}</td>
      <td class="mono muted">${esc(a.credentialRef ?? '—')}</td>
      ${proxyCell}
      <td><div class="ops">
        <button data-act="toggle" data-id="${esc(a.id)}">${a.enabled === false ? '启用' : '停用'}</button>
        <button data-act="refresh" data-id="${esc(a.id)}">续期</button>
        <button data-act="test" data-id="${esc(a.id)}">测试</button>
        <button data-act="retest" data-id="${esc(a.id)}">复测</button>
        <button data-act="reset" data-id="${esc(a.id)}">重置</button>
        <button data-act="comp" data-id="${esc(a.id)}">补偿</button>
        <button data-act="onboard" data-id="${esc(a.id)}">新人奖励</button>
        ${px ? `<button data-act="proxy" data-id="${esc(a.id)}">代理</button>` : ''}
        ${rekey ? `<button data-act="rekey" data-id="${esc(a.id)}">换 Key</button>` : ''}
        ${provider === 'opencode' ? `<button data-act="rotfp" data-id="${esc(a.id)}">换指纹</button>` : ''}
        <button data-act="up" data-id="${esc(a.id)}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button data-act="down" data-id="${esc(a.id)}" ${i === ACC.length - 1 ? 'disabled' : ''}>↓</button>
        <button data-act="del" data-id="${esc(a.id)}">删除</button>
      </div></td>
    </tr>`
  })
  $('#accTable').innerHTML = `<thead><tr><th>账号</th><th>状态</th><th>到期</th><th>可续期</th><th>凭据 ref</th><th>出口代理</th><th>操作</th></tr></thead><tbody>${
    rows.join('') || '<tr><td colspan="7" class="muted">这个 provider 下还没有账号</td></tr>'
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
        const v = await rpc('account.refresh', { accountId: id })
        renderGeneric($('#accDetail'), v)
      } else if (act === 'test') {
        const v = await rpc('account.test', { accountId: id })
        renderGeneric($('#accDetail'), v)
        say('#accMsg', v?.ok === true ? '测试通过' : `测试失败：${v?.message ?? '见下方'}`, v?.ok === true ? 'ok' : 'err')
        return
      } else if (act === 'retest') {
        const v = await rpc('account.retest', { accountId: id })
        renderGeneric($('#accDetail'), v)
        say('#accMsg', `复测 ${v?.accounts?.[0]?.tested ?? 0} 个模型，清掉 ${v?.clearedCount ?? 0} 个限流`, 'ok')
        return
      } else if (act === 'reset') {
        const v = await rpc('account.reset', { accountId: id })
        renderGeneric($('#accDetail'), v)
      } else if (act === 'comp') {
        // buddy.compensationStatus 只认 provider === 'buddy'，且要 accountId
        const v = await rpc('buddy.compensationStatus', { provider: 'buddy', accountId: id })
        renderGeneric($('#accDetail'), v)
        const box = $('#accCompId')
        if (box) box.value = id
        return
      } else if (act === 'onboard') {
        // onboarding.status / claim 都要 accountId（本体在守卫之后才解析凭据）
        const s = await rpc('onboarding.status', { provider, accountId: id })
        renderGeneric($('#accDetail'), s)
        if (s?.claimable === true || s?.canClaim === true) {
          const c = await rpc('onboarding.claim', { provider, accountId: id })
          renderGeneric($('#accDetail'), c)
        }
        return
      } else if (act === 'proxy') {
        openProxyModal(provider, id)
        return
      } else if (act === 'rekey') {
        openRekeyModal(id)
        return
      } else if (act === 'rotfp') {
        // rotateFingerprint 自己写完再整表重读（代次变了要在行里显示出来）；
        // 它不自己套 busy —— 这里已经是 busy 里面了。
        await rotateFingerprint(id)
        return
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
    say('#accMsg', String(err.message ?? err), 'err')
  }
}

async function accBulk(btn, method) {
  const provider = $('#accProvider').value
  try {
    await busy(btn, async () => {
      if (method === 'account.resetAll' && !confirm(`重置 ${provider} 全部账号的状态？`)) return
      const v = await rpc(method, { provider })
      renderGeneric($('#accDetail'), v)
      say('#accMsg', '已执行', 'ok')
    })
    await loadAccounts()
  } catch (e) {
    say('#accMsg', String(e.message ?? e), 'err')
  }
}

/* --- buddy 补偿（只对 provider==='buddy' 生效，且必须带 accountId） --- */

async function compAction(btn, which) {
  const accountId = ($('#accCompId').value ?? '').trim()
  if (!accountId) {
    say('#accCompMsg', '先填 buddy 账号 id（或在账号表里点「补偿」自动填入）', 'err')
    return
  }
  try {
    await busy(btn, async () => {
      const v =
        which === 'status'
          ? await rpc('buddy.compensationStatus', { provider: 'buddy', accountId })
          : await rpc('buddy.claimCompensation', { provider: 'buddy', accountId })
      renderGeneric($('#accDetail'), v)
      say('#accCompMsg', which === 'status' ? '已查询' : '已尝试领取', 'ok')
    })
  } catch (e) {
    say('#accCompMsg', String(e.message ?? e), 'err')
  }
}

/* --- 登录流程 --- */
let loginTimer

const SMS_PROVIDERS = new Set(['loomy', 'autoclaw'])

function closeLogin() {
  clearInterval(loginTimer)
  loginTimer = undefined
  $('#loginModal').hidden = true
}

/**
 * Key 型渠道：没有浏览器授权流程，本体不接受 `account.create`
 * （实测传 provider:'modelscope' / 'opencode' 回 `unknown provider: xxx`），
 * 只能走各自的前缀改道方法 `*.addAccount`。
 *
 * 官方客户端也这么选：vendor/lib/client/jet-hub.js 的 createAccount() 在
 * `vendor/lib/client/jet-hub.js:8073`（`if (provider === "opencode")`）与
 * `:8077`（`if (provider === "modelscope")`）两处都提前调
 * `setKeyModal({ provider, error: "" })`（分别在 `:8074` / `:8078`）然后 return，
 * 根本不到 account.create —— 补 create 分支等于让一个「建占位号 + 回 loginUrl +
 * login.poll 轮询」的方法再长出两套没有 poll 的语义，还得把两份 KEY_PATTERN
 * 校验复制一遍。控制台自己的入口自己的坑自己填，不动 src/。
 *
 * `hint` / `where` 与本体报错文案逐字对齐（vendor/lib/modelscope-rpc.js:88、
 * vendor/lib/opencode-rpc.js:251），用户看到的提示与后端判据同源。
 */
const KEY_CHANNELS = {
  modelscope: {
    method: 'modelscope.addAccount',
    hint: '魔搭的访问令牌，以 ms- 开头、至少 20 位。同一把 Key 重复添加会复用同一条账号。',
    where: 'https://modelscope.cn/my/myaccesstoken',
  },
  opencode: {
    method: 'opencode.addAccount',
    // 与 modelscope 的口径**刻意不同**：modelscope 命中同 id 就直接回 existed:true
    // （modelscope-rpc.js:95），而 opencode 在 opencode-rpc.js:272-302 有 2026-10-25
    // 审计后的修正 —— 同 id 但凭据读不出来（坏槽）会**覆盖写**并如实回 existed:false。
    // 所以这里不能像上面那样许诺「重复添加一定复用」。
    hint: 'OpenCode Zen 的 Key，20 位以上、不含空格。同一把 Key 重复添加会复用同一条账号；若那条账号的凭据已读不出来（坏槽），会覆盖写并如实回报为新建。',
    where: 'https://opencode.ai/console/account',
  },
}

/** 弹 Key 输入框（替代 startLogin 的授权流程）。 */
function openKeyModal(provider) {
  const cfg = KEY_CHANNELS[provider]
  if (!cfg) throw new Error(`没有 Key 型渠道的配置：${provider}`)
  $('#kmProvider').textContent = provider
  $('#kmHint').textContent = cfg.hint
  $('#kmWhere').href = cfg.where
  $('#kmKey').value = ''
  $('#kmNick').value = ''
  say('#kmMsg', '')
  $('#keyModal').hidden = false
  $('#kmKey').focus()
}

function closeKeyModal() {
  $('#keyModal').hidden = true
  say('#kmMsg', '')
}

async function submitKeyAccount(btn) {
  const provider = $('#kmProvider').textContent
  const cfg = KEY_CHANNELS[provider]
  if (!cfg) return
  const apiKey = $('#kmKey').value.trim()
  if (!apiKey) {
    say('#kmMsg', '请先粘贴 API Key', 'err')
    return
  }
  const nickname = $('#kmNick').value.trim()
  try {
    await busy(btn, async () => {
      const v = await rpc(cfg.method, nickname ? { apiKey, nickname } : { apiKey })
      // 本体如实回报 existed：同 Key 复用 / 坏槽覆盖都会落到这里，
      // 只有 created 才是真的新建了一条（文案别把覆盖说成新建）。
      say('#kmMsg', v?.existed === true ? `已存在，复用了 ${v.accountId}` : `已添加 ${v?.accountId ?? ''}`, 'ok')
      setTimeout(() => {
        closeKeyModal()
        loadAccounts()
      }, 700)
    })
  } catch (e) {
    say('#kmMsg', String(e.message ?? e), 'err')
  }
}

/* ══════════ 换 API Key（只有 modelscope；opencode 没有 setApiKey） ══════════
 *
 * ⚠️ **这不是「改一个字段」，多数时候是换一条账号**：`modelscope.setApiKey` 的
 * 账号 id 由 Key 尾 8 位派生（`modelscopeSlotNamesOf`，vendor/lib/modelscope-rpc.js:131），
 * 所以换另一把 Key 时本体走「先建新号 + 删旧号」，回 `renamed:true`。
 * ⇒ 界面必须**整表重读**：就地改一行的话，旧 id 那行还在、新 id 那行没有，
 * 用户会以为账号没变、实际已经换了一条。`renamed:false` 才是真正就地刷新凭据。
 *
 * opencode **没有** setApiKey（对照 `opencode-rpc.js` 的 case 表，只有 addAccount），
 * 唯一出路是先删后加 —— 所以这里不给 opencode 这个按钮，不让用户看到一条走不通的路。
 */
const REKEY_CHANNELS = {
  modelscope: {
    hint: '换成另一把 Key 会**换一条账号**（id 随 Key 尾 8 位变）：本体先建新号再删旧号，' +
      '昵称与停用状态都继承旧的。填同一把 Key 则只刷新凭据，账号不变。',
    where: 'https://modelscope.cn/my/myaccesstoken',
  },
}

function openRekeyModal(accountId) {
  const provider = $('#accProvider').value
  const cfg = REKEY_CHANNELS[provider]
  if (!cfg) throw new Error(`没有换 Key 端点的 provider：${provider}`)
  const acc = ACC.find((a) => a.id === accountId)
  $('#rkProvider').textContent = provider
  $('#rkHint').textContent = cfg.hint
  $('#rkWhere').href = cfg.where
  $('#rkAccountId').value = accountId
  $('#rkKey').value = ''
  say('#rkMsg', acc?.nickname ? `当前账号：${acc.nickname}` : '')
  $('#rkModal').hidden = false
  $('#rkKey').focus()
}

function closeRekeyModal() {
  $('#rkModal').hidden = true
  say('#rkMsg', '')
}

async function submitRekey(btn) {
  const provider = $('#rkProvider').textContent
  if (!REKEY_CHANNELS[provider]) return
  const accountId = $('#rkAccountId').value.trim()
  const apiKey = $('#rkKey').value.trim()
  if (!apiKey) {
    say('#rkMsg', '请先粘贴新的 API Key', 'err')
    return
  }
  try {
    await busy(btn, async () => {
      // 方法名写字面量（tests/t-rpc-cover.mjs 按字面量数覆盖率，用变量拼会数不到）
      const v = await rpc('modelscope.setApiKey', { accountId, apiKey })
      if (v?.renamed === true) {
        say('#rkMsg', `已换成另一把 Key：账号从 ${accountId} 变成 ${v.accountId}（旧号已删）`, 'ok')
      } else {
        say('#rkMsg', `已刷新凭据 ${v?.masked ?? ''}（账号不变 ${v?.accountId ?? accountId}）`, 'ok')
      }
      setTimeout(async () => {
        closeRekeyModal()
        // ⚠️ 两种结果都整表重读：renamed 是换了一条账号；没换也得让
        // `credentialRef` / 掩码这些派生列重新算一遍，别只改内存里的一个字段。
        await loadAccounts()
      }, 800)
    })
  } catch (e) {
    say('#rkMsg', String(e.message ?? e), 'err')
  }
}

/* ══════════ 换指纹代次（只有 opencode） ══════════
 *
 * `opencode.rotateFingerprint` 用**当前代次**派生下一代并写回池
 * （vendor/lib/account-pool.js:2865 `updateOpencodeFingerprintGeneration`，
 * 只接受比现值更大的代次 —— 乱序/重复回调写回小值会让人以为换了、其实没换）。
 * 回包 `{generation, projectId}` 的 projectId **只用于即时回显**，不是请求依据：
 * 真正的权威值在接线层按 `deriveProjectId(api_key, generation)` 重算。
 *
 * ⚠️ 换指纹**不增加配额**：匿名通道按出口 IP 限额（本体注释实测：换 key、换伪装头、
 * 换指纹全部无效）。要多份额度得给不同通道配不同代理。所以按钮文案与回显都不许诺额度。
 */
async function rotateFingerprint(accountId) {
  // 由 onAccAction 的 busy() 包着调用，这里不再自己 busy(btn) —— 同一个按钮
  // 套两层 busy 会让内层先恢复文字与 disabled，外层的「执行中」状态提前消失。
  // 方法名写字面量（tests/t-rpc-cover.mjs 按字面量数覆盖率）。
  const v = await rpc('opencode.rotateFingerprint', { accountId })
  say('#accMsg', `指纹代次 → ${v?.generation ?? '—'}（projectId ${v?.projectId ?? '—'}；换指纹不加额度，要额度请给它单独配出口）`, 'ok')
  await loadAccounts()
}

/* ══════════ 出口代理（per-账号，四家各自的端点与池字段） ══════════
 *
 * 本体把四家**刻意写成四份实现、四个池字段**（vendor/lib/account-pool.js：
 * setOpencodeProxy / setGeminiProxy / setQoderProxy / setMinimaxIntlProxy），
 * 因为语义不同：opencode = 分份额度（匿名通道按出口 IP 限额）、Gemini =
 * 能不能连通（全部端点都在墙外）、Qoder = 绕开 openapi.qoder.sh 的 SNI 阻断、
 * MiniMax 国际站 = 绕开地域分流。共用一份会让「清掉 Gemini 的代理」连带清掉
 * opencode 的出口配置 —— 所以界面上也分开，一个 provider 一个端点。
 *
 * ⚠️ **读代理不需要新 RPC**：`account.list` 的 listAccounts 只做 `{...entry}`
 * 浅拷贝，池字段原样透传（实测 opencode 那条回 `"opencodeProxy":
 * "http://127.0.0.1:7897"`）。写走各家 `*.setProxy`；**空串 = 删键回直连**
 * （池侧 `delete entry.xxxProxy`，不是写空串 —— 否则下游会把空串当成
 * 「配了一个空地址」）。
 *
 * ⚠️ `qodercn` 没有自己的 `qodercn.setProxy`：前缀改道只认 `qoder.`
 * （vendor/lib/jet-hub-rpc.js:2936 `method.startsWith('qoder.')`，而
 * `'qodercn.setProxy'.startsWith('qoder.')` 为 false）。但 `setQoderProxy`
 * 是按 accountId 定位的，所以中国版账号照样能设；只有 `testProxy` 需要把
 * `provider` 传 `qodercn` 才会选到中国站产品（qoder-rpc.js:56 productOf）。
 */
const PROXY_CHANNELS = {
  opencode: {
    setProxy: 'opencode.setProxy',
    testProxy: 'opencode.testProxy',
    field: 'opencodeProxy',
    hint: 'OpenCode 的出口。要 http/https/socks5 **且带端口**（裸 host:port 会补成 http://）。清空即回本机出口。注意：匿名通道按出口 IP 限额，多要份额度得给不同通道配不同代理，换指纹不增加配额。',
  },
  gemini: {
    setProxy: 'gemini.setProxy',
    testProxy: 'gemini.testProxy',
    field: 'geminiProxy',
    hint: 'Gemini 全部端点都在墙外，而插件进程**不走系统代理**，只能在这里给账号单独配。测试只要拿到 HTTP 响应就算通（400 invalid_request 也算），不判状态码。',
  },
  qoder: {
    setProxy: 'qoder.setProxy',
    testProxy: 'qoder.testProxy',
    field: 'qoderProxy',
    testProvider: 'qoder',
    hint: '国际版 openapi.qoder.sh 会被 SNI 阻断。中国版本来直连就快，别一起塞进代理。测试不判状态码：401/403 同样证明链路通。',
  },
  qodercn: {
    setProxy: 'qoder.setProxy',
    testProxy: 'qoder.testProxy',
    field: 'qoderProxy',
    testProvider: 'qodercn',
    hint: '中国版账号的代理写在本体同一份 qoder 池字段里（qoder.setProxy 按 accountId 定位，没有单独的 qodercn.setProxy）。测试时传 provider=qodercn 才会选中国站产品。',
  },
  minimaxintl: {
    setProxy: 'minimaxintl.setProxy',
    testProxy: 'minimaxintl.testProxy',
    field: 'minimaxIntlProxy',
    hint: 'MiniMax 国际站的出口。测试用 redirect:manual 看那一跳 307 判有没有被分流 —— 跟随之后 401 与「凭据失效」逐字同形，事后分不清。',
  },
}

function syncProxyButtons() {
  const provider = $('#accProvider').value
  const anon = $('#accAnon')
  if (anon) anon.hidden = provider !== 'opencode'
  const px = $('#accProxy')
  if (px) px.hidden = !PROXY_CHANNELS[provider]
}

/** 当前代理弹窗里的 accountId：下拉优先，其次手填框。 */
function proxyAccountId() {
  return (($('#pxAccount').value || $('#pxAccountId').value) ?? '').trim()
}

function fillProxyAccounts(provider, preferId) {
  const sel = $('#pxAccount')
  const opts = ACC.map((a) => `<option value="${esc(a.id)}">${esc(a.nickname ?? a.id)}</option>`).join('')
  sel.innerHTML = opts || '<option value="">（这个 provider 下没有账号）</option>'
  const want = preferId || ACC[0]?.id
  if (want && ACC.some((a) => a.id === want)) sel.value = want
}

/** 把选中账号的当前代理回填进输入框（值来自 account.list 透传的池字段）。 */
function prefillProxyValue() {
  const provider = $('#pxProvider').textContent
  const cfg = PROXY_CHANNELS[provider]
  const id = proxyAccountId()
  const acc = ACC.find((a) => a.id === id)
  $('#pxProxy').value = (cfg && acc && typeof acc[cfg.field] === 'string') ? acc[cfg.field] : ''
}

function openProxyModal(provider, accountId) {
  const cfg = PROXY_CHANNELS[provider]
  if (!cfg) throw new Error(`没有代理端点的 provider：${provider}`)
  $('#pxProvider').textContent = provider
  $('#pxHint').textContent = cfg.hint
  $('#pxAccountId').value = accountId && !ACC.some((a) => a.id === accountId) ? accountId : ''
  fillProxyAccounts(provider, accountId)
  prefillProxyValue()
  say('#pxMsg', '')
  $('#pxOut').innerHTML = ''
  $('#proxyModal').hidden = false
}

function closeProxyModal() {
  $('#proxyModal').hidden = true
  say('#pxMsg', '')
}

/** 测试连接：只要 `{proxy}`（qoder 另收 provider 选产品），不要 accountId。 */
async function proxyTest(btn) {
  const provider = $('#pxProvider').textContent
  const cfg = PROXY_CHANNELS[provider]
  const proxy = $('#pxProxy').value.trim()
  if (!proxy) {
    say('#pxMsg', '先填代理地址；要回直连请点「清除」', 'err')
    return
  }
  try {
    await busy(btn, async () => {
      const payload = cfg.testProvider ? { proxy, provider: cfg.testProvider } : { proxy }
      const v = await rpc(cfg.testProxy, payload)
      renderGeneric($('#pxOut'), v)
      // 四家的回包形状各不相同：opencode 要 exitIp，minimaxintl 要 geoRouted，
      // gemini/qoder 只有 status+latency。逐家读自己那几个字段，别硬套一套文案。
      let line = `通：${v?.status ?? '—'}`
      if (typeof v?.latencyMs === 'number') line += `，${v.latencyMs}ms`
      if (v?.exitIp) line += `，出口 IP ${v.exitIp}${v.country ? `（${v.country}）` : ''}`
      if (typeof v?.geoRouted === 'boolean') line += v.geoRouted ? '，⚠ 被分流到中国站' : '，未分流'
      if (v?.host) line += `，目标 ${v.host}`
      say('#pxMsg', line, 'ok')
    })
  } catch (e) {
    say('#pxMsg', String(e.message ?? e), 'err')
  }
}

async function proxyWrite(btn, proxy) {
  const provider = $('#pxProvider').textContent
  const cfg = PROXY_CHANNELS[provider]
  const accountId = proxyAccountId()
  if (!accountId) {
    say('#pxMsg', '先选账号或填 accountId（代理是按账号存的）', 'err')
    return
  }
  try {
    await busy(btn, async () => {
      const v = await rpc(cfg.setProxy, { accountId, proxy })
      renderGeneric($('#pxOut'), v)
      say('#pxMsg', v?.proxy ? `已设为 ${v.label ?? v.proxy}` : '已清除，回直连（本机出口）', 'ok')
      await loadAccounts()
      fillProxyAccounts(provider, accountId)
      prefillProxyValue()
    })
  } catch (e) {
    say('#pxMsg', String(e.message ?? e), 'err')
  }
}

async function addAnonymousChannel(btn) {
  try {
    await busy(btn, async () => {
      const v = await rpc('opencode.addAnonymous', {})
      say('#accMsg', `已加匿名通道 ${v?.accountId ?? ''}（指纹不增加配额；要更多份额度，给它单独配一个出口）`, 'ok')
    })
    await loadAccounts()
  } catch (e) {
    say('#accMsg', String(e.message ?? e), 'err')
  }
}

async function startLogin(provider) {
  if (KEY_CHANNELS[provider]) {
    openKeyModal(provider)
    return
  }
  const v = await rpc('account.create', { provider })
  const { accountId, loginUrl } = v ?? {}
  $('#lmProvider').textContent = provider
  $('#lmState').textContent = '等待授权…'
  $('#lmState').className = 'msg'
  $('#loginModal').hidden = false
  $('#lmSms').hidden = true
  $('#lmOauth').hidden = false
  $('#lmSmsMsg').textContent = ''
  $('#lmPhone').value = ''
  $('#lmCode').value = ''
  if (SMS_PROVIDERS.has(provider)) {
    $('#lmSms').hidden = false
    $('#lmOauth').hidden = true
  } else if (loginUrl) {
    $('#lmUrl').textContent = loginUrl
    $('#lmOpen').href = loginUrl
    try {
      window.open(loginUrl, '_blank', 'noreferrer')
    } catch {
      /* 沙箱里可能被拦，界面里已经给了地址与按钮 */
    }
  } else {
    throw new Error('本体没有返回 loginUrl')
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
      } else if (s?.pending === true || s?.state) {
        $('#lmState').textContent = `等待中…（${s.state ?? 'pending'}）`
      }
    } catch (e) {
      $('#lmState').textContent = `轮询出错：${e.message ?? e}`
      $('#lmState').className = 'msg err'
    }
  }, 2000)
}

/* ═══════════════════ 积分 ═══════════════════ */

async function creditsStatus(btn) {
  const provider = $('#credProvider').value
  try {
    await busy(btn, async () => {
      const v = await rpc('credits.status', { provider })
      renderGeneric($('#credOut'), v)
      say('#credMsg', '已查询', 'ok')
    })
  } catch (e) {
    say('#credMsg', String(e.message ?? e), 'err')
  }
}

async function creditsBalances(btn) {
  const provider = $('#credProvider').value
  try {
    await busy(btn, async () => {
      const v = await rpc('credits.balances', { provider })
      renderGeneric($('#credOut'), v)
      say('#credMsg', '已查询余额', 'ok')
    })
  } catch (e) {
    say('#credMsg', String(e.message ?? e), 'err')
  }
}

async function creditsBadge(btn) {
  const provider = $('#credProvider').value
  try {
    await busy(btn, async () => {
      const v = await rpc('usage.badge', { provider })
      renderGeneric($('#credOut'), v)
      say('#credMsg', '已查询徽章', 'ok')
    })
  } catch (e) {
    say('#credMsg', String(e.message ?? e), 'err')
  }
}

async function creditsClaim(btn) {
  const provider = $('#credProvider').value
  try {
    await busy(btn, async () => {
      const v = await rpc('credits.claimAll', { provider })
      renderGeneric($('#credOut'), v)
      const s = v?.summary
      say('#credMsg', s ? `领取 ${s.claimed} 个，+${s.totalCredit ?? 0}；已领 ${s.alreadyClaimed ?? 0}，失败 ${s.failed ?? 0}` : '已执行领取', 'ok')
    })
  } catch (e) {
    say('#credMsg', String(e.message ?? e), 'err')
  }
}

async function creditsSpecial(btn, which) {
  try {
    await busy(btn, async () => {
      let v
      if (which === 'cline') v = await rpc('cline.quota', { provider: 'cline' })
      else if (which === 'office') v = await rpc('officeace.status')
      else if (which === 'clineLog') {
        // cline.requestLog 只认 provider==='cline'，且 accountId 必填（按账号过滤）
        const accounts = await rpc('account.list', { provider: 'cline' })
        const first = accounts?.accounts?.[0]
        if (!first) throw new Error('cline 名下没有账号')
        v = await rpc('cline.requestLog', { provider: 'cline', accountId: first.id, limit: 50 })
        if (v && typeof v === 'object') v = { 账号: first.id, ...v }
      }
      renderGeneric($('#credOut2'), v)
      say('#credMsg2', '已查询', 'ok')
    })
  } catch (e) {
    say('#credMsg2', String(e.message ?? e), 'err')
  }
}

/* --- 永久积分锁定 --- */

async function lockAction(btn, mode) {
  const provider = $('#credProvider').value
  // loomy 有一个历史端点名 `loomy.permanentLock`：本体侧与 `credits.permanentLock`
  // 是**同一个 case**，只是 provider 固定为 loomy、且忽略载荷里的 provider。
  // 走哪个名字行为完全一致（实测两者回包相同），这里用老名字把本体方法覆盖补满。
  const lockMethod = provider === 'loomy' ? 'loomy.permanentLock' : 'credits.permanentLock'
  try {
    await busy(btn, async () => {
      let v
      if (mode === 'load') v = await rpc(lockMethod, { provider })
      else if (mode === 'on') {
        if (!confirm(`锁定 ${provider} 的永久积分？（只烧永久额度，不动临期额度）`)) return
        v = await rpc(lockMethod, { provider, locked: true })
      } else if (mode === 'off') v = await rpc(lockMethod, { provider, locked: false })
      renderGeneric($('#lockOut'), v)
      say('#lockMsg', '已执行', 'ok')
    })
  } catch (e) {
    say('#lockMsg', String(e.message ?? e), 'err')
  }
}

/* ═══════════════════ 模型 ═══════════════════ */

let MODELS = []

async function loadModels(btn) {
  const provider = $('#modProvider').value
  try {
    await busy(btn, async () => {
      const v = await rpc('model.list', { provider })
      MODELS = v?.models ?? []
      renderModels()
      const off = MODELS.filter((m) => m.disabled === true).length
      say('#modMsg', `${MODELS.length} 个模型，${off} 个已关闭`, 'ok')
    })
    // 聚合候选的 canonical 下拉是独立数据源，进页面就填好，别让用户先点按钮
    if (!AGG_CATALOG.length) {
      const c = await rpc('aggregate.catalog')
      AGG_CATALOG = Array.isArray(c?.models) ? c.models : []
      fillCanonSelect()
    }
  } catch (e) {
    say('#modMsg', String(e.message ?? e), 'err')
  }
}

function renderModels() {
  const q = ($('#modFilter').value ?? '').trim().toLowerCase()
  const list = q ? MODELS.filter((m) => `${m.id} ${m.name ?? ''}`.toLowerCase().includes(q)) : MODELS
  $('#modTable').innerHTML = `<thead><tr><th class="pick"><input type="checkbox" id="modHeadBox"></th><th>模型</th><th>显示名</th><th>状态</th><th>开关</th></tr></thead><tbody>${
    list
      .map(
        (m) => `<tr>
      <td class="pick"><input type="checkbox" data-mid="${esc(m.id)}"></td>
      <td class="mono">${esc(m.id)}</td>
      <td>${esc(m.name ?? '')}</td>
      <td>${m.disabled ? '<span class="pill off">已关闭</span>' : '<span class="pill on">可用</span>'}${m.dead ? ' <span class="pill warn">已失效</span>' : ''}</td>
      <td><button data-model="${esc(m.id)}" data-disabled="${m.disabled ? '1' : ''}">${m.disabled ? '打开' : '关闭'}</button></td>
    </tr>`,
      )
      .join('') || '<tr><td colspan="5" class="muted">没有匹配的模型</td></tr>'
  }</tbody>`
  const head = $('#modHeadBox')
  if (head) {
    head.addEventListener('change', () => {
      for (const b of $$('#modTable tbody input[type=checkbox]')) b.checked = head.checked
    })
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
    say('#modMsg', String(err.message ?? err), 'err')
  }
}

async function modelBulk(btn, which) {
  const provider = $('#modProvider').value
  try {
    await busy(btn, async () => {
      let v
      if (which === 'allOff') {
        if (!confirm(`把 ${provider} 的模型全部关闭？`)) return
        v = await rpc('model.setAllDisabled', { provider, disabled: true })
      } else if (which === 'allOn') {
        v = await rpc('model.setAllDisabled', { provider, disabled: false })
      } else if (which === 'clearDead') {
        v = await rpc('model.clearDead', { provider })
      }
      renderGeneric($('#accDetail'), v)
      say('#modMsg', '已执行', 'ok')
    })
    await loadModels()
  } catch (e) {
    say('#modMsg', String(e.message ?? e), 'err')
  }
}

async function aggAction(btn, which) {
  try {
    await busy(btn, async () => {
      let v
      if (which === 'catalog') v = await rpc('aggregate.catalog')
      else if (which === 'expiry') v = await rpc('aggregate.expiryOrder', { force: true })
      else if (which === 'active') v = await rpc('aggregate.activeProvider')
      else if (which === 'orderMode') {
        const cur = await rpc('aggregate.expiryOrder')
        v = await rpc('aggregate.setOrderMode', { mode: cur?.mode === 'manual' ? 'expiry' : 'manual' })
      } else if (which === 'clearRej') v = await rpc('aggregate.clearRejected', {})
      else if (which === 'rejectNonExpiring') v = await rpc('aggregate.rejectNonExpiring')
      renderGeneric($('#aggOut'), v)
      if (which === 'catalog' || which === 'clearRej' || which === 'rejectNonExpiring') {
        AGG_CATALOG = Array.isArray(v?.models) ? v.models : []
        fillCanonSelect()
      }
      say('#aggMsg', '已执行', 'ok')
    })
  } catch (e) {
    say('#aggMsg', String(e.message ?? e), 'err')
  }
}

/* --- 聚合候选级操作 --- */

let AGG_CATALOG = []
let AGG_CANDS = [] // 当前 canonical 的候选，顺序即提交顺序

function fillCanonSelect() {
  const sel = $('#aggCanon')
  if (!sel) return
  const prev = sel.value
  sel.innerHTML = AGG_CATALOG.map((m) => `<option value="${esc(m.canonicalId)}">${esc(m.canonicalId)}（${m.candidates?.length ?? 0}）</option>`).join('')
  if (prev && AGG_CATALOG.some((m) => m.canonicalId === prev)) sel.value = prev
}

async function loadAggCandidates(btn) {
  const canonicalId = $('#aggCanon').value
  try {
    await busy(btn, async () => {
      if (!AGG_CATALOG.length) {
        const v = await rpc('aggregate.catalog')
        AGG_CATALOG = Array.isArray(v?.models) ? v.models : []
        fillCanonSelect()
      }
      const m = AGG_CATALOG.find((x) => x.canonicalId === canonicalId)
      AGG_CANDS = (m?.candidates ?? []).map((c) => ({ ...c }))
      renderAggCands()
      say('#aggCandMsg', `${AGG_CANDS.length} 个候选`, 'ok')
    })
  } catch (e) {
    say('#aggCandMsg', String(e.message ?? e), 'err')
  }
}

function renderAggCands() {
  const t = $('#aggCandTable')
  if (!t) return
  t.innerHTML = `<thead><tr><th>顺序</th><th>provider</th><th>上游模型</th><th>单价</th><th>状态</th><th>操作</th></tr></thead><tbody>${
    AGG_CANDS.map((c, i) => {
      // state: allowed / rejected / 其它（未手工打开）
      const statePill =
        c.rejected === true
          ? '<span class="pill off">已拒绝</span>'
          : c.state === 'allowed'
            ? '<span class="pill on">可用</span>'
            : `<span class="pill">${esc(c.state ?? '—')}</span>`
      return `<tr>
        <td class="mono">${i + 1}</td>
        <td class="mono">${esc(c.provider)}</td>
        <td class="mono">${esc(c.realId)}<div class="muted">${esc(c.realName ?? '')}</div></td>
        <td class="mono">${c.price === null || c.price === undefined ? '—' : esc(c.price)}</td>
        <td>${statePill}${c.viaPatch ? ' <span class="pill">改过名</span>' : ''}${c.expiryWired ? '' : ' <span class="pill warn">未接到期</span>'}</td>
        <td><div class="ops">
          <button data-cand="${i}" data-cact="allow">${c.state === 'allowed' ? '取消打开' : '打开'}</button>
          <button data-cand="${i}" data-cact="reject" class="warn">${c.rejected ? '恢复' : '拒绝'}</button>
          <button data-cand="${i}" data-cact="up">↑</button>
          <button data-cand="${i}" data-cact="down">↓</button>
        </div></td>
      </tr>`
    }).join('') || '<tr><td colspan="6" class="muted">先点「列出候选」</td></tr>'
  }</tbody>`
}

async function onAggCand(e) {
  const btn = e.target.closest('button[data-cand]')
  if (!btn) return
  const i = Number(btn.dataset.cand)
  const act = btn.dataset.cact
  const c = AGG_CANDS[i]
  if (!c) return
  const canonicalId = $('#aggCanon').value
  try {
    await busy(btn, async () => {
      if (act === 'allow') {
        const allowed = c.state !== 'allowed'
        await rpc('aggregate.setAllowed', { canonicalId, provider: c.provider, realId: c.realId, allowed })
        c.state = allowed ? 'allowed' : 'other'
      } else if (act === 'reject') {
        const rejected = !c.rejected
        await rpc('aggregate.setRejected', { canonicalId, provider: c.provider, realId: c.realId, rejected })
        c.rejected = rejected
      } else if (act === 'up' || act === 'down') {
        const j = act === 'up' ? i - 1 : i + 1
        if (j < 0 || j >= AGG_CANDS.length) return
        ;[AGG_CANDS[i], AGG_CANDS[j]] = [AGG_CANDS[j], AGG_CANDS[i]]
      }
      renderAggCands()
      say('#aggCandMsg', '已写入', 'ok')
    })
  } catch (err) {
    say('#aggCandMsg', String(err.message ?? err), 'err')
  }
}

async function saveAggOrder(btn) {
  const canonicalId = $('#aggCanon').value
  try {
    await busy(btn, async () => {
      // ⚠️ 本体认的条目格式是 `provider\u0000realId`（NUL 分隔），不是 `provider/realId`。
      // 传斜杠会被 setAggregateOrder 全部丢弃 → 返回空数组 → 顺手删键（等于清空顺序）。
      const order = AGG_CANDS.map((c) => `${c.provider}\u0000${c.realId}`)
      const v = await rpc('aggregate.setOrder', { canonicalId, order })
      const kept = Array.isArray(v?.order) ? v.order.length : 0
      renderGeneric($('#aggOut'), v)
      if (kept === 0) say('#aggCandMsg', '顺序已清空（本体认 0 条 = 恢复按到期排序）', 'err')
      else say('#aggCandMsg', `已保存 ${kept} 条顺序`, 'ok')
    })
  } catch (e) {
    say('#aggCandMsg', String(e.message ?? e), 'err')
  }
}

/* --- 模型批量勾选 --- */

function checkedModels() {
  return $$('#modTable tbody input[type=checkbox]:checked').map((el) => el.dataset.mid)
}

async function modBulkChecked(btn, disabled) {
  const provider = $('#modProvider').value
  const modelIds = checkedModels()
  if (!modelIds.length) {
    say('#modBulkMsg', '先勾选模型', 'err')
    return
  }
  if (disabled && !confirm(`把勾选的 ${modelIds.length} 个模型关闭？`)) return
  try {
    await busy(btn, async () => {
      await rpc('model.setDisabledMany', { provider, modelIds, disabled })
      say('#modBulkMsg', `已${disabled ? '关闭' : '打开'} ${modelIds.length} 个`, 'ok')
    })
    await loadModels()
  } catch (e) {
    say('#modBulkMsg', String(e.message ?? e), 'err')
  }
}

/* ═══════════════════ 供应商 ═══════════════════ */

let PROV_ORDER = []

async function loadProviders(btn) {
  try {
    await busy(btn, async () => {
      const [o, s] = await Promise.all([rpc('provider.getOrder'), rpc('provider.status', { providers: META.providers.map((p) => p.id) })])
      PROV_ORDER = o?.order ?? []
      const st = s?.statuses ?? {}
      $('#pvTable').innerHTML = `<thead><tr><th>provider</th><th>模型</th><th>账号</th><th>启用</th><th>操作</th></tr></thead><tbody>${PROV_ORDER.map((id) => {
        const x = st[id] ?? {}
        const closed = x.closed === true
        return `<tr>
          <td class="mono">${esc(id)}</td>
          <td class="mono">${x.models?.total ?? 0}<div class="muted">关 ${x.models?.disabled ?? 0}</div></td>
          <td class="mono">${x.accounts?.total ?? 0}<div class="muted">启用 ${x.accounts?.enabled ?? 0}</div></td>
          <td>${closed ? '<span class="pill off">关</span>' : '<span class="pill on">开</span>'}</td>
          <td><div class="ops"><button data-pv="${esc(id)}" data-on="${closed ? '1' : ''}">${closed ? '启用' : '停用'}</button></div></td>
        </tr>`
      }).join('')}</tbody>`
      $('#pvOrder').innerHTML = PROV_ORDER.map((id) => `<span class="chip"><b>${esc(id)}</b></span>`).join('')
      say('#pvMsg', `${PROV_ORDER.length} 个 provider`, 'ok')
    })
  } catch (e) {
    say('#pvMsg', String(e.message ?? e), 'err')
  }
}

async function onProvToggle(e) {
  const btn = e.target.closest('button[data-pv]')
  if (!btn) return
  const id = btn.dataset.pv
  const enabled = btn.dataset.on === '1'
  try {
    await busy(btn, () => rpc('provider.setEnabled', { provider: id, enabled }))
    await loadProviders()
  } catch (err) {
    say('#pvMsg', String(err.message ?? err), 'err')
  }
}

/* ═══════════════════ 用量账本 ═══════════════════ */

async function ledgerLoad(btn, which) {
  try {
    await busy(btn, async () => {
      let v
      if (which === 'load') v = await rpc('usage.tokenLedger', { limit: Number($('#tlLimit').value) || 20 })
      else if (which === 'history') v = await rpc('usage.tokenLedgerHistory', { sinceDays: Number($('#tlDays').value) || 7 })
      else if (which === 'delete') {
        const day = prompt('要删除哪一天的账本？格式 YYYY-MM-DD')
        if (!day) return
        if (!confirm(`删除 ${day} 的用量记录？`)) return
        v = await rpc('usage.tokenLedgerDeleteDay', { day })
      }
      renderLedger($('#tlOut'), v, which)
      say('#tlMsg', '已读取', 'ok')
    })
  } catch (e) {
    say('#tlMsg', String(e.message ?? e), 'err')
  }
}

/** 账本形状：{snapshot:{channels, totals:{requests,inputTokens,...}, entries:[...]}}
 *  历史形状：{history:[{day, channels:[{channel, providers:[{provider, accounts:[{accountId, models:[{model, requests,...}]}]}]}]}]}
 *  直接 renderGeneric 会把 totals 塞进一格 JSON，看不出数，所以单独摊开。 */
function renderLedger(host, v, which) {
  host = typeof host === 'string' ? $(host) : host
  host.innerHTML = ''
  const snap = v?.snapshot
  if (snap) {
    const t = snap.totals ?? {}
    const cards = [
      ['请求', t.requests ?? 0],
      ['失败', t.errors ?? 0],
      ['输入 token', t.inputTokens ?? 0],
      ['输出 token', t.outputTokens ?? 0],
      ['缓存读', t.cacheReadTokens ?? 0],
      ['合计', t.totalTokens ?? 0],
    ]
    const box = document.createElement('div')
    box.className = 'cards'
    box.innerHTML = cards.map(([k, n]) => `<div class="cardc"><span>${esc(k)}</span><b>${esc(n)}</b></div>`).join('')
    host.appendChild(box)
    const entries = Array.isArray(snap.entries) ? snap.entries : []
    if (entries.length) renderGeneric(host, entries)
    else {
      const p = document.createElement('p')
      p.className = 'muted'
      p.textContent = '这个时间窗内没有记账（本体只记经过网关的请求）。'
      host.appendChild(p)
    }
    return
  }
  const hist = v?.history
  if (Array.isArray(hist)) {
    if (!hist.length) {
      host.innerHTML = '<p class="muted">没有历史记录。</p>'
      return
    }
    const rows = []
    for (const day of hist) {
      for (const ch of day.channels ?? []) {
        for (const pv of ch.providers ?? []) {
          for (const acc of pv.accounts ?? []) {
            for (const m of acc.models ?? []) {
              rows.push({
                day: day.day,
                渠道: ch.channel,
                provider: pv.provider,
                账号: acc.accountId,
                模型: m.model,
                请求: m.requests ?? 0,
                失败: m.errors ?? 0,
                输入: m.inputTokens ?? 0,
                输出: m.outputTokens ?? 0,
              })
            }
          }
        }
      }
    }
    renderGeneric(host, rows)
    return
  }
  renderGeneric(host, v)
}

async function badgeLoad() {
  try {
    const v = await rpc('usage.badgePreference')
    if (v?.preference) $('#badgePref').value = v.preference
    say('#badgeMsg', `当前：${v?.preference ?? '—'}`)
  } catch (e) {
    say('#badgeMsg', String(e.message ?? e), 'err')
  }
}

async function badgeSave(btn) {
  try {
    await busy(btn, async () => {
      const v = await rpc('usage.badgePreference', { preference: $('#badgePref').value })
      say('#badgeMsg', `已保存：${v?.preference ?? '—'}`, 'ok')
    })
  } catch (e) {
    say('#badgeMsg', String(e.message ?? e), 'err')
  }
}

/* ═══════════════════ 设置 ═══════════════════ */

async function loadSettings() {
  try {
    const [gw, ns, pe, xff] = await Promise.all([
      rpc('gateway.getEnabled').catch(() => ({})),
      rpc('nativeSearch.getEnabled').catch(() => ({})),
      rpc('panelEntry.get').catch(() => ({})),
      rpc('minimax.getXff').catch(() => ({})),
    ])
    $('#setGateway').checked = (gw?.enabled ?? gw?.desired ?? false) === true
    $('#setAllowLan').checked = gw?.allowLan === true
    $('#setSearch').checked = ns?.enabled === true
    if (pe?.entry) $('#setPanel').value = pe.entry
    $('#setXff').value = xff?.xff ?? ''
    say('#setMsg', '')
  } catch (e) {
    say('#setMsg', String(e.message ?? e), 'err')
  }
}

async function saveSetting(what, value) {
  try {
    // 直连模式下本体自带网关被 `DSH_OPENAI_GATEWAY_ENABLED=0` 关掉，
    // 插件根本不经过它。此时改这个开关**不会**改变转发路径，
    // 必须当场说清，否则用户点了没反应还以为保存失败。
    if (what === 'gateway' && META.gateway?.mode === 'direct') {
      say('#setMsg', '直连模式：插件进程内直接调本体 llm 服务，不走本体网关，这个开关不生效', 'err')
      return
    }
    if (what === 'gateway') await rpc('gateway.setEnabled', { enabled: value })
    if (what === 'allowLan') await rpc('gateway.setAllowLan', { allowLan: value })
    if (what === 'search') await rpc('nativeSearch.setEnabled', { enabled: value })
    if (what === 'panel') await rpc('panelEntry.set', { entry: value })
    if (what === 'xff') await rpc('minimax.setXff', { xff: value })
    say('#setMsg', '已保存', 'ok')
  } catch (e) {
    say('#setMsg', String(e.message ?? e), 'err')
  }
}

async function captchaAction(btn, which) {
  try {
    await busy(btn, async () => {
      let v
      if (which === 'demand') v = await rpc('captcha.demand')
      else if (which === 'carrier') v = await rpc('captcha.carrierUrl')
      else if (which === 'contribute') v = await rpc('captcha.contribute', { elapsedMs: 0 })
      renderGeneric($('#capOut'), v)
      say('#capMsg', '已执行', 'ok')
    })
  } catch (e) {
    say('#capMsg', String(e.message ?? e), 'err')
  }
}

/* ═══════════════════ 备份 ═══════════════════ */

async function loadBackup() {
  try {
    const v = await rpc('backup.status')
    $('#bkCards').innerHTML = [
      ['账号总数', v?.accounts ?? '—'],
      ['缺有效期', v?.withoutExpiry ?? '—'],
    ]
      .map(([k, n]) => `<div class="cardc"><span>${esc(k)}</span><b>${esc(n)}</b></div>`)
      .join('')
    if (Array.isArray(v?.accountList) && v.accountList.length) renderGeneric($('#bkOut'), v.accountList)
  } catch (e) {
    say('#bkMsg', String(e.message ?? e), 'err')
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
      say('#bkMsg', `已导出（${text.length} 字节）`, 'ok')
    })
  } catch (e) {
    say('#bkMsg', String(e.message ?? e), 'err')
  }
}

async function doImport(btn) {
  const file = $('#bkFile').files?.[0]
  if (!file) {
    say('#bkMsg', '先选一个备份文件', 'err')
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
      say('#bkMsg', '导入完成', 'ok')
    })
    await loadBackup()
  } catch (e) {
    say('#bkMsg', String(e.message ?? e), 'err')
  }
}

/* ═══════════════════ 启动 ═══════════════════ */

// 路由组不是真渠道：它们没有自己的账号，模型是「从别家挑一个」。
// 放进下拉时排到最后，否则默认选中它 → 账号页空、模型页只剩聚合目录。
const ROUTE_GROUPS = new Set(['aggregate', 'jet-hub-auto', 'auto'])

function orderedProviders() {
  const real = META.providers.filter((p) => !ROUTE_GROUPS.has(p.id))
  const groups = META.providers.filter((p) => ROUTE_GROUPS.has(p.id))
  return [...real, ...groups]
}

function fillProviderSelects() {
  const list = orderedProviders()
  const opts = list.map((p) => `<option value="${esc(p.id)}">${esc(p.id)}（${p.models?.length ?? 0}）</option>`).join('')
  for (const sel of ['#accProvider', '#credProvider', '#modProvider']) {
    const el = $(sel)
    el.innerHTML = opts
  }
  if (list.length) {
    const first = list.find((p) => (p.models?.length ?? 0) > 0) ?? list[0]
    for (const sel of ['#accProvider', '#credProvider', '#modProvider']) $(sel).value = first.id
  }
}

const TAB_LOADERS = {
  accounts: () => loadAccounts(),
  backup: () => loadBackup(),
  settings: () => loadSettings(),
  providers: () => loadProviders($('#pvLoad')),
  models: () => loadModels($('#modLoad')),
  usage: () => {
    ledgerLoad($('#tlLoad'), 'load')
    badgeLoad()
  },
  credits: () => loadAutoCheckin($('#acOut2')),
}

function wireTabs() {
  $('#nav').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]')
    if (!b) return
    $$('#nav button').forEach((x) => x.classList.toggle('on', x === b))
    $$('.tab').forEach((t) => t.classList.toggle('on', t.id === `tab-${b.dataset.tab}`))
    TAB_LOADERS[b.dataset.tab]?.()
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
  syncProxyButtons()
  renderOverview()
  wireTabs()

  // 账号
  $('#accReload').addEventListener('click', () => loadAccounts())
  $('#accProvider').addEventListener('change', () => {
    syncProxyButtons()
    loadAccounts()
  })
  $('#accTable').addEventListener('click', onAccAction)
  $('#accRetestAll').addEventListener('click', (e) => accBulk(e.currentTarget, 'account.retestAll'))
  $('#accResetAll').addEventListener('click', (e) => accBulk(e.currentTarget, 'account.resetAll'))
  $('#accAnon').addEventListener('click', (e) => addAnonymousChannel(e.currentTarget))
  $('#accProxy').addEventListener('click', () => {
    try {
      openProxyModal($('#accProvider').value)
    } catch (e) {
      say('#accMsg', String(e.message ?? e), 'err')
    }
  })

  // 出口代理弹窗
  $('#pxTest').addEventListener('click', (e) => proxyTest(e.currentTarget))
  $('#pxSave').addEventListener('click', (e) => proxyWrite(e.currentTarget, $('#pxProxy').value.trim()))
  // 清除 = 传空串（池侧删键回直连）。**不是不传**：不传时 raw 取空串同样走清除，
  // 但显式传空串能让人在抓包时一眼看出意图。
  $('#pxClear').addEventListener('click', (e) => proxyWrite(e.currentTarget, ''))
  $('#pxClose').addEventListener('click', closeProxyModal)
  $('#pxAccount').addEventListener('change', () => {
    $('#pxAccountId').value = ''
    prefillProxyValue()
  })
  $('#pxAccountId').addEventListener('input', prefillProxyValue)
  $('#pxProxy').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') proxyTest($('#pxTest'))
  })
  $('#accAdd').addEventListener('click', async () => {
    const provider = $('#accProvider').value
    try {
      await busy($('#accAdd'), () => startLogin(provider))
    } catch (e) {
      say('#accMsg', String(e.message ?? e), 'err')
    }
  })

  // Key 型渠道弹窗
  $('#kmAdd').addEventListener('click', (e) => submitKeyAccount(e.currentTarget))
  $('#kmClose').addEventListener('click', closeKeyModal)
  $('#kmKey').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitKeyAccount($('#kmAdd'))
  })

  // 换 Key 弹窗
  $('#rkSave').addEventListener('click', (e) => submitRekey(e.currentTarget))
  $('#rkClose').addEventListener('click', closeRekeyModal)
  $('#rkKey').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitRekey($('#rkSave'))
  })

  // 登录弹窗
  $('#lmCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#lmUrl').textContent)
      $('#lmState').textContent = '已复制'
    } catch {
      $('#lmState').textContent = '复制失败，请手动选中'
    }
  })
  $('#lmClose').addEventListener('click', closeLogin)
  $('#lmSend').addEventListener('click', async (e) => {
    const provider = $('#lmProvider').textContent
    try {
      await busy(e.currentTarget, async () => {
        const v = await rpc('login.sendSms', { provider, phone: $('#lmPhone').value.trim() })
        say('#lmSmsMsg', v?.message ?? '验证码已发送', 'ok')
      })
    } catch (err) {
      say('#lmSmsMsg', String(err.message ?? err), 'err')
    }
  })
  $('#lmSubmit').addEventListener('click', async (e) => {
    const provider = $('#lmProvider').textContent
    try {
      await busy(e.currentTarget, async () => {
        const v = await rpc('login.submitSms', { provider, code: $('#lmCode').value.trim() })
        say('#lmSmsMsg', v?.message ?? '已提交', 'ok')
      })
    } catch (err) {
      say('#lmSmsMsg', String(err.message ?? err), 'err')
    }
  })

  // 积分
  $('#credLoad').addEventListener('click', (e) => creditsStatus(e.currentTarget))
  $('#credBalances').addEventListener('click', (e) => creditsBalances(e.currentTarget))
  $('#credBadge').addEventListener('click', (e) => creditsBadge(e.currentTarget))
  $('#credClaim').addEventListener('click', (e) => creditsClaim(e.currentTarget))
  $('#credCline').addEventListener('click', (e) => creditsSpecial(e.currentTarget, 'cline'))
  $('#credOffice').addEventListener('click', (e) => creditsSpecial(e.currentTarget, 'office'))
  $('#credProvider').addEventListener('change', () => ($('#credOut').innerHTML = ''))
  $('#acRun').addEventListener('click', async (e) => {
    // 本体没有「立即运行」这个 RPC —— 只有 enabled 开关与 dismiss。
    // 切到 enabled 时本体自己会跑今天的；所以这里用「关→开」触发一轮。
    try {
      await busy(e.currentTarget, async () => {
        const before = (await rpc('usage.autoCheckin'))?.autoCheckin ?? {}
        if (before.enabled === true) {
          await rpc('usage.autoCheckin', { enabled: false })
          await new Promise((r) => setTimeout(r, 300))
        }
        const v = await rpc('usage.autoCheckin', { enabled: true })
        renderGeneric($('#acOut2'), v)
        say('#acMsg', '已重新开启自动签到（本体随后会跑一轮）', 'ok')
        loadAutoCheckin($('#acOut'))
      })
    } catch (err) {
      say('#acMsg', String(err.message ?? err), 'err')
    }
  })
  $('#acDismiss').addEventListener('click', async (e) => {
    try {
      await busy(e.currentTarget, async () => {
        await rpc('usage.autoCheckin', { dismiss: true })
        say('#acMsg', '已清掉提示', 'ok')
      })
    } catch (err) {
      say('#acMsg', String(err.message ?? err), 'err')
    }
  })

  // 模型
  $('#modLoad').addEventListener('click', (e) => loadModels(e.currentTarget))
  $('#modProvider').addEventListener('change', () => loadModels())
  $('#modFilter').addEventListener('input', renderModels)
  $('#modTable').addEventListener('click', onModelToggle)
  $('#modAllOff').addEventListener('click', (e) => modelBulk(e.currentTarget, 'allOff'))
  $('#modAllOn').addEventListener('click', (e) => modelBulk(e.currentTarget, 'allOn'))
  $('#modClearDead').addEventListener('click', (e) => modelBulk(e.currentTarget, 'clearDead'))
  $('#aggCatalog').addEventListener('click', (e) => aggAction(e.currentTarget, 'catalog'))
  $('#aggOrderMode').addEventListener('click', (e) => aggAction(e.currentTarget, 'orderMode'))
  $('#aggExpiry').addEventListener('click', (e) => aggAction(e.currentTarget, 'expiry'))
  $('#aggActive').addEventListener('click', (e) => aggAction(e.currentTarget, 'active'))
  $('#aggClearRej').addEventListener('click', (e) => aggAction(e.currentTarget, 'clearRej'))
  $('#aggRejectNonExpiring').addEventListener('click', (e) => aggAction(e.currentTarget, 'rejectNonExpiring'))
  $('#aggShowCand').addEventListener('click', (e) => loadAggCandidates(e.currentTarget))
  $('#aggSaveOrder').addEventListener('click', (e) => saveAggOrder(e.currentTarget))
  $('#aggCandTable').addEventListener('click', onAggCand)

  // 模型批量勾选
  $('#modBulkOff').addEventListener('click', (e) => modBulkChecked(e.currentTarget, true))
  $('#modBulkOn').addEventListener('click', (e) => modBulkChecked(e.currentTarget, false))
  $('#modCheckAll').addEventListener('click', () => {
    for (const b of $$('#modTable tbody input[type=checkbox]')) b.checked = true
    const h = $('#modHeadBox')
    if (h) h.checked = true
  })
  $('#modUncheckAll').addEventListener('click', () => {
    for (const b of $$('#modTable tbody input[type=checkbox]')) b.checked = false
    const h = $('#modHeadBox')
    if (h) h.checked = false
  })

  // 积分专项 + 永久锁定
  $('#credClineLog').addEventListener('click', (e) => creditsSpecial(e.currentTarget, 'clineLog'))
  $('#lockLoad').addEventListener('click', (e) => lockAction(e.currentTarget, 'load'))
  $('#lockOn').addEventListener('click', (e) => lockAction(e.currentTarget, 'on'))
  $('#lockOff').addEventListener('click', (e) => lockAction(e.currentTarget, 'off'))

  // buddy 补偿
  $('#accCompStatus').addEventListener('click', (e) => compAction(e.currentTarget, 'status'))
  $('#accCompClaim').addEventListener('click', (e) => compAction(e.currentTarget, 'claim'))

  // 供应商
  $('#pvLoad').addEventListener('click', (e) => loadProviders(e.currentTarget))
  $('#pvTable').addEventListener('click', onProvToggle)
  $('#pvSaveOrder').addEventListener('click', async (e) => {
    try {
      await busy(e.currentTarget, async () => {
        await rpc('provider.setOrder', { order: PROV_ORDER })
        say('#pvMsg', '顺序已保存', 'ok')
      })
    } catch (err) {
      say('#pvMsg', String(err.message ?? err), 'err')
    }
  })

  // 用量
  $('#tlLoad').addEventListener('click', (e) => ledgerLoad(e.currentTarget, 'load'))
  $('#tlHistory').addEventListener('click', (e) => ledgerLoad(e.currentTarget, 'history'))
  $('#tlDelete').addEventListener('click', (e) => ledgerLoad(e.currentTarget, 'delete'))
  $('#badgeSave').addEventListener('click', (e) => badgeSave(e.currentTarget))

  // 设置
  $('#setGateway').addEventListener('change', (e) => saveSetting('gateway', e.target.checked))
  $('#setAllowLan').addEventListener('change', (e) => saveSetting('allowLan', e.target.checked))
  $('#setSearch').addEventListener('change', (e) => saveSetting('search', e.target.checked))
  $('#setPanel').addEventListener('change', (e) => saveSetting('panel', e.target.value))
  $('#setXff').addEventListener('change', (e) => saveSetting('xff', e.target.value.trim()))
  $('#capDemand').addEventListener('click', (e) => captchaAction(e.currentTarget, 'demand'))
  $('#capCarrier').addEventListener('click', (e) => captchaAction(e.currentTarget, 'carrier'))
  $('#capContribute').addEventListener('click', (e) => captchaAction(e.currentTarget, 'contribute'))

  // 备份
  $('#bkExport').addEventListener('click', (e) => doExport(e.currentTarget))
  $('#bkImport').addEventListener('click', (e) => doImport(e.currentTarget))

  loadAccounts()
}

boot()
