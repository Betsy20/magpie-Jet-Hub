// Jet Hub 控制台前端。全部能力走插件本体注册的 Jet Hub 管理 API：
//   POST /api/jet-hub  {type:'client-request', rpcId, method:'jet-hub', payload:{method, payload}}
//   ← {type:'server-response', rpcId, result:{ok:true, value} | {ok:false, error}}
// 方法名与字段取自 vendor/lib/jet-hub-rpc.js 的 switch（已逐个核对）。
// 覆盖：account.* / credits.* / cline.quota / officeace.status / model.* / provider.* /
//       gateway.* / nativeSearch.* / panelEntry.* / minimax.* / captcha.* /
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
  // ⚠️ 这里会把元素原有的类**一起冲掉**（15 个调用目标里只有 `#gwCards`
  // 带布局类 `.cards`）。错误态下它变成普通块级文案反而是对的 —— 一行读完。
  // 但**成功**时 `loadGatewayCards()` 必须把 `className` 还原成 `cards`，
  // 否则卡片网格再也回不来。
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
  // 用户拿客户端接的是 magpie 主程序那个网关；地址由宿主 meta 给（可被
  // JET_HUB_USER_GATEWAY 覆盖），别在这里再写死一份。
  const ugw = META.gateway?.userGateway || 'http://127.0.0.1:3425'
  $('#gwCode').textContent = direct
    ? [
        '直连模式：本插件不开本地 OpenAI 网关端口，',
        '请求在进程内直接交给本体 llm 服务（ctx.llm）。',
        '',
        '对外统一走 magpie 网关（模型 id 前缀 jet-hub/<provider>/<model>）：',
        `  ${ugw}/v1`,
        '',
        '# 直接验证（需 magpie 在跑）',
        `curl -s ${ugw}/v1/models | head -c 400`,
      ].join('\n')
    : [
        `OpenAI 兼容地址（magpie 内部使用）：${base}`,
        `模型 id 前缀：jet-hub/<provider>/<model>`,
        ``,
        `# 直接验证`,
        `curl -s ${base}/models -H "Authorization: Bearer <插件内部 key>" | head -c 400`,
      ].join('\n')
  $('#gw').textContent = direct ? `${ugw}/v1` : base
  loadGatewayCards()
  loadAutoCheckin($('#acOut'))
}

async function loadGatewayCards() {
  try {
    const direct = META.gateway?.mode === 'direct'
    const g = await rpc('gateway.getEnabled')
    // 直连模式下 `gateway.getEnabled` 报的是**本体自己那个内嵌网关**的开关，
    // 本插件已经不用它了（请求走进程内 ctx.llm）。直接摊开六行「启用=否 /
    // 运行中=否」会让人以为插件没生效，所以直连时把语义写在第一行，并在每项
    // 上标明「本插件不使用」。
    const rows = direct
      ? [
          ['模式', '直连本体（进程内调 ctx.llm，无本地端口）'],
          ['对外网关', META.gateway?.userGateway ?? '—'],
          ['本体内嵌网关', g?.enabled === true ? '启用（本插件不使用）' : '未启用（本插件不使用）'],
          ['监听', `${g?.address?.host ?? '—'}:${g?.address?.port ?? '—'}`],
          ['被环境变量挡住', g?.blockedByEnv === true ? '是（DSH_OPENAI_GATEWAY_* 优先）' : '否'],
          ['最近错误', g?.lastError ?? '无'],
        ]
      : [
          ['启用', g?.enabled === true ? '是' : '否'],
          ['运行中', g?.running === true ? '是' : '否'],
          ['被环境变量挡住', g?.blockedByEnv === true ? '是（DSH_OPENAI_GATEWAY_* 优先）' : '否'],
          ['允许局域网', g?.allowLan === true ? '是' : '否'],
          ['监听', `${g?.address?.host ?? '—'}:${g?.address?.port ?? '—'}`],
          ['最近错误', g?.lastError ?? '无'],
        ]
    // 上一次失败时 `say()` 会往这里挂 `msg err`（红字），成功后必须清回去 ——
    // 否则重试成功后卡片内容仍继承错误色，而且 `.msg` 的 12px 会压掉卡片自己的字号。
    $('#gwCards').className = 'cards'
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

/**
 * 每个账号的积分读数，键是 accountId。
 *
 * 本体 `credits.balances` 一次返回**整家渠道所有账号**的余额（不是逐账号问），
 * 所以这里按 provider 拉一次、摊到每张卡上。三个坑：
 *  ① 有些渠道直接抛 `unsupported provider`（本机没登录过）—— 那不是错，是「没得查」；
 *  ② 有些渠道**逐账号兜错**，单账号失败时把异常塞进该条的 `error` 字段，
 *     其余账号照常返回（实测 workbuddy 20 个账号里只有几个是坏的）；
 *  ③ 三个额度字段的语义**别弄反**（下面 `loadBalances` 的注释有详述）：
 *     `total` 是可用合计，`expiringTotal` 才是「临期」，`expiredTotal` 是「已失效」。
 *
 * @type {Map<string, {total:number, long:number, temp:number, expired:number, error?:string}>}
 */
let BAL = new Map()

/**
 * 拉一家渠道下**所有账号**的积分余额，摊成 `accountId → 读数`。
 *
 * ⚠️ 三个坑（都踩过）：
 *
 * 1. **返回值是 `{ accounts: [...] }`**，不是裸数组。handler 在
 *    `jet-hub-rpc.js:7336-7338` 把 `collectCreditBalances()` 的 `results`
 *    （那个函数 `:1007` 确实 `return results`，是**收集器**）包成
 *    `{ ok: true, value: { accounts: values, windowDays? } }`。
 *    ⚠️ 按裸数组取会让循环体 0 次执行 ⇒ 每张卡都显示「—」，
 *    而且**零测试覆盖**（29 个测试全绿也发现不了）。
 * 2. **`expiredTotal` 不是「临期」**：它是「**已经失效、不可用**」的额度
 *    （见 `credits.d.ts:331-336`），UI 该单独提示「另有 N 已失效」。
 *    「临期」是另一个字段 `expiringTotal` —— 「`total` 中即将到期的额度」
 *    （`credits.d.ts:337-375`，两者方向相反、互斥）。
 * 3. **单账号失败不能连坐**：handler 是逐账号兜错的，某家查不到时 `balance` 为
 *    `null` 且带 `error`，这时给「查不到」而不是 0（0 会被读成「真的没积分了」）。
 * 4. **「有 balance + 有 error」= 兼顶旧读数**，不是成功。`jet-hub-rpc.js:905-925`
 *    明写「兼顶读数（`stale: true`）照样回传，并带上 `error` 让 UI 标注『本次查询
 *    失败，显示的是 HH:MM 的数据』」。⇒ 只在 `balance` 缺失时消费 `error`，
 *    等于把**过期积分当实时值**展示，而且一句提示都没有。
 *
 * ## 为什么不复刻上游的三档分桶（永久 / 长期 / 临期）
 *
 * 上游那行是 `formatPoolSplitLine(packages, …)` 按**资源包名**分组算出来的
 * （`client/jet-hub.js:4659` 的 `splitCreditsByExpiry` + `:7021` 的 `formatPoolSplitLine`），
 * 要读 `packages[].deductionEndTime` / `expiringRemaining` /
 * `isExclusivePool` / `normalizeWindowDays2` 一整套，60 行逻辑。
 * 在浏览器里复制一份必然与本体分叉（`buddy-balance-rank.js` 的注释已经为
 * 「同一语义两侧同判」打过补丁，那是给宿主用的，不是给这个页面的）。
 * ⇒ 这里只展示**权威聚合值**：`total`，加上游明确下发的 `expiringTotal`（临期）
 * 与 `expiredTotal`（已失效）。没下发就不编造。
 *
 * ⚠️ 因此「其余 = `total` - 临期」这一档**不能叫「长期」**：它把「永久」
 * （服务端没给 `deductionEndTime` 的那部分）也算进去了。上游三档里
 * 永久与长期是两个独立读数（`jet-hub.js:2907-2915` 的表格、`:4727-4741` 的
 * `formatExpirySplitLine` 三个独立 `parts.push`）。给余数贴「长期」会**低估
 * 最安全的那部分额度** —— 对一个积分看板是实质误导。所以文案写「其余」。
 */
async function loadBalances(provider, prefetched, force = false) {
  // ⚠️ 写局部 `next` 再返回，**不要**在这里直接改全局 `BAL`。
  // 这里有一次 `await`（下面那个 `rpc`），期间用户可能已经切走：旧渠道的回包
  // 晚到时会无条件覆盖 `BAL`，而新的 `loadAccounts` 已经拿新渠道的 `ACC`
  // 渲染过了 —— 结果是卡片显示「—」（旧 id 查不到新账号）或旧值。
  // 调用方必须在 `provider` 守卫**通过之后**再 `BAL = next`。
  const next = new Map()
  try {
    // `prefetched` 是调用方已经拿到的同一份回包 —— 别为了刷卡片再发一次 RPC
    // （同一个按钮点一下发两个 `credits.balances`，还可能出现两次结果不一致）。
    //
    // `force` 只在真的要发 RPC 时有意义：后端默认吃 120 秒的共享读数缓存
    // （`vendor/lib/index.js:1092`），而 `credits.claimAll` 只清折算缓存、
    // **刻意不清余额缓存**（`vendor/lib/jet-hub-rpc.js:3110-3111`、
    //  buddy 补偿 `:7531-7534` 还专门写「刻意不复用 `balanceCache.clear()`」）。
    // ⇒ 领完不传 `force: true` 的话，卡片上的积分 120 秒内还是领取前的旧数。
    const v = prefetched === undefined ? await rpc('credits.balances', { provider, force }) : prefetched
    for (const row of Array.isArray(v?.accounts) ? v.accounts : []) {
      const id = String(row?.accountId ?? '')
      if (!id) continue
      // 兼顶旧读数：`balance` 有值 + `error` 也有值（见上面第 4 条）。
      const stale = typeof row?.error === 'string' && row.error !== '' ? row.error : null
      const b = row?.balance
      if (!b || typeof b !== 'object') {
        next.set(id, { total: 0, long: null, temp: null, expired: 0, error: stale ?? '余额查询失败', stale: null })
        continue
      }
      const total = Number(b.total) || 0
      // 临期：**只有上游真的下发了正数才展示**。`expiringTotal` 是可选字段，
      // 绝大多数渠道（CodeBuddy / AStudio / MiniMax …）压根没有 —— 这时显示
      // 「临期 0」会让人误以为「确认没有快过期的」，而事实是「不知道」。
      const rawTemp = Number(b.expiringTotal)
      const temp = Number.isFinite(rawTemp) && rawTemp > 0 ? Math.min(rawTemp, total) : null
      // 已失效：不可用额度，只用于「另有 N 已失效」的提示。
      const expired = Math.max(0, Number(b.expiredTotal) || 0)
      next.set(id, {
        total,
        temp,
        expired,
        // 「其余」= 永久 + 长期（不是「长期」，见上面注释）。
        long: temp === null ? null : Math.max(0, total - temp),
        error: null,
        stale,
      })
    }
  } catch (e) {
    // `unsupported provider` 是「这家没得查」，不是错误；其余也降级成「—」，
    // 不能让整张账号列表因为积分查不到就渲染不出来。
    const msg = String(e?.message ?? e)
    if (!/unsupported provider/i.test(msg)) console.warn('[console] 余额查询失败：', msg)
  }
  // 失败时也要返回（可能已经有部分行摊平了，也可能空）—— 调用方统一 BAL = next。
  return next
}

async function loadAccounts() {
  const provider = $('#accProvider').value
  if (!provider) return
  say('#accMsg', '读取中…')
  try {
    const list = (await rpc('account.list', { provider }))?.accounts ?? []
    // 两次 await 之间用户可能已经切走 —— 守卫必须放在给 `ACC` 赋值**之前**，
    // 否则旧渠道的账号会盖掉新渠道的，然后按新 provider 去渲染（指纹 / 代理字段全错）。
    if ($('#accProvider').value !== provider) return
    ACC = list
    // ⚠️ 先渲染列表、**再**去查余额。`credits.balances` 要为每个账号发一次网络
    // 请求，慢且可能挂起（`rpc()` 是裸 fetch，没有 `AbortSignal` / 超时）；旧实现
    // 先 `await` 余额，于是余额挂起时整页停在「读取中…」，连「停用 / 删除 /
    // 换 Key」都点不到。后端明确说两者必须独立 ——
    // `vendor/lib/jet-hub-rpc.js:6931-6933`「混在一起会让账号列表被网络耗时拖慢，
    // 且一次查询失败会让整份列表都取不到」。
    // 代价是积分列先显示「—」再跳成数字，但列表本身立刻可操作。
    renderAccounts(provider)
    syncProxyButtons()
    say('#accMsg', `${ACC.length} 个账号`, 'ok')
    const nextBal = await loadBalances(provider)
    if ($('#accProvider').value !== provider) return
    BAL = nextBal
    renderAccounts(provider)
    syncProxyButtons()
    // 「查不到」与「旧数据」是两件事，别混成一个数：
    // 查不到 = 这次没有任何读数；旧数据 = 有读数但可能是上一轮的。
    const noBal = ACC.filter((a) => !BAL.has(a.id) || BAL.get(a.id)?.error).length
    const staleBal = ACC.filter((a) => BAL.get(a.id)?.stale).length
    const notes = [noBal ? `${noBal} 个查不到` : '', staleBal ? `${staleBal} 个是旧数据` : '']
      .filter(Boolean)
      .join('、')
    say('#accMsg', notes ? `${ACC.length} 个账号（${notes}）` : `${ACC.length} 个账号`, 'ok')
  } catch (e) {
    say('#accMsg', String(e.message ?? e), 'err')
  }
}

/** 卡片左上角那枚「拖动排序」把手（纯装饰，真正的排序走 ↑ / ↓ 按钮）。 */
const GRIP_ICON =
  '<svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">' +
  '<circle cx="3" cy="2.5" r="1.15"/><circle cx="7" cy="2.5" r="1.15"/>' +
  '<circle cx="3" cy="7" r="1.15"/><circle cx="7" cy="7" r="1.15"/>' +
  '<circle cx="3" cy="11.5" r="1.15"/><circle cx="7" cy="11.5" r="1.15"/></svg>'

/**
 * @param {string} [provider] 渲染哪个渠道。默认读当前下拉框 —— 但**异步调用点
 *   必须显式传**（await 期间用户可能已经切走，用新 provider 去配旧 `ACC` / `BAL`
 *   会闪一帧全是「—」的卡）。
 */
function renderAccounts(provider = $('#accProvider').value) {
  const px = PROXY_CHANNELS[provider]
  const rekey = REKEY_CHANNELS[provider]
  const cards = ACC.map((a, i) => {
    const dead = a.refreshable === false && typeof a.expiresAt === 'number' && a.expiresAt < Date.now()
    const on = a.enabled !== false
    // 代理值直接从 account.list 透传的池字段读（不需要额外的读端点）。
    // 四家的字段名不同，所以由 PROXY_CHANNELS[provider].field 决定读哪个。
    const proxyVal = px && typeof a[px.field] === 'string' ? a[px.field] : ''
    // opencode 指纹代次：`account.list` 透传池字段 `opencodeFingerprintGeneration`，
    // 未设过就是 0（读的是同一个 normalizeOpencodeGeneration，见 pool:2883）。
    const gen = provider === 'opencode' ? Number(a.opencodeFingerprintGeneration ?? 0) : null
    const bal = BAL.get(a.id)
    // 积分行：`5100 其余 3700 · 临期 1400`（上游控制台同款排版）。
    // 上游没下发 `expiringTotal` 时**只显示合计**，不编造「临期 0」；
    // 有已失效额度时再缀一句「另有 N 已失效」（上游 `jet-hub.js:7040` 同款）。
    // 查不到时给「—」而不是 0 —— 0 会被读成「真的没积分了」。
    // ⚠️ 这一档叫「其余」不叫「长期」：它是 `total - 临期`，把「永久」也算进去了
    // （见 loadBalances 上方注释）。给余数贴「长期」会低估最安全的额度。
    // ⚠️ `bal.stale` 是「兼顶旧读数」：RPC 层要求这种行必须标注，否则用户
    // 看到的是过期积分却毫无提示（`jet-hub-rpc.js:905-925`）。
    const creditDd = !bal
      ? '<dd class="muted">—</dd>'
      : bal.error
        ? `<dd class="muted" title="${esc(bal.error)}">查不到（${esc(bal.error.slice(0, 18))}）</dd>`
        : `<dd${bal.stale ? ` title="${esc(bal.stale)}"` : ''}><span class="creditTotal">${bal.total}</span>${
            bal.temp === null
              ? ''
              : ` <span class="creditPoolPart">其余 ${bal.long} · 临期 <span class="creditExpire">${bal.temp}</span></span>`
          }${bal.expired > 0 ? `<span class="creditExpired">另有 ${bal.expired} 已失效</span>` : ''}${
            bal.stale ? '<span class="creditStale">旧</span>' : ''
          }</dd>`
    return `<article class="accountCard">
      <div class="accountTop">
        <span class="dragHandle" aria-hidden="true" title="用操作行的 ↑ ↓ 调整顺序">${GRIP_ICON}</span>
        <span class="accountOrder">${i + 1}</span>
        <span class="accountStatus" data-tone="${dead ? 'dead' : on ? 'on' : 'off'}"></span>
        <span class="accountName" title="${esc(a.id)}">${esc(a.nickname ?? a.id)}</span>
        ${dead ? '<span class="accountTag" data-tone="warn">死号</span>' : ''}
        <span class="accountTag" data-tone="${on ? 'on' : 'off'}">${on ? '已启用' : '已停用'}</span>
      </div>
      <dl class="accountMeta">
        <div class="metaRow"><dt>凭据</dt><dd class="mono">${esc(a.credentialRef ?? '—')}</dd></div>
        <div class="metaRow"><dt>账号 id</dt><dd class="mono">${esc(a.id)}</dd></div>
        <div class="metaRow"><dt>有效期</dt><dd>${esc(fmtTime(a.expiresAt))}<span class="relTime"> ${esc(relTime(a.expiresAt))}</span></dd></div>
        <div class="metaRow"><dt>可续期</dt><dd data-tone="${a.refreshable === false ? 'off' : 'ok'}">${a.refreshable === false ? '否' : '是'}</dd></div>
        <div class="metaRow"><dt>出口代理</dt><dd>${!px ? '—' : proxyVal ? esc(proxyVal) : '直连'}</dd></div>
        <div class="metaRow"><dt>积分</dt>${creditDd}</div>
        ${gen === null ? '' : `<div class="metaRow"><dt>指纹代次</dt><dd>${gen}</dd></div>`}
        <div class="metaRow metaRow--actions">
          <dt>操作</dt>
          <dd class="accountActions">
            <button data-act="toggle" data-id="${esc(a.id)}">${on ? '停用' : '启用'}</button>
            <button data-act="refresh" data-id="${esc(a.id)}">续期</button>
            <button data-act="test" data-id="${esc(a.id)}">测试</button>
            <button data-act="retest" data-id="${esc(a.id)}">复测</button>
            <button data-act="reset" data-id="${esc(a.id)}">重置</button>
            ${provider === 'buddy' ? `<button data-act="comp" data-id="${esc(a.id)}">补偿</button>` : ''}
            ${ONBOARDING_PROVIDERS.has(provider) ? `<button data-act="onboard" data-id="${esc(a.id)}">新人奖励</button>` : ''}
            ${px ? `<button data-act="proxy" data-id="${esc(a.id)}">代理</button>` : ''}
            ${rekey ? `<button data-act="rekey" data-id="${esc(a.id)}">换 Key</button>` : ''}
            ${provider === 'opencode' ? `<button data-act="rotfp" data-id="${esc(a.id)}">换指纹</button>` : ''}
            <button data-act="up" data-id="${esc(a.id)}" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button data-act="down" data-id="${esc(a.id)}" ${i === ACC.length - 1 ? 'disabled' : ''}>↓</button>
            <button data-act="del" data-id="${esc(a.id)}">删除</button>
          </dd>
        </div>
      </dl>
    </article>`
  })
  $('#accList').innerHTML =
    cards.join('') || '<div class="accountEmpty">这个 provider 下还没有账号</div>'
}

async function onAccAction(e) {
  const btn = e.target.closest('button[data-act]')
  if (!btn) return
  const provider = $('#accProvider').value
  const id = btn.dataset.id
  const act = btn.dataset.act
  // 有些动作要说一句话，但下面 `await loadAccounts()` 会把 `#accMsg` 覆写成
  // 「N 个账号」。所以先把话存起来，等列表刷完再说（`test` / `retest` / `comp` 在用）。
  let flash = null
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
        flash = { text: v?.ok === true ? '测试通过' : `测试失败：${v?.message ?? '见下方'}`, kind: v?.ok === true ? 'ok' : 'err' }
        return
      } else if (act === 'retest') {
        const v = await rpc('account.retest', { accountId: id })
        renderGeneric($('#accDetail'), v)
        flash = { text: `复测 ${v?.accounts?.[0]?.tested ?? 0} 个模型，清掉 ${v?.clearedCount ?? 0} 个限流`, kind: 'ok' }
        return
      } else if (act === 'reset') {
        const v = await rpc('account.reset', { accountId: id })
        renderGeneric($('#accDetail'), v)
      } else if (act === 'comp') {
        // 补偿是**一次性限时活动**（`end_time` 到期即作废），点一次按钮就把「查 + 领」走完。
        // 别再让用户去页脚输入框里点第二次 —— 卡片上本来就带着 accountId。
        // 和 `onboard`（新人奖励）同一个模式：先查状态，可领才领。
        let s
        try {
          s = await rpc('buddy.compensationStatus', { provider: 'buddy', accountId: id })
        } catch (e) {
          // 活动没开 / 已过期时上游直接拒（业务码 10001）。这是可预期的结论，不是异常，
          // 但也别吞掉 —— 原文照给用户看，他才知道为什么点不动。
          flash = { text: String(e.message ?? e), kind: 'err' }
          return
        }
        renderGeneric($('#accDetail'), s)
        if (s?.claimed === true) {
          flash = { text: '这个账号的补偿已经领过了', kind: 'ok' }
          return
        }
        if (s?.active !== true) {
          flash = { text: '补偿活动未开启或已过期', kind: 'err' }
          return
        }
        await rpc('buddy.claimCompensation', { provider: 'buddy', accountId: id })
        // 领完再查一次：`claimCompensation` 只回空对象，数字得从 status 拿。
        const after = await rpc('buddy.compensationStatus', { provider: 'buddy', accountId: id })
        renderGeneric($('#accDetail'), after)
        flash = { text: after?.creditNum ? `补偿已领取：${after.creditNum} 积分` : '补偿已领取', kind: 'ok' }
        return
      } else if (act === 'onboard') {
        // ⚠️ 旧实现读 `claimable` / `canClaim` —— 这两个字段**任何 provider 都不
        // 返回**（`vendor/lib/types.d.ts:1255-1266` 的 `RpcOnboardingStatusResponse`
        // 只有 tasks / earned / total / titles / points），条件恒为 `false`，
        // 于是 `onboarding.claim` 成了没有 UI 入口的死端点。
        //
        // 现在两步都调，但 **status 是 best-effort**：它只提供「任务清单 + 完成
        // 情况」这个视图，领取本身不依赖它（`onboarding.claim` 自己会解析凭据、
        // 执行领取）。把 status 写成硬依赖的话，一次状态查询失败（限流 / 该家
        // 实现没覆盖 status）会让本来能成功的领取整个不执行 —— 用户点一次
        // 「新人奖励」什么都没发生，还以为是没奖励可领。
        //
        // `onboarding.claim` 本身**幂等**（响应里的 `skipped` 就是「此前已完成」），
        // 重复点不会重复发奖。
        let status = null
        try {
          status = await rpc('onboarding.status', { provider, accountId: id })
          renderGeneric($('#accDetail'), status)
        } catch (e) {
          // 状态查不到不影响领取 —— 但要说一声，否则用户以为任务清单是空的。
          console.warn('[console] 新人任务状态查询失败：', String(e?.message ?? e))
        }
        const c = await rpc('onboarding.claim', { provider, accountId: id })
        // 用 claim 的响应渲染详情：它才是这次点击的**结果**
        // （claimed / skipped / errors / manualRequired）；status 的任务清单
        // 已经在上面渲染过一次，claim 失败时保留它（有 status 才有内容）。
        if (c !== undefined && c !== null) renderGeneric($('#accDetail'), c)
        const gained = (c?.claimed ?? []).reduce((n, x) => n + (Number(x?.points) || 0), 0)
        const failed = c?.errors?.length ?? 0
        const skipped = c?.skipped?.length ?? 0
        // `manualRequired`：需要用户去网页上手动完成的任务（实测 magicrew 有），
        // 不提示的话会被静默漏掉 —— 用户看到「领取 0 个」却不知道为什么。
        const manual = c?.manualRequired?.length ?? 0
        const parts = [`领取 ${c?.claimed?.length ?? 0} 个`]
        if (gained > 0) parts.push(`+${gained}`)
        parts.push(`已领 ${c?.earned ?? 0} / ${c?.total ?? 0}`)
        if (skipped > 0) parts.push(`${skipped} 个此前已完成`)
        if (manual > 0) parts.push(`${manual} 个需去网页手动完成`)
        if (failed > 0) parts.push(`失败 ${failed} 个`)
        flash = { text: parts.join('，'), kind: failed > 0 ? 'err' : 'ok' }
        return
      } else if (act === 'proxy') {
        openProxyModal(provider, id)
        return
      } else if (act === 'rekey') {
        openRekeyModal(id, provider)
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
        // ⚠️ 必须先检查 `i`：卡片是上一轮 `ACC` 渲染的，`ACC` 已经换了一份
        // （比如刚删掉一个账号、或切了渠道）时 `indexOf` 返回 -1，此时「下移」
        // 的 `j === 0` 能通过原守卫，解构赋值等价于
        // `ids[-1] = ids[0]; ids[0] = undefined`，`JSON.stringify` 后
        // `orderedIds[0] === null`。后端（`vendor/lib/jet-hub-rpc.js:5876-5878`）
        // 会拦下并报「orderedIds 必须是字符串数组」，但用户看到的是莫名其妙的错误。
        if (i < 0 || j < 0 || j >= ids.length) return
        ;[ids[i], ids[j]] = [ids[j], ids[i]]
        await rpc('account.reorder', { provider, orderedIds: ids })
      }
    })
    await loadAccounts()
    if (flash) say('#accMsg', flash.text, flash.kind)
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

/* --- 登录流程 --- */
let loginTimer
// 正在登录的账号 id。`account.create` 会**立刻**在池里写一条占位条目（无凭据、
// 昵称就是 id），好让 login.poll 能查到；本体只在登录失败时自己删它。用户点
// 「关闭」放弃授权时没人删 —— 那些占位就变成池里一行「启用 / 无到期 / 凭据 ref
// 空」的幽灵账号（实测：点一次添加账号再关掉，state.json 就多一条
// accio-xxxxxxxx）。所以关闭时由这里负责回收。
let loginAccountId
/** 这次登录弹窗对应的 provider —— 回收占位账号时要按 provider 查池。 */
let loginProvider

const SMS_PROVIDERS = new Set(['loomy', 'autoclaw'])

/**
 * 这条账号是不是「还没登录成功的占位条目」？—— 直接查账号池，不信 `login.poll` 的时序。
 *
 * ⚠️ 不能用「有没有 `credentialRef`」当判据：accio 的占位条目**照写**
 * `credentialRef: refName`（`vendor/lib/accio-auth.js` 的 `startLogin`，注释说
 * 「占位条目必须在返回 loginUrl 之前登记」），只是那条 ref 在
 * `.credentials.yaml` 里还没有值。其余家走 RPC 登记，形状相同。
 *
 * 占位条目的真实形状（实测 state.json）：
 *   { id, provider, nickname: <与 id 完全相同>, enabled: true,
 *     credentialRef: <有>, refreshable: false, createdAt, 无 expiresAt }
 * 登录成功后 `finishLogin` 会把 nickname 换成真实昵称、refreshable 置真、
 * 补上 expiresAt —— 三条一起变，所以三条一起判。
 *
 * 昵称判据有两个可接受值：**等于 id**（15 家），或命中
 * `PLACEHOLDER_NICKNAMES`（autoclaw 的 `'AutoClaw (登录中...)'`）。
 *
 * 宁可漏删也不误删：`removeAccount` 会连带 `credentials.unset`，不可逆。
 * 所以再加一道时间窗：只回收**刚刚创建**的（10 分钟内）。历史遗留的怪账号
 * （实测池里有 4 条 nickname === id 但有 expiresAt 的真账号）一律不碰。
 */
const PLACEHOLDER_MAX_AGE_MS = 10 * 60 * 1000

/**
 * 占位条目的昵称白名单 —— 除「昵称就等于 id」之外的写法。
 *
 * 15 家走 `nickname: id`（`vendor/lib/jet-hub-rpc.js` 里 14 处
 * `nickname: id` + `vendor/lib/accio-auth.js:525` 一处），但 autoclaw 的短信
 * 登录路径写的是**固定文案**（`vendor/lib/jet-hub-rpc.js` 的
 * `nickname: 'AutoClaw (登录中...)'`）—— 只按「昵称 === id」判会把它判成 `'no'`，
 * 于是用户点「添加账号」→ 选 autoclaw → 直接关掉，那条 `AutoClaw (登录中...)`
 * 就永远留在池里（三审实测复现）。
 *
 * 这里只登记**已确证**的固定文案。
 *
 * ⚠️ 维护触发条件：动 `vendor/lib/jet-hub-rpc.js` 的 `account.create` 分支时，
 * 必须 `grep -n "pool.addAccount({" -A 6 vendor/lib/*.js` 把每一处的 `nickname`
 * 取值看一遍 —— 一旦出现第三种写法（既不是 id、也不在这张表里），这一家的占位
 * 就永远删不掉。`login.poll` 二次确认和 10 分钟时间窗都**不是**兜底：判成 `'no'`
 * 之后根本走不到 poll 那一步，时间窗只会让判据更严。
 */
const PLACEHOLDER_NICKNAMES = new Set(['AutoClaw (登录中...)'])

/**
 * 三态判据，对齐本体自己的惯例（`vendor/lib/jet-hub-rpc.js` 的
 * `loginCredentialLanded` 返回 `'yes' | 'no' | 'unknown'`，其注释记着历史 P0：
 * 「只有一个布尔 ⇒ 读凭据失败与确证没有凭据同样为 false ⇒ 静默收口会把
 * 健康账号连凭据一起删掉」）。
 *
 * 这里只回答「是不是占位」，但**读不到池条目时返 `'unknown'` 而不是 `'no'`**，
 * 让调用方能区分「确证不是占位」与「问不出来」—— 后者一律不删。
 */
async function isPlaceholder(accountId, provider) {
  let v
  try {
    v = await rpc('account.list', { provider })
  } catch {
    return 'unknown'
  }
  const hit = (v?.accounts ?? []).find((a) => String(a?.id ?? '') === String(accountId))
  // 池里找不到 = 它已经不在池里了（本体自己删过 / 别处删过），不是「占位」。
  if (!hit) return 'no'
  const nick = String(hit.nickname ?? '')
  const sameName = nick === String(hit.id ?? '') || PLACEHOLDER_NICKNAMES.has(nick)
  const noExpiry = hit.expiresAt === undefined || hit.expiresAt === null || hit.expiresAt === 0
  const notRefreshable = hit.refreshable !== true
  const created = Number(hit.createdAt)
  const fresh = Number.isFinite(created) && Date.now() - created < PLACEHOLDER_MAX_AGE_MS
  return sameName && noExpiry && notRefreshable && fresh ? 'yes' : 'no'
}

/**
 * 收掉一条「还没登录成功的占位账号」—— 但只在它确实是占位时才删。
 *
 * `account.create` 会**立刻**在池里写一条占位条目（好让 `login.poll` 能查到），
 * 本体只在登录失败路径自己删；用户放弃授权时没人删，于是每点一次「添加账号」
 * 再关掉就多一条幽灵账号。
 *
 * ⚠️ 控制台的「关闭」只是关掉前端弹窗，**不会通知本体** —— 本体没有
 * `login.cancel` 这类 RPC（全库只有 `login.poll` / `login.sendSms` /
 * `login.submitSms`）。accio 那条路虽然有 `close()` 回调会 `fail()` 并
 * `removePlaceholder`，但那个回调只有本体自己的超时定时器会触发，前端关弹窗
 * 够不着它。所以占位账号只能由控制台在这里回收。
 *
 * 所有「要回收占位账号」的路径都走这里（关弹窗、连续点添加账号），
 * 两条路径策略必须一致，否则总有一条会误删刚拿到凭据的号。
 */
function reclaimPlaceholder(accountId, provider) {
  if (!accountId) return Promise.resolve()
  return isPlaceholder(accountId, provider)
    .then(async (ghost) => {
      // 'yes' 才继续往下判；'no' 确证不是占位、'unknown' 问不出来 —— 都不删。
      if (ghost !== 'yes') return loadAccounts()
      // ⚠️ 删前必须再问一次 `login.poll`（2026-10-29 二审发现的真实缺陷）。
      //
      // 池条目的四字段判据有一个挡不住的窗口：本体 `finishLogin` 是**两步** ——
      // 先 `persistLogin` 把凭据落盘，之后才 `fillAccountEntry` 回填池条目，
      // 且回填失败只 warn 不抛。而 `login.poll` 的成功判据是「凭据能 resolve」，
      // **不是**池条目三字段。所以在「凭据已写、池条目未回填」这段时间里，
      // 四字段判据会把它判成占位并删掉，随后本体才把凭据写进来 ——
      // 终态是「池里没账号、凭据库里留一条孤儿凭据」，不可逆。
      //
      // `done === true` 说明凭据已经落地，保留；只有「还没落地」才删。
      try {
        const s = await rpc('login.poll', { accountId })
        if (s?.done === true) return loadAccounts()
      } catch {
        // poll 都问不出来就保守处理：不删。
        return loadAccounts()
      }
      return rpc('account.delete', { accountId }).then(() => loadAccounts())
    })
    .catch(() => {
      /* 已经不在池里（本体自己删过 / 别处删过）就不管了 */
    })
}

function closeLogin() {
  clearInterval(loginTimer)
  loginTimer = undefined
  $('#loginModal').hidden = true
  const abandoned = loginAccountId
  const provider = loginProvider
  loginAccountId = undefined
  loginProvider = undefined
  if (!abandoned) return
  reclaimPlaceholder(abandoned, provider)
}

/**
 * Key 型渠道：没有浏览器授权流程，本体不接受 `account.create`
 * （实测传 provider:'modelscope' / 'opencode' 回 `unknown provider: xxx`），
 * 只能走各自的前缀改道方法 `*.addAccount`。
 *
 * 官方客户端也这么选：vendor/lib/client/jet-hub.js 的 createAccount()（`:8642`）在
 * `vendor/lib/client/jet-hub.js:8647`（`if (provider === "opencode")`）与
 * `:8651`（`if (provider === "modelscope")`）两处都提前调
 * `setKeyModal({ provider, error: "" })`（分别在 `:8648` / `:8652`）然后 return，
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
  qiniu: {
    method: 'qiniu.addAccount',
    hint: '七牛云 AI 的 API Key。同一把 Key 重复添加会复用同一条账号。',
    where: 'https://portal.qiniu.com/ai-inference/api-key',
  },
  // 2026-11-04 同步上游新增的三家。都是「静态 Key」渠道：上游没有任何 refresh 端点，
  // 建号时 `refreshable` 写 `false`（`jet-hub-store.js` 的例外表），所以卡片上不会
  // 显示「自动续期」—— 这是事实，不是缺陷。
  baizhi: {
    method: 'baizhi.addAccount',
    hint: '百智云的 API Key。同一把 Key 重复添加会复用同一条账号。',
    where: 'https://ai-models.app.baizhi.cloud/console/keys',
  },
  monkeycode: {
    method: 'monkeycode.addAccount',
    hint: 'MonkeyCode（国内站 monkeycode-ai.com）的 API Key。同一把 Key 重复添加会复用同一条账号。',
    where: 'https://monkeycode-ai.com',
  },
  monkeycodeintl: {
    // ⚠️ 两站**账号体系隔离**：同一把 Key 在 `.com` 与 `.net` 上是两条不同的账号，
    // 所以控制台把它们当两家独立渠道列出，不做任何合并。
    method: 'monkeycodeintl.addAccount',
    hint: 'MonkeyCode 国际站（monkeycode-ai.net）的 API Key，与国内站账号体系隔离 —— 同一把 Key 在两边是两条账号。',
    where: 'https://monkeycode-ai.net',
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
 * qiniu 有同款的 `qiniu.setApiKey`（`vendor/lib/qiniu-rpc.js`，语义与 modelscope 一致：
 * Key 尾段派生 id、先建后删、回 `renamed`），所以它也有这个按钮。
 * opencode **没有** setApiKey（对照 `opencode-rpc.js` 的 case 表，只有 addAccount），
 * 唯一出路是先删后加 —— 所以这里不给 opencode 这个按钮，不让用户看到一条走不通的路。
 */
const REKEY_CHANNELS = {
  modelscope: {
    method: 'modelscope.setApiKey',
    hint: '换成另一把 Key 会**换一条账号**（id 随 Key 尾 8 位变）：本体先建新号再删旧号，' +
      '昵称与停用状态都继承旧的。填同一把 Key 则只刷新凭据，账号不变。',
    where: 'https://modelscope.cn/my/myaccesstoken',
  },
  qiniu: {
    method: 'qiniu.setApiKey',
    hint: '换成另一把 Key 会**换一条账号**（id 随 Key 派生）：本体先建新号再删旧号，' +
      '昵称与停用状态都继承旧的。填同一把 Key 则只刷新凭据，账号不变。',
    where: 'https://portal.qiniu.com/ai-inference/api-key',
  },
  // 2026-11-04 同步上游新增的三家，语义与上面两家一致（Key 派生 id、先建后删、回 `renamed`）。
  baizhi: {
    method: 'baizhi.setApiKey',
    hint: '换成另一把 Key 会**换一条账号**：本体先建新号再删旧号。填同一把 Key 则只刷新凭据。',
    where: 'https://ai-models.app.baizhi.cloud/console/keys',
  },
  monkeycode: {
    method: 'monkeycode.setApiKey',
    hint: '换成另一把 Key 会**换一条账号**：本体先建新号再删旧号。填同一把 Key 则只刷新凭据。',
    where: 'https://monkeycode-ai.com',
  },
  monkeycodeintl: {
    method: 'monkeycodeintl.setApiKey',
    hint: '换成另一把 Key 会**换一条账号**：本体先建新号再删旧号。填同一把 Key 则只刷新凭据。',
    where: 'https://monkeycode-ai.net',
  },
}

function openRekeyModal(accountId, provider) {
  // `provider` 由调用方（账号行按钮）传进来 —— 不能读 `#accProvider`，
  // 那个下拉是「新建账号」用的，跟这行的账号可能不是同一家。
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
      // 方法名写字面量（tests/t-rpc-cover.mjs 按字面量数覆盖率，用变量拼会数不到）——
      // 所以这里逐家各写一行字面量，而不是按 REKEY_CHANNELS 表取方法名。
      const v = provider === 'qiniu'
        ? await rpc('qiniu.setApiKey', { accountId, apiKey })
        : provider === 'baizhi'
          ? await rpc('baizhi.setApiKey', { accountId, apiKey })
          : provider === 'monkeycode'
            ? await rpc('monkeycode.setApiKey', { accountId, apiKey })
            : provider === 'monkeycodeintl'
              ? await rpc('monkeycodeintl.setApiKey', { accountId, apiKey })
              : await rpc('modelscope.setApiKey', { accountId, apiKey })
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
 * （vendor/lib/jet-hub-rpc.js:3159 `method.startsWith('qoder.')`，而
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

/**
 * 有 onboarding（新人任务）实现的渠道。
 *
 * ⚠️ 必须与 `vendor/lib/provider-onboarding.js` 的实现表一一对应 —— 目前只有
 * 四家：`loomy`（:63）、`raccoon`（:108）、`magicrew`（:176）、`magicrewintl`
 * （:185）。其余 24 家走 `vendor/lib/jet-hub-rpc.js:6393-6394` 的
 * `unsupported provider` 分支，渲染出来的按钮点了必报 bad-request。
 *
 * ⚠️ 加新供应商时**两处一起改**（实现表 + 这里），否则要么按钮缺失、
 * 要么按钮点了报错。`tests/t-rpc-cover.mjs` 不管这个（它只对账 RPC 方法名）。
 */
const ONBOARDING_PROVIDERS = new Set(['loomy', 'raccoon', 'magicrew', 'magicrewintl'])

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

/**
 * 只放行 http(s) 的登录地址。
 *
 * `#lmOpen` 是 `<a href>`，`window.open` 也吃字符串 —— `rel="noreferrer"`
 * 不阻止 `javascript:` 协议。登录地址目前由 `account.create` 的服务端适配器
 * 拼出来（不是用户直接输入），但一旦某个适配器把外部字符串拼进去，这里就是
 * 一次点击型 XSS。白名单只放 http / https 两条，其余一律拒绝。
 *
 * @returns {string|null} 规范化后的地址；非法协议或空串返回 `null`
 */
function safeLoginUrl(raw) {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const u = new URL(raw)
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href
  } catch {
    /* 不是合法 URL：拒绝 */
  }
  return null
}

async function startLogin(provider) {
  // 先把上一次没关的登录弹窗收干净 —— 必须在 KEY_CHANNELS 判断之前：
  // 否则「开着 OAuth 弹窗把渠道切到 modelscope 再点添加」会两个弹窗叠着，
  // 而 .modal 没有 z-index、#loginModal 在 DOM 里更靠后，旧的登录弹窗会把
  // key 弹窗整个盖住，用户看到的还是「等待授权…」—— 正是本次要修的症状。
  const stale = loginAccountId
  if (stale) closeLogin()
  if (KEY_CHANNELS[provider]) {
    openKeyModal(provider)
    return
  }
  // 上一次登录没关就直接又点了「添加账号」：上面 closeLogin 已经把那条占位
  // 账号交给 reclaimPlaceholder 回收（它用 isPlaceholder 的四条判据确认「还是占位」，
  // 不会误删刚拿到凭据的号 —— 登录成功会把 nickname 换成真昵称、refreshable 置真、
  // 补上 expiresAt，三条一起变，四条判据就不再同时成立）。
  const v = await rpc('account.create', { provider })
  const { accountId } = v ?? {}
  // ⚠️ `reused: true` + 空 `loginUrl` 是「导入本机会话」的**成功**出口
  // （`vendor/lib/jet-hub-rpc.js:5676-5677` 的注释、`:5713` 的返回值；
  // 上游 `client/jet-hub.js` 按 `if (res.reused)` 接受空 loginUrl 并直接
  // `loadAccounts()`）。这条路径**没有授权页可开**，也不需要轮询 ——
  // 账号已经 `pool.addAccount` + `pool.updateAccount` 建好了。
  //
  // 必须在下面给 `loginAccountId` 赋值**之前**分流：否则会落到 `!loginUrl`
  // 的失败分支，把一次成功的导入显示成「本体没有返回 loginUrl」的错误。
  // 可达路径：astudio 在本机已导入 AStudio 会话时返回
  // `{ accountId, loginUrl: '', reused: true }`（`vendor/lib/jet-hub-rpc.js`
  // 的 astudio 分支，:5713）。
  if (v?.reused === true) {
    $('#loginModal').hidden = true
    await loadAccounts()
    say('#accMsg', `已导入本机 ${provider} 会话${accountId ? `（${accountId}）` : ''}`, 'ok')
    return
  }
  // ⚠️ 只放行 http(s)（见 safeLoginUrl 的注释）。空串是「复用了本机已有会话」
  // 的合法形态（`vendor/lib/jet-hub-rpc.js` 的 `{ accountId, loginUrl: '',
  // reused: true }`），不算协议错误 —— 它在上面就已经分流走了。
  const loginUrl = safeLoginUrl(v?.loginUrl)
  loginAccountId = accountId
  loginProvider = provider
  if (v?.loginUrl && loginUrl === null) {
    // ⚠️ 抛之前必须把状态收干净 —— 与下面 `!loginUrl` 分支同一条纪律
    // （2026-10-29 三审发现的真实泄漏）。到这里 `loginAccountId` /
    // `loginProvider` 已经赋值，直接抛会让 `loginAccountId` 残留到下一次点
    // 「添加账号」时被当成「放弃授权」去 `reclaimPlaceholder` 回收 —— 那是
    // 一条**真实**的账号，删错了没法恢复。占位账号留着不致命（列表里多一条
    // 「未登录」），比误删安全。
    loginAccountId = undefined
    loginProvider = undefined
    throw new Error(`登录地址不是 http/https（${String(v.loginUrl).slice(0, 60)}），已拒绝打开`)
  }
  $('#lmProvider').textContent = provider
  $('#lmState').textContent = '等待授权…'
  $('#lmState').className = 'msg'
  $('#lmHint').textContent = '浏览器没自动打开时，复制下面的地址手动访问，授权完成后本页会自动继续。'
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
    // 浏览器会拦掉「不在用户手势里」的 window.open：这里是 await 之后调的，
    // 手势已经失效，Chrome/Edge 会直接拦下并返回 null。被拦时页面什么都没
    // 发生，用户会以为「添加账号点了没用」—— 所以被拦时把提示换成让他点
    // 「在新窗口打开」（那是 <a> 的真实点击，一定放行）。
    //
    // ⚠️ 不能用 `window.open(url, '_blank', 'noreferrer')` 来测：`noreferrer`
    // 隐含 `noopener`，按 HTML 规范这种情形 window.open **必须**返回 null，
    // 与有没有被拦无关 —— 拿它当判据等于恒真，提示会跟事实反着说
    // （实测：返回 null 的同时窗口确实开了）。这里不带 noopener 拿到真实
    // 返回值，再立刻把 opener 摘掉做同样的隔离。
    let opened = null
    try {
      opened = window.open(loginUrl, '_blank')
      if (opened) {
        try {
          opened.opener = null
        } catch {
          /* 跨源窗口不让改 opener 就算了，不影响使用 */
        }
      }
    } catch {
      /* 沙箱里可能直接抛，按被拦处理 */
    }
    if (!opened) {
      $('#lmHint').textContent = '浏览器拦下了自动弹窗（授权页必须由你亲手点开）。点下面的「在新窗口打开」，或复制地址到新标签页访问，授权完成后本页会自动继续。'
      $('#lmState').textContent = '等你打开授权页…'
      $('#lmState').className = 'msg'
    }
  } else {
    // ⚠️ 抛之前必须把状态收干净（2026-10-29 三审发现的真实泄漏）。
    // 到这里 `loginAccountId` / `loginProvider` 已经赋值、`#loginModal` 也已经
    // `hidden = false`，但轮询定时器还没建立 —— 直接抛会让弹窗永远停在
    // 「等待授权…」且没有任何轮询，同时 `loginAccountId` 残留到下一次点
    // 「添加账号」时被当成「放弃授权」去回收（可能误伤）。
    //
    // 可达路径：astudio 在本机已导入 AStudio 会话时返回
    // `{ accountId, loginUrl: '', reused: true }`（`vendor/lib/jet-hub-rpc.js`
    // 的 astudio 分支），空串是 falsy 就走这里。
    loginAccountId = undefined
    loginProvider = undefined
    $('#loginModal').hidden = true
    throw new Error('本体没有返回 loginUrl（这个渠道可能复用了本机已有的登录会话，去 DSH 的 Jet Hub 里看看是否已经加上了）')
  }
  const started = Date.now()
  clearInterval(loginTimer)
  loginTimer = setInterval(async () => {
    if (Date.now() - started > 5 * 60 * 1000) {
      $('#lmState').textContent = '超时（5 分钟），可关闭后重试'
      $('#lmState').className = 'msg err'
      clearInterval(loginTimer)
      loginTimer = undefined
      return
    }
    try {
      const s = await rpc('login.poll', { accountId })
      if (s?.done === true) {
        clearInterval(loginTimer)
        if (s.success === false) {
          // 本体在失败路径里自己把占位账号删了，这里别再删一次。
          clearInterval(loginTimer)
          loginTimer = undefined
          loginAccountId = undefined
          $('#lmState').textContent = `登录失败：${s.error ?? '未知原因'}`
          $('#lmState').className = 'msg err'
        } else {
          $('#lmState').textContent = '✓ 登录成功'
          $('#lmState').className = 'msg ok'
          // 账号已经拿到凭据，别再当成「放弃授权」删掉。
          //
          // ⚠️ 收尾定时器必须带身份校验（2026-10-29 二审发现的真实回归）：
          // 这 900ms 里用户完全可能又点了一次「添加账号」并开了一次新登录。
          // 那时 `loginAccountId` / `loginTimer` 已经是**下一次**的了，
          // 无条件调 `closeLogin()` 会关掉新弹窗、clearInterval 掉新轮询，
          // 并且把新登录的占位账号当成「放弃授权」删掉 —— 实测现象是
          // 「新弹窗闪一下就没了、账号消失」。
          const settledId = loginAccountId
          loginAccountId = undefined
          setTimeout(() => {
            // 期间又开了新登录 ⇒ 这次收尾已经过时，什么都不做。
            if (loginAccountId !== undefined) return
            if (settledId !== undefined) {
              // 没开新登录：只关 UI，不再走 closeLogin（那会回收账号）。
              clearInterval(loginTimer)
              loginTimer = undefined
              $('#loginModal').hidden = true
            }
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
  const provider = $('#accProvider').value
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
  const provider = $('#accProvider').value
  try {
    await busy(btn, async () => {
      // 「刷新余额」是用户主动要求回源的唯一入口 —— 不传 `force` 会拿到 120 秒内
      // 的共享读数缓存，按钮点了等于没点（`vendor/lib/types.d.ts:911` 的 `force`
      // 注释明确写着它服务的就是这个按钮）。
      const v = await rpc('credits.balances', { provider, force: true })
      renderGeneric($('#credOut'), v)
      say('#credMsg', '已查询余额', 'ok')
      // 卡片上的积分是同一份数据，不刷新会出现「上面还是旧数、下面已经是新数」。
      // 直接把这份回包喂给 `loadBalances`，别再发一次同样的 RPC。
      if ($('#accProvider').value !== provider) return
      BAL = await loadBalances(provider, v)
      renderAccounts(provider)
    })
  } catch (e) {
    say('#credMsg', String(e.message ?? e), 'err')
  }
}

async function creditsBadge(btn) {
  const provider = $('#accProvider').value
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

/**
 * token：`>= 1e6` → `94.54M`；`>= 1e3` → `945.39K`；其余取整。
 *
 * 与 `vendor/lib/credits.js:480` 的 `formatTokenAmount`（进而与客户端
 * `credits-format.js` 的 `formatTokens`）逐字一致。
 */
function formatTokenAmount(value) {
  const abs = Math.abs(value)
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}K`
  return String(Math.round(value))
}

/** 积分：整数不带小数位，有小数才保留两位（与客户端 `formatCredits` 一致）。 */
function formatCreditAmount(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

/**
 * 把 `totalByUnit` 拼成 `+100.00MToken, +100积分`。
 *
 * ⚠️ 不能直接展示 `summary.totalCredit`：`vendor/lib/jet-hub-rpc.js:511-517`
 * 明确写它会把不同量纲加在一起（ZCode 的 1 亿 token + 100 积分 =
 * `100000100`），「**不要**在展示路径上用它」。正确的字段是同层的
 * `totalByUnit`（`computeClaimSummary` 同时产出两者，`totalCredit` 只为兼容
 * 既有契约而保留原语义）。
 *
 * 这里是 `vendor/lib/credits.js:523` 的 `formatClaimGains` 的同形实现（浏览器侧
 * 不能 import vendor 的模块图，只能复刻）：只列**非零**单位、token 在前、每个
 * 单位各带一个 `+`、数值与单位之间**不留空格**。
 *
 * ⚠️ 复刻必须是**逐字**的：`token` 走 M / K 两档，`credit` 整数不带小数位、
 * 有小数才保留两位。少了 K 档，5000 token 会渲染成 `5,000Token` 而不是
 * `5.00KToken`；`credit` 走 `Math.round` 会把 100.5 分成 101。
 */
function formatClaimGains(totals) {
  if (totals === undefined || totals === null || typeof totals !== 'object') return null
  const parts = []
  for (const unit of ['token', 'credit']) {
    const value = Number(totals[unit])
    if (!Number.isFinite(value) || value <= 0) continue
    const text = unit === 'token' ? formatTokenAmount(value) : formatCreditAmount(value)
    parts.push(`+${text}${unit === 'token' ? 'Token' : '积分'}`)
  }
  return parts.length === 0 ? null : parts.join(', ')
}

async function creditsClaim(btn) {
  const provider = $('#accProvider').value
  try {
    await busy(btn, async () => {
      const v = await rpc('credits.claimAll', { provider })
      renderGeneric($('#credOut'), v)
      const s = v?.summary
      const gained = formatClaimGains(s?.totalByUnit)
      say('#credMsg', s ? `领取 ${s.claimed} 个${gained === null ? '' : `，${gained}`}；已领 ${s.alreadyClaimed ?? 0}，失败 ${s.failed ?? 0}` : '已执行领取', 'ok')
      // 领完卡片上的数字就过期了，重拉一次（也要重拉余额，不然还停在这轮之前）。
      // 期间切了渠道就别渲染了 —— 新渠道的 `ACC` 还没拉，会闪一帧空列表。
      if ($('#accProvider').value !== provider) return
      // `force: true`：余额缓存 120 秒，不强制回源的话卡片还是领取前的旧数。
      const nextBal = await loadBalances(provider, undefined, true)
      // ⚠️ 第二次 `await` 之后必须**再**校验一次 —— 期间用户可能已经切走，
      // 用旧渠道的读数渲染新渠道的账号会闪一帧全是「—」的卡。
      if ($('#accProvider').value !== provider) return
      BAL = nextBal
      renderAccounts(provider)
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
  const provider = $('#accProvider').value
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


/* ═══════════════════ 徽章偏好 ═══════════════════ */

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

/**
 * 「严格手动顺序」是**按供应商**存的（上游 `pool.strictManualOrder(provider)`，
 * 见 `vendor/lib/jet-hub-rpc.js` 的 `strictManualOrder.getEnabled`）。
 *
 * 它回答的是「拖拽排序到底算不算数」：关着的时候，走余额分档的渠道会**盖过**
 * 卡片顺序（这就是「拖拽时灵时不灵」那条报障的根）。所以开关必须放在账号页
 * —— 和「当前是哪一家」绑在一起，而不是设置页那种全局项。
 */
async function loadStrictOrder(provider) {
  const el = $('#accStrict')
  if (!el || !provider) return
  try {
    const v = await rpc('strictManualOrder.getEnabled', { provider })
    // 期间用户可能已经切走 —— 别把上一家的值盖到新渠道上。
    if ($('#accProvider').value !== provider) return
    el.checked = v?.enabled === true
    el.disabled = false
  } catch {
    // 问不出来就置灰：让用户看到「这一家没有这个能力」，而不是一个点了没反应的开关。
    el.checked = false
    el.disabled = true
  }
}

async function saveStrictOrder(enabled) {
  const provider = $('#accProvider').value
  if (!provider) return
  try {
    await rpc('strictManualOrder.setEnabled', { provider, enabled })
    say('#accMsg', `严格手动顺序已${enabled ? '开启' : '关闭'}（${provider}）`, 'ok')
  } catch (e) {
    say('#accMsg', String(e.message ?? e), 'err')
    // 落盘失败就把开关拨回去，别让界面停在「已开启」的假状态。
    await loadStrictOrder(provider)
  }
}

async function loadSettings() {
  try {
    const [ns, pe, xff, sb] = await Promise.all([
      rpc('nativeSearch.getEnabled').catch(() => ({})),
      rpc('panelEntry.get').catch(() => ({})),
      rpc('minimax.getXff').catch(() => ({})),
      rpc('sessionBalance.getEnabled').catch(() => ({})),
    ])
    $('#setSearch').checked = ns?.enabled === true
    $('#setSession').checked = sb?.enabled === true
    if (pe?.entry) $('#setPanel').value = pe.entry
    $('#setXff').value = xff?.xff ?? ''
    say('#setMsg', '')
  } catch (e) {
    say('#setMsg', String(e.message ?? e), 'err')
  }
}

async function saveSetting(what, value) {
  try {
    // 网关启用 / 允许局域网已从这里移除：magpie 的 Settings › Network and sharing
    // 才是那两项的界面。直连模式下本体网关本来就被 DSH_OPENAI_GATEWAY_ENABLED=0
    // 关掉、插件根本不经过它，在这里改也改不动任何东西。
    if (what === 'search') await rpc('nativeSearch.setEnabled', { enabled: value })
    if (what === 'panel') await rpc('panelEntry.set', { entry: value })
    if (what === 'xff') await rpc('minimax.setXff', { xff: value })
    if (what === 'session') await rpc('sessionBalance.setEnabled', { enabled: value })
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

/* 备份文件有两种形态：前端导出时可选加一层壳。CLI 的 import-backup.mjs 认它，
   控制台原来只认不加壳的那种，于是拿加壳的备份来导入只会看到「不是
   dsh-codearts-auth/backup 备份文件」。这里用 WebCrypto 复刻 CLI 的同一套参数
   （PBKDF2-SHA256，默认 310000 轮，AES-256-GCM，密文尾部 16 字节是 tag）——
   控制台跑在 127.0.0.1，属 secure context，crypto.subtle 可用。 */
const PLAIN_FORMAT = 'dsh-codearts-auth/backup'
const ENCRYPTED_FORMAT = 'dsh-codearts-auth/backup.encrypted'
const KDF_ITERATIONS = 310000
// 迭代数上限：容器里的 iterations 直接进 PBKDF2，一个 1e9 的（损坏/恶意）文件
// 足以把标签页拖到假死。超过 500 万就拒，与 scripts/import-backup.mjs 同值。
const MAX_KDF_ITERATIONS = 5000000

/** base64 → Uint8Array（atob 只给 latin1 字符串，得自己搬字节）。 */
function b64ToBytes(s) {
  let bin
  try {
    bin = atob(String(s))
  } catch {
    // atob 对非法字符抛 InvalidCharacterError，报文是 "Failed to execute 'atob'…"，
    // 用户完全看不懂；这是容器坏了，不是口令问题。
    throw new Error('加密容器里的 salt / iv / ciphertext 不是合法 base64（文件可能被截断或改过）')
  }
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}

/** 解密加壳备份。WebCrypto 的 AES-GCM 直接吃「密文 || tag」，与 Node 侧一致。 */
async function decryptBackup(enc, passphrase) {
  // 控制台只绑 127.0.0.1（src/hub-server.mjs 的 host 默认值），正常一定是安全上下文。
  // 这里只是兜底：万一以后有人改了绑定地址、或经反代访问，crypto.subtle 会是
  // undefined，那时下面会抛 "Cannot read properties of undefined" —— 看不懂，直接说清。
  if (!globalThis.crypto?.subtle) {
    throw new Error('这个地址不是安全上下文，浏览器不给 WebCrypto：请改用 http://127.0.0.1:<端口> 打开控制台再导入加壳备份')
  }
  const salt = b64ToBytes(enc.salt ?? '')
  const iv = b64ToBytes(enc.iv ?? '')
  const blob = b64ToBytes(enc.ciphertext ?? '')
  if (salt.length === 0 || iv.length === 0 || blob.length <= 16) {
    throw new Error('加密容器缺 salt / iv / ciphertext')
  }
  const iterations = Number.isSafeInteger(enc.iterations) && enc.iterations > 0 ? enc.iterations : KDF_ITERATIONS
  if (iterations > MAX_KDF_ITERATIONS) {
    throw new Error(`加密容器的迭代数 ${iterations} 超出上限 ${MAX_KDF_ITERATIONS}（文件可能被改过）`)
  }
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  )
  let plain
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, blob)
  } catch (e) {
    // AES-GCM 认证失败只有一种可说的原因组合：口令不对，或文件被改过。都不可重试。
    // 附上底层 message：iv 长度非法、容器被截断这类畸形文件也能对上号，
    // 否则一律「口令不对」会让人白试口令（CLI 侧 scripts/import-backup.mjs 同样带）。
    throw new Error(`解密失败：口令不对，或文件被改动过（${e?.message ?? e}）`)
  }
  const text = new TextDecoder().decode(plain)
  try {
    return JSON.parse(text)
  } catch (e) {
    // 口令对了、容器也完整，只是里面不是 JSON —— 与「口令不对」是两回事，分开说
    throw new Error(`解密成功，但内容不是合法 JSON（${e?.message ?? e}）`)
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
      // ⚠️ `passEl` 必须在 `if` **外面**取：下面导入成功后还要用它清口令。
      // 原先它声明在 `if (parsed?.format === ENCRYPTED_FORMAT)` 块内，块外引用是
      // `ReferenceError: passEl is not defined`，被外层 catch 吞掉后把「导入完成」
      // 覆盖成一条报错 —— 导入其实成功了，用户却以为失败。
      const passEl = $('#bkPass')
      // 加壳的备份先解密再往下走：口令留空就直说，别让它撞到 decrypt 里变成「口令不对」。
      if (parsed?.format === ENCRYPTED_FORMAT) {
        // 口令**不裁剪**：导出侧（vendor/lib/client/jet-hub.js）与 CLI 都按原样取，
        // 这里一 trim，首尾带空格的口令（复制粘贴时最常见）就解不开，而且只报
        // 「口令不对」，用户无从判断。空口令单独拦，不走解密。
        const pass = String(passEl?.value ?? '')
        if (pass === '') throw new Error('这份备份加了壳，先在「加密备份的口令」里填口令')
        parsed = await decryptBackup(parsed, pass)
      }
      if (parsed?.format !== PLAIN_FORMAT) {
        throw new Error(`不是 ${PLAIN_FORMAT} 备份文件（format=${String(parsed?.format)}）`)
      }
      // keepDisabledModels: 覆盖（replace）只换账号池与永久锁定表，**不换模型黑名单**。
      // 备份里的黑名单是导出那一刻的状态，整份还原会让「全关」重新落到本机，
      // 而控制台 2026-10-31 起没有模型开关，用户没有界面能清掉（见 scripts/import-backup.mjs）。
      const v = await rpc('backup.import', { payload: parsed, mode, keepDisabledModels: true })
      renderGeneric($('#bkOut'), v)
      say('#bkMsg', '导入完成', 'ok')
      // 清掉口令：换一份口令不同的备份时不会静默沿用旧值（否则只报「口令不对」）
      if (passEl) passEl.value = ''
    })
    await loadBackup()
  } catch (e) {
    say('#bkMsg', String(e.message ?? e), 'err')
    // 失败也清口令：换一份口令不同的加壳备份时不会静默沿用旧值
    // （旧值只会再报一次「口令不对」，看着像同一个问题其实换了原因）
    const passEl = $('#bkPass')
    if (passEl) passEl.value = ''
  }
}

/* ═══════════════════ 启动 ═══════════════════ */

// 路由组不是真渠道：它们没有自己的账号，模型是「从别家挑一个」。
// 放进下拉时排到最后，否则默认选中它 → 账号页空。
//
// ⚠️ 2026-10-31：`aggregate` / `jet-hub-auto` 既不注册成 magpie provider，
// 控制台也不再提供它们的配置页（magpie 侧没有对应入口）⇒ 这个集合现在是空的。
// 留着是为了将来本体若再引入「不是真渠道」的 provider 时，直接加一个名字
// 就能继续排序。
const ROUTE_GROUPS = new Set([])

function orderedProviders() {
  const real = META.providers.filter((p) => !ROUTE_GROUPS.has(p.id))
  const groups = META.providers.filter((p) => ROUTE_GROUPS.has(p.id))
  return [...real, ...groups]
}

/** 给供应商配一个稳定的色相：同一家每次刷新都同色，不用维护图标表。 */
function hueOf(id) {
  let h = 0
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) % 360
  return h
}

/**
 * 侧栏的供应商列表。点一家 = 切到它的账号池。
 *
 * 图标来自 `icons.js` 的 `window.PROVIDER_ICONS`（上游 `provider-icons.js` 的
 * 29 个 data URI）。没登记的那几家退回「首字 + 色相」，不是空白。
 */
function renderProviderList() {
  $('#providerList').innerHTML = orderedProviders()
    .map((p) => {
      const n = p.models?.length ?? 0
      const label = p.name || p.id
      const src = window.PROVIDER_ICONS?.[p.id]
      const icon = src
        ? `<img src="${src}" alt="">`
        : esc(label.trim().charAt(0).toUpperCase() || '?')
      return `<button class="providerItem" data-provider="${esc(p.id)}" title="${esc(label)}（${n} 个模型）">
        <span class="providerIcon"${src ? ' data-icon' : ` style="--hue: ${hueOf(p.id)}"`} aria-hidden="true">${icon}</span>
        <span class="providerLabel"><strong>${esc(label)}</strong><small>${n} 个模型</small></span>
      </button>`
    })
    .join('')
}

/**
 * 切换当前供应商。
 *
 * `#accProvider` 是隐藏域，仍是**唯一**状态源 —— `$('#accProvider').value` 那十几个
 * 调用点（`renderAccounts` / `syncProxyButtons` / `openProxyModal` …）一行都不用改。
 */
function setProvider(id, { silent = false } = {}) {
  if (!id) return
  const changed = $('#accProvider').value !== id
  $('#accProvider').value = id
  $$('#providerList .providerItem').forEach((b) => b.classList.toggle('on', b.dataset.provider === id))
  const p = META.providers.find((x) => x.id === id)
  $('#accProviderName').textContent = p ? p.name || p.id : id
  syncProxyButtons()
  // 严格手动顺序是**按供应商**存的 ⇒ 切一家就要重读一次（否则开关会停在上家的值）。
  loadStrictOrder(id)
  if (!silent && changed) loadAccounts()
}

const TAB_LOADERS = {
  // ⚠️ `overview` 必须在这里：它原先只在 `boot()` 里渲染一次，切回概览页时
  // `loadGatewayCards()` / `loadAutoCheckin()` 都不会重跑，于是网关状态与自动
  // 签到状态永远停在打开页面那一刻（在设置页改了东西回来还是旧值）。
  overview: () => renderOverview(),
  backup: () => loadBackup(),
  settings: () => {
    loadSettings()
    badgeLoad()
  },
}

function wireTabs() {
  // 底部那三个切页按钮
  $('#nav').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]')
    if (!b) return
    $$('#nav button').forEach((x) => x.classList.toggle('on', x === b))
    $$('.tab').forEach((t) => t.classList.toggle('on', t.id === `tab-${b.dataset.tab}`))
    TAB_LOADERS[b.dataset.tab]?.()
  })
  // 侧栏供应商：点一家就切回账号池（底部三个按钮都不高亮 —— 账号页不对应任何按钮）
  $('#providerList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-provider]')
    if (!b) return
    $$('#nav button').forEach((x) => x.classList.remove('on'))
    $$('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-accounts'))
    setProvider(b.dataset.provider)
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

  renderProviderList()
  // 默认选「有模型的第一家」，没有就退到第一家 —— 空 provider 打开就是一片空卡片。
  const firstProvider = orderedProviders().find((p) => (p.models?.length ?? 0) > 0) ?? orderedProviders()[0]
  // silent 只写状态、不发请求：真正的首次加载在 boot() 末尾统一做（那里所有监听器都挂好了）。
  // 别在这里再调一次 loadAccounts() —— 会变成首屏两次 account.list + 两次 credits.balances。
  if (firstProvider) setProvider(firstProvider.id, { silent: true })
  syncProxyButtons()
  renderOverview()
  wireTabs()

  // 账号
  $('#accReload').addEventListener('click', () => loadAccounts())
  $('#accList').addEventListener('click', onAccAction)
  $('#accRetestAll').addEventListener('click', (e) => accBulk(e.currentTarget, 'account.retestAll'))
  $('#accResetAll').addEventListener('click', (e) => accBulk(e.currentTarget, 'account.resetAll'))
  // 「严格手动顺序」按供应商存 —— 切换账号页时重新读（见 loadStrictOrder 的注释）。
  $('#accStrict').addEventListener('change', (e) => saveStrictOrder(e.target.checked))
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

  // 积分专项 + 永久锁定
  $('#credClineLog').addEventListener('click', (e) => creditsSpecial(e.currentTarget, 'clineLog'))
  $('#lockLoad').addEventListener('click', (e) => lockAction(e.currentTarget, 'load'))
  $('#lockOn').addEventListener('click', (e) => lockAction(e.currentTarget, 'on'))
  $('#lockOff').addEventListener('click', (e) => lockAction(e.currentTarget, 'off'))

  // 供应商：控制台不再提供 —— magpie 自己的「Providers」页就是那个界面
  // （启用 / 停用、拖拽排序、看模型数与账号数）。本体的 provider.setOrder 只是
  // DSH 界面里的显示顺序，在 magpie 里看不见；provider.setEnabled 的「关掉一家」
  // 「关掉一家的全部模型」等价操作在 magpie 的 Providers 编辑器里勾掉全部模型
  // （或 Select none）；控制台不再提供 model.setAllDisabled 这类开关。

  // 徽章偏好：原先挂在「用量」标签里，标签删掉后搬到设置页（值仍是 usage.badgePreference）
  $('#badgeSave').addEventListener('click', (e) => badgeSave(e.currentTarget))

  // 设置：网关启用 / 允许局域网这两项已移除 —— magpie 的
  // Settings › Network and sharing 就是它们的界面（端口、局域网共享、允许的 IP、
  // 网页白名单都在那儿）。控制台再摆一遍只会两处打架。
  $('#setSearch').addEventListener('change', (e) => saveSetting('search', e.target.checked))
  $('#setPanel').addEventListener('change', (e) => saveSetting('panel', e.target.value))
  $('#setXff').addEventListener('change', (e) => saveSetting('xff', e.target.value.trim()))
  $('#setSession').addEventListener('change', (e) => saveSetting('session', e.target.checked))
  $('#capDemand').addEventListener('click', (e) => captchaAction(e.currentTarget, 'demand'))
  $('#capCarrier').addEventListener('click', (e) => captchaAction(e.currentTarget, 'carrier'))
  $('#capContribute').addEventListener('click', (e) => captchaAction(e.currentTarget, 'contribute'))

  // 备份
  $('#bkExport').addEventListener('click', (e) => doExport(e.currentTarget))
  $('#bkImport').addEventListener('click', (e) => doImport(e.currentTarget))

  loadAccounts()
}

boot()
