/**
 * `vendor/lib/backup.js` 的 `importBackup(..., { keepDisabledModels })` 单测。
 *
 * 为什么单独一个文件：这个分支是 magpie 里「备份覆盖要不要连模型黑名单一起换」的
 * 唯一实现点（控制台的备份导入恒传 `true`，CLI 默认不传）。独立审查实测发现它**零覆盖**——
 * 把 `:329` 改成恒 `false` 或恒 `true`，整套测试都还是绿的。这里用假 pool 直接调它。
 *
 * 断言三条：
 *   1. `keepDisabledModels: true` ⇒ replaceAll 收到的是**本机现值**（不是备份里的）
 *   2. 不传（默认 replace）⇒ replaceAll 收到的是**备份里的**值（保持既有行为）
 *   3. `mode: 'merge'` ⇒ 走 mergeAccounts，replaceAll 一次都不被调用
 *
 * 用法：node tests/t-backup-keep.mjs
 */
import { importBackup } from '../vendor/lib/backup.js'

const FORMAT = 'dsh-codearts-auth/backup'

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

const LOCAL_DISABLED = { workbuddy: { 'wb-legacy': true } }
const BACKUP_DISABLED = { cline: { 'cline-free/deepseek-v4.1-flash': true } }

function payload() {
  return {
    format: FORMAT,
    version: 1,
    exportedAt: '2026-10-27T00:00:00.000Z',
    credentials: {},
    accounts: [],
    disabledModels: JSON.parse(JSON.stringify(BACKUP_DISABLED)),
    permanentLocks: {},
  }
}

function makePool() {
  const calls = { replaceAll: [], mergeAccounts: [] }
  return {
    calls,
    getStateSnapshot() {
      return { accounts: [{ id: 'local-1' }], disabledModels: JSON.parse(JSON.stringify(LOCAL_DISABLED)) }
    },
    async replaceAll(accounts, disabledModels, locks) {
      calls.replaceAll.push({ accounts, disabledModels, locks })
    },
    async mergeAccounts(accounts) {
      calls.mergeAccounts.push(accounts)
    },
  }
}

const credentials = { set: async () => {} }

console.log('· 1  keepDisabledModels: true ⇒ 保留本机黑名单')
{
  const pool = makePool()
  await importBackup(credentials, pool, payload(), { keepDisabledModels: true })
  const c = pool.calls.replaceAll[0]
  ok(c !== undefined, 'replace 分支被走到', JSON.stringify(pool.calls))
  ok(
    JSON.stringify(c?.disabledModels) === JSON.stringify(LOCAL_DISABLED),
    'replaceAll 收到的黑名单是本机现值，不是备份里的',
    JSON.stringify(c?.disabledModels),
  )
}

console.log('· 2  不传选项 ⇒ 按备份里的黑名单写回（既有行为不变）')
{
  const pool = makePool()
  await importBackup(credentials, pool, payload(), {})
  const c = pool.calls.replaceAll[0]
  ok(
    JSON.stringify(c?.disabledModels) === JSON.stringify(BACKUP_DISABLED),
    'replaceAll 收到的是备份里的黑名单',
    JSON.stringify(c?.disabledModels),
  )
}

console.log('· 3  keepDisabledModels 只认严格 true（字符串 / 1 不算）')
{
  const pool = makePool()
  await importBackup(credentials, pool, payload(), { keepDisabledModels: 'true' })
  const c = pool.calls.replaceAll[0]
  ok(
    JSON.stringify(c?.disabledModels) === JSON.stringify(BACKUP_DISABLED),
    '非布尔 true（字符串 "true"）按不传处理 ⇒ 写备份值（不吃意外真值）',
    JSON.stringify(c?.disabledModels),
  )
}

console.log('· 4  merge 模式不碰黑名单，也不调 replaceAll')
{
  const pool = makePool()
  await importBackup(credentials, pool, payload(), { mode: 'merge' })
  ok(pool.calls.replaceAll.length === 0, 'merge 下 replaceAll 一次都没被调', pool.calls.replaceAll.length)
  ok(pool.calls.mergeAccounts.length === 1, 'mergeAccounts 被调了一次', pool.calls.mergeAccounts.length)
}

console.log(`\n${failed === 0 ? '✓ 全部通过' : `✗ ${failed} 项失败`}（${total} 项：keepDisabledModels 三态 + merge 不碰黑名单）`)
process.exit(failed === 0 ? 0 : 1)
