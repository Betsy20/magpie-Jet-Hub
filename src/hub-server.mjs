// 本地控制台服务：把本体的 Jet Hub 管理 API（/api/jet-hub）暴露给浏览器，
// 同时把 console/ 下的管理界面当静态站点发出去。
//
// 为什么要单独起一个 HTTP 服务，而不是把界面塞进 magpie 的插件页：
//   magpie 给插件页的 CSP 是 `connect-src 'none'` + `frame-src 'none'`，
//   页面里 fetch 一个字节都发不出去、也嵌不进框架（见 internal/gui/assets/pluginpages.js）。
//   所以 magpie 侧栏页只**显示地址**，用户在浏览器里顶层打开本服务提供的管理界面 ——
//   它自己的响应头里没有那条 CSP，fetch 同源即可。
//
// 三个必须踩准的点（都真跑过）：
//  1. **只回显控制台自己那一个 Origin，绝不回 `*`**（2026-11-03 修，11-04 收紧）。
//     早先这里是 `Access-Control-Allow-Origin: *`，理由是「magpie 用 sandbox iframe
//     嵌控制台，文档是 opaque origin，跨域必须通配」——但 `page/index.html` 早已
//     不再嵌 iframe，只把地址显示给用户去浏览器里**顶层打开**，那个理由已经不成立。
//     留着 `*` 的后果是：**任意网页**都能跨域读 `/api/jet-hub`，一键导出全部渠道
//     的凭据（PoC 实测 evil.example / null / attacker.test 三种源都拿到 200 + `*`）。
//     白名单 = 协议 `http`（本服务不跑 TLS，`https` 来源不可能是我们）+ 回环主机
//     （`127.0.0.1` / `localhost` / `[::1]`，允许 FQDN 尾随点）+ **本次真正绑定的端口**。
//     不按探测区间放行：容器调 `startHubServer({ from: 18500 })` 不传 tries ⇒ 区间会变成
//     18500–18559，那 60 个端口里任何一个本机页面都能读走凭据。
//     同源 GET 浏览器不带 Origin；同源 POST 会带，带的就是控制台自己，放行。
//  2. 端口必须动态找：magpie 可能同时开多个插件宿主（桌面版 + web 版各一个 bun 进程），
//     固定端口必撞。
//  3. 转发必须保留原始 header 与 body：本体的 handler 自己判 Content-Type /
//     methods 405 / 415，服务端不能替它做决定。
//
// 防线的一处已知边界：`Sec-Fetch-Site` 是拦截「读不到响应但会执行副作用」那类请求
// （`<form>` 提交、`fetch(mode:'no-cors')`）的唯一手段，而它 Safari 16.4 / Firefox 90 /
// Chrome 76 起才有。更老的浏览器上，跨站 `<form>` 仍能打到写接口 —— 影响面是
// 「本机用户的浏览器版本」，不是网络可达面，所以没有为它再加 Referer 之类更脆的判据。
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONSOLE_DIR = fileURLToPath(new URL('../console/', import.meta.url))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

/**
 * Origin 是否控制台自己：协议 http（本服务不跑 TLS）、主机是回环写法、
 * 端口就是**本次真正绑定的那一个**。
 *
 * 为什么不按「探测区间」放行（2026-11-04 二审实测）：区间是 [from, from+tries-1]，
 * 而 `src/container.mjs` 调 `startHubServer({ from: 18500 })` **不传 tries** ⇒ 默认 60 ⇒
 * 白名单变成 18500–18559。于是本机任意落在这 60 个端口里的服务页面都能跨域读走凭据
 * （实测 `Origin: http://127.0.0.1:18505` → 200 + ACAO + 凭据）。本服务一次只绑一个端口，
 * 所以只认它。
 */
function ownOrigin(origin, port) {
  const o = String(origin ?? '').trim().toLowerCase()
  if (!o || !Number.isInteger(port)) return false
  // `localhost.`：合法的 FQDN 尾随点写法（DNS 解析时表示「不再追加搜索域」），别误伤。
  const m = /^http:\/\/(127\.0\.0\.1|localhost\.?|\[::1\]):(\d{1,5})$/.exec(o)
  if (!m) return false
  return Number(m[2]) === port
}

/** Host 头必须是回环地址：挡 DNS rebinding（攻击者域名解析到 127.0.0.1）。 */
function loopbackHost(hostHeader) {
  const h = String(hostHeader ?? '').trim().toLowerCase()
  return /^(127\.0\.0\.1|localhost\.?|\[::1\])(:\d{1,5})?$/.test(h)
}

/** 写操作：只有它们才额外收紧 `same-site`（见 crossSite）。 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * 跨站判定，三条：
 *  1. 带了 `Origin` 却不是控制台自己 → 跨站。同源 GET 浏览器不带 Origin，
 *     同源 POST **会带**（带的正是控制台自己，放行）。
 *  2. 浏览器自报 `Sec-Fetch-Site: cross-site` → 跨站。挡的是「读不到响应但会执行副作用」
 *     的那一类（`<form>` 提交、`fetch(mode:'no-cors')`），CORS 头对它们不起作用。
 *  3. **写操作**再收紧到 `same-site`：`Sec-Fetch-Site` 的 site 不含端口，
 *     本机 `127.0.0.1:3000` 的页面与 `127.0.0.1:18500` 是 same-site，
 *     不收紧的话本机任意端口的页面都能用 `<form enctype="text/plain">` 构造 JSON body
 *     打写接口。读请求不收紧 —— 能救的是 same-site 导航（本机另一个端口的页面里点链接）；
 *     跨站导航本来就被第 2 条挡住，读也不收紧并不会放过它。
 *  另：`Sec-Fetch-Site` 按逗号拆开判，见下面实现处的注释。
 */
function crossSite(req, port) {
  const origin = req.headers.origin
  if (origin && !ownOrigin(origin, port)) return true
  // 同一个请求头可能来多行（Node 会拼成 `"a, b"`），也可能被塞成逗号列表，
  // 所以拆开逐个判：只做 `=== 'cross-site'` 严格比较的话，
  // `Sec-Fetch-Site: same-site` + `Sec-Fetch-Site: cross-site` 这种重复头
  // 会拼成 `"same-site, cross-site"`，两个分支都不命中 → 直接放行（实测过）。
  const sites = String(req.headers['sec-fetch-site'] ?? '')
    .toLowerCase()
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  if (sites.includes('cross-site')) return true
  if (sites.includes('same-site') && WRITE_METHODS.has(String(req.method ?? '').toUpperCase())) return true
  return false
}

function applyCors(res, req, port) {
  const origin = req.headers.origin
  if (origin && ownOrigin(origin, port)) {
    // 回显具体来源，不再通配：只有控制台自己能跨域读。
    res.setHeader('Access-Control-Allow-Origin', String(origin))
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  // 只列前端真正用到的三种。`WRITE_METHODS` 里那几个（PUT/PATCH/DELETE）是给
  // `crossSite` 判定用的，前端从不发；同源请求也不需要预检，所以这里不列无妨。
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Max-Age', '600')
}

/** 把一个 node 的 IncomingMessage 转成 web Request（body 先缓冲成 Buffer）。 */
async function toWebRequest(req, host) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue
    headers.set(k, Array.isArray(v) ? v.join(',') : v)
  }
  const init = { method: req.method, headers }
  if (req.method !== 'GET' && req.method !== 'HEAD' && body !== undefined) init.body = body
  return new Request(`http://${host}${req.url}`, init)
}

/**
 * @param {object} opts
 * @param {{routes: Map<string, any>}} opts.seam  connection 接缝（提供 routes）
 * @param {(msg:string)=>void} [opts.log]
 * @param {()=>object} [opts.meta]  /__meta 的内容（provider 目录、连接方式等）
 * @param {string} [opts.host]
 * @param {number} [opts.from] 起始端口（默认 18500；直连后已无内部网关要避让）
 * @param {number} [opts.tries] 最多向上试几个端口
 */
export async function startHubServer({ seam, log = () => {}, meta = () => ({}), host = '127.0.0.1', from = 18500, tries = 60 }) {
  // Origin 白名单只认**本次真正绑定的端口** —— 按探测区间放行会连带放行上下
  // 几十个端口（见 ownOrigin 注释）。真实端口在 onListening 里写进来；
  // handler 只可能在 listen 之后被调用，那时它已经是真值。
  // 初值给 null 而不是 `from`：万一哪天真走到这里，ownOrigin 的 Number.isInteger
  // 会拒掉一切 Origin（fail-closed），而给 `from` 是 fail-open。
  let boundPort = null
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const port = boundPort
        // 先挡两类不该被受理的请求，再挂 CORS 头：
        //  · Host 不是回环 → DNS rebinding（攻击者域解析到 127.0.0.1 后绕过 Origin 白名单）；
        //  · 来源跨站 → 任意网页读凭据 / CSRF。
        if (!loopbackHost(req.headers.host)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('forbidden host')
          return
        }
        if (crossSite(req, port)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('forbidden origin')
          return
        }
        applyCors(res, req, port)
        if (req.method === 'OPTIONS') {
          res.writeHead(204).end()
          return
        }
        const url = new URL(req.url ?? '/', `http://${host}`)

        if (url.pathname === '/__meta') {
          let payload
          try {
            payload = meta()
          } catch (e) {
            payload = { error: String(e) }
          }
          res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' })
          res.end(JSON.stringify(payload))
          return
        }

        // 1) 本体注册的管理路由（/api/jet-hub、/api/jet-hub/captcha-carrier …）
        const route = seam.routes.get(url.pathname)
        if (route) {
          const resp = await route.fetch(await toWebRequest(req, host))
          const headers = {}
          resp.headers.forEach((v, k) => {
            headers[k] = v
          })
          const buf = Buffer.from(await resp.arrayBuffer())
          res.writeHead(resp.status, headers)
          res.end(buf)
          return
        }

        // 2) 静态控制台
        const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname)
        if (rel.includes('..')) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad path')
          return
        }
        const file = join(CONSOLE_DIR, rel)
        try {
          const data = await readFile(file)
          res.writeHead(200, {
            'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
            'cache-control': 'no-store',
          })
          res.end(data)
        } catch {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
        }
      } catch (e) {
        log(`控制台请求失败 ${req.method} ${req.url}：${String(e && e.stack ? e.stack : e)}`)
        try {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('internal error')
        } catch {}
      }
    })()
  })

  const port = await new Promise((resolve, reject) => {
    let p = from
    const attempt = () => {
      if (p >= from + tries) {
        reject(new Error(`magpie-jet-hub: 控制台端口 ${from}–${from + tries} 全被占用`))
        return
      }
      const onError = () => {
        server.removeListener('listening', onListening)
        p += 1
        attempt()
      }
      const onListening = () => {
        server.removeListener('error', onError)
        // 取 address() 而不是 p：`from: 0` 时 p 就是 0，真实端口由内核分配，
        // 只有 address() 才拿得到。别退回 `from`——那是 fail-open（放行别人占着的端口）。
        const a = server.address()
        const actual = a && typeof a === 'object' ? a.port : p
        boundPort = actual
        resolve(actual)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(p, host)
    }
    attempt()
  })

  return {
    port,
    url: `http://${host}:${port}/`,
    close: () =>
      new Promise((r) => {
        try {
          server.close(() => r())
        } catch {
          r()
        }
      }),
  }
}
