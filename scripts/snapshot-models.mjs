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
// ⚠️ 现在每个本体 provider 都是**独立的 magpie provider**，所以网关上的模型 id
// 形如 `jet-hub-codearts/deepseek-v4.1-flash`。快照保留完整 id（页面要能直接
// 复制去用），分组时按第一段（= magpie provider id）来。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'page', 'models.js')

const gateway = (process.argv[2] || 'http://127.0.0.1:3425').replace(/\/+$/, '')

/** magpie provider id 前缀（`jet-hub` 是本体自己的自动选号路由）。 */
const isOurs = (seg) => seg === 'jet-hub' || seg.startsWith('jet-hub-')

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

async function main() {
  const res = await fetch(`${gateway}/v1/models`, { signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`GET ${gateway}/v1/models → HTTP ${res.status}`)
  const body = await res.json()
  const all = Array.isArray(body?.data) ? body.data.map((m) => String(m?.id || '')) : []

  const models = [...new Set(all.filter((id) => isOurs(String(id).split('/')[0])))].sort()

  const providers = {}
  for (const id of models) {
    const seg = id.split('/')[0]
    const [name, desc] = NAMES[seg] ?? [seg, '本体带来的 provider']
    providers[seg] = { name, desc }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    gateway,
    totalOnGateway: all.length,
    models,
    providers,
  }

  const js = `// 自动生成：node scripts/snapshot-models.mjs —— 别手改。
// 快照时间 ${payload.generatedAt}
window.JET_HUB_CATALOG = ${JSON.stringify(payload, null, 2)};
`
  fs.writeFileSync(OUT, js, 'utf8')
  const groups = new Set(models.map((m) => m.split('/')[0]))
  console.log(`✓ ${models.length} 个模型 / ${groups.size} 个 provider（网关共 ${all.length} 个）→ ${path.relative(process.cwd(), OUT) || OUT}`)
  const unknown = [...groups].filter((g) => !(g in NAMES))
  if (unknown.length) console.log(`  未登记名字的 provider：${unknown.join(', ')}（请在 NAMES 里补上）`)
  if (!models.length) console.log('  ⚠ 一个 jet-hub 模型都没有：网关可能没登录任何账号，或插件没加载')
}

main().catch((err) => {
  console.error('快照失败：' + (err?.message || err))
  console.error('  确认 magpie 网关在跑：curl ' + gateway + '/v1/models')
  process.exit(1)
})
