// 本体 RPC 方法总数 / 控制台覆盖率的口径锁定测试。
//
// 为什么要有这个测试：README 曾写「控制台覆盖 62 / 65」，但几个数彼此对不上，
// 因为不同人数的方法不一样，靠人工 grep 数：
//   - 只数小写首段 → 61（漏了 nativeSearch.* / panelEntry.* 这 4 个驼峰首段）
//   - 数关键字面量 → 69（多出 claimed / inactive / failed / already-claimed 这四条
//     非 RPC 的枚举 case）
//   - 控制台里 `grep rpc('...')` → 62（account.retestAll / account.resetAll 是
//     当字符串常量传给 accBulk() 的，字面量正则数不到）
//   - 只解析主 `switch (method)` → 65 —— **仍然偏低**：还有一类方法根本不走主
//     switch，而是在它之前被 `handleMethod()` 按前缀改道接管（见下）。
//
// 所以本测试有两个来源，都从源码解析、不硬编码任何方法数：
//   A) 主 `switch (method)` 块里的 `case '<x>.<y>'` 标签；
//   B) `handleMethod()` 里每个 `method.startsWith('<prefix>.')` → 对应的
//      `handle*Rpc` 处理器所在文件里的 `case '<prefix>.<名字>'`。
// 二者并集就是「本体实际可调度的方法」全集。
//
// ⚠️ 量 B 时**不能**只读 jet-hub-rpc.js：那 5 个分支只写 `method.startsWith('opencode.')`，
// 方法名在各自的 handler 文件里。而且前缀和文件名**不是**一一对应 —— `minimaxintl.`
// 的 handler 也在 `minimax-rpc.js` 里，不在 minimaxintl-*.js。所以这里从
// `import { handle*Rpc } from './x.js'` 反查文件名，不按前缀猜。
//
// 另加一条**可调用性**断言：对每个方法真发一次空 payload，断言回包不含
// `unknown method:` —— 这条能防住「case 标签存在但根本没接进调度」的错觉。
// 有副作用的方法（account.create 会真的建占位账号）走白名单排除 + 事后清理断言。
//
// 运行方式的取舍（探活默认**关**）：
//   node tests/t-rpc-cover.mjs                 只做静态推断与覆盖率断言（毫秒级）
//   node tests/t-rpc-cover.mjs --probe         额外探活（需要活的 magpie 控制台）
//   JET_HUB_PROBE=1 node tests/t-rpc-cover.mjs 同上（env 形式）
//   node tests/t-rpc-cover.mjs --no-probe      强制关（env JET_HUB_PROBE=0 同义）
//   scripts/test-all.mjs --all                 会给本测试补 --probe（与 --all 语义对齐）
// 为什么默认关：探活是 N 次网络往返，串行跑 5 分钟零输出（2026-10-28 实测被
// 控制台 job_kill），在 CI 里等于挂住。开着时每请求单独超时，失败计入
// 「探活失败」并判红，而不是把进程挂在那里。
//
// ⚠️ 探活的两阶段（2026-10-28 的教训）：阶段一并发扫描，只断言「没有 unknown
// method」「没有请求异常」；副作用归因放到阶段二，只在阶段一真的探测到内容变化
// 时才启动，且**串行、逐方法、两次独立命中才坐实**。最初让并发扫描顺便做前后
// 整体比对，结果把 aggregate.clearRejected、credits.permanentLock 这两个空载荷下
// 内容一字未变的只读方法误判成「真写用户状态」（_tmp-diff-attr.mjs 复核实测：
// 三次调用前后指纹 0116a85d2638|0a963f18dd28|263d00e235ee 始终不变）。
//
// 还有一个口径：**本测试只认「解析得到字面量」的方法名**（详见第 4 节开头）。
//
// 退出码即结论。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const RPC_JS = path.join(ROOT, 'vendor', 'lib', 'jet-hub-rpc.js')
const CONSOLE_JS = path.join(ROOT, 'console', 'console.js')
const CONSOLE_FILES = ['console/console.js', 'console/index.html'].map((f) => path.join(ROOT, f))

const ARGV = process.argv.slice(2)
const PROBE = ARGV.includes('--no-probe') || process.env.JET_HUB_PROBE === '0'
  ? false
  : ARGV.includes('--probe') || ARGV.includes('--all') || process.env.JET_HUB_PROBE === '1'

let failed = 0
const ok = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) failed += 1
}
const read = (p) => fs.readFileSync(p, 'utf8')
const linesOf = (p) => read(p).split(/\r?\n/)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 1) A：主 switch (method) 块里的 case 标签 ---------------------------------
const rpcLines = linesOf(RPC_JS)
const switchLine = rpcLines.findIndex((l) => /switch\s*\(\s*method\s*\)/.test(l))
ok(switchLine >= 0, `找到主 switch (method)（第 ${switchLine + 1} 行）`)

const mainCases = []
for (let i = switchLine + 1; i < rpcLines.length; i++) {
  const m = rpcLines[i].match(/^(\s*)case '([A-Za-z]+\.[A-Za-z]+)'\s*:/)
  if (m) mainCases.push({ line: i + 1, method: m[2], hasBody: rpcLines[i].slice(m[0].length).trim() !== '' })
  if (/^\s{8,}default\s*:/.test(rpcLines[i])) break
}
ok(mainCases.length === new Set(mainCases.map((c) => c.method)).size,
  `主 switch 里 case 标签无重复（${mainCases.length} 个标签 / ${new Set(mainCases.map((c) => c.method)).size} 个唯一）`)

// 别名/老端点：标签后不跟 { 的是 fall-through，与下一个 case 共享实现体。
const fallThrough = mainCases.filter((c) => !c.hasBody).map((c) => c.method)
console.log(`  A) 主 switch 方法数: ${new Set(mainCases.map((c) => c.method)).size}`)

// ---- 2) B：handleMethod() 里的前缀改道 ----------------------------------------
// 从源码里读「哪些前缀被改道」以及「改道到哪个处理器」，不硬编码前缀表。
const handleStart = rpcLines.findIndex((l) => /function\s+handleMethod\s*\(/.test(l))
ok(handleStart >= 0, `找到 handleMethod()（第 ${handleStart + 1} 行）`)

// 改道分支形如： if (method.startsWith('opencode.')) { ... handleOpencodeRpc(...) }
const prefixes = []
// 边界：只在 handleMethod 函数体里扫，即 [handleStart, switchLine)。
for (let i = handleStart; i < switchLine; i++) {
  const m = rpcLines[i]?.match(/method\.startsWith\('([A-Za-z]+)\.'\)/)
  if (!m) continue
  // 在随后几行里找它调用的处理器名
  let handler = null
  for (let k = i; k < Math.min(i + 6, rpcLines.length); k++) {
    const h = rpcLines[k].match(/await\s+(handle\w*Rpc)\s*\(/)
    if (h) { handler = h[1]; break }
  }
  prefixes.push({ prefix: m[1], handler, line: i + 1 })
}
ok(prefixes.length > 0, `handleMethod() 里识别到 ${prefixes.length} 个前缀改道分支`)
for (const p of prefixes) console.log(`     ${p.prefix}.* → ${p.handler}（第 ${p.line} 行）`)

// 处理器名 → 源文件：从 jet-hub-rpc.js 的 import 语句里解析，别猜文件名。
const importMap = {}
for (const l of rpcLines) {
  const m = l.match(/^import\s*\{\s*(handle\w*Rpc)\s*\}\s*from\s*'\.\/(.+?\.js)'/)
  if (m) importMap[m[1]] = m[2]
}
ok(Object.keys(importMap).length > 0, `解析到 ${Object.keys(importMap).length} 个处理器 import`)

const prefixCases = []
for (const p of prefixes) {
  const file = importMap[p.handler]
  if (!file) {
    ok(false, `前缀 ${p.prefix}.* 的处理器 ${p.handler} 找不到源文件（import 里没有）`)
    continue
  }
  const src = linesOf(path.join(ROOT, 'vendor', 'lib', file))
  const found = []
  for (const l of src) {
    const m = l.match(/^\s*case '([A-Za-z]+\.[A-Za-z]+)'\s*:/)
    if (m && m[1].startsWith(`${p.prefix}.`)) found.push(m[1])
  }
  ok(found.length > 0, `${file} 里认出 ${found.length} 个 ${p.prefix}.* 方法`)
  // 前缀和文件名不一定同名（minimaxintl → minimax-rpc.js），这里把实际文件名打出来
  console.log(`     ${p.prefix}.* → vendor/lib/${file}（${found.length} 个：${found.join(', ')}）`)
  for (const f of found) prefixCases.push(f)
}
console.log(`  B) 前缀改道方法数: ${prefixCases.length}`)

// 前缀改道的方法不该同时出现在主 switch 里（否则重复计数/语义冲突）
const overlap = prefixCases.filter((m) => mainCases.some((c) => c.method === m))
ok(overlap.length === 0, `前缀改道与主 switch 无重叠${overlap.length ? '：' + overlap.join(', ') : ''}`)

// ---- 3) 全量方法集合 ----------------------------------------------------------
const methods = [...new Set([...mainCases.map((c) => c.method), ...prefixCases])].sort()
const mainMethodSet = new Set(mainCases.map((c) => c.method))
console.log(`\n  本体实际可调度方法总数: ${methods.length}（主 switch ${mainMethodSet.size} + 前缀改道 ${prefixCases.length}）`)
console.log(`  其中共享实现体的标签: ${fallThrough.length ? fallThrough.join(', ') : '无'}`)
ok(fallThrough.includes('credits.permanentLock'),
  'credits.permanentLock 与 loomy.permanentLock 是同一实现的两个 label（fall-through）')

// ---- 4) 控制台覆盖率 ----------------------------------------------------------
// 【口径：方法名必须能解析到「字面量」，否则本测试判红】
//
// 本测试**不**对整份源码做 `includes("'<方法名>'")`（那是旧版做法，等于碰运气：
// 名字一旦进了变量就数不到，而当时能数对只是因为名字恰好以字面量出现在旁边的
// const 里 —— 巧合，不是判据）。现在逐个解析 `console.js` 里 `rpc(<实参>, …)` 的实参：
//   - 实参是字面量          → 就是方法名（当前 73 处）
//   - 实参是标识符          → 回溯同文件的 const/let 绑定里的字面量（如 lockMethod）
//   - 实参是 `<obj>.<field>` → 回溯对象字面量的该字段（如 KEY_CHANNELS[p].method）
//   - 实参是**转发函数的形参** → 找该函数的全部调用点，取同位置的字面量实参
//                              （如 accBulk(btn, method) 的 'account.resetAll'）
// 任何实参**解析不出字面量**（模板串拼装 `'account.' + act`、从接口/配置里取、
// 跨文件导入……）都判红，并指名是哪一行 —— 因为那样本测试就数不到它，
// 覆盖率会静默偏低，而「漏计」和「没接」在报告里长得一模一样。
// 这就是与控制台的约定：**新的方法名一律写成字面量常量**（必要时先 `const M = 'x.y'`
// 再传变量），不要拼装。
// 反向也收紧：`console.js` 里出现某方法名字面量但**没进任何 rpc() 调用点**（只用于
// 比较、日志、i18n 文案）不算「已接」—— 这也是旧版整文件 grep 的漏洞之一。
const consoleLines = linesOf(CONSOLE_JS)
const METHOD_SHAPE = /^[A-Za-z][A-Za-z]*\.[A-Za-z][A-Za-z]*$/
const literalsIn = (line) => [...line.matchAll(/'([^'\\\n]{3,80})'|"([^"\\\n]{3,80})"/g)]
  .map((m) => m[1] ?? m[2])
  .filter((s) => METHOD_SHAPE.test(s))
// 拼正则前必须先转义标识符；同一条也适用于模板串里的 `\s`
// —— `\s` 写进模板串会被 JS 吃成 `s`，正则变成 `consts`，绑定永远匹配不上，
//    于是整个「实参回溯」静默失效、误报「解析不出」。这坑真踩过（13:35 那轮）。
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 解析 `rpc(...)` 的实参表达式 → { names: [], why } 或 { names: [], unresolved: '原因' } */
function resolveArg(arg, atLine) {
  const expr = arg.trim()
  // (a) 字面量：'x.y'
  const lit = expr.match(/^'([^']+)'$|^"([^"]+)"$/)
  if (lit) return { names: [lit[1] ?? lit[2]] }
  // (b) 标识符：回溯 const/let/var 绑定（含三元两条臂）
  if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
    // b1) 直接绑定 —— **按调用点可见性取最近的同名绑定**，不是取第一个。
    //     踩过的坑（2026-10-28）：`cfg` 在 console.js 里有 5 个绑定
    //     （:386/:405 是 KEY_CHANNELS，:509/:516/:536/:563 是 PROXY_CHANNELS），
    //     旧实现从头扫一遍、撞上第一条就返回，于是 `rpc(cfg.testProxy)`
    //     被解析成 APIKEY 的字段、报「解析不出」—— 这是测试自己误报，
    //     控制台那边的写法是对的（同名的局部变量在不同函数里各有含义）。
    const bindRe = new RegExp(`(?:const|let|var)\\s+${expr}\\s*=`)
    let boundAt = -1
    for (let i = 0; i < Math.min(atLine - 1, consoleLines.length); i++) {
      if (bindRe.test(consoleLines[i])) boundAt = i
    }
    const names = []
    if (boundAt >= 0) names.push(...literalsIn(consoleLines[boundAt]))
    if (!names.length) {
      // 没有前序绑定（可能是提升/函数作用域写法）→ 退回旧行为：全文第一个
      for (const l of consoleLines.slice(atLine - 1)) {
        if (bindRe.test(l)) { names.push(...literalsIn(l)); break }
      }
    }
    let isParam = false
    if (names.length) return { names }
    // b2) 是某个函数的形参 → 找全部调用点，取同位置的字面量实参
    for (const l of consoleLines) {
      const sig = l.match(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/)
        ?? l.match(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/)
      if (!sig) continue
      const params = sig[2].split(',').map((s) => s.trim().split(/\s*=\s*/)[0].trim())
      const idx = params.indexOf(expr)
      if (idx < 0) continue
      isParam = true
      const fname = sig[1]
      const callRe = new RegExp(`\\b${fname}\\(([^()]*)\\)`, 'g')
      for (const l2 of consoleLines) {
        let cm
        callRe.lastIndex = 0
        while ((cm = callRe.exec(l2)) !== null) {
          const args = cm[1].split(',').map((s) => s.trim())
          const got = literalsIn(args[idx] ?? '')
          names.push(...got)
        }
      }
    }
    if (isParam && names.length) return { names: [...new Set(names)] }
    return { names: [], unresolved: `标识符 ${expr} 既不是字面量常量绑定，也不是「调用点都传字面量」的转发形参` }
  }
  // (c) <obj>.<field>：回溯对象字面量字段（含「表取一层再取字段」：
  //     例 `const cfg = KEY_CHANNELS[provider]` + `rpc(cfg.method)`，
  //     方法名在 KEY_CHANNELS 这个**嵌套**对象字面量的 method 字段里）
  const member = expr.match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/)
  if (member) {
    const [, obj, field] = member
    const names = fieldLiterals(obj, field, 0, undefined, atLine)
    if (names.length) return { names: [...new Set(names)] }
    return { names: [], unresolved: `成员表达式 ${expr} 回溯不到对象字面量里的字面量字段` }
  }
  return { names: [], unresolved: `实参形状 ${JSON.stringify(expr)} 不是字面量/标识符/成员表达式（疑似拼装）` }
}

// 在对象字面量里找某字段的字面量值；obj 本身也可能是「从另一个对象字面量里按 key 取」
// （`const cfg = KEY_CHANNELS[provider]`），那就先顺着 key 回到那张表再取字段。
// depth 限 2 层，够用且不会在互相引用的表之间绕圈。
function fieldLiterals(obj, field, depth, viaKey, atLine) {
  if (depth > 2) return []
  let derivedFrom = null
  // 1) 直接绑定：const <obj> = { ... }（整块）或 = <TABLE>[k]（从表里取一层）
  // ⚠️ 模板字符串里写 `\s` 会被 JS 当成转义序列吃掉（`\s` → `s`），
  //    正则于是变成 `consts`，永远匹配不到绑定 —— 一处复发式误报的根因。
  //    统一走 escapeRe() 拼正则。
  const id = escapeRe(obj)
  const bindRe2 = new RegExp(`(?:const|let|var)\\s+${id}\\s*=\\s*(.+)$`)
  const limit2 = atLine ? Math.min(atLine - 1, consoleLines.length) : consoleLines.length
  let start = -1
  for (let i = 0; i < limit2; i++) if (bindRe2.test(consoleLines[i])) start = i
  if (start < 0 && atLine) {
    for (let i = 0; i < consoleLines.length; i++) if (bindRe2.test(consoleLines[i])) { start = i; break }
  }
  if (start >= 0) {
    const rhs = consoleLines[start].match(bindRe2)[1].trim()
    const fromTable = rhs.match(/^([A-Za-z_$][\w$]*)\[.+\]$/)
    if (fromTable) derivedFrom = fromTable[1]
  }
  // 2) 常量字符串 → 没有字段，放弃
  if (!derivedFrom && start < 0) return []

  const scan = (begin, end, label) => {
    const out = []
    for (let i = begin; i < end; i++) {
      const fm = consoleLines[i].match(new RegExp(`^\\s*${field}\\s*:\\s*(.+?),?\\s*$`))
      if (fm) out.push(...literalsIn(fm[1]))
    }
    return out
  }

  if (derivedFrom) {
    // 回到那张表（TABLE 自身的定义）扫它的全部字段
    const tStart = consoleLines.findIndex((l) => new RegExp(`(?:const|let|var)\\s+${derivedFrom}\\s*=\\s*\\{`).test(l))
    if (tStart >= 0) {
      let tEnd = consoleLines.length
      for (let i = tStart + 1; i < consoleLines.length; i++) if (new RegExp(`^\\}?\\s*$|^\\};?\\s*$`).test(consoleLines[i])) { tEnd = i; break }
      const names = scan(tStart + 1, tEnd, derivedFrom)
      if (names.length) return names
    }
    return viaKey ? [] : fieldLiterals(derivedFrom, field, depth + 1, true)
  }

  // 3) 直接对象字面量：从定义行扫到第一个顶层 `}`
  const names = []
  for (let i = start + 1; i < consoleLines.length; i++) {
    if (/^\}/.test(consoleLines[i])) break
    const fm = consoleLines[i].match(new RegExp(`^\\s*${field}\\s*:\\s*(.+?),?\\s*$`))
    if (fm) names.push(...literalsIn(fm[1]))
  }
  return names
}

const rpcCallSites = []
for (let i = 0; i < consoleLines.length; i++) {
  const l = consoleLines[i]
  const re = /(?<![\w$.])rpc\(\s*([^,()\n]+?)\s*[,)]/g
  let m
  re.lastIndex = 0
  while ((m = re.exec(l)) !== null) {
    // 跳过函数定义行 `function rpc(method, payload = {})`
    if (/function\s+rpc\s*$/.test(l.slice(0, m.index))) continue
    rpcCallSites.push({ line: i + 1, arg: m[1], ...resolveArg(m[1], i + 1) })
  }
}
const unresolvedSites = rpcCallSites.filter((s) => s.unresolved)
ok(unresolvedSites.length === 0,
  `${rpcCallSites.length} 个 rpc() 调用点的实参全部解析到字面量方法名`
  + (unresolvedSites.length ? `；解析不出的：` + unresolvedSites.map((s) => `console/console.js:${s.line} rpc(${s.arg})`).join(' · ') : ''))

const used = [...new Set(rpcCallSites.flatMap((s) => s.names))]
  .filter((m) => methods.includes(m))
const ghosts = [...new Set(rpcCallSites.flatMap((s) => s.names))].filter((m) => !methods.includes(m))
const unused = methods.filter((m) => !used.includes(m))
console.log(`  控制台已接: ${used.length} / ${methods.length}`)
console.log(`  控制台未接: ${unused.length}${unused.length ? '\n    ' + unused.join('\n    ') : ''}`)

// 未接清单**不维护任何硬编码名单**（以前写死过「13 个」「11 个」，控制台接两个就过时）。
// 判据是从源码推导的两条规则：
//   规则 A：主 switch 里的方法**一个都不许未接** —— 控制台的主要操作面，漏接即红。
//   规则 B：前缀改道那一批允许未接（控制台还没有账号级代理 / 匿名账号的 UI），
//           但**只报告不失败**，接上了自动从清单里消失。
// 所以「现在缺几个」永远等于本测试这次打印的数，文档不要抄死数字。
const unusedMain = unused.filter((m) => mainMethodSet.has(m))
const unusedPrefix = unused.filter((m) => !mainMethodSet.has(m))
ok(unusedMain.length === 0,
  `主 switch 的 ${mainMethodSet.size} 个方法控制台全都接了`
  + (unusedMain.length ? `；未接 ${unusedMain.length} 个：${unusedMain.join(', ')}` : ''))
// 未接项只可能来自前缀改道（规则 A 通过时这一条自动成立，留着当交叉校验）
ok(unusedPrefix.every((m) => prefixCases.includes(m)),
  `未接项全部属于前缀改道（${unusedPrefix.length} 个）`)
if (unusedPrefix.length) {
  // 按 provider 分组报，比一长串更好读，也顺便暴露「哪家整体没入口」
  const byProvider = new Map()
  for (const m of unusedPrefix) {
    const p = m.split('.')[0]
    byProvider.set(p, [...(byProvider.get(p) ?? []), m])
  }
  console.log(`  已知接线缺口（前缀改道，控制台无 UI）${unusedPrefix.length} 个：`)
  for (const [p, list] of [...byProvider].sort()) console.log(`    ${p}: ${list.join(', ')}`)
}

// 反向锚点：Loomy 的永久锁定**不是**未接项。控制台经变量 `lockMethod` 调
// `loomy.permanentLock`（console.js:563 的 const，三个调用点共用）；实例实测
// 回 `{provider:'loomy',locked:true}`（200）。它一旦被算成未接，说明调用从
// 字面量常量变成了拼装/间接形式 —— 那正是上面第 4 节开头禁止的写法。
ok(!unused.includes('loomy.permanentLock'),
  'loomy.permanentLock 已由控制台接通（经 lockMethod 变量，不是未接项）')

// 前缀改道那 5 家：控制台要么接了几个、要么明确还缺几个 —— 但不能**整个忽略**
// （一家都没有任何处置 = 这家在控制台里完全不存在）。
for (const p of ['opencode.', 'gemini.', 'qoder.', 'minimaxintl.', 'modelscope.']) {
  const missed = unused.filter((m) => m.startsWith(p))
  ok(missed.length > 0 || used.some((m) => m.startsWith(p)),
    `控制台对 ${p}* 有处置（接了 ${used.filter((m) => m.startsWith(p)).length} / 缺 ${missed.length}）`)
}

// 控制台不该调本体不存在的方法（会静默 unknown method）
ok(ghosts.length === 0, `控制台没有调用不存在的方法${ghosts.length ? '：' + ghosts.join(', ') : ''}`)

// ---- 5) 可调用性：真发一次空 payload，断言不是 unknown method -----------------
// 这一条是 Jeb 的反证逼出来的：光看 case 标签会漏掉「标签在但没接进调度」。
//
// ⚠️⚠️ 空 payload 探活**并不天然安全**：下面这些 case 的入口没有「缺参数就
// bad-request」的闸，空 payload 会真的执行到写盘 / 发上游请求。逐个核对过实现体：
//   aggregate.rejectNonExpiring  无闸 → clearAggregateAllowedExcept(...) 改聚合白名单
//   backup.import                无闸 → mode 缺省即 'replace'，会用空 payload 覆盖整库
//   captcha.contribute           无闸 → 往载体参数表里写一条
//   account.retest / retestAll   无闸 → 发真实上游请求并清限流标记
//   account.reset / resetAll     无闸 → 清限流标记（改 state.json）
//   credits.claimAll             无闸 → 对每条账号真发领取请求
//   account.create               无闸 → 建占位账号（Jeb 探它时就建出过
//                                gemini-4da6f7c8 / minimaxintl-a579da3c，事后用
//                                account.delete 清的 —— 所以它**必须**在这张表里）
const SIDE_EFFECTS = new Map([
  ['aggregate.rejectNonExpiring', '改聚合白名单'],
  ['backup.import', "缺省 mode='replace'，会覆盖整库"],
  ['captcha.contribute', '写载体参数表'],
  ['account.retest', '发真实上游请求 + 清限流标记'],
  ['account.retestAll', '同上，且遍历全部账号'],
  ['account.reset', '清限流标记'],
  ['account.resetAll', '同上，且遍历全部账号'],
  ['credits.claimAll', '对每条账号真发领取'],
  ['account.create', '建占位账号'],
])

// 探活**必须**不改变用户状态：调用前后比对这几份权威文件的内容，一变即判红。
// 这条是给「以后新加的 case 忘加闸」用的安全网——它自己不该被触发。
//
// ⚠️ 2026-10-28 踩过的坑：最初用**文件字节 sha1**做指纹，结果对
// aggregate.clearRejected 空载荷误报「改写了状态」。复核（_probe-clearrejected.mjs
// A/B 对照）证明：内容一字未变，只是 mtime 被改了 —— 有并发写方（多实例 / UI 轮询）
// 会把同样的内容重写一遍。所以指纹必须是**规范化 JSON 内容**，mtime 一律不参与。
const STATE_FILES = ['state.json', 'permanent-locks.json', 'auto-checkin.json']
  .map((f) => path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'jet-hub', f))
const canon = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  const keys = Object.keys(v).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
}
const fingerprint = () => STATE_FILES.map((p) => {
  try { return crypto.createHash('sha1').update(canon(JSON.parse(fs.readFileSync(p, 'utf8')))).digest('hex').slice(0, 12) }
  catch { return 'absent' }
}).join('|')
// 指纹只回答「变没变」；要**说清变了什么**（写进报告的证据），再给一个 diff。
const stateJson = () => STATE_FILES.map((p) => {
  try { return { file: path.basename(p), json: JSON.parse(fs.readFileSync(p, 'utf8')) } }
  catch { return { file: path.basename(p), json: null } }
})
const diffKeys = (a, b) => {
  const out = []
  for (let i = 0; i < a.length; i++) {
    const fa = a[i].json, fb = b[i].json
    if (JSON.stringify(fa) === JSON.stringify(fb)) continue
    const keys = new Set([...Object.keys(fa ?? {}), ...Object.keys(fb ?? {})])
    for (const k of keys) {
      if (canon(fa?.[k]) !== canon(fb?.[k])) out.push(`${a[i].file}:${k}`)
    }
  }
  return out
}
const callable = { checked: 0, unknown: [], errors: [], skipped: [] }

// 单请求超时 5s（旧版 15s × 78 串行 = 最坏 19 分钟，正是「挂住」的来源）。
const REQUEST_TIMEOUT = Number(process.env.JET_HUB_PROBE_TIMEOUT || 5_000)
// 限并发 6：本地 HTTP 服务扛得住，78 个方法从「分钟级」降到「秒级」。
const CONCURRENCY = Math.max(1, Number(process.env.JET_HUB_PROBE_CONCURRENCY || 6))

async function callOne(base, method, timeoutMs = REQUEST_TIMEOUT) {
  const body = {
    type: 'client-request', rpcId: 'probe', method: 'jet-hub',
    payload: { method, payload: {} },
  }
  const r = await fetch(`${base}/api/jet-hub`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  })
  return r.text()
}

// 极简并发池：不引依赖，跑完即返回；单个任务抛错由调用方自己吞。
async function pool(items, limit, worker) {
  let next = 0
  const run = async () => {
    while (next < items.length) {
      const i = next++
      await worker(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
}

// 网关 3425 不暴露管理路由；控制台地址从本体自己写的快照读。
// ⚠️ 快照会**过期**：本体每次启动把当前地址写进去，进程退出后文件仍留着旧端口
// （实测 2026-10-28：文件写 18502，而活的实例在 18500 / 18501）。所以拿到快照
// 地址后必须再验一次活，不行就沿端口区间扫——否则测试会静默退化成 NOT RUN，
// 「可调用性」这条最重要的断言就白写了。
function snapshotUrls() {
  const candidates = [
    process.env.JET_HUB_CONSOLE,
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'jet-hub', 'console.json'),
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.config', 'magpie', 'jet-hub-console.json'),
  ].filter(Boolean)
  const urls = []
  for (const c of candidates) {
    if (c.startsWith('http')) { urls.push(c.replace(/\/$/, '')); continue }
    try {
      const j = JSON.parse(read(c))
      if (j?.url) urls.push(String(j.url).replace(/\/$/, ''))
    } catch { /* 没有快照就走下一个候选 */ }
  }
  return [...new Set(urls)]
}

// 本体控制台从 18500 起向上找空位（见 src/container.mjs 的 `from: 18500`），
// 同时允许 JET_HUB_CONSOLE_SCAN 覆盖区间（多实例并存时用）。
function scanPrefixes() {
  const raw = process.env.JET_HUB_CONSOLE_SCAN
  const list = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : null
  if (list) return list
  const out = []
  for (let p = 18500; p <= 18510; p++) out.push(`http://127.0.0.1:${p}`)
  return out
}

async function isAlive(base) {
  try {
    await callOne(base, 'account.list', 2_000)
    return true
  } catch { return false }
}

async function pickConsole() {
  for (const u of snapshotUrls()) if (await isAlive(u)) return u
  for (const u of scanPrefixes()) if (await isAlive(u)) return u
  return null
}

if (!PROBE) {
  console.log('  探活未启用（默认关：全量网络往返不该绑在每次单测里）。'
    + '要跑可调用性断言：加 --probe / JET_HUB_PROBE=1，或跑 scripts/test-all.mjs --all。')
} else {
  const t0 = Date.now()
  const base = await pickConsole()
  if (!base) {
    console.log('  NOT RUN：找不到活的控制台（快照过期且 18500-18510 都不通；'
      + '需要 magpie 在跑，或设 JET_HUB_CONSOLE / JET_HUB_CONSOLE_SCAN）')
  } else {
    const snapshots = snapshotUrls()
    const stale = snapshots.filter((u) => u !== base)
    console.log(`  控制台探活: ${base}${stale.length ? `（快照里的 ${stale.join(', ')} 已失效，已改扫端口）` : ''}`
      + `（并发 ${CONCURRENCY}，单请求超时 ${REQUEST_TIMEOUT} ms）`)
    const probeAll = methods.filter((m) => !SIDE_EFFECTS.has(m))
    callable.skipped = methods.filter((m) => SIDE_EFFECTS.has(m))
    // 静默基线：先等 2s 看内容自己会不会变（并发写方若真在改内容，这里先暴露），
    // 避免把「别人的改动」记到探活头上。
    const quiet0 = fingerprint()
    await sleep(2000)
    const quiet1 = fingerprint()
    if (quiet0 !== quiet1) console.log('  ⚠ 静默期内容就变了：有并发写方在改这些文件，下面的副作用判定可能归错帐')
    const before = fingerprint()
    // 阶段一：并发扫描，只负责「能调通」——unknown method / 请求异常。
    // 副作用**不在这里判**（并发下整体前后比对归不了因，见文件头）。
    await pool(probeAll, CONCURRENCY, async (m) => {
      try {
        const text = await callOne(base, m)
        callable.checked += 1
        if (text.includes('unknown method:')) callable.unknown.push(m)
      } catch (e) {
        // 超时/连接错误不算 unknown，但要计入「探活失败」并判红 —— 别让它伪装成通过
        callable.errors.push(`${m}（${e?.name ?? e}）`)
      }
    })
    const after = fingerprint()
    // 阶段二：副作用归因。阶段一真的改了内容才进（正常情况下永远不进）。
    // 串行、逐方法：先等一个内容稳定的窗口，调一次，再比对；同一方法**两次独立
    // 命中**才坐实 —— 单次命中很容易被「恰好此时别的写方落盘」冒充。
    const mutated = after !== before
    let confirmed = []
    const noise = []
    if (mutated) {
      console.log('  ⚠ 探活期间状态文件内容变了，进入隔离复验（串行，逐个方法等静默窗口、两次命中才算）')
      const suspects = probeAll
      for (const m of suspects) {
        let hits = 0
        let unattributed = false
        for (let round = 0; round < 2 && hits < 2; round++) {
          let quiet = ''
          for (let i = 0; i < 10; i++) { // 最多等 5s 找一个内容稳定的窗口
            const a = fingerprint()
            await sleep(500)
            if (fingerprint() === a) { quiet = a; break }
          }
          if (!quiet) { unattributed = true; break }
          await callOne(base, m).catch(() => {})
          await sleep(400)
          if (fingerprint() !== quiet) hits += 1
        }
        if (hits >= 2) confirmed.push(m)
        else noise.push(unattributed ? `${m}（等不到静默窗口，无法归因）` : m)
      }
      console.log(`  副作用归因：嫌疑 ${suspects.length}，坐实 ${confirmed.length}，判为并发写方噪声 ${noise.length}`
        + (noise.length ? `（噪声: ${noise.join(', ')}）` : ''))
    }
    const missing = confirmed.filter((m) => !SIDE_EFFECTS.has(m))
    ok(missing.length === 0,
      missing.length === 0
        ? (mutated
          ? '探活后状态文件内容变了，但两次隔离复验都无法把改动归给任何单个方法（判定为外部并发写方）'
          : '探活前后 state.json / permanent-locks.json / auto-checkin.json 内容未变')
        : `这些方法的空载荷会真写用户状态：${missing.join(', ')}（需补进 SIDE_EFFECTS 或给实现补「空载荷即拒绝」的闸）`)
    ok(callable.unknown.length === 0,
      `${callable.checked} 个方法真发请求，均未回 unknown method${callable.unknown.length ? '；异常 ' + callable.unknown.slice(0, 6).join(', ') : ''}`)
    ok(callable.errors.length === 0,
      `探活无请求异常/超时${callable.errors.length ? `；${callable.errors.length} 个：` + callable.errors.slice(0, 8).join(', ') : ''}`)
    console.log(`  有副作用、按设计跳过（${callable.skipped.length}）: ${callable.skipped.map((m) => `${m}[${SIDE_EFFECTS.get(m)}]`).join(', ') || '无'}`)
    console.log(`  探活耗时 ${Date.now() - t0} ms`)
  }
}

console.log(failed === 0 ? `\n✓ RPC 口径一致：本体 ${methods.length} 个方法，控制台接 ${used.length} 个` : `\n✗ ${failed} 条失败`)
process.exit(failed === 0 ? 0 : 1)
