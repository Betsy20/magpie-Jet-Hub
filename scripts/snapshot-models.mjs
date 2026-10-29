// 从正在跑的 magpie 宿主拉一份 Jet Hub 的模型目录快照，写进 page/models.js。
//
// 页面在沙箱里联网被 CSP 挡住（connect-src 'none'），读不到宿主，所以模型目录
// 只能是快照。账号 / 模型开关变了就重跑一次：
//
//   node scripts/snapshot-models.mjs
//   node scripts/snapshot-models.mjs http://127.0.0.1:3425     # 用户网关（拼 snippet 用）
//   JET_HUB_USER_GATEWAY=http://127.0.0.1:4000 node scripts/snapshot-models.mjs
//                                         # 同上，但走环境变量（magpie 换了端口时用）
//
// 只写 page/models.js，不动别的文件。
//
// ⚠️ **模型目录和控制台地址必须出自同一个宿主**（2026-10-28 实测错配，见下）。
//
// 旧取法有两个独立数据源：模型来自插件落盘的缓存
// `~/.config/magpie/jet-hub-models.json`，控制台地址来自
// `~/.config/magpie/jet-hub-console.json`。两个文件都是「最后写入者说了算」，
// 同时跑两个宿主时实测到的结果是：缓存里 893 个模型属于 18501，地址文件写
// 18502（无人监听），页面静态默认又是 18500（892 个，缺
// `loomy/DeepSeek-V4.1-Flash`）。页面上就是「模型数 / 开关状态对不上控制台」。
//
// 现在的取法：先探出**活着的**控制台宿主（18500..18509 逐个连 `/__meta` 验活，
// 地址文件里的端口只当额外候选），然后**只从这一个宿主的 `/__meta`** 取全量目录
// 和控制台地址。`/__meta` 的目录已经是上游全量（`fullCatalogAt` 那一路），不需要
// 再读缓存；缓存只按 id 补 `name` / `disabled` 两个展示字段，对不上的就不补 ——
// 绝不跨宿主掺数据。
//
// ⚠️ 多宿主同时在跑时本脚本不合并、不猜：取**端口最小**的那台活宿主 ——
// magpie 从 18500 起按占用情况 +1 分配，所以最小端口 = 默认宿主 = 用户正在用的
// 那台；测试套件起的临时容器一定拿到更大的端口（实测抓到 :18502 活了不到 60 秒
// 就退出，而地址文件当时正好写着它）。地址文件里的端口**不因它在文件里就优先**：
// 那个文件是「最后写入者说了算」，谁都可能写。
// 所有活宿主都写进 `hosts` 字段，页面据此提示「还有别的宿主在跑」。要换宿主就
// 关掉另一个再重跑。
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

/** 用户网关（拼给客户端用的那个，不是插件内部网关 1839x）。
 *  优先级：命令行第一个参数 → JET_HUB_USER_GATEWAY → 常量默认。
 *  与 src/container.mjs 的 DEFAULT_USER_GATEWAY 保持同一个值。 */
const gateway = (process.argv[2] || process.env.JET_HUB_USER_GATEWAY || 'http://127.0.0.1:3425').replace(/\/+$/, '')

const CONSOLE_FILE = path.join(homedir(), '.config', 'magpie', 'jet-hub-console.json')
const CACHE = path.join(homedir(), '.config', 'magpie', 'jet-hub-models.json')

/** GET 一个地址的 `/__meta`；连不上、或者不是插件宿主就 null。 */
function probeMeta(url) {
  return new Promise((resolve) => {
    const req = http.get(`${url}__meta`, { timeout: 1500 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        resolve(null)
        return
      }
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { buf += d })
      res.on('end', () => {
        try {
          const j = JSON.parse(buf)
          resolve(Array.isArray(j?.providers) ? { url, meta: j } : null)
        } catch {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

/**
 * 候选控制台地址：18500..18509 按端口升序，加上地址文件里写的那个（如果不在
 * 这个区间）。
 *
 * ⚠️ 地址文件**不优先**（实测踩过两次）：
 *   1. 宿主的 console 端口是 18500 起 +1 分配的，最小端口就是最先启动的那台，
 *      也就是用户长期开着的那台；
 *   2. `~/.config/magpie/jet-hub-console.json` 是「最后写入者说了算」，测试套件
 *      起的临时容器会把它写成死端口（实测抓到它写 18502，而 18502 60 秒后就没了）。
 *
 * 所以候选顺序按端口，文件里的条目只当补充；活不活一律由 `/__meta` 验。
 */
function candidates() {
  const list = []
  for (let port = 18500; port < 18510; port += 1) list.push(`http://127.0.0.1:${port}/`)
  try {
    const j = JSON.parse(fs.readFileSync(CONSOLE_FILE, 'utf8'))
    if (typeof j?.url === 'string' && /^https?:\/\//.test(j.url)) {
      const u = j.url.endsWith('/') ? j.url : `${j.url}/`
      if (!list.includes(u)) list.push(u)
    }
  } catch {
    /* 文件不在或坏了就只探默认区间 */
  }
  return list
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
  'jet-hub-minimax': ['Jet Hub · MiniMax', 'MiniMax 国内站'],
  'jet-hub-autoclawintl': ['Jet Hub · AutoClaw 国际', '智谱 AutoClaw 国际版'],
  'jet-hub-gemini': ['Jet Hub · Gemini', 'Google Gemini'],
  'jet-hub-accio':  ['Jet Hub · Accio', '阿里 Accio'],
  'jet-hub-codely': ['Jet Hub · Codely', 'Codely'],
}

/** 缓存里按本体 id（`<provider>/<model>`）索引的 name / disabled，只用来补展示字段。 */
function readCache() {
  const map = new Map()
  let at = ''
  try {
    const j = JSON.parse(fs.readFileSync(CACHE, 'utf8'))
    at = String(j?.at ?? '')
    if (Array.isArray(j?.full)) {
      for (const r of j.full) {
        const id = String(r?.id ?? '')
        if (id) map.set(id, r)
      }
    }
  } catch {
    /* 没缓存也能出快照（只少中文名/关闭标记） */
  }
  return { map, at }
}

/** 把宿主 `/__meta` 的 provider 目录展开成 `{provider, bare}` 列表。 */
function rowsFromMeta(meta) {
  const rows = []
  for (const p of meta.providers ?? []) {
    const owner = String(p?.id ?? '')
    if (!owner) continue
    for (const m of p.models ?? []) {
      const bare = String(m ?? '')
      if (bare) rows.push({ provider: owner, bare })
    }
  }
  return rows
}

const portOf = (url) => {
  try {
    return new URL(url).port || ''
  } catch {
    return ''
  }
}

async function main() {
  // 1) 找出所有活着的控制台宿主；第一个出场的那个是数据源
  const live = []
  let chosen = null
  for (const url of candidates()) {
    const got = await probeMeta(url)
    if (!got) continue
    const rows = rowsFromMeta(got.meta)
    live.push({
      url: got.url,
      port: portOf(got.url),
      models: rows.length,
      providers: Array.isArray(got.meta.providers) ? got.meta.providers.length : 0,
      // 直连模式下没有本地网关地址（`meta.gateway.baseURL` 为 null）；
      // 字段保留是为了让下游「有没有内嵌网关」的判断继续成立，值改报模式。
      internalGateway: got.meta.gateway?.mode === 'direct' ? 'direct' : String(got.meta.gateway?.baseURL ?? ''),
      fullCatalogAt: String(got.meta.fullCatalogAt ?? ''),
      version: String(got.meta.version ?? ''),
    })
    if (!chosen) chosen = got
  }

  const cache = readCache()
  /** @type {Map<string, {id:string, upstream:string, name:string, disabled:boolean}>} */
  const byId = new Map()
  let source = ''
  let catalogAt = ''
  let consoleUrl = ''
  let consoleFrom = 'default'
  let missingDetail = 0

  if (chosen) {
    // 2) 主路：全量目录 + 控制台地址都来自**这一个**宿主
    consoleUrl = chosen.url
    consoleFrom = 'probe'
    catalogAt = String(chosen.meta.fullCatalogAt ?? '')
    source = `宿主 :${portOf(chosen.url)}/__meta（上游全量）`
    for (const { provider, bare } of rowsFromMeta(chosen.meta)) {
      const id = `${idOf(provider)}/${bare}`
      const hit = cache.map.get(`${provider}/${bare}`)
      if (!hit) missingDetail += 1
      byId.set(id, {
        id,
        upstream: `${provider}/${bare}`,
        name: String(hit?.name ?? ''),
        disabled: hit?.disabled === true,
      })
    }
  } else {
    // 3) 一个宿主都没连上：退回缓存（有全量就是全量），再不行才退网关实时目录
    console.log('  ⚠ 没连上任何控制台宿主，退回缓存 / 网关，控制台地址可能不对')
    let rows = []
    if (cache.map.size > 0) {
      rows = [...cache.map.values()].map((r) => ({ id: String(r.id), name: r.name, disabled: r.disabled }))
      catalogAt = cache.at
      source = 'plugin-cache（上游全量，没连上控制台）'
    } else {
      console.log('  缓存里也没有全量目录，退回网关（只有当前可用模型）')
      const res = await fetch(`${gateway}/v1/models`, { signal: AbortSignal.timeout(20000) })
      if (!res.ok) throw new Error(`GET ${gateway}/v1/models → HTTP ${res.status}`)
      const body = await res.json()
      const all = Array.isArray(body?.data) ? body.data : []
      rows = all.map((m) => ({ id: String(m?.id || ''), name: '', disabled: false }))
      source = 'gateway（仅当前可用）'
    }
    for (const r of rows) {
      const raw = String(r?.id ?? '')
      const i = raw.indexOf('/')
      if (i <= 0) continue
      byId.set(`${idOf(raw.slice(0, i))}/${raw.slice(i + 1)}`, {
        id: `${idOf(raw.slice(0, i))}/${raw.slice(i + 1)}`,
        upstream: raw,
        name: r?.name ?? '',
        disabled: r?.disabled === true,
      })
    }
    try {
      const j = JSON.parse(fs.readFileSync(CONSOLE_FILE, 'utf8'))
      if (typeof j?.url === 'string' && /^https?:\/\//.test(j.url)) {
        consoleUrl = j.url.endsWith('/') ? j.url : `${j.url}/`
        consoleFrom = 'file'
      }
    } catch {
      /* 连不上宿主时地址文件也只是参考 */
    }
    if (!consoleUrl) consoleUrl = 'http://127.0.0.1:18500/'
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
    catalogAt,
    gateway,
    source,
    total: models.length,
    models,
    // ⚠️ detail 的键顺序必须跟着 models 走。byId 的插入顺序 = 宿主 RPC 的返回顺序，
    //    上游每次给的顺序并不稳定（同一次升级重跑实测：891 个 id 一模一样的快照，
    //    diff 却有 253 行全是位置挪动）。键顺序在这里没有功能意义 —— 页面只拿
    //    `detail?.[m]` 按 id 查（page/page.js:201），但会让每次重跑都产出一份
    //    看不出改了什么的大 diff，把真正的目录变化埋掉。用排过序的 models 生成。
    detail: Object.fromEntries(models.map((id) => [id, byId.get(id)])),
    providers,
    // 控制台地址随快照一起带过去：侧栏页 CSP 是 connect-src 'none'，自己问不到端口，
    // 只能从这份快照里读（否则页面只能写死 18500，被占用后就是错地址）。
    // ⚠️ 它和上面的模型目录出自**同一个**宿主（见文件头）。
    console: consoleUrl,
    // probe = 探通了那台宿主自己报的地址；file = 一个都没探通，只好信地址文件；
    // default = 文件也没有，退回 18500。页面按这个换提示文案，错配才看得见。
    consoleFrom,
    consolePort: portOf(consoleUrl),
    // 所有活着的宿主：>1 个时页面提示「模型和控制台可能不是同一个实例」。
    hosts: live,
  }

  const js = `// 自动生成：node scripts/snapshot-models.mjs —— 别手改。
// 快照时间 ${payload.generatedAt}｜数据源 ${payload.source}｜控制台 ${payload.console}
window.JET_HUB_CATALOG = ${JSON.stringify(payload, null, 2)};
`
  fs.writeFileSync(OUT, js, 'utf8')
  const groups = new Set(models.map((m) => m.split('/')[0]))
  console.log(`✓ ${models.length} 个模型 / ${groups.size} 个 provider（来源：${payload.source}）→ ${path.relative(process.cwd(), OUT) || OUT}`)
  console.log(`  控制台地址 ${payload.console}（来源：${payload.consoleFrom}）`)
  if (live.length > 1) {
    console.log(`  ⚠ 检测到 ${live.length} 个宿主同时在跑：${live.map((h) => `:${h.port}=${h.models} 模型`).join('｜')}`)
    console.log('    快照只取第一个（上面那台）；要换宿主就关掉另一个再重跑。')
  }
  if (payload.consoleFrom !== 'probe') {
    console.log('  ⚠ 地址不是从活宿主探出来的：可能是死端口（测试套件也会写这个文件）')
  }
  if (missingDetail > 0) console.log(`  提示：${missingDetail} 个模型在缓存里查不到中文名/关闭标记（不影响 id）`)
  const unknown = [...groups].filter((g) => !(g in NAMES))
  if (unknown.length) console.log(`  未登记名字的 provider：${unknown.join(', ')}（请在 NAMES 里补上）`)
  if (!models.length) console.log('  ⚠ 一个 jet-hub 模型都没有：宿主可能没登录任何账号，或插件没加载')
}

main().catch((err) => {
  console.error('快照失败：' + (err?.message || err))
  console.error('  确认 magpie 在做：curl ' + gateway + '/v1/models，或看 ~/.config/magpie/jet-hub-console.json')
  process.exit(1)
})
