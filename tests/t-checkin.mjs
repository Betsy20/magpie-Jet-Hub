// auth.checkin 契约测试。
//
// ⚠️ 签到是**有副作用**的真操作（会真的给账号领积分）。所以这里分两层：
//   1) 纯映射层（toMagpieCheckin）：所有 kind → outcome 的对应关系，不联网；
//   2) 真调用层：只打一个**明确不支持签到**的渠道（workbuddy），
//      它固定回 `ineligible`（能力缺失，不是故障），不会给任何账号产生副作用。
import * as mod from '../src/plugin.mjs'

// ⚠️ 本文件会真起容器，必须隔离（否则 `resolveHome(undefined)` 退回 `homedir()`，
// 把本体 `DSH_HOME` 指向用户真实凭据目录 —— 实测会真实轮换 access_token）。
// 三层隔离与踩过的坑写在 `tests/_iso.mjs` 文件头。
import { isolate } from './_iso.mjs'

const iso = isolate()

const problems = []
const ok = (cond, msg) => { if (!cond) problems.push(msg) }

// ---- 1) 映射层 -------------------------------------------------------------
const map = mod.PLUGINS[0][1]
const probe = await map({}, iso.options())
const toMagpieCheckin = probe._internal?.toMagpieCheckin
ok(typeof toMagpieCheckin === 'function', '_internal 应导出 toMagpieCheckin')

if (typeof toMagpieCheckin === 'function') {
  const cases = [
    [{ kind: 'claimed', credit: 100 }, 'claimed', 100],
    [{ kind: 'already-claimed' }, 'done', undefined],
    [{ kind: 'inactive', message: '活动未开启' }, 'inactive', undefined],
    [{ kind: 'exhausted' }, 'done', undefined],
    [{ kind: 'failed', message: '网络错误' }, 'failed', undefined],
    [{ kind: 'captcha', message: '需要验证码' }, 'captcha', undefined],
    [{ kind: '某种没见过的 kind' }, 'failed', undefined],
  ]
  for (const [outcome, want, wantCredit] of cases) {
    const got = toMagpieCheckin({ accountId: 'a', outcome })
    ok(got.outcome === want, `kind=${outcome.kind} 应映射为 ${want}，实际 ${got.outcome}`)
    if (wantCredit !== undefined) ok(got.credit === wantCredit, `kind=${outcome.kind} 应带 credit=${wantCredit}，实际 ${got.credit}`)
    // magpie 只认这六种 outcome
    ok(
      ['claimed', 'done', 'ineligible', 'inactive', 'captcha', 'failed'].includes(got.outcome),
      `outcome 越界：${got.outcome}`,
    )
  }
  // ── 「这家没有签到功能」必须报 ineligible，不能报 failed ──
  //
  // 2026-11-01 用户报「部分供应商签到失败」：magpie 把 `failed` 画成红旗，
  // 而实测那份 plugin-checkin.json（当天 88 条记录）里本插件 failed 44 条，
  // 其中 38 条是「本体明确说这家没有签到」，剩下 6 条是真失败（HTTP 401 凭据过期）。
  // ⚠️ 这些数字是**当天快照**，会随账号增减漂；结论（大多数不是故障）不随它变。
  // 下面四条文案逐字取自那份文件（也是 vendor 的 claimUnavailableReason）。
  const unsupported = [
    'unsupported provider: modelscope',
    'Cline 不支持每日签到（其后端没有签到接口）',
    '超级麦吉暂不支持每日签到（本插件未接该端点）',
    'WorkBuddy 国际版不支持每日签到（其后端没有签到接口）',
    'Raccoon Work 不支持每日签到（每日积分由服务端自动发放；登录奖励请在「新手任务」中领取）',
    // ⚠️ 这条刻意**只含「不支持每日签到」一个关键词**：其余几条都同时命中两个模式，
    // 删掉其中一条正则测试仍然绿。留一条单一依赖的，每个模式才都有人守。
    '某渠道不支持每日签到',
  ]
  for (const msg of unsupported) {
    const got = toMagpieCheckin({ accountId: 'a', outcome: { kind: 'failed', message: msg } })
    ok(got.outcome === 'ineligible', `不支持签到的文案应映射为 ineligible，实际 ${got.outcome}（${msg.slice(0, 24)}…）`)
    ok(got.message === msg, 'ineligible 仍要保留原文，方便用户在控制台看到原因')
  }
  // 真失败不能被误判成 ineligible
  for (const msg of [
    '凭据已失效（HTTP 401）：invalid access token',
    '账户信息查询失败：HTTP 401：APIG.0301 Incorrect IAM authentication information: Unauthorized',
    'fetch failed',
  ]) {
    const got = toMagpieCheckin({ accountId: 'a', outcome: { kind: 'failed', message: msg } })
    ok(got.outcome === 'failed', `真失败仍应是 failed，实际 ${got.outcome}（${msg.slice(0, 24)}…）`)
  }
  // credit 为 0 / 负数不该当成"领到了积分"
  const zero = toMagpieCheckin({ outcome: { kind: 'claimed', credit: 0 } })
  ok(zero.credit === undefined, 'credit=0 时不该带 credit 字段')
}

// ---- 2) 契约层：只有上游真支持签到的渠道才声明 checkin ---------------------
//
// magpie 的签到开关**只看插件有没有声明 `auth.checkin`**
// （宿主 host.js 的 `checkin: typeof a.auth.checkin === "function"`，
// Go 侧 `Provider.Checkin` 再决定 Settings 显不显示）。
// 给「后端根本没有签到接口」的渠道也声明，就等于给用户画一个点了必然失败的开关 ——
// 2026-11-01 用户报「部分供应商签到失败」，当天快照里 44 条 failed 有 38 条是这么来的。
//
// 期望值直接从**上游的能力表**算（不抄名单）：表里有 `claim` 就算支持；
// 另外三家走上游的特例分支（qoder / qodercn / zcode），表里没有但确实支持。
{
  const { createProviderCredits, creditsOf } = await import('../vendor/lib/provider-credits.js')
  const table = createProviderCredits({})
  const SPECIAL = new Set(['qoder', 'qodercn', 'zcode'])

  // 守卫：这三家一旦**开始**出现在表里，说明上游把它们挪出了特例分支，
  // 插件侧这份例外集就该删掉。让它变红而不是静默过时。
  for (const id of SPECIAL) {
    const impl = creditsOf(table, id)
    ok(
      typeof impl?.claim !== 'function',
      `${id} 已经在 vendor 能力表里有 claim 了 —— 上游把它挪出了特例分支，src/plugin.mjs 的 SPECIAL_CLAIM_PROVIDERS 可以删掉这家`,
    )
  }

  // 护栏一：上游 `credits.claimAll` 的「支持」路径必须**只有三条**
  // （isQoderFamily / ZCODE.id / creditsOf(...).claim）。出现第四条就说明上游新加了
  // 特例分支，插件这份 SPECIAL 集与表判据可能已经不完整 —— 让测试红，而不是静默漏一家。
  {
    const { readFileSync } = await import('node:fs')
    const rpc = readFileSync(new URL('../vendor/lib/jet-hub-rpc.js', import.meta.url), 'utf8')
    /**
     * 从 `from` 往后找到该 case 块的「配对 `}` 之后」的位置。
     * 跳过行注释、块注释与三种引号（内部还处理反斜杠转义），再数花括号配平。
     * 找不到（不配平）返回 -1，调用方会退化成「截到文件尾」。
     */
    function blockEnd(src, from) {
      const open = src.indexOf('{', from)
      if (open < 0) return -1
      let depth = 0
      for (let i = open; i < src.length; i += 1) {
        const c = src[i]
        if (c === '/' && src[i + 1] === '/') {
          i = src.indexOf(String.fromCharCode(10), i)
          if (i < 0) return -1
          continue
        }
        if (c === '/' && src[i + 1] === '*') {
          i = src.indexOf('*/', i + 2) + 1
          if (i < 1) return -1
          continue
        }
        if (c === '"' || c === "'" || c === '`') {
          const q = c
          for (i += 1; i < src.length; i += 1) {
            if (src[i] === '\\') { i += 1; continue }
            if (src[i] === q) break
          }
          continue
        }
        if (c === '{') depth += 1
        else if (c === '}') {
          depth -= 1
          if (depth === 0) return i + 1
        }
      }
      return -1
    }
    const HEAD = "case 'credits.claimAll'"
    const a = rpc.indexOf(HEAD)
    ok(a >= 0, 'vendor 里能找到 credits.claimAll 的 case')
    // 终点用**同级缩进的 case**（12 空格）。三个坑都在这里：
    //   ① 用 `case '` 就会被嵌套 switch 里的 `case 'none':` 截断，后面的分支根本没进段；
    //   ② claimAll 是末位 case 时没有后继，必须截到文件尾而不是拿 `a + 20000` 兜底
    //      （那样会读到后面的无关代码，把别的 provider 特判算进来）；
    //   ③ 只删「整行 //」挡不住行尾注释（`foo() // 旧：if (req.provider === OLD.id)`）。
    // 终点取两个候选里的**较小**值：
    //   ① 同级缩进的 `case '`（12 空格）—— 嵌套 switch 的 case 缩进更深，不会误截；
    //   ② `case` 块的括号配平终点 —— claimAll 若是 switch 的末位 case，①拿不到，
    //      只靠①就会截到文件尾，把 switch 之外的 11 条别的 provider 特判也算进来（假红）。
    const b = rpc.indexOf("\n            case '", a + HEAD.length)
    const ends = [b, blockEnd(rpc, a)].filter((x) => x > a)
    const raw = rpc.slice(a, ends.length > 0 ? Math.min(...ends) : rpc.length)
    const seg = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(String.fromCharCode(10))
      .filter((l) => !l.trimStart().startsWith('//'))
      .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
      .join(String.fromCharCode(10))
    // 上游两种写法都有：`=== ZCODE.id`（:5842）与 `=== 'magicrew'`（:3211/:3327），
    // 只认前一种会让「第四条特判用了字符串字面量」这条变异假绿。
    // 上游有四种真实写法，缺一种就是假绿：
    //   ① `=== ZCODE.id`  ② `=== 'magicrew'`（字符串字面量）
    //   ③ `=== CODELY_PROVIDER_ID`（裸常量，`vendor/lib/jet-hub-rpc.js` 里就有这种）
    //   ④ `['lobsterai'].includes(req.provider)`（列表写法）
    const branches = [
      ...seg.matchAll(/req\.provider\s*===\s*(?:([A-Z_$][\w$]*)(?:\.id)?|'([^']+)'|"([^"]+)")/g),
    ].map((m) => m[1] ?? m[2] ?? m[3])
    for (const ls of seg.matchAll(/\[([^\]]*)\]\s*\.includes\(\s*req\.provider\s*\)/g)) {
      for (const q of (ls[1] ?? '').matchAll(/'([^']+)'|"([^"]+)"/g)) branches.push(q[1] ?? q[2])
    }
    ok(
      // 大小写不敏感：等价写法 `=== ZCODE.id` 与 `=== 'zcode'` 都该放行（否则纯重构假红），
      // 但 `NEWSENSE` / `'lobsterai'` 这种**真的第四条**仍要红。
      branches.length <= 1 && branches.every((n) => n.toLowerCase() === 'zcode'),
      `claimAll 里的「按 provider 特判」只应有 ZCODE 一条，实际：${branches.join(', ') || '无'}`,
    )
    ok(/isQoderFamily\(req\.provider\)/.test(seg), 'claimAll 里的 Qoder 家族特例还在（isQoderFamily）')
    ok(/creditsOf\(credits, req\.provider\)/.test(seg), 'claimAll 里的能力表判据还在（creditsOf(...).claim）')
  }

  // 护栏二：**deps 不影响能力判定**。插件用 `createProviderCredits({})`（空注入），
  // 若某家的 `claim` 是挂在注入上的，空表就会把它判成「不支持」而生产环境其实支持。
  {
    // 生产代码注入的 deps 见 vendor/lib/jet-hub-rpc.js 的 `createProviderCredits({...})`。
    // 七个键全给上，否则「某家的 claim 依赖某个没注入的 dep」这种形状只在恰好用那一个
    // 键做变异时才红（2026-11-01 二审：只注入 minimaxIntlFetchFor 时，deps.loomy 版假绿）。
    const stub = () => fetch
    const fakeDeps = {
      loomy: { resolve: async () => undefined },
      raccoon: { resolve: async () => undefined },
      zcode: { claimDailyFor: async () => [] },
      lobsteraiClientVersion: () => '0.0.0-test',
      minimaxXff: () => '',
      geminiFetchFor: stub,
      minimaxIntlFetchFor: stub,
    }
    const withDeps = createProviderCredits(fakeDeps)
    const keySet = (t) => Object.keys(t).sort().join(',')
    const claimSet = (t) => Object.keys(t).filter((k) => typeof t[k]?.claim === 'function').sort().join(',')
    ok(keySet(table) === keySet(withDeps), '空注入与带注入构造的能力表键集不同 —— 空表不可信')
    ok(claimSet(table) === claimSet(withDeps), '空注入与带注入构造的「有 claim」集合不同 —— 空表不可信')

    // 盯住上游：生产注入的 deps 键集若变了，上面的 fakeDeps 就漏了新键（又是假绿）。
    {
      const { readFileSync } = await import('node:fs')
      const rpc = readFileSync(new URL('../vendor/lib/jet-hub-rpc.js', import.meta.url), 'utf8')
      const m = rpc.match(/createProviderCredits\(\{([\s\S]*?)\}\)/)
      ok(m !== null, '能在 vendor 里找到 createProviderCredits({...}) 的注入点')
      const keys = [...(m?.[1] ?? '').matchAll(/^\s*([A-Za-z_$][\w$]*)\s*[:,]/gm)].map((x) => x[1])
      const covered = Object.keys(fakeDeps).filter((k) => keys.includes(k))
      ok(
        covered.length === keys.length,
        `测试没跟上上游的注入键：多出 ${keys.filter((k) => !(k in fakeDeps)).join(', ') || '无'}`,
      )
    }
  }

  const want = new Set()
  for (const [id, fn] of mod.PLUGINS) {
    const plugin = await fn({}, iso.options())
    const p = plugin.auth.provider.replace(/^jet-hub-/, '')
    const expected = SPECIAL.has(p) || typeof creditsOf(table, p)?.claim === 'function'
    const got = typeof plugin.auth.checkin === 'function'
    ok(got === expected, `${id}: 上游能力表说${expected ? '支持' : '不支持'}签到，插件却${got ? '声明了' : '没声明'}`)
    if (got) want.add(id)
  }
  console.log(`  声明了 checkin 的：${want.size} 家；未声明：${mod.PLUGINS.length - want.size} 家`)

  // 反向固定几个代表：文档与答复里点过名的，别让判据整体漂掉
  const unsupported = ['jet-hub-cline', 'jet-hub-workbuddy', 'jet-hub-magicrew', 'jet-hub-raccoon', 'jet-hub-modelscope', 'jet-hub-opencode', 'jet-hub-officeace', 'jet-hub-accio', 'jet-hub-gemini']
  for (const id of unsupported) {
    const [, fn] = mod.PLUGINS.find(([i]) => i === id)
    const plugin = await fn({}, iso.options())
    ok(typeof plugin.auth.checkin !== 'function', `${id}: 上游没有签到实现，不该声明 auth.checkin（否则 magpie 会画一个必然失败的开关）`)
  }
  const supported = ['jet-hub-trae', 'jet-hub-qoder', 'jet-hub-qodercn', 'jet-hub-zcode', 'jet-hub-lobsterai', 'jet-hub-loomy']
  for (const id of supported) {
    const [, fn] = mod.PLUGINS.find(([i]) => i === id)
    const plugin = await fn({}, iso.options())
    ok(typeof plugin.auth.checkin === 'function', `${id}: 上游支持签到，必须声明 auth.checkin`)
  }
}

// ---- 3) 不支持的渠道连方法都不该有 -----------------------------------------
//
// ⚠️ 这一节**不能**去调 `workbuddy.auth.checkin(...)`：`4fd1677` 起 workbuddy
// 不声明 checkin（上游没有签到实现），方法不存在 ⇒ 调用是 `TypeError`。
// 而这行带 `await`、外层又是顶层 `if (live())`，于是整个文件会**崩溃**而不是报断言
// —— 2026-11-01 补审实测：`workbuddy: checkin= undefined`，`JET_HUB_LIVE=1` 直接抛。
//
// 现在只断言「方法在不在」，不发任何 RPC、不需要真凭据，所以不再需要 opt-in ——
// 也就**不要**再调 `skipLive()`：那会让 `scripts/test-all.mjs` 的汇总行永远挂着
// 「设 JET_HUB_LIVE=1 才会跑」，而这一节再也不会因为那个变量而跑（假承诺）。
{
  const [, wb] = mod.PLUGINS.find(([i]) => i === 'jet-hub-workbuddy')
  const wbPlugin = await wb({}, iso.options())
  ok(typeof wbPlugin.auth.checkin !== 'function', 'workbuddy 不该有 auth.checkin（上游没有签到实现）')
  // 真支持签到的家必须有。这里只查形状、不真调 —— 真调会真的给账号领积分。
  const [, tr] = mod.PLUGINS.find(([i]) => i === 'jet-hub-trae')
  const trPlugin = await tr({}, iso.options())
  ok(typeof trPlugin.auth.checkin === 'function', 'trae 必须有 auth.checkin')
  console.log('  · 不真调 checkin：那会真的给账号领积分，需要时由用户在 magpie 里点')
}

if (problems.length) {
  console.log('✗ ' + problems.length + ' 处不符：')
  for (const p of problems) console.log('  ' + p)
  process.exit(1)
}
console.log('✓ checkin 映射与契约均正确')
process.exit(0)
