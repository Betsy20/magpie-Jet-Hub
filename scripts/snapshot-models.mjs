// 从正在跑的 magpie 网关拉一份 Jet Hub 的模型目录快照，写进 page/models.js。
//
// 页面在沙箱里联网被 CSP 挡住（connect-src 'none'），读不到网关，所以模型目录
// 只能是快照。这份快照跟着本插件的账号登录状态走，账号变了就重跑一次：
//
//   node scripts/snapshot-models.mjs
//   node scripts/snapshot-models.mjs http://127.0.0.1:3425 jet-hub/
//
// 只写 page/models.js，不动别的文件。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'page', 'models.js')

const gateway = (process.argv[2] || 'http://127.0.0.1:3425').replace(/\/+$/, '')
const prefix = process.argv[3] || 'jet-hub/'

// 本体里这些 provider 的名字与一句话说明（写死，来自 deepseek-harness-codearts
// 的 provider 列表；id 用模型 id 的前缀段）
export const PROVIDERS = {
  workbuddy:      ['WorkBuddy',        'WorkBuddy 主账号池'],
  'workbuddy-ai': ['WorkBuddy AI',     'WorkBuddy AI 渠道'],
  zcode:          ['ZCode',            'ZCode（GLM 系列）'],
  qoder:          ['Qoder',            'Qoder'],
  qodercn:        ['Qoder CN',         'Qoder 国内站'],
  'qoder-cn':     ['Qoder CN',         'Qoder 国内站'],
  codearts:       ['CodeArts',         '华为云 CodeArts（STS 临时凭据）'],
  'trae-cn':      ['Trae CN',          'Trae 国内站'],
  trae:           ['Trae',             'Trae 国际站'],
  traeglobal:     ['Trae Global',      'Trae 国际站'],
  'autoclaw-cn':  ['AutoClaw 国内',    '智谱 AutoClaw 国内站'],
  autoclaw:       ['AutoClaw',         '智谱 AutoClaw'],
  autoclawintl:   ['AutoClaw 国际',    '智谱 AutoClaw 国际站'],
  officeace:      ['OfficeAce',        '华为云 OfficeAce'],
  astudio:        ['AStudio',          '讯飞 AStudio'],
  buddy:          ['Buddy',            'Buddy'],
  loomy:          ['Loomy',            'Loomy'],
  lobsterai:      ['LobsterAI',        'LobsterAI'],
  modelscope:     ['ModelScope',       '魔搭社区'],
  raccoon:        ['Raccoon',          'Raccoon'],
  opencode:       ['OpenCode',         'OpenCode'],
  cline:          ['Cline',            'Cline'],
  codely:         ['Codely',           'Codely'],
  gemini:         ['Gemini',           'Gemini（Cloud Code 客户端）'],
  accio:          ['Accio',            '阿里 Accio'],
  minimax:        ['MiniMax',          'MiniMax'],
  minimaxintl:    ['MiniMax 国际',     'MiniMax 国际版'],
  'providers-hub':['Providers Hub',    '聚合渠道（池路由）'],
  'jet-hub-auto': ['Jet Hub Auto',     '按额度自动择优的路由组'],
  auto:           ['Auto',             '按额度自动择优'],
  group:          ['Group',            '按顺序兜底的路由组'],
}

const PROVIDERS_JSON = Object.fromEntries(
  Object.entries(PROVIDERS).map(([id, [name, desc]]) => [id, { name, desc }]),
)

async function main() {
  const res = await fetch(`${gateway}/v1/models`, { signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`GET ${gateway}/v1/models → HTTP ${res.status}`)
  const body = await res.json()
  const all = Array.isArray(body?.data) ? body.data.map((m) => String(m?.id || '')) : []
  const mine = all
    .filter((id) => id.startsWith(prefix))
    .map((id) => id.slice(prefix.length))
    .filter(Boolean)
    .sort()

  const models = [...new Set(mine)]
  const seen = new Set(models.map((m) => m.split('/')[0]))
  const unknown = [...seen].filter((p) => !(p in PROVIDERS_JSON)).sort()

  const payload = {
    generatedAt: new Date().toISOString(),
    gateway,
    prefix,
    totalOnGateway: all.length,
    models,
    providers: PROVIDERS_JSON,
  }

  const js = `// 自动生成：node scripts/snapshot-models.mjs —— 别手改。
// 快照时间 ${payload.generatedAt}
window.JET_HUB_CATALOG = ${JSON.stringify(payload, null, 2)};
`
  fs.writeFileSync(OUT, js, 'utf8')
  console.log(`✓ ${models.length} 个模型（网关共 ${all.length} 个）→ ${path.relative(process.cwd(), OUT) || OUT}`)
  if (unknown.length) console.log(`  未登记名字的 provider 前缀：${unknown.join(', ')}（请在 scripts/snapshot-models.mjs 的 PROVIDERS 里补上）`)
  if (!models.length) console.log(`  ⚠ 一个 jet-hub 模型都没有：网关可能还没登录任何账号，或插件没加载`)
}

main().catch((err) => {
  console.error('快照失败：' + (err?.message || err))
  console.error('  确认 magpie 网关在跑：curl ' + gateway + '/v1/models')
  process.exit(1)
})
