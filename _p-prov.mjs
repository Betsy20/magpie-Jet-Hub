import { JetHubContainer } from './src/container.mjs'
const c = new JetHubContainer({ home: process.env.USERPROFILE, entryPath: new URL('./vendor/lib/index.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') })
await c.start()
const r = await c.rpc('provider.status', { providers: [] }).catch(e => ({ err: e.message }))
const st = r?.statuses ?? {}
const ids = Object.keys(st)
console.log('本体 provider 总数:', ids.length)
console.log(ids.join(', '))
const { DSH_PROVIDERS } = await import('./src/plugin.mjs')
const have = new Set(DSH_PROVIDERS)
console.log('magpie 已接入:', DSH_PROVIDERS.length)
console.log('未接入:', ids.filter(x => !have.has(x)).join(', ') || '无')
console.log('已接入但本体没有:', DSH_PROVIDERS.filter(x => !ids.includes(x)).join(', ') || '无')
process.exit(0)
