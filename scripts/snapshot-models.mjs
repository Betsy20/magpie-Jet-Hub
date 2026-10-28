// 从正在跑的 magpie 网关拉一份 Jet Hub 的模型目录快照，写进 page/models.js。
//
// 页面在沙箱里联网被 CSP 挡住（connect-src 'none'），读不到网关，所以模型目录
// 只能是快照。账号变了就重跑一次：
//
//   node scripts/snapshot-models.mjs
//   node scripts/snapshot-models.mjs http://127.0.0.1:3425
//
// 只写 page/models.js，不动别的文件。
//
// ⚠️ 数据源是**插件写的缓存** `~/.config/magpie/jet-hub-models.json`，不是网关。
// 原因（实测，m06921）：网关 `/v1/models` 只列**当前账号此刻能用**的模型
// （astudio 1 / cline 1 / workbuddy 2），用户要的是**上游全量**
// （astudio 9 / cline 540 / workbuddy 32）。全量只有本体 `model.list` RPC 拿得到，
// 而那个 RPC 只在插件进程里可用 —— 所以插件把全量落盘，这里读盘。
//
// ⚠️ 现在每个本体 provider 都是**独立的 magpie provider**，所以网关上的模型 id
// 形如 `jet-hub-codearts/deepseek-v4.1-flash`。快照保留完整 id（页面要能直接
// 复制去用），分组时按第一段（= magpie provider id）来。
import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'page', 'models.js')

const gateway = (process.argv[2] || 'http://127.0.0.1:3425').replace(/\/+$/, '')

/**
 * 控制台真实地址（插件启动时写在 `~/.config/magpie/jet-hub-console.json`）。
 * 端口从 18500 起找空位，被占用就是 18501/18502…，所以不能写死。
 *
 * ⚠️ 只读文件不够（实测踩过）：那个文件是**最后写入者**留下的，宿主被强杀后
 * 会留下一个死端口（实测文件写 18502，但 18502 早已没人监听，实际活着的是
 * 18500/18501）。所以读完必须连一下 `/__meta` 验证，连不上就按候选列表逐个探。
 * 全都不通才退回默认值（此时页面上的提示会指路这个文件）。
 */
async function readConsoleUrl() {
  const probe = (url) =>
    new Promise((resolve) => {
      const req = http.get(`${url}__meta`, { timeout: 1500 }, (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      })
      req.on('error', () => resolve(false))
      req.on('timeout', () => { req.destroy(); resolve(false) })
    })

  const cands = []
  try {
    const p = path.join(homedir(), '.config', 'magpie', 'jet-hub-console.json')
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (typeof j?.url === 'string' && j.url) cands.push(j.url)
  } catch {
    /* 文件不在或坏了就只探默认端口 */
  }
  for (let port = 18500; port < 18510; port += 1) cands.push(`http://127.0.0.1:${port}/`)

  for (const url of cands) {
    if (await probe(url)) return url
  }
  return 'http://127.0.0.1:18500/'
}

/**
 * 本体 provider → magpie provider id。
 *
 * ⚠️ 只有 `jet-hub-auto` 特殊：它在 magpie 里叫 `jet-hub`（见 src/plugin.mjs 的 idOf）。
 * 其余一律 `jet-hub-<本体名>`。这里必须与 idOf 保持一致，否则页面上的 id 复制出去用不了。
 */
const idOf = (dsh) => (dsh === 'jet-hub-auto' ? 'jet-hub' : `jet-hub-${dsh}`)

/** magpie provider id → [显示名, 一句话说明]。 */
const NAMES = {
  'jet-hub':        ['Jet Hub · 自动选号', '本体自带的按额度自动择优路由'],
  'jet-hub-aggregate': ['Jet Hub · 聚合', '本体内部的聚合路由组'],
  'jet-hub-codearts': ['Jet Hub · CodeArts', '华为云 CodeArts（STS 临时凭据）'],
  'jet-hub-workbuddy': ['Jet Hub · WorkBuddy', 'WorkBuddy 账号池'],
  'jet-hub-qoder':  ['Jet Hub · Qoder', 'Qoder'],
  'jet-hub-qodercn': ['Jet Hub · Qoder CN', 'Qoder 国内站'],
  'jet-hub-zcode':  ['Jet Hub · ZCode', 'ZCode（GLM 系列）'],
  'jet-hub-trae':   ['Jet Hub · Trae', 'Trae'],
  'jet-hub-autoclaw': ['Jet Hub · AutoClaw', '智谱 AutoClaw'],
  'jet-hub-buddy':  ['Jet Hub · Buddy', 'Buddy'],
  'jet-hub-cline':  ['Jet Hub · Cline', 'Cline'],
  'jet-hub-loomy':  ['Jet Hub · Loomy', 'Loomy'],
  'jet-hub-lobsterai': ['Jet Hub · LobsterAI', 'LobsterAI'],
  'jet-hub-modelscope': ['Jet Hub · ModelScope', '魔搭社区'],
  'jet-hub-officeace': ['Jet Hub · OfficeAce', '华为云 OfficeAce'],
  'jet-hub-astudio': ['Jet Hub · AStudio', '讯飞 AStudio'],
  'jet-hub-opencode': ['Jet Hub · OpenCode', 'OpenCode'],
  'jet-hub-raccoon': ['Jet Hub · Raccoon', 'Raccoon'],
  'jet-hub-minimaxintl': ['Jet Hub · MiniMax 国际', 'MiniMax 国际版'],
}

const CACHE = path.join(homedir(), '.config', 'magpie', 'jet-hub-models.json')

async function main() {
  let rows = []
  let cacheAt = ''
  try {
    const j = JSON.parse(fs.readFileSync(CACHE, 'utf8'))
    if (Array.isArray(j?.full) && j.full.length > 0) {
      rows = j.full
      cacheAt = String(j.at ?? '')
    }
  } catch { /* 没有缓存是正常情况，退回网关 */ }

  if (rows.length === 0) {
    console.log('  缓存里没有全量目录，退回网关（只有当前可用模型）')
    const res = await fetch(`${gateway}/v1/models`, { signal: AbortSignal.timeout(20000) })
    if (!res.ok) throw new Error(`GET ${gateway}/v1/models → HTTP ${res.status}`)
    const body = await res.json()
    const all = Array.isArray(body?.data) ? body.data : []
    rows = all.map((m) => ({ id: String(m?.id || ''), name: '', disabled: false }))
  }

  const byId = new Map()
  for (const r of rows) {
    const raw = String(r?.id ?? '')
    if (!raw) continue
    // 全量缓存里的 id 是**本体形态** `<dshProvider>/<model>`（如 `codearts/GLM-5.2`）。
    // 页面上要显示的是**能直接粘进 magpie 的** id，所以转成 magpie 形态。
    const i = raw.indexOf('/')
    if (i <= 0) continue
    const id = `${idOf(raw.slice(0, i))}/${raw.slice(i + 1)}`
    byId.set(id, {
      id,
      upstream: raw,
      name: r?.name ?? '',
      disabled: r?.disabled === true,
    })
  }
  const models = [...byId.keys()].sort()

  const providers = {}
  for (const id of models) {
    const seg = id.split('/')[0]
    const [name, desc] = NAMES[seg] ?? [seg, '本体带来的 provider']
    providers[seg] = { name, desc }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    catalogAt: cacheAt,
    gateway,
    source: cacheAt ? 'plugin-cache（上游全量）' : 'gateway（仅当前可用）',
    total: models.length,
    models,
    detail: Object.fromEntries([...byId]),
    providers,
    // 控制台地址随快照一起带过去：侧栏页 CSP 是 connect-src 'none'，自己问不到端口，
    // 只能从这份快照里读（否则页面只能写死 18500，被占用后就是错地址）。
    console: await readConsoleUrl(),
  }

  const js = `// 自动生成：node scripts/snapshot-models.mjs —— 别手改。
// 快照时间 ${payload.generatedAt}
window.JET_HUB_CATALOG = ${JSON.stringify(payload, null, 2)};
`
  fs.writeFileSync(OUT, js, 'utf8')
  const groups = new Set(models.map((m) => m.split('/')[0]))
  console.log(`✓ ${models.length} 个模型 / ${groups.size} 个 provider（来源：${payload.source}）→ ${path.relative(process.cwd(), OUT) || OUT}`)
  const unknown = [...groups].filter((g) => !(g in NAMES))
  if (unknown.length) console.log(`  未登记名字的 provider：${unknown.join(', ')}（请在 NAMES 里补上）`)
  if (!models.length) console.log('  ⚠ 一个 jet-hub 模型都没有：网关可能没登录任何账号，或插件没加载')
}

main().catch((err) => {
  console.error('快照失败：' + (err?.message || err))
  console.error('  确认 magpie 网关在跑：curl ' + gateway + '/v1/models')
  process.exit(1)
})
