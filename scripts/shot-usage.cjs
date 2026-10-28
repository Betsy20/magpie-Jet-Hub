// 截 magpie「用量 → 概览」里 Jet Hub 账号积分卡片。
//
//   MAGPIE_WEB_KEY=<key> node scripts/shot-usage.cjs [out] [卡片标题]
//
// ⚠️ key 不写默认值（2026-10-28 实测过一次凭据进公开仓库，见 VERIFICATION.md 第十九节）。
//
// 实测踩到的四个坑（都写进 README 了）：
//   1. 滚动容器是 `MAIN.view`，不是 window/body —— `scrollIntoView` / `window.scrollBy` 全不动。
//   2. 卡片是**懒渲染**的：不在视口内时 `getBoundingClientRect()` 全返回 0，
//      所以必须先滚到位、等一拍，再取 rect。
//   3. Node 24 自带 global WebSocket，`require('ws')` 会 MODULE_NOT_FOUND。
//   4. 页面里 60+ 张卡，前几张是内置插件的；必须按标题文本精确定位。
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p))
const KEY = process.env.MAGPIE_WEB_KEY
if (!KEY) {
  console.error('缺少 magpie web 登录 key：设 MAGPIE_WEB_KEY=<key> 再跑。')
  process.exit(2)
}
const PORT = 9337
const OUT = process.argv[2] || path.join(process.env.TEMP || '/tmp', 'jethub-usage.png')
const TARGET = process.argv[3] || 'Jet Hub · WorkBuddy'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = (u) =>
  new Promise((res, rej) => {
    http.get(u, (r) => { let s = ''; r.on('data', (d) => (s += d)); r.on('end', () => { try { res(JSON.parse(s)) } catch (e) { rej(e) } }) }).on('error', rej)
  })

;(async () => {
  const proc = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
    '--window-size=1500,5200',
    '--user-data-dir=' + path.join(process.env.TEMP, 'jethub-shot-profile'),
    'about:blank',
  ], { stdio: 'ignore' })
  try {
    let tabs
    for (let i = 0; i < 40; i++) { try { tabs = await getJson(`http://127.0.0.1:${PORT}/json/list`); if (tabs.length) break } catch {} await sleep(300) }
    const sock = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl)
    await new Promise((r) => sock.addEventListener('open', r))
    let id = 0
    const pend = new Map()
    sock.addEventListener('message', (e) => { const j = JSON.parse(e.data); if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id) } })
    const send = (m, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); sock.send(JSON.stringify({ id: i, method: m, params: p })) })
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
      return r.result?.result?.value
    }

    await send('Network.enable')
    await send('Page.enable')
    await send('Network.setCookie', { name: 'magpie_web_3456', value: KEY, domain: '127.0.0.1', path: '/' })
    await send('Page.navigate', { url: 'http://127.0.0.1:3456/' })
    await sleep(5000)

    console.log('用量导航:', await ev(`(()=>{const b=[...document.querySelectorAll('button,a,[role=button]')].filter(x=>/用量/.test(x.textContent||''));if(!b.length)return 'no nav';b[0].click();return 'ok'})()`))
    await sleep(2500)
    console.log('概览:', await ev(`(()=>{const b=[...document.querySelectorAll('button,a,[role=button]')].filter(x=>/^概览$/.test((x.textContent||'').trim()));if(!b.length)return 'no overview';b[0].click();return 'ok'})()`))
    await sleep(10000)

    // 逐档滚动 + 每次扫一遍可见标题。
    // 为什么不用 scrollIntoView：卡片是**懒渲染**的，不在视口内时元素 rect 全 0，
    // 拿不到目标位置；只能反过来「滚到某处 → 看这里有什么」。
    let rect = null
    const maxTop = await ev(`(()=>{const m=[...document.querySelectorAll('main')].find(x=>x.scrollHeight>x.clientHeight+100);return m?Math.round(m.scrollHeight-m.clientHeight):0})()`)
    console.log('可滚动高度:', maxTop)
    for (let top = 0; top <= maxTop && !rect; top += 700) {
      const r = await ev(`(()=>{
        const target=${JSON.stringify(TARGET)};
        const main=[...document.querySelectorAll('main')].find(x=>x.scrollHeight>x.clientHeight+100);
        if(!main) return {err:'no scroller'};
        main.scrollTop = ${'${top}'};
        return {moved:Math.round(main.scrollTop)};
      })()`.replace('${top}', String(top)))
      await sleep(1400)
      const hit = await ev(`(()=>{
        const target=${JSON.stringify(TARGET)};
        const all=[...document.querySelectorAll('*')].filter(x=>{
          const t=(x.innerText||'').trim();
          if(t!==target) return false;
          const b=x.getBoundingClientRect();
          return b.width>0 && b.height>0 && b.top>=0 && b.top<innerHeight;
        });
        if(!all.length) return null;
        let el=all[0], box=null;
        for(let i=0;i<10&&el;i++){
          const b=el.getBoundingClientRect();
          if(b.width>=240&&b.width<=700&&b.height>=150){box=b;break}
          el=el.parentElement;
        }
        const use=box||all[0].getBoundingClientRect();
        return {x:Math.round(use.x),y:Math.round(use.y),w:Math.round(use.width),h:Math.round(use.height)};
      })()`)
      if (hit) {
        console.log('  命中于 scrollTop=' + top + '，卡片 y=' + hit.y + ' 视口高=' + (await ev('innerHeight')))
        // 把卡片顶推到视口顶部：直接改 main.scrollTop（卡片是懒渲染的，只有滚到位才渲染）
        await ev(`(()=>{
          const m=[...document.querySelectorAll('main')].find(x=>x.scrollHeight>x.clientHeight+100);
          if(!m) return 0;
          m.scrollTop = m.scrollTop + ${'${hit.y}'} - 40;
          return Math.round(m.scrollTop);
        })()`.replace('${hit.y}', String(hit.y)))
        await sleep(2500)
        const again = await ev(`(()=>{
          const target=${JSON.stringify(TARGET)};
          const all=[...document.querySelectorAll('*')].filter(x=>{
            const t=(x.innerText||'').trim();
            if(t!==target) return false;
            const b=x.getBoundingClientRect();
            return b.width>0&&b.height>0&&b.top>=0&&b.top<innerHeight;
          });
          if(!all.length) return null;
          let el=all[0],box=null;
          for(let i=0;i<10&&el;i++){
            const b=el.getBoundingClientRect();
            if(b.width>=240&&b.width<=700&&b.height>=150){box=b;break}
            el=el.parentElement;
          }
          const use=box||all[0].getBoundingClientRect();
          return {x:Math.round(use.x),y:Math.round(use.y),w:Math.round(use.width),h:Math.round(use.height),top:Math.round(use.top)};
        })()`)
        if (again) { rect = again; console.log('  重取:', JSON.stringify(again)) }
        else rect = hit
      }
    }
    console.log('卡片位置:', JSON.stringify(rect))

    if (rect && rect.w > 100) {
      const shot = await send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 2 },
      })
      fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'))
    } else {
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'))
      console.log('⚠️ 没定位到卡片，截了整屏')
    }
    console.log('截图', OUT, fs.statSync(OUT).size, 'bytes')
    sock.close()
  } finally {
    proc.kill()
  }
  process.exit(0)
})()
