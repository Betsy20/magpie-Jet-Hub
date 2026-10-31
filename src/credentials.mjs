// 凭据桥：把 DSH 的 .credentials.yaml（refs 段）变成 cordis 容器的 credentials 服务。
//
// ⚠️ 三个必须踩准的点（都真跑验证过）：
//  1. resolve() 必须返回 { value } 包装对象 —— account-pool.js:2049 读的是
//     resolved.value 再 JSON.parse；返回裸字符串会得到 undefined，JSON.parse 抛错
//     被 catch 吞掉，结果所有账号被判「凭据未配置或已失效」，chat 全 502。
//  2. .credentials.yaml 的值可能是跨多行的单引号标量（workbuddy 就是 3 行）：
//     只取第一行会把 JSON 尾部切掉。必须实现 YAML 折行折叠（换行→空格，'' → '）。
//  3. 写入路径必须落回 .credentials.yaml —— 否则 refresh 出的新 token 只活在内存里，
//     下次启动就退回旧 token，refresh_token 被消耗后彻底登不上。
import { Service } from '@deepseek-ai/cordis'
import { readFileSync, writeFileSync, copyFileSync, existsSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const CRED_BASENAME = '.credentials.yaml'

// 同一进程内 set() 的并发序号（临时文件名用）
let writeSeq = 0

/**
 * 写盘串行化用的 promise 链。
 *
 * ⚠️ 2026-10-30 审查发现真缺陷：`set()` 是「读文件 → 改 → 写临时文件 → `await renameInto`」，
 * 那个 `await` 之后写回的是 **await 之前读到的旧快照**。两条并发 set 各自读到同一份旧文件，
 * 后落盘的那条会把先落盘的新 ref 整条抹掉。而并发是**真机已发生**的：
 * 本体在后台续 magicrew 的 token，同时用户点了「连接」——`renameInto` 的注释就是为它写的。
 *
 * 更糟的是本轮给 `renameInto` 加的 EPERM 重试把竞争窗口从「微秒」拉到 10–630 ms，
 * 实测 gap=0/3/5/8ms 全部丢一条，gap=12ms（超出 10ms 首个退避窗口）才都幸存。
 *
 * 修法：所有写盘走同一条 promise 链，后一个等前一个落盘完成再读文件。
 * 链上任何一环失败都不能卡死后续（用 `.catch(() => {})` 接住再挂下一环）。
 */
// 按目标文件分链：不同 .credentials.yaml 互不排队。
// 单条全局链会让无关文件的写入被慢文件拖住（2026-10-31 审查实测：
// 无关文件基线 1ms，慢文件写入期间被拖到 359–370ms）。
const writeChains = new Map()

/** 把一次写盘排到该文件的链尾，返回它自己的结果/异常（不影响后续排队者）。 */
function serializeWrite(key, task) {
  const prev = writeChains.get(key) ?? Promise.resolve()
  const run = prev.then(task, task)
  // 链本身只用来排队，不传播异常；调用方拿到的是 run。
  writeChains.set(key, run.then(() => undefined, () => undefined))
  return run
}

/**
 * `renameSync` + Windows 的 EPERM 重试。
 *
 * 真机踩过（2026-10-30）：本体在后台续 magicrew 的 token，同时用户点了「连接」，
 * 两条写入路径同时 rename 同一个目标 ⇒ `EPERM: operation not permitted, rename
 * '.credentials.yaml.tmp-34636' -> '.credentials.yaml'`。Windows 上目标文件正被
 * 另一个句柄（杀软扫描、索引器、另一个 rename）短暂占用时就会这样，重试几十毫秒即过。
 *
 * 重试仍失败时删掉临时文件再抛 —— 否则 `%USERPROFILE%\.dsh` 里会积一堆 `.tmp-*`。
 *
 * ⚠️ 退避必须用 `await` + `setTimeout`，**不能用 `Atomics.wait` 同步阻塞**：
 * 这个函数跑在本体容器的 HTTP 网关进程里，一次 set 最坏要退避
 * 10+20+40+80+160+320 = 630 ms，同步阻塞会把整个网关（所有 provider 的请求、
 * 控制台的 RPC）一起卡住 0.6 秒。异步退避期间事件循环照常转，别的请求不受影响。
 */
async function renameInto(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(from, to); return } catch (error) {
      const code = error?.code
      if (attempt >= 6 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
        try { rmSync(from, { force: true }) } catch { /* 尽力而为 */ }
        throw error
      }
      // 退避 10/20/40… ms：Windows 的文件占用通常几十毫秒内消失。
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt))
    }
  }
}

/**
 * 块标量（`KEY: |-` / `KEY: >` 这类）的结束行下标。
 *
 * 块标量是**本体自己写出来的形态**：值里含真换行时 yaml 会序列化成
 * `A: |-` + 缩进更深的续行。原来 `parseRefs` / `writeRefsInto` /
 * `upsertRefsInto` 都只看 `  KEY:` 那一行，于是：
 *   - 追加新 ref 时插在块头与续行之间 ⇒ `A: |-` 后面跟 `  NEW: '…'`、
 *     再后面才是 `    line1` ⇒ 本体 yaml 报 `All mapping items must start at
 *     the same column`，**整份凭据文件读不了**；
 *   - set / unset 块标量 ref 时只换首行，续行成了孤儿 ⇒ 同样非法。
 * 2026-10-31 审查实测三种操作都能复现。所以凡按行处理 refs 段的地方
 * 都要先把它整块吃掉。
 *
 * 续行判据：缩进 >= 3（ref 首行是 2）；块内空行也属于块，但空行之后
 * 若出现浅缩进行，块就结束在最后一个深缩进行。
 */
function isBlankLine(line) {
  return /^ *$/.test(line)
}

function hasContent(line) {
  return /[^ ]/.test(line)
}

function trimYaml(text) {
  return String(text).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '')
}

/**
 * 从条目行 `i` 找到它续行块的最后一行（返回 `i` 表示没有续行）。
 *
 * `skipComments` 决定「缩进不够深的整行注释」算不算块内的行：
 * - **块标量（`|` / `>`）必须传 `false`** —— 块里的 `#` 是**内容**不是注释
 *   （`  A: |` + `    #y` 本体读 `"#y\n"`，跳过就成了空串）。
 * - **裸 key / plain 标量必须传 `true`** —— 注释行不参与标量折叠，但也不会
 *   终止标量：`  A:` + `  # c` + `    l3` 本体读 `"l3"`。不跳过的话 `end === i`，
 *   读侧把值读成空串；写侧更糟 —— `set()` 一条**无关** ref 会把新行插到注释
 *   下面，落盘成 `  A:` / `  # c` / `  Z: 'zzz'` / `    l3`，本体读回
 *   `{"A":null,"Z":"zzz","l3":null}`：真实凭据被改写成 null 还多出假 key
 *   （2026-10-31 七审必修 2，实测）。
 */
function blockScalarEnd(lines, i, skipComments = false) {
  // 续行的门槛是「比条目行更深」，不是写死的 3 个空格。
  // ⚠️ 2026-10-31 五审实测真缺陷：parseRefs 的条目正则放宽成 `[ \t]+` 之后，
  // 这里还硬编码 `/^ {3,}/` 就与它不自洽 —— 条目缩进 3 或 4 个空格时，**同级兄弟
  // ref（缩进 3/4）也满足 `>= 3`**，被当成块标量的续行吞进值里：
  //   `   A: |-` + `       x` + `   B: 'bbb'`  ⇒ 我们读到 `{"A":"    x\nB: 'bbb'"}`
  // 而本体读到 `{"A":"x","B":"bbb"}`。污染值会让 `JSON.parse` 抛错，`src/container.mjs`
  // 的钉号逻辑 catch 之后当成「凭据不可用」⇒ 账号有凭据却登不上（静默）。
  const indent = (/^[ \t]*/.exec(String(lines[i])) ?? [''])[0].length
  const need = new RegExp(`^ {${indent + 1},}`)
  let last = i
  let k = i + 1
  while (k < lines.length) {
    const next = lines[k]
    if (isBlankLine(next)) { k++; continue }
    if (skipComments && /^[ \t]*#/.test(next)) { k++; continue }
    if (!need.test(next)) break
    last = k
    k++
  }
  return last
}

/**
 * 这一行是不是「refs 段到此为止」的边界。
 *
 * 判据：行首无缩进（不是 ref 的 2 空格缩进），且形如 `key:` / `key: value`。
 * ⚠️ 2026-10-31 二审实测真缺陷：原来只认 `/^[A-Za-z_]+\s*:\s*$/`，`x1:` / `x-y:` /
 * `"quoted":` 这类顶层 key 都不匹配 ⇒ 它下面缩进 2 的子 key 被当成 ref。HEAD 遇到
 * 这种「假 ref」是抛错不动文件，而 set 改成 upsert 之后会**把凭据写进那个段**
 * （`x1:\n  y: '...'`），本体 `toJS()` 永远读不到 —— 静默丢凭据，比报错更糟。
 */
function isSectionBoundary(line) {
  if (/^\s/.test(line)) return false          // 有缩进 ⇒ 还是 refs 段里的东西
  if (/^\s*(#|$)/.test(line)) return false    // 空行与注释不构成边界
  return /^[^:\s][^:]*:(\s|$)/.test(line)
}

/**
 * 这一行的值是不是块标量头。
 *
 * YAML 的写法是「缩进指示数字在前、chomping 在后」：`|2-`、`>2+`。
 * ⚠️ 2026-10-31 二审实测真缺陷：原正则 `/^[|>][+-]?\d*\s*$/` 只认 `|-2`（非法写法），
 * 认不出 `|2-`。而本体 yaml 库在**值首行带前导空格**时真会写出 `  A: |2-`
 * （`'  leading\nline2'` ⇒ `|2-`）。认不出它 ⇒ 块头被当成值、续行成孤儿 ⇒
 * set/unset 之后整份凭据文件被本体拒绝（HEAD 是抛错不动文件，属新引入退化）。
 */
function isBlockScalarHead(body) {
  return /^[|>](?:[1-9][+-]?|[+-][1-9]?)?\s*$/.test(body)
}

/** 块头里的缩进指示数字（没有就返回 0）。 */
function blockIndentHint(head) {
  const m = /^[|>]([1-9])/.exec(String(head))
  return m === null ? 0 : Number(m[1])
}

/**
 * 把块标量的续行拼回字符串。
 *
 * 缩进按 YAML 规则剥：有显式缩进指示数字（`|2-`）时剥「ref 缩进 2 + 数字」，
 * 否则按第一条非空续行的缩进（自动缩进就是它）。两种规则在自动缩进下等价，
 * 只有 `|2-` 这类显式指示会不同 —— 而本体会写它。
 */
function blockScalarBody(lines, i, end) {
  const headMatch = /^([ \t]+)[A-Za-z0-9_#.\-{}]+:[ \t]*([\s\S]*)$/.exec(lines[i])
  const head = headMatch === null ? '' : headMatch[2]
  const itemIndent = headMatch === null ? 2 : headMatch[1].length
  const hint = blockIndentHint(head)
  // ⚠️ 但**物理最后一行不算**，不管它长什么样：`split(/\r?\n/)` 的最后一段是
  // 「文件末尾那行之后还有没有空行」的产物 —— 文件以换行结尾时它是个空串，
  // 不结尾时它就是那行本身（可能只剩缩进）。两种都不该计入 `|+` 的 keep，
  // 否则值会多一个换行，resolve→set 就把它永久写进文件（2026-10-31 六审 A 只修了
  // 「以换行结尾」那一半；七审补上另一半：末行只有空格且无尾随换行时同样多读一个）。
  const eof = Math.max(0, lines.length - 1)
  let last = end
  for (let k = end + 1; k < eof && isBlankLine(lines[k]); k++) last = k
  const raw = []
  for (let k = i + 1; k <= last; k++) raw.push(lines[k])
  let cut
  if (hint > 0) {
    // 显式缩进指示数字（`|2-`）剥「条目实际缩进 + 数字」—— 原来硬编码成 2 + hint，
    // 在 1 空格 / 3 空格缩进的 refs 段里会切错（2026-10-31 四审）。
    cut = itemIndent + hint
  } else {
    const indents = raw.filter((l) => hasContent(l)).map((l) => /^ */.exec(l)[0].length)
    // 整块全是空行（`A: |+` 后面只跟一个「只有缩进」的行）时没有可参考的缩进，
    // YAML 规定这种块的内容就是空行本身 ⇒ 全部当空串。若按 cut = 0 切，
    // 那 4 个空格会被当成内容，读回来变成 `'    \n'`。
    cut = indents.length > 0 ? Math.min(...indents) : Number.POSITIVE_INFINITY
  }
  // ⚠️ 判空只能用 `l === ''`，不能用 `l.trim() === ''`：后者会把「整行都是空格」
  // 的内容行也清成空串，`'x\n   '` 这类值读回来就丢了尾部的三个空格。
  // 另一条同样重要的规则：**缩进比 cut 还浅的行等于空行**。`|+` 后跟一个
  // 「只有缩进、没有内容」的行（`    ` + 换行）在 YAML 里就是空行，切 cut 会
  // 切出 `'  '` 甚至负长度，读回来变成一串空格。
  const content = raw.map((l) => (l.length <= cut ? '' : l.slice(cut)))
  // chomping 还原（YAML 规范）：`|+` keep 全部、`|` clip 留一个、`|-` strip 一个不留。
  // 规则是「内容行用 \n 连起来，末尾再加一个行终止符」，所以：
  //   `|+` + ['a','b','']  ⇒ "a\nb\n\n"；`|+` + [''] ⇒ "\n"；`|+` 什么都没有 ⇒ ""
  const chomp = /[|>]\d*([+-])?\s*$/.exec(head)?.[1] ?? ''
  if (chomp === '+') return content.length === 0 ? '' : `${content.join('\n')}\n`
  const trimmed = content.join('\n').replace(/\n+$/, '')
  if (chomp === '-') return trimmed
  return trimmed === '' ? '' : `${trimmed}\n`
}

/**
 * refs 段里条目用的是几个空格缩进（找不到条目时返回 2）。
 *
 * 标准写法是 2 个空格，但 YAML 允许任意一致缩进（1 个、3 个、tab 都合法）。
 * ⚠️ 2026-10-31 三审实测真缺陷：所有写入侧都硬编码 `  ` 前缀，而 `scanRefKeys`
 * 也只认恰好 2 空格 —— 缩进是 1 空格时它返回空集，`upsertRefsInto` 于是认为
 * 「全都不存在」全部走追加，落盘出现重复 key，本体报
 * `All mapping items must start at the same column` ⇒ 整份文件读不了。
 * HEAD 在同一输入上是抛错不动文件，属新引入退化。
 * 现在的策略：**读侧认任意缩进，写侧发现缩进不是 2 就抛错不动文件** ——
 * 宁可拒绝写，也不能把一份本体读得好好的文件写坏。
 */
function refsIndentOf(lines, start) {
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (isSectionBoundary(line)) break
    const m = /^([ \t]+)[A-Za-z0-9_#.\-{}]+:/.exec(line)
    if (m) return m[1]
  }
  return '  '
}

/** 写侧守卫：条目缩进不是 2 空格就拒绝写（见 refsIndentOf 的说明）。 */
function assertStandardIndent(lines, start, what) {
  const indent = refsIndentOf(lines, start)
  if (indent !== '  ') {
    throw new Error(
      `${CRED_BASENAME}: refs 段的条目缩进是 ${JSON.stringify(indent)}，不是标准的两个空格 —— `
      + `拒绝${what}，以免把这份本体读得好好的文件写坏。`
      + `请先把它改成统一的两个空格缩进再重试。`,
    )
  }
}

/**
 * 把一个 ref 编码成文件里的行。
 *
 * 值含换行时写**块标量**（`|-` / `|` / `|+`），不能像以前那样折成空格：
 * ⚠️ 2026-10-31 三审实测真缺陷：四处写入分支都把 `\n` 折成空格，而 PEM 私钥、
 * 多行 JSON 这类值折完之后 yaml 依然合法、本体读回同串 —— **值被悄悄改掉而校验
 * 看不出来**。HEAD 同输入是「写坏文件 + 本体报 Missing closing quote」，两种都错，
 * 但静默改值更难发现。最现实的入口是 `vendor/lib/backup.js:506` 原样写入备份里的
 * 字符串（换机导入会带真换行）。
 *
 * chomping 必须跟着值走，否则「读出来再 set 回去」本身就会改值：
 *   结尾无 `\n`        → `|-`（strip）
 *   结尾恰好一个 `\n`  → `|` （clip）
 *   结尾两个以上 `\n`  → `|+`（keep）
 */
function refLines(key, value) {
  const v = String(value)
  if (!/[\r\n]/.test(v)) return [`  ${key}: '${v.replace(/'/g, "''")}'`]
  // 含换行的值优先写块标量（可读性最好，也是本体自己的写法）。但块标量有四种
  // 表示不了的形态，这时退回双引号 + 转义（单行、完全无损、不涉及 chomping）：
  //   ① 含 `\r`：字面块会把 CRLF 规范成 LF，读回来就变了；
  //   ② 值整体只有换行（去掉尾换行后为空）：`|` 会读成空串、`|+` 靠空行计数易错；
  //   ③ 结尾两个以上换行：`|+` 的尾随空行与文件末尾的空行难以区分；
  //   ④ 某行以空格/制表符开头或结尾：块标量的缩进剥离与「整行空格」判空会吃掉它。
  // 2026-10-31 四审前自查实测：这四种原来都会静默改值。
  const needsQuote =
    /\r/.test(v)
    || v.replace(/\n+$/, '') === ''
    || /\n\n$/.test(v)
    || /^[ \t]/m.test(v)
    || /[ \t]$/m.test(v)
  if (needsQuote) {
    const esc = v
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t')
      // 其余 C0 控制字符一律转成 \xNN，双引号标量里这是合法写法
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
    return [`  ${key}: "${esc}"`]
  }
  // 走到这里：不含 `\r`、去掉尾换行后非空、结尾最多一个换行、没有行首行尾空白。
  // 于是 trailing 只可能是 0 或 1 ⇒ 只会写出 `|-`（strip）与 `|`（clip）两种块头。
  // `|+`（keep）在本函数里不可达（结尾两个以上换行已被 needsQuote 拦去双引号），
  // 但 parseRefs 仍要能读它 —— 本体自己会写 `|+`（见 blockScalarBody）。
  const trailing = (/\n+$/.exec(v) ?? [''])[0].length
  const body = v.replace(/\n+$/, '').split('\n')
  const head = trailing === 0 ? '|-' : '|'
  return [`  ${key}: ${head}`, ...body.map((l) => `    ${l}`)]
}

/**
 * 文本扫 refs 段里**所有** `  KEY:` 行，返回 key 集合。
 *
 * 这是「这个 ref 在不在文件里」的真相源，**不能改用 `parseRefs`**：
 * `parseRefs` 会漏解几种形态（裸 key 无值 `KEY:`、块标量 `KEY: |-` 的值），
 * 漏解就等于「不存在」，`upsertRefsInto` 于是又追加一条同名 key ⇒ 落盘出现
 * 重复 key ⇒ 本体 yaml（`uniqueKeys: true`）报 `Map keys must be unique`，
 * **整份凭据文件读不了**。2026-10-31 审查实测：
 * `refs:\n  EMPTY:\n  A: 'a'` + `set('EMPTY')` 落盘两条 EMPTY。
 */
export function scanRefKeys(text) {
  const lines = text.split(/\r?\n/)
  const out = new Set()
  const start = normalizeRefsHead(lines)
  if (start < 0) return out
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (isSectionBoundary(line)) break
    // 认任意缩进宽度（1 个、3 个、tab 都是合法 YAML）。只认恰好 2 空格时，
    // 非标准缩进的段会返回空集 ⇒ upsertRefsInto 认为「全都不存在」全走追加
    // ⇒ 落盘重复 key ⇒ 本体读不了整份文件。2026-10-31 三审实测。
    const m = /^[ \t]+([A-Za-z0-9_#.\-{}]+):/.exec(line)
    if (m) out.add(m[1])
  }
  return out
}

/**
 * 还原 YAML 双引号标量里的转义序列。
 *
 * 双引号标量是本文件里**唯一能无损表示任意字节**的形态（块标量表示不了 `\r`、
 * 纯换行值、尾随空白），所以 `refLines` 遇到那几类会退回双引号 + 转义。
 * 读侧必须对称地还原，否则 `resolve()` 拿到的是字面量 `\\n`（反斜杠 + n）。
 * 支持的转义按 YAML 规范：`\\0 \\a \\b \\t \\n \\v \\f \\r \\e \\" \\\/ \\\\`、
 * `\\xNN`、`\\uNNNN`、`\\UNNNNNNNN`，以及行尾反斜杠续接（已在上层折行时处理）。
 * 未知转义按规范原样保留反斜杠（`\\q` → `\\q`），不猜。
 */
function unescapeDouble(text) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c !== '\\') { out += c; continue }
    const n = text[i + 1]
    if (n === undefined) { out += '\\'; break }
    const simple = {
      0: '\u0000', a: '\u0007', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\u001b',
      '"': '"', '/': '/', '\\': '\\', ' ': ' ', N: '\u0085', _: '\u00a0', L: '\u2028', P: '\u2029',
    }
    if (Object.prototype.hasOwnProperty.call(simple, n)) { out += simple[n]; i++; continue }
    const hexLen = n === 'x' ? 2 : n === 'u' ? 4 : n === 'U' ? 8 : 0
    if (hexLen > 0) {
      const hex = text.slice(i + 2, i + 2 + hexLen)
      if (hex.length === hexLen && /^[0-9A-Fa-f]+$/.test(hex)) {
        out += String.fromCodePoint(Number.parseInt(hex, 16))
        i += 1 + hexLen
        continue
      }
    }
    out += '\\' + n
    i++
  }
  return out
}

/** 解析 refs 段。支持单行/多行、单引号/双引号、未加引号四种标量形态。 */
// 双引号标量「这一行到底闭合了没有」的判据。
// YAML 里 `\"` 是转义的双引号，`\\"` 才是「字面反斜杠 + 闭合引号」——
// 所以判据是「行尾那个 `"` 前面有**偶数个**反斜杠」，不是「前面那个字符不是反斜杠」。
// 2026-10-31 随机模糊测试实测真缺陷：值 `?|#@>\r]!,"` 落盘成 `  A: "?|#@>\r]!,\""`，
// 行尾是 `""`（转义引号 + 闭合引号），旧判据 `[^"\\]"\s*$` 要求闭合引号前是
// 非引号非反斜杠字符 ⇒ 判成「没闭合」⇒ 解析器继续往下吞行，把紧随其后的
// `records: {}` 整段并进值里（实测读回 `'?|#@>\r]!,"" records: {} '`）。
function quoteClosed(s) {
  const tail = /"\s*$/.exec(s)
  if (tail === null) return false
  let k = tail.index - 1
  let backslashes = 0
  while (k >= 0 && s[k] === '\\') { backslashes++; k-- }
  return backslashes % 2 === 0
}

export function parseRefs(text) {
  const lines = text.split(/\r?\n/)
  const out = new Map()
  const start = normalizeRefsHead(lines)
  if (start < 0) return out
  let i = start + 1
  while (i < lines.length) {
    const line = lines[i]
    // 到 records: 或下一个顶层 key 就停
    if (isSectionBoundary(line)) break
    // ⚠️ 用 `[\s\S]*` 而不是 `.*`：JS 的 `.` 与 `$` 都不匹配 U+2028（行分隔符）
    // 与 U+2029（段分隔符），而它们能原样出现在 YAML 标量里。用 `.` 时整行
    // 匹配失败 ⇒ 那个 ref 从解析结果里消失（`resolve()` 返回 undefined）。
    // 2026-10-31 实测：值 `'x\u2028y'` 落盘后 `parseRefs` 读不到它。
    const m = /^([ \t]+)([A-Za-z0-9_#.\-{}]+):[ \t]*([\s\S]*)$/.exec(line)
    if (!m) { i++; continue }
    const key = m[2]
    const rest = m[3]
    // Block scalar (`A: |-` + indented continuation lines): consume the whole
    // block, value = joined body. Without this, out.set(key, '|-') stores the
    // header as the value and the continuation lines get skipped, and set()
    // on that ref replaces only the header leaving orphan lines behind
    // (the host's yaml parser then rejects the entire credentials file).
    if (isBlockScalarHead(rest)) {
      const end = blockScalarEnd(lines, i)
      out.set(key, blockScalarBody(lines, i, end))
      i = end + 1
      continue
    }
    // Bare key with no value (`EMPTY:`): record as empty string. Previously
    // skipped entirely, so the ref vanished from the parse result and
    // upsertRefsInto treated it as missing and appended a duplicate key.
    if (rest === '') {
      // 裸 key（`A:`）后面可能跟深缩进的续行（`    line1`）或子映射（`    k: v`），
      // 都是合法 YAML。只吃首行会让续行成孤儿，本体报 `Implicit keys need to be on
      // a single line` / `All mapping items must start at the same column` ⇒ 整份
      // 文件读不了（2026-10-31 四审，本轮新引入的退化）。
      const end = blockScalarEnd(lines, i, true)
      if (end === i) {
        out.set(key, '')
        i++
        continue
      }
      // 裸 key 后面跟深缩进的续行，在 YAML 里就是**多行 plain 标量**：
      //   `  A:` + `    line1`  ⇒ 本体读 `"line1"`
      //   `  A:` + `    k: v`   ⇒ 本体读 `{"k":"v"}`（子映射）
      // 原来一律 `out.set(key, '')`，导致「本体有值、我们读成空」——
      // `resolve()` 返回 undefined，那条凭据在插件侧等于不存在（2026-10-31 五审）。
      // 折叠规则与下面的 plain 分支保持一致：相邻非空行折成一个空格，N 个空行折成 N 个换行。
      let value = ''
      let blanks = 0
      for (let k = i + 1; k <= end; k++) {
        // 整行注释不参与标量折叠：本体把 `  A: x` + `    # note` 读成 `"x"`，
        // 折进去就变成 `"x # note"`，resolve→set 写回后永久改值（2026-10-31 六审 B）。
        if (/^[ 	]*#/.test(lines[k])) continue
        const piece = trimYaml(lines[k])
        if (piece === '') { blanks++; continue }
        value += value === '' ? piece : blanks > 0 ? '\n'.repeat(blanks) + piece : ` ${piece}`
        blanks = 0
      }
      out.set(key, value)
      i = end + 1
      continue
    }
    const q = rest[0]
    if (q !== "'" && q !== '"') {
      // plain 标量也可能跨行（`  A: line1` + 缩进续行 `    line2`，合法 YAML）。
      // 只取首行会让 `resolve()` 返回截断值，再 `set()` 回去就把后半截永久丢掉。
      // YAML 的折行规则：续行前导缩进吃掉、行间折成一个空格；空行折成换行。
      // 2026-10-31 三审同类缺陷（set/unset 的孤儿续行）在写入侧已修，读取侧这里补齐。
      // ⚠️ 不传 skipComments：plain 标量已开头（`A: l1`）时，后面一行注释就是
      // 标量的结尾，本体只读 `"l1"`。跳过注释继续吃续行会多读出 `"l1 l3"`。
      const end = blockScalarEnd(lines, i)
      if (end === i) { out.set(key, trimYaml(rest)); i++; continue }
      // YAML 折叠规则：相邻非空行之间折成**一个空格**；N 个连续空行折成 N 个换行。
      let value = trimYaml(rest)
      let blanks = 0
      for (let k = i + 1; k <= end; k++) {
        // 整行注释不参与标量折叠（同上，2026-10-31 六审 B）。
        if (/^[ 	]*#/.test(lines[k])) continue
        const piece = trimYaml(lines[k])
        if (piece === '') { blanks++; continue }
        value += blanks > 0 ? '\n'.repeat(blanks) + piece : ` ${piece}`
        blanks = 0
      }
      out.set(key, value)
      i = end + 1
      continue
    }
    // 单引号闭合判据：行尾**连续单引号个数为奇数**才是真闭合。
    // YAML 单引号标量里 `''` 表示一个字面 `'`，所以：
    //   值 x     → 行尾 '        （1 个，奇）⇒ 闭合
    //   值 x'    → 行尾 '''      （3 个，奇）⇒ 闭合
    //   值 x''   → 行尾 ''''     （5 个，奇）⇒ 闭合
    // ⚠️ 2026-10-30 实测真缺陷：原判据 `!/''\s*$/` 把「行尾两个引号」当成未闭合，
    // 于是值以 `'` 结尾时（行尾 `'''`，正则从末尾先匹配到 `''`）被误判成未闭合 ——
    // 解析器继续往下吞行，把紧随其后的 ref 整条并进本值。
    // 实测：`  A: 'x'''` + 下一行 `  B: 'y'` ⇒ A = "x''   B: 'y'"，B 消失。
    // 走 `vendor/lib/backup.js:506` 原样写入的备份值很容易以引号结尾。
    const isClose = (s) => {
      if (q === '"') return quoteClosed(s)
      const tail = /('+)\s*$/.exec(s)
      return tail !== null && tail[1].length % 2 === 1
    }
    let body = rest.slice(1)
    if (isClose(body)) {
      body = body.replace(new RegExp(`${q}\\s*$`), '')
      // 单行双引号标量同样要还原转义：`refLines` 对含 `\\r` / 纯换行 / 尾随空白的
      // 值就是写这种形态（`  A: "x\\r\\ny"`），不还原的话 `resolve()` 拿到字面量。
      out.set(key, q === "'" ? body.replace(/''/g, "'") : unescapeDouble(body))
      i++
      continue
    }
    // YAML 折行（2026-10-31 二审实测真缺陷）：续行的**前导缩进必须吃掉**。
    // 原来 `parts.push(cur)` 原样压入、`join(' ')` 只补一个空格 ⇒ 真实凭据文件里
    // 24/62 条值多出「\ + 5 个空格」，其中 LOOMY_ACCOUNT_D54BD0DF 的 JSON 直接
    // 解析失败（消费方 vendor/lib/accio-auth.js 等 20+ 处 parseCredential 都返回
    // undefined ⇒ 该账号续期永久失效）。更糟的是「resolve → set 回去」会把脏值
    // 落盘，原本完好的凭据被静默损坏，而 yaml 语法仍然合法、校验看不出来。
    // 双引号标量还支持「行尾反斜杠」续接：那种情况下连空格都不该插。
    const parts = [body]
    let joined
    i++
    let closed = false
    let pending = body
    while (i < lines.length) {
      const cur = lines[i]
      const closes = isClose(cur)
      const piece = closes ? cur.replace(new RegExp(`${q}\\s*$`), '') : cur
      // 双引号标量行尾的单个反斜杠 = 续接（不插空格）
      const escaped = q === '"' && /(^|[^\\])\\$/.test(pending)
      pending = escaped ? pending.slice(0, -1) + piece.replace(/^\s+/, '') : pending + ' ' + piece.replace(/^\s+/, '')
      parts.push(piece)
      if (closes) { i++; closed = true; break }
      i++
    }
    joined = pending
    out.set(key, q === "'" ? joined.replace(/''/g, "'") : unescapeDouble(joined))
    if (!closed) break
  }
  return out
}

/**
 * 定位 refs 段头，并把空的流式映射「refs: {}」归一成「refs:」。
 *
 * 本体把 refs 删空时就写「refs: {}」（流式映射），而下面五处只认裸的
 * 「refs:」。认不出就抛「找不到 refs: 段」—— 写入失败虽然安全（文件不动），
 * 但那一次登录就白登了。归一后下面的行遍历逻辑全部照常工作：
 * 空段的「最后一个完整条目」就是段头自己，新 ref 直接插在它后面。
 *
 * 注意这个函数会**就地改写** `lines`，调用方都是先 split 再遍历、
 * 最后 join 回去，所以改写会一并落盘（这正是需要的）。
 */
function normalizeRefsHead(lines) {
  // 容忍段头带尾注释（`refs:  # 凭据`是合法 YAML，本体读得好好的）。
  // 2026-10-31 实测：只认 `/^refs:\s*$/` 时，带注释的段头会让写入直接抛
  // 「找不到 refs: 段」—— 文件没事，但那次登录白登。
  const RE = /^(refs:)\s*(\{\s*\})?\s*(#.*)?$/
  const i = lines.findIndex((l) => RE.test(l))
  if (i < 0) return -1
  const m = RE.exec(lines[i])
  if (m[2] !== undefined) {
    // 空的流式映射归一成裸段头。注释**不能跟在段头同一行**：
    // 上游 `vendor/lib/jet-hub-store.js` 的 extractCredentialRefNames 用
    // `/^refs:\s*$/` 认段头，带注释就认不出来，那条「从
    // .credentials.yaml 恢复账号」的兜底路径就断了。
    // 所以把注释挪成紧跟的独立注释行（缩进 2，两边都认）。
    lines[i] = 'refs:'
    if (m[3] !== undefined) lines.splice(i + 1, 0, `  ${m[3]}`)
  }
  return i
}

/** 把 refs 写回 .credentials.yaml：只替换值所在行，其余字节原样保留。 */
export function writeRefsInto(text, changed) {
  const lines = text.split(/\r?\n/)
  const start = normalizeRefsHead(lines)
  if (start < 0) throw new Error(`${CRED_BASENAME}: 找不到 refs: 段`)
  assertStandardIndent(lines, start, '写入')
  const out = []
  // refs 段之前原样
  for (let i = 0; i < start + 1; i++) out.push(lines[i])
  let i = start + 1
  const done = new Set()
  while (i < lines.length) {
    const line = lines[i]
    if (isSectionBoundary(line)) break
    // ⚠️ 用 `[\s\S]*` 而不是 `.*`：JS 的 `.` 与 `$` 都不匹配 U+2028（行分隔符）
    // 与 U+2029（段分隔符），而它们能原样出现在 YAML 标量里。用 `.` 时整行
    // 匹配失败 ⇒ 那个 ref 从解析结果里消失（`resolve()` 返回 undefined）。
    // 2026-10-31 实测：值 `'x\u2028y'` 落盘后 `parseRefs` 读不到它。
    const m = /^ {2}([A-Za-z0-9_#.\-{}]+):[ \t]*([\s\S]*)$/.exec(line)
    if (!m) { out.push(line); i++; continue }
    const key = m[1]
    if (!changed.has(key)) { out.push(line); i++; continue }
    // A block-scalar ref must be replaced as a whole block: replacing only
    // the header leaves the continuation lines orphaned, which makes the
    // host's yaml parser reject the entire credentials file.
    if (isBlockScalarHead(m[2])) {
      out.push(...refLines(key, changed.get(key)))
      done.add(key)
      i = blockScalarEnd(lines, i) + 1
      continue
    }
    const q = m[2][0]
    if (q === "'" || q === '"') {
      // 单引号闭合判据：行尾**连续单引号个数为奇数**才是真闭合。
      // YAML 单引号标量里 `''` 表示一个字面 `'`，所以：
      //   值 x     → 行尾 '        （1 个，奇）⇒ 闭合
      //   值 x'    → 行尾 '''      （3 个，奇）⇒ 闭合
      //   值 x''   → 行尾 ''''     （5 个，奇）⇒ 闭合
      // ⚠️ 2026-10-30 实测真缺陷：原判据 `!/''\s*$/` 把「行尾两个引号」当成未闭合，
      // 于是值以 `'` 结尾时（行尾 `'''`，正则从末尾先匹配到 `''`）被误判成未闭合 ——
      // 解析器继续往下吞行，把紧随其后的 ref 整条并进本值。
      // 实测：`  A: 'x'''` + 下一行 `  B: 'y'` ⇒ A = "x''   B: 'y'"，B 消失。
      // 走 `vendor/lib/backup.js:506` 原样写入的备份值很容易以引号结尾。
      const isClose = (s) => {
        if (q === '"') return quoteClosed(s)
        const tail = /('+)\s*$/.exec(s)
        return tail !== null && tail[1].length % 2 === 1
      }
      // ⚠️ j 必须从 i 起算，不能从 i+1 起算（2026-10-28 实测真缺陷）：
      // 值在**首行就闭合**时（绝大多数 ref 都是单行），closed 一开始就是 true，
      // j 保持 i+1，收尾 `i = j + 1` 就变成 i+2 —— 把紧随其后的那个 ref 整段吞掉。
      // 实际踩过：改 CODEARTS_ACCOUNT_92D5F562 时吃掉了下一行的
      // WORKBUDDY_ACCOUNT_6EF844A1，refs 从 47 掉到 46。
      let j = i
      let closed = isClose(m[2].slice(1))
      while (!closed && j + 1 < lines.length) {
        j++
        if (isClose(lines[j])) { closed = true; break }
      }
      // 值用单引号包，内部 ' 转义成 ''。
      // ⚠️ 换行必须折成空格（`/\r\n|\r|\n/g`，含孤立 `\r`）：引号分支原来只转义单引号，
      // 值里的真换行会让写出的标量跨行。它**不会**吞掉相邻 ref（转义后的续行 `isClose`
      // 判未闭合，会一直吞到后续真实行才闭合），但文件里会出现跨行标量、与另外两处
      // 不一致。三处（parseRefs 之外的 writeRefsInto 引号分支、裸标量分支、
      // upsertRefsInto 追加分支）统一成同一个折叠规则。
      out.push(...refLines(key, changed.get(key)))
      done.add(key)
      i = closed ? j + 1 : i + 1
      continue
    }
    // 无引号的裸标量（`DEEPSEEK_API_KEY: sk-…` 这种）。
    // ⚠️ 2026-10-30 实测真缺陷：原实现这里直接 `out.push(line); i++`，
    // 既没写新值也没标 done，收尾就抛「未找到要更新的 ref」——
    // 本机 .credentials.yaml 里 64 个 ref 中有 3 个是裸标量
    // （DEEPSEEK_API_KEY / MAGPIE_GATEWAY_KEY / DSH_QQBOT_APP_SECRET_…），
    // 它们永远改不了。裸标量必然是单行（YAML 折行只对引号标量成立），
    // 所以直接整行替换成单引号形态 —— 值里若有 `#` `:` 之类字符，
    // 加了引号反而更安全。
    //
    // ⚠️ 换行必须先折成空格，与下面 `upsertRefsInto` 的追加分支逐字对齐
    // （2026-10-30 审查发现）：只转义单引号、不折换行时，值里的真换行会让写出的
    // 单引号标量跨行，后续行被 `parseRefs` 当成续行折叠 —— 实测
    // `set('MAGPIE_GATEWAY_KEY', 'evil\n  MAGICREW_ACCESS_TOKEN: \'PWNED\'')`
    // 会把紧随其后的真实凭据 MAGICREW_ACCESS_TOKEN 整条吞掉。
    // 上游多数 set 走 `JSON.stringify()`（无真换行），但 `vendor/lib/backup.js:506`
    // 是原样写入备份里的字符串，换机导入/手改过的备份都可能带真换行。
    // ⚠️ 换行折叠必须是 `/\r\n|\r|\n/g`，不能是 `/\r?\n/g`（2026-10-30 二审发现）：
    // 后者折不了**孤立 `\r`**（老式 Mac 换行、手改过的备份里常见）。残留的裸 `\r` 会让
    // `parseRefs` 的 `split(/\r?\n/)` 把整行当一行、`isClose` 判不闭合 ⇒ 这条 ref 从
    // 解析结果里彻底消失（`resolve` 返回 undefined，`unset` 也救不回，因为文件里那行还在）。
    // 旧版同一输入是抛错不写入，所以「写进去但读不出来」是行为退化，不是等价重构。
    // ⚠️ 多行 plain 标量（`  A: line1` + 缩进续行 `    line2`）是**合法 YAML**，
    // 而这里只吃首行 ⇒ 续行成孤儿，本体报 `Implicit keys need to be on a single
    // line` / `All mapping items must start at the same column` ⇒ 整份文件读不了。
    // 2026-10-31 三审实测（本轮新引入：HEAD 的 set 走 writeRefsInto 抛错不动文件）。
    // plain 续行的判据与块标量一致（缩进 >= 3），所以直接复用 blockScalarEnd。
    out.push(...refLines(key, changed.get(key)))
    done.add(key)
    // ⚠️ 这里同样要按「裸 key / plain 标量」分流传 skipComments（2026-10-31 审查发现，本轮漏传）：
    // 裸 key（`A:`）后面的同级注释不是续行，要跳过去找真正的续行；
    // plain 标量（`A: l1`）已经开头，后面出现注释本身就是非法 YAML，不能跳。
    i = blockScalarEnd(lines, i, m[2] === '') + 1
    continue
  }
  for (let k = i; k < lines.length; k++) out.push(lines[k])
  for (const [k, v] of changed) {
    if (done.has(k)) continue
    throw new Error(`${CRED_BASENAME}: 未找到要更新的 ref ${k}`)
  }
  return out.join('\n')
}

/**
 * 从 refs 段整条删掉若干 ref（连同它的续行）。
 *
 * 为什么不写成空值：本体自己的 `unset` 是 `deleteSectionEntry(document, "refs", ref)`
 * —— 整条删 key；本体 `set` 还明确拒绝空值（`an empty value cannot be stored for
 * "${ref}"; use unset`）。插件侧原来写 `KEY: ''`，语义上等价（`resolve` 都返回
 * undefined），但会在文件里留下一条空壳记录：真机调试时 `MAGICREW_ACCOUNT_*` 这种
 * 一次性 ref 被 unset 后全是空值行，得手工清。删掉更干净，也和本体契约一致。
 */
export function deleteRefsFrom(text, names) {
  const drop = new Set([...names].map(String))
  if (drop.size === 0) return text
  const lines = text.split(/\r?\n/)
  const start = normalizeRefsHead(lines)
  if (start < 0) return text
  assertStandardIndent(lines, start, '删除')
  const out = lines.slice(0, start + 1)
  let i = start + 1
  while (i < lines.length) {
    const line = lines[i]
    if (isSectionBoundary(line)) break
    // ⚠️ 用 `[\s\S]*` 而不是 `.*`：JS 的 `.` 与 `$` 都不匹配 U+2028（行分隔符）
    // 与 U+2029（段分隔符），而它们能原样出现在 YAML 标量里。用 `.` 时整行
    // 匹配失败 ⇒ 那个 ref 从解析结果里消失（`resolve()` 返回 undefined）。
    // 2026-10-31 实测：值 `'x\u2028y'` 落盘后 `parseRefs` 读不到它。
    const m = /^ {2}([A-Za-z0-9_#.\-{}]+):[ \t]*([\s\S]*)$/.exec(line)
    if (!m) { out.push(line); i++; continue }
    if (!drop.has(m[1])) { out.push(line); i++; continue }
    // 整条跳过：块标量与多行 plain 吃到底，引号标量吃到闭合行，其余只吃这一行。
    // ⚠️ 多行 plain 标量（`  A: line1` + `    line2`）是合法 YAML，只吃首行会
    // 留下孤儿续行，本体报 `Implicit keys need to be on a single line` ⇒ 整份
    // 文件读不了。2026-10-31 三审实测（本轮新引入）。
    let end = i
    if (isBlockScalarHead(m[2])) {
      end = blockScalarEnd(lines, i)
    } else if ((m[2] === '' || (m[2][0] !== "'" && m[2][0] !== '"')) && blockScalarEnd(lines, i, m[2] === '') > i) {
      // ⚠️ 这里**不能**传 skipComments：plain 标量已经开头（`A: l1`）时，
      // 后面一行注释就是标量的结尾 —— 本体读 `{"A":"l1"}`（且报
      // `All mapping items must start at the same column`），跳过注释继续吃续行反而与本体不一致。
      // 只有**裸 key**（`A:` 后面没有任何值）才跳注释。
      // plain 标量（无引号）：续行缩进 >= 3 时整块吃
      end = blockScalarEnd(lines, i, m[2] === '')
    } else {
      const q = m[2][0]
      if (q === "'" || q === '"') {
        const isClose = (s) => {
          if (q === '"') return quoteClosed(s)
          const tail = /('+)\s*$/.exec(s)
          return tail !== null && tail[1].length % 2 === 1
        }
        let j = i
        let closed = isClose(m[2].slice(1))
        while (!closed && j + 1 < lines.length) {
          j++
          if (isClose(lines[j])) { closed = true; break }
        }
        if (closed) end = j
      }
    }
    i = end + 1
  }
  for (let k = i; k < lines.length; k++) out.push(lines[k])
  return out.join('\n')
}

/**
 * 把 refs 写回 .credentials.yaml，**允许新增 ref**。
 *
 * `writeRefsInto` 只改已存在的 ref（找不到就抛错），那是运行时 token 续期的
 * 正确语义 —— 续期不该凭空造出一个 ref。但导入备份时必须能落地本机从来没有
 * 过的 ref（换机、换账号池都是从零开始的），所以这里补一层「没有就追加」：
 *
 *  - 已存在的 ref 交给 `writeRefsInto` 走原有逻辑（保留其余字节原样）；
 *  - 新增的 ref 插在 refs 段的**末尾**（紧跟最后一个 ref，`records:` 之前）。
 *
 * 值里的换行一律折成空格：JSON 字符串内部的裸换行只可能是排版空白
 * （真正的换行在 JSON 里是 `\n` 两个字符），折行后 JSON 依然合法，
 * 而 refs 段保持「一个 ref 一行」的可读形态。
 */
export function upsertRefsInto(text, changed) {
  // Existence must come from scanRefKeys (text scan), not parseRefs
  // (verified by review 2026-10-31): parseRefs misses the "bare key with no
  // value" and "block scalar" shapes, and a miss reads as "not present", so
  // a duplicate key gets appended -> the host's yaml (uniqueKeys: true)
  // reports `Map keys must be unique` and the ENTIRE credentials file
  // becomes unreadable. HEAD's failure mode was only "this one ref cannot be
  // updated, throw without writing", which is strictly milder.
  const keys = scanRefKeys(text)
  const existing = new Map()
  const added = new Map()
  for (const [k, v] of changed) (keys.has(k) ? existing : added).set(k, v)
  if (added.size === 0) return writeRefsInto(text, existing)

  const withExisting = existing.size > 0 ? writeRefsInto(text, existing) : text
  const lines = withExisting.split(/\r?\n/)
  const start = normalizeRefsHead(lines)
  if (start < 0) throw new Error(`${CRED_BASENAME}: 找不到 refs: 段`)
  assertStandardIndent(lines, start, '新增')

  // 找 refs 段里最后一个**完整条目**的结束行：遇 records: / 下一个顶层 key /
  // 文件尾就停。
  //
  // ⚠️ 不能只记「以两个空格 + ref 名开头的行」（2026-10-29 实测真缺陷）：
  // 值可能是跨多行的单引号标量（本机真实文件里 `BUDDY_ACCOUNT_49872581` 就跨 3 行），
  // 续行不以 `  KEY:` 开头。只记首行会把新 ref 插进标量首行与续行**之间**，
  // 把值劈成两半 —— JSON 由合法变非法，且新 ref 也没落地。
  // 实际踩过：拿真实 .credentials.yaml 副本 + 1 条新 ref 跑，BUDDY 的值从
  // 2864 字符掉到 2729，`✗ 凭据写回校验失败`。换机导入恰恰全是新增 ref，
  // 必然触发。所以这里套用与 `writeRefsInto` 完全相同的引号闭合判定。
  let end = start + 1
  let lastEntry = start
  while (end < lines.length) {
    const line = lines[end]
    if (isSectionBoundary(line)) break
    // ⚠️ 用 `[\s\S]*` 而不是 `.*`：JS 的 `.` 与 `$` 都不匹配 U+2028（行分隔符）
    // 与 U+2029（段分隔符），而它们能原样出现在 YAML 标量里。用 `.` 时整行
    // 匹配失败 ⇒ 那个 ref 从解析结果里消失（`resolve()` 返回 undefined）。
    // 2026-10-31 实测：值 `'x\u2028y'` 落盘后 `parseRefs` 读不到它。
    const m = /^ {2}([A-Za-z0-9_#.\-{}]+):[ \t]*([\s\S]*)$/.exec(line)
    if (!m) {
      // 段内的注释行不算条目，但新 ref 要插在它**后面**——否则
      // 「refs: {}」归一时挪走的那行注释会被挤到新凭据下面，读起来像在注释新凭据。
      if (/^\s*#/.test(line)) lastEntry = end
      end++
      continue
    }
    // Skip a whole block scalar: matching only the header would insert the
    // new ref between the header and its continuation lines, producing YAML
    // the host cannot parse.
    if (isBlockScalarHead(m[2])) {
      lastEntry = blockScalarEnd(lines, end)
      end = lastEntry + 1
      continue
    }
    // 多行 plain 标量（`  A: line1` + `    line2`，合法 YAML）也要整块跳过，
    // 否则新 ref 会被插进标量首行与续行之间，把值劈成两半。2026-10-31 三审实测。
    if ((m[2] === '' || (m[2][0] !== "'" && m[2][0] !== '"')) && blockScalarEnd(lines, end, m[2] === '') > end) {
      lastEntry = blockScalarEnd(lines, end, m[2] === '')
      end = lastEntry + 1
      continue
    }
    let closeAt = end
    const q = m[2][0]
    if (q === "'" || q === '"') {
      // 单引号闭合判据：行尾**连续单引号个数为奇数**才是真闭合。
      // YAML 单引号标量里 `''` 表示一个字面 `'`，所以：
      //   值 x     → 行尾 '        （1 个，奇）⇒ 闭合
      //   值 x'    → 行尾 '''      （3 个，奇）⇒ 闭合
      //   值 x''   → 行尾 ''''     （5 个，奇）⇒ 闭合
      // ⚠️ 2026-10-30 实测真缺陷：原判据 `!/''\s*$/` 把「行尾两个引号」当成未闭合，
      // 于是值以 `'` 结尾时（行尾 `'''`，正则从末尾先匹配到 `''`）被误判成未闭合 ——
      // 解析器继续往下吞行，把紧随其后的 ref 整条并进本值。
      // 实测：`  A: 'x'''` + 下一行 `  B: 'y'` ⇒ A = "x''   B: 'y'"，B 消失。
      // 走 `vendor/lib/backup.js:506` 原样写入的备份值很容易以引号结尾。
      const isClose = (s) => {
        if (q === '"') return quoteClosed(s)
        const tail = /('+)\s*$/.exec(s)
        return tail !== null && tail[1].length % 2 === 1
      }
      let j = end
      let closed = isClose(m[2].slice(1))
      while (!closed && j + 1 < lines.length) {
        j++
        if (isClose(lines[j])) { closed = true; break }
      }
      // 引号没闭合说明文件本身是坏的，退回「插在首行后」不再往下吞。
      if (closed) closeAt = j
    }
    lastEntry = closeAt
    end = closeAt + 1
  }

  const fresh = []
  for (const [k, v] of added) fresh.push(...refLines(k, v))
  const out = [...lines.slice(0, lastEntry + 1), ...fresh, ...lines.slice(lastEntry + 1)]
  return out.join('\n')
}

/** 读写 .credentials.yaml 的凭据服务实现。 */
export class FileCredentialProvider extends Service {
  constructor(ctx, options = {}) {
    super(ctx, 'credentials')
    // home 是用户家目录（本体内部自己拼 `.dsh/`），也接受直接指向 `.dsh` 的写法。
    const base = options.file
      ? options.file
      : (() => {
          const home = options.home ?? homedir()
          return /[\\/]\.dsh$/i.test(home)
            ? join(home, CRED_BASENAME)
            : join(home, '.dsh', CRED_BASENAME)
        })()
    this.file = base
    this._refs = undefined
    this._raw = undefined
  }

  _load() {
    if (this._refs !== undefined) return
    this._raw = readFileSync(this.file, 'utf8')
    this._refs = parseRefs(this._raw)
  }

  async resolve(ref) {
    this._load()
    const raw = this._refs.get(String(ref))
    if (raw === undefined || raw === '') return undefined // 空值视为未配置（seam 规则）
    return { value: raw }
  }

  async describe(ref) {
    this._load()
    const ok = (this._refs.get(String(ref)) ?? '') !== ''
    return { configured: ok, present: ok }
  }

  /**
   * 唯一写入路径：读-改-写 + 原子备份。
   *
   * ⚠️ 必须允许新增 ref（走 `upsertRefsInto`，不是 `writeRefsInto`）。
   * 2026-10-30 真机报障：超级麦吉网页登录成功、插件却一直显示「请在浏览器中完成登录」。
   * 根因就在这里 —— 本体给新账号写凭据用的是**全新的** ref（`MAGICREW_ACCOUNT_963C771C`
   * 这种，每次新建随机生成），而 `writeRefsInto` 只改已存在的 ref、找不到就抛
   * `未找到要更新的 ref`。那条错误把 `account.create` 整个打断：账号占位留在池里、
   * 凭据没落地、`login.poll` 永远 `done:false` ⇒ magpie 侧状态卡在 waiting。
   *
   * 受害面不止 magicrew：25 家的 `account.create` 全都走
   * `credentials.set(credentialRef(refName), …)` 写新 ref（`vendor/lib/*-auth.js` 里 20+ 处），
   * 任何「本机第一次登录这家」都会炸。
   *
   * 为什么不是 `writeRefsInto`：它的严格语义只对**运行时 token 续期**是对的
   * （续期不该凭空造 ref）。续期走 `modifyRecord`，先 `resolve` 再写，ref 必然已存在，
   * 所以放宽 `set` 不会让续期路径造出幽灵 ref。
   */
  async set(ref, value) {
    const name = String(ref)
    this._load()
    // 整段读-改-写排进串行链：并发 set 不再各自拿旧快照覆盖对方（见 serializeWrite 注释）。
    await serializeWrite(this.file, async () => {
      const raw = readFileSync(this.file, 'utf8')
      const next = upsertRefsInto(raw, new Map([[name, String(value)]]))
      // ⚠️ `.bak` 只是装饰（全仓库只写不读），不能因为备份失败就拒绝写凭据
      // —— 只读文件/被杀软占住时 `copyFileSync` 会抛 EPERM，凭据就白丢了。
      try { if (existsSync(this.file)) copyFileSync(this.file, `${this.file}.bak`) } catch { /* 尽力而为 */ }
      // tmp 名字带自增序号：同一进程里两个并发 set（两家 provider 同时续期）不会撞同一个临时文件
      const tmp = `${this.file}.tmp-${process.pid}-${(writeSeq += 1)}`
      writeFileSync(tmp, next, 'utf8')
      await renameInto(tmp, this.file) // 原子替换：崩溃不会留下半个文件
      this._refs = parseRefs(next)
      this._raw = next
    })
    this.notifyUpdated?.(ref)
  }

  /**
   * 清空一个 ref 的值。
   *
   * ref 本来就不存在时**什么都不做**：`set` 现在允许新增，若不拦住，
   * `unset('NO_SUCH_REF')` 会在 refs 段里凭空长出一条空值记录。本体在
   * 「判重命中、把凭据搬到已存在账号」的分支里会 unset 刚生成的临时 ref，
   * 那种 ref 有时压根没写过。
   */
  async unset(ref) {
    const name = String(ref)
    // ⚠️ 判存在性必须读**文件**，不能用 `this._refs`（2026-10-30 实测真缺陷）。
    // `_refs` 是进程内缓存、只在第一次 `_load()` 时填；而每个 provider 容器各有
    // 一个 FileCredentialProvider 实例，A 实例写入的新 ref 对 B 实例的缓存不可见，
    // 用户手改文件同理。缓存过期时这里会误判「ref 不存在」直接 return，
    // 而调用方（`account-pool.js` 的 `removeAccount`、officeace/magicrew 的
    // 「判重命中后回收临时 ref」）指望 unset 清掉值 —— 漏掉就是永不清除的孤儿凭据。
    // 实测：文件里补一条 B 后调 unset('B')，缓存里没有 B ⇒ B 原样留在文件里。
    // 判存在性放在链内（2026-10-31 审查）：链外先判、再排队写，中间别的写者
    // 可能已经改了文件，判据就过期了（TOCTOU）。判据本身用 scanRefKeys
    // （文本扫）而不是 parseRefs —— 后者漏解裸 key 与块标量。
    await serializeWrite(this.file, async () => {
      const raw = readFileSync(this.file, 'utf8')
      if (!scanRefKeys(raw).has(name)) return
      // 整条删掉，不写空值（见 deleteRefsFrom 的说明）。
      const next = deleteRefsFrom(raw, [name])
      try { if (existsSync(this.file)) copyFileSync(this.file, `${this.file}.bak`) } catch { /* best effort */ }
      const tmp = `${this.file}.tmp-${process.pid}-${(writeSeq += 1)}`
      writeFileSync(tmp, next, 'utf8')
      await renameInto(tmp, this.file)
      this._refs = parseRefs(next)
      this._raw = next
    })
    this.notifyUpdated?.(ref)
  }

  /** token refresh 的读-决定-替换：整段替换该 ref。 */
  async modifyRecord(ref, fn) {
    const cur = await this.resolve(ref)
    const next = await fn(cur)
    if (next === undefined) return
    await this.set(ref, next.value)
  }

  /** 供插件内部遍历用。 */
  listRefs() {
    this._load()
    return [...this._refs.keys()]
  }
}
