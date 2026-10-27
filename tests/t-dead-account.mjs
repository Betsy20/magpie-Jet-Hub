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

console.log(`\n${pass} 条断言全部通过`)
