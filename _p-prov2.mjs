import { JetHubContainer } from './src/container.mjs'
const c = new JetHubContainer({ home: process.env.USERPROFILE, entryPath: new URL('./vendor/lib/index.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') })
await c.start()
const r = await c.rpc('provider.getOrder', {}).catch(e => ({ err: e.message }))
console.log('getOrder:', JSON.stringify(r).slice(0, 800))
process.exit(0)
