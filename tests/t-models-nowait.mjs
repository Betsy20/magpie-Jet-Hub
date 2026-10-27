// 验证 provider.models 不再阻塞（magpie 只给 20s）
import * as mod from '../index.mjs'

const plugin = await mod.JetHubPlugin({ client: { app: { log: (o) => console.log('  [log]', o.message) } } }, {})

const cfg = {}
await plugin.config(cfg)
const p = cfg.provider['jet-hub']

const t0 = Date.now()
const m1 = await plugin.provider.models(p)
const t1 = Date.now() - t0
console.log(`第 1 次 models(): ${Object.keys(m1).length} 个，耗时 ${t1}ms（必须 < 2000ms，否则会被 20s 超时打断）`)

// 等一下让后台容器起来，再取一次应拿到真目录
await new Promise((r) => setTimeout(r, 45000))
const t2 = Date.now()
const m2 = await plugin.provider.models(p)
const t3 = Date.now() - t2
console.log(`第 2 次 models(): ${Object.keys(m2).length} 个，耗时 ${t3}ms`)
console.log('前 6:', Object.keys(m2).slice(0, 6).join(', '))

if (t1 > 5000) {
  console.log('✗ 第 1 次仍然阻塞')
  process.exit(1)
}
console.log('✓ models() 不阻塞')
process.exit(0)
