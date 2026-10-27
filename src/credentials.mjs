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
import { readFileSync, writeFileSync, copyFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const CRED_BASENAME = '.credentials.yaml'

/** 解析 refs 段。支持单行/多行、单引号/双引号、未加引号四种标量形态。 */
export function parseRefs(text) {
  const lines = text.split(/\r?\n/)
  const out = new Map()
  const start = lines.findIndex((l) => /^refs:\s*$/.test(l))
  if (start < 0) return out
  let i = start + 1
  while (i < lines.length) {
    const line = lines[i]
    // 到 records: 或下一个顶层 key 就停
    if (/^\s*records:\s*$/.test(line) || /^[A-Za-z_]+\s*:\s*$/.test(line)) break
    const m = /^ {2}([A-Za-z0-9_#.\-{}]+):\s*(.*)$/.exec(line)
    if (!m) { i++; continue }
    const key = m[1]
    const rest = m[2]
    if (rest === '') { i++; continue }
    const q = rest[0]
    if (q !== "'" && q !== '"') { out.set(key, rest.trim()); i++; continue }
    const isClose = (s) => (q === "'" && /(^|[^'])'\s*$/.test(s) && !/''\s*$/.test(s))
      || (q === '"' && /[^"\\]"\s*$/.test(s))
    let body = rest.slice(1)
    if (isClose(body)) {
      body = body.replace(new RegExp(`${q}\\s*$`), '')
      out.set(key, q === "'" ? body.replace(/''/g, "'") : body)
      i++
      continue
    }
    const parts = [body]
    i++
    let closed = false
    while (i < lines.length) {
      const cur = lines[i]
      if (isClose(cur)) { parts.push(cur.replace(new RegExp(`${q}\\s*$`), '')); i++; closed = true; break }
      parts.push(cur); i++
    }
    // YAML 折行：换行折叠成空格，再反转义
    const joined = parts.join(' ')
    out.set(key, q === "'" ? joined.replace(/''/g, "'") : joined.replace(/\\"/g, '"'))
    if (!closed) break
  }
  return out
}

/** 把 refs 写回 .credentials.yaml：只替换值所在行，其余字节原样保留。 */
export function writeRefsInto(text, changed) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => /^refs:\s*$/.test(l))
  if (start < 0) throw new Error(`${CRED_BASENAME}: 找不到 refs: 段`)
  const out = []
  // refs 段之前原样
  for (let i = 0; i < start + 1; i++) out.push(lines[i])
  let i = start + 1
  const done = new Set()
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*records:\s*$/.test(line) || /^[A-Za-z_]+\s*:\s*$/.test(line)) break
    const m = /^ {2}([A-Za-z0-9_#.\-{}]+):\s*(.*)$/.exec(line)
    if (!m) { out.push(line); i++; continue }
    const key = m[1]
    if (!changed.has(key)) { out.push(line); i++; continue }
    const q = m[2][0]
    if (q === "'" || q === '"') {
      const isClose = (s) => (q === "'" && /(^|[^'])'\s*$/.test(s) && !/''\s*$/.test(s))
        || (q === '"' && /[^"\\]"\s*$/.test(s))
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
      // 值用单引号包，内部 ' 转义成 ''
      const v = changed.get(key).replace(/'/g, "''")
      out.push(`  ${key}: '${v}'`)
      done.add(key)
      i = closed ? j + 1 : i + 1
      continue
    }
    out.push(line); i++
  }
  for (let k = i; k < lines.length; k++) out.push(lines[k])
  for (const [k, v] of changed) {
    if (done.has(k)) continue
    throw new Error(`${CRED_BASENAME}: 未找到要更新的 ref ${k}`)
  }
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

  /** 唯一写入路径：读-改-写 + 原子备份。 */
  async set(ref, value) {
    const name = String(ref)
    this._load()
    const raw = readFileSync(this.file, 'utf8')
    const next = writeRefsInto(raw, new Map([[name, String(value)]]))
    if (existsSync(this.file)) copyFileSync(this.file, `${this.file}.bak`)
    const tmp = `${this.file}.tmp-${process.pid}`
    writeFileSync(tmp, next, 'utf8')
    renameSync(tmp, this.file) // 原子替换：崩溃不会留下半个文件
    this._refs = parseRefs(next)
    this._raw = next
    this.notifyUpdated?.(ref)
  }

  async unset(ref) {
    await this.set(ref, '')
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
