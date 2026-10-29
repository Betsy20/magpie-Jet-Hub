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

// 3) 失败要原样报，不能吞成 0 积分。
//
// 这里原本钉死「codearts 凭据失效必须报 error」—— 断言本身没错，但它把
// **上游账号当时的健康状态**当成了契约。账号一旦恢复登录（或换了条账号，
// 见下面第 5 节的兜底逻辑），这条就必然假失败：实测 2026-10-29 该账号
// 返回了真实余额 28700 credit，测试却报「凭据失效应报 error」。
// 真正要守的契约与账号健康无关，只有两条：
//   ① 有 error 就非空（别把失败渲染成空白卡）；
//   ② 有余额就非空（别把失败渲染成 0）。
// 换句话说：任何情况下都不能既没 error 又没有余额。
const fn2 = mod.PLUGINS.find(([i]) => i === 'jet-hub-codearts')[1]
const p2 = await fn2({}, {})
const u2 = await p2.auth.usage(async () => ({ uid: '', accountId: 'x' }), { id: 'jet-hub-codearts' })
console.log('codearts =', JSON.stringify(u2).slice(0, 200))
const hasError = typeof u2.error === 'string' && u2.error !== ''
const hasBalance = typeof u2.balance === 'string' && u2.balance !== ''
ok(hasError || hasBalance, 'codearts 既没 error 也没余额（失败被吞成 0 积分）')
ok(!hasError || u2.error.trim() !== '', 'codearts 的 error 是空白字符串')
ok(!(u2.error === undefined && (u2.windows ?? []).length === 0), 'codearts 无读数时应报 error 而非空卡')

// 4) 路由组：没有可查账号，返回模型计数而不是报错
const fn3 = mod.PLUGINS.find(([i]) => i === 'jet-hub-aggregate')[1]
if (fn3) {
  const p3 = await fn3({}, {})
  const u3 = await p3.auth.usage(async () => ({ uid: '' }), { id: 'jet-hub-aggregate' })
  console.log('aggregate =', JSON.stringify(u3).slice(0, 200))
  ok(Array.isArray(u3.windows), 'aggregate 应返回 windows 数组')
  // ⚠️ 回归守卫：直连改造删掉了 container.port，这行曾拼出
  //    「容器 127.0.0.1:undefined」直接显示在 magpie 的用量卡上。
  //    原来只断言 windows 是数组，所以测试全绿也没发现 —— 这里把文案钉住。
  const display = String(u3.windows?.[0]?.display ?? '')
  ok(display !== '', 'aggregate 的 window 缺 display')
  ok(!display.includes('undefined'), `aggregate 的 display 出现 undefined：${display}`)
  ok(!display.includes('127.0.0.1'), `直连模式不该再出现本地端口：${display}`)
}

// 5) 空 uid 兜底：本体是逐账号兜错的，坏账号的 error 会把整张卡变成内部堆栈文案。
//    退回账号时必须优先挑没有 error 的那条，且透出去的文案不能是裸 TypeError。
const fn4 = mod.PLUGINS.find(([i]) => i === 'jet-hub-workbuddy')[1]
if (fn4) {
  const p4 = await fn4({}, {})
  const u4 = await p4.auth.usage(async () => ({ uid: '' }), { id: 'jet-hub-workbuddy' })
  console.log('workbuddy(空uid) =', JSON.stringify(u4).slice(0, 200))
  ok(
    !/^Cannot read propert/.test(String(u4.error ?? '')),
    `空 uid 时不该把裸 TypeError 透给用户：${u4.error}`,
  )
}

// 6) 积分包合并：同名同单位的包必须合成一条。
//
// 用户 m05242 的反馈是「用量积分包占比太大了」—— 实测 trae 一个账号有 20+ 条
// `{name:'签到奖励', total:100}`，每条都变成一个 window，magpie 的用量卡被撑成
// 一长列 100/100，真正的「每月登录赠送 500」反而被淹没。
//
// 判据（从源码里截 mergePackages/toMagpieUsage 求值，不复制粘贴）：
//   ① 同名同单位合并成一条，名字带 ×N；
//   ② total / remaining 求和；
//   ③ 排序按**组内单包最大额度**，主套餐排在「一堆小包」前面；
//   ④ aside（active:false）压到最后。
{
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../src/plugin.mjs', import.meta.url), 'utf8')
  const from = src.indexOf('function mergePackages')
  const to = src.indexOf(String.fromCharCode(10) + 'function writeCache')
  ok(from > 0 && to > from, '从 src/plugin.mjs 截不到 mergePackages/toMagpieUsage')
  if (from > 0 && to > from) {
    const body = src.slice(from, to)
    const { toMagpieUsage } = new Function(
      'DISPLAY_NAME',
      'humanizeUsageError',
      body + String.fromCharCode(10) + 'return { mergePackages, toMagpieUsage }',
    )('Jet Hub', (x) => String(x))

    const big = { name: '每月登录赠送', unit: 'credits', remaining: 500, total: 500, used: 0, active: true, deductionEndTime: 1793462399000 }
    const small = Array.from({ length: 20 }, (_, i) => ({
      name: '签到奖励', unit: 'credits', remaining: 100, total: 100, used: 0, active: true,
      deductionEndTime: 1793292923000 + i * 86400000,
    }))
    const dead = { name: '已过期包', unit: 'credits', remaining: 0, total: 0, active: false }
    const u6 = toMagpieUsage(
      { provider: 'trae', accountId: 'a', nickname: 'n', balance: { total: 3650, packages: [big, ...small, dead] } },
      'trae',
    )
    const ws = u6.windows ?? []
    console.log('trae 合并后 windows =', JSON.stringify(ws.map((w) => w.name + ' ' + w.display)))
    ok(ws.length === 2, `23 个包（20 小 + 1 大 + 1 空）应合并成 2 条，实际 ${ws.length} 条`)
    const bonus = ws.find((w) => String(w.name).includes('签到奖励'))
    ok(bonus !== undefined, '合并后应还有「签到奖励」这一条')
    ok(bonus && String(bonus.name).includes('×20'), `合并条目名字应带 ×20，实际 ${bonus?.name}`)
    ok(bonus && bonus.limit === 2000 && bonus.amount === 2000, `合并后 total/remaining 应各为 2000，实际 ${bonus?.limit}/${bonus?.amount}`)
    ok(ws[0]?.name === '每月登录赠送', `主套餐（单包 500）应排在「20 个 100 的小包」前面，实际第一条是 ${ws[0]?.name}`)
    ok(ws.every((w) => w.limit > 0), '合并后不该留下 0/0 的空包')

    // 到期时间取合并组里最早的那个（最近要过期的先提醒）
    ok(bonus && bonus.resetsAt === 1793292923000, `合并组 resetsAt 应取最早，实际 ${bonus?.resetsAt}`)

    // aside 压到最后
    const u7 = toMagpieUsage(
      {
        provider: 'x', accountId: 'a', nickname: 'n',
        balance: {
          total: 600,
          packages: [
            // 三审指出的盲区：原来「已失效」总额更小（100 < 500），aside 判据
            // 即使被删掉、靠额度比较也能得出同样顺序 ⇒ 断言恒真。
            // 改成「已失效总额**更大**」，aside 判据成为唯一决定因素。
            { name: '已失效', unit: 'credits', remaining: 900, total: 900, active: false },
            { name: '在用的', unit: 'credits', remaining: 500, total: 500, active: true },
          ],
        },
      },
      'x',
    )
    const ws7 = u7.windows ?? []
    ok(ws7[0]?.name === '在用的', `aside 应压到最后，实际第一条是 ${ws7[0]?.name}`)
    ok(ws7[ws7.length - 1]?.aside === true, '最后一条应带 aside 标记')

    // 排序判据必须是「组内单包最大额度」而不是平均值。
    //
    // 2026-10-29 四审的 M-G 变异指出：原来只有 trae 那组夹具（主套餐 500 vs
    // 签到组 100），最大值和平均值给出的顺序相同，测不出差别。这里补一个
    // **平均值会被稀释** 的场景：一个 500 的大包 + 19 个 1 的小包合成一组
    // （each = 500，avg ≈ 25.9），另一家单个 300 的包（each = avg = 300）。
    //   · 最大值判据 → 大包组在前（正确）
    //   · 平均值判据 → 另一家在前（错误，主套餐被小包压下去）
    const u8 = toMagpieUsage(
      {
        provider: 'x', accountId: 'a', nickname: 'n',
        balance: {
          total: 819,
          packages: [
            { name: '主套餐', unit: 'c', total: 500, remaining: 500, active: true },
            ...Array.from({ length: 19 }, () => ({
              name: '主套餐', unit: 'c', total: 1, remaining: 1, active: true,
            })),
            { name: '另一家', unit: 'c', total: 300, remaining: 300, active: true },
          ],
        },
      },
      'x',
    )
    const ws8 = u8.windows ?? []
    ok(
      ws8[0]?.name === '主套餐 ×20',
      `each 判据：含大包的合并组应排第一，实际第一条是 ${ws8[0]?.name}`,
    )
  }
}

if (problems.length) {
  console.log('✗ ' + problems.length + ' 处不符：')
  for (const p of problems) console.log('  ' + p)
  process.exit(1)
}
console.log('✓ usage 契约与真实读数均正确')
process.exit(0)
