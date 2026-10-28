// 测插件入口：模拟 magpie 宿主（遍历导出 + 无参探测）后按契约调用。
// 现在是「一个本体 provider 一个插件工厂」，所以要逐个验证契约一致。
import * as mod from '../index.mjs'

const fns = Object.entries(mod).filter(([, v]) => typeof v === 'function')
const notFns = Object.entries(mod).filter(([, v]) => typeof v !== 'function')

console.log('非函数导出:', notFns.length === 0 ? '无 ✓' : notFns.map(([k]) => k).join(', '))
console.log('函数导出数:', fns.length)

const problems = []
const described = []
/** 上游没声明窗口的家（codely 就是：只有模态，没有 context/maxTokens）。 */
const noContext = []
for (const [name, fn] of fns) {
  // 宿主行为：无参探测调用，不能抛
  let plugin
  try {
    plugin = await fn({ client: { app: { log: () => {} } } }, {})
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
    }
  }
  described.push(`${id} ← ${name} | ${p?.name} | 静态模型 ${Object.keys(p?.models ?? {}).length}`)
}

console.log('--- 19 个 provider ---')
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
for (const [exportName, id] of CANDIDATES) {
  const fn = mod[exportName]
  if (typeof fn !== 'function') {
    failures.push(`${id}: 找不到导出 ${exportName}`)
    continue
  }
  const plugin = await fn({ client: { app: { log: () => {} } } }, {})
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
