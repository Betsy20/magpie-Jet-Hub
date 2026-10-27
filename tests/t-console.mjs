// 控制台端到端自检：真启动容器（真网关 + 真控制系统），全部走真实 HTTP。
//
// 只断言「结构与非空」，不依赖具体账号数量 —— 那是用户数据，会变。
// 退出码即结论。
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { JetHubContainer } from '../src/container.mjs'

const entryPath = fileURLToPath(new URL('../vendor/lib/index.js', import.meta.url))
const log = (m) => console.log('  ·', m)

let failed = 0
function ok(name, cond, extra = '') {
  if (cond) console.log(`✓ ${name}${extra ? ' — ' + extra : ''}`)
  else {
    failed += 1
    console.log(`✗ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

const container = new JetHubContainer({ home: homedir(), entryPath, log })
let consoleUrl

try {
  console.log('启动容器（最久 60s）…')
  await container.start()
  consoleUrl = container.consoleUrl
  ok('控制台已启动', typeof consoleUrl === 'string' && consoleUrl.startsWith('http://127.0.0.1:'), consoleUrl)

  // 1) /__meta
  const metaRes = await fetch(`${consoleUrl}__meta`)
  const meta = await metaRes.json()
  ok('/__meta 200', metaRes.status === 200)
  ok('/__meta 有 provider', Array.isArray(meta.providers) && meta.providers.length > 0, `${meta.providers?.length} 个`)
  ok('/__meta 有模型', meta.models > 0, `${meta.models} 个`)
  ok('/__meta 带网关地址', typeof meta.gateway?.baseURL === 'string', meta.gateway?.baseURL)
  ok('/__meta 带版本', typeof meta.version === 'string', meta.version)

  // 2) 静态界面
  const pageRes = await fetch(consoleUrl)
  const html = await pageRes.text()
  ok('GET / 200', pageRes.status === 200)
  ok('页面标题正确', html.includes('Jet Hub 控制台'))
  for (const f of ['console.css', 'console.js']) {
    const r = await fetch(`${consoleUrl}${f}`)
    ok(`静态资源 ${f}`, r.status === 200, `HTTP ${r.status}`)
  }

  // 3) CORS 预检（sandbox iframe 的 opaque origin 必需）
  const opt = await fetch(`${consoleUrl}api/jet-hub`, { method: 'OPTIONS' })
  ok('OPTIONS 预检 204', opt.status === 204, `HTTP ${opt.status}`)
  ok('回 ACAO *', opt.headers.get('access-control-allow-origin') === '*')

  // 4) RPC 转发：account.list
  const rpcCall = async (method, payload = {}) => {
    const body = { type: 'client-request', rpcId: 't1', method: 'jet-hub', payload: { method, payload } }
    const r = await fetch(`${consoleUrl}api/jet-hub`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const j = await r.json()
    return { status: r.status, result: j.result }
  }

  const providers = meta.providers.map((p) => p.id)
  let total = 0
  let firstProvider = null
  for (const pv of providers) {
    const { result } = await rpcCall('account.list', { provider: pv })
    if (result?.ok !== true) continue
    const n = result.value?.accounts?.length ?? 0
    total += n
    if (n > 0 && firstProvider === null) firstProvider = pv
  }
  ok('account.list 可调用且有账号', total > 0, `${providers.length} 个 provider 共 ${total} 个账号，首个有账号的是 ${firstProvider}`)

  // 5) RPC 转发：model.list（挑第一个有模型的 provider）
  const withModels = meta.providers.find((p) => (p.models?.length ?? 0) > 0)
  if (withModels) {
    const { result } = await rpcCall('model.list', { provider: withModels.id })
    ok('model.list 可调用', result?.ok === true && Array.isArray(result.value?.models), `${withModels.id}：${result?.value?.models?.length ?? 0} 个`)
  }

  // 6) 错误路径：非法 method 应回 ok:false，而不是 500
  const bad = await rpcCall('__no_such_method__', {})
  ok('未知方法回 ok:false', bad.result?.ok === false && bad.status === 200, `${bad.status} ${bad.result?.error?.code ?? ''}`)

  // 7) 网关仍在
  const gw = await fetch(`http://127.0.0.1:${container.port}/v1/models`, {
    headers: { Authorization: `Bearer ${container.apiKey}` },
  })
  ok('内部网关 /v1/models 200', gw.status === 200)

  console.log(failed === 0 ? '\n结论：✓ 控制台链路正常' : `\n结论：✗ ${failed} 项失败`)
} catch (e) {
  console.error('✗ 异常：', e?.stack ?? e)
  failed += 1
} finally {
  await container.console?.close?.()
}

process.exit(failed === 0 ? 0 : 1)
