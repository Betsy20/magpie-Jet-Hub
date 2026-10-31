// cordis 容器宿主：把 deepseek-harness-codearts 插件本体（npm 包
// `deepseek-harness-codearts` / 仓库 dsh-providers-hub）原样装进一个 cordis 容器。
//
// 为什么这样做：本体自带 25 个 provider、账号池、静默续期、积分选号、模型目录、
// Jet Hub 的登录流程 —— 这些全部原样复用，一行都不重写。
//
// ⚠️ **不开 HTTP 网关**（本次改动）：本体的 OpenAI 兼容网关
// （`vendor/lib/openai-gateway/`）只是 `ctx.llm` 的一层 HTTP 外壳
// —— 它做的全部工作是「解析 body → `ctx.llm.stream()` → 转回 SSE/JSON」。
// 插件在**本进程内**已经握着同一个 `ctx.llm`，再走一遍
// `fetch(http://127.0.0.1:1839x/v1/...)` 只是多一次回环序列化。
//
// 所以这里显式 `DSH_OPENAI_GATEWAY_ENABLED=0`：不占端口、不需要随机 apiKey、
// 不需要 40 秒就绪轮询。请求由 `src/llm-bridge.mjs` 直接投给本体 llm 服务。
import { pathToFileURL } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { FileCredentialProvider } from './credentials.mjs'
import { ConnectionSeam } from './connection.mjs'
import { startHubServer } from './hub-server.mjs'
import { JetHubAttachmentStore } from './attachments.mjs'
import { chatCompletion, modelsPayload, llmReady, jsonResponse, errorResponse, openAiEfforts } from './llm-bridge.mjs'

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

/**
 * 「本次请求钉住哪个账号」的请求作用域。
 *
 * ## 为什么需要它（真实缺陷，2026-10-29 实测）
 *
 * magpie 的供应商编辑器里，一个 provider 的账号行是**用户可点选**的 ——
 * 用户在 magpie 里挑了「账号 B」，期望接下来的请求真的走 B。但直连模式下
 * 本体选号走的是 `AccountPool.getAvailableAccount(provider, modelId)`，
 * 它的判据**只有池内数组顺序**（`vendor/lib/account-pool.js:1961` 注释原文：
 * 「账号列表的数组顺序就是候选优先级」），池里没有任何「钉住某个账号」的字段
 * （全文件 grep `pin|sticky|preferredAccount|forcedAccount` 零命中）。
 *
 * ⇒ 光在 magpie 侧建多条账号记录是不够的：那些记录只是「看得见」，
 * 真正发请求时仍然是本体按顺序挑第一个可用号。要让「挑哪个就用哪个」成立，
 * 必须在**请求期**把候选集收窄到那一个账号。
 *
 * ## 为什么用 AsyncLocalStorage 而不是改池顺序
 *
 * 改池顺序（`account.reorder` 把选中账号顶到池首）有两个真实代价：
 *  ① 它是**全局持久**的副作用 —— 一次 magpie 请求会改掉本体账号池的落盘顺序，
 *     影响控制台与 DSH 里的手动排序（用户手动拖过的顺序被静默覆盖）；
 *  ② 并发不安全 —— 两个 magpie 请求钉不同账号时会互相踩。
 * AsyncLocalStorage 是**请求作用域**的：并发请求各自钉各自的号，不改任何盘上状态。
 */
const pinnedScope = new AsyncLocalStorage()

/**
 * 对外网关默认地址 —— magpie 主程序自己的 OpenAI 兼容网关。
 *
 * 为什么是常量而不是探测：magpie 不落盘端口（见构造函数里 `this.userGateway`
 * 的注释）。改端口的人用 `JET_HUB_USER_GATEWAY` 覆盖即可，控制台/插件页/快照
 * 三处都从 `meta().gateway.userGateway` 取值，不再各写一份。
 */
export const DEFAULT_USER_GATEWAY = 'http://127.0.0.1:3425'

export class JetHubContainer {
  constructor(options = {}) {
    // ⚠️ 两个路径语义**不同**（2026-10-27 实测，卡住一轮）：
    //  - `this.home` 给**自己的** FileCredentialProvider 用，是**家目录**
    //    （本机是 `%USERPROFILE%` / `$HOME`），它内部拼 `<家>/.dsh/.credentials.yaml`。
    //  - `this.dshHome` 给**本体**用（`process.env.DSH_HOME`），本体直接读
    //    `${DSH_HOME}/.credentials.yaml`（**不拼 `.dsh`**），所以必须是
    //    `<家>/.dsh`（本机即 `%USERPROFILE%\.dsh`）。
    // 传错的表现：本体报「未配置凭据，请先登录」而 credentials 服务 resolve 正常。
    this.home = options.home
    this.dshHome = options.dshHome ?? (() => {
      const h = options.home ?? ''
      return /[\\/]\.dsh$/i.test(h) ? h.replace(/[\\/]\.dsh$/i, '') + '/.dsh' : h + '/.dsh'
    })()
    this.entryPath = options.entryPath // 本体 lib/index.js 的绝对路径
    this.log = options.log ?? (() => {})
    this.ctx = undefined
    this.ready = undefined
    this.seam = undefined
    this.console = undefined
    this.version = undefined
    this.models = []      // 最近一次拉到的模型 id（不带 provider 前缀）
    this.ownerOf = new Map() // modelId -> provider id
    // modelId -> 能力元数据 `{ context, output, input, reasoning }`。
    //
    // ⚠️ 单独存一份是因为 `this.models` 是**纯 id 数组**：magpie 的模型列表要
    // 上下文窗口、能不能发图、有没有思考档位，只留 id 的话调用方只能按 128K 猜。
    // 实测（2026-10-29）：真窗口 trae 1000000 / astudio 1048576，全被猜成 128K。
    this.modelMeta = new Map()
    this.fullCatalog = [] // 上游全量目录 [{id:'p/m', name, disabled, dead}]，含 disabled
    this.fullCatalogAt = undefined
    // 对外网关（magpie 主程序那个，不是本插件内部网关 —— 内部网关已经没有了）。
    //
    // ⚠️ 这个地址**只能写默认值 + 让人覆盖**，没法自动探测：实测 magpie 主程序
    // 不把端口落盘到 `~/.config/magpie/` 下任何可读配置（settings.json 里
    // 没有 gate/port/server/api 相关键，也没有任何网关命名的文件），宿主注入
    // 给插件的环境变量只有 `MAGPIE_*` 系列，同样不带端口。所以给一个显式覆盖口
    // 比在三个文件里各写死一份 3425 更诚实。
    this.userGateway = String(
      options.userGateway ?? process.env.JET_HUB_USER_GATEWAY ?? DEFAULT_USER_GATEWAY,
    ).replace(/\/+$/, '')
  }

  /**
   * 在「钉住某个账号」的作用域里跑一段异步逻辑。
   *
   * `accountId` 是本体账号池里的条目 id（`workbuddy-9c0d1e2f` 这种）。
   * 传空串 / undefined 就是普通调用（不钉，按池内顺序选号）。
   *
   * ⚠️ 必须用 `run()` 而不是「设一个全局变量再还原」：magpie 的请求是并发的，
   * 全局变量会让 A 请求钉的号漏到 B 请求上。AsyncLocalStorage 沿 Promise 链
   * 传播，每个请求各拿各的值。
   */
  runPinned(accountId, fn) {
    const id = String(accountId ?? '').trim()
    if (id === '') return fn()
    return pinnedScope.run({ accountId: id }, fn)
  }

  /** 当前作用域钉住的账号 id（没钉就是空串）。 */
  static pinnedAccountId() {
    return String(pinnedScope.getStore()?.accountId ?? '')
  }

  /**
   * 本体的 llm 服务（`ctx.llm`）。直连层的唯一入口。
   *
   * 只在 `start()` 之后可用；`_start()` 的第三步 `ctx.plugin(mod)` 是异步排期，
   * 所以取用一律走 `await this.start()` 之后的 `this.llm`。
   */
  get llm() {
    return this.ctx?.get('llm')
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
    // 本体网关读这些环境变量。必须在 import 本体之前设好。
    process.env.DSH_HOME = this.dshHome
    // ⚠️ 显式**关掉**本体自带的 HTTP 网关：本插件直接调 `ctx.llm`
    // （见文件头注释），不需要那个端口，也就不设 PORT / API_KEY。
    process.env.DSH_OPENAI_GATEWAY_ENABLED = '0'

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

    // 2.5) 附件服务（`ctx.attachments`）：本体收发图片全走它
    //
    //      ⚠️ 必须在 `ctx.plugin(mod)` **之前** provide：本体的
    //      `makeReadImage(ctx)` / `makeReadImageRequest(ctx)` 是在 apply 时
    //      `ctx.get('attachments')` 拿一次并闭包住的，晚一步就永远是 undefined
    //      —— 表现是纯文本正常、一发图就报「当前 profile 未装载附件服务」。
    //
    //      实现的契约见 `src/attachments.mjs` 文件头（内容寻址落盘 + 原字节读回，
    //      不做缩放：本体对「没有 readImageRequest」有现成的回退）。
    this.attachments = new JetHubAttachmentStore()
    ctx.provide('attachments', this.attachments)

    // 3) 本体
    // 必须转成 file:// URL：Node 的 ESM loader 拒绝裸 Windows 路径（'d:' 被当协议），
    // bun 虽然能接受裸路径，但写成 URL 两边都成立。
    const mod = await import(pathToFileURL(this.entryPath).href)
    ctx.plugin(mod)

    // 4) 等本体的 llm 服务可用（最长 40s；本体要拉账号池、预热模型目录）
    //
    //    不走 HTTP：`ctx.get('llm')` 要等本体的 `apply()` 把服务 provide 出来
    //    才非空，`ctx.plugin(mod)` 只是排期。这里轮询同一个判据，模型目录
    //    也从 `ctx.llm` 直接采（`collectGatewayModels` 已逐个 provider 兜错）。
    //
    //    ⚠️ **「llm 存在」≠「目录已填」**（实测踩过）：`ctx.get('llm')` 一
    //    provide 就非空，但账号池加载与 provider 注册都还在异步进行，此刻采到
    //    的目录是 **0 条**。原来走 HTTP 时这个时间差被网关的首个 200 挡掉了；
    //    直连后必须自己等，否则控制台与 magpie 都会看到「没有模型」。
    //    判据因此是「采到模型」，而不是「llm 非空」。
    const hardDeadline = Date.now() + 40_000
    // 目录为空时的等待上限：未登录（真的没模型）是合法状态，不能死等到 40s
    // 才放行 —— 那会让插件宿主启动白等 40 秒。
    const emptyDeadline = Date.now() + 15_000
    let lastError
    for (;;) {
      const llm = this.llm
      if (llmReady(llm)) {
        try {
          this._absorbModels(await modelsPayload(llm))
          lastError = undefined
        } catch (error) {
          lastError = error
        }
        if (this.models.length > 0) {
          this.log(`本体 llm 服务就绪（直连，无网关端口），模型 ${this.models.length} 个`)
          break
        }
        if (Date.now() > emptyDeadline) {
          // 等够了还是没有：可能是所有渠道都未登录，也可能 provider 注册慢。
          // 两种情况都不该让插件起不来 —— 记一行日志、继续（模型登录后会刷新）。
          this.log('本体 llm 服务就绪，但模型目录仍为空（各渠道可能都未登录）')
          break
        }
      }
      if (Date.now() > hardDeadline) {
        if (!llmReady(this.llm)) {
          throw new Error('magpie-jet-hub: 本体 llm 服务 40s 内未就绪（直连模式，无网关端口）')
        }
        // llm 就绪但采集一直抛错：这是真故障（不是「没登录」），必须暴露。
        throw new Error(`magpie-jet-hub: 本体 llm 模型目录采集失败：${lastError?.message ?? lastError}`)
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
    // `ctx.provide('accountPool', pool)` 提供（vendor/lib/index.js:5712），而
    // `ctx.plugin(mod)` 只是排期、apply 是异步的。装早了 `ctx.accountPool` 还是
    // undefined，补丁静默失效（实测踩过一次：补丁装了但选号仍是死号）。
    //
    // 为什么在容器层补而不是改 vendor：vendor 是本体原样拷贝，改它会让
    // 「跟着上游升级」变成手工合并。这里只包一层判定，升级 vendor 不受影响。
    //
    // 判据刻意保守：只有「明确标了不可续期」**且**「有效期已过」才算死号。
    // 缺 `expiresAt` 的、或 refreshable 为 true 的一律放行（可能还能刷成功）。
    //
    // 5.5) 按账号钉住（magpie 里用户挑了哪个账号，请求就必须真的走哪个）
    //
    // ⚠️ **必须在死号过滤之前装**（2026-10-29 审查发现并改正）：两层包装是
    // 栈式叠加，后装的在外层。钉号那层会把结果直接替换成被钉的那一条、
    // 不再问内层 —— 如果钉号在外层，用户钉了一个已过期且不可续期的账号时，
    // 死号过滤被整个绕过，整家渠道立刻 502（而 `_filterDeadAccounts` 存在的
    // 理由正是拦这种号（实测 codearts 会报 `STS5.1806 invalid refresh token`））。
    //
    // 正确顺序：钉号先装（内层，把候选收窄到一个），死号后装（外层，把死号
    // 并进 `excludeAccountIds` 传给内层，内层见自己被排除就返回 null）。
    this._pinAccounts(ctx)

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
      // 控制台端口从 18500 起向上找空位（直连后已经没有内部网关要分端口了，
      // 这段历史注释留在这里是为了说明 18500 这个起点的来历）。
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
      // 直连模式：**没有**本地网关端口了。`mode: 'direct'` 是给控制台/插件页
      // 判文案的判据 —— 它们读 `gateway.port` 有值才显示「本地网关 :1839x」，
      // 读到 null 就显示「直连本体 llm 服务（无本地端口）」。
      //
      // `userGateway` 是**另一个**东西：插件内部没有端口了，但用户拿客户端接的
      // 是 magpie 主程序那个网关。它以前在控制台/插件页/快照脚本里各写死一份
      // 3425，改端口就得改三处；现在统一从这里取（见 DEFAULT_USER_GATEWAY）。
      gateway: { mode: 'direct', baseURL: null, port: null, userGateway: this.userGateway },
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
    //    无条件写死（`loomy-auth.js:160` / `:189`，再由 `jet-hub-rpc.js:3976` 那条
    //    `pool.addAccount` 落池）⇒ 池里每一个 loomy 账号都是 refreshable:false。
    // ② `expires_at` 是**本地推算的假日期**：服务端响应不带到期时间戳，
    //    `loomy-auth.js:198-206 buildCredential` 按 `Date.now() + 14 天` 自己算
    //    （`loomy-oauth.js:35 LOOMY_SESSION_TTL_SECONDS = 1_209_600`）。
    //    它只回答「登录后第 14 天」，不回答「这个号还能不能用」。
    //
    // 后果：两条腿合起来对 loomy **恒真** —— 登录满 14 天后，连同当时唯一在
    // 服务的号一起被判死。实测（2026-10-28）：两个 loomy 号寿命正好 336.00 小时，
    // 全被判死，而账本里 `loomy-3a4b5c6d` 当日 91 次请求 0 错误。
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
    //  - officeace：登录成功即回填 `refreshable: true`（jet-hub-rpc.js:2774）
    //    ⇒ 第一腿就不过；占位条目虽写 false（:4574），但它不带 expiresAt。
    //  - codely：`refreshable` 恒 false（续期未接线，jet-hub-rpc.js:4913），
    //    但 expiresAt 只在 JWT 自带 exp 时才写（:4912）——写了且已过 = 真的
    //    不可用，判死是正确行为。
    //  - modelscope / opencode / zcode：落池条目都没有 expiresAt —— 魔搭的
    //    `expiresAtOf` 虽登记了（modelscope-auth.js:48），但 API Key 默认长期
    //    有效、凭据里多数没有 `expires_at`；opencode 是匿名占位（opencode-
    //    auth.js:183）、zcode 是「JWT 无 exp」的静态凭据（见 `zcode-auth.js` 的
    //    `startLogin`，落池条目不带 expiresAt）。
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
   * - 但 `vendor/lib/index.js:2718` 与 `:2732` 会为「凭据健康探测 / 续期」与
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

  /**
   * 把「本请求钉住的那个账号」变成选号时的**唯一候选**。
   *
   * ## 为什么必须包在池上（而不是在 `forward()` 里传参）
   *
   * 选号发生在**适配器内部**（21 处 `getAvailableAccount` 调用，见
   * `vendor/lib/account-pool.js:2249`），`forward()` → `chatCompletion()` →
   * `llm.stream()` 这条链上**没有任何账号参数位**（`toGenerateOptions()` 的
   * 签名里也没有）。所以要影响选号，只能包池的两个选号入口 —— 与死号过滤
   * 同一个手法（改 vendor 会让「跟上游升级」变成手工合并）。
   *
   * ## 钉不住时怎么办（刻意选择）
   *
   * 钉的账号在池里找不到（用户刚在 DSH 里删了它）→ **退回不钉**，照常按
   * 池内顺序选号。理由：一个陈旧的 magpie 账号记录不该让整家渠道 502。
   * 这条会在日志里留一行，便于排查「我挑的号没生效」。
   */
  _pinAccounts(ctx) {
    const pool = ctx.accountPool
    if (pool === undefined) {
      this.log('警告：ctx.accountPool 未就绪，按账号钉住未安装')
      return
    }
    if (pool.__dshHubPinned === true) return
    pool.__dshHubPinned = true
    const self = this

    /** 本次请求钉的账号条目（未钉 / 找不到都返回 undefined）。 */
    const pinnedEntryOf = (provider) => {
      const want = JetHubContainer.pinnedAccountId()
      if (want === '') return undefined
      const hit = pool.readAccounts().find((a) => a.id === want && a.provider === provider)
      if (hit === undefined) {
        self.log(`钉住的账号 ${want} 不在 ${provider} 的池里（可能已在 DSH 里删除），本次按池内顺序选号`)
      }
      return hit
    }

    const origGet = pool.getAvailableAccount.bind(pool)
    pool.getAvailableAccount = async function (provider, modelId, excludeAccountIds) {
      const pin = pinnedEntryOf(provider)
      if (pin === undefined) return origGet(provider, modelId, excludeAccountIds)
      // 显式排除集仍然尊重（调用方说「这个号试过了」时不能又挑回它）。
      if (excludeAccountIds !== undefined && new Set(excludeAccountIds).has(pin.id)) return null
      // 限流判据与本体一致：空 modelId 跳过，未到期才算可用。
      if (modelId && pin.modelRateLimits) {
        const resetAt = pin.modelRateLimits[modelId]
        if (resetAt !== undefined && resetAt !== 0 && Date.now() < resetAt) return null
      }
      if (pin.enabled === false) return null
      try {
        // ⚠️ 用 `_pinAccounts(ctx)` 拿到的 ctx，**不要用 `this.ctx`**：
        // 这个包装函数被调用时 `this` 是 pool，真实 pool 恰好也有 `.ctx`，
        // 但那是实现细节（`vendor/lib/account-pool.js` 的实例字段），
        // 依赖它会让测试的假池（没有 `.ctx`）静默返回 null。
        const resolved = await ctx.credentials.resolve(pin.credentialRef)
        if (!resolved) return null
        return { entry: pin, credential: JSON.parse(resolved.value) }
      } catch (error) {
        self.log(`钉住的账号 ${pin.id} 凭据不可用：${error?.message ?? error}`)
        return null
      }
    }

    const origList = pool.listAvailableCredentials.bind(pool)
    pool.listAvailableCredentials = async function (provider, modelId) {
      const pin = pinnedEntryOf(provider)
      if (pin === undefined) return origList(provider, modelId)
      // 判据必须与上面 getAvailableAccount 的包装**逐条对齐**（本体
      // `vendor/lib/account-pool.js:2331` 的 listAvailableCredentials 也是
      // enabled + modelRateLimits 双判据）。只判 enabled 的话，钉了一个在
      // 当前模型上限流未到期的号，getAvailableAccount 返回 null 而这里还
      // 返回它，两个入口对同一请求给出相反答案。
      if (pin.enabled === false) return []
      if (modelId && pin.modelRateLimits) {
        const resetAt = pin.modelRateLimits[modelId]
        if (resetAt !== undefined && resetAt !== 0 && Date.now() < resetAt) return []
      }
      try {
        const resolved = await ctx.credentials.resolve(pin.credentialRef)
        if (!resolved) return []
        return [{ entry: pin, credential: JSON.parse(resolved.value) }]
      } catch {
        return []
      }
    }
  }

  _absorbModels(json) {
    const rows = Array.isArray(json?.data) ? json.data : []
    this.models = []
    this.ownerOf.clear()
    this.modelMeta.clear()
    for (const m of rows) {
      const id = String(m?.id ?? '')
      if (!id) continue
      this.models.push(id)
      const owner = String(m?.owned_by ?? '')
      if (owner) this.ownerOf.set(id, owner)
      // 能力元数据：`modelsPayload` 已经把 `resolveModelInfo` 的窗口/预算/模态/
      // 档位并进 data 项了，这里只挑 magpie 用得到的四个。
      const meta = {}
      if (Number.isFinite(m?.context_window) && m.context_window > 0) meta.context = m.context_window
      if (Number.isFinite(m?.max_tokens) && m.max_tokens > 0) meta.output = m.max_tokens
      if (Array.isArray(m?.input) && m.input.length > 0) meta.input = [...m.input]
      // ⚠️ 档位数组**必须留住**：magpie 的推理强度下拉只认插件给的档位列表，
      //    把它压成一个布尔就等于告诉它「这模型会思考，但一档都挑不了」——
      //    2026-10-31 用户报的「使用插件模型无法修改推理强度」正是这里丢的数组。
      if (m?.reasoning !== undefined) {
        const efforts = Array.isArray(m.reasoning?.openai_efforts)
          ? m.reasoning.openai_efforts.filter((e) => typeof e === 'string' && e !== '')
          : []
        meta.reasoning = Array.isArray(m.reasoning?.openai_efforts) ? efforts.length > 0 : true
        if (efforts.length > 0) meta.efforts = efforts
      }
      if (Object.keys(meta).length > 0) this.modelMeta.set(id, meta)
    }
  }

  /**
   * 刷新模型目录（本体有新账号登录后会变）。
   *
   * 直连模式：从 `ctx.llm` 现采，不再打 `/v1/models` HTTP。
   * 采集器 `collectGatewayModels` 对每个 provider 单独兜错 —— 未登录的家跳过，
   * 不会因为一家失败就整份目录报错。
   */
  async refreshModels() {
    await this.start()
    this._absorbModels(await modelsPayload(this.llm))
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
        // 少数渠道本机没登录过 / 路由组没有自己的目录时 `model.list` 会失败，是正常的
        this.log(`拉 ${p} 的全量目录失败：${e?.message ?? e}`)
      }
    }

    // 全量目录只有 id / name / disabled / dead —— **上下文窗口、模态、思考档位
    // 都在 `resolveModelInfo` 里**，`model.list` 一个都不给。实测（2026-10-29）：
    // 895 条里有 41% 能解析出窗口，而 `listModels` 那条路 53 条里 0 条有窗口。
    //
    // 成本可忽略：`resolveModelInfo` 读的是适配器**已缓存**的目录（`model.list`
    // 刚拉过同一份），不产生网络请求。实测 300 个模型 8 ms 全部成功。
    // 逐模型 catch：解析失败就是那条没有能力字段，全量目录照常返回。
    if (typeof this.llm?.resolveModelInfo === 'function') {
      await Promise.all(out.map(async (row) => {
        const at = row.id.indexOf('/')
        const provider = row.id.slice(0, at)
        const model = row.id.slice(at + 1)
        try {
          const info = await this.llm.resolveModelInfo(provider, model)
          // ⚠️ **合并**而不是整体替换：两条腿的模型 id 形态相同（都是
          //    `${provider}/${model}`，见 vendor 的 `toOpenAiModelId`），所以
          //    这里会覆盖实时腿写的那份。而两条腿的字段来源不完全一样 ——
          //    输入模态那条：实时腿优先用适配器自己 `listModels` 的 `input`，
          //    这条腿只有 `resolveModelInfo` 的 `inputModalities`。整体替换会
          //    把「能发图片」这个声明抹掉，症状是照着模型列表选了能看图的模型
          //    却传不了图。
          const meta = { ...(this.modelMeta.get(row.id) ?? {}) }
          const window = info?.context?.contextWindow
          if (typeof window === 'number' && window > 0) meta.context = window
          const maxTokens = info?.defaultMaxTokens
          if (typeof maxTokens === 'number' && maxTokens > 0) meta.output = maxTokens
          if (Array.isArray(info?.inputModalities) && info.inputModalities.length > 0) meta.input = [...info.inputModalities]
          if (Array.isArray(info?.reasoning?.efforts) && info.reasoning.efforts.length > 0) meta.reasoning = true
          // 这条腿直接调 resolveModelInfo（没走 modelsPayload 那趟），档位要多翻一次；
          // 不翻就只有布尔、没有可挑的档位。
          const efforts = openAiEfforts(info)
          if (efforts.length > 0) {
            meta.reasoning = true
            meta.efforts = efforts
          }
          if (Object.keys(meta).length > 0) this.modelMeta.set(row.id, meta)
        } catch {
          // 这个模型没有能力声明（或 provider 没加载）：全量目录照常，它自己少字段
        }
      }))
    }

    this.fullCatalog = out
    this.fullCatalogAt = new Date().toISOString()
    return out
  }

  /**
   * 处理一次 OpenAI 协议请求 —— **进程内**直连本体 llm 服务。
   *
   * @param {string} pathname  `/v1/chat/completions` 或 `/v1/models`
   * @param {RequestInit} init `body` 是 JSON 字符串或 Uint8Array
   * @returns {Promise<Response>} 流式时是 `text/event-stream`
   */
  async forward(pathname, init) {
    await this.start()
    const path = String(pathname ?? '').replace(/^\/v1(?=\/|$)/, '') || '/'

    if (path === '/models' || path === '/models/') {
      try {
        return jsonResponse(200, await modelsPayload(this.llm))
      } catch (error) {
        return errorResponse(error)
      }
    }

    if (path === '/chat/completions' || path === '/chat/completions/') {
      let body
      try {
        body = parseJsonBody(init?.body)
      } catch (error) {
        return jsonResponse(400, {
          error: { message: `请求体不是合法 JSON：${error?.message ?? error}`, type: 'invalid_request_error' },
        })
      }
      try {
        return await chatCompletion(this.llm, body, init?.signal, this.attachments)
      } catch (error) {
        return errorResponse(error)
      }
    }

    return jsonResponse(404, {
      error: { message: `magpie-jet-hub: 不支持的路径 ${pathname}`, type: 'invalid_request_error', code: 'unsupported_path' },
    })
  }
}

/** 把 `RequestInit.body` 解成对象（字符串 / Uint8Array / 已是对象三种都收）。 */
function parseJsonBody(raw) {
  if (raw === undefined || raw === null) return {}
  if (typeof raw === 'object' && !(raw instanceof Uint8Array) && !(raw instanceof ArrayBuffer)) return raw
  const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
  if (text.trim() === '') return {}
  return JSON.parse(text)
}
