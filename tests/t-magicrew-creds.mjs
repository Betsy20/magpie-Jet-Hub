/**
 * 「超级麦吉登录凭据读不到」这条路的回归测试。
 *
 * 背景（2026-10-30 真机报障）：用户在自己的 Edge 里登录了 www.letsmagic.cn，
 * 插件却一直提示「请在浏览器中完成 超级麦吉 登录」，等满 4 分钟才失败。根因是
 * **凭据不在 localStorage 里，而在 IndexedDB 的 `magic-global/user` 库里**，
 * 而插件的两条腿（CDP 实时读 / 磁盘 leveldb 读）都只认 localStorage。
 *
 * 这里守住的点：
 *
 * 1. **CDP 表达式必须同时读 localStorage 与 IndexedDB**，且 IndexedDB 那条腿
 *    必须把 in-line key 的记录解包（`user` store 的 keyPath 是记录里的 `key` 字段，
 *    `get()` 拿到的是 `{ key, value }` 包装，不是裸值）。
 * 2. **`Runtime.evaluate` 必须传 `awaitPromise: true`**：表达式是 async IIFE，
 *    不传它拿到的是未 settle 的 Promise —— `returnByValue` 下变成 `{}`，
 *    与「用户还没登完」完全同形，诊断上看不出来。
 * 3. **磁盘腿必须按站点精确读 IndexedDB 目录**，且不能全扫：本机 Edge 有 150+ 个
 *    站点目录、1.7 GB，全扫直接 `RangeError: Invalid string length`。
 * 4. **IndexedDB 的记录形态与 localStorage 完全不同**：JWT 是 UTF-16LE
 *    （`e\0y\0J\0…`）、组织码是单字节 latin1 且不带 JSON 包装
 *    （`magic_organization_code"<长度字节><值>"`）。用 localStorage 那套裸 JSON
 *    正则去匹配，一条都匹配不上。
 * 5. **缺组织码一律不产出凭据**（不造假）：空 org 配 jwt 在上游是 HTTP 200 +
 *    `code:403`，比「读不到」难查得多。
 *
 * 跑法：`node tests/t-magicrew-creds.mjs`（不联网、不读真实浏览器目录）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const LOGIN_SRC = path.join(ROOT, 'vendor', 'lib', 'magicrew-browser-login.js')
const LOCAL_SRC = path.join(ROOT, 'vendor', 'lib', 'magicrew-local-browser.js')

let total = 0
let bad = 0
function ok(cond, message) {
  total++
  if (cond) {
    console.log(`  ✓ ${message}`)
    return true
  }
  bad++
  console.log(`  ✗ ${message}`)
  return false
}

const loginSrc = fs.readFileSync(LOGIN_SRC, 'utf8').replace(/\r\n/g, '\n')
const localSrc = fs.readFileSync(LOCAL_SRC, 'utf8').replace(/\r\n/g, '\n')

// ── 1. CDP 表达式必须两条腿都读 ────────────────────────────────────────────
console.log('\n1. CDP 表达式：localStorage + IndexedDB 双读')
{
  const start = loginSrc.indexOf('const CDP_CREDENTIAL_EXPRESSION = ')
  ok(start !== -1, '找得到 CDP_CREDENTIAL_EXPRESSION')
  const end = loginSrc.indexOf('`;', start)
  const expr = start === -1 || end === -1 ? '' : loginSrc.slice(start, end)

  ok(expr.includes('localStorage.getItem'), '表达式仍读 localStorage（老路径不能丢）')
  ok(expr.includes('indexedDB.open'), '表达式会打开 IndexedDB')
  ok(expr.includes("'magic-global'"), "打开的是 magic-global 库（实测凭据就在这里）")
  ok(expr.includes('user'), '读的是 user store')
  // in-line key 解包：拿到 { key, value } 包装后必须取 .value
  ok(/record\.value|result\.value|\.value\b/.test(expr), '解包 in-line key 记录（取 .value）')
  ok(expr.trimStart().startsWith('(async') || expr.includes('(async () =>'), '表达式是 async IIFE')
  ok(expr.includes('organizations'), '同时读 organizations（组织码在那条记录里）')

  // 先列后开：库不存在时 open() 会凭空新建一个空库，而我们只是来读的。
  ok(expr.includes('indexedDB.databases'), '先用 indexedDB.databases() 列库，不直接 open')
  ok(
    expr.indexOf('indexedDB.databases') !== -1 &&
      expr.indexOf('indexedDB.databases') < expr.indexOf('indexedDB.open'),
    'databases() 必须排在 open() 之前',
  )
  ok(expr.includes("entry.name === 'magic-global'"), '列库时按库名精确比对 magic-global')
  ok(expr.includes('out.ie') && expr.includes('out.id'), '两个失败原因字段都写进 out（ie / id）')
}

// ── 2. Runtime.evaluate 必须 awaitPromise ──────────────────────────────────
console.log('\n2. Runtime.evaluate 必须 awaitPromise: true')
{
  const at = loginSrc.indexOf("cdp.send('Runtime.evaluate'")
  ok(at !== -1, '找得到 Runtime.evaluate 调用')
  const call = at === -1 ? '' : loginSrc.slice(at, at + 400)
  ok(call.includes('awaitPromise: true'), '传了 awaitPromise: true（否则 async IIFE 只回 {}）')
  ok(call.includes('returnByValue: true'), '传了 returnByValue: true')
  ok(call.includes('attachedId'), '带了 sessionId（否则命令落在浏览器端点上报 -32601）')
}

// ── 3. 解析函数必须两条腿都认 ──────────────────────────────────────────────
console.log('\n3. parseEvaluatedCredential 两条腿都认')
{
  const start = loginSrc.indexOf('function parseEvaluatedCredential(')
  const end = loginSrc.indexOf('\n}', loginSrc.indexOf('return pickCredential(parsed.ia', start))
  const body = start === -1 ? '' : loginSrc.slice(start, end)
  ok(body.includes('pickCredential(parsed.a'), 'localStorage 腿：parsed.a / parsed.o / parsed.t')
  ok(body.includes('parsed.ia'), 'IndexedDB 腿：parsed.ia（jwt）')
  ok(body.includes('parsed.io'), 'IndexedDB 腿：parsed.io（organizations）')
  ok(body.includes('organizationFromIndexedDb'), '组织码走 organizationFromIndexedDb()')
  ok(!/parsed\.n\s*===\s*0[\s\S]{0,40}return undefined/.test(body), '不再用 parsed.n === 0 早退（n 只数 localStorage）')
}

// ── 4. 组织码三字段都要认 ──────────────────────────────────────────────────
console.log('\n4. organizationFromIndexedDb 认三个字段')
{
  const start = loginSrc.indexOf('function organizationFromIndexedDb(')
  const end = loginSrc.indexOf('\n}', start)
  const body = start === -1 ? '' : loginSrc.slice(start, end)
  for (const key of ['magic_organization_code', 'teamshare_organization_code', 'third_platform_organization_code']) {
    ok(body.includes(key), `认 ${key}`)
  }
}

// ── 5. 磁盘腿：按站点精确定位 + 两种记录形态 ───────────────────────────────
console.log('\n5. 磁盘腿：按站点定位 IndexedDB 目录')
{
  ok(localSrc.includes('indexedDbTextFor'), '有 indexedDbTextFor()')
  ok(localSrc.includes("'IndexedDB'"), '扫的是 IndexedDB 目录')
  ok(/indexeddb\\\.\(leveldb\|blob\)|indexeddb\.\(leveldb\|blob\)|\.indexeddb\./.test(localSrc), '按 `<origin>.indexeddb.leveldb` 目录名匹配站点')
  ok(localSrc.includes('wanted.includes'), '只读目标站点那一个目录（不全扫）')
  // 全扫会 RangeError：注释里必须写明这条约束
  ok(/RangeError/.test(localSrc) && /1\.7\s*GB/.test(localSrc), '注释写明了「不能全扫」的理由')
  ok(localSrc.includes('withFileTypes: true'), '用 withFileTypes 才能下钻子目录')
}

console.log('\n6. 磁盘腿：IndexedDB 记录形态（UTF-16LE JWT + latin1 组织码）')
{
  ok(localSrc.includes('idbCredentialsIn'), '有 idbCredentialsIn()')
  ok(localSrc.includes('IDB_JWT_HEAD'), 'JWT 用固定开头 needle 扫（不写正则）')
  // 关键：needle 必须是 UTF-16LE 形态 e\0y\0J\0
  const headAt = localSrc.indexOf('const IDB_JWT_HEAD = ')
  const headLine = headAt === -1 ? '' : localSrc.slice(headAt, localSrc.indexOf('\n', headAt))
  ok(/\\u0000/.test(headLine) || headLine.includes('\\0'), 'JWT needle 是 UTF-16LE（字符间带 NUL）')
  ok(localSrc.includes('utf16AsciiAt'), '有 utf16AsciiAt()（解 UTF-16LE 段）')
  ok(localSrc.includes('IDB_ORGANIZATION_KEYS'), '组织码字段名单独成表')
  ok(localSrc.includes('charCodeAt(start)'), '按长度字节取组织码值')
  ok(!/\u0000/.test(localSrc), '源码里没有裸 NUL 字节（会让 git 当二进制、edit 拒写）')
}

// ── 7. 不造假：缺组织码不产出 ─────────────────────────────────────────────
console.log('\n7. 缺组织码一律不产出凭据')
{
  const start = loginSrc.indexOf('function pickCredential(')
  const end = loginSrc.indexOf('\n}', start)
  const body = start === -1 ? '' : loginSrc.slice(start, end)
  ok(body.includes('isJwtShaped'), '校验 JWT 形状')
  ok(/org\.length === 0[\s\S]{0,80}return undefined/.test(body), '组织码为空 ⇒ 返回 undefined')
  ok(!/organizationCode:\s*''/.test(body), '绝不返回空组织码')
}

// ── 8. 行为级验证：真的能解出凭据 ──────────────────────────────────────────
console.log('\n8. 行为级：idbCredentialsIn 真能解出 jwt × org')
{
  const mod = await import(pathToFileURL(LOCAL_SRC).href)
  ok(typeof mod.idbCredentialsIn === 'function', 'idbCredentialsIn 是导出的函数')

  // 造一段仿 IndexedDB 字节：JWT 用 UTF-16LE、组织码用 latin1 长度前缀
  const jwt = `eyJ${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(20)}`
  const org = 'evro2209i6j0'
  const u16 = [...jwt].map((ch) => `${ch}\u0000`).join('')
  const orgRec = `magic_organization_code"${String.fromCharCode(org.length)}${org}"`
  const text = `\u0002${u16}\u0000\u0000 garbage ${orgRec}`

  const found = mod.idbCredentialsIn(text)
  ok(found.length === 1, `解出 1 条（实际 ${found.length}）`)
  ok(found[0]?.jwt === jwt, 'jwt 解对了（NUL 已剥、控制字节已跳过）')
  ok(found[0]?.organizationCode === org, '组织码解对了（按长度字节取）')

  // 只有 jwt 没有 org ⇒ 一条都不产出
  ok(mod.idbCredentialsIn(`\u0002${u16}`).length === 0, '只有 jwt 没有组织码 ⇒ 不产出（不造假）')

  // 组织码在前、jwt 在后 ⇒ 仍然配上（find 不到「之后」就退回第一个）
  ok(mod.idbCredentialsIn(`${orgRec} ${u16}`).length === 1, '组织码在前也能配上')
}

// ── 9. 行为级：CDP 表达式「先列后开」，库不存在时绝不 open() ────────────────
console.log('\n9. 行为级：库不存在时不许 open()（open 会凭空新建空库）')
{
  const start = loginSrc.indexOf('const CDP_CREDENTIAL_EXPRESSION = ')
  const end = start === -1 ? -1 : loginSrc.indexOf('`;', start)
  // 源码里那一段是「模板字符串字面量」，先求值成真正的表达式文本
  const literal = start === -1 || end === -1 ? '' : loginSrc.slice(start + 'const CDP_CREDENTIAL_EXPRESSION = '.length, end + 1)
  let expression = ''
  try {
    expression = new Function(`return ${literal}`)()
  } catch (error) {
    ok(false, `CDP 表达式能被求值（${String(error)}）`)
  }
  ok(expression.includes('(async'), '表达式求值出来是 async IIFE')

  /** 造一个假页面环境：localStorage 三条界面配置 + 可编排的 indexedDB。 */
  const fakeEnv = ({ databases, db }) => {
    const calls = { open: 0, databases: 0 }
    const localStorage = {
      length: 3,
      getItem: (k) => ({ fontScale: '1.2', i18n: 'zh_CN', theme: 'light' })[k] ?? null,
    }
    const indexedDB = {
      ...(databases === 'absent'
        ? {}
        : {
            databases: async () => {
              calls.databases++
              if (databases instanceof Error) throw databases
              return databases
            },
          }),
      open: () => {
        calls.open++
        const req = {}
        setTimeout(() => {
          req.result = db
          req.onsuccess?.()
        }, 0)
        return req
      },
    }
    return { localStorage, indexedDB, calls }
  }

  // ① 没有 magic-global 这个库 ⇒ 绝不 open()，且把原因写进 ie
  {
    const env = fakeEnv({ databases: [{ name: 'MAGIC:chat-db-schema/default' }], db: null })
    const run = new Function('localStorage', 'indexedDB', `return ${expression}`)
    const out = JSON.parse(await run(env.localStorage, env.indexedDB))
    ok(env.calls.databases === 1, '先调了 databases()')
    ok(env.calls.open === 0, '库不存在时一次都没 open()（否则会在用户 profile 里新建空库）')
    ok(typeof out.ie === 'string' && out.ie.includes('magic-global'), 'ie 写明了「没有 magic-global 这个库」')
    ok(out.ia === null && out.io === null, '库不存在时不产出任何凭据字段')
  }

  // ② 库存在 ⇒ 正常 open() 并读 user store
  {
    const records = { authorization: { key: 'authorization', value: 'eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOjF9.c2ln' }, organizations: { key: 'organizations', value: { magic_organization_code: 'org-x' } } }
    const db = {
      objectStoreNames: { contains: (name) => name === 'user' },
      transaction: () => ({ objectStore: () => ({ get: (key) => { const req = {}; setTimeout(() => { req.result = records[key] ?? null; req.onsuccess?.() }, 0); return req } }) }),
      close: () => {},
    }
    const env = fakeEnv({ databases: [{ name: 'magic-global' }], db })
    const run = new Function('localStorage', 'indexedDB', `return ${expression}`)
    const out = JSON.parse(await run(env.localStorage, env.indexedDB))
    ok(env.calls.open === 1, '库存在时正常 open() 一次')
    ok(out.ii === 1, 'ii = 1（IndexedDB 那条腿跑成了）')
    ok(typeof out.ia === 'string' && out.ia.startsWith('eyJ'), '读到了 authorization')
    ok(out.io?.magic_organization_code === 'org-x', '读到了 organizations')
  }

  // ③ databases() 不可用（旧内核）⇒ 退回 open()，并把原因写进 id（不据此下结论）
  {
    const db = { objectStoreNames: { contains: () => false }, close: () => {} }
    const env = fakeEnv({ databases: 'absent', db })
    const run = new Function('localStorage', 'indexedDB', `return ${expression}`)
    const out = JSON.parse(await run(env.localStorage, env.indexedDB))
    ok(env.calls.open === 1, 'databases() 不可用时退回 open()（只读、不写）')
    ok(typeof out.id === 'string' && out.id.includes('databases'), 'id 写明了 databases() 不可用')
  }
}

// ── 10. 行为级：IndexedDB 报错要能从 CDP 返回值里被抽出来（note 通道） ────
console.log('\n10. 行为级：CDP 返回值里的 ie / id 要变成一句人话')
{
  // `indexedDbNoteOf` 没有 export（内部函数），从源码截段求值来测行为。
  const start = loginSrc.indexOf('function indexedDbNoteOf(')
  ok(start !== -1, '找得到 indexedDbNoteOf')
  let fn = ''
  if (start !== -1) {
    const rest = loginSrc.slice(start)
    const endAt = rest.search(/\n\}\n/)
    fn = endAt === -1 ? '' : rest.slice(0, endAt + 2)
  }
  ok(fn.length > 0, '截到了函数体')
  let noteOf
  try {
    noteOf = new Function(`${fn}; return indexedDbNoteOf`)()
  } catch (error) {
    ok(false, `函数体能求值（${String(error)}）`)
  }
  if (typeof noteOf === 'function') {
    ok(noteOf(undefined) === '', 'undefined ⇒ 空串')
    ok(noteOf('') === '', '空串 ⇒ 空串')
    ok(noteOf('不是 JSON') === '', '非 JSON ⇒ 空串（不能崩）')
    ok(noteOf('{}') === '', '空对象 ⇒ 空串（读通了没报错）')
    ok(noteOf(JSON.stringify({ ie: '库不存在' })) === '库不存在', 'ie 被抽出来')
    ok(noteOf(JSON.stringify({ id: 'databases() 不可用' })) === 'databases() 不可用', 'id 被抽出来')
    ok(
      noteOf(JSON.stringify({ ie: '库不存在', id: 'databases() 不可用' })) === '库不存在；databases() 不可用',
      'ie 与 id 都在时用「；」拼起来',
    )
    ok(noteOf(JSON.stringify({ ia: 'eyJ.x.y', ii: 1 })) === '', '读通了（有 ia）⇒ 空串，不误报')
  }
}

// ── 11. 行为级：放弃等待时，IndexedDB 那条腿的报错必须出现在诊断行里 ──────
console.log('\n11. 行为级：放弃等待的诊断行要带 IndexedDB 报错')
{
  const mod = await import(pathToFileURL(LOGIN_SRC).href)
  const logs = []
  // createMagicrewCredentialWaiter 返回的是 `async (timeoutMs) => credential|undefined` 本身
  const wait = mod.createMagicrewCredentialWaiter({
    log: (line) => logs.push(line),
    pollIntervalMs: 10,
    isStopped: () => false,
    read: () => undefined,
    readRealtime: async () => ({ note: '没有 magic-global 这个库（用户还没在这个站点登录过）' }),
    // ⚠️ 必须自己给 sleep：默认的 `chromium-session.sleep` 带 `unref()`（生产靠 HTTP
    //    server 撑着 event loop），单测里没有别的东西撑着 ⇒ 进程会在 await 处直接退出。
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
  const result = await wait(60)
  ok(result === undefined, '读不到时返回 undefined（不造假）')
  const line = logs.join('\n')
  ok(line.includes('IndexedDB 那条腿'), '诊断行里点名了 IndexedDB 那条腿')
  ok(line.includes('没有 magic-global 这个库'), '诊断行带上了具体报错原因')
}

// ── 12. 端到端：真实浏览器目录能读到（有则验，无则跳过） ───────────────────
console.log('\n12. 端到端：真实 Edge 目录（有则验，无则跳过）')
{
  const mod = await import(pathToFileURL(LOCAL_SRC).href)
  const creds = mod.readMagicrewLocalCreds('www.letsmagic.cn')
  if (creds === undefined) {
    console.log('  – 跳过（本机没登录 www.letsmagic.cn，或没有 Edge 配置）')
  } else {
    ok(typeof creds.jwt === 'string' && creds.jwt.startsWith('eyJ'), '读到 JWT')
    ok(creds.jwt.split('.').length === 3, 'JWT 是三段式')
    ok(typeof creds.organizationCode === 'string' && creds.organizationCode.length > 0, '读到组织码')
  }
}

// ── 13. 行为级：遗留的一次性 profile 目录要被回收 ─────────────────────────
console.log('\n13. 行为级：上次遗留的临时浏览器 profile 会被回收')
{
  /**
   * 背景（2026-10-31 真机实测）：`%TEMP%` 下攒了 **11 个 `magicrew-login-*` / 856 MB**。
   * 成因两条：① `ChromiumSession.dispose()` 的删除只退避 2.1 秒，Windows 上
   * `taskkill /T` 之后句柄释放没那么快；② 窗口被**用户**关掉时没有任何回调保证
   * 走到 `dispose()`。⇒ 兜底是「下次开窗前扫一遍够老的目录」。
   */
  const head = 'function collectStaleLoginProfiles('
  const at = loginSrc.indexOf(head)
  ok(at >= 0, '源码里有 collectStaleLoginProfiles')
  const end = loginSrc.indexOf('\n}\n', at)
  ok(end > at, '能切出完整函数体')
  const fnSrc = loginSrc.slice(at, end + 3)
  // 前缀常量的值（下面既用它求值函数，也用它做断言）。
  const constDecl = loginSrc.match(/const LOGIN_PROFILE_PREFIX = '([^']+)'/)?.[1]
  // 单轮上限的数值（同上）。
  const limitDecl = Number(loginSrc.match(/const STALE_COLLECT_LIMIT = (\d+)/)?.[1])
  // 保留时长的**表达式**（不是算好的毫秒数 —— 它按平台分叉，测试里要原样求值，
  // 才能保证测的是真源码的取值，而不是我这台机器上算出来的那一个数）。
  const maxAgeDecl = loginSrc.match(/const STALE_PROFILE_MAX_AGE_MS = (.+)$/m)?.[1]
  // 「够老」的时间戳必须**由源码阈值算出来**，不能写死（比如 2 小时）：
  // 阈值按平台分叉（Windows 1 小时 / POSIX 6 小时），写死会在 POSIX 上把
  // 「2 小时前的目录」判成还年轻 ⇒ §13 的 5 条断言集体变红。本机恒 Windows，
  // 仓库又没有 CI，所以这个坑会一直潜伏到别人在 Linux 上跑才炸。
  const maxAgeMs = new Function(`return ${maxAgeDecl}`)()
  /** 比阈值再老 1 小时：任何平台上都必然算「够老」。 */
  const staleAt = new Date(Date.now() - maxAgeMs - 60 * 60 * 1000)

  const fakeRoot = fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'rv-collect-'))
  try {
    // 三个目录 + 一个同名文件（「够老」= 比源码阈值再老 1 小时，见上）：
    //  · magicrew-login-old   够老 → 该删
    //  · magicrew-login-new   刚刚 → 不许删（可能正在用）
    //  · keep-me              够老 → 不是本插件前缀，不许碰
    //  · magicrew-login-file  够老 → 是文件不是目录，不许碰
    const old = path.join(fakeRoot, 'magicrew-login-old')
    const fresh = path.join(fakeRoot, 'magicrew-login-new')
    const other = path.join(fakeRoot, 'keep-me')
    const notDir = path.join(fakeRoot, 'magicrew-login-file')
    for (const d of [old, fresh, other]) fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(old, 'inside.txt'), 'x')
    fs.writeFileSync(notDir, 'x')
    for (const p of [old, other, notDir]) fs.utimesSync(p, staleAt, staleAt)

    // 不复制实现：把源码里**常量声明 + 函数**原样求值，只把 tmpdir 换成假根。
    // ⚠ 常量声明必须一起带上 —— 函数体引用 `LOGIN_PROFILE_PREFIX` 与
    // `STALE_COLLECT_LIMIT`，只塞函数会 ReferenceError（这正是「抽成常量」的连带后果）。
    const constSrc = `const LOGIN_PROFILE_PREFIX = '${constDecl}'\nconst STALE_COLLECT_LIMIT = ${limitDecl}\nconst STALE_PROFILE_MAX_AGE_MS = ${maxAgeDecl}\n`
    const collect = new Function(
      'readdirSync', 'rmSync', 'statSync', 'tmpdir', 'join',
      `${constSrc}${fnSrc}\nreturn collectStaleLoginProfiles`,
    )(fs.readdirSync, fs.rmSync, fs.statSync, () => fakeRoot, path.join)

    const removed = collect()
    ok(removed === 1, `删掉 1 个够老的目录（实际 ${removed}）`)
    ok(!fs.existsSync(old), '比阈值更老的一次性目录被删掉了')
    ok(fs.existsSync(fresh), '刚建好的目录一个字节没动（可能正在用）')
    ok(fs.existsSync(other), '别的前缀目录没被碰')
    ok(fs.existsSync(notDir), '同名文件没被当成目录删掉')
    ok(collect() === 0, '再扫一次没有可回收的（幂等）')

    // ── 单轮上限：残留 11 个时不许一次删完（同步删除会卡住开窗）──────────
    // 场景：真机攒到 11 个 / 856 MB，一次清完 ≈ 7 秒，全卡在「点连接」与
    // 「窗口出现」之间。上限让它分几次清完。
    const manyRoot = fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'rv-many-'))
    try {
      for (let i = 0; i < 10; i++) {
        const d = path.join(manyRoot, `magicrew-login-${i}`)
        fs.mkdirSync(d, { recursive: true })
        fs.utimesSync(d, staleAt, staleAt)
      }
      const collectMany = new Function(
        'readdirSync', 'rmSync', 'statSync', 'tmpdir', 'join',
        `${constSrc}${fnSrc}\nreturn collectStaleLoginProfiles`,
      )(fs.readdirSync, fs.rmSync, fs.statSync, () => manyRoot, path.join)
      const first = collectMany()
      ok(first === limitDecl, `一轮最多删 ${limitDecl} 个（实际 ${first}）`)
      const leftAfter1 = fs.readdirSync(manyRoot).length
      ok(leftAfter1 === 10 - limitDecl, `剩下的留给下次（还剩 ${leftAfter1} 个）`)
      collectMany()
      collectMany()
      const leftAfter3 = fs.readdirSync(manyRoot).length
      ok(leftAfter3 === 10 - limitDecl * 3, `连扫三轮到清空（还剩 ${leftAfter3} 个）`)
    } finally {
      fs.rmSync(manyRoot, { recursive: true, force: true })
    }

    // ── 删除复核：`force: true` 静默失败时不许计数 ──────────────────────
    // 否则「没删掉」也占掉一个上限配额，真正的残留永远排不到。
    const ghostRoot = fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'rv-ghost-'))
    try {
      const d = path.join(ghostRoot, 'magicrew-login-ghost')
      fs.mkdirSync(d, { recursive: true })
      fs.utimesSync(d, staleAt, staleAt)
      const collectGhost = new Function(
        'readdirSync', 'rmSync', 'statSync', 'tmpdir', 'join',
        `${constSrc}${fnSrc}\nreturn collectStaleLoginProfiles`,
      )(
        fs.readdirSync,
        () => {}, // 假装删了但什么都不做（对齐 force:true 吞掉 ENOENT 的情形）
        fs.statSync,
        () => ghostRoot,
        path.join,
      )
      ok(collectGhost() === 0, '没真删掉就不计数（不然配额会被虚耗）')
      ok(fs.existsSync(d), '那个目录确实还在（证明上一条不是因为别的原因）')
    } finally {
      fs.rmSync(ghostRoot, { recursive: true, force: true })
    }

    // ── 取不到临时目录也必须安静返回 0 ───────────────────────────────────
    // `tmpdir()` 自己也会抛（TEMP/TMP/TEMPDIR 全指向不可用位置的极端环境）。
    // 那属于「登录不该关心的事」，不能让它把「点连接」整条链路带崩。
    // 以前 `const root = tmpdir()` 写在 try 之外 —— 纯防御性缺口，这条断言锁住。
    const collectNoTmp = new Function(
      'readdirSync', 'rmSync', 'statSync', 'tmpdir', 'join',
      `${constSrc}${fnSrc}\nreturn collectStaleLoginProfiles`,
    )(
      fs.readdirSync,
      fs.rmSync,
      fs.statSync,
      () => {
        throw new Error('TEMP 不可用')
      },
      path.join,
    )
    let noTmpResult
    try {
      noTmpResult = collectNoTmp()
    } catch (e) {
      noTmpResult = `抛了：${e?.message ?? e}`
    }
    ok(noTmpResult === 0, `tmpdir() 抛错时安静返回 0（实际 ${String(noTmpResult)}）`)
  } finally {
    fs.rmSync(fakeRoot, { recursive: true, force: true })
  }

  ok(/collectStaleLoginProfiles\(\)/.test(loginSrc), '开窗流程里真的调了回收')
  // 前缀必须是**一个常量**、两处引用它。硬编码两次的话只改一处就会
  // 变成「建了不回收」或「回收时去删别人的目录」—— 那两条都不会被别的断言抓到。
  ok(constDecl === 'magicrew-login-', `前缀常量声明正确（${String(constDecl)}）`)
  ok(
    /startsWith\(LOGIN_PROFILE_PREFIX\)/.test(loginSrc),
    '回收时引用常量，不是第二个字面量',
  )
  ok(
    /profilePrefix: LOGIN_PROFILE_PREFIX/.test(loginSrc),
    '建目录时引用同一个常量',
  )
  ok(
    (loginSrc.match(/'magicrew-login-'/g) ?? []).length === 1,
    '整个文件里该前缀只出现一次（就是那行常量声明）',
  )
  // 上限必须是**有限正数**：为 0 等于永不回收、无限大等于一次删到底（卡住开窗）。
  ok(Number.isInteger(limitDecl) && limitDecl >= 1 && limitDecl <= 10,
    `单轮上限是个合理的正数（${String(limitDecl)}）`)
  ok(
    /removed >= STALE_COLLECT_LIMIT/.test(loginSrc),
    '上限真的被用于跳出循环',
  )
  // 删除复核：`force: true` 会吞掉 ENOENT，所以必须再 stat 一次才能确认删掉了。
  ok(
    /rmSync\(dir, \{ recursive: true, force: true/.test(loginSrc) &&
      /statSync\(dir\);\s*\n\s*continue;/.test(loginSrc),
    '删完复核路径是否真的消失（不把"没删掉"算成删掉）',
  )
  // 阈值必须按平台分叉：POSIX 上 unlink 打开中的文件是合法的，没有 Windows
  // 那道「被占用就抛 EPERM」的网，只能靠更长的阈值自保。
  ok(
    /process\.platform === 'win32'/.test(loginSrc),
    '保留时长按平台分叉（POSIX 没有 EPERM 那道网）',
  )
}

console.log('')
if (bad === 0) {
  console.log(`✓ 全部通过（${total} 项：凭据在 IndexedDB 而非 localStorage —— 两条腿都要读它）`)
  process.exit(0)
}
console.log(`✗ ${bad} 项失败`)
process.exit(1)
