// 独立起一个容器 + 控制台（不依赖 magpie 重启），供截图与手工验证。
import { JetHubContainer } from '../src/container.mjs'
const c = new JetHubContainer({
  home: process.env.USERPROFILE ?? process.env.HOME,
  entryPath: new URL('../vendor/lib/index.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  log: (m) => console.error('[hub]', m),
})
await c.start()
console.log('CONSOLE_URL=' + c.consoleUrl)
console.log('GATEWAY=' + c.baseURL)
setInterval(() => {}, 1 << 30)
