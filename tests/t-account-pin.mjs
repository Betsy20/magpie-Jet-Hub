// 「在 magpie 里挑哪个账号，请求就真的走哪个」的回归测试（不联网、不读真实凭据）。
//
// 锁住 2026-10-29 的真实缺陷：用户报「在 magpie 中无法新建账号」。查下来是
// 三件事叠在一起：
//   ① 插件声明 `auth.single: true` ⇒ 宿主 `signInKey()` 每次都返回
//      `accountsOf(provider)[0]`，点几次「连接」都只覆盖同一条记录；
//   ② `authorize()` 永远返回同一个 key ⇒ `settle()` 按 accountId/secret 判重，
//      永远不会长出第二条；
//   ③ 就算 magpie 里真有两条记录，本体选号也只看**池内数组顺序**
//      （`vendor/lib/account-pool.js:1961`「账号列表的数组顺序就是候选优先级」），
//      池里没有「钉住某个账号」的字段 ⇒ 挑 B 仍然走 A。
//
// 本测试覆盖修法对应的三处：`ask()` 列账号、`authorize(inputs)` 编 key/uid、
// 容器 `_pinAccounts` 收窄选号。**不启动容器**（要拉本体、太重），用假池 +
// 直接调 `_pinAccounts` 的方式验行为 —— 与 `t-dead-account.mjs` 同一手法。
import assert from 'node:assert/strict'
import { JetHubContainer } from '../src/container.mjs'

let pass = 0
const ok = (cond, name) => {
  assert.ok(cond, name)
  pass++
  console.log('  ✓', name)
}

// ---- 假池：复刻本体两个选号入口的真实语义 --------------------------------
// `getAvailableAccount` 的关键事实是「按数组顺序返回第一个可用」，
// 这正是「挑 B 却走 A」的根源，必须照实复刻，否则测试测不到东西。
const accounts = [
  { id: 'wb-aaa111', provider: 'workbuddy', enabled: true, credentialRef: 'WORKBUDDY_ACCOUNT_AAA111', nickname: 'betsy030' },
  { id: 'wb-bbb222', provider: 'workbuddy', enabled: true, credentialRef: 'WORKBUDDY_ACCOUNT_BBB222', nickname: 'betsy024' },
  { id: 'wb-ccc333', provider: 'workbuddy', enabled: false, credentialRef: 'WORKBUDDY_ACCOUNT_CCC333', nickname: '停用号' },
  { id: 'cl-ddd444', provider: 'cline', enabled: true, credentialRef: 'CLINE_ACCOUNT_DDD444', nickname: 'cline号' },
  // 死号：明确标了不可续期且有效期已过（`JetHubContainer.isDeadAccount` 的判据）。
  { id: 'wb-dead111', provider: 'workbuddy', enabled: true, credentialRef: 'R_DEAD', nickname: '死号', refreshable: false, expiresAt: 1_000_000 },
  // 限流号：只在 m-locked 这个模型上被限到很远的将来。
  { id: 'wb-lmt222', provider: 'workbuddy', enabled: true, credentialRef: 'R_LMT', nickname: '限流号', modelRateLimits: { 'm-locked': Date.now() + 3_600_000 } },
]
const creds = {
  WORKBUDDY_ACCOUNT_AAA111: JSON.stringify({ token: 'aaa' }),
  WORKBUDDY_ACCOUNT_BBB222: JSON.stringify({ token: 'bbb' }),
  WORKBUDDY_ACCOUNT_CCC333: JSON.stringify({ token: 'ccc' }),
  CLINE_ACCOUNT_DDD444: JSON.stringify({ token: 'ddd' }),
  R_DEAD: JSON.stringify({ token: 'dead' }),
  R_LMT: JSON.stringify({ token: 'limited' }),
}
// 判据照抄 `vendor/lib/account-pool.js:2249-2300` 与 `:2331`：
// enabled + excludeAccountIds + modelRateLimits（空 modelId 跳过）。漏掉任何一条，
// 包装层复制语义时漏判据就没人发现（2026-10-29 审查正是这么发现真缺陷的）。
const rateLimited = (a, modelId) => {
  if (!modelId || !a.modelRateLimits) return false
  const resetAt = a.modelRateLimits[modelId]
  return resetAt !== undefined && resetAt !== 0 && Date.now() < resetAt
}
const pool = {
  readAccounts: () => accounts,
  getAvailableAccount: async (provider, modelId, exclude) => {
    const hit = accounts.find((a) => a.provider === provider && a.enabled
      && !(exclude?.has(a.id)) && !rateLimited(a, modelId))
    return hit === undefined ? null : { entry: hit, credential: JSON.parse(creds[hit.credentialRef]) }
  },
  listAvailableCredentials: async (provider, modelId) =>
    accounts.filter((a) => a.provider === provider && a.enabled && !rateLimited(a, modelId))
      .map((a) => ({ entry: a, credential: JSON.parse(creds[a.credentialRef]) })),
}
const ctx = {
  accountPool: pool,
  credentials: { resolve: async (ref) => (creds[ref] === undefined ? undefined : { value: creds[ref] }) },
}
const container = new JetHubContainer({ home: '/x', entryPath: '/x', log: () => {} })
// ⚠️ 顺序必须与 `_start()` 一致：钉号先装（内层），死号过滤后装（外层）。
// 反过来（filter 先、pin 后）会让钉住死号时死号过滤被整个绕过 —— 这是
// 2026-10-29 审查发现的真实缺陷，下面「钉住死号」用例就是它的回归锁。
container._pinAccounts(ctx)
container._filterDeadAccounts(ctx)

console.log('基线（不钉号）：')
{
  const picked = await pool.getAvailableAccount('workbuddy', '')
  ok(picked?.entry?.id === 'wb-aaa111', '不钉时按池内顺序选第一个 —— 这就是「挑 B 却走 A」的根源')
}

console.log('\n钉住具体账号：')
{
  const picked = await container.runPinned('wb-bbb222', () => pool.getAvailableAccount('workbuddy', ''))
  ok(picked?.entry?.id === 'wb-bbb222', '钉住 bbb222 后选号真的走 bbb222（不再是池首的 aaa111）')
  ok(picked?.credential?.token === 'bbb', '拿到的是被钉那个账号自己的凭据（不是池首那个的）')
}
{
  const rows = await container.runPinned('wb-bbb222', () => pool.listAvailableCredentials('workbuddy', ''))
  ok(rows.length === 1 && rows[0].entry.id === 'wb-bbb222',
    'listAvailableCredentials 也只给被钉的那一个（临期折算 / 余额查询不会串号）')
}

console.log('\n边界与安全：')
{
  // 别的 provider 的账号 id 不能影响本家
  const picked = await container.runPinned('cl-ddd444', () => pool.getAvailableAccount('workbuddy', ''))
  ok(picked?.entry?.id === 'wb-aaa111', '钉的是 cline 的号 → 对 workbuddy 无效，照常按池内顺序（不跨家串号）')
}
{
  // 钉了一个池里没有的号（DSH 里删了）→ 退回不钉，而不是让整家 502
  const picked = await container.runPinned('wb-gone999', () => pool.getAvailableAccount('workbuddy', ''))
  ok(picked?.entry?.id === 'wb-aaa111', '钉的账号已不在池里 → 退回池内顺序（陈旧记录不该让整家不可用）')
}
{
  // 已停用的号：钉了也不给
  const picked = await container.runPinned('wb-ccc333', () => pool.getAvailableAccount('workbuddy', ''))
  ok(picked === null, '钉住一个已停用的账号 → 返回 null（不会绕过 enabled 判据）')
}
{
  // 调用方的显式排除集仍然生效
  const picked = await container.runPinned('wb-bbb222', () =>
    pool.getAvailableAccount('workbuddy', '', new Set(['wb-bbb222'])))
  ok(picked === null, '调用方显式排除被钉的号时返回 null（不忽略 exclude 集）')
}
{
  // 空 / 空白 / undefined 都等于不钉
  const a = await container.runPinned('', () => pool.getAvailableAccount('workbuddy', ''))
  const b = await container.runPinned('   ', () => pool.getAvailableAccount('workbuddy', ''))
  const c = await container.runPinned(undefined, () => pool.getAvailableAccount('workbuddy', ''))
  ok(a?.entry?.id === 'wb-aaa111' && b?.entry?.id === 'wb-aaa111' && c?.entry?.id === 'wb-aaa111',
    '空串 / 空白 / undefined 都等于不钉（按池内顺序）')
}

console.log('', '两层包装的叠加顺序（钉住 vs 死号过滤）：')
{
  // 钉住一个死号：死号过滤必须仍然拦得住。钉号是内层、死号过滤是外层，
  // 外层把死号并进 excludeAccountIds 传给内层，内层见自己被排除就返 null。
  const picked = await container.runPinned('wb-dead111', () => pool.getAvailableAccount('workbuddy', ''))
  ok(picked === null, '钉住一个死号 → 仍被死号过滤拦住（不会整家 502）')
  const rows = await container.runPinned('wb-dead111', () => pool.listAvailableCredentials('workbuddy', ''))
  ok(rows.length === 0, '钉住死号时 listAvailableCredentials 也是空的')
}
{
  // 钉住限流号 + 该模型已限流：两个入口必须给出一致答案（都不能给）。
  const got = await container.runPinned('wb-lmt222', () => pool.getAvailableAccount('workbuddy', 'm-locked'))
  const rows = await container.runPinned('wb-lmt222', () => pool.listAvailableCredentials('workbuddy', 'm-locked'))
  ok(got === null && rows.length === 0,
    '钉住限流号 + 该模型限流未到期 → getAvailableAccount 与 listAvailableCredentials 都给不出（判据一致）')
}
{
  // 同一个限流号，换个没被限流的模型就应该能用。
  const picked = await container.runPinned('wb-lmt222', () => pool.getAvailableAccount('workbuddy', 'm-free'))
  ok(picked?.entry?.id === 'wb-lmt222', '同一个号换到未被限流的模型 → 正常可用（限流判据是按模型的）')
}

console.log('\n并发隔离（AsyncLocalStorage 的存在理由）：')
{
  // 两个请求同时钉不同账号。若实现是「设全局变量再还原」，这里必然串。
  const [x, y] = await Promise.all([
    container.runPinned('wb-aaa111', async () => {
      await new Promise((r) => setTimeout(r, 30))
      return (await pool.getAvailableAccount('workbuddy', ''))?.entry?.id
    }),
    container.runPinned('wb-bbb222', async () => {
      await new Promise((r) => setTimeout(r, 10))
      return (await pool.getAvailableAccount('workbuddy', ''))?.entry?.id
    }),
  ])
  ok(x === 'wb-aaa111' && y === 'wb-bbb222', '两个并发请求各钉各的号，互不串（全局变量实现会在这里挂）')
}

console.log('\n幂等：')
{
  const before = pool.getAvailableAccount
  container._pinAccounts(ctx)
  ok(pool.getAvailableAccount === before, '重复安装幂等（不套两层包装）')
}

console.log(`\n✓ 全部通过（${pass} 项）`)
process.exit(0)
