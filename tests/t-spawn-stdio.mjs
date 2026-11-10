// 子进程 stdio 守卫：`spawnSync` 一律**不许**用默认的管道 stdio。
//
// ## 为什么要有这个测试（2026-11-11 实测，不是理论风险）
//
// `tests/t-seed-auth.mjs` 与 `tests/t-import-backup.mjs` 原来都写成
//
//   spawnSync(process.execPath, [script, …], { encoding: 'utf8', … })
//
// `encoding` 是**管道模式**的选项 —— 等价于 `stdio: 'pipe'`。而受限环境
// （Windows AppLocker / 容器 / 企业策略 / DSH 沙箱）**禁止创建管道**：
// `spawnSync` 直接给出 `error.code === 'EPERM'`、`status === null`，
// `stdout` 与 `stderr` 全空。
//
// 于是 `scripts/test-all.mjs` 打印出来的失败尾部是
//
//   ✗ --dry-run 失败:
//
// 后面**一片空白**。两条用例各失败一次、重试仍失败，而判据工具**给不出任何线索**
// —— 看起来像被测脚本坏了，实际是被测环境不给跑。这不是某台机器的特例：
// 任何把 DSH 跑在受限沙箱里的人都撞得上，**而本机与 CI 都是绿的**（它们不限制
// 管道），所以只有换环境才暴露，属于「最难查」那一档。
//
// 正确写法是 fd 重定向（`scripts/test-all.mjs` 早就这么做了，这两个测试没跟上）：
//
//   const fd = openSync(capPath, 'w')
//   spawnSync(cmd, args, { stdio: ['ignore', fd, fd] })
//
// 退出码语义不变、两条流都拿得到、沙箱里也能跑。`tests/_iso.mjs` 的
// `runNode()` 把这件事封好了，新写的测试直接用。
//
// ## 判据（三条，都从**源码**算）
//
//   ① 每个 `spawnSync(` / `execFileSync(` / `execSync(` 调用**必须**显式传
//      `stdio` —— 不传就是默认 `'pipe'`，正是本测试要挡的那件事；
//   ② `stdio` 的值不许是 `'pipe'`，也不许是含 `'pipe'` 的数组；
//   ③ 不许同时写 `encoding` —— 那个选项只对管道模式有意义，出现就说明有人
//      把 fd 重定向改回了管道（或者照着旧代码抄了一遍）。
//
// ## 为什么扫 `scripts/` 与 `src/`，不只是 `tests/`
//
// 同一个坑在**任何**需要捕获子进程输出的地方都成立。`scripts/import-backup.mjs`
// 用的是 `stdio: 'inherit'`（子进程直接继承终端，不建管道），那也是合法写法；
// 但哪天有人为了「顺手拿一下输出」改成 `encoding: 'utf8'`，导入备份就会在沙箱里
// 静默炸掉 —— 而那条路用户是拿来救数据的。守卫要盖住全部调用点。
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 路径含空格或非 ASCII 时 `URL.pathname` 会返回百分号编码串，用 fileURLToPath。
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)

/** 收摘要扫的目录（相对仓库根）。 */
const DIRS = ['tests', 'scripts', 'src']
const EXTS = ['.mjs', '.cjs', '.js']

const problems = []
const ok = (cond, msg) => { if (!cond) problems.push(msg) }

/**
 * 「把注释与字符串内容涂成空格」——返回与原文**等长**、换行位置不变的一份副本。
 *
 * 为什么不能只做「行首像注释就整行清掉」：那会把 `*\/ spawnSync(…` 这种
 * 闭合符与调用并在一行的形态漏掉（tsc 产物里很常见）。
 *
 * 为什么要连字符串内容一起涂：URL 里的 `//`（`'https://…'`）会被当成行注释的
 * 开头，把后面整行代码吞掉 ⇒ 守卫假绿。字符串的**引号本身保留**，括号配对
 * 不受内容影响。
 *
 * 为什么是单遍：一边涂一边读 `text[i]` 是最容易出 off-by-one 的写法。
 * 这里**读 `text`、写 `chars`**，两个数组分开，下标永远同步。
 */
function maskCode(text) {
  const chars = text.split('')
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text[i]
    const d = text[i + 1]
    if (c === '/' && d === '/') {
      while (i < n && text[i] !== '\n') {
        chars[i] = ' '
        i += 1
      }
      continue
    }
    if (c === '/' && d === '*') {
      chars[i] = ' '
      chars[i + 1] = ' '
      i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] !== '\n') chars[i] = ' '
        i += 1
      }
      if (i < n) { chars[i] = ' '; i += 1 }
      if (i < n) { chars[i] = ' '; i += 1 }
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      i += 1
      while (i < n && text[i] !== q) {
        if (text[i] === '\\' && i + 1 < n) {
          chars[i] = ' '
          chars[i + 1] = ' '
          i += 2
          continue
        }
        if (text[i] !== '\n') chars[i] = ' '
        i += 1
      }
      if (i < n) i += 1 // 闭合引号保留
      continue
    }
    i += 1
  }
  return chars.join('')
}

/** 从 `(` 的位置出发，返回与它配对的 `)` 的下标；不配对返回 -1。 */
function matchParen(src, openIdx) {
  let depth = 0
  for (let i = openIdx; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1
    else if (src[i] === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** 递归列目录下的源码文件（跳过 node_modules 与隐藏目录）。 */
function walk(dir, out = []) {
  let rows
  try { rows = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const d of rows) {
    if (d.name.startsWith('.') || d.name === 'node_modules') continue
    const p = path.join(dir, d.name)
    if (d.isDirectory()) walk(p, out)
    else if (EXTS.some((e) => d.name.endsWith(e))) out.push(p)
  }
  return out
}

// `execSync` / `execFileSync` 默认同样走管道，一起守。`spawn` / `exec` 的异步
// 版本当前仓库没有（全仓 grep 为空），等真出现时再并进来 —— 判据宁可窄而准，
// 也不要因为误报（`re.exec(`）被人加进白名单后彻底失效。
const CALL_RE = /\b(spawnSync|execFileSync|execSync)\s*\(/g

const files = DIRS.flatMap((d) => walk(path.join(ROOT, d)))
ok(files.length > 0, '一个源码文件都没扫到（DIRS 写错了？）')

let callCount = 0
for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  const text = readFileSync(file, 'utf8')
  // ⚠ 两套源码配合用：
  //   · `masked` 把**注释和字符串内容**都涂成空格，只用来定位调用与做括号配对
  //     （字符串里的 `(` 不会打乱深度）；
  //   · 取实参时回到 `text` 的同一区间 —— 判据要看的是 `stdio: 'pipe'` 这种
  //     **字面量**，涂空后只剩 `stdio: ''`，`'pipe'` 永远匹配不到。
  //     （2026-11-11 变异实测：只用 masked 时「显式写 'pipe'」这条**绿着通过**。）
  // 两者等长且换行位置一致，下标可以直接互换。
  const masked = maskCode(text)
  for (const m of masked.matchAll(CALL_RE)) {
    callCount += 1
    const name = m[1]
    const openIdx = m.index + m[0].length - 1
    const closeIdx = matchParen(masked, openIdx)
    const line = masked.slice(0, m.index).split('\n').length
    if (closeIdx < 0) {
      problems.push(`${rel}:${line} 的 ${name}( 括号不配对，无法判定 stdio（解析器需要更新？）`)
      continue
    }
    const args = text.slice(openIdx + 1, closeIdx)
    const hasStdio = /\bstdio\s*:/.test(args)
    // `stdio: 'pipe'` / `stdio: ['pipe', …]` 都算管道。
    const pipeStdio = /\bstdio\s*:\s*\[?\s*['"]pipe['"]/.test(args)
    if (!hasStdio) {
      problems.push(
        `${rel}:${line} 的 ${name}() 没传 stdio（默认 'pipe'）——` +
        ' 受限环境禁止建管道，直接 EPERM 且两条流全空，失败信息退化成一片空白',
      )
    } else if (pipeStdio) {
      problems.push(
        `${rel}:${line} 的 ${name}() 用了 'pipe' stdio ——` +
        ' 受限环境禁止建管道；改用 fd 重定向（见 tests/_iso.mjs 的 runNode()）',
      )
    }
    if (/\bencoding\s*:/.test(args)) {
      problems.push(
        `${rel}:${line} 的 ${name}() 写了 encoding ——` +
        ' 那个选项只对管道模式有意义，fd 重定向下是死配置；出现它通常说明有人把 runNode() 改回了 spawnSync 默认写法',
      )
    }
  }
}

ok(callCount > 0, '一个子进程调用都没扫到（CALL_RE 写错了？）')

if (problems.length) {
  console.log('✗ 子进程 stdio 守卫失败：')
  for (const p of problems) console.log('  - ' + p)
  process.exitCode = 1
} else {
  console.log(`✓ 子进程 stdio 全部安全（${callCount} 处调用，都显式指定了非管道 stdio，且无死配置 encoding）`)
}
