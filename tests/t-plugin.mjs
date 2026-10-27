// 测插件入口：模拟 magpie 宿主（遍历导出 + 无参探测）后按契约调用
import * as mod from '../index.mjs'

console.log('导出名单:', Object.keys(mod).join(', '))

// 1) 宿主行为：遍历全部导出，非函数跳过；函数逐个"探测"调用
for (const [k, v] of Object.entries(mod)) {
  if (typeof v !== 'function') {
    console.log(`  非函数导出 ${k} = ${typeof v} ${String(v).slice(0, 40)}`)
  }
}
const fns = Object.values(mod).filter((v) => typeof v === 'function')
console.log('函数导出数:', fns.length, '(应为 1)')

// 2) 按契约调用插件工厂
const plugin = await mod.JetHubPlugin({ client: { app: { log: () => {} } } }, {})
console.log('plugin keys:', Object.keys(plugin).join(', '))
console.log('auth.provider:', plugin.auth?.provider)
console.log('auth.methods:', plugin.auth?.methods?.map((m) => `${m.type}:${m.label}`).join(' | '))
console.log('provider.id:', plugin.provider?.id)

// 3) config
const cfg = {}
await plugin.config(cfg)
const p = cfg.provider?.['jet-hub']
console.log('config → name:', p?.name, '| api:', p?.api, '| models:', Object.keys(p?.models ?? {}).length)

// 4) authorize（会启动容器，耗时较久）
const t0 = Date.now()
try {
  const acc = await plugin.auth.methods[0].authorize()
  console.log(`authorize ✓ ${Date.now() - t0}ms →`, JSON.stringify(acc).slice(0, 160))
} catch (e) {
  console.log('authorize ✗', e?.message ?? e)
}

// 5) provider.models
const live = await plugin.provider.models(p)
console.log('models 数:', Object.keys(live).length)
console.log('前 8:', Object.keys(live).slice(0, 8).join(', '))

// 6) loader().fetch 真转发
const loaded = await plugin.auth.loader()
console.log('loader.baseURL:', loaded.baseURL)
const firstProviderModel = 'workbuddy/deepseek-v4.1-flash'
console.log('试转发:', firstProviderModel)
const r = await loaded.fetch('https://jet-hub.invalid/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: `jet-hub/${firstProviderModel}`,
    messages: [{ role: 'user', content: '只回答两个字：收到' }],
    stream: false,
    max_tokens: 32,
  }),
  signal: AbortSignal.timeout(90000),
})
const text = await r.text()
console.log('HTTP', r.status, '|', text.slice(0, 220).replace(/\n/g, ' '))

process.exit(0)
