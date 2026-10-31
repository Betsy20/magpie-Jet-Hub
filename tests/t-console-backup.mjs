/**
 * 控制台「导入加壳备份」的回归测试。
 *
 * 背景：dsh-providers-hub 的备份可以选加一层壳（PBKDF2-SHA256 310000 轮 +
 * AES-256-GCM，密文尾部 16 字节是 tag）。CLI 的 `scripts/import-backup.mjs`
 * 一直认它，但控制台的「备份 → 导入」只认不加壳的，用户拿加壳备份来导入只会
 * 看到「不是 dsh-codearts-auth/backup 备份文件（format=…encrypted）」。
 *
 * 2026-10-31 补上：页面加「备份口令」框，`doImport` 里先解密再校验格式。
 * 这里验两件事 ——
 *   1. 解密是**行为级**正确的：用 Node 侧同一套参数造容器，能解开、错口令会拒；
 *   2. `doImport` 的分支**接线**没接反：加壳先解密、格式不对要拒、口令空要直说。
 *
 * 判据取自 `console/console.js` 源码文本（`new Function` 求值），不是复制粘贴。
 *
 * 跑法：`node tests/t-console-backup.mjs`（不联网、不碰真实 ~/.dsh）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SRC = path.join(ROOT, 'console', 'console.js')
const HTML = path.join(ROOT, 'console', 'index.html')

let bad = 0
// 断言条数自己数，不写死 —— 写死会随每次加断言漂
let total = 0
const ok = (cond, msg) => {
  total++
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) bad++
}

// 行尾要归一化成 \n，否则 indexOf 的定位串一个都对不上（console.js 是 CRLF）
const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n')
const html = fs.readFileSync(HTML, 'utf8').replace(/\r\n/g, '\n')

/* ── 1. 从源码里截出 b64ToBytes + decryptBackup 原样求值 ────────────── */

function sliceFn(prefix) {
  const start = src.indexOf(prefix)
  if (start < 0) throw new Error(`截不到源码片段：找不到 ${JSON.stringify(prefix)}`)
  const end = src.indexOf('\n}\n', start)
  if (end < 0) throw new Error(`截不到源码片段的结尾：${JSON.stringify(prefix)}`)
  return src.slice(start, end + 3)
}

/** decryptBackup 的源码片段（供后面的静态断言用）。 */
const decryptSrc = sliceFn('async function decryptBackup(')

/* ── 2. 契约常量的真值源 ──────────────────────────────────────────────
 *
 * ⚠️ 这里**不能**自己另写一份字面量：测试用自己抄的常量造容器、再用它去解，
 * 等于自证。2026-10-31 审查实测三个变异全绿 —— 控制台把 ENCRYPTED_FORMAT 少写
 * 三个字母、PLAIN_FORMAT 多一个空格、KDF 轮数改成 1000，测试毫无反应，而三者
 * 每一个都会让真实备份解不开（最后那个正是要修的那个 bug）。
 *
 * 所以：控制台侧从 console.js 源码读，CLI 侧从 scripts/import-backup.mjs 读，
 * 前端导出侧从 vendor/lib/client/jet-hub.js 读，三方对齐了才继续。
 */

const pickFrom = (text, re) => (text.match(re) ?? [])[1] ?? null

const cliSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'import-backup.mjs'), 'utf8').replace(/\r\n/g, '\n')
const webSrc = fs.readFileSync(path.join(ROOT, 'vendor', 'lib', 'client', 'jet-hub.js'), 'utf8')

const CONSOLE_PLAIN = pickFrom(src, /const PLAIN_FORMAT = '([^']+)'/)
const CONSOLE_ENC = pickFrom(src, /const ENCRYPTED_FORMAT = '([^']+)'/)
const CONSOLE_ITER = Number(pickFrom(src, /const KDF_ITERATIONS = (\d+)/) ?? 0)
const CONSOLE_MAX_ITER = Number(pickFrom(src, /const MAX_KDF_ITERATIONS = (\d+)/) ?? 0)

// 导出侧（前端）的真源：改壳名时会和控制台/CLI 一起落后，必须单独对一次。
// 先剥掉行注释：控制台源码里就有 `// var KDF_ITERATIONS = 31e4;` 这种写法，
// 不剥的话把真值改坏、注释留着旧值，照样能骗过下面三条断言（2026-10-31 三审实测）。
const webCode = webSrc.replace(/\/\/[^\n]*/g, '')
const WEB_PLAIN = pickFrom(webCode, /var BACKUP_FORMAT = "([^"]+)"/)
const WEB_ENC = pickFrom(webCode, /format: "(dsh-[a-z-]+\/backup\.encrypted)"/)
const WEB_ITER = Number(pickFrom(webCode, /var KDF_ITERATIONS = ([\d.e]+)/) ?? 0)

const CLI_PLAIN = pickFrom(cliSrc, /const BACKUP_FORMAT = '([^']+)'/)
const CLI_ENC = pickFrom(cliSrc, /const ENCRYPTED_FORMAT = '([^']+)'/)
const CLI_ITER = Number(pickFrom(cliSrc, /const KDF_ITERATIONS = (\d+)/) ?? 0)
const CLI_MAX_ITER = Number(pickFrom(cliSrc, /const MAX_KDF_ITERATIONS = (\d+)/) ?? 0)

console.log('--- 0) 契约常量与真源一致（防测试自证）---')
{
  ok(CONSOLE_PLAIN !== null && CONSOLE_ENC !== null, `控制台侧常量解析到了（${CONSOLE_PLAIN} / ${CONSOLE_ENC}）`)
  ok(CONSOLE_PLAIN === CLI_PLAIN, `PLAIN_FORMAT 与 CLI 一致（${CONSOLE_PLAIN} / ${CLI_PLAIN}）`)
  ok(CONSOLE_ENC === CLI_ENC, `ENCRYPTED_FORMAT 与 CLI 一致（${CONSOLE_ENC} / ${CLI_ENC}）`)
  ok(CONSOLE_ENC === `${CONSOLE_PLAIN}.encrypted`, '加壳格式就是明文格式 + ".encrypted"')
  ok(CONSOLE_ITER === CLI_ITER, `KDF 轮数与 CLI 一致（${CONSOLE_ITER} / ${CLI_ITER}）`)
  ok(CONSOLE_ITER === 310000, `KDF 轮数是 310000（${CONSOLE_ITER}）`)
  ok(
    WEB_PLAIN !== null && WEB_PLAIN === CONSOLE_PLAIN,
    `前端导出侧明文格式与控制台一致（${WEB_PLAIN} / ${CONSOLE_PLAIN}）`,
  )
  ok(WEB_ENC !== null && WEB_ENC === CONSOLE_ENC, `前端导出侧加壳格式与控制台一致（${WEB_ENC} / ${CONSOLE_ENC}）`)
  ok(WEB_ITER === CONSOLE_ITER, `前端导出侧轮数与控制台一致（${WEB_ITER} / ${CONSOLE_ITER}）`)
  // 只比「定义了同名字符串」还不够：导出载荷里把常量换成字面量时，上面三条照样绿。
  ok(/format: BACKUP_FORMAT,/.test(webCode), '导出载荷用的是 BACKUP_FORMAT 常量（不是另抄一份字面量）')
  ok(/iterations: KDF_ITERATIONS,/.test(webCode), '导出载荷用的是 KDF_ITERATIONS 常量（不是另抄一份字面量）')
  ok(CONSOLE_MAX_ITER === CLI_MAX_ITER && CONSOLE_MAX_ITER > 0, `迭代数上限两边一致（${CONSOLE_MAX_ITER}）`)
  ok(CONSOLE_MAX_ITER > CONSOLE_ITER, '上限比默认轮数大（不会把正常备份挡在外面）')
  ok(CONSOLE_MAX_ITER === 5_000_000, `迭代数上限锁死 5000000（${CONSOLE_MAX_ITER}）`)
}

// 常量对齐之后再求值：decryptBackup 依赖模块级的 KDF_ITERATIONS / MAX_KDF_ITERATIONS，
// 两个值都来自上面的真源解析（不是测试另抄的字面量）。
const code =
  `const KDF_ITERATIONS = ${CONSOLE_ITER}\n` +
  `const MAX_KDF_ITERATIONS = ${CONSOLE_MAX_ITER}\n` +
  sliceFn('function b64ToBytes(') +
  '\n' +
  decryptSrc
const decryptBackup = new Function(`${code}\nreturn decryptBackup`)()

const PLAIN_FORMAT = CONSOLE_PLAIN
const ENCRYPTED_FORMAT = CONSOLE_ENC

function seal(payload, passphrase, { iterations = 1000, drop = null, raw = null } = {}) {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = pbkdf2Sync(passphrase, salt, iterations, 32, 'sha256')
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const text = raw === null ? JSON.stringify(payload) : String(raw)
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const enc = {
    format: ENCRYPTED_FORMAT,
    kdf: 'PBKDF2',
    hash: 'SHA-256',
    iterations,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    // 尾部 16 字节 tag，与 CLI / 前端导出完全一致
    ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString('base64'),
  }
  if (drop) delete enc[drop]
  return enc
}

const SAMPLE = {
  format: PLAIN_FORMAT,
  version: 1,
  exportedAt: '2026-10-31T00:00:00.000Z',
  credentials: { 'PROVIDER_ACCOUNT_AAAABBBB': '{"refresh_token":"rt"}' },
  accounts: [{ id: 'workbuddy-1', provider: 'workbuddy', credentialRef: 'PROVIDER_ACCOUNT_AAAABBBB' }],
  disabledModels: {},
  permanentLocks: { 'workbuddy-1': { reason: '测试' } },
}

console.log('--- 1) 解密行为（Node 造容器 → 控制台侧代码解）---')
{
  const enc = seal(SAMPLE, 'hunter2')
  const got = await decryptBackup(enc, 'hunter2')
  ok(got?.format === PLAIN_FORMAT, `解开后 format 是明文格式（${got?.format}）`)
  ok(got?.accounts?.length === 1 && got.accounts[0].id === 'workbuddy-1', '账号条目往返一致')
  ok(
    got?.credentials?.['PROVIDER_ACCOUNT_AAAABBBB'] === SAMPLE.credentials['PROVIDER_ACCOUNT_AAAABBBB'],
    '凭据往返一致',
  )
  ok(got?.permanentLocks?.['workbuddy-1']?.reason === '测试', '永久锁定表往返一致')

  let msg = ''
  try {
    await decryptBackup(enc, 'wrong-pass')
  } catch (e) {
    msg = String(e.message ?? e)
  }
  ok(msg.startsWith('解密失败：口令不对'), `错口令给的是「口令不对」而不是底层报错（${msg}）`)
}

console.log('--- 2) 容器字段不全时的报错 ---')
{
  for (const [drop, why] of [
    ['salt', '缺 salt'],
    ['iv', '缺 iv'],
    ['ciphertext', '缺 ciphertext'],
  ]) {
    const enc = seal(SAMPLE, 'hunter2', { drop })
    let msg = ''
    try {
      await decryptBackup(enc, 'hunter2')
    } catch (e) {
      msg = String(e.message ?? e)
    }
    ok(msg === '加密容器缺 salt / iv / ciphertext', `${why} 时报字段缺失（${msg || '没报错'}）`)
  }

  // 密文长度 <= 16 时连 tag 都放不下，也按字段缺失处理
  const enc = seal(SAMPLE, 'hunter2')
  enc.ciphertext = Buffer.alloc(16).toString('base64')
  let msg = ''
  try {
    await decryptBackup(enc, 'hunter2')
  } catch (e) {
    msg = String(e.message ?? e)
  }
  ok(msg === '加密容器缺 salt / iv / ciphertext', `密文不足 17 字节也报字段缺失（${msg || '没报错'}）`)
}

console.log('--- 3) 篡改、迭代数上限与畸形容器 ---')
{
  // 天文数字的 iterations 会把标签页拖死，必须在密钥派生之前就拒
  const enc = seal(SAMPLE, 'hunter2', { iterations: CONSOLE_MAX_ITER + 1 })
  let msg = ''
  try {
    await decryptBackup(enc, 'hunter2')
  } catch (e) {
    msg = String(e.message ?? e)
  }
  ok(msg.includes('超出上限'), `迭代数超上限被拒（${msg.slice(0, 60) || '没报错'}）`)
}

{
  const enc = seal(SAMPLE, 'hunter2')
  // 动 tag 的最后一个字节：AES-GCM 认证必须失败，不能静默返回半截明文
  const blob = Buffer.from(enc.ciphertext, 'base64')
  blob[blob.length - 1] ^= 0xff
  enc.ciphertext = blob.toString('base64')
  let msg = ''
  try {
    await decryptBackup(enc, 'hunter2')
  } catch (e) {
    msg = String(e.message ?? e)
  }
  ok(msg.startsWith('解密失败：口令不对'), `密文被改一个字节 → 认证失败（${msg || '没报错'}）`)

  // 容器不写 iterations 时退回源码里的默认轮数（与 CLI、前端导出一致）
  const noIter = seal(SAMPLE, 'hunter2', { iterations: CONSOLE_ITER })
  delete noIter.iterations
  const got = await decryptBackup(noIter, 'hunter2')
  ok(got?.format === PLAIN_FORMAT, `容器缺 iterations 时按默认 ${CONSOLE_ITER} 轮解开了`)

  // 非法 iterations（0 / 小数 / 字符串）也应退回默认，而不是抛错或算出错的 key
  const bad0 = seal(SAMPLE, 'hunter2', { iterations: CONSOLE_ITER })
  bad0.iterations = 0
  const got0 = await decryptBackup(bad0, 'hunter2')
  ok(got0?.format === PLAIN_FORMAT, 'iterations=0 时退回默认轮数（不是拿 0 轮算密钥）')
}

console.log('--- 4) doImport 的接线（静态断言，防分支接反）---')
{
  const start = src.indexOf('async function doImport(')
  ok(start > 0, '源码里有 doImport')
  const end = src.indexOf('\n}\n', start)
  const body = src.slice(start, end + 3)

  // 必须带 `parsed = ` 前缀：只匹配 `await decryptBackup(parsed, pass)` 的话，
  // 把赋值去掉（解完就把明文丢了）照样绿 —— 2026-10-31 变异 A 抓到的假绿。
  ok(
    /parsed = await decryptBackup\(parsed, pass\)/.test(body),
    '解密结果覆写回 parsed（不是丢掉返回值）',
  )
  // 局域网/反代（非安全上下文）下 crypto.subtle 是 undefined，得给可读的错，
  // 而不是让 importKey 抛 "Cannot read properties of undefined"。
  ok(
    /if \(!globalThis\.crypto\?\.subtle\)/.test(decryptSrc),
    'decryptBackup 先查安全上下文，非 127.0.0.1 访问时给的是可读报错',
  )
  // 口令不裁剪：导出侧与 CLI 都按原样取，一 trim 就把首尾带空格的口令变成解不开。
  // 判「取口令 → 解密」之间整段里没有裁剪调用：早先只盯 `$('#bkPass').value` 后面
  // 40 字符，元素取值改成 passEl 之后就整条失效（2026-10-31 三审后实测 .trimEnd() 溜过）。
  const passRegion = body.slice(
    body.indexOf('const passEl ='),
    body.indexOf('parsed = await decryptBackup'),
  )
  ok(
    passRegion.length > 0 && !/\.(trim|trimStart|trimEnd|replace|replaceAll)\s*\(/.test(passRegion),
    '口令不做 trim / replace 裁剪（与 CLI、前端导出一致）',
  )
  // 导入成功后清掉口令，换不同口令的备份时不会静默沿用旧值
  ok(/if \(passEl\) passEl\.value = ''/.test(body), '导入成功后清空口令框')
  // 从失败分支的 catch 起切片再判包含：固定 240 字窗口实测余量只有 82 字符，
  // 加一行注释就会假红（2026-10-31 三审实测）。
  const errTail = body.slice(body.indexOf('catch (e) {'))
  ok(
    errTail.includes("passEl.value = ''"),
    '导入失败时也清空口令框（换不同口令的备份不静默沿用旧值）',
  )

  /* 顺序：加壳判定 → 空口令 → 解密 → 明文格式校验 → backup.import
     只查「存在」不够：把明文格式校验挪到解密之前正是要修的那个 bug，
     把空口令检查挪到解密之后或提成无条件也都能全绿 —— 2026-10-31 审查实测。 */
  const at = (s) => body.indexOf(s)
  const iEnc = at('parsed?.format === ENCRYPTED_FORMAT')
  const iEmpty = at("if (pass === '') throw")
  const iDec = at('parsed = await decryptBackup(parsed, pass)')
  const iPlain = at('parsed?.format !== PLAIN_FORMAT')
  const iImport = at("rpc('backup.import'")
  ok(
    iEnc >= 0 && iEmpty > iEnc && iDec > iEmpty && iPlain > iDec && iImport > iPlain,
    '顺序：加壳判定 → 空口令 → 解密 → 明文格式校验 → backup.import',
  )
  ok(
    /const pass = String\(passEl\?\.value \?\? ''\)/.test(body),
    '口令取自 #bkPass（页面上的口令框，不裁剪）',
  )
  ok(/if \(pass === ''\) throw new Error\(/.test(body), '口令留空时直接报错，不撞进 decrypt 变成「口令不对」')
  ok(/parsed\?\.format !== PLAIN_FORMAT/.test(body), '解完还要校验明文格式（不是只看不是 encrypted 就放行）')
  // 解密必须发生在 backup.import 之前——顺序反了就等于把壳丢给本体
  const idxDecrypt = body.indexOf('decryptBackup(parsed, pass)')
  const idxImport = body.indexOf("rpc('backup.import'")
  ok(idxDecrypt > 0 && idxImport > idxDecrypt, '解密在 backup.import 之前（壳不会被直接丢给本体）')
  ok(/keepDisabledModels: true/.test(body), '仍然恒传 keepDisabledModels: true（黑名单闸门没被这次改动弄丢）')
}

console.log('--- 5) decryptBackup 的内部边界 ---')
{
  // 「JSON.parse 必须在解密的 catch 之外」不再用静态判据：索引比较会被更早的
  // `} catch` 骗过，而等价的合法写法（单 try + instanceof SyntaxError）会假红。
  // 真实保护在第 6 节的行为用例：封一段非 JSON 明文，断言报的是 JSON 问题、
  // 不是「口令不对」（2026-10-31 三审实测：把 JSON.parse 挪回同一 try 时它真红）。
  // 上限判断必须早于 importKey（否则白算一次密钥，且天文数字会先卡死）
  const iMax = decryptSrc.indexOf('MAX_KDF_ITERATIONS')
  const iKey = decryptSrc.indexOf('crypto.subtle.importKey')
  ok(iMax > 0 && iKey > iMax, '迭代数上限的判断早于密钥派生')
  // 底层 message 要带上，否则畸形容器一律被说成「口令不对」
  ok(/解密失败：口令不对，或文件被改动过（\$\{/.test(decryptSrc), '解密失败时附上底层 message')
}

console.log('--- 6) 明文不是 JSON 时不说成「口令不对」 ---')
{
  const enc = seal(null, 'hunter2', { raw: '这不是 JSON，只是一段普通文本' })
  let msg = ''
  try {
    await decryptBackup(enc, 'hunter2')
  } catch (e) {
    msg = String(e?.message ?? e)
  }
  ok(/不是合法 JSON/.test(msg), `明文不是 JSON 时说清是 JSON 的问题（${msg}）`)
  ok(!/口令不对/.test(msg), '明文不是 JSON 时不误报成「口令不对」')
}

console.log('--- 7) 页面元素 ---')
{
  ok(/id="bkPass"/.test(html), 'index.html 有 #bkPass 口令框')
  ok(
    /id="bkPass"[\s\S]{0,120}type="password"|type="password"[\s\S]{0,120}id="bkPass"/.test(html),
    '#bkPass 是密码输入框（口令不该明文显示）',
  )
  ok(html.includes('不加壳的留空'), '#bkPass 的占位文案说明「不加壳的留空」')
}

console.log(`\n${bad === 0 ? '✓ 全部通过' : `✗ ${bad} 项失败`}（${total} 项）`)
if (bad > 0) process.exit(1)
