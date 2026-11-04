// 控制台服务的跨站防线 —— 2026-11-03 那次 CORS 漏洞的回归闸。
//
// 背景：早先每个响应都带 `Access-Control-Allow-Origin: *`，而 `/api/jet-hub`
// 会把各渠道的 access_key_id / access_key_secret / refresh_token 一起吐出来 ——
// 等于**任意网页**都能跨域读完全部凭据；它同时接 POST，于是又是一个 CSRF 入口。
// 当时的理由是「magpie 用 sandbox iframe 嵌控制台，opaque origin 必须通配」，
// 但 `page/index.html` 早已改成只显示地址、由用户顶层打开，那条理由早就失效了。
//
// 这里不测「有没有那条头」，测的是**四类攻击面各自被挡**：
//   ① 跨站 Origin 拿不到响应体（403，且响应里不带 ACAO —— 带了就等于告诉浏览器「可以读」）
//   ② `Origin: null`（sandbox iframe / file:// / data:）同样挡
//   ③ Host 不是回环 → 403（挡 DNS rebinding：攻击者域名解析到 127.0.0.1 之后，
//      Origin 白名单对它就是透明的，只有 Host 还能露馅）
//   ④ `Sec-Fetch-Site: cross-site` 的**无 Origin** 请求也挡 —— `<form>` 提交、
//      `fetch(mode:'no-cors')` 这类读不到响应但会执行副作用的请求，CORS 头对它们
//      完全不起作用，只能服务端拒
// 再反向断言「同源没被误伤」：控制台自己就靠这条活着，挡过头等于功能全废。
//
// 端口必须换着起：白名单只认**本次真正绑定的那一个端口**，写死 18500 的话
// 这里就变成「测自己」，什么也证明不了。反向也要测：同主机的**其它**端口一律拒。

import { createServer, request } from 'node:http'
import { startHubServer } from '../src/hub-server.mjs'

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}${extra ? `（${extra}）` : ''}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${extra ? `（${extra}）` : ''}`)
  }
}

console.log('控制台跨站防线')

// 业务 handler 的调用计数：被拦下的请求**一个都不该**走到这里 ——
// 只看状态码会漏掉「先执行了副作用、再回 403」这种更糟的实现。
let hits = 0
const seam = {
  routes: new Map([
    [
      '/api/jet-hub',
      {
        fetch: async () => {
          hits++
          return new Response(
            JSON.stringify({ providers: [{ id: 'officeace', access_key_secret: 'SECRET-VALUE' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        },
      },
    ],
  ]),
}

const BASE = 19000 + (process.pid % 200)
const srv = await startHubServer({ seam, meta: () => ({ providers: ['a'] }), from: BASE, tries: 40 })
const SELF = `http://127.0.0.1:${srv.port}`

/** 直接对回环发请求；`host` 也能被覆盖（模拟 DNS rebinding）。 */
function req(path, { method = 'GET', headers = {}, port = srv.port } = {}) {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          acao: res.headers['access-control-allow-origin'],
          vary: res.headers.vary,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      )
    })
    r.on('error', reject)
    r.end()
  })
}

try {
  // ── ① 同源基线：不许被误伤 ─────────────────────────────────────────
  {
    // 不吞错：连不上就是测试环境坏了，让它直接炸出来，
    // 否则 `.catch(()=>null)` 会让下面两条断言在「连不上」时恒真。
    const r = await req('/api/jet-hub')
    ok(r.status === 200, '同源 GET（不带 Origin）200', `实际 ${r.status}`)
    ok(r.acao === undefined, '同源 GET 不需要 ACAO 头', String(r.acao))
  }
  {
    // 控制台页面自己发的就是这条：同源 + 显式 Origin（POST 会带）
    const r = await req('/api/jet-hub', { headers: { origin: SELF } })
    ok(r.status === 200, '控制台自己 Origin 200', `实际 ${r.status}`)
    ok(r.acao === SELF, 'ACAO 回显具体来源（不是 *）', String(r.acao))
    ok(String(r.vary ?? '').toLowerCase().includes('origin'), '带 Vary: Origin（缓存不串源）', String(r.vary))
  }
  {
    const r = await req('/api/jet-hub', { method: 'POST', headers: { origin: SELF, 'content-type': 'application/json' } })
    ok(r.status === 200, '同源 POST 200（写操作没被误伤）', `实际 ${r.status}`)
    ok(r.acao === SELF, '同源 POST 的 ACAO 也回显具体来源', String(r.acao))
  }
  {
    const r = await req('/api/jet-hub', { headers: { origin: SELF, 'sec-fetch-site': 'same-origin' } })
    ok(r.status === 200, '同源 + Sec-Fetch-Site: same-origin 200', `实际 ${r.status}`)
  }
  {
    // 静态站与 /__meta 也要正向断言：只测「坏的不通」的话，
    // 哪天静态分支被改坏（一律 403）测试照样是绿的。
    const r = await req('/', { headers: { origin: SELF } })
    ok(r.status === 200, '同源 GET / 200（静态站没被误伤）', `实际 ${r.status}`)
    const m = await req('/__meta', { headers: { origin: SELF } })
    ok(m.status === 200, '同源 /__meta 200', `实际 ${m.status}`)
  }
  {
    // 预检：带自己 Origin 回 204 + 回显自己（浏览器据此放行真正的 POST）
    const r = await req('/api/jet-hub', { method: 'OPTIONS', headers: { origin: SELF } })
    ok(r.status === 204, '同源 OPTIONS 预检 204', `实际 ${r.status}`)
    ok(r.acao === SELF, '预检回显控制台自己 Origin', String(r.acao))
  }
  {
    // `localhost.` 是合法的 FQDN 尾随点写法（解析时表示不再追加搜索域），别误伤
    const r = await req('/api/jet-hub', { headers: { origin: `http://localhost.:${srv.port}` } })
    ok(r.status === 200, 'Origin 写 localhost.（FQDN 尾随点）200', `实际 ${r.status}`)
  }
  {
    // same-site 但**读**：放行。导航请求的 Sec-Fetch-Site 可能是 same-site，
    // 收紧了就等于「从别处点链接打开控制台」被挡。
    const r = await req('/api/jet-hub', { headers: { 'sec-fetch-site': 'same-site' } })
    ok(r.status === 200, 'same-site 的读请求 200（导航不误伤）', `实际 ${r.status}`)
  }
  {
    // 地址栏直接输入 / 收藏夹 / 从剪贴板粘贴：`Sec-Fetch-Site: none`，属于导航，必须放行。
    // 这是用户的真实路径 —— 跨站链接会被挡（见下方 ⑤ 组），只能复制到地址栏打开。
    const r = await req('/', { headers: { 'sec-fetch-site': 'none' } })
    ok(r.status === 200, '地址栏直接打开首页（SFS: none）200', `实际 ${r.status}`)
  }

  {
    // `localhost.` 是合法的 FQDN 尾随点写法，Host 侧也要容忍（不只 Origin 侧）
    const r = await req('/api/jet-hub', { headers: { host: `localhost.:${srv.port}` } })
    ok(r.status === 200, 'Host 写 localhost.（尾随点）200', `实际 ${r.status}`)
  }

  // 该放行的都发完了，记下业务 handler 被命中几次。
  // 下面整段是跨站组：一个都不该再进 handler。
  // 上面打到 handler 的正向用例一共 7 条（同源 GET / 带 Origin 的 GET / 同源 POST /
  // same-origin GET / `localhost.` 的 Origin / `Host: localhost.` / same-site 读）。
  // 用 `>=` 是因为以后再加正向用例只会让这个数变大，但**低于它**就说明有正向用例被误挡了。
  const ALLOWED_THROUGH = 7
  const allowedHits = hits
  ok(allowedHits >= ALLOWED_THROUGH, '该放行的请求确实进了业务 handler', `实际 ${allowedHits} 次，至少应 ${ALLOWED_THROUGH}`)

  // ── ② 跨站读：403 且拿不到响应体 ─────────────────────────────────
  {
    const r = await req('/api/jet-hub', { headers: { origin: 'http://evil.example' } })
    ok(r.status === 403, '跨站 Origin 403', `实际 ${r.status}`)
    ok(r.acao === undefined, '跨站响应不带 ACAO（带了浏览器就能读）', String(r.acao))
    ok(!r.body.includes('SECRET-VALUE'), '跨站响应体里没有凭据')
  }
  {
    const r = await req('/api/jet-hub', { headers: { origin: 'null' } })
    ok(r.status === 403, 'Origin: null（sandbox iframe）403', `实际 ${r.status}`)
    ok(r.acao === undefined, 'Origin: null 的响应不带 ACAO', String(r.acao))
  }
  {
    // 同一台机器、不同端口：端口是白名单的一部分，不能只认主机名。
    // 这条同时钉住「白名单不能是探测区间」——容器调 startHubServer({from:18500})
    // 不传 tries 时，按区间放行会把 18500–18559 全放进来。
    const r = await req('/api/jet-hub', { headers: { origin: 'http://127.0.0.1:9999' } })
    ok(r.status === 403, '同主机不同端口（:9999）403', `实际 ${r.status}`)
  }
  {
    const r = await req('/api/jet-hub', { headers: { origin: `http://127.0.0.1:${srv.port + 5}` } })
    ok(r.status === 403, '相邻端口（本机另一服务）403', `实际 ${r.status}`)
  }
  {
    // 本服务不跑 TLS，https 来源不可能是控制台自己
    const r = await req('/api/jet-hub', { headers: { origin: `https://127.0.0.1:${srv.port}` } })
    ok(r.status === 403, 'https 来源 403（本服务没有 TLS）', `实际 ${r.status}`)
  }

  // ── ③ DNS rebinding：Host 不是回环就拒 ────────────────────────────
  {
    const r = await req('/api/jet-hub', { headers: { host: 'evil.example' } })
    ok(r.status === 403, '伪造 Host（DNS rebinding）403', `实际 ${r.status}`)
    ok(r.acao === undefined, 'rebinding 响应不带 ACAO', String(r.acao))
  }

  // ── ④ 读不到响应但有副作用的请求：靠 Sec-Fetch-Site 挡 ────────────
  {
    const r = await req('/api/jet-hub', { method: 'POST', headers: { origin: 'http://evil.example' } })
    ok(r.status === 403, '跨站 POST 403（CSRF）', `实际 ${r.status}`)
  }
  {
    const r = await req('/api/jet-hub', { method: 'OPTIONS', headers: { origin: 'http://evil.example' } })
    ok(r.status === 403, '跨站 OPTIONS 预检 403（预检也不放行）', `实际 ${r.status}`)
  }
  {
    // `<form>` 提交 / fetch(mode:'no-cors')：浏览器不发 Origin，但会带 Sec-Fetch-Site
    const r = await req('/api/jet-hub', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })
    ok(r.status === 403, '无 Origin 但 Sec-Fetch-Site: cross-site 的 POST 403', `实际 ${r.status}`)
  }
  {
    // same-site 的**写**也要拒：Sec-Fetch-Site 的 site 不含端口，
    // 本机 127.0.0.1:3000 的页面与 127.0.0.1:18500 是 same-site，
    // 它能用 `<form enctype="text/plain">` 拼出 JSON body 打过来。
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await req('/api/jet-hub', { method, headers: { 'sec-fetch-site': 'same-site' } })
      ok(r.status === 403, `same-site 的 ${method} 403（本机别的端口页面打不进来）`, `实际 ${r.status}`)
    }
  }

  {
    // 同一个头来多行时 Node 会拼成 `"a, b"`。只做 `=== 'cross-site'` 严格比较的话，
    // `Sec-Fetch-Site: same-site` + `Sec-Fetch-Site: cross-site` 会拼成
    // `"same-site, cross-site"`，两个分支都不命中 ⇒ 直接放行（实测过，这是真绕过）。
    for (const [name, value] of [
      ['重复头 same-site + cross-site', ['same-site', 'cross-site']],
      ['单头多值 "same-site, cross-site"', 'same-site, cross-site'],
      ['单头多值 "cross-site, same-site"', 'cross-site, same-site'],
    ]) {
      const r = await req('/api/jet-hub', { method: 'POST', headers: { 'sec-fetch-site': value } })
      ok(r.status === 403, `${name} 403（多值拼起来也不能绕过）`, `实际 ${r.status}`)
    }
  }
  // ── ⑤ 静态站也别被跨站白嫖 ────────────────────────────────────────
  {
    const r = await req('/', { headers: { origin: 'http://evil.example' } })
    ok(r.status === 403, '静态首页跨站 403', `实际 ${r.status}`)
  }
  {
    // 跨站**顶层导航**（从聊天软件、文档里点链接）也挡 —— 这是刻意的：
    // 挡掉的只是「点一下就能在无感知下打开控制台」这条路，用户复制到地址栏即可。
    const r = await req('/', { headers: { 'sec-fetch-site': 'cross-site' } })
    ok(r.status === 403, '跨站顶层导航 403（改用地址栏打开）', `实际 ${r.status}`)
  }

  // ── ⑥ 最关键的一条：被拦的请求没有一个是「先干活再拒」 ────────────
  // 用相对增量而不是写死数字：跨站组前后命中数必须**一模一样**。
  // 写死数字在加用例时会莫名其妙变红，且报错只说「期望 4 实际 7」看不出哪里错。
  ok(
    hits === allowedHits,
    '跨站请求一个都没进业务 handler（没有「先干活再拒」）',
    `跨站组前 ${allowedHits} 次 → 之后 ${hits} 次`,
  )
  // ── ⑦ 起始端口被占（线上 18500 被占是常态）：白名单必须跟着**实际**绑定端口走 ──
  // 专抓 onListening 里「把真实端口写进 boundPort」那行被删掉：删了之后白名单会停在
  // from，于是「别人占着的那个端口」上的页面能读走凭据（fail-open），而控制台自己
  // 反而进不去。测试里的 BASE 永远空闲，不造「被占」这个场景就永远抓不到。
  {
    // 用内核分配端口当「被占住的起始端口」，不让这个用例自带一个可能被外部进程
    // 占住的固定端口（那样 blocker.listen 会抛未捕获的 error 事件，变成假红）。
    const blocker = createServer((_, r) => r.end('x'))
    await new Promise((done) => blocker.listen(0, '127.0.0.1', done))
    const FROM = blocker.address().port
    // FROM+1 若也被人占着，就只能退化成「跳到 FROM 之后某个端口」——但先探一下，
    // 探得通就必须钉死 FROM+1：只断言「端口不等于 FROM」是恒真的（OS 不可能让两个
    // server 绑同一端口），那样把探测步长从 +1 改成 +2 都不会红，等于没测。
    const nextFree = await new Promise((done) => {
      const probe = createServer((_, r) => r.end('x'))
      probe.once('error', () => done(false))
      probe.listen(FROM + 1, '127.0.0.1', () => probe.close(() => done(true)))
    })
    const srv2 = await startHubServer({ seam, meta: () => ({ providers: ['a'] }), from: FROM, tries: 5 })
    try {
      if (nextFree) {
        ok(srv2.port === FROM + 1, '起始端口被占时跳到下一个（FROM+1）', `实际 ${srv2.port}`)
      } else {
        ok(
          srv2.port > FROM && srv2.port <= FROM + 4,
          '起始端口被占时跳到后面某个可用端口（FROM+1 本身被占，退化断言）',
          `实际 ${srv2.port}`,
        )
      }
      const self = await req('/api/jet-hub', {
        port: srv2.port,
        headers: { origin: `http://127.0.0.1:${srv2.port}` },
      })
      ok(self.status === 200, '跳端口后自身 Origin 仍被认', `HTTP ${self.status}`)
      ok(self.acao === `http://127.0.0.1:${srv2.port}`, 'ACAO 回显的是实际端口', String(self.acao))
      const other = await req('/api/jet-hub', {
        port: srv2.port,
        headers: { origin: `http://127.0.0.1:${FROM}` },
      })
      ok(other.status === 403, '被占端口的页面读不到凭据（白名单不能停在 from）', `HTTP ${other.status}`)
    } finally {
      await srv2.close()
      await new Promise((done) => blocker.close(done))
    }
  }

  // ── ⑧ from: 0（让内核分配端口）：返回的端口必须是真实那个 ─────────────
  {
    const srv3 = await startHubServer({ seam, meta: () => ({}), from: 0, tries: 1 })
    try {
      ok(srv3.port > 0, 'from: 0 时返回内核分配的真实端口', `实际 ${srv3.port}`)
      ok(!srv3.url.includes(':0/'), 'url 里不是 :0', srv3.url)
      const r = await req('/api/jet-hub', {
        port: srv3.port,
        headers: { origin: `http://127.0.0.1:${srv3.port}` },
      })
      ok(r.status === 200, 'from: 0 时自身 Origin 被认', `HTTP ${r.status}`)
    } finally {
      await srv3.close()
    }
  }
} finally {
  await srv.close()
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}（${pass + fail} 项：控制台跨站防线 —— 跨站读写 / null / DNS rebinding / 无 Origin 副作用）`)
process.exit(fail === 0 ? 0 : 1)
