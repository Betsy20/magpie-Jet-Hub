// cordis 容器宿主：把 deepseek-harness-codearts 插件本体（npm 包
// `deepseek-harness-codearts` / 仓库 dsh-providers-hub）原样装进一个 cordis 容器，
// 让它自己开一个只监听回环的 OpenAI 兼容网关。
//
// 为什么这样做：本体自带 17 个 provider、账号池、静默续期、积分选号、模型目录、
// Jet Hub 的登录流程 —— 这些全部原样复用，一行都不重写。magpie 侧只需要把请求
// 转发到本容器自己的网关。
//
// ⚠️ 端口必须动态探测：magpie 可能同时开多个插件宿主（每个插件一个 bun 进程），
// 固定端口会撞。这里从 18390 往上找一个空端口。
import { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { FileCredentialProvider } from './credentials.mjs'

/** 找可用端口：先 bind 试探再释放（网关自己还会 bind，窗口极小但可接受）。 */
async function findFreePort(from = 18390, tries = 60) {
  for (let p = from; p < from + tries; p++) {
    const free = await new Promise((res) => {
      const s = createServer()
      s.once('error', () => res(false))
      s.once('listening', () => s.close(() => res(true)))
      s.listen(p, '127.0.0.1')
    })
    if (free) return p
  }
  throw new Error(`magpie-jet-hub: ${from}–${from + tries} 全是占用端口，无法为内部网关找位`)
}

export class JetHubContainer {
  constructor(options = {}) {
    // ⚠️ 两个路径语义**不同**（2026-10-27 实测，卡住一轮）：
    //  - `this.home` 给**自己的** FileCredentialProvider 用，是**家目录**
    //    （`C:/Users/Betsy`），它内部拼 `<家>/.dsh/.credentials.yaml`。
    //  - `this.dshHome` 给**本体**用（`process.env.DSH_HOME`），本体直接读
    //    `${DSH_HOME}/.credentials.yaml`（**不拼 `.dsh`**），所以必须是
    //    `C:/Users/Betsy/.dsh`。
    // 传错的表现：本体报「未配置凭据，请先登录」而 credentials 服务 resolve 正常。
    this.home = options.home
    this.dshHome = options.dshHome ?? (() => {
      const h = options.home ?? ''
      return /[\\/]\.dsh$/i.test(h) ? h.replace(/[\\/]\.dsh$/i, '') + '/.dsh' : h + '/.dsh'
    })()
    this.entryPath = options.entryPath // 本体 lib/index.js 的绝对路径
    this.log = options.log ?? (() => {})
    this.port = undefined
    this.apiKey = `jethub-${randomBytes(12).toString('hex')}`
    this.ctx = undefined
    this.ready = undefined
    this.models = []      // 最近一次拉到的模型 id（不带 provider 前缀）
    this.ownerOf = new Map() // modelId -> provider id
  }

  get baseURL() {
    return `http://127.0.0.1:${this.port}/v1`
  }

  /** 幂等启动。并发调用共享同一个 promise。 */
  start() {
    if (this.ready) return this.ready
    this.ready = this._start().catch((e) => {
      this.ready = undefined // 允许下次重试
      throw e
    })
    return this.ready
  }

  async _start() {
    this.port = await findFreePort()
    // 本体网关读这些环境变量。必须在 import 本体之前设好。
    process.env.DSH_HOME = this.dshHome
    process.env.DSH_OPENAI_GATEWAY_PORT = String(this.port)
    process.env.DSH_OPENAI_GATEWAY_ENABLED = '1'
    process.env.DSH_OPENAI_GATEWAY_API_KEY = this.apiKey

    const ctx = new Context()
    this.ctx = ctx

    // 1) credentials 服务：桥到 DSH 的 .credentials.yaml
    ctx.plugin(FileCredentialProvider, { home: this.home })

    // 2) 本体依赖的两个 seam
    for (const spec of ['@deepseek-ai/dsh-commands', '@deepseek-ai/dsh-llm']) {
      const m = await import(spec)
      ctx.plugin(m.default ?? m)
    }
    await new Promise((r) => setTimeout(r, 300))

    // 3) 本体
    const mod = await import(this.entryPath)
    ctx.plugin(mod)

    // 4) 等网关真的起来（最长 40s；本体要拉账号池、预热模型目录）
    const deadline = Date.now() + 40_000
    for (;;) {
      try {
        const r = await fetch(`${this.baseURL}/models`, {
          headers: { Authorization: `Bearer ${this.apiKey}` },
          signal: AbortSignal.timeout(3000),
        })
        if (r.ok) {
          const j = await r.json()
          this._absorbModels(j)
          this.log(`内部网关就绪 :${this.port}，模型 ${this.models.length} 个`)
          break
        }
      } catch {}
      if (Date.now() > deadline) {
        throw new Error(`magpie-jet-hub: 内部网关 40s 内未就绪（端口 ${this.port}）`)
      }
      await new Promise((r) => setTimeout(r, 700))
    }

    // 5) 死号过滤（真实缺陷，2026-10-28 实测）
    //
    // 本体的 `AccountPool.getAvailableAccount` 只按 `enabled` 与 `modelRateLimits`
    // 过滤，**完全不看 `expiresAt` / `refreshable`**（见 vendor/lib/account-pool.js:2251）。
    // 于是「已过期且没有 refresh_token」的死号仍是候选，一旦被选中就必然 502：
    //   `CodeArts token request failed: 400 STS5.1806 invalid refresh token`
    //
    // 实测现场：codearts 有两个账号，健康的 a40ab885（refreshable: true，可续期）
    // 与死号 8e65da6c（refreshable: false，expiresAt 已过 2000 分钟）。死号排在
    // 手动顺序前面 ⇒ 每次请求都先选它 ⇒ 整个 codearts 渠道看起来「挂了」，
    // 而实际上健康账号完全可用。
    //
    // ⚠️ **必须等网关就绪后再装**：`ctx.accountPool` 由本体的 `apply()` 里
    // `ctx.provide('accountPool', pool)` 提供（vendor/lib/index.js:5437），而
    // `ctx.plugin(mod)` 只是排期、apply 是异步的。装早了 `ctx.accountPool` 还是
    // undefined，补丁静默失效（实测踩过一次：补丁装了但选号仍是死号）。
    //
    // 为什么在容器层补而不是改 vendor：vendor 是本体原样拷贝，改它会让
    // 「跟着上游升级」变成手工合并。这里只包一层判定，升级 vendor 不受影响。
    //
    // 判据刻意保守：只有「明确标了不可续期」**且**「有效期已过」才算死号。
    // 缺 `expiresAt` 的、或 refreshable 为 true 的一律放行（可能还能刷成功）。
    this._filterDeadAccounts(ctx)
    return this
  }

  /** 判断账号是否「死号」：明确不可续期且有效期已过。 */
  static isDeadAccount(entry, now = Date.now()) {
    if (entry?.refreshable !== false) return false
    const at = entry?.expiresAt
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return false
    return at < now
  }

  /**
   * 把死号从账号池的两条选号路径里排除掉。
   *
   * 包的是 `AccountPool` 的两个公开方法（`getAvailableAccount` /
   * `listAvailableCredentials`），而不是 `readAccounts()` —— 后者是**写入**路径的
   * 读源（`updateModelRateLimit` 等走「读 → 改 → 整体写回」），在读取层过滤会
   * 把死号从磁盘上抹掉，那是用户的账号数据，不能悄悄删。
   */
  _filterDeadAccounts(ctx) {
    const pool = ctx.accountPool
    if (pool === undefined) {
      this.log('警告：ctx.accountPool 未就绪，死号过滤未安装')
      return
    }
    // 幂等：重复安装会套两层包装（日志重复、每次选号多跑两遍 readAccounts）。
    if (pool.__dshHubDeadFiltered === true) return
    pool.__dshHubDeadFiltered = true
    const { isDeadAccount } = JetHubContainer
    const self = this

    const origGet = pool.getAvailableAccount.bind(pool)
    pool.getAvailableAccount = async function (provider, modelId, excludeAccountIds) {
      const dead = new Set(
        this.readAccounts()
          .filter((a) => a.provider === provider && isDeadAccount(a))
          .map((a) => a.id),
      )
      if (dead.size === 0) return origGet(provider, modelId, excludeAccountIds)
      const merged = new Set(excludeAccountIds ?? [])
      for (const id of dead) merged.add(id)
      const hit = await origGet(provider, modelId, merged)
      if (hit !== null) self.log(`跳过 ${provider} 的 ${dead.size} 个死号`)
      return hit
    }

    const origList = pool.listAvailableCredentials.bind(pool)
    pool.listAvailableCredentials = async function (provider, modelId) {
      const rows = await origList(provider, modelId)
      const dead = new Set(
        this.readAccounts()
          .filter((a) => a.provider === provider && isDeadAccount(a))
          .map((a) => a.id),
      )
      return dead.size === 0 ? rows : rows.filter((r) => !dead.has(r.entry?.id))
    }
  }

  _absorbModels(json) {
    const rows = Array.isArray(json?.data) ? json.data : []
    this.models = []
    this.ownerOf.clear()
    for (const m of rows) {
      const id = String(m?.id ?? '')
      if (!id) continue
      this.models.push(id)
      const owner = String(m?.owned_by ?? '')
      if (owner) this.ownerOf.set(id, owner)
    }
  }

  /** 刷新模型目录（本体有新账号登录后会变）。 */
  async refreshModels() {
    await this.start()
    const r = await fetch(`${this.baseURL}/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) throw new Error(`刷新模型目录失败 HTTP ${r.status}`)
    this._absorbModels(await r.json())
    return this.models
  }

  /** 转发一次 chat/completions。model 必须是带 provider 前缀的 id。 */
  async forward(pathname, init) {
    await this.start()
    const url = `${this.baseURL}${pathname}`
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${this.apiKey}`)
    return fetch(url, { ...init, headers })
  }
}
