// UI 自检：CDP 打开 magpie 窗口 → 点侧栏 Jet Hub 页 → 连进页面 iframe（OOPIF）逐标签截图 + DOM 断言。
//
//   node tests/ui-check.cjs [key] [outDir]
//
// 页面是 sandbox="allow-scripts"（无 allow-same-origin）⇒ opaque origin ⇒ 独立进程。
// 所以不能从主文档读它的 DOM，也不在主 target 的 execution context 里。
// 正确做法：/json/list 里那个 type=iframe 的目标有自己的 ws 地址，直连它。

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9379
const KEY = process.argv[2] || '41e0772d0d4af2b38f0f13750dde7775'
const OUT_DIR = process.argv[3] || path.join(process.env.TEMP || '/tmp', 'jethub-ui')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json()

function makeClient(wsUrl, problems) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const send = (m, p = {}) => new Promise((res, rej) => {
    const mid = ++id
    pending.set(mid, { res, rej })
    ws.send(JSON.stringify({ id: mid, method: m, params: p }))
  })
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const q = pending.get(m.id); pending.delete(m.id)
      m.error ? q.rej(new Error(JSON.stringify(m.error))) : q.res(m.result)
      return
    }
    if (problems) {
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails
        problems.push('[exception] ' + (d?.exception?.description || d?.text || ''))
      }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        problems.push('[log] ' + m.params.entry.text)
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        problems.push('[console] ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
      }
    }
  })
  const ready = new Promise((r) => ws.addEventListener('open', r, { once: true }))
  return { ws, send, ready }
}

;(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1280,1100',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(process.env.TEMP || '/tmp', 'cdp-ui-' + Date.now())}`,
    'about:blank',
  ], { stdio: 'ignore' })

  let targets = null
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    try { targets = await getJson('/json/list'); if (targets && targets.length) break } catch (e) {}
  }
  if (!targets || !targets.length) { console.error('CDP 没起来'); child.kill(); process.exit(1) }

  const problems = []
  const mainT = targets.find((t) => t.type === 'page' && !t.url.startsWith('edge://')) || targets[0]
  const main = makeClient(mainT.webSocketDebuggerUrl, problems)
  await main.ready
  await main.send('Page.enable'); await main.send('Runtime.enable'); await main.send('Log.enable'); await main.send('Network.enable')
  await main.send('Network.setCookie', {
    name: 'magpie_web_3456', value: KEY, domain: '127.0.0.1', path: '/',
    httpOnly: true, sameSite: 'Lax',
  })
  await main.send('Page.navigate', { url: 'http://127.0.0.1:3456/' })
  await sleep(8000)

  const clicked = await main.send('Runtime.evaluate', {
    expression: `(()=>{const b=[...document.querySelectorAll('#nav button')].find(x=>(x.textContent||'').includes('Jet Hub'));if(!b)return 'no button';b.click();return 'clicked '+(b.textContent||'').trim()})()`,
    returnByValue: true,
  })
  console.log('侧栏:', clicked.result?.value)
  await sleep(8000)

  const list = await getJson('/json/list')
  const frameT = list.find((t) => t.type === 'iframe' && String(t.url).includes('_magpie/plugin'))
  if (!frameT) { console.error('没找到页面 iframe 目标'); child.kill(); process.exit(1) }
  console.log('页面 iframe:', frameT.url)

  const fr = makeClient(frameT.webSocketDebuggerUrl, problems)
  await fr.ready
  await fr.send('Runtime.enable'); await fr.send('Log.enable'); await fr.send('Page.enable')
  await sleep(1500)

  const evalIn = async (expr) => {
    const r = await fr.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails?.exception?.description || r.exceptionDetails?.text)
    return r.result?.value
  }

  const shot = async (name) => {
    const r = await main.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    const p = path.join(OUT_DIR, `tab-${name}.png`)
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'))
    console.log('  截图', path.basename(p), fs.statSync(p).size, 'bytes')
  }

  const tabs = ['start', 'models', 'usage', 'providers', 'settings']
  const report = []
  for (const name of tabs) {
    const r = await evalIn(`(()=>{const b=[...document.querySelectorAll('#tabs button')].find(x=>x.dataset.tab==='${name}');if(!b)return 'no tab ${name}';b.click();return 'ok'})()`)
    if (r !== 'ok') throw new Error(r)
    await sleep(name === 'usage' ? 2500 : 900)
    await shot(name)
    const probe = await evalIn(`(()=>{
      const p=document.querySelector('.panel:not([hidden])');
      return JSON.stringify({
        tab:'${name}',
        panelTitle: p?(p.querySelector('h2')?.textContent||''):'NO PANEL',
        state:document.querySelector('#state')?.textContent,
        count:document.querySelector('#count')?.textContent,
        groups:document.querySelectorAll('#groups details').length,
        chips:document.querySelectorAll('.mid').length,
        tiles:[...document.querySelectorAll('.tile')].map(t=>(t.querySelector('.k')?.textContent||'')+'='+(t.querySelector('.v')?.textContent||'')),
        rows:document.querySelectorAll('#ubody tr').length,
        provs:document.querySelectorAll('.prov').length,
        snippetLen:(document.querySelector('#snippet')?.textContent||'').length,
        bodyH:Math.round(document.body.getBoundingClientRect().height),
      })
    })()`)
    console.log('  ' + probe)
    report.push(JSON.parse(probe))
  }

  console.log(problems.length ? '--- 页面问题 ---' : '页面无 JS 报错')
  for (const p of [...new Set(problems)]) console.log('  ' + p)

  const bad = report.filter((r) => r.panelTitle === 'NO PANEL' || !r.state)
  if (bad.length) console.log('⚠ 有标签未正常渲染:', bad.map((b) => b.tab).join(','))
  else console.log('✓ 五个标签均渲染正常')

  fr.ws.close(); main.ws.close(); child.kill()
  await sleep(300)
  process.exit(problems.length || bad.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
