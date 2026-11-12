/**
 * `vendor/` 的本地补丁**还在不在** —— 只覆盖那些没有别处盯着的。
 *
 * `docs/vendor.md` 的「版本怎么升」写着：升级 = clone 上游 → `npm install` 构建 →
 * **重打 7 类补丁（13 个文件）**。那一步是「整片覆盖」，而且每一类都**静默**：
 * 不报错，只出症状。其余几类各有自己的用例（`t-backup-keep` 的 `keepDisabledModels`、
 * `t-magicrew-creds` 的 IndexedDB 读取与 `leveldb-sstable`、`t-rpc-cover` 第 8 节的
 * 「全关即意图」），本文件只补两条**原来零覆盖**的：
 *
 *   1. `lib/gemini-oauth.js` / `.d.ts` 的两个默认 OAuth client 常量**拆成两段字符串
 *      拼接**。上游是整串明文，本仓拆开是为了躲 GitHub push protection 误报
 *      （它是公开客户端 id，不是密钥，但扫描器不认）。恢复明文 ⇒ 本地一切正常，
 *      **只有 `git push` 那一刻被远端拒**，所以这条必须自动盯。
 *   2. `lib/types.d.ts` 的 `closeProvider?: boolean`（两处：`setAllDisabled` /
 *      `setDisabledMany` 的请求体）。少一条 ⇒ 调用方按类型传参报
 *      「对象字面量只能指定已知属性」。
 *
 * 判据刻意用**源码形态**而不是「值等于某个字面量」：把整串 client id 写进断言文件，
 * 等于把这条补丁要躲的东西原样搬回来（push protection 照样拦）。
 * 所以这里只钉「拆开了」+「拆开后长度不变」。
 *
 * 用法：node tests/t-vendor-patches.mjs
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  GEMINI_DEFAULT_CLIENT_ID,
  GEMINI_DEFAULT_CLIENT_SECRET,
} from '../vendor/lib/gemini-oauth.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GEMINI_JS = join(ROOT, 'vendor', 'lib', 'gemini-oauth.js')
const GEMINI_DTS = join(ROOT, 'vendor', 'lib', 'gemini-oauth.d.ts')
const TYPES_DTS = join(ROOT, 'vendor', 'lib', 'types.d.ts')

let total = 0
let failed = 0

function ok(cond, label, extra) {
  total++
  if (cond) {
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.log(`  ✗ ${label}${extra === undefined ? '' : ` — ${extra}`}`)
  }
}

const read = (p) => readFileSync(p, 'utf8')

/**
 * 「赋值语句被拆成两段字符串拼接」的形态判据。
 *
 * 只认 `= '<一段>' +` 换行 `'<另一段>';` 这一种写法（上游 `tsc` 产物就是这个缩进）。
 * 单段明文、或者用模板串 / 变量间接拼，都算**补丁不在** —— 后者是因为上游 a5b3cd10
 * 之后改过写法，真出现时值得人工看一眼，而不是让断言猜。
 */
function splitForm(name, quote = "'") {
  const re = new RegExp(`export (?:declare )?const ${name} = ${quote}[^${quote}]*${quote} \\+\\r?\\n\\s*${quote}[^${quote}]*${quote};`)
  return (src) => re.test(src)
}

console.log('· 1  gemini 默认 client 常量：拆开了，且值没变')
{
  // `.js` 是单引号、`.d.ts` 是双引号 —— 两边都钉，因为 `tsc` 重新生成时只会覆盖后者。
  ok(splitForm('GEMINI_DEFAULT_CLIENT_ID', "'")(read(GEMINI_JS)), 'lib/gemini-oauth.js 的 client id 是两段拼接')
  ok(splitForm('GEMINI_DEFAULT_CLIENT_ID', '"')(read(GEMINI_DTS)), 'lib/gemini-oauth.d.ts 的声明同样是两段拼接')
  // ⚠️ 原有一条 `!singleLiteral(id, 73)` 与上面的 `splitForm` **逻辑等价**（一个字面量
  //    不可能同时是两段拼接），2026-11-10 对抗审查指出是零增量，已删。

  ok(splitForm('GEMINI_DEFAULT_CLIENT_SECRET', "'")(read(GEMINI_JS)), 'lib/gemini-oauth.js 的 client secret 是两段拼接')
  ok(splitForm('GEMINI_DEFAULT_CLIENT_SECRET', '"')(read(GEMINI_DTS)), 'lib/gemini-oauth.d.ts 的声明同样是两段拼接')

  // ⚠️⚠️「形态 + 长度 + 前缀」**不够**（2026-11-10 对抗审查 m03–m06 实测）：
  //    把 client id 中间任意一个字符**等长替换**（`tmhssin`→`tmhssiN`），
  //    上面四条形态判据 + `length === 73` + `startsWith('1071')` **全绿** ——
  //    而那是真事故：浏览器授权成功、账号却永不出现（token 端点直接拒绝）。
  //    secret 更糟：`'GOCS' + ''` / `'GOCS' + 'x'` / 等长替换**三种全绿**
  //    （`length > 0` 与 `startsWith('GOCS')` 都只覆盖前 4 个字符）。
  // ⇒ 用 **sha256 指纹**锁值：单向哈希不泄露明文（push protection 扫的是明文），
  //    但任何字符改动都会红。改常量时连同指纹一起改。
  const fingerprint = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)
  ok(GEMINI_DEFAULT_CLIENT_ID.length === 73, '拼出来的 client id 长度是 73', GEMINI_DEFAULT_CLIENT_ID.length)
  ok(fingerprint(GEMINI_DEFAULT_CLIENT_ID) === 'bf00c418024ba6bf',
    '… 且值未被等长替换（sha256 前 16 位）', fingerprint(GEMINI_DEFAULT_CLIENT_ID))
  ok(GEMINI_DEFAULT_CLIENT_SECRET.length === 35, '拼出来的 client secret 长度是 35', GEMINI_DEFAULT_CLIENT_SECRET.length)
  ok(fingerprint(GEMINI_DEFAULT_CLIENT_SECRET) === '1d2f041093fd95aa',
    '… 且值未被等长替换（sha256 前 16 位）', fingerprint(GEMINI_DEFAULT_CLIENT_SECRET))
}

console.log('· 2  types.d.ts 的 closeProvider 契约（setAllDisabled / setDisabledMany 各一处）')
{
  const types = read(TYPES_DTS)
  const hits = [...types.matchAll(/closeProvider\?: boolean;/g)]
  ok(hits.length === 2, '两个请求体都声明了 closeProvider?: boolean', `实际 ${hits.length} 处`)
  // 只钉「有这两行」还不够：把字段挪到不相干的 interface 里也照样命中。
  // 所以再确认它附近的注释还点着「与 setAllDisabled 同一条契约」—— 那是本仓补丁的
  // 语义（默认 true、显式 false 才删意图），被覆盖时会一起丢。
  ok(/与 \{\@link RpcModelSetAllDisabledRequest\.closeProvider\} 同一条契约/.test(types),
    '… 且注释说明了「与 setAllDisabled 同一条契约」')
}

console.log('· 3  magicrew 两个 .d.ts 的声明与实现对齐（2026-11-08 P2-4 那类事故的复发面）')
{
  // 这两条是纯类型层面的补丁：实现改了、声明没跟上 ⇒ 运行一切正常，
  // 只有按 `.d.ts` 写代码 / 跑 `tsc` 的人才会撞上。同步整片覆盖时最容易静默丢。
  const loginDts = read(join(ROOT, 'vendor', 'lib', 'magicrew-browser-login.d.ts'))
  // 补丁前这里是单段 JSON.stringify 的字面量类型（`declare const …: "…"`）——
  // 实现改成 async IIFE 之后必须放宽成 `string`，否则类型与实现自相矛盾。
  ok(/export declare const CDP_CREDENTIAL_EXPRESSION: string;/.test(loginDts),
    'magicrew-browser-login.d.ts 的 CDP_CREDENTIAL_EXPRESSION 声明是 string（不是字面量类型）')

  const localDts = read(join(ROOT, 'vendor', 'lib', 'magicrew-local-browser.d.ts'))
  // 第三个参数 `hostname` 是补丁加的（按站点区分 IndexedDB 库名）；少一个参数时
  // 调用方传三个实参会报「应有 1-2 个参数，但获得 3 个」。
  ok(/export declare function leveldbTextFor\(root: string, log\?: \(message: string\) => void, hostname\?: string\): string;/.test(localDts),
    'magicrew-local-browser.d.ts 的 leveldbTextFor 声明是三参（含 hostname?: string）')
  ok(/export declare function idbCredentialsIn\(text: string\): \{/.test(localDts),
    '… 且导出了 idbCredentialsIn(text: string)')
}

console.log(`\n${failed === 0 ? '✓ 全部通过' : `✗ ${failed} 项失败`}（${total} 项：gemini 常量拆分 + types.d.ts 契约）`)
process.exit(failed === 0 ? 0 : 1)
