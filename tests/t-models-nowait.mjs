// 验证 provider.models 不再阻塞（magpie 只给 20s），且按 provider 切分正确
import * as mod from '../index.mjs'

// 单跑时别改写用户的 `~/.config/magpie/jet-hub-console.json`（理由见 t-plugin.mjs 的长注释）
process.env.JET_HUB_NO_ADDR_FILE = '1'

// ⚠️ 本文件会真起容器并计延迟，必须隔离（理由见 `tests/_iso.mjs` 文件头）。
import { isolate } from './_iso.mjs'

const iso = isolate()
const plugin = await mod.JetHubWorkbuddyPlugin({ client: { app: { log: (o) => console.log('  [log]', o.message) } } }, iso.options())
const cfg = {}
await plugin.config(cfg)
const p = cfg.provider['jet-hub-workbuddy']

const t0 = Date.now()
const m1 = await plugin.provider.models(p)
const t1 = Date.now() - t0
console.log(`第 1 次 models(): ${Object.keys(m1).length} 个，耗时 ${t1}ms（必须 < 2000ms）`)

await new Promise((r) => setTimeout(r, 45000))
const t2 = Date.now()
const m2 = await plugin.provider.models(p)
const t3 = Date.now() - t2
console.log(`第 2 次 models(): ${Object.keys(m2).length} 个，耗时 ${t3}ms`)
console.log('前 6:', Object.keys(m2).slice(0, 6).join(', '))

// 切分正确性：不该混进别的 provider 的前缀
const leaked = Object.keys(m2).filter((k) => k.includes('/') && !k.startsWith('deepseek-ai/'))
console.log('疑似串号(含斜杠但非 modelscope 形态):', leaked.length ? leaked.join(', ') : '无 ✓')

if (t1 > 5000) { console.log('✗ 第 1 次仍然阻塞'); process.exit(1) }
if (Object.keys(m2).length === 0) { console.log('✗ 拿不到模型'); process.exit(1) }
console.log('✓ models() 不阻塞且按 provider 切分')
process.exit(0)
