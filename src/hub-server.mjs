// 本地控制台服务：把本体的 Jet Hub 管理 API（/api/jet-hub）暴露给浏览器，
// 同时把 console/ 下的管理界面当静态站点发出去。
//
// 为什么要单独起一个 HTTP 服务，而不是把界面塞进 magpie 的插件页：
//   magpie 给插件页的 CSP 是 `connect-src 'none'`，页面里 fetch 一个字节都发不出去
//   （见 internal/gui/pagebridge.js）。所以 magpie 侧栏页只能放一个 iframe 指向这里，
//   真正的管理界面由本服务提供 —— 它自己的响应头里没有那条 CSP，fetch 同源即可。
//
// 三个必须踩准的点（都真跑过）：
//  1. iframe 带 sandbox="allow-scripts" 且没有 allow-same-origin ⇒ 文档是 opaque origin，
//     对 http://127.0.0.1:<port> 也算跨域 ⇒ **必须回 Access-Control-Allow-Origin: *`，
//     并应答 OPTIONS 预检，否则界面上每个请求都 CORS 失败。
//  2. 端口必须动态找：magpie 可能同时开多个插件宿主（桌面版 + web 版各一个 bun 进程），
//     固定端口必撞。
//  3. 转发必须保留原始 header 与 body：本体的 handler 自己判 Content-Type /
//     methods 405 / 415，服务端不能替它做决定。
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

function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
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
  const server = createServer((req, res) => {
    void (async () => {
      try {
        applyCors(res)
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
        resolve(p)
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
