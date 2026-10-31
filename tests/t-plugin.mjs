// 测插件入口：模拟 magpie 宿主（遍历导出 + 无参探测）后按契约调用。
// 现在是「一个本体 provider 一个插件工厂」，所以要逐个验证契约一致。
import * as mod from '../index.mjs'
import { outputLimit } from '../src/plugin.mjs'
import { readFileSync } from 'node:fs'

// ⚠️ 本文件调 23 个工厂会**真起容器**（`warmUp()` 后台跑），所以必须隔离：
// 不隔离的话 `resolveHome(undefined)` 会退回 `homedir()`，把本体的 `DSH_HOME`
// 直指用户真实凭据目录 —— 实测跑一次本文件，`~/.dsh/.credentials.yaml` 与
// `jet-hub/state.json` 两个文件的哈希都变了（4 个 cline 账号的 access_token
// 被真实轮换）。隔离的三层做法与踩过的坑写在 `tests/_iso.mjs` 文件头。
//
// 传 `iso.options()` 而不是 `{}` 是关键那一步：`{}` 正是事故成因。
import { isolate, live, skipLive } from './_iso.mjs'

const iso = isolate()

const fns = Object.entries(mod).filter(([, v]) => typeof v === 'function')
const notFns = Object.entries(mod).filter(([, v]) => typeof v !== 'function')

console.log('非函数导出:', notFns.length === 0 ? '无 ✓' : notFns.map(([k]) => k).join(', '))
console.log('函数导出数:', fns.length)

const problems = []
const described = []
/** 上游没声明窗口的家（codely 就是：只有模态，没有 context/maxTokens）。 */
const noContext = []
/** `${工厂名}/${模型名}` → `limit.output`，护栏用。 */
const outputById = new Map()
for (const [name, fn] of fns) {
  // 宿主行为：无参探测调用，不能抛
  let plugin
  try {
    plugin = await fn({ client: { app: { log: () => {} } } }, iso.options())
  } catch (e) {
    problems.push(`${name}: 无参调用抛错 ${e?.message ?? e}`)
    continue
  }
  const id = plugin?.provider?.id
  if (typeof plugin?.config !== 'function') problems.push(`${name}: 缺 config`)
  if (!plugin?.auth?.provider) problems.push(`${name}: 缺 auth.provider`)
  if (plugin?.auth?.provider !== id) problems.push(`${name}: auth.provider(${plugin?.auth?.provider}) ≠ provider.id(${id})`)
  if (!Array.isArray(plugin?.auth?.methods) || plugin.auth.methods.length === 0) problems.push(`${name}: 缺 auth.methods`)
  if (typeof plugin?.auth?.loader !== 'function') problems.push(`${name}: 缺 auth.loader`)
  if (typeof plugin?.provider?.models !== 'function') problems.push(`${name}: 缺 provider.models`)

  const cfg = {}
  await plugin.config(cfg)
  const p = cfg.provider?.[id]
  if (!p) problems.push(`${name}: config 没写 provider[${id}]`)
  else if (!p.name || !p.api) problems.push(`${name}: config 缺 name/api`)
  if (p) {
    // 模型条目必须带**能力字段**（2026-10-29 用户报「推理强度 / 支持图片输出 /
    // 上下文没正确取到」）。宿主 `provider.models` 的返回是整体替换，不跟
    // models.dev 合并 —— 这里不给，magpie 界面上就是缺。
    const models = p?.models ?? {}
    const rows = Object.values(models)
    if (rows.length > 0) {
      const noLimit = rows.filter((m) => typeof m?.limit?.context !== 'number').length
      if (noLimit > 0) problems.push(`${name}: ${noLimit}/${rows.length} 个模型缺 limit.context`)
      const noCaps = rows.filter((m) => typeof m?.capabilities?.input?.text !== 'boolean').length
      if (noCaps > 0) problems.push(`${name}: ${noCaps}/${rows.length} 个模型缺 capabilities.input`)
      // 上下文别再是「一个数字都没有」：真实窗口必须来自本体，不能全 0。
      // ⚠️ 逐家不判死：codely 上游只声明模态、不声明 context（实测），那家全 0
      // 是上游事实。所以只把「一家都没有」当失败 —— 那才是能力链路整体断了。
      const withContext = rows.filter((m) => (m?.limit?.context ?? 0) > 0).length
      if (rows.length > 0 && withContext === 0) noContext.push(name)
      for (const [mid, m] of Object.entries(models)) outputById.set(`${name}/${mid}`, m?.limit?.output)
    }
  }
  described.push(`${id} ← ${name} | ${p?.name} | 静态模型 ${Object.keys(p?.models ?? {}).length}`)
}

// ⚠️ 回归护栏：未申报 `limit.output` 的渠道不许再被兜底成 8192 —— 那是「请求已被
// 夹断」的指纹。magpie 的路由组按**选中成员**的 output 夹 `max_tokens`，实测路由日志
// （`~/.config/magpie/routing/`）：`jet-hub-lobsterai/deepseek-flash` 走组 623 次输出
// 上限全 ≤8192，而同一模型直连同参数能到 40000；同组的 `jet-hub-workbuddy`
// （申报 128000）走组能到 40000。被夹到 8192 的推理模型会把预算全烧进 reasoning，
// `content` 为空、`finish_reason=length` ⇒ 客户端报「已达到输出 token 上限」。
//
// 直接测兜底口径（不走目录缓存），缓存竞态不会让这条护栏失效。
const OUTPUT_CASES = [
  // [模型 id, 申报值, 期望值, 说明]
  ['deepseek-flash', undefined, 393_216, 'LobsterAI 上游不申报 output'],
  ['deepseek-v4.1-flash', undefined, 393_216, 'CodeArts 上游不申报 output'],
  ['DeepSeek-V4.1-Flash', undefined, 393_216, 'Loomy 上游不申报 output'],
  ['deepseek-v4.1-flash', undefined, 393_216, 'OfficeAce 上游不申报 output'],
  ['deepseek-v4.1-flash-1017', undefined, 393_216, '同族带后缀变体'],
  ['deepseek-v4-flash-vision-exp', undefined, 393_216, '同族带后缀变体'],
  ['GLM-5.3', undefined, 131_072, 'GLM-5 系'],
  ['zai_glm-5.3-flash', undefined, 131_072, 'GLM-5 系（带前缀）'],
  // 申报过的值必须原样保留，不能被兜底表覆盖。
  ['deepseek-v4.1-flash', 128_000, 128_000, 'WorkBuddy 申报 128000'],
  ['deepseek-v4.1-flash', 64_000, 64_000, 'Trae 申报 64000'],
  ['sn-deepseek-v4-1-flash-1017', 100_000, 100_000, 'Raccoon 申报 100000'],
  // 认不出的系列：不申报（undefined），而不是编一个 8192。
  ['qfmodel', undefined, undefined, 'Qoder qfmodel 无据可查'],
]
for (const [id, declared, want, why] of OUTPUT_CASES) {
  const got = outputLimit(id, declared)
  if (got !== want) problems.push(`outputLimit(${id}, ${declared}) = ${got}，应为 ${want}（${why}）`)
}
// 源码级：`output` 不许再有 `?? 8192` 兜底（改回它就等于把故障改回来）。
{
  const src = readFileSync(new URL('../src/plugin.mjs', import.meta.url), 'utf8')
  if (/output\s*\?\?\s*8192/.test(src)) {
    problems.push('src/plugin.mjs 里仍有 `output ?? 8192` 兜底 —— 路由组会把请求夹到 8192')
  }
  // 全量目录那条路径必须把**模型 id** 交给 modelEntry（展示名匹配不到兜底表）。
  if (/out\[bare\]\s*=\s*modelEntry\(\s*(?!bare\b)/.test(src)) {
    problems.push('modelsOfFull 又把展示名当 id 传给 modelEntry —— 系列兜底会全部落空')
  }
}
// 目录侧抽样：受影响的四家在真实目录里必须带上真值（目录缓存可能不含该模型，故只抽检）。
for (const [key, want] of [
  ['JetHubLobsteraiPlugin/deepseek-flash', 393_216],
  ['JetHubCodeartsPlugin/deepseek-v4.1-flash', 393_216],
  ['JetHubLoomyPlugin/DeepSeek-V4.1-Flash', 393_216],
  ['JetHubOfficeacePlugin/deepseek-v4.1-flash', 393_216],
]) {
  if (!outputById.has(key)) continue
  const got = outputById.get(key)
  if (got !== want) problems.push(`${key}: 目录里 limit.output 应为 ${want}，实际 ${got}`)
}

/**
 * ⚠️ 回归护栏（2026-10-30 上游加 magicrew 时暴露的真缺陷）：
 * `index.mjs` 里的具名导出是**手写**的，而入口那道 `PROVIDER_IDS` 契约校验只查
 * `byId.get(id)`（从 `PLUGINS` 建的表，必定存在），**查不到「忘了写那一行 export」**。
 * 后果是静默的：magpie 加载插件后就是少一个 provider，没有任何报错，
 * `DSH_PROVIDERS` 加了、`panel` 里也看不见 —— 实测加完 magicrew 后
 * 这个文件报「✓ 全部工厂契约一致」却只有 25 个工厂。
 *
 * 判据：每个 `PROVIDER_IDS[i]` 对应的 `jet-hub-<id>` 都必须出现在模块的具名导出里，
 * 且那个导出的值就是 `PLUGINS` 里同一 id 的工厂（不是别家的被赋了两次）。
 */
{
  const { PROVIDER_IDS, PLUGINS } = await import('../src/plugin.mjs')
  const factoryById = new Map(PLUGINS)
  /** `jet-hub-magicrew` → `JetHubMagicrewPlugin`。两个路由组不注册，所以没有 `jet-hub` 这种裸 id。 */
  const exportNameOf = (id) => {
    const tail = id.replace(/^jet-hub-/, '')
    return `JetHub${tail.charAt(0).toUpperCase()}${tail.slice(1)}Plugin`
  }
  let checked = 0
  for (const id of PROVIDER_IDS) {
    const wanted = exportNameOf(id)
    const got = mod[wanted]
    if (typeof got !== 'function') {
      problems.push(`${id}: index.mjs 缺具名导出 ${wanted}（provider 会静默消失）`)
    } else if (got !== factoryById.get(id)) {
      problems.push(`${id}: 具名导出 ${wanted} 指向的不是本 id 的工厂（赋值错位）`)
    }
    checked += 1
  }
  // 反向：不许有导出名对不上任何 provider 的工厂（拼错就是拖一个孤儿工厂进去）。
  const names = new Set(PROVIDER_IDS.map(exportNameOf))
  for (const [k, v] of Object.entries(mod)) {
    if (typeof v !== 'function') continue
    if (!names.has(k)) problems.push(`index.mjs 多出无法对应 provider 的导出 ${k}`)
  }
  console.log(`具名导出护栏: 校验 ${checked} 个 provider`)
}

console.log(`--- ${described.length} 个 provider ---`)
for (const d of described) console.log('  ' + d)
if (noContext.length > 0) console.log(`  注：${noContext.join(' / ')} 的上游没声明上下文窗口（不是插件缺陷）`)
if (noContext.length === described.length && described.length > 0) {
  problems.push(`全部 ${described.length} 个 provider 的模型都没有 limit.context —— 能力链路断了`)
}

if (problems.length) {
  console.log('✗ 契约问题:')
  for (const p of problems) console.log('  ' + p)
  process.exit(1)
}
console.log('✓ 全部工厂契约一致')

// ---- 真转发 ----
//
// ⚠️ 换过两次策略（实测记录，别改回单一渠道）：
//   1. 一开始只用 workbuddy —— 它的账号池会偶发「余额查询未能全部完成」502，
//      测试因此红过一次，那**不是**桥接层缺陷。
//   2. 现在按顺序试 workbuddy → codearts → trae，**任一 200 即通过**。
//      三家都是本机已登录的真账号；全挂才说明桥接层真坏了。
//      上游此刻能不能用属于环境事实，不该让桥接层的回归测试跟着红。
const CANDIDATES = [
  ['JetHubWorkbuddyPlugin', 'jet-hub-workbuddy'],
  ['JetHubCodeartsPlugin', 'jet-hub-codearts'],
  ['JetHubTraePlugin', 'jet-hub-trae'],
]

let ok = false
const failures = []
// 真转发要真凭据 —— 隔离沙箱里没有 `.credentials.yaml`，跑必 502。
// 所以改成显式 opt-in：默认跳过并打印说明，`JET_HUB_LIVE=1` 才跑。
// ⚠️ 开了它就**会碰真实账号**（隔离被这一项主动放弃）：可能轮换 access_token
// （正常续期、不可回滚但无害），也可能消费一次性 refresh_token（**会逼用户
// 重新登录**，本机 officeace 那次 STS5.1806 就是这么来的）。别写进 CI。
if (!live()) {
  skipLive('真转发（需要真实凭据）')
  process.exit(0)
}
for (const [exportName, id] of CANDIDATES) {
  const fn = mod[exportName]
  if (typeof fn !== 'function') {
    failures.push(`${id}: 找不到导出 ${exportName}`)
    continue
  }
  const plugin = await fn({ client: { app: { log: () => {} } } }, iso.options())
  const t0 = Date.now()
  let acc
  try {
    acc = await plugin.auth.methods[0].authorize()
    console.log(`${id} authorize ✓ ${Date.now() - t0}ms →`, JSON.stringify(acc).slice(0, 120))
  } catch (e) {
    failures.push(`${id}: authorize 失败 ${e?.message ?? e}`)
    continue
  }

  const loaded = await plugin.auth.loader()
  const r = await loaded.fetch('https://jet-hub.invalid/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: '只回答两个字：收到' }],
      stream: false,
      max_tokens: 32,
    }),
    signal: AbortSignal.timeout(90000),
  })
  const text = await r.text()
  console.log(`${id} HTTP ${r.status} | ${text.slice(0, 160).replace(/\n/g, ' ')}`)
  if (r.status === 200) {
    ok = true
    break
  }
  failures.push(`${id}: HTTP ${r.status}`)
}

if (!ok) {
  console.log('✗ 三个渠道全挂，桥接层有问题：')
  for (const f of failures) console.log('  ' + f)
  process.exit(1)
}
console.log('✓ 真转发成功（至少一个渠道 200）')
process.exit(0)
