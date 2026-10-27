// 测插件入口：模拟 magpie 宿主（遍历导出 + 无参探测）后按契约调用。
// 现在是「一个本体 provider 一个插件工厂」，所以要逐个验证契约一致。
import * as mod from '../index.mjs'

const fns = Object.entries(mod).filter(([, v]) => typeof v === 'function')
const notFns = Object.entries(mod).filter(([, v]) => typeof v !== 'function')

console.log('非函数导出:', notFns.length === 0 ? '无 ✓' : notFns.map(([k]) => k).join(', '))
console.log('函数导出数:', fns.length)

const problems = []
const described = []
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
  described.push(`${id} ← ${name} | ${p?.name} | 静态模型 ${Object.keys(p?.models ?? {}).length}`)
}

console.log('--- 19 个 provider ---')
for (const d of described) console.log('  ' + d)

if (problems.length) {
  console.log('✗ 契约问题:')
  for (const p of problems) console.log('  ' + p)
  process.exit(1)
}
console.log('✓ 全部工厂契约一致')

// ---- 真转发：抽一个确定有模型的 provider（workbuddy） ----
const id = 'jet-hub-workbuddy'
const fn = mod.JetHubWorkbuddyPlugin
if (typeof fn !== 'function') {
  console.log('✗ 找不到 JetHubWorkbuddyPlugin')
  process.exit(1)
}
const plugin = await fn({ client: { app: { log: () => {} } } }, {})
const t0 = Date.now()
try {
  const acc = await plugin.auth.methods[0].authorize()
  console.log(`authorize ✓ ${Date.now() - t0}ms →`, JSON.stringify(acc).slice(0, 140))
} catch (e) {
  console.log('authorize ✗', e?.message ?? e)
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
console.log('HTTP', r.status, '|', text.slice(0, 200).replace(/\n/g, ' '))
if (r.status !== 200) process.exit(1)
process.exit(0)
