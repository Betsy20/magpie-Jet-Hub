/**
 * 把 **dsh-providers-hub 插件的备份文件** 导入到本机，落成 magpie 里能直接用的形态。
 *
 * ## 它解决什么
 *
 * `dsh-providers-hub` 导出的备份是一份自包含快照：
 *
 *   { format: 'dsh-codearts-auth/backup', version: 1, exportedAt,
 *     credentials: { <credentialRef>: '<凭据 JSON 原文>' },
 *     accounts: [ { id, provider, nickname, enabled, credentialRef, … } ],
 *     disabledModels: { <provider>: { <model>: true } },
 *     permanentLocks?, loomyPermanentLocked? }
 *
 * 本插件（magpie-Jet-Hub）用的不是这份结构，而是两处**本体自己的落点**：
 *
 *   ~/.dsh/.credentials.yaml   ← refs 段：credentialRef → 凭据 JSON 原文
 *   ~/.dsh/jet-hub/state.json  ← accounts[] 账号池 + disabledModels 黑名单
 *
 * 账号池是本体内嵌容器的**唯一**账号来源；凭据是它发请求时 `resolve(ref)` 取
 * token 的唯一来源。两者都写对了，magpie 里这 23 个 provider 才真的能用备份
 * 里的账号跑起来。最后再摊平一次 `plugin-auth.json`（复用 `seed-auth.mjs`），
 * magpie 的账号卡片上就能看到备份里带了谁。
 *
 * ## 两种模式
 *
 * - `merge`（默认）：**只增加不覆盖**。按账号 `id` 判重，已存在的跳过；凭据只写
 *   新增账号引用的 ref，且若该 ref 已被**别的**现有账号占用则不写（写进去等于
 *   把别人的 token 换掉）。模型黑名单与永久锁定表**不碰**。
 * - `replace`：整体还原 —— 账号池、模型黑名单、永久锁定表全部换成备份里的值。
 *   这是「换机/重装」场景，本机现有账号会被丢弃（有备份文件可回滚）。
 *
 * ## 加密备份
 *
 * 备份可能带一层 PBKDF2(310000, SHA-256) + AES-256-GCM 的壳（前端导出时加的）：
 *
 *   { format: 'dsh-codearts-auth/backup.encrypted', kdf: 'PBKDF2', hash: 'SHA-256',
 *     iterations, salt, iv, ciphertext }        // ciphertext = 密文 || 16B GCM tag
 *
 * 口令按 `--passphrase` → 环境变量 `JET_HUB_BACKUP_PASSPHRASE` → 交互输入 的顺序取。
 *
 * ## 用法
 *
 *   node scripts/import-backup.mjs <备份文件.json> [选项]
 *
 *   --mode merge|replace   默认 merge
 *   --passphrase <口令>    加密备份的口令（更推荐用环境变量，别留在 shell 历史里）
 *   --list                 只列出备份里有什么，不写盘
 *   --dry-run              只报告会改什么，不写盘（也不跑 seed-auth）
 *   --no-seed              写完账号池就停，不摊平 magpie 的 plugin-auth.json
 *   --dsh-home <目录>      覆盖 DSH 数据目录（默认 ~/.dsh），测试用
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { upsertRefsInto, parseRefs, CRED_BASENAME } from '../src/credentials.mjs'

const BACKUP_FORMAT = 'dsh-codearts-auth/backup'
const BACKUP_VERSION = 1
const ENCRYPTED_FORMAT = 'dsh-codearts-auth/backup.encrypted'
const KDF_ITERATIONS = 310000

// ---- 参数 ------------------------------------------------------------------

const argv = process.argv.slice(2)
/** 带值选项：值紧跟其后，不按位置猜。 */
const VALUE_OPTS = new Set(['--mode', '--passphrase', '--dsh-home'])
/**
 * 取选项值，同时支持 `--mode replace` 与 `--mode=replace` 两种写法。
 *
 * 原先只认空格形式：`--mode=replace` 会被当成未知的裸选项（它 `startsWith('--')`
 * 所以不会被当成文件名，但 `--mode` 本身又取不到值）→ 静默退回 merge，
 * 用户以为在整体还原、实际只增不覆盖（2026-10-29 审查发现）。
 */
const opt = (name, fallback = undefined) => {
  const eq = argv.find((a) => a.startsWith(`${name}=`))
  if (eq !== undefined) return eq.slice(name.length + 1)
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}
const flag = (name) => argv.includes(name)
const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUE_OPTS.has(argv[i - 1]))
const file = positional[0]
const dry = flag('--dry-run')
const listOnly = flag('--list')
const noSeed = flag('--no-seed')

// ⚠️ 非法 --mode 必须报错，不能静默降级：`--mode REPLACE` / `--mode=Replace`
// 静默变成 merge 会让用户以为在整体还原，实际只增不覆盖（2026-10-29 审查发现）。
const modeRaw = String(opt('--mode', 'merge')).trim().toLowerCase()
if (modeRaw !== 'merge' && modeRaw !== 'replace') {
  console.error(`✗ --mode 只接受 merge 或 replace，收到：${opt('--mode')}`)
  process.exit(1)
}
const mode = modeRaw

const dshHome = opt('--dsh-home') ?? path.join(os.homedir(), '.dsh')
const credPath = path.join(dshHome, CRED_BASENAME)
const statePath = path.join(dshHome, 'jet-hub', 'state.json')
const here = path.dirname(fileURLToPath(import.meta.url))
const seedScript = path.join(here, 'seed-auth.mjs')

function die(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

if (!file) die('用法: node scripts/import-backup.mjs <备份文件.json> [--mode merge|replace] [--list] [--dry-run]')

// ---- 读备份 + 解密 ----------------------------------------------------------

let container
try {
  container = JSON.parse(fs.readFileSync(file, 'utf8'))
} catch (e) {
  die(`备份文件读不动（${file}）：${e.message}`)
}

const isEncrypted = (v) => v !== null && typeof v === 'object'
  && typeof v.kdf === 'string' && typeof v.ciphertext === 'string'

async function readPassphrase() {
  const fromArg = opt('--passphrase')
  if (fromArg !== undefined) return fromArg
  const fromEnv = process.env.JET_HUB_BACKUP_PASSPHRASE
  if (fromEnv) return fromEnv
  if (!process.stdin.isTTY) die('备份是加密的，但没有给口令：用 --passphrase 或环境变量 JET_HUB_BACKUP_PASSPHRASE')
  const { createInterface } = await import('node:readline')
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  // 屏蔽回显：口令不该留在终端里
  const write = rl._writeToOutput
  rl._writeToOutput = function (s) {
    if (s.includes('口令')) write.call(rl, s)
  }
  const answer = await new Promise((r) => rl.question('备份口令: ', r))
  rl.close()
  process.stdout.write('\n')
  return answer
}

/** AES-256-GCM：ciphertext 尾部 16 字节是 GCM tag。 */
function decrypt(enc, passphrase) {
  const salt = Buffer.from(String(enc.salt ?? ''), 'base64')
  const iv = Buffer.from(String(enc.iv ?? ''), 'base64')
  const blob = Buffer.from(String(enc.ciphertext), 'base64')
  if (salt.length === 0 || iv.length === 0 || blob.length <= 16) {
    throw new Error('加密容器缺 salt / iv / ciphertext')
  }
  const iterations = Number.isSafeInteger(enc.iterations) && enc.iterations > 0
    ? enc.iterations
    : KDF_ITERATIONS
  const key = pbkdf2Sync(passphrase, salt, iterations, 32, 'sha256')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(blob.subarray(blob.length - 16))
  const plain = Buffer.concat([decipher.update(blob.subarray(0, blob.length - 16)), decipher.final()])
  return JSON.parse(plain.toString('utf8'))
}

let payload = container
if (isEncrypted(container)) {
  // 严格相等而不是「有就比、没有就放行」：缺 format 的容器大概率根本不是
  // 备份文件，放行会让它在解密时失败，于是用户看到「口令不对」——
  // 把「格式不认识」误导成「口令错」，白试口令（2026-10-29 审查发现）。
  if (container.format !== ENCRYPTED_FORMAT) {
    die(`不认识的加密容器格式：${String(container.format)}（期望 ${ENCRYPTED_FORMAT}）`)
  }
  const passphrase = await readPassphrase()
  try {
    payload = decrypt(container, passphrase)
  } catch (e) {
    // AES-GCM 认证失败时 OpenSSL 只会说「unable to authenticate data」，真正的
    // 原因是口令错或文件被改过 —— 两种都不可重试，直接说清。
    die(`解密失败（口令不对，或文件被改动过）：${e.message}`)
  }
}

// ---- 校验载荷 --------------------------------------------------------------

if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
  die('备份内容不是对象')
}
if (payload.format !== BACKUP_FORMAT) {
  die(`不是 ${BACKUP_FORMAT} 备份文件（format=${String(payload.format)}）`)
}
if (payload.version !== BACKUP_VERSION) {
  die(`不支持的备份版本：${String(payload.version)}（当前支持 v${BACKUP_VERSION}）`)
}

const accounts = Array.isArray(payload.accounts) ? payload.accounts.filter(
  (a) => a !== null && typeof a === 'object' && !Array.isArray(a) && typeof a.id === 'string' && a.id.length > 0,
) : []
const credentials = (payload.credentials !== null && typeof payload.credentials === 'object' && !Array.isArray(payload.credentials))
  ? payload.credentials
  : {}
const disabledModels = (payload.disabledModels !== null && typeof payload.disabledModels === 'object' && !Array.isArray(payload.disabledModels))
  ? payload.disabledModels
  : {}
const permanentLocks = (payload.permanentLocks !== null && typeof payload.permanentLocks === 'object' && !Array.isArray(payload.permanentLocks))
  ? payload.permanentLocks
  : undefined

// 本机现值（独立文档 `$DSH_HOME/jet-hub/permanent-locks.json`，见文件末尾写盘处）。
// 这里提前读一次，只为在「备份带的是空表、本机却有锁定」时给出警告 ——
// 那张表关系到不可逆的永久积分，静默清空代价很高（2026-10-29 审查发现）。
const locksPath = path.join(dshHome, 'jet-hub', 'permanent-locks.json')
const localLocksDoc = readJsonOr(locksPath, null)
const localLocks = (localLocksDoc?.locks !== null && typeof localLocksDoc?.locks === 'object' && !Array.isArray(localLocksDoc?.locks))
  ? localLocksDoc.locks
  : (localLocksDoc !== null && typeof localLocksDoc === 'object' && !Array.isArray(localLocksDoc) && !('schema' in localLocksDoc) ? localLocksDoc : {})
const localLockNames = Object.entries(localLocks).filter(([, v]) => v === true).map(([k]) => k)

const byProvider = new Map()
for (const a of accounts) {
  const p = String(a.provider ?? '') || '（无 provider）'
  byProvider.set(p, (byProvider.get(p) ?? 0) + 1)
}
const lockedCount = Object.values(disabledModels).reduce(
  (n, m) => n + (m !== null && typeof m === 'object' ? Object.values(m).filter(Boolean).length : 0),
  0,
)

console.log(`备份文件: ${file}`)
console.log(`  格式: ${BACKUP_FORMAT} v${payload.version}${isEncrypted(container) ? '（加密容器）' : ''}`)
console.log(`  导出时间: ${payload.exportedAt ?? '（未记录）'}`)
console.log(`  账号: ${accounts.length} 个 / ${byProvider.size} 个 provider`)
for (const [p, n] of [...byProvider].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${p.padEnd(22)} ${String(n).padStart(2)} 个`)
}
console.log(`  凭据: ${Object.keys(credentials).length} 条`)
console.log(`  已关闭模型: ${lockedCount} 个`)
if (permanentLocks) console.log(`  永久锁定: ${Object.keys(permanentLocks).length} 项`)
console.log('')

if (listOnly) {
  console.log('（--list，只看不写）')
  process.exit(0)
}

// ---- 读本机现状 ------------------------------------------------------------

function readJsonOr(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') return fallback
    die(`${file} 读不动（${e.message}）—— 拒绝改写`)
  }
}

const pool = readJsonOr(statePath, { accounts: [] })
if (pool === null || typeof pool !== 'object' || Array.isArray(pool)) die(`${statePath} 不是对象 —— 拒绝改写`)
const localAccounts = Array.isArray(pool.accounts) ? pool.accounts : []
/** ref → 占用它的本机账号 id（用于识别「这个 ref 是别人的」）。 */
const refOwner = new Map()
for (const a of localAccounts) {
  if (typeof a?.credentialRef === 'string' && a.credentialRef) refOwner.set(a.credentialRef, String(a.id))
}

let credText
try {
  credText = fs.readFileSync(credPath, 'utf8')
} catch (e) {
  if (e.code !== 'ENOENT') die(`${credPath} 读不动（${e.message}）—— 拒绝改写`)
  // 新机器上这个文件还不存在：给一份最小骨架，refs 段留空。
  credText = `version: 1\nrefs:\nrecords:\n`
}
const localRefs = parseRefs(credText)

// ---- 规划：账号 ------------------------------------------------------------

const keptAccounts = mode === 'replace' ? [] : localAccounts
const keptIds = new Set(keptAccounts.map((a) => String(a?.id ?? '')))
const incoming = mode === 'replace' ? accounts : accounts.filter((a) => !keptIds.has(a.id))
const skipped = mode === 'replace' ? [] : accounts.filter((a) => keptIds.has(a.id))

// ---- 规划：凭据 ------------------------------------------------------------

/** 导入完成后账号池里会存在的账号（merge = 现有 + 新增；replace = 备份里的）。 */
const finalAccounts = mode === 'replace' ? accounts : [...localAccounts, ...incoming]
/** 这批账号真正引用的 ref —— 备份里可能还有账号池之外的独立凭据，不写它们。 */
const referencedRefs = new Set(
  finalAccounts.map((a) => a.credentialRef).filter((r) => typeof r === 'string' && r.length > 0),
)

const credPlan = new Map()
const credKeptLocal = []    // 本机已有非空值 —— 保留本机（通常是刷新过的新 token）
const credConflicts = []    // 本机值属于另一个账号 —— 明确点名，绝不覆盖
for (const [ref, value] of Object.entries(credentials)) {
  if (typeof value !== 'string' || value.length === 0) continue
  if (!referencedRefs.has(ref)) continue

  const current = localRefs.get(ref)
  if (current === value) continue // 一模一样，不用写

  if (mode === 'merge' && current !== undefined && current !== '') {
    // ⚠️ merge 的核心承诺：**本机非空值一律不覆盖**。理由两条，任一条都足以否决：
    //  1. 本机值几乎总是**更新**的 —— 运行时 refresh 会把新 token 写回同一个 ref，
    //     拿几天前的备份盖掉它等于把 refresh_token 打回上一代，直接登不上；
    //  2. 该 ref 可能被**别的**账号占着，写进去就是偷换别人的 token。
    // 只有「本机没有 / 空值」才是备份该补的位置 —— 这正是换机、重登后凭据
    // 丢失时最需要的修复。
    // 判「这个 ref 是不是别人的」不能只看第一个引用它的账号 —— 本机原主一定
    // 排在 finalAccounts 前面，`find` 永远先撞上它，于是「备份里的新账号想抢
    // 本机老号的 ref」会被误判成「同一个号、只是本机值更新」而静默放过。
    // 正确判据：除了本机原主之外，还有**别的**账号在引用同一个 ref。
    const owner = refOwner.get(ref)
    const stranger = finalAccounts
      .filter((a) => a.credentialRef === ref)
      .map((a) => String(a?.id ?? ''))
      .find((id) => id !== owner)
    if (owner !== undefined && stranger !== undefined) {
      credConflicts.push([ref, owner, stranger])
    } else {
      credKeptLocal.push(ref)
    }
    continue
  }
  credPlan.set(ref, value)
}

// ---- 报告 ------------------------------------------------------------------

console.log(`落点: ${statePath}`)
console.log(`      ${credPath}`)
console.log(`模式: ${mode === 'replace' ? 'replace（整体还原）' : 'merge（只增加不覆盖）'}`)
console.log('')
console.log(`账号: 现有 ${localAccounts.length} → 写入 ${incoming.length} 个新增` +
  (skipped.length > 0 ? `，跳过 ${skipped.length} 个已存在` : ''))
if (incoming.length > 0) {
  const shown = incoming.slice(0, 12).map((a) => `${a.provider ?? '?'}/${a.nickname ?? a.id}`)
  console.log(`      ${shown.join('、')}${incoming.length > shown.length ? ` …共 ${incoming.length} 个` : ''}`)
}
console.log(`凭据: 写入 ${credPlan.size} 条` +
  (credKeptLocal.length > 0 ? `，保留本机更新值 ${credKeptLocal.length} 条` : '') +
  (credConflicts.length > 0 ? `，跳过 ${credConflicts.length} 条被别的账号占用` : ''))
// 反向检查：账号池里会存在的账号，其 ref 在「本机现值 + 本次要写的值」里找不到
// 就是登不上的号。只正向遍历 credentials 看不出来 —— 账号进了池子、报告一片绿，
// 实际一用就 502（2026-10-29 审查发现）。
const resolvedRefs = new Set([...localRefs.keys()])
for (const ref of credPlan.keys()) resolvedRefs.add(ref)
const orphanRefs = [...referencedRefs].filter((ref) => !resolvedRefs.has(ref))
if (orphanRefs.length > 0) {
  const owners = orphanRefs.map((ref) => {
    const who = finalAccounts.filter((a) => a.credentialRef === ref).map((a) => String(a?.id ?? '')).filter(Boolean)
    return `${ref}（${who.slice(0, 3).join(', ')}${who.length > 3 ? ` …共 ${who.length} 个` : ''}）`
  })
  console.log(`      ⚠️ 有 ${orphanRefs.length} 个 ref 既不在本机、备份里也没有值 —— 这些账号接进来会登不上：`)
  for (const line of owners.slice(0, 8)) console.log(`        ${line}`)
  if (owners.length > 8) console.log(`        …共 ${owners.length} 个`)
  console.log(`        备份导出时这些账号可能已登录失败（导出报告的 warnings 里会点名）。`)
}
for (const [ref, owner, stranger] of credConflicts) {
  console.log(`      ! ${ref} 已被本机账号 ${owner} 占用（备份里的 ${stranger} 也想用），不覆盖`)
}
if (credKeptLocal.length > 0) {
  console.log(`      · 本机已有值的 ref 一律保留（本机值通常是运行时刷新后的新 token，用备份覆盖会打回上一代）`)
}
if (mode === 'replace') {
  console.log(`模型黑名单: 整体换成备份里的 ${lockedCount} 个关闭项`)
  console.log(`永久锁定: ${permanentLocks ? `整体换成备份里的 ${Object.keys(permanentLocks).length} 项` : '备份未带，保持本机现值'}`)
  // 备份带的是**空表**、本机却有锁定时必须喊一声：replace 会把这些锁定清掉，
  // 而这张表关系到不可逆的永久积分（2026-10-29 审查发现静默清空的问题）。
  const wantLockNames = permanentLocks ? Object.entries(permanentLocks).filter(([, v]) => v === true).map(([k]) => k) : []
  const dropped = permanentLocks ? localLockNames.filter((k) => !wantLockNames.includes(k)) : []
  if (dropped.length > 0) {
    console.log(`      ⚠️ 本机这 ${dropped.length} 项永久锁定会被清掉：${dropped.join(', ')}`)
    console.log(`         这张表关系到不可逆的永久积分。若不想动它，改用 --mode merge。`)
  }
} else {
  console.log('模型黑名单 / 永久锁定: merge 模式不碰')
}
console.log('')

if (dry) {
  console.log('（--dry-run，未写盘）')
  process.exit(0)
}

// ---- 写 .credentials.yaml ---------------------------------------------------

// 备份名带毫秒：同一秒内连跑两次不会互相覆盖（原先只到秒，第二次会把
// 第一次的 .bak-import-<stamp> 盖掉，最初原始态就丢了）。
const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 17)

if (credPlan.size > 0) {
  const nextText = upsertRefsInto(credText, credPlan)

  // ⚠️ 先写 tmp、**校验 tmp 的内容**、通过了才 rename 覆盖正式文件
  // （2026-10-29 审查发现的真实缺陷）：原来的顺序是「rename 覆盖 → 回读校验」，
  // 校验发现坏数据时只 `die` 退出、不还原，用户拿到的是**已被写坏的凭据文件**，
  // 而此刻 state.json 还没写，账号池与凭据不一致。校验 tmp 就没有这个窗口。
  fs.mkdirSync(path.dirname(credPath), { recursive: true })
  const tmp = `${credPath}.tmp-${process.pid}`
  fs.writeFileSync(tmp, nextText, 'utf8')
  const staged = parseRefs(fs.readFileSync(tmp, 'utf8'))
  const bad = [...credPlan].filter(([k, v]) => staged.get(k) !== v).map(([k]) => k)
  if (bad.length > 0) {
    try { fs.unlinkSync(tmp) } catch { /* 删不掉也不影响正式文件 */ }
    die(`凭据写回校验失败，以下 ref 值与备份不符：${bad.join(', ')}（正式文件未被改动）`)
  }

  if (fs.existsSync(credPath)) fs.copyFileSync(credPath, `${credPath}.bak-import-${stamp}`)
  fs.renameSync(tmp, credPath)

  // 落地后再回读一次，确认 rename 真的生效（tmp 校验过不代表目标文件对）。
  const after = parseRefs(fs.readFileSync(credPath, 'utf8'))
  const missing = [...credPlan.keys()].filter((k) => after.get(k) === undefined)
  if (missing.length > 0) {
    const bak = `${credPath}.bak-import-${stamp}`
    if (fs.existsSync(bak)) fs.copyFileSync(bak, credPath)
    die(`凭据落地后回读失败，以下 ref 不存在：${missing.join(', ')}（已从 ${path.basename(bak)} 还原）`)
  }
  console.log(`✓ 凭据已写入 ${credPlan.size} 条（refs ${localRefs.size} → ${after.size}）`)
} else {
  console.log('· 凭据无需写入（备份里的都已在位）')
}

// ---- 写 state.json ----------------------------------------------------------

const nextPool = {
  ...pool,
  accounts: mode === 'replace' ? accounts.slice() : [...localAccounts, ...incoming],
}
if (mode === 'replace') {
  nextPool.disabledModels = disabledModels
  if (typeof payload.loomyPermanentLocked === 'boolean') nextPool.loomyPermanentLocked = payload.loomyPermanentLocked
}

fs.mkdirSync(path.dirname(statePath), { recursive: true })
if (fs.existsSync(statePath)) fs.copyFileSync(statePath, `${statePath}.bak-import-${stamp}`)
const tmpState = `${statePath}.tmp-${process.pid}`
fs.writeFileSync(tmpState, JSON.stringify(nextPool, null, 2))
fs.renameSync(tmpState, statePath)

// ---- 写 permanent-locks.json ------------------------------------------------
//
// ⚠️ 永久锁定表**不住 state.json**（本仓库实测确认）：它是独立文档
// `$DSH_HOME/jet-hub/permanent-locks.json`，形态
// `{ schema: 'dsh-codearts-auth/permanent-locks/v1', locks: { <provider>: true } }`。
// 往 state.json 塞 `permanentLocks` 字段是无效写入 —— 读侧只看独立文档，
// 且文档存在时它**是唯一权威**，不再回看老的 loomyPermanentLocked 字段。
// 把它写错地方，用户会以为锁回去了，实际一点没变（而这张表关系到不可逆的
// 永久积分，猜错代价很高）。

if (mode === 'replace' && permanentLocks) {
  const locksPath = path.join(dshHome, 'jet-hub', 'permanent-locks.json')
  fs.mkdirSync(path.dirname(locksPath), { recursive: true })
  if (fs.existsSync(locksPath)) fs.copyFileSync(locksPath, `${locksPath}.bak-import-${stamp}`)
  const tmpLocks = `${locksPath}.tmp-${process.pid}`
  fs.writeFileSync(tmpLocks, JSON.stringify({
    schema: 'dsh-codearts-auth/permanent-locks/v1',
    locks: permanentLocks,
  }, null, 2))
  fs.renameSync(tmpLocks, locksPath)

  const afterLocks = readJsonOr(locksPath, null)
  const got = Object.entries(afterLocks?.locks ?? {}).filter(([, v]) => v === true).map(([k]) => k)
  const want = Object.entries(permanentLocks).filter(([, v]) => v === true).map(([k]) => k)
  const missed = want.filter((k) => !got.includes(k))
  if (missed.length > 0) die(`永久锁定表写回校验失败，以下 provider 没落地：${missed.join(', ')}`)
  console.log(`✓ 永久锁定表已写入 ${got.length} 项`)
}

const afterPool = readJsonOr(statePath, null)
if (!Array.isArray(afterPool?.accounts)) die('账号池写回校验失败：accounts 不是数组')
const afterIds = new Set(afterPool.accounts.map((a) => String(a?.id ?? '')))
const lostIncoming = incoming.filter((a) => !afterIds.has(a.id)).map((a) => a.id)
if (lostIncoming.length > 0) die(`账号池写回校验失败，以下账号没落地：${lostIncoming.join(', ')}`)
console.log(`✓ 账号池已写入：${localAccounts.length} → ${afterPool.accounts.length} 个账号`)

// ---- 摊平到 magpie ----------------------------------------------------------

if (noSeed) {
  console.log('· 已跳过 plugin-auth.json 摊平（--no-seed）')
  console.log('  要补上：node scripts/seed-auth.mjs')
} else {
  console.log('')
  // `--dsh-home` 只改「读哪份账号池」，摊平的目标始终是 magpie 自己的
  // `~/.config/magpie/plugin-auth.json`（那是 magpie 的配置，不属于 dsh home）。
  // 用非默认 dsh home 做试验时，这一步会写真实 magpie 配置 —— 必须说清楚，
  // 否则测试/换机演练会顺手改掉在用的 magpie（2026-10-29 审查发现）。
  if (dshHome !== path.join(os.homedir(), '.dsh')) {
    console.log(`⚠️ 注意：--dsh-home 只影响账号池落点；摊平的目标仍是 magpie 自己的`)
    console.log(`   ${path.join(os.homedir(), '.config', 'magpie', 'plugin-auth.json')}`)
    console.log(`   只想验证导入、不想动在用的 magpie 时，加 --no-seed。`)
    console.log('')
  }
  console.log('→ 摊平到 magpie 的 plugin-auth.json …')
  // stdio: 'inherit' 而不是管道：本仓库沙箱下管道 stdio 会 EPERM（见
  // scripts/test-all.mjs 的同一处绕法）。子进程直接继承当前输出。
  const run = spawnSync(process.execPath, [seedScript, statePath], { stdio: 'inherit' })
  if (run.status !== 0) die(`seed-auth 失败（退出码 ${String(run.status)}）—— 账号池已写好，可单独重跑 node scripts/seed-auth.mjs`)
}

console.log('')
console.log('✓ 导入完成。magpie 里重启一次这个插件，账号卡片就能看到备份里的账号了。')
