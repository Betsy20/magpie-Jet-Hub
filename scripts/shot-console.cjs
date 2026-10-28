// 控制台截图 + DOM 断言（Node 24 内置 WebSocket）。
// 用法: node scripts/shot-console.cjs [tab1 tab2 ...]
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9341
const OUT = path.join(__dirname, '..', 'docs')

/**
 * 控制台真实地址。只读 `jet-hub-console.json` 不够：那个文件是**最后写入者**
 * 留下的，宿主被强杀、或测试套件起的临时容器退出后都会留一个死端口（实测：
 * 文件写 18502，而 18502 活了不到 60 秒；同时 18500/18501 一直在跑）。
 *
 * 所以顺序是 **端口升序 18500..18509**（端口从 18500 起按占用 +1 分配，最小端口
 * = 默认宿主 = 用户长期开着的那台），文件里的地址只当补充候选；活不活一律由
 * `/__meta` 验。与 page/models.js 的取法一致（scripts/snapshot-models.mjs），
 * 这样侧栏页显示的端口和这里截的图保证是同一台宿主。
 */
const probe = (url) =>
  new Promise((resolve) => {
    const req = http.get(`${url}__meta`, { timeout: 1500 }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })

async function readConsoleUrl() {
  const cands = []
  for (let port = 18500; port < 18510; port += 1) cands.push(`http://127.0.0.1:${port}/`)
  try {
    const p = path.join(process.env.USERPROFILE, '.config/magpie/jet-hub-console.json')
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (typeof j?.url === 'string' && j.url) {
      const u = j.url.endsWith('/') ? j.url : `${j.url}/`
      if (!cands.includes(u)) cands.push(u)
    }
  } catch {
    /* 文件不在或坏了就只探默认区间 */
  }
  let live = 0
  let hit = ''
  for (const url of cands) {
    if (!(await probe(url))) continue
    live += 1
    if (!hit) hit = url
  }
  if (live > 1) console.log(`⚠ 检测到 ${live} 个控制台宿主同时在跑；本脚本只用端口最小的 ${hit}`)
  return hit || 'http://127.0.0.1:18500/'
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const tabs = process.argv.slice(2)
  const want = tabs.length ? tabs : ['overview', 'accounts', 'credits', 'models', 'providers', 'usage', 'settings', 'backup']
  const URL_BASE = process.env.CONSOLE_URL || (await readConsoleUrl())
  console.log(`控制台: ${URL_BASE}`)
  fs.mkdirSync(OUT, { recursive: true })
  const prof = path.join(require('node:os').tmpdir(), 'edge-console-' + Date.now())
  const proc = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${prof}`,
    '--window-size=1440,900',
    '--hide-scrollbars',
    '--no-first-run',
    '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore' })

  let wsUrl
  for (let i = 0; i < 60; i++) {
    await sleep(400)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const t = list.find((x) => x.type === 'page')
      if (t?.webSocketDebuggerUrl) { wsUrl = t.webSocketDebuggerUrl; break }
    } catch {}
  }
  if (!wsUrl) { proc.kill(); throw new Error('拿不到 CDP') }

  const ws = new WebSocket(wsUrl)
  await new Promise((r) => (ws.onopen = r))
  let id = 0
  const pending = new Map()
  const errors = []
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text)
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '))
  }
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.navigate', { url: URL_BASE })
  await sleep(2500)

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text)
    return r.result?.result?.value
  }

  const health = await ev(`(() => {
    const boot = document.querySelector('#boot')
    const app = document.querySelector('#app')
    return { bootHidden: boot?.hidden === true, appShown: app?.hidden === false, bootText: boot?.textContent ?? '', meta: typeof META === 'object' ? { providers: META.providers?.length, models: META.models } : null }
  })()`)
  console.log('启动状态:', JSON.stringify(health))
  if (!health.appShown) { console.log('页面没起来，boot 文本:', health.bootText) }

  // ---- P1 回归断言：侧栏页快照里的模型数 / 控制台地址，必须就是这一台宿主 --------
  // 侧栏页读的是 page/models.js 快照（sandbox 发不出请求），控制台地址也在同一份
  // 快照里。历史故障是「模型取自 18501、地址指向 18500（第三台又写 18502）」，
  // 所以要断言：快照 total === 这台宿主的 /__meta models，且快照 console === 本站。
  {
    const snapPath = path.join(__dirname, '..', 'page', 'models.js')
    let snap = null
    try {
      const src = fs.readFileSync(snapPath, 'utf8')
      snap = JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1))
    } catch (e) {
      console.log('✗ 读不出 page/models.js 快照：' + (e?.message || e))
      errors.push('快照不可读')
    }
    if (snap) {
      const here = String(health.meta?.models ?? '')
      const snapTotal = String(snap.total ?? '')
      const sameModels = here === snapTotal
      const sameUrl = String(snap.console || '').replace(/\/+$/, '') + '/' === URL_BASE
      const samePort = String(snap.consolePort || '') === (URL_BASE.match(/:(\d+)\//)?.[1] ?? '')
      console.log(
        `快照对齐: 模型 ${snapTotal} vs 本站 ${here} ${sameModels ? '✓' : '✗'}｜` +
        `控制台 ${snap.console} vs ${URL_BASE} ${sameUrl ? '✓' : '✗'}｜端口 ${snap.consolePort} ${samePort ? '✓' : '✗'}`,
      )
      if (!sameModels) {
        console.log(`✗ 快照的模型数(${snapTotal})不是这台宿主(:${new URL(URL_BASE).port})的(${here})，快照过期或指向别的宿主 —— 重跑 node scripts/snapshot-models.mjs`)
        errors.push('快照模型数与宿主不一致')
      }
      if (!sameUrl || !samePort) {
        console.log('✗ 快照里的控制台地址不是这台宿主 —— 重跑 node scripts/snapshot-models.mjs')
        errors.push('快照控制台地址不一致')
      }
      if (Array.isArray(snap.hosts) && snap.hosts.length > 1) {
        console.log(`⚠ 快照时还有 ${snap.hosts.length - 1} 个别的宿主在跑：${snap.hosts.map((h) => ':' + h.port).join('、')}（不影响本断言）`)
      }
    }
  }

  for (const t of want) {
    await ev(`document.querySelector('#nav button[data-tab="${t}"]').click()`)
    await sleep(t === 'credits' || t === 'accounts' ? 3200 : 1400)
    const info = await ev(`(() => {
      const sec = document.querySelector('#tab-${t}')
      const rows = sec?.querySelectorAll('tbody tr').length ?? 0
      const cards = sec?.querySelectorAll('.cardc').length ?? 0
      const btns = sec?.querySelectorAll('button').length ?? 0
      const msgs = [...(sec?.querySelectorAll('.msg') ?? [])].map(m => m.textContent).filter(Boolean)
      const err = [...(sec?.querySelectorAll('.msg.err') ?? [])].map(m => m.textContent)
      return { on: sec?.classList.contains('on'), rows, cards, btns, msgs: msgs.slice(0,6), err }
    })()`)
    console.log(`[${t}]`, JSON.stringify(info))
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    fs.writeFileSync(path.join(OUT, `console-${t}.png`), Buffer.from(shot.result.data, 'base64'))
  }

  console.log('页面 JS 报错:', errors.length ? errors.slice(0, 6) : '（无）')

  // ---- Key 型渠道的添加弹窗（modelscope / opencode）--------------------------
  // 这两家不吃 account.create（回 unknown provider），必须走各自的 *.addAccount。
  // 断言只用**形状非法的 Key**：错误路径不落任何账号，跑多少遍都不污染账号池。
  const keyChecks = []
  for (const provider of ['modelscope', 'opencode']) {
    const r = await ev(`(async () => {
      document.querySelector('#nav button[data-tab="accounts"]').click()
      await new Promise(r => setTimeout(r, 300))
      const sel = document.querySelector('#accProvider')
      sel.value = ${JSON.stringify(provider)}
      sel.dispatchEvent(new Event('change'))
      await new Promise(r => setTimeout(r, 600))
      await startLogin(${JSON.stringify(provider)})
      const modal = document.querySelector('#keyModal')
      const opened = modal?.hidden === false
      const shown = {
        provider: document.querySelector('#kmProvider')?.textContent,
        hint: document.querySelector('#kmHint')?.textContent,
        where: document.querySelector('#kmWhere')?.getAttribute('href'),
      }
      // 形状非法的 Key：断言错误消息真的落进弹窗，而不是静默吞掉
      document.querySelector('#kmKey').value = 'not-a-valid-key'
      await submitKeyAccount(document.querySelector('#kmAdd'))
      await new Promise(r => setTimeout(r, 900))
      const msg = document.querySelector('#kmMsg')
      const out = { provider: ${JSON.stringify(provider)}, opened, shown, msgText: msg?.textContent, msgErr: msg?.className?.includes('err') === true, stillOpen: modal?.hidden === false }
      // 弹窗**先别关**：截图要拍到打开的样子。关闭放到截图之后。
      return out
    })()`)
    keyChecks.push(r)
    console.log(`[keyModal:${provider}]`, JSON.stringify(r))
    // ⚠️ 截图必须在关闭之前 —— 曾经把 closeKeyModal() 写在同一个 ev() 里，
    // 结果拍出来的是「弹窗已关」的空页面，两张 keymodal 图与 proxymodal 图字节相同。
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    fs.writeFileSync(path.join(OUT, `console-keymodal-${provider}.png`), Buffer.from(shot.result.data, 'base64'))
    await ev(`closeKeyModal()`)
    const okOpen = r?.opened === true && r?.shown?.provider === provider && !!r?.shown?.where
    const okErr = r?.msgErr === true && /形状不对/.test(r?.msgText ?? '')
    if (!okOpen) { console.log(`✗ keyModal ${provider}: 弹窗没打开或字段没填`); errors.push(`keyModal ${provider} 未就绪`) }
    if (!okErr) { console.log(`✗ keyModal ${provider}: 非法 Key 没显示本体错误消息`); errors.push(`keyModal ${provider} 错误未显示`) }
  }
  console.log('Key 弹窗断言:', keyChecks.every((r) => r?.opened) && keyChecks.every((r) => r?.msgErr) ? '通过' : '失败')

  // ---- 出口代理（四家各自的 *.setProxy / *.testProxy）--------------------------
  // ⚠️ 只用**必被拒的代理串**（ftp 不是支持的三类），错误路径不落任何池字段，
  // 跑多少遍都不污染账号池 —— 与上面 Key 弹窗只用非法 Key 是同一条纪律。
  // `opencode.addAnonymous` 会真的新建一条账号，所以这里只断言按钮的显隐，不点。
  const pxChecks = []
  for (const provider of ['opencode', 'gemini', 'qoder', 'minimaxintl', 'buddy']) {
    const r = await ev(`(async () => {
      document.querySelector('#nav button[data-tab="accounts"]').click()
      await new Promise(r => setTimeout(r, 300))
      const sel = document.querySelector('#accProvider')
      sel.value = ${JSON.stringify(provider)}
      sel.dispatchEvent(new Event('change'))
      await new Promise(r => setTimeout(r, 800))
      const wantProxy = !!PROXY_CHANNELS[${JSON.stringify(provider)}]
      const barBtnHidden = document.querySelector('#accProxy').hidden
      const anonHidden = document.querySelector('#accAnon').hidden
      const hasCol = [...document.querySelectorAll('#accTable thead th')].some(th => th.textContent === '出口代理')
      const rowProxyBtns = document.querySelectorAll('#accTable button[data-act="proxy"]').length
      const out = { provider: ${JSON.stringify(provider)}, wantProxy, barBtnHidden, anonHidden, hasCol, rowProxyBtns }
      if (!wantProxy) return out
      openProxyModal(${JSON.stringify(provider)})
      const modal = document.querySelector('#proxyModal')
      out.opened = modal?.hidden === false
      out.modalProvider = document.querySelector('#pxProvider')?.textContent
      out.hintLen = (document.querySelector('#pxHint')?.textContent ?? '').length
      out.accountIds = document.querySelectorAll('#pxAccount option').length
      // 当前代理必须从 account.list 的池字段回填（不需要新增读端点）
      out.prefilled = document.querySelector('#pxProxy').value
      out.hasAccount = document.querySelector('#pxAccount').value
      document.querySelector('#pxProxy').value = 'ftp://host:21'
      await proxyTest(document.querySelector('#pxTest'))
      await new Promise(r => setTimeout(r, 500))
      const msg = document.querySelector('#pxMsg')
      out.testMsg = msg?.textContent
      out.testErr = msg?.className?.includes('err') === true
      // 清除/保存：不真的点（会写池），只断言两个按钮都在
      out.btns = ['pxSave','pxClear','pxTest','pxClose'].filter(id => !!document.getElementById(id)).length
      // 同样先别关：截图要拍到弹窗与回填值
      return out
    })()`)
    pxChecks.push(r)
    console.log(`[proxy:${provider}]`, JSON.stringify(r))
    if (provider === 'opencode') {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
      fs.writeFileSync(path.join(OUT, 'console-proxymodal.png'), Buffer.from(shot.result.data, 'base64'))
    }
    await ev(`closeProxyModal()`)
    if (r?.wantProxy) {
      if (r?.barBtnHidden !== false) { console.log(`✗ proxy ${provider}: bar 按钮没显示`); errors.push(`proxy ${provider} 按钮未显示`) }
      if (r?.hasCol !== true) { console.log(`✗ proxy ${provider}: 账号表没有「出口代理」列`); errors.push(`proxy ${provider} 无代理列`) }
      if (r?.opened !== true || r?.modalProvider !== provider) { console.log(`✗ proxy ${provider}: 弹窗没打开或 provider 没填`); errors.push(`proxy ${provider} 弹窗未就绪`) }
      if (r?.testErr !== true || !/不支持/.test(r?.testMsg ?? '')) { console.log(`✗ proxy ${provider}: 非法代理没显示本体错误`); errors.push(`proxy ${provider} 错误未显示`) }
      if (!r?.hintLen) { console.log(`✗ proxy ${provider}: 没有提示文案`); errors.push(`proxy ${provider} 无提示`) }
    } else {
      if (r?.barBtnHidden !== true) { console.log(`✗ proxy ${provider}: 不该有代理按钮却显示了`); errors.push(`proxy ${provider} 多余按钮`) }
    }
    // 「加匿名通道」只有 opencode 有（opencode.addAnonymous），其他 provider 下必须隐藏
    if (provider === 'opencode' && r?.anonHidden !== false) { console.log('✗ opencode 下「加匿名通道」应可见'); errors.push('匿名通道按钮不可见') }
    else if (provider === 'buddy' && r?.anonHidden !== true) { console.log('✗ buddy 下「加匿名通道」应隐藏'); errors.push('匿名通道按钮没隐藏') }
  }
  // opencode 那条真的读过池字段了吗：有一个账号设了代理，回填必须非空
  const oc = pxChecks.find((r) => r?.provider === 'opencode')
  if (oc && oc.hasAccount && !oc.prefilled) {
    console.log(`⚠ opencode 账号 ${oc.hasAccount} 的代理回填为空（该账号可能本来就没配代理，不算失败）`)
  } else if (oc?.prefilled) {
    console.log(`代理回填: opencode 账号 ${oc.hasAccount} → ${oc.prefilled}`)
  }
  console.log('代理断言:', pxChecks.filter((r) => r?.wantProxy).every((r) => r?.opened && r?.testErr) ? '通过' : '失败')

  ws.close()
  proc.kill()
  try { fs.rmSync(prof, { recursive: true, force: true }) } catch {}
  process.exit(errors.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
