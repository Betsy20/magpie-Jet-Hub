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
 * 留下的，宿主被强杀后会留一个死端口（实测文件写 18502，活着的是 18500/18501）。
 * 所以读完必须连 `/__meta` 验证，连不上就按 18500..18509 逐个探。
 * 与 scripts/snapshot-models.mjs 的 readConsoleUrl 同一套判断。
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
  try {
    const p = path.join(process.env.USERPROFILE, '.config/magpie/jet-hub-console.json')
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (typeof j?.url === 'string' && j.url) cands.push(j.url)
  } catch {
    /* 文件不在或坏了就只探默认端口 */
  }
  for (let port = 18500; port < 18510; port += 1) cands.push(`http://127.0.0.1:${port}/`)
  for (const url of cands) if (await probe(url)) return url
  return 'http://127.0.0.1:18500/'
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
  ws.close()
  proc.kill()
  try { fs.rmSync(prof, { recursive: true, force: true }) } catch {}
  process.exit(errors.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
