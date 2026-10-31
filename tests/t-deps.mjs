// 运行时依赖声明守卫：代码里 import 的每一个外部包，package.json 必须声明。
//
// 为什么要有这个测试（真实事故，2026-10-31）：
//   `vendor/lib/oauth.js` 第 2 行 `from 'jose'`、`vendor/lib/opencode-proxy.js`
//   `from 'undici'`，但**根 package.json 的 dependencies 里没有这两个包**。
//   本机开发副本之所以能跑，是因为 node_modules 里早就装着（早期手工装的），
//   所以本地测试全绿、一切正常。而用户从 GitHub 装：
//     · `git clone` 后 `npm install` → 只装 6 个 @deepseek-ai/*，jose/undici 缺席；
//     · `magpie plugin add github:Betsy20/magpie-Jet-Hub` → bun 按依赖树装，
//       同样装不到这两个，于是插件进程一加载 vendor 就
//       `ERR_MODULE_NOT_FOUND: Cannot find package 'jose'`，
//       插件整个起不来，内嵌容器不启动 ⇒ 控制台（18500 起）压根不存在，
//       用户看到的就是「GitHub 装的版本打不开控制台」。
//   本机看起来好、换机全崩 —— 这是最难查的一类缺陷，用机器守比用眼睛守可靠。
//
// 判据（刻意从**源码**算，不看 node_modules）：
//   ① 扫 index.mjs / src/**/*.mjs / vendor/lib/**/*.js / scripts/ / tests/ 的
//      **静态** import 与字面量形式的动态 import，抽出所有裸包名（滤掉 node:、
//      相对路径、`#` 别名、URL 型说明符）；
//   ② 运行时侧（index.mjs / src/ / vendor/lib/）import 的包必须在
//      `dependencies` 或 `peerDependencies` 里；工具侧（scripts/ / tests/）
//      允许只在 `devDependencies`（宿主不装 dev 依赖，逼测试框架进 dependencies
//      会污染用户插件目录）；只在 dev 声明却被运行时 import 的，单独报；
//   ③ 反向也查一遍：dependencies 里声明了却**没有任何代码 import** 的，报一行提示
//      但不算失败（传递依赖 / 宿主注入 / seam 包间接带入）；
//   ④ `vendor/package.json` 声明过的包外层必须也声明，且**版本区间逐字相同**；
//      `engines` 同样比**值**（只查键会让 `">=18"` 混过去）；
//   ⑤ `src/container.mjs` 的 `SEAM_PACKAGES` 每一项都必须被**字面量** import 看见；
//   ⑥ 运行时目录禁止变量形式的动态 import（`await import(spec)`）—— 那种写法
//      静态上看不见，等于在守卫上开一个后门。
//
// 去注释/去字符串用的是单遍字符状态机 `maskCode()`，不是「行首像注释就整行清掉」：
// 后者对 `*/ import z from 'w'`（闭合符与 import 并在一行，tsc 产物常见）会**漏报**，
// 对块注释内部不以 `*` 开头的行会**误报**。实测 vendor 里有这种形态。
//
// 为什么扫 vendor 也要扫：vendor 是本体原样拷贝，但它是**这个包的一部分**，
// 它 import 的包必须由这个包的 package.json 负责装 —— 上游那份 vendor/package.json
// 里写了 jose/undici，可 magpie 装的、npm 装的是**外层**那份，两份对不上就出事。
// 例外：`vendor/lib/client/**` 是 DSH 网页端 `window.__ModuleLoader__` 的产物，
// 它的 react / react-dom 由浏览器宿主注入，跟 Node 包解析无关，必须排除。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { builtinModules } from 'node:module'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const ROOT = path.dirname(HERE)

const problems = []
const ok = (cond, msg) => { if (!cond) problems.push(msg) }

// ── 收集要扫的文件 ────────────────────────────────────────────────────────────

/** 递归列目录下指定扩展名的文件（跳过 node_modules 与隐藏目录）。 */
function walk(dir, exts, out = []) {
  let rows
  try { rows = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const d of rows) {
    if (d.name.startsWith('.') || d.name === 'node_modules') continue
    const p = path.join(dir, d.name)
    if (d.isDirectory()) walk(p, exts, out)
    else if (exts.some((e) => d.name.endsWith(e))) out.push(p)
  }
  return out
}

// 浏览器端的 client bundle 必须排除：`vendor/lib/client/*.js` 是 DSH 前端
// `window.__ModuleLoader__` 的产物，它的 `require('react')` 由 DSH 网页宿主在
// 浏览器里注入，跟 Node 的包解析毫无关系。把它算进来会误报三个包
// （实测：`@deepseek-ai/dsh-client-ui-primitives`、`react`、`react-dom`）。
// 判据用「文件头是不是 __ModuleLoader__」，比按目录更准 —— 上游换布局也守得住。
const isBrowserBundle = (file) => {
  try {
    return readFileSync(file, 'utf8').slice(0, 200).includes('__ModuleLoader__')
  } catch {
    return false
  }
}

// 扫描集：**只在 Node 侧跑的源码**。
//
// ⚠️ 只能往里加 tsc / bundler 的产物目录，**禁止**加 `page/` 与 `console/`：
//   `page/page.js` 里有一句 UI 示例文本 `import OpenAI from 'openai'`（在模板
//   字符串内，不是依赖），加进来会立刻假红。两个目录都是浏览器侧代码，
//   浏览器宿主注入的包（`react` 等）不归本包的 package.json 负责。
// `tests/` 与 `scripts/` 在 Node 下跑，缺声明同样会 ERR_MODULE_NOT_FOUND，所以一并扫。
// 根目录其它脚本（将来加 build.mjs 之类工具）也必须进扫描集：只列 index.mjs 的话，
// 根上新增文件的依赖完全不进守卫。
const rootTop = readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isFile() && !d.name.startsWith('.') && d.name !== 'index.mjs'
    && ['.mjs', '.js', '.cjs'].some((e) => d.name.endsWith(e)))
  .map((d) => path.join(ROOT, d.name))
const files = [
  path.join(ROOT, 'index.mjs'),
  ...rootTop,
  ...walk(path.join(ROOT, 'src'), ['.mjs']),
  ...walk(path.join(ROOT, 'vendor', 'lib'), ['.js']),
  ...walk(path.join(ROOT, 'scripts'), ['.mjs', '.js', '.cjs']),
  ...walk(path.join(ROOT, 'tests'), ['.mjs', '.js', '.cjs']),
].filter((f) => !isBrowserBundle(f) && !f.includes(`${path.sep}vendor${path.sep}lib${path.sep}client${path.sep}`))

// 判据是「每个目录都要有东西」，不是「总数够大」：`files.length > 50`
// 这种阈值在某个目录被写错、整体却仍超阈值时照样绿（实测分布 294 = 1+10+252+7+24，
// 单看总数完全看不出 `tests/` 被写成 0 个）。
const dirCounts = {
  'index.mjs': files.some((f) => f === path.join(ROOT, 'index.mjs')) ? 1 : 0,
  'src/': files.filter((f) => f.includes(`${path.sep}src${path.sep}`)).length,
  'vendor/lib/': files.filter((f) => f.includes(`${path.sep}vendor${path.sep}lib${path.sep}`)).length,
  'scripts/': files.filter((f) => f.includes(`${path.sep}scripts${path.sep}`)).length,
  'tests/': files.filter((f) => f.includes(`${path.sep}tests${path.sep}`)).length,
}
for (const [dir, cnt] of Object.entries(dirCounts)) {
  ok(cnt > 0, `扫描集里 ${dir} 一个文件都没有 —— 路径算错了，那一块的漏声明不会被发现`)
}

// ── 抽外部包名 ────────────────────────────────────────────────────────────────

// 三种写法都要认（漏一种就会漏报，等于这个测试白写）：
//   ① `import x from 'pkg'` / `import 'pkg'` / `export … from 'pkg'`
//   ② `import('pkg')` 动态
//   ③ `require('pkg')`（vendor 里有 CommonJS 痕迹，宁可多认）
// `require` 前面加 `(?<!\.)`：排除 `o.require('x')` 这类对象方法调用。
const SPEC_RES = [
  /(?:^|[\s;{}()])(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"`]([^'"`$]+)['"`]\s*\)/g,
  /(?<!\.)\brequire\s*\(\s*['"`]([^'"`$]+)['"`]\s*\)/g,
]

/** 裸包名：去掉子路径，@scope/name/sub → @scope/name。 */
function bareName(spec) {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return null
  // 裸名也可能就是 Node 内置（`require('fs')` / `import('path')`），不带 `node:` 前缀。
  // 不滤掉的话，根目录新加的脚本一写 `require('fs')` 就会假红。
  if (builtinModules.includes(spec)) return null
  if (spec.startsWith('#')) return null // package.json 的 "imports" 内部别名
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) return null // file: / data: / https: 等 URL 型
  if (/^[a-zA-Z]:[\\/]/.test(spec)) return null // 绝对路径
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/**
 * 「把注释和字符串内容涂成空格」——返回与原文**等长**、换行位置不变的一份副本。
 *
 * 为什么不能用「这行长得像注释就整行清掉」：那是行首形状启发式，两种情况都会错
 *   · 漏报：`/* … ⏎ * doc ⏎ *\/ import z from 'w'` —— 闭合符与 import 并在一行，
 *     该行以 `*` 开头被整行清空，真 import 被吞掉（V8 能解析 ⇒ 守卫自己假绿）。
 *     仓库实证：`vendor/lib/account-pool.js:2705` 就是 tsc 生成的
 *     `     *\/ async setOpencodeProxy(accountId, proxy) {`。
 *   · 误报：块注释内部不以 `*` 开头的行（`/* ⏎ import a from 'r' ⏎ *\/`）、
 *     行内块注释（`const v = 1 /* import n from 'cmt' *\/`）、
 *     以及字符串里的假 import（`const s = " import x from 'fake'"`）。
 *
 * 所以改成单遍字符扫描状态机：注释整体涂空格（保留换行，行号不变）；
 * 字符串**内容**涂空格但**引号本身保留**，于是 `from 'pkg'` 的引号结构还在，
 * 而字符串内部那些引号（比如 `"… 'fake' …"` 里的单引号）被涂掉 ⇒ 不会被当成说明符。
 *
 * 已知边界：模板字符串整体当字符串处理，`` `${await import('x')}` `` 里的代码会被涂掉
 * ⇒ 那种写法扫不到。当前仓库没有这种形态（全仓 grep 为空），真出现时会被
 * `files.length`/反面断言之外的别的测试抓到，届时再按需解析 `${}` 插值。
 */
function maskCode(text) {
  // 必须按 UTF-16 码元拆分（`split('')`）而不是按码点（`[...text]`）：
  // 后面的 text[i] 都是码点下标，两种下标对 BMP 之外的字符（emoji 等）会错位，
  // 而 vendor 里有大量中文与 emoji 注释，错位一次整份源代码就切错。
  const chars = text.split('')
  const n = text.length
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (chars[k] !== '\n') chars[k] = ' '
  }
  // 正则字面量里的引号（`/['"]/`）若是被当成字符串开头，会让整个状态机错位、
  // 后面几百行全被吞掉 —— 实测过，症状是「注释里的 import 也被扫出来」。
  // 判据用「前一个非空白字符」：`= /re/`、`(/re/)`、`, /re/`、`return /re/`
  // 这类位置才是正则；`a / b` 前面是标识符或 `)`，不当正则。
  const REGEX_PREV = '([{,;:=!&|?+-*%~^<>'
  // 只看「前一个非空白字符」会漏掉 `return /re/` 这种常识写法（`n` 不在上表里）。
  // 漏认一次的代价极大：正则体里的反引号会开启模板态，直到下一个反引号之间的
  // 真实 import 全被涂空 —— 实测 `return /`/` 后面跟一句 import 可以让守卫假绿。
  // 仓库里 `vendor/lib/sse.js` 的 `return /`$/.test(tail) || /<$/.test(tail)` 就是
  // 这个形态，今天绿只是因为该行之后没有反引号。故补一条关键字回看。
  const REGEX_KEYWORDS = new Set([
    'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw',
    'await', 'yield', 'instanceof', 'do', 'else', 'default',
  ])
  // 已知盲区（本轮真值对账 0 漏报，属理论边界）：`if (ok) /`/.test(s)`、
  // `while (ok) /`/.test(s)` 这种 `)` 后紧跟正则的写法仍会被当成除号，
  // 其后的 import 会被吞。当前仓库无此写法；把 `)` / `}` 塞进 REGEX_PREV
  // 会把 `a = (b) / c` 这类真除法误判成正则，反方向出错更糟，故不修。
  const afterKeyword = (k) => {
    // 只在同一行内回看：`return` 后换行时 ASI 会先插一个分号，下一行开头的 `/…/`
    // 已经是独立的正则表达式语句，与前面那个 `return` 无关 —— 所以回看不能跨行。
    let p = k - 1
    while (p >= 0 && (text[p] === ' ' || text[p] === '\t')) p -= 1
    const end = p
    while (p >= 0 && /[A-Za-z0-9_$]/.test(text[p])) p -= 1
    return p !== end && REGEX_KEYWORDS.has(text.slice(p + 1, end + 1))
  }
  const prevNonSpaceChar = (k) => {
    let p = k - 1
    while (p >= 0 && (text[p] === ' ' || text[p] === '\t')) p -= 1
    return p >= 0 ? text[p] : ''
  }
  let i = 0
  while (i < n) {
    const ch = text[i]
    const nx = i + 1 < n ? text[i + 1] : ''
    if (ch === '/' && nx === '/') {
      const from = i
      i += 2
      while (i < n && text[i] !== '\n') i += 1
      blank(from, i)
      continue
    }
    if (ch === '/' && nx === '*') {
      const from = i
      i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i = Math.min(n, i + 2)
      blank(from, i)
      continue
    }
    if (ch === '/' && nx !== '/' && nx !== '*') {
      const p = prevNonSpaceChar(i)
      if (p === '' || p === '\n' || REGEX_PREV.includes(p) || afterKeyword(i)) {
        let j = i + 1
        let inClass = false
        while (j < n) {
          const c = text[j]
          if (c === '\\') { j += 2; continue }
          if (c === '[') inClass = true
          else if (c === ']') inClass = false
          else if (c === '/' && !inClass) { j += 1; break }
          else if (c === '\n') break
          j += 1
        }
        blank(i + 1, j - 1) // 正则体涂空格，两个斜杠留着
        i = j
        continue
      }
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      let j = i + 1
      while (j < n) {
        const c = text[j]
        if (c === '\\') { j += 2; continue }
        if (c === quote) break
        // 单/双引号字符串不跨行：撞到换行说明这行里的引号不是字符串开头
        if (quote !== '`' && c === '\n') break
        j += 1
      }
      if (j < n && text[j] === quote) {
        blank(i + 1, j) // 内容涂空格，两个引号留着
        i = j + 1
      } else {
        i += 1 // 未闭合，当成普通字符
      }
      continue
    }
    i += 1
  }
  return chars.join('')
}

/** 文件 → Set<包名> */
function scan(file) {
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const masked = maskCode(text)
  const names = new Set()
  for (const re of SPEC_RES) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(masked))) {
      // masked 与 text 等长、引号位置一致，且说明符内容已被涂成空格 ⇒ 匹配段里
      // 出现的引号**恰好**是说明符的那一对。据此反推下标，从 text 取回真值。
      // 注意不能拿「m[0] 的最后一位」当闭合引号：`import('x')` 与 `require('x')`
      // 的匹配末尾是 `)`，差一位就会把 `@scope/name` 截成 `scope/name`。
      const seg = m[0]
      const openIdx = seg.search(/['"`]/)
      const quote = openIdx === -1 ? '' : seg[openIdx]
      const closeIdx = quote ? seg.lastIndexOf(quote) : -1
      const spec = openIdx !== -1 && closeIdx > openIdx ? text.slice(m.index + openIdx + 1, m.index + closeIdx) : m[1]
      const n = bareName(spec)
      if (n) names.add(n)
    }
  }
  return names
}

const importedBy = new Map() // 包名 → 引用它的文件（相对路径，报错时好定位）
for (const f of files) {
  for (const n of scan(f)) {
    if (!importedBy.has(n)) importedBy.set(n, [])
    importedBy.get(n).push(path.relative(ROOT, f).replace(/\\/g, '/'))
  }
}

// ── 断言 ①：每个被 import 的包都声明了 ────────────────────────────────────────

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const declared = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
])
// 工具侧（`scripts/`、`tests/`）允许只声明在 devDependencies：
// 那两处的依赖不参与插件运行，逼它们进 dependencies 会让 `npm install --omit=dev`
// 也把测试框架装进用户的插件目录（将来引入 vitest 就会立刻踩到）。
// 运行时侧（index.mjs / src/ / vendor/lib/）**不认** devDependencies —— 宿主按
// dependencies 装，写进 dev 等于没写。
const devDeclared = new Set(Object.keys(pkg.devDependencies ?? {}))
const isToolPath = (rel) => rel.startsWith('tests/') || rel.startsWith('scripts/')
const usedByRuntime = (n) => (importedBy.get(n) ?? []).some((p) => !isToolPath(p))

// 只在本包**之外**提供的东西不算（magpie 宿主注入的、Node 内置的已在 bareName 里滤掉）。
// 当前不需要例外表；将来真需要时在这里加，且必须写明理由。

// devDependencies 里声明过的交给下面的 `devOnlyButRuntime` 单独报，
// 否则同一条问题会出两条文案，读起来像两个缺陷。
const missingRuntime = [...importedBy.keys()]
  .filter((n) => usedByRuntime(n) && !declared.has(n) && !devDeclared.has(n))
  .sort()
ok(
  missingRuntime.length === 0,
  `package.json 没有声明这些被**运行时代码** import 的包（从 GitHub/npm 装会 ERR_MODULE_NOT_FOUND）：\n` +
    missingRuntime.map((n) => `    ${n}  ← ${[...new Set(importedBy.get(n))].slice(0, 3).join(', ')}`).join('\n'),
)
const missingTool = [...importedBy.keys()]
  .filter((n) => !usedByRuntime(n) && !declared.has(n) && !devDeclared.has(n))
  .sort()
ok(
  missingTool.length === 0,
  `package.json 没有声明这些被 scripts/tests import 的包（dependencies 或 devDependencies 都行）：\n` +
    missingTool.map((n) => `    ${n}  ← ${[...new Set(importedBy.get(n))].slice(0, 3).join(', ')}`).join('\n'),
)

// 反向查一遍：被 import 的包若只声明在 devDependencies、却被运行时文件用了，必须报出来。
const devOnlyButRuntime = [...importedBy.keys()]
  .filter((n) => usedByRuntime(n) && !declared.has(n) && devDeclared.has(n))
  .sort()
ok(
  devOnlyButRuntime.length === 0,
  `这些包只在 devDependencies 里，但被运行时代码 import（宿主不会装 dev 依赖）：\n` +
    devOnlyButRuntime.map((n) => `    ${n}  ← ${[...new Set(importedBy.get(n))].slice(0, 3).join(', ')}`).join('\n'),
)

// ── 断言 ②：vendor 那份自己的 package.json 若声明了，外层也必须声明 ─────────
//
// 这条专治本次事故的形状：`vendor/package.json` 写着 jose/undici，
// 外层漏了。外层是**实际被安装的那份**，vendor 那份只对「独立按上游装」有效。
// 而且不只比包名，还比**版本区间字符串** —— 外层写成 `jose: "^5"`、vendor 是 `^6`，
// 名字对得上、装下来的版本却对不上，运行期照样炸。

let vendorPkg = null
try { vendorPkg = JSON.parse(readFileSync(path.join(ROOT, 'vendor', 'package.json'), 'utf8')) } catch { /* 没有就跳过 */ }
ok(vendorPkg !== null, 'vendor/package.json 读不出来 —— 与上游声明对齐这一整组（gap / drift / peerThird / engines）被跳过了')
if (vendorPkg) {
  const upstreamDeps = vendorPkg.dependencies ?? {}
  const gap = Object.keys(upstreamDeps).filter((n) => !declared.has(n))
  ok(
    gap.length === 0,
    `vendor/package.json 声明了但外层 package.json 没声明：${gap.join(', ')}` +
      `（外层才是实际被装的，漏了就换机必崩）`,
  )
  const rootDeps = pkg.dependencies ?? {}
  const rootPeer = pkg.peerDependencies ?? {}
  // 外层声明在哪一半都算数，但**取到的那一份**必须与 vendor 逐字相同。
  // 早先写成 `n in rootDeps && …`：只声明在 peerDependencies 的包会整条跳过版本比对，
  // 名字对得上、装下来却是另一个大版本 —— 与漏声明同级的事故。
  const outerRange = (n) => (n in rootDeps ? rootDeps[n] : rootPeer[n])
  const drift = Object.keys(upstreamDeps)
    .filter((n) => declared.has(n) && outerRange(n) !== upstreamDeps[n])
    .map((n) => `${n}（外层 ${JSON.stringify(outerRange(n))} vs vendor ${JSON.stringify(upstreamDeps[n])}）`)
  ok(
    drift.length === 0,
    `内外层版本区间不一致：${drift.join('；')}`,
  )

  // 第三方运行时包（jose / undici 这类）只认 dependencies：宿主只按 dependencies 装，
  // 声明在 peerDependencies 等于「等宿主提供」，而宿主根本没有它们的来源。
  // `@deepseek-ai/*` 才由 magpie 宿主注入，允许走 peer。
  // 遍历的必须是「vendor 声明的 ∪ 外层 peer 声明的」：只看 vendor 那份的话，
  // 一个 vendor 里根本没有的第三方包（`peer-only-probe` 这种）永远不被检查，
  // 而 `declared` 又把 peer 算作已声明 ⇒ 声明在错的字段上、守卫照样绿，
  // 与本次事故完全同形（换机才 ERR_MODULE_NOT_FOUND）。
  const peerThird = [...new Set([...Object.keys(upstreamDeps), ...Object.keys(rootPeer)])]
    .filter((n) => !n.startsWith('@deepseek-ai/') && !(n in rootDeps) && n in rootPeer)
    .sort()
  ok(
    peerThird.length === 0,
    `这些第三方包只声明在 peerDependencies 里，宿主不会装它们：${peerThird.join(', ')}（挪进 dependencies）`,
  )

  // engines 同理：vendor 要求 node ^22.19.0 || >=24.0.0，外层不写就等于没要求，
  // 换到 node 20 的机器上装完才在运行期炸。
  // ⚠️ 只查「键在不在」是假绿 —— 外层写 `">=18"` 也会通过，而 README 明确承诺
  //    「必须写上同样的 engines」，所以键与**值**都要比。
  const upstreamEngines = vendorPkg.engines ?? {}
  const rootEngines = pkg.engines ?? {}
  const engineGap = Object.keys(upstreamEngines).filter((k) => !(k in rootEngines))
  ok(
    engineGap.length === 0,
    `vendor/package.json 要求 ${engineGap.map((k) => `${k} ${upstreamEngines[k]}`).join(', ')}，外层 package.json 没写 engines`,
  )
  const engineDrift = Object.keys(upstreamEngines)
    .filter((k) => k in rootEngines && rootEngines[k] !== upstreamEngines[k])
    .map((k) => `${k}（外层 ${JSON.stringify(rootEngines[k])} vs vendor ${JSON.stringify(upstreamEngines[k])}）`)
  ok(
    engineDrift.length === 0,
    `内外层 engines 不一致：${engineDrift.join('；')}（README 承诺与 vendor 逐字相同）`,
  )
}

// ── 断言 ③：反向提示（不算失败） ──────────────────────────────────────────────
//
// 注意：③ **只管「多声明」**，防漏声明靠断言 ①。两者不要混。
// 文案不能说「可能是 scripts/tests 用的」——这两个目录也在扫描集里了，
// 真被用就会出现在 importedBy 里；列在这里的多半是：
//   · 传递依赖（本包不直接 import，但依赖树里的包要用）；
//   · 宿主注入的东西（magpie 给插件进程准备的运行时）；
//   · 由 seam 包间接带进来的（`@deepseek-ai/dsh-commands` / `dsh-llm` 这类本体 seam，
//     见 `src/container.mjs` 里那两句**字面量** `await import`）。

const unused = [...Object.keys(pkg.dependencies ?? {})].filter((n) => !importedBy.has(n)).sort()
if (unused.length) {
  console.log(
    `· 提示：dependencies 里这些没被源码直接 import（传递依赖 / 宿主注入 / seam 包间接带入，删前先确认）：${unused.join(', ')}`,
  )
}

// ── 断言 ④：声明了但这台机器没装（非致命） ───────────────────────────────────
//
// 与「漏声明」互为两面：本次事故的另一半就是「本机 node_modules 早就装着，
// 所以本地全绿、换机全崩」。这条只在有 node_modules 时才有意义，没装就跳过。
// 只查 dependencies：peerDependencies 本来就不保证装在本地（那是宿主的事），
// 把它们算进「解析不到」会天天刷一行假提示。

let resolveOk = null
try {
  const { createRequire } = await import('node:module')
  const req = createRequire(path.join(ROOT, 'package.json'))
  resolveOk = []
  for (const n of Object.keys(pkg.dependencies ?? {}).sort()) {
    try { req.resolve(n) } catch { resolveOk.push(n) }
  }
} catch { /* 环境不支持就跳过 */ }
if (resolveOk && resolveOk.length) {
  console.log(`· 提示：声明了但本机 node_modules 里解析不到（先 npm install 再判断真假）：${resolveOk.join(', ')}`)
}

// ── 断言 ⑤：seam 包清单必须真的被字面量 import 看见 ──────────────────────────
//
// `src/container.mjs` 导出了 `SEAM_PACKAGES`（本体 seam：dsh-commands / dsh-llm），
// 它们在 `start()` 里 `ctx.plugin` 装上，属于**容器启动路径**。
// 只在数组里加一项却没加对应的 `await import('包名')` 字面量 ⇒ 依赖守卫看不见它
// ⇒ 换机 `ERR_MODULE_NOT_FOUND`。这条就是堵那个入口的。
//
// 注意：这里用**读源码**抽数组，不 import 那个模块 —— 真 import 会把 cordis 拉起来，
// 在没装依赖的机器上这条测试自己先崩，等于守卫失效。

const seamSrc = readFileSync(path.join(ROOT, 'src', 'container.mjs'), 'utf8').replace(/\r\n/g, '\n')
// 数组边界必须在 masked 上配对：注释里出现一个 `]` 就能让贪婪截断提前收尾，
// 后面的包名根本不被检查（实测往注释里写 `// A]` 可让未声明的包静默通过）。
// masked 里注释与字符串内容都已涂成空格，括号配对不会被它们带偏。
const seamMaskedAll = maskCode(seamSrc)
const seamAt = seamMaskedAll.indexOf('SEAM_PACKAGES')
// 窗口用「本行行首 → SEAM_PACKAGES」而不是固定 40 字符：
// 上一行若也是 `export const XXX = 1`，40 字符窗口会把它的 export 借过来（实测误判）。
const seamLineStart = seamAt < 0 ? 0 : seamMaskedAll.lastIndexOf('\n', seamAt - 1) + 1
const seamIsDecl = seamAt >= 0 && seamMaskedAll.slice(seamLineStart, seamAt).includes('export')
const seamBracket = seamAt < 0 ? -1 : seamMaskedAll.indexOf('[', seamAt)
let seamSpan = null
if (seamBracket >= 0) {
  const bracketOpen = seamBracket
  let bracketDepth = 0
  for (let k = bracketOpen; k < seamMaskedAll.length; k += 1) {
    if (seamMaskedAll[k] === '[') bracketDepth += 1
    else if (seamMaskedAll[k] === ']') {
      bracketDepth -= 1
      if (bracketDepth === 0) {
        seamSpan = [bracketOpen + 1, k]
        break
      }
    }
  }
}
const seamOk = seamSpan !== null && seamIsDecl
ok(seamOk, 'src/container.mjs 里找不到 `export const SEAM_PACKAGES = [...]`（改名或删了？断言⑤会静默失效）')
if (seamOk) {
  // 引号必须在 masked 上配对、内容回原文取：直接在原文上 matchAll 引号，
  // 数组里一行含引号的注释（`// 注意 'dsh-llm' 也要`）就会被当成一个包名 ⇒ 假红。
  const seamNames = []
  if (seamSpan) {
    const seg = seamMaskedAll.slice(seamSpan[0], seamSpan[1])
    for (let p = 0; p < seg.length; p += 1) {
      const q = seg[p]
      if (q !== "'" && q !== '"' && q !== '`') continue
      const close = seg.indexOf(q, p + 1)
      if (close < 0) break
      seamNames.push(seamSrc.slice(seamSpan[0] + p + 1, seamSpan[0] + close))
      p = close
    }
  }
  ok(seamNames.length > 0, 'SEAM_PACKAGES 是空数组 —— 本体 seam 至少有 dsh-commands 与 dsh-llm 两个')
  // 判据必须用 container.mjs **这一个文件**的字面量 import，不能拿全局 `importedBy`：
  // `@deepseek-ai/dsh-llm` 被 45 个以上 vendor/lib/*.js 静态 import，全局集合里它永远在，
  // 于是把 container.mjs 里那句 import 整段删掉，断言⑤照样绿 —— 实测过。
  // `scan()` 返回的就是该文件抽到的包名，正是要的粒度。
  const seamLocal = new Set(scan(path.join(ROOT, 'src', 'container.mjs')))
  const seamInvisible = seamNames.filter((n) => !seamLocal.has(n))
  ok(
    seamInvisible.length === 0,
    `SEAM_PACKAGES 里有包没有被**字面量** import（依赖守卫因此看不见它）：${seamInvisible.join(', ')}` +
      `（在 src/container.mjs 里补一句 await import('包名')，别用变量循环）`,
  )
  // 反向：container.mjs 里新加一句字面量 `await import('x')` 却忘了登记进 SEAM_PACKAGES，
  // 说明「数组与代码必须同步」这条契约只被单方向守着，补上另一半。
  // 在 masked 上定位引号（注释已被涂空，不会命中注释里的示例句），再回原文取包名。
  const seamMasked = seamMaskedAll
  const seamDynamic = []
  for (const m of seamMasked.matchAll(/(?<![\w$.])import\s*\(\s*(['"`])/g)) {
    const from = m.index + m[0].length
    const to = seamMasked.indexOf(m[1], from)
    if (to > from) seamDynamic.push(seamSrc.slice(from, to))
  }
  // 反向断言只该管**包名**：`await import('./x.mjs')`、`await import('node:fs')`
  // 是本地文件/内置模块，登记进 SEAM_PACKAGES 毫无意义（bareName 会把它们滤成 null）。
  const seamUnlisted = seamDynamic.map(bareName).filter(Boolean).filter((n) => !seamNames.includes(n))
  ok(
    seamUnlisted.length === 0,
    `src/container.mjs 里有字面量 import 的包没登记进 SEAM_PACKAGES：${seamUnlisted.join(', ')}`,
  )
}

// ── 断言 ⑥：运行时目录禁止「变量形式的动态 import」 ──────────────────────────
//
// `await import(spec)` 里的 spec 若是变量，任何静态扫描都看不见 ⇒ 往那种数组里
// 加一个未声明的包，断言①照样绿，换机才 `ERR_MODULE_NOT_FOUND`。
// 2026-10-31 那次就是同款形状：`src/container.mjs` 曾写
// `for (const spec of ['@deepseek-ai/dsh-commands', …]) await import(spec)`。
//
// 只管**运行时目录**（index.mjs / src/ / vendor/lib/）：测试里
// `await import(pathToFileURL(某文件).href)` 是正常手段，扫进去只会天天假红。
// 另外排除明显的路径构造形态 —— 它们装的是本地文件，不是包。

const isRuntimeFile = (f) => {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/')
  return rel === 'index.mjs' || rel.startsWith('src/') || rel.startsWith('vendor/lib/')
}
// 判**实参表达式**，不判整行：原来按「原文整行含路径关键字就放行」，
// 一行尾注释 `// 以前用 path.join(...)` 就能把真违规整行豁免（实测 4 个用例全绿）。
// 用 masked 定位括号（注释已涂空 ⇒ 注释里的括号不参与配对），回原文取实参。
// `String.raw` 是标签模板（`import(String.raw`jose`)`），后面跟反引号而不是 `(`，
// 早先写成统一的 `\s*\(` 让它成为死条目 —— 实测那种写法会假红。
const PATH_ARG = /^(?:pathToFileURL|readFileSync|path\.(?:join|resolve)|new\s+URL)\s*\(|^String\.raw\s*[(`]|import\.meta\.url/
const dynamicVar = []
for (const f of files) {
  if (!isRuntimeFile(f)) continue
  const text = readFileSync(f, 'utf8').replace(/\r\n/g, '\n')
  const masked = maskCode(text)
  const re = /(?<![\w$.])import\s*\(\s*/g
  let m
  while ((m = re.exec(masked))) {
    const open = m.index + m[0].lastIndexOf('(')
    if (masked[open] !== '(') continue
    let depth = 0
    let close = -1
    for (let k = open; k < masked.length; k += 1) {
      if (masked[k] === '(') depth += 1
      else if (masked[k] === ')') {
        depth -= 1
        if (depth === 0) { close = k; break }
      }
    }
    const rawArg = (close > open ? text.slice(open + 1, close) : text.slice(open + 1)).trim()
    const line = masked.slice(0, m.index).split('\n').length
    const at = `${path.relative(ROOT, f).replace(/\\/g, '/')}:${line}`
    if (/^['"]/.test(rawArg)) continue // 包名字面量交给断言 ①
    if (rawArg.startsWith('`')) {
      // 模板字面量：无插值时等价字面量（断言 ① 负责），带 `${` 则静态扫描看不见。
      if (rawArg.includes('${')) dynamicVar.push(`${at}  ← import(\`…\${…}…\`)`)
      continue
    }
    if (PATH_ARG.test(rawArg)) continue // 装的是本地文件，不是包
    dynamicVar.push(`${at}  ← import(${rawArg.split('\n')[0].slice(0, 60)})`)
  }
}
ok(
  dynamicVar.length === 0,
  `这些地方用了变量形式的动态 import（静态扫描看不见，请改成字面量）：\n    ${dynamicVar.join('\n    ')}`,
)

// ── 汇总 ──────────────────────────────────────────────────────────────────────

if (problems.length) {
  console.log('✗ ' + problems.length + ' 处不符：')
  for (const p of problems) console.log('  ' + p)
  process.exit(1)
}
console.log(
  `✓ 依赖声明完整：扫了 ${files.length} 个源文件，${importedBy.size} 个外部包，` +
    `全部在 package.json 里（dependencies ${Object.keys(pkg.dependencies ?? {}).length} 项 + ` +
    `peer ${Object.keys(pkg.peerDependencies ?? {}).length} 项）`,
)
process.exit(0)
