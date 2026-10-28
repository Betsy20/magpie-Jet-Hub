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
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { FileCredentialProvider } from './credentials.mjs'
import { ConnectionSeam } from './connection.mjs'
import { startHubServer } from './hub-server.mjs'

/**
 * 「死号判据对本家不可信」的 provider 名单 —— 命中即**不判死**。
 *
 * 判据 = 「`refreshable === false` 且 `expiresAt` 已过」。它成立于
 * 「refreshable 是兑出来的、expiresAt 是真日期」这两条前提。
 * 前提不成立的家必须列在这里，否则判据恒真、把能用的号就地判死。
 *
 * 当前只有 loomy —— 具体理由见 `isDeadAccount` 内注释。
 */
const DEAD_JUDGE_UNTRUSTED = new Set(['loomy'])

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
    this.seam = undefined
    this.console = undefined
    this.version = undefined
    this.models = []      // 最近一次拉到的模型 id（不带 provider 前缀）
    this.ownerOf = new Map() // modelId -> provider id
    this.fullCatalog = [] // 上游全量目录 [{id:'p/m', name, disabled, dead}]，含 disabled
    this.fullCatalogAt = undefined
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

    // 读本体版本（vendor/package.json），只用于控制台展示；读不到不影响运行。
    try {
      this.version = JSON.parse(readFileSync(join(dirname(this.entryPath), '..', 'package.json'), 'utf8')).version
    } catch {
      this.version = undefined
    }

    // 1) credentials 服务：桥到 DSH 的 .credentials.yaml
    ctx.plugin(FileCredentialProvider, { home: this.home })

    // 2) 本体依赖的三个 seam
    //    ⚠️ `connection` 必须在 `ctx.plugin(mod)` **之前**装好：本体的 apply() 里
    //    `registerJetHubRpc` 会 `ctx.get('connection')`，拿不到就只 warn 一句、
    //    一条管理路由都不注册（账号/登录/积分/模型/备份全部消失，只剩转发）。
    ctx.plugin(ConnectionSeam)
    for (const spec of ['@deepseek-ai/dsh-commands', '@deepseek-ai/dsh-llm']) {
      const m = await import(spec)
      ctx.plugin(m.default ?? m)
    }
    await new Promise((r) => setTimeout(r, 300))

    // 3) 本体
    // 必须转成 file:// URL：Node 的 ESM loader 拒绝裸 Windows 路径（'d:' 被当协议），
    // bun 虽然能接受裸路径，但写成 URL 两边都成立。
    const mod = await import(pathToFileURL(this.entryPath).href)
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

    // 6) 本地控制台：对外暴露本体注册的管理 API（/api/jet-hub）与 console/ 界面。
    //    放在网关就绪之后，`/__meta` 里的 provider 目录才是拉全的。
    this.seam = ctx.get('connection')
    if (this.seam === undefined || this.seam.routes.size === 0) {
      // 走到这里说明本体的 RPC 注册链路变了（版本升级），必须暴露出来而不是静默降级。
      throw new Error(
        'magpie-jet-hub: 本体没有注册任何 Jet Hub 管理路由（connection 接缝失效）。' +
          '管理功能会全部不可用，请检查 vendor/lib/jet-hub-rpc.js 的 registerJetHubRpc 是否仍在用 ctx.get("connection").fetch.register。',
      )
    }
    this.console = await startHubServer({
      seam: this.seam,
      log: this.log,
      meta: () => this.meta(),
      // 控制台与内部网关分两段端口：网关从 18390 起，控制台从 18500 起，
      // 各自向上找空位，互不抢。magpie 插件页里的默认端口也是 18500。
      from: 18500,
    })
    this.log(`控制台就绪 ${this.console.url}｜管理路由 ${this.seam.routes.size} 条：${this.seam.list().join(' | ')}`)
    // ⚠️ 不在这里补拉全量目录：`refreshFullCatalog()` 第一行就是 `await this.start()`，
    // 而此刻 `this.ready` 正是**当前这个** promise —— 会自己等自己，死锁。
    // 全量目录由 plugin.mjs 的 refreshInBackground 在 start 完成后填。
    // 落一份地址文件：magpie 的插件页 CSP 是 connect-src 'none'，页面拿不到端口，
    // 只能由用户/文档从这里取；同时便于 `magpie plugin list` 之后排查。
    //
    // ⚠️ **两条件缺一不可**（2026-10-28 事故：文件被测试进程写成 18502，而 18502
    // 上无人监听，用户照它访问连不上）。
    //
    //  ① `JET_HUB_NO_ADDR_FILE=1` 时**完全不写**：测试起的临时容器跑完就退，
    //     它绝不是这个文件该记的所有者；让测试闭嘴是根上的修法。
    //  ② 只有拿到**首发端口**（`from`，即 18500）时才写。向上漂移出来的 18501 /
    //     18502 说明首发端口被别人占着，**那个人才是所有者**，它的地址更该留。
    //     这条兜住「测试脚本忘了带开关」的情形。
    //
    // 代价（明写，不留暗坑）：所有者进程退出后文件仍指向它，直到下次有实例
    // 拿到 18500 才刷新。读取方（控制台页 / scripts/shot-console.cjs /
    // t-rpc-cover 的 `snapshotUrls`）本来就都另有探活与沿区间扫描的退路。
    const addrFileDisabled = /^(1|true|yes)$/i.test(String(process.env.JET_HUB_NO_ADDR_FILE ?? ''))
    if (!addrFileDisabled && this.console.port === 18500) {
      try {
        const p = join(homedir(), '.config', 'magpie', 'jet-hub-console.json')
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, JSON.stringify({ url: this.console.url, port: this.console.port, at: new Date().toISOString() }, null, 2))
      } catch { /* 写不了不影响服务 */ }
    }
    return this
  }

  /** 控制台地址（未启动时 undefined）。 */
  get consoleUrl() {
    return this.console?.url
  }

  /** 给控制台 `/__meta` 用的现场快照：provider → 模型，外加网关地址。 */
  meta() {
    /** @type {Map<string, string[]>} */
    const byProvider = new Map()
    // 优先用上游全量目录：网关 /v1/models 只列「此刻能用」的（astudio 1 条），
    // 控制台的模型页读的是 model.list 全量（astudio 9 条），两边不一致会让
    // 概览页的模型数看起来是错的。全量没拉到（冷启动中）才退回实时目录。
    const source = this.fullCatalog.length > 0 ? this.fullCatalog.map((m) => m.id) : this.models
    for (const fullId of source) {
      const owner = this.fullCatalog.length > 0
        ? fullId.split('/')[0]
        : this.ownerOf.get(fullId)
      if (!owner) continue
      if (!byProvider.has(owner)) byProvider.set(owner, [])
      const bare = fullId.startsWith(`${owner}/`) ? fullId.slice(owner.length + 1) : fullId
      byProvider.get(owner).push(bare)
    }
    return {
      providers: [...byProvider.entries()]
        .map(([id, models]) => ({ id, name: id, models }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      models: source.length,
      liveModels: this.models.length,
      fullCatalogAt: this.fullCatalogAt ?? undefined,
      gateway: { baseURL: this.baseURL, port: this.port },
      version: this.version,
      generatedAt: new Date().toISOString(),
    }
  }

  /** 判断账号是否「死号」：明确不可续期且有效期已过。 */
  static isDeadAccount(entry, now = Date.now()) {
    // loomy 的两条判据都**不是失效证据**，对它恒真 ⇒ 必须豁免，否则必误杀。
    //
    // ① `refreshable` 恒 false：loomy 服务端根本没有 refresh 端点，
    //    `vendor/lib/loomy-auth.js:34-37` 把这条写成了「诚实标记」——它描述的是
    //    「本产品没有续期这回事」，不是「这个号失效了」。而且它在登录返回值里
    //    无条件写死（`loomy-auth.js:160` / `:189`，再由 `jet-hub-rpc.js:3460` /
    //    `:4846` 落池）⇒ 池里每一个 loomy 账号都是 refreshable:false。
    // ② `expires_at` 是**本地推算的假日期**：服务端响应不带到期时间戳，
    //    `loomy-auth.js:198-206 buildCredential` 按 `Date.now() + 14 天` 自己算
    //    （`loomy-oauth.js:35 LOOMY_SESSION_TTL_SECONDS = 1_209_600`）。
    //    它只回答「登录后第 14 天」，不回答「这个号还能不能用」。
    //
    // 后果：两条腿合起来对 loomy **恒真** —— 登录满 14 天后，连同当时唯一在
    // 服务的号一起被判死。实测（2026-10-28）：两个 loomy 号寿命正好 336.00 小时，
    // 全被判死，而账本里 `loomy-dd2c0ebd` 当日 91 次请求 0 错误。
    //
    // 与「同样没有登记 refreshableOf 的另 6 家」（astudio / codely / modelscope /
    // officeace / opencode / zcode）**不能**一并豁免：它们各有第三条退路，判据
    // 对它们不会恒真，留着是有效保护（codearts 的死号正是靠它挡住 502）。
    // 但注意：这 6 家「不会被误杀」的原因**各不相同**，下面逐家点明真正的那条腿
    // —— 安全原因写错腿比不写更糟，下一个人会顺着错因去「修」一个没坏的东西。
    //  - astudio：**只靠第二腿**保住 —— `astudio.js:91 astudioCredentialExpiresAtMs`
    //    恒 undefined，astudio-auth.js:617-620 把「绝不写 expiresAt」列成硬规矩，
    //    所以判据的第二腿（`expiresAt` 是有限正数且已过）**永不成真**。
    //    它的第一腿**是会过的**：`refreshable` 由凭据如实判定（astudio.js:95
    //    isAstudioRefreshable，astudio-auth.js:631 用它回写账号池），凭据缺
    //    access_token（astudio-auth.js:582-584）或续期到终态错误（:597-600）
    //    时就写 false。⇒ 别拿「无 refreshableOf」当它的安全原因，那是一条错腿
    //    （2026-10-28 更正）。
    //  - officeace：登录成功即回填 `refreshable: true`（jet-hub-rpc.js:2551）
    //    ⇒ 第一腿就不过；占位条目虽写 false（:4032），但它不带 expiresAt。
    //  - codely：`refreshable` 恒 false（续期未接线，jet-hub-rpc.js:4371），
    //    但 expiresAt 只在 JWT 自带 exp 时才写（:4370）——写了且已过 = 真的
    //    不可用，判死是正确行为。
    //  - modelscope / opencode / zcode：落池条目都没有 expiresAt —— 魔搭的
    //    `expiresAtOf` 虽登记了（modelscope-auth.js:48），但 API Key 默认长期
    //    有效、凭据里多数没有 `expires_at`；opencode 是匿名占位（opencode-
    //    auth.js:183）、zcode 是「JWT 无 exp」的静态凭据（jet-hub-rpc.js:3843）。
    if (DEAD_JUDGE_UNTRUSTED.has(entry?.provider)) return false
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
   *
   * ⚠️ **覆盖范围有限，且刻意不扩**（2026-10-28 定稿）：
   * - 请求选号里有一批家走 `vendor/lib/credential-resolver.js:148 candidatesOf`
   *   → `pool.listAccountsByProvider`，**不经过这两个方法**，即本过滤对它们无效
   *   （loomy 的请求路径就在这批里）。
   * - 但 `vendor/lib/index.js:2712` 与 `:2726` 会为「凭据健康探测 / 续期」与
   *   「远端模型表」调 `getAvailableAccount(LOOMY.id, '')` —— 那两条**走这里**。
   *   所以 loomy 的豁免不是可有可无的：没有它，这两条会拿到 `null` 并落到
   *   全池刷新或 `LOOMY.defaultCredentialRef` 兜底。
   * - 不去包 `listAccountsByProvider`：它是 `candidatesOf` / `status()` / 控制台
   *   列表的**共同上游**，在那里过滤会同时改掉余额分档的候选集与 UI 展示，
   *   超出「选号」这件事的范围。要做必须单独立项、带自己的判据。
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
    // magpie 里「跳过已过期且不可续期的账号」开关：按 provider 单独拨，
    // 由 plugin.mjs 注册进来（容器自己不知道 magpie 的开关存在）。
    const skipFor = (provider) => (typeof self.deadSkipCheck === 'function' ? self.deadSkipCheck(provider) !== false : true)

    const origGet = pool.getAvailableAccount.bind(pool)
    pool.getAvailableAccount = async function (provider, modelId, excludeAccountIds) {
      if (!skipFor(provider)) return origGet(provider, modelId, excludeAccountIds)
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
      if (!skipFor(provider)) return rows
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

  /**
   * 调一次本体自己注册的管理 RPC（走 connection 接缝，不是网关）。
   *
   * 为什么需要：网关 `/v1/models` 只列**当前账号此刻能用**的模型
   * （实测 astudio 只给 1 个、cline 1 个、workbuddy 2 个），而本体的
   * `model.list` 给的是**上游全量目录**（同三个渠道分别 9 / 540 / 32 个）。
   * 用户要的是后者。
   */
  async rpc(method, payload) {
    await this.start()
    const route = this.seam?.routes?.get('/api/jet-hub')
    if (!route) throw new Error('本体管理路由未注册，拿不到全量目录')
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: 'catalog',
      method: 'jet-hub',
      payload: { method, payload },
    })
    const req = new Request('http://127.0.0.1/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    const resp = await route.fetch(req)
    const json = await resp.json()
    const r = json?.result
    if (!r?.ok) throw new Error(r?.error?.message ?? `${method} 失败`)
    return r.value
  }

  /**
   * 拉每个 provider 的**上游全量目录**，返回 `<provider>/<model>` 数组。
   *
   * ⚠️ 与 `refreshModels()` 的区别（实测数据，别混用）：
   *   - `refreshModels()` = 网关 `/v1/models` = 此刻**能用**的（会漏掉没登录账号的、
   *     被限流的、以及上游有但账号没开通的）
   *   - 本方法 = 本体 `model.list` RPC = **上游全量**（含 `disabled` 与 `dead` 标记）
   *
   * 全量里可能含打不通的模型，所以调用方要自己决定显示哪些。这里把
   * `disabled` / `dead` 标记一起带出去，不做静默过滤。
   */
  async refreshFullCatalog(providers) {
    await this.start()
    /** @type {{id:string, name:string, disabled:boolean, dead:boolean}[]} */
    const out = []
    for (const p of providers ?? []) {
      try {
        const v = await this.rpc('model.list', { provider: p })
        for (const m of v?.models ?? []) {
          const id = String(m?.id ?? '')
          if (!id) continue
          out.push({
            id: `${p}/${id}`,
            name: typeof m?.name === 'string' && m.name !== '' ? m.name : id,
            disabled: m?.disabled === true,
            dead: m?.dead === true,
          })
        }
      } catch (e) {
        // 路由组（jet-hub-auto / aggregate）本体里没有自己的目录，失败是正常的
        this.log(`拉 ${p} 的全量目录失败：${e?.message ?? e}`)
      }
    }
    this.fullCatalog = out
    this.fullCatalogAt = new Date().toISOString()
    return out
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
