// connection 接缝：本体的 Jet Hub 管理 API 靠 DSH 的 `connection.fetch.register()` 注册。
//
// 为什么需要它（真跑验过，缺了就「全部功能」全部消失）：
//   vendor/lib/jet-hub-rpc.js:1535
//     const connection = ctx.connection ?? ctx.get('connection')
//     if (!connection || typeof connection.fetch?.register !== 'function') {
//       ctx.logger.warn('[jet-hub] connection.fetch not available, RPC endpoints not registered')
//
// 也就是说：容器里没有 `connection` 服务时，本体一条管理路由都不注册 —— 账号池、
// 登录流程、积分领取、模型目录、备份导入导出、原生搜索、面板入口，全部拿不到。
// 网关（/v1/chat/completions）照旧能用，所以表面看「插件是好的」，实际只剩转发。
//
// 这里提供一个最小可用的实现：把注册进来的路由收进一个 Map，由 src/hub-server.mjs
// 把真实 HTTP 请求转发进来。契约照抄本体的用法（path / methods / requestBody / fetch）。
import { Service } from '@deepseek-ai/cordis'

export class ConnectionSeam extends Service {
  constructor(ctx) {
    super(ctx, 'connection')
    /** @type {Map<string, {path:string, methods?:string[], fetch:(req:Request)=>Promise<Response>}>} */
    this.routes = new Map()
    // 本体读的是 `connection.fetch.register(...)`，形状必须一致。
    this.fetch = {
      register: (route) => {
        if (!route || typeof route.path !== 'string' || typeof route.fetch !== 'function') {
          ctx.logger?.warn?.('[jet-hub] connection.fetch.register 收到无效路由，已忽略')
          return
        }
        if (this.routes.has(route.path)) {
          ctx.logger?.warn?.(`[jet-hub] 路由 ${route.path} 被重复注册，后者覆盖前者`)
        }
        this.routes.set(route.path, route)
      },
    }
  }

  /** 路由清单（日志/自检用）。 */
  list() {
    return [...this.routes.values()].map((r) => `${(r.methods ?? []).join('+') || '*'} ${r.path}`)
  }
}
