// 死号过滤的回归测试（不联网、不读真实凭据）。
//
// 锁住 2026-10-28 的真实缺陷：`AccountPool.getAvailableAccount` 只按 `enabled`
// 与 `modelRateLimits` 过滤，不看 `expiresAt` / `refreshable`。于是「已过期且
// 不可续期」的死号仍会被选中，整个渠道表现为 502，而健康账号其实完全可用。
//
// 本测试只验判据本身（`JetHubContainer.isDeadAccount`）与包装后的选号行为，
// 不启动容器（容器要拉本体、开网关，太重）。
import assert from 'node:assert/strict'
import { JetHubContainer } from '../src/container.mjs'

const { isDeadAccount } = JetHubContainer
const NOW = 1_700_000_000_000
let pass = 0
const ok = (cond, name) => {
  assert.ok(cond, name)
  pass++
  console.log('  ✓', name)
}

console.log('死号判据：')
ok(isDeadAccount({ refreshable: false, expiresAt: NOW - 60_000 }, NOW) === true,
  'refreshable=false 且已过期 → 死号')
ok(isDeadAccount({ refreshable: false, expiresAt: NOW + 60_000 }, NOW) === false,
  'refreshable=false 但仍有效 → 不是死号（还能用）')
ok(isDeadAccount({ refreshable: true, expiresAt: NOW - 60_000 }, NOW) === false,
  'refreshable=true 且已过期 → 不是死号（还能刷）')
ok(isDeadAccount({ expiresAt: NOW - 60_000 }, NOW) === false,
  '缺 refreshable → 保守放行')
ok(isDeadAccount({ refreshable: false }, NOW) === false,
  '缺 expiresAt → 保守放行')
ok(isDeadAccount({ refreshable: false, expiresAt: 0 }, NOW) === false,
  'expiresAt=0（未记录）→ 保守放行')
ok(isDeadAccount({ refreshable: false, expiresAt: NaN }, NOW) === false,
  'expiresAt=NaN → 保守放行')
ok(isDeadAccount(null, NOW) === false, 'null → 放行不抛错')
ok(isDeadAccount(undefined, NOW) === false, 'undefined → 放行不抛错')

// ---- loomy 豁免（真实缺陷，2026-10-28）-------------------------------------
// loomy 的 refreshable 恒 false 是「无续期端点」的诚实标记（loomy-auth.js:34-37），
// expires_at 是本地按 14 天推算的假日期（loomy-auth.js:198-206 + loomy-oauth.js:35）。
// 两条腿合起来对它**恒真** ⇒ 登录满 14 天即把唯一在服务的号判死。必须豁免。
console.log('\nloomy 豁免：')
ok(isDeadAccount({ provider: 'loomy', refreshable: false, expiresAt: NOW - 60_000 }, NOW) === false,
  'loomy 的 refreshable=false + 已过期 → **不算**死号（判据对它不可信）')
ok(isDeadAccount({ provider: 'loomy', refreshable: false, expiresAt: NOW - 14 * 24 * 3600_000 }, NOW) === false,
  'loomy 过期 14 天 → 仍不算死号（它压根没有续期概念）')
ok(isDeadAccount({ provider: 'codearts', refreshable: false, expiresAt: NOW - 60_000 }, NOW) === true,
  '非 loomy 同样输入 → 仍然算死号（豁免没扩大）')
ok(isDeadAccount({ provider: 'minimax', refreshable: false, expiresAt: NOW - 60_000 }, NOW) === true,
  'minimax 同样输入 → 仍然算死号（它的 refreshable 是兑出来的）')
ok(isDeadAccount({ provider: 'astudio', refreshable: false, expiresAt: NOW - 60_000 }, NOW) === true,
  'astudio 同样输入 → 仍然算死号（终态错误写下的 false）')

// ---- 豁免前提的反向守卫（Jeb 要求）----------------------------------------
// 豁免是建立在 vendor 两个事实上的：① loomy 没有真正的 refreshableOf 判据；
// ② 它的 expires_at 是本地按 14 天算出来的假日期，不是服务端下发。
// 任何一条被上游改掉，豁免就不再成立、会真的漏掉死号。
// 这条断言**故意读 vendor 源码**：它要抓的正是「上游某天变了而这里没人知道」。
// 报警方式 = 断言失败（CI 与 test-all 都会红），而不是日志 —— 静默继续豁免
// 是这轮最危险的失败模式。
console.log('\n豁免前提守卫（读 vendor 源码）：')
{
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const authSrc = readFileSync(join(root, 'vendor/lib/loomy-auth.js'), 'utf8')
  const oauthSrc = readFileSync(join(root, 'vendor/lib/loomy-oauth.js'), 'utf8')

  ok(!/refreshableOf:/.test(authSrc),
    'loomy-auth.js 仍无 refreshableOf 判据（若有了，说明上游给了可信判据 → 应撤豁免并重估）')
  ok(/expires_at:\s*String\(\s*Date\.now\(\)\s*\+\s*LOOMY_SESSION_TTL_SECONDS/.test(authSrc),
    'loomy 的 expires_at 仍是本地推算（若改成服务端真日期 → 第二腿可信 → 应撤豁免）')
  ok(/LOOMY_SESSION_TTL_SECONDS\s*=\s*1_209_600/.test(oauthSrc),
    'LOOMY_SESSION_TTL_SECONDS 仍是 14 天常量（1209600 秒）')
}

// 用假 pool 验证包装后的选号行为（复刻真实 pool 的两个方法签名）。
console.log('\n包装后的选号：')
const accounts = [
  { id: 'dead', provider: 'codearts', enabled: true, refreshable: false, expiresAt: NOW - 2000 * 60_000 },
  { id: 'live', provider: 'codearts', enabled: true, refreshable: true, expiresAt: NOW + 100 * 60_000 },
  { id: 'other', provider: 'qoder', enabled: true, refreshable: false, expiresAt: NOW - 60_000 },
]
const pool = {
  readAccounts: () => accounts,
  // 复刻本体行为：只按 enabled 过滤，返回第一个候选。
  getAvailableAccount: async (provider, _modelId, exclude) => {
    const hit = accounts.find(
      (a) => a.provider === provider && a.enabled && !(exclude?.has(a.id)),
    )
    return hit === undefined ? null : { entry: hit }
  },
  listAvailableCredentials: async (provider) =>
    accounts.filter((a) => a.provider === provider && a.enabled).map((a) => ({ entry: a })),
}
const ctx = { accountPool: pool }
const container = new JetHubContainer({ home: '/x', entryPath: '/x', log: () => {} })
container._filterDeadAccounts(ctx)

const picked = await pool.getAvailableAccount('codearts', '')
ok(picked?.entry?.id === 'live', 'codearts 跳过死号，选中健康账号')

const listed = await pool.listAvailableCredentials('codearts')
ok(listed.length === 1 && listed[0].entry.id === 'live', 'listAvailableCredentials 同样过滤死号')

// 边界：排除集与死号集合并后仍能正常工作。
const picked2 = await pool.getAvailableAccount('codearts', '', new Set(['live']))
ok(picked2 === null, '健康账号被显式排除后返回 null（不会回落到死号）')

// 幂等：重复安装不应套两层包装（否则日志重复、性能退化）。
const before = pool.getAvailableAccount
container._filterDeadAccounts(ctx)
ok(pool.getAvailableAccount === before, '重复安装幂等')

// loomy 豁免在**包装层**同样生效：池里唯一一个 loomy 号已过期，
// 但它是「无续期端点」的诚实 false + 本地推算的假日期 ⇒ 必须仍被选中。
// 这条锁住的是 P0 的伤害链：若在包装层被筛掉，选号会被交给 fallback，
// 而 loomy 的 fallback 是 `LOOMY_ACCESS_TOKEN` 这个**并不存在**的 ref
// （plugin-auth.json 里只有 jet-hub-loomy / jet-hub-loomy#1i2rdg）。
const loomyAccounts = [
  { id: 'loomy-old', provider: 'loomy', enabled: true, refreshable: false, expiresAt: NOW - 14 * 24 * 3600_000 },
]
const loomyPool = {
  readAccounts: () => loomyAccounts,
  getAvailableAccount: async (provider, _m, exclude) => {
    const hit = loomyAccounts.find((a) => a.provider === provider && a.enabled && !(exclude?.has(a.id)))
    return hit === undefined ? null : { entry: hit }
  },
  listAvailableCredentials: async (provider) =>
    loomyAccounts.filter((a) => a.provider === provider).map((e) => ({ entry: e })),
}
const loomyContainer = new JetHubContainer({ home: '/x', entryPath: '/x', log: () => {} })
loomyContainer._filterDeadAccounts({ accountPool: loomyPool })
const loomyPick = await loomyPool.getAvailableAccount('loomy', '')
ok(loomyPick?.entry?.id === 'loomy-old', '过期的 loomy 号仍被选中（不被死号过滤筛掉）')
const loomyList = await loomyPool.listAvailableCredentials('loomy')
ok(loomyList.length === 1, 'listAvailableCredentials 也保留过期的 loomy 号')

// ---- 开关真的能关掉过滤（auth.options 的 dead_account_skip）------------------
// 这一半验的是容器侧契约：`container.deadSkipCheck(provider)` 返回 false 时，
// 过滤必须整体让路，死号回到候选里 —— 那正是「关掉开关会 502」的成因。
// 插件侧（magpie 开关 → 这个回调）由 tests/t-options.mjs 与静态契约覆盖。
console.log('\n开关关闭时：')
const accounts2 = [
  { id: 'dead2', provider: 'codearts', enabled: true, refreshable: false, expiresAt: NOW - 2000 * 60_000 },
  { id: 'live2', provider: 'codearts', enabled: true, refreshable: true, expiresAt: NOW + 100 * 60_000 },
]
const pool2 = {
  readAccounts: () => accounts2,
  getAvailableAccount: async (provider, _m, exclude) => {
    const hit = accounts2.find((a) => a.provider === provider && a.enabled && !(exclude?.has(a.id)))
    return hit === undefined ? null : { entry: hit }
  },
  listAvailableCredentials: async (provider) =>
    accounts2.filter((a) => a.provider === provider && a.enabled).map((a) => ({ entry: a })),
}
const container2 = new JetHubContainer({ home: '/x', entryPath: '/x', log: () => {} })
let skip = true
container2.deadSkipCheck = () => skip
container2._filterDeadAccounts({ accountPool: pool2 })

skip = true
const onPick = await pool2.getAvailableAccount('codearts', '')
ok(onPick?.entry?.id === 'live2', '开关开 → 跳过死号（选中健康账号）')

skip = false
const offPick = await pool2.getAvailableAccount('codearts', '')
ok(offPick?.entry?.id === 'dead2', '开关关 → 死号回到候选首位（复刻 502 的成因）')

skip = true
const backOn = await pool2.getAvailableAccount('codearts', '')
ok(backOn?.entry?.id === 'live2', '开关重新打开 → 过滤立即恢复（现读，不用重启）')

// 开关按 provider 单独拨：只关 codearts，别的 provider 仍过滤。
skip = true
const perProvider = new JetHubContainer({ home: '/x', entryPath: '/x', log: () => {} })
perProvider.deadSkipCheck = (p) => p !== 'codearts'
const accounts3 = [{ id: 'd3', provider: 'qoder', enabled: true, refreshable: false, expiresAt: NOW - 60_000 }]
const pool3 = {
  readAccounts: () => accounts3,
  // 复刻本体的排除语义：exclude 里的 id 不该被返回。
  getAvailableAccount: async (provider, _m, exclude) => {
    const hit = accounts3.find((a) => a.provider === provider && a.enabled && !(exclude?.has(a.id)))
    return hit === undefined ? null : { entry: hit }
  },
  listAvailableCredentials: async (provider) => accounts3.filter((a) => a.provider === provider).map((e) => ({ entry: e })),
}
perProvider._filterDeadAccounts({ accountPool: pool3 })
const qPick = await pool3.getAvailableAccount('qoder', '')
ok(qPick === null, '开关是按 provider 拨的：qoder 仍过滤死号')

console.log(`\n${pass} 条断言全部通过`)
