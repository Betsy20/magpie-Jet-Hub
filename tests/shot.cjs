// 用 CDP 驱动 Edge：注入 magpie web 登录 cookie → 打开 UI → 点侧栏 Jet Hub 页 → 截图
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9344
const KEY = process.argv[2] || '41e0772d0d4af2b38f0f13750dde7775'
const VIEW = process.argv[3] || 'plugin-magpie-jet-hub'
const OUT = process.argv[4] || path.join(process.env.TEMP || '/tmp', 'dshhub.png')
const UA_DIR = path.join(process.env.TEMP || '/tmp', 'cdp-dshhub-' + Date.now())

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(p) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`)
  return r.json()
}

;(async () => {
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1400,1000',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${UA_DIR}`,
    'about:blank',
  ], { stdio: 'ignore' })

  let targets = null
  for (let i = 0; i < 60; i++) {
    await sleep(250)
    try { targets = await getJson('/json/list'); if (targets?.length) break } catch {}
  }
  if (!targets?.length) { console.error('CDP 没起来'); child.kill(); process.exit(1) }
  const page = targets.find((t) => t.type === 'page') || targets[0]

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id
    pending.set(mid, { resolve, reject })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
  const logs = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
      return
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push('[console] ' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '))
    }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push('[exception] ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text))
    }
  })
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))

  await send('Page.enable')
  await send('Network.enable')
  await send('Runtime.enable')
  await send('Network.setCookie', {
    name: 'magpie_web_3456', value: KEY, domain: '127.0.0.1', path: '/',
    httpOnly: true, sameSite: 'Lax',
  })

  await send('Page.navigate', { url: `http://127.0.0.1:3456/?view=${encodeURIComponent(VIEW)}` })
  await sleep(10000)

  // 打印侧栏 nav 按钮
  const nav = await send('Runtime.evaluate', {
    expression: `JSON.stringify([...document.querySelectorAll('#nav button')].map(b=>({t:(b.textContent||'').trim(),d:b.dataset.pluginPage||'',a:b.getAttribute('aria-selected')})))`,
    returnByValue: true,
  })
  console.log('侧栏按钮:', nav.result?.value)

  // 如果页面没自动切过去，点一下
  const click = await send('Runtime.evaluate', {
    expression: `(()=>{const b=[...document.querySelectorAll('#nav button')].find(x=>x.dataset.pluginPage==='${VIEW}'||(x.textContent||'').includes('Jet Hub'));if(!b)return 'no button';b.click();return 'clicked '+((b.textContent||'').trim())})()`,
    returnByValue: true,
  })
  console.log('点击:', click.result?.value)
  await sleep(6000)

  // 检查 iframe 内容
  const probe = await send('Runtime.evaluate', {
    expression: `(()=>{const f=document.querySelector('iframe');if(!f)return 'no iframe';const d=f.contentDocument;if(!d)return 'no doc';return JSON.stringify({state:d.getElementById('state')?.textContent,title:d.querySelector('.head h1')?.textContent,models:[...(d.getElementById('models')?.children||[])].slice(0,6).map(li=>li.textContent.trim()),ver:d.getElementById('ver')?.textContent})})()`,
    returnByValue: true,
  })
  console.log('iframe 内容:', probe.result?.value)

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
  console.log('截图:', OUT, fs.statSync(OUT).size, 'bytes')
  if (logs.length) console.log('--- 页面日志 ---\n' + logs.slice(-25).join('\n'))

  ws.close()
  child.kill()
  await sleep(300)
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
