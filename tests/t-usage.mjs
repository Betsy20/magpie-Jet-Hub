// auth.usage 契约测试：真实调用本体 credits.balances，断言形状。
//
// 为什么要有这个测试：magpie 的用量卡此前显示「上游模型 / 当前可用」这种
// 自造条目，用户要的是**真实积分**（m07216「账号积分也未接入」）。
import * as mod from '../src/plugin.mjs'

const problems = []
const ok = (cond, msg) => { if (!cond) problems.push(msg) }

// 1) 契约：每个 provider 都要有 usage，且形参是 (getAuth, provider)
for (const [id, fn] of mod.PLUGINS) {
  const plugin = await fn({}, {})
  ok(typeof plugin.auth.usage === 'function', `${id}: 缺 auth.usage`)
}

// 2) 真实读数：workbuddy 有 20 个账号，取第二个账号，必须精确匹配
const fn = mod.PLUGINS.find(([i]) => i === 'jet-hub-workbuddy')[1]
const plugin = await fn({}, {})
const getAuth = async () => ({
  type: 'api',
  key: 'jet-hub-local:workbuddy/workbuddy-bb3380f3',
  uid: 'workbuddy-bb3380f3',
  accountId: 'betsy030',
})
const u = await plugin.auth.usage(getAuth, { id: 'jet-hub-workbuddy' })
console.log('usage =', JSON.stringify(u).slice(0, 300))

ok(u.error === undefined || u.error === '', `workbuddy 不该报错：${u.error}`)
ok(typeof u.balance === 'string' && u.balance !== '', 'balance 应为非空字符串')
ok(u.user === 'betsy030', `user 应为该账号昵称，实际 ${u.user}`)
ok(Array.isArray(u.windows) && u.windows.length > 0, 'windows 应非空')
for (const w of u.windows ?? []) {
  ok(typeof w.name === 'string' && w.name !== '', 'window 缺 name')
  ok(w.used === null || (typeof w.used === 'number' && w.used >= 0 && w.used <= 200), `window used 越界：${w.used}`)
  ok(typeof w.display === 'string' && w.display !== '', 'window 缺 display')
  ok(w.amount === undefined || typeof w.amount === 'number', 'window amount 应为数字')
}
// 空套餐必须被过滤掉（astudio 的 total=0 条目踩过）
ok(!(u.windows ?? []).some((w) => w.limit === 0 && w.amount === 0), '空套餐 0/0 应被过滤')

// 3) 错误路径：余额查询失败要原样报，不能当成 0 积分
const fn2 = mod.PLUGINS.find(([i]) => i === 'jet-hub-codearts')[1]
const p2 = await fn2({}, {})
const u2 = await p2.auth.usage(async () => ({ uid: '', accountId: 'x' }), { id: 'jet-hub-codearts' })
console.log('codearts =', JSON.stringify(u2).slice(0, 200))
ok(typeof u2.error === 'string' && u2.error !== '', 'codearts 凭据失效应报 error（不能是 0 积分）')

// 4) 路由组：没有可查账号，返回模型计数而不是报错
const fn3 = mod.PLUGINS.find(([i]) => i === 'jet-hub-aggregate')[1]
if (fn3) {
  const p3 = await fn3({}, {})
  const u3 = await p3.auth.usage(async () => ({ uid: '' }), { id: 'jet-hub-aggregate' })
  console.log('aggregate =', JSON.stringify(u3).slice(0, 200))
  ok(Array.isArray(u3.windows), 'aggregate 应返回 windows 数组')
}

if (problems.length) {
  console.log('✗ ' + problems.length + ' 处不符：')
  for (const p of problems) console.log('  ' + p)
  process.exit(1)
}
console.log('✓ usage 契约与真实读数均正确')
process.exit(0)
