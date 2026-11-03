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
// 端口必须换着起：区间是跟着 `startHubServer({from, tries})` 算的，
// 写死 18500–18559 的话这里就变成「测自己」，什么也证明不了。

import { request } from 'node:http'
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
function req(path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port: srv.port, path, method, headers }, (res) => {
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
    const r = await req('/api/jet-hub')
      .catch(() => null)
    ok(r?.status === 200, '同源 GET（不带 Origin）200', `实际 ${r?.status}`)
    ok(r?.acao === undefined, '同源 GET 不需要 ACAO 头', String(r?.acao))
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
    // 同一台机器、不同端口：端口是白名单的一部分，不能只认主机名
    const r = await req('/api/jet-hub', { headers: { origin: 'http://127.0.0.1:9999' } })
    ok(r.status === 403, '同主机不同端口（:9999）403', `实际 ${r.status}`)
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

  // ── ⑤ 静态站也别被跨站白嫖 ────────────────────────────────────────
  {
    const r = await req('/', { headers: { origin: 'http://evil.example' } })
    ok(r.status === 403, '静态首页跨站 403', `实际 ${r.status}`)
  }

  // ── ⑥ 最关键的一条：被拦的请求没有一个是「先干活再拒」 ────────────
  // 放行的只有上面四处同源请求（同源 GET、带 Origin 的 GET、同源 POST、same-origin GET）。
  ok(hits === 4, '业务 handler 只被同源请求命中 4 次', `实际 ${hits}`)
} finally {
  await srv.close()
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}（${pass + fail} 项：控制台跨站防线 —— 跨站读写 / null / DNS rebinding / 无 Origin 副作用）`)
process.exit(fail === 0 ? 0 : 1)
