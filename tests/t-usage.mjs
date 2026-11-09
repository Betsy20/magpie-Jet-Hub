// auth.usage 契约测试：真实调用本体 credits.balances，断言形状。
//
// 为什么要有这个测试：magpie 的用量卡此前显示「上游模型 / 当前可用」这种
// 自造条目，用户要的是**真实积分**（m07216「账号积分也未接入」）。
import * as mod from '../src/plugin.mjs'

// ⚠️ 本文件会真起容器，必须隔离 —— 不隔离时 `resolveHome(undefined)` 退回
// `homedir()`，把本体 `DSH_HOME` 直指用户真实凭据目录；实测跑一次就把
// `~/.dsh/.credentials.yaml` 与 `jet-hub/state.json` 改写（cline 账号的
// access_token 被真实轮换）。三层隔离与踩过的坑写在 `tests/_iso.mjs` 文件头。
import { isolate, live, skipLive } from './_iso.mjs'

const iso = isolate()

const problems = []
const ok = (cond, msg) => { if (!cond) problems.push(msg) }

// 1) 契约：每个 provider 都要有 usage，且形参是 (getAuth, provider)
for (const [id, fn] of mod.PLUGINS) {
  const plugin = await fn({}, iso.options())
  ok(typeof plugin.auth.usage === 'function', `${id}: 缺 auth.usage`)
}

// ⚠️ 下面这段打的是**真实账号**（隔离沙箱里没有凭据 ⇒ 默认跳过）。
// 保留它的理由：`user` / `balance` 这些字段只有真凭据路径才产出，是
// 「积分真的连上了」的唯一硬证据。跑法：`JET_HUB_LIVE=1 node tests/t-usage.mjs`。
if (live()) {
  // 真实段落必须先**撤销隔离**：沙箱里没有 `.credentials.yaml`，不撤销就只能拿到
  // 「上游模型 / 当前可用」这种没有余额的兜底卡，等于白跑。
  // ⚠️ 必须先丢掉隔离段建的那个容器单例：`iso.restore()` 只恢复环境变量，
  //    而 `shared` 已经按隔离 home 钉死了，不丢的话真实段读到的还是空目录。
  mod.__resetContainerForTest()
  iso.restore()
  // 2) 真实读数：从账号池里**动态**挑一个已启用的 workbuddy 账号。
  //
  // 原来这里写死了 `workbuddy-9c0d1e2f` + 昵称 `user-g7h8`。那是**当时机器上恰好在池里**的一条，
  // 账号一旦被删（本机 2026-10-31 已不在），这条就变成永久假失败：
  // 读到的不是“契约坏了”而是“被试体没了”。契约本身不依赖具体哪一条：
  // 任意一个已启用账号都应归回它自己的昵称与非空余额。
  const statePath = `${process.env.USERPROFILE || process.env.HOME}/.dsh/jet-hub/state.json`
  let wbAccount
  try {
    const st = JSON.parse(await import('node:fs').then((m) => m.readFileSync(statePath, 'utf8')))
    wbAccount = (st.accounts || []).find(
      (a) => a?.provider === 'workbuddy' && a?.enabled !== false && a?.credentialRef,
    )
  } catch {
    wbAccount = undefined
  }
  if (wbAccount === undefined) {
    skipLive('真实积分读数（workbuddy）—— 账号池里没有已启用的 workbuddy 账号')
  } else {
    const fn = mod.PLUGINS.find(([i]) => i === 'jet-hub-workbuddy')[1]
    const plugin = await fn({}, {})
    const getAuth = async () => ({
      type: 'api',
      key: `jet-hub-local:workbuddy/${wbAccount.id}`,
      uid: wbAccount.id,
      accountId: wbAccount.nickname,
    })
    const u = await plugin.auth.usage(getAuth, { id: 'jet-hub-workbuddy' })
    console.log('usage =', JSON.stringify(u).slice(0, 300))

    ok(u.error === undefined || u.error === '', `workbuddy 不该报错：${u.error}`)
    ok(typeof u.balance === 'string' && u.balance !== '', 'balance 应为非空字符串')
    ok(u.user === wbAccount.nickname, `user 应为该账号昵称 ${wbAccount.nickname}，实际 ${u.user}`)
    ok(Array.isArray(u.windows) && u.windows.length > 0, 'windows 应非空')
    for (const w of u.windows ?? []) {
      ok(typeof w.name === 'string' && w.name !== '', 'window 缺 name')
      ok(w.used === null || (typeof w.used === 'number' && w.used >= 0 && w.used <= 200), `window used 越界：${w.used}`)
      ok(typeof w.display === 'string' && w.display !== '', 'window 缺 display')
      ok(w.amount === undefined || typeof w.amount === 'number', 'window amount 应为数字')
    }
    // 空套餐必须被过滤掉（astudio 的 total=0 条目踩过）
    ok(!(u.windows ?? []).some((w) => w.limit === 0 && w.amount === 0), '空套餐 0/0 应被过滤')
  }
} else {
  skipLive('真实积分读数（workbuddy）')
}

// ⚠️ 下面这段打的是**真实账号**（隔离沙箱里没有凭据 ⇒ 默认跳过）。
// 保留它的理由：`user` / `balance` 这些字段只有真凭据路径才产出，是
// 「积分真的连上了」的唯一硬证据。跑法：`JET_HUB_LIVE=1 node tests/t-usage.mjs`。
if (live()) {
  // ⚠️ 必须先丢掉隔离段建的那个容器单例：`iso.restore()` 只恢复环境变量，
  //    而 `shared` 已经按隔离 home 钉死了，不丢的话真实段读到的还是空目录。
  mod.__resetContainerForTest()
  iso.restore()
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
} else {
  skipLive('codearts 失败语义（真实账号）')
}

// ⚠️ 这一段也走真实容器/真实账号，同样 opt-in。
if (live()) {
  // ⚠️ 必须先丢掉隔离段建的那个容器单例：`iso.restore()` 只恢复环境变量，
  //    而 `shared` 已经按隔离 home 钉死了，不丢的话真实段读到的还是空目录。
  mod.__resetContainerForTest()
  iso.restore()
  // 4) 直连模式的用量卡文案：不能出现 `undefined` 与本地端口。
  //
  // 原来这一节拿 `jet-hub-aggregate`（路由组）当被试体，因为它没有可查账号、
  // 用量卡只能靠模型计数兑底。路由组不再注册成 provider 后，这个被试体没了，
  // 但它守的那个回归（直连改造删掉了 container.port，曾拼出
  // 「容器 127.0.0.1:undefined」直接显示在用量卡上）仍然有效 —— 换成任一家
  // 真渠道都行：只要它拿得到用量。拿不到（没登录）就跳过，不假绿。
  const fn3pair = mod.PLUGINS.find(([, f]) => typeof f === 'function')
  if (fn3pair) {
    const p3 = await fn3pair[1]({}, {})
    const u3 = await p3.auth.usage(async () => ({ uid: '' }), {})
    const first = u3.windows?.[0]
    if (first !== undefined) {
      const display = String(first.display ?? '')
      ok(display !== '', `${fn3pair[0]} 的 window 缺 display`)
      ok(!display.includes('undefined'), `${fn3pair[0]} 的 display 出现 undefined：${display}`)
      ok(!display.includes('127.0.0.1'), `直连模式不该再出现本地端口：${display}`)
    } else {
      skipLive(`${fn3pair[0]} 的 usage 没拿到 windows（该家没登录）`)
    }
  }

} else {
  skipLive('路由组 usage（真实容器）')
}
// ⚠️ 这一段也走真实容器/真实账号，同样 opt-in。
if (live()) {
  // ⚠️ 必须先丢掉隔离段建的那个容器单例：`iso.restore()` 只恢复环境变量，
  //    而 `shared` 已经按隔离 home 钉死了，不丢的话真实段读到的还是空目录。
  mod.__resetContainerForTest()
  iso.restore()
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

} else {
  skipLive('workbuddy 空 uid 兜底（真实账号）')
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
//   ③ 名字里带到期日（用户 m07331：「能看到每个积分包的过期时间」）；
//   ④ 排序首判据是**到期时间**，快到期的排前面（用户 m07331：「按到期顺序展示」）；
//   ⑤ 同一到期档内再按**组内单包最大额度**降序（旧的额度语义保住了，但降为次判据）；
//   ⑥ aside（active:false）压到最后。
{
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../src/plugin.mjs', import.meta.url), 'utf8')
  // 起点要在 groupName 之前：mergePackages 会调它，截漏就 ReferenceError。
  const from = src.indexOf('function groupName')
  const to = src.indexOf(String.fromCharCode(10) + 'function writeCache')
  ok(from > 0 && to > from, '从 src/plugin.mjs 截不到 mergePackages/toMagpieUsage')
  if (from > 0 && to > from) {
    const body = src.slice(from, to)
    // `NAMES` 也要当形参传进去：`toMagpieUsage` 的 `plan` 现在取
    // `NAMES[provider] ?? provider`（2026-10-30 去掉「Jet Hub · 」前缀后不再用
    // `DISPLAY_NAME`），漏传会 ReferenceError。值取真实表的前几项即可 ——
    // 下面的断言只看 plan 是否带前缀，不看具体名字。
    const NAMES_FIXTURE = { trae: 'TRAE (字节)', workbuddy: 'WorkBuddy (国际版)', codearts: 'CodeArts (华为云)' }
    const { toMagpieUsage, windowName, dateLabel } = new Function(
      'NAMES',
      'humanizeUsageError',
      // 切片范围（groupName…writeCache）不含这两个 —— 每日额度基线在文件更前面。
      // 桩语义与 src 一致：**首见额度即分母**，之后不再变（测试里用全局表模拟）。
      'isDailyPool',
      'dailyTotalOf',
      body + String.fromCharCode(10) + 'return { mergePackages, toMagpieUsage, windowName, dateLabel }',
    )(
      NAMES_FIXTURE,
      (x) => String(x),
      (name) => ['每日积分', '每日赠送', '每日额度', '每日签到奖励'].includes(String(name ?? '').trim()),
      // 每个 key 记住第一次见到的余额当分母；之后只抬不降（与 src 的 dailyTotalOf 同语义）
      (() => {
        const base = new Map()
        return (key, remaining) => {
          if (!base.has(key) || remaining > base.get(key)) base.set(key, remaining)
          return base.get(key)
        }
      })(),
    )

    // 到期时间一律用**相对当前时间的未来值**：渲染期会按 deductionEndTime
    // 重算过期（过期组改 text 窗口），写死绝对时间戳会让夹具在某天悄悄变过期。
    const T0 = Date.now()
    const DAY = 86400000
    const big = { name: '每月登录赠送', unit: 'credits', remaining: 500, total: 500, used: 0, active: true, deductionEndTime: T0 + 30 * DAY }
    const small = Array.from({ length: 20 }, (_, i) => ({
      name: '签到奖励', unit: 'credits', remaining: 100, total: 100, used: 0, active: true,
      deductionEndTime: T0 + DAY + i * DAY,
    }))
    const dead = { name: '已过期包', unit: 'credits', remaining: 0, total: 0, active: false }
    const u6 = toMagpieUsage(
      { provider: 'trae', accountId: 'a', nickname: 'n', balance: { total: 3650, packages: [big, ...small, dead] } },
      'trae',
    )
    const ws = u6.windows ?? []
    console.log('trae 合并后 windows =', JSON.stringify(ws.map((w) => w.name + ' ' + w.display)))
    ok(ws.length === 2, `22 个包（20 小 + 1 大 + 1 空）应合并成 2 条，实际 ${ws.length} 条`)
    const bonus = ws.find((w) => String(w.name).includes('签到奖励'))
    ok(bonus !== undefined, '合并后应还有「签到奖励」这一条')
    ok(bonus && String(bonus.name).includes('×20'), `合并条目名字应带 ×20，实际 ${bonus?.name}`)
    ok(bonus && bonus.limit === 2000 && bonus.amount === 2000, `合并后 total/remaining 应各为 2000，实际 ${bonus?.limit}/${bonus?.amount}`)
    ok(bonus && String(bonus.name).includes('到期'), `合并条目名字应带到期日（用户要求「能看到过期时间」），实际 ${bonus?.name}`)
    // 排序首判据是**到期时间**，不是额度。
    //
    // 本夹具里 small 的到期日从 T0+DAY 起逐日递增、big（主套餐）是
    // T0+30*DAY ⇒ 小包组最早那一天比主套餐更早，小包组排前面。
    //
    // 这与旧断言（「主套餐应排第一」）相反，是**需求变更后的预期结果**：
    // 用户 m07331 明确要求「按到期顺序展示」，额度退为同档内的次判据。
    // 这不是回归，别把它改回去 —— 想看额度优先的行为请看下面 u9 的第二段
    // （主套餐更早过期时它照样排第一）。
    ok(
      String(ws[0]?.name).startsWith('签到奖励'),
      `到期更早的组应排第一（该组最早 T0+DAY 早于主套餐 T0+30*DAY），实际第一条是 ${ws[0]?.name}`,
    )
    ok(ws.every((w) => w.limit > 0), '合并后不该留下 0/0 的空包')

    // 到期时间取合并组里最早的那个（最近要过期的先提醒）
    ok(bonus && bonus.resetsAt === T0 + DAY, `合并组 resetsAt 应取最早，实际 ${bonus?.resetsAt}`)

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

    // 到期时间的两个方向都要测，否则「按到期排序」可能被写成「按额度排序 + 名字带日期」。
    //
    // u9 的第一段：**主套餐额度更大且到期更早** ⇒ 两条判据同向，主套餐第一。
    //   这一段防的是「到期判据被整个删掉」—— 删掉后靠 each 也能得到同样顺序，
    //   所以它单独不构成证明，真正的证明是上面 trae 那段（到期判据逆行时仍按到期）。
    // u9 的第二段：**主套餐额度更大但到期更晚** ⇒ 小包组第一。
    //   这一段才是到期判据的唯一决定因素：删掉到期判据、只剩 each，顺序会反过来。
    const u9 = toMagpieUsage(
      {
        provider: 'x', accountId: 'a', nickname: 'n',
        balance: {
          total: 1200,
          packages: [
            // 主套餐 500 到期 T0+5d；小包 20 个 100 到期 T0+15d 起。
            { name: '主套餐', unit: 'c', total: 500, remaining: 500, active: true, deductionEndTime: T0 + 5 * DAY },
            ...Array.from({ length: 20 }, (_, i) => ({
              name: '小包', unit: 'c', total: 100, remaining: 100, active: true,
              deductionEndTime: T0 + 15 * DAY + i * DAY,
            })),
          ],
        },
      },
      'x',
    )
    const ws9 = u9.windows ?? []
    ok(
      String(ws9[0]?.name).startsWith('主套餐'),
      `到期更早（且额度更大）的主套餐应排第一，实际第一条是 ${ws9[0]?.name}`,
    )

    const u10 = toMagpieUsage(
      {
        provider: 'x', accountId: 'a', nickname: 'n',
        balance: {
          total: 5500,
          packages: [
            // 主套餐 500 到期 T0+30d 更晚；小包 50 个 100 到期 T0+DAY 起。
            { name: '主套餐', unit: 'c', total: 500, remaining: 500, active: true, deductionEndTime: T0 + 30 * DAY },
            ...Array.from({ length: 50 }, (_, i) => ({
              name: '小包', unit: 'c', total: 100, remaining: 100, active: true,
              deductionEndTime: T0 + DAY + i * DAY,
            })),
          ],
        },
      },
      'x',
    )
    const ws10 = u10.windows ?? []
    ok(
      String(ws10[0]?.name).startsWith('小包'),
      `到期判据必须压过额度判据：小包额度小但先过期，应排第一，实际第一条是 ${ws10[0]?.name}`,
    )

    // 同一到期档（都没有到期时间）仍按 each 降序 —— 保住旧语义。
    const u11 = toMagpieUsage(
      {
        provider: 'x', accountId: 'a', nickname: 'n',
        balance: {
          total: 800,
          packages: [
            { name: '小的', unit: 'c', total: 100, remaining: 100, active: true },
            { name: '大的', unit: 'c', total: 700, remaining: 700, active: true },
          ],
        },
      },
      'x',
    )
    const ws11 = u11.windows ?? []
    ok(
      ws11[0]?.name === '大的',
      `同档（都无到期时间）内应按额度降序，实际第一条是 ${ws11[0]?.name}`,
    )

    // 日期标签：今年只写 MM-DD，非今年必须带年份。
    //
    // 起因是实测输出 `Bonus Pack ×2 · 11-04~04-01 到期` 与
    // `Free Plan Subscription · 01-01 到期` —— 后者真实到期是 **2034-12-28**，
    // 只写 `01-01` 会让人以为一个多月后就没了。
    {
      const now = new Date(2026, 9, 30, 12, 0, 0).getTime() // 2026-10-30 本地时间
      ok(dateLabel(new Date(2026, 10, 4, 0, 0, 0).getTime(), now) === '11-04', '今年的日期应只写 MM-DD')
      ok(
        dateLabel(new Date(2034, 11, 28, 0, 0, 0).getTime(), now) === '2034-12-28',
        `非今年的日期必须带年份（否则 2034-12-28 会显示成 12-28），实际 ${dateLabel(new Date(2034, 11, 28, 0, 0, 0).getTime(), now)}`,
      )
      ok(dateLabel(Number.NaN, now) === '', '非法时间戳应返回空串而不是 Invalid Date')

      // 组内首尾跨年 ⇒ 两端都带年份
      const cross = windowName({
        name: 'Bonus Pack', count: 2,
        untils: [new Date(2026, 10, 4, 0, 0, 0).getTime(), new Date(2027, 2, 28, 0, 0, 0).getTime()],
      })
      ok(
        cross === 'Bonus Pack ×2 · 2026-11-04~2027-03-28 到期',
        `跨年区间两端都应带年份，实际 ${cross}`,
      )
    }
  }
}

// ── 「本次查询失败，但还有上一次快照」的展示 ────────────────────────
//
// 起因（2026-11-01 用户截图）：OfficeAce 的卡片只显示「暂时无法获取额度：本次查询失败，
// 显示的是上一次成功读到的数据（可能已过期）」，一个数字都没有 —— 说自己显示了旧数据，
// 而画面上什么都没有。原因是两层相叠：上游对「有快照 + 本次失败」故意把快照一起回传并
// 带 `error` 标注；而 magpie 一见 `error` 就整块只画错误、不画 `windows`。
// 修法：有快照就照常画 windows，把「本次未刷新」写进第一条的名字；真没快照才回 error。
{
  console.log('')
  // 从源码里截 mergePackages/toMagpieUsage 求值，避免复制一份逻辑。
  const fs2 = await import('node:fs')
  const src2 = fs2.readFileSync(new URL('../src/plugin.mjs', import.meta.url), 'utf8').replace(/\r\n/g, String.fromCharCode(10))
  const a2 = src2.indexOf('function windowName(')
  const b2 = src2.indexOf('function writeCache(')
  ok(a2 >= 0 && b2 > a2, '能从 src/plugin.mjs 截到 windowName 到 toMagpieUsage 的片段')
  const fn2 = new Function(
    'NAMES',
    'humanizeUsageError',
    // 切片范围不含每日额度基线（它在文件更前面），必须注入桩，否则 ReferenceError。
    'isDailyPool',
    'dailyTotalOf',
    // 起点要在 mergePackages 之前：toMagpieUsage 会调它，截漏就 ReferenceError。
    // 起点要在 groupName 之前：它被 mergePackages 调用，截漏就 ReferenceError。
    src2.slice(src2.indexOf('function groupName('), b2) + String.fromCharCode(10) + 'return { toMagpieUsage, groupName }',
  )(
    { officeace: 'OfficeAce' },
    (x) => `已人化:${x}`,
    (name) => ['每日积分', '每日赠送', '每日额度', '每日签到奖励'].includes(String(name ?? '').trim()),
    (() => {
      const base = new Map()
      return (key, remaining) => {
        if (!base.has(key) || remaining > base.get(key)) base.set(key, remaining)
        return base.get(key)
      }
    })(),
  )

  const withSnapshot = {
    provider: 'officeace',
    accountId: 'officeace-1',
    nickname: 'OfficeAce 5c2eddfe',
    // 上游在「有快照 + 本次失败」时就是这个形状：数据在，另带一条 error。
    balance: {
      total: 100,
      packages: [{
        name: '每日签到有礼', unit: 'Token', remaining: 100, total: 100, used: 0, active: true,
        // ⚠️ 必须有周期字段：本节的断言是「旧快照的数据别丢」，需要一个**确定是配额**
        // 的包。没有周期的 `total===remaining && used===0` 包与钱包同形，会被
        // toMagpieUsage 判成 wallet（只报 `N left`、不画分母），那时 display/used
        // 本来就不该有 —— 那是另一条契约，见 t-usage.mjs 后面的钱包小节。
        cycleStartTime: '2026-11-01 00:00:00',
        cycleEndTime: '2026-11-30 23:59:59',
      }],
    },
    error: '本次查询失败，显示的是上一次成功读到的数据（可能已过期）',
  }
  const uSnap = fn2.toMagpieUsage(withSnapshot, 'officeace')
  ok(
    Array.isArray(uSnap.windows) && uSnap.windows.length > 0,
    `有快照时必须照常画 windows（实际 ${JSON.stringify(uSnap.windows?.length)}）—— 否则就是「说显示了旧数据却什么都没有」`,
  )
  ok(
    !uSnap.error,
    `有快照时不能带 error（实际 ${JSON.stringify(uSnap.error)}）—— magpie 见到 error 就只画错误、不画数据`,
  )
  ok(
    String(uSnap.windows?.[0]?.name ?? '').includes('本次未刷新'),
    `第一条名字要标出「本次未刷新」（实际 ${JSON.stringify(uSnap.windows?.[0]?.name)}）`,
  )
  ok(String(uSnap.windows?.[0]?.display ?? '').includes('100'), '数据本身不能丢（display 里仍有 100）')
  // 标注是「后缀」，不是「替换」：套餐名与数字都必须原样保留，否则等于换了张脸。
  ok(
    String(uSnap.windows?.[0]?.name ?? '').includes('每日签到有礼'),
    `标注不能盖掉原套餐名（实际 ${JSON.stringify(uSnap.windows?.[0]?.name)}）`,
  )
  ok(
    Number.isFinite(uSnap.windows?.[0]?.used),
    `used 必须仍是数字（实际 ${JSON.stringify(uSnap.windows?.[0]?.used)}）`,
  )

  // ── 过期桶渲染期重算（2026-11-09 用户截图回归）──
  //
  // OfficeAce 凭据失效走 stale 快照时，上游把过期每日桶的 active 冻成 true、
  // remaining 冻成 100 ⇒ 旧码画成「100 / 100 · 剩余 100%」，还因到期最早排第一
  // 占住卡片前两行。deductionEndTime 才是「这批积分何时作废」的硬事实，
  // 渲染期必须按当前时间重算：过期组改 text 窗口、aside 压后。
  const uExpired = fn2.toMagpieUsage(
    {
      provider: 'officeace',
      accountId: 'officeace-exp',
      balance: {
        total: 4100,
        packages: [
          // 故意 active:true（stale 快照冻住的形状）+ 到期在过去
          { name: '每日签到有礼', unit: 'Token', remaining: 100, total: 100, used: 0, active: true, deductionEndTime: Date.now() - 86400000 },
          { name: '新用户专属福利', unit: 'Token', remaining: 1314.48, total: 4000, used: 2685.52, active: true, deductionEndTime: Date.now() + 4 * 86400000 },
        ],
      },
      error: '本次查询失败，显示的是上一次成功读到的数据（可能已过期）',
    },
    'officeace',
  )
  const wsExp = uExpired.windows ?? []
  ok(wsExp.length === 2, `过期桶不该被丢掉（实际 ${wsExp.length} 条）`)
  ok(
    String(wsExp[0]?.name ?? '').startsWith('新用户专属福利'),
    `过期桶必须压后、活跃包占第一行（实际第一条 ${JSON.stringify(wsExp[0]?.name)}）`,
  )
  const expW = wsExp.find((w) => String(w?.name ?? '').includes('每日签到有礼'))
  ok(expW !== undefined && String(expW.text ?? '').includes('过期'), `过期桶应改 text 窗口报「已过期作废」（实际 ${JSON.stringify(expW)}）`)
  ok(
    expW !== undefined && expW.limit === undefined && expW.used === undefined && expW.amount === undefined,
    `过期桶不该再画进度条（limit/used/amount 必须缺席，实际 ${JSON.stringify(expW)}）`,
  )
  ok(expW?.aside === true, '过期桶应带 aside 标记')
  ok(
    String(wsExp[0]?.name ?? '').includes('本次未刷新'),
    `stale 标注应落在第一条（现在是活跃包）上（实际 ${JSON.stringify(wsExp[0]?.name)}）`,
  )

  // 多个套餐时只该标第一条：magpie 行内只画前 2 条，全标就是噪音。
  const uTwo = fn2.toMagpieUsage(
    {
      provider: 'officeace',
      accountId: 'officeace-2',
      balance: {
        total: 300,
        packages: [
          { name: '每日签到有礼', unit: 'Token', remaining: 100, total: 100, used: 0, active: true },
          { name: '个人体验版', unit: 'Token', remaining: 200, total: 200, used: 0, active: true },
        ],
      },
      error: '本次查询失败，显示的是上一次成功读到的数据（可能已过期）',
    },
    'officeace',
  )
  const marked = (uTwo.windows ?? []).filter((w) => String(w?.name ?? '').includes('本次未刷新'))
  ok(marked.length === 1, `只标第一条（实际标了 ${marked.length} 条）`)

  // 有快照、但所有套餐都是 0/0，且本次失败：没有数字可画，必须照实报错。
  // 否则 magpie 会画成「Balance 0 积分」的健康读数 —— 比空白更误导。
  const uZero = fn2.toMagpieUsage(
    {
      provider: 'officeace',
      accountId: 'officeace-3',
      balance: {
        total: 0,
        packages: [{ name: '每日签到有礼', unit: 'Token', remaining: 0, total: 0, used: 0, active: true }],
      },
      error: '本次查询失败，显示的是上一次成功读到的数据（可能已过期）',
    },
    'officeace',
  )
  ok(
    uZero.error !== undefined,
    `全 0/0 且本次失败时必须报错（实际 ${JSON.stringify(uZero.error)}）—— 否则 magpie 画成「0 积分」健康读数`,
  )
  ok(Array.isArray(uZero.windows) && uZero.windows.length === 0, '全 0/0 时 windows 为空')

  // ── 名字里带发放日的包要归成一类 ──
  //
  // 上游 minimax 把每个积分包起名成 `积分包 2026/10/9`（发放日，每笔都不同）。
  // 按原名分组的话，30 笔赠送就是 30 行一模一样的流水账（2026-11-01 用户截图）。
  const gn = fn2.groupName
  ok(gn('积分包 2026/10/9') === '积分包', `剥掉结尾的 yyyy/m/d（实际 ${JSON.stringify(gn('积分包 2026/10/9'))}）`)
  ok(gn('积分包 2026-10-09') === '积分包', `剥掉结尾的 yyyy-mm-dd（实际 ${JSON.stringify(gn('积分包 2026-10-09'))}）`)
  ok(gn('每日签到有礼') === '每日签到有礼', '不带日期的名字原样保留')
  ok(gn('Free Plan Subscription') === 'Free Plan Subscription', 'Free Plan 不能被误剥')
  ok(gn(' 2026/10/9') === '2026/10/9', '只由日期组成的名字剥空后要退回原名（不能变成空串）')

  // 到期时间用相对当前时间的未来值（渲染期会重算过期，绝对时间戳会某天悄悄变过期）
  const T1 = Date.now()
  const DAY1 = 86400000
  const uMiniPkgs = [
          ...Array.from({ length: 20 }, (_, i) => ({
            name: `积分包 2026/10/${9 + i}`,
            unit: 'credit',
            remaining: 400,
            total: 400,
            used: 0,
            active: true,
            deductionEndTime: T1 + i * DAY1,
          })),
          ...Array.from({ length: 2 }, (_, i) => ({
            name: `积分包 2026/11/${1 + i}`,
            unit: 'credit',
            remaining: 1000,
            total: 1000,
            used: 0,
            active: true,
            deductionEndTime: T1 + (25 + i) * DAY1,
          })),
        ]
  const uMini = fn2.toMagpieUsage(
    {
      provider: 'minimax',
      accountId: 'minimax-1',
      balance: {
        total: 20 * 400 + 2 * 1000,
        packages: uMiniPkgs,
      },
    },
    'minimax',
  )
  ok(
    uMini.windows?.length === 1,
    `22 笔带发放日的积分包要合成 1 条（实际 ${JSON.stringify(uMini.windows?.length)} 条）—— 否则卡片变成流水账`,
  )
  ok(
    String(uMini.windows?.[0]?.name ?? '').includes('积分包 ×22'),
    `合并后名字要带 ×22（实际 ${JSON.stringify(uMini.windows?.[0]?.name)}）`,
  )
  ok(
    !String(uMini.windows?.[0]?.name ?? '').includes('/'),
    `合并后名字里不该再留发放日（实际 ${JSON.stringify(uMini.windows?.[0]?.name)}）`,
  )
  ok(
    String(uMini.windows?.[0]?.name ?? '').includes('~'),
    `合并后要给出到期区间（实际 ${JSON.stringify(uMini.windows?.[0]?.name)}）`,
  )
  // 「最早到期」不能取第一条：夹具是升序的，实现里写成 `untils[0]` 也会绿。
  // 这里把顺序打乱再问一次，钉住「取最小」而不是「取第一个」。
  const miniPkgs = uMiniPkgs
  const uShuffled = fn2.toMagpieUsage(
    { provider: 'minimax', accountId: 'minimax-2', balance: { total: 8800, packages: [...miniPkgs].reverse() } },
    'minimax',
  )
  ok(
    uShuffled.until === T1,
    `乱序输入时 until 仍要取最早（实际 ${JSON.stringify(uShuffled.until)}，期望 ${T1}）`,
  )
  ok(
    uMini.until === T1,
    `升序输入时 until 同样是最早（实际 ${JSON.stringify(uMini.until)}）`,
  )

  // 余额是纯文本，magpie 原样贴 —— 上游给的是原始浮点，不过 fmtNum 就是 12 位小数
  // 的 `4584.442685714286 Token`（2026-11-01 用户截图）。
  const uLong = fn2.toMagpieUsage(
    {
      provider: 'officeace',
      accountId: 'officeace-9',
      balance: {
        total: 4584.442685714286,
        packages: [{ name: '个人体验版', unit: 'Token', remaining: 500, total: 500, used: 0, active: true }],
      },
    },
    'officeace',
  )
  ok(
    uLong.balance === '4584.44 Token',
    `余额最多两位小数（实际 ${JSON.stringify(uLong.balance)}）`,
  )

  // 连快照都没有：这个时候只能报错，但要带人话提示
  const uNull = fn2.toMagpieUsage(
    { provider: 'officeace', accountId: 'x', balance: null, error: '积分查询失败（凭据已失效）' },
    'officeace',
  )
  ok(uNull.error !== undefined, '没快照时必须回 error')
  ok(Array.isArray(uNull.windows) && uNull.windows.length === 0, '没快照时 windows 为空')

  // 正常读数：不能凭空多标一句
  const uOk = fn2.toMagpieUsage(
    {
      provider: 'officeace',
      accountId: 'y',
      nickname: 'n',
      balance: { total: 100, packages: [{ name: '每日签到有礼', unit: 'Token', remaining: 100, total: 100, used: 0, active: true }] },
    },
    'officeace',
  )
  ok(
    !String(uOk.windows?.[0]?.name ?? '').includes('本次未刷新'),
    `正常读数时不该有「本次未刷新」标注（实际 ${JSON.stringify(uOk.windows?.[0]?.name)}）`,
  )
}

// ── 7. 「凭据不在了」这句报错必须说人话 ────────────────────────────
//
// 上游 `collectCreditBalances` 在「凭据解析不出来」时会去读 `product.id`，而那条
// 路上的 `product` 恒为 undefined ⇒ 真实报错是
// `undefined is not an object (evaluating 'product.id')`。
// 用户看到这句只会来问「为什么额度取不到」，所以插件必须把它翻成可执行的话。
{
  const fs3 = await import('node:fs')
  const src3 = fs3.readFileSync(new URL('../src/plugin.mjs', import.meta.url), 'utf8').split(String.fromCharCode(13)).join('')
  const a3 = src3.indexOf('function humanizeUsageError(')
  const b3 = src3.indexOf('function groupName(')
  ok(a3 >= 0 && b3 > a3, '能从 src/plugin.mjs 截到 humanizeUsageError')
  const human = new Function(src3.slice(a3, b3) + String.fromCharCode(10) + 'return humanizeUsageError')()
  const cred = human("undefined is not an object (evaluating 'product.id')")
  ok(
    cred.includes('凭据'),
    `「凭据不在了」的 JSC 报错要翻成提凭据的话（实际 ${JSON.stringify(cred)}）`,
  )
  ok(
    cred.includes("evaluating 'product.id'"),
    `按约定要保留原文（同函数其它分支都留了原文，出问题才定位得到），实际 ${JSON.stringify(cred)}`,
  )
  // V8 形状：engines 是 node，只兜 JSC 等于在 node 宿主上什么都没做。
  // 它不带对象名（只有 `(reading 'id')`），所以措辞只能到「可能」。
  const v8 = human("Cannot read properties of undefined (reading 'id')")
  ok(
    v8.includes('凭据') && v8.includes('可能'),
    `V8 形状也要朝凭据方向提示（实际 ${JSON.stringify(v8)}）`,
  )
  ok(human('别的错误原样透出') === '别的错误原样透出', '不认识的错误不许改写')

  // 行为级锁：真 import vendor，构造「凭据解析不出来」的账号，看它回什么。
  // 只锁文案是没用的 —— 把 vendor 里的 `product?.id` 改回 `product.id`
  // 文案层照样绿，而真实行为会退化成一句 TypeError。实测：删守卫后这里变红。
  {
    const { collectCreditBalances } = await import('../vendor/lib/jet-hub-rpc.js')
    const out = await collectCreditBalances(
      [{ id: 'probe-account', nickname: 'probe', credentialRef: 'Definitely_Missing_Ref' }],
      undefined,
      { resolve: async () => undefined },
    )
    ok(
      out?.[0]?.error === '凭据未配置',
      `凭据缺失时 vendor 应回「凭据未配置」（实际 ${JSON.stringify(out?.[0]?.error)}）—— 回 TypeError 说明 product 判空守卫被删了`,
    )

    // 另一处同形守卫在 `collectCreditsStatus`（credits.status 那条路）。它**不会**把
    // 错误给用户（整段 catch 只 warn），所以结果层分不出来 —— 断言必须打在 warn 上：
    // 守卫在时这条路径压根不抛；删了守卫才会有带 "reading 'id'" 的 warn。
    const { collectCreditsStatus } = await import('../vendor/lib/jet-hub-rpc.js')
    const warns = []
    await collectCreditsStatus(
      [{ id: 'probe-status', nickname: 'probe', credentialRef: 'Definitely_Missing_Ref' }],
      undefined,
      { resolve: async () => undefined, warn: (m) => warns.push(String(m)) },
    )
    ok(
      !warns.some((w) => w.includes("reading 'id'")),
      `credits.status 侧也不该抛 product.id（实际 warn：${JSON.stringify(warns)}）—— 两处守卫都要在`,
    )
  }
}

// 钱包 vs 配额：没有初始总额就不能编分母（2026-11-09 用户报「剩余永远 100%」）。
//
// magpie 画进度条用 `limit` 当分母、文案「剩余 N%」。上游只给余额时我们把
// remaining 冗余填进 total ⇒ 分母==余额 ⇒ 永远 100%。契约依据
// `vendor/lib/credits.d.ts:184-196`（totalKnown:false 时面板不得并列显示）。
// 判据：① 上游明说 totalKnown:false；② 组内每份都无周期 且 used==0 且 total==remaining
//       ⇒ wallet（只给 balance，不给 limit/used，magpie 只写「N left」不画进度条）。
{
  console.log('')
  const fs3 = await import('node:fs')
  const src3 = fs3.readFileSync(new URL('../src/plugin.mjs', import.meta.url), 'utf8').replace(/\r\n/g, String.fromCharCode(10))
  const e3 = src3.indexOf('function writeCache(')
  const fn3 = new Function(
    'NAMES',
    'humanizeUsageError',
    'isDailyPool',
    'dailyTotalOf',
    src3.slice(src3.indexOf('function groupName('), e3) + String.fromCharCode(10) + 'return { toMagpieUsage }',
  )(
    { baizhi: '百度云', cline: 'Cline', codearts: 'CodeArts' },
    (x) => String(x),
    (name) => ['每日积分', '每日赠送', '每日额度', '每日签到奖励'].includes(String(name ?? '').trim()),
    (() => {
      const base = new Map()
      return (key, remaining) => {
        if (!base.has(key) || remaining > base.get(key)) base.set(key, remaining)
        return base.get(key)
      }
    })(),
  )
  const one = (pkgs) => fn3.toMagpieUsage(
    { provider: 'x', accountId: 'a', nickname: 'n', balance: { total: 0, packages: pkgs } }, 'x',
  )

  // 实机形状（2026-11-09 hcss2 实测）：
  // 百智云充值积分 total=817.04 remaining=817.04 totalKnown=false → 钱包
  const uBz = one([{ name: '充值积分', unit: 'credit', remaining: 817.04, total: 817.04, used: 0, totalKnown: false, active: true }])
  const bz = uBz.windows[0]
  ok(bz && bz.balance === 817.04, `百智充值积分应给 balance=817.04（实际 ${JSON.stringify(bz?.balance)}）`)
  ok(bz && bz.limit === undefined && bz.used === undefined,
    `钱包不得给 limit/used（否则 magpie 画出 817.04/817.04 剩余 100%），实际 limit=${JSON.stringify(bz?.limit)} used=${JSON.stringify(bz?.used)}`)

  // Cline 账户余额 / ModelScope 魔粒 / Raccoon 奖励积分：无周期、used=0、total==remaining
  const uCl = one([{ name: 'Cline 账户余额', unit: 'USD', remaining: 5, total: 5, used: 0, active: true }])
  ok(uCl.windows[0]?.balance === 5, `Cline 账户余额（无周期、恰好没用过）应判钱包（实际 ${JSON.stringify(uCl.windows[0]?.balance)}）`)

  // 反例：codearts 赠送积分包 —— cycleEndTime 为空但 used=4.48，是真配额，必须仍画进度条
  const uCa = one([{ name: '赠送积分包', unit: 'credit', remaining: 17095.52, total: 17100, used: 4.48, active: true }])
  const ca = uCa.windows[0]
  ok(ca && ca.limit === 17100 && ca.amount === 17095.52,
    `codearts 赠送积分包（无周期但有消耗）必须仍是配额，实际 limit=${JSON.stringify(ca?.limit)} amount=${JSON.stringify(ca?.amount)}`)
  ok(ca && ca.used === 0, `17100 里只用了 4.48 ⇒ 已用 0%（四舍五入），实际 ${JSON.stringify(ca?.used)}`)

  // 反例：有周期的配额（WorkBuddy Free Plan）即便 total==remaining、used=0 也必须画进度条
  const uWb = one([{ name: 'Free Plan', unit: 'credits', remaining: 100, total: 100, used: 0, active: true,
    cycleStartTime: '2026-11-01 00:00:00', cycleEndTime: '2026-11-30 23:59:59' }])
  ok(uWb.windows[0]?.limit === 100 && uWb.windows[0]?.balance === undefined,
    `有周期的 Free Plan（未使用）必须仍是配额，实际 limit=${JSON.stringify(uWb.windows[0]?.limit)}`)

  // 每日积分桶：分母 = **当天首见额度**（用户 2026-11-09 定的口径）。
  // 百智云每日发放额不固定：实测梨花 100、其余 4 个账号 200（上游
  // `temporary_credit_cents: 19996`）。而 baizhi-credits 里
  // `dailyTotal = max(100, temporary)` ⇒ 200 的账号分母==余额 ⇒ 永远 100%。
  // 首次读到 199.96 时就以它为分母；后续消耗才算得出百分比。
  // ⚠️ totalKnown:false 是关键：百智云发放额超过写死的 100 时，vendor 的
  // `buildBaizhiBalance` 会标 totalKnown:false（dailyExcess 分支）—— 只有这种
  // 「上游没给可信总额」的情况才走自采基线。给了真总额的每日桶（MonkeyCode
  // 的 10000000）必须直接用上游值，见本文件后面的回归断言。
  const uD1 = one([{ name: '每日积分', unit: 'credit', remaining: 199.96, total: 199.96, used: 0, totalKnown: false, active: true }])
  ok(uD1.windows[0]?.limit === 199.96 && uD1.windows[0]?.amount === 199.96,
    `每日积分首见 199.96 ⇒ 分母取 199.96（不能用写死的 100），实际 limit=${JSON.stringify(uD1.windows[0]?.limit)}`)

  // 同一账号第二次读数：余额降到 150、上游 total 仍给 199.96 ⇒ 分母**必须还是 199.96**
  // 且已用 = (199.96-150)/199.96 ≈ 25%，不能变成「150/150 剩余 100%」。
  const uD2 = fn3.toMagpieUsage({
    provider: 'x', accountId: 'a', nickname: 'n',
    balance: { total: 0, packages: [{ name: '每日积分', unit: 'credit', remaining: 150, total: 150, used: 0, totalKnown: false, active: true }] },
  }, 'x')
  ok(uD2.windows[0]?.limit === 199.96,
    `同账号第二次读数分母应保持首见值 199.96，实际 ${JSON.stringify(uD2.windows[0]?.limit)}`)
  ok(uD2.windows[0]?.used === 25,
    `已用应为 25%（(199.96-150)/199.96），实际 ${JSON.stringify(uD2.windows[0]?.used)}%`)

  // 当天中途补发（余额超过首见值）⇒ 基线抬高，避免「已用为负」
  const uD3 = fn3.toMagpieUsage({
    provider: 'x', accountId: 'a', nickname: 'n',
    balance: { total: 0, packages: [{ name: '每日积分', unit: 'credit', remaining: 260, total: 260, used: 0, totalKnown: false, active: true }] },
  }, 'x')
  ok(uD3.windows[0]?.limit === 260 && uD3.windows[0]?.used === 0,
    `余额涨到 260 ⇒ 基线抬到 260 且已用 0，实际 limit=${JSON.stringify(uD3.windows[0]?.limit)} used=${JSON.stringify(uD3.windows[0]?.used)}`)

  // 不同账号各有各的发放额：另一个账号首见 99.48 ⇒ 分母 99.48（不串号）
  const uD4 = fn3.toMagpieUsage({
    provider: 'x', accountId: 'other', nickname: 'n',
    balance: { total: 0, packages: [{ name: '每日积分', unit: 'credit', remaining: 99.48, total: 100, used: 0.52, totalKnown: false, active: true }] },
  }, 'x')
  ok(uD4.windows[0]?.limit === 99.48,
    `另一个账号首见 99.48 ⇒ 分母 99.48（基线按账号隔离），实际 ${JSON.stringify(uD4.windows[0]?.limit)}`)
}

// 回归：有真实总额的每日桶**不能**被自采基线覆盖；负余额要保留且不画进度条。
//
// 用户 2026-11-09 报「这都变成负数了，还不如之前的」—— 两处都是我先引入的：
//  ① 第一版对**所有**每日桶采基线 ⇒ MonkeyCode「每日额度」（真总额 10000000、
//     已用 439414）被写成基线 9560586（当时残值）⇒ `9560586 / 9560586 · 剩余 0%`，
//     比修复前的 `9560586 / 10000000 · 剩余 4%` 更糟。
//  ② 过滤 `total>0 || remaining>0` 把 MonkeyCode 欠费账号的
//     `积分余额 total=-10.402` **整条丢掉** ⇒ 卡片上毫无欠费痕迹。
{
  console.log('')
  const fs4 = await import('node:fs')
  const src4 = fs4.readFileSync(new URL('../src/plugin.mjs', import.meta.url), 'utf8').replace(/\r\n/g, String.fromCharCode(10))
  const f4 = src4.indexOf('function writeCache(')
  const fn4 = new Function(
    'NAMES', 'humanizeUsageError', 'isDailyPool', 'dailyTotalOf',
    src4.slice(src4.indexOf('function groupName('), f4) + String.fromCharCode(10) + 'return { toMagpieUsage }',
  )(
    { monkeycode: 'MonkeyCode' },
    (x) => String(x),
    (name) => ['每日积分', '每日赠送', '每日额度', '每日签到奖励'].includes(String(name ?? '').trim()),
    (() => {
      const base = new Map()
      return (key, remaining) => {
        if (!base.has(key) || remaining > base.get(key)) base.set(key, remaining)
        return base.get(key)
      }
    })(),
  )

  // ① MonkeyCode 正常账号：每日额度有真总额 ⇒ 必须直接用 10000000
  const mc = fn4.toMagpieUsage({
    provider: 'monkeycode', accountId: 'mc1', nickname: 'n',
    balance: { total: 146.341, packages: [
      { name: '积分余额', unit: 'credit', remaining: 146.341, total: 146.341, used: 0, totalKnown: false, active: true },
      { name: '每日额度', unit: 'token', remaining: 9560586, total: 10000000, used: 439414, active: true },
    ] },
  }, 'monkeycode')
  const day = mc.windows.find((w) => String(w.name).startsWith('每日额度'))
  ok(day && day.limit === 10000000,
    `有真总额的每日额度必须用上游 10000000 当分母（不能被首见残值 9560586 覆盖），实际 ${JSON.stringify(day?.limit)}`)
  ok(day && day.amount === 9560586 && day.used === 4,
    `应显示 9560586 / 10000000 · 已用 4%，实际 amount=${JSON.stringify(day?.amount)} used=${JSON.stringify(day?.used)}`)

  // ② MonkeyCode 欠费账号：负数包必须保留，且用 text 窗口（不画进度条）
  const od = fn4.toMagpieUsage({
    provider: 'monkeycode', accountId: 'mc2', nickname: 'n',
    balance: { total: -10.402, packages: [
      { name: '积分余额', unit: 'credit', remaining: -10.402, total: -10.402, used: 0, totalKnown: false, active: true },
      { name: '每日额度', unit: 'token', remaining: 0, total: 10000000, used: 10000000, active: true },
    ] },
  }, 'monkeycode')
  const owed = od.windows.find((w) => String(w.name).startsWith('积分余额'))
  ok(owed !== undefined, '欠费账号的负数「积分余额」不能被过滤掉（否则卡片毫无欠费痕迹）')
  ok(owed && typeof owed.text === 'string' && owed.text.includes('欠费'),
    `负数包应给 text「已欠费 …」，实际 ${JSON.stringify(owed?.text)}`)
  ok(owed && owed.limit === undefined && owed.used === undefined && owed.balance === undefined,
    `负数包不得带 limit/used/balance（负值会让百分比失控），实际 limit=${JSON.stringify(owed?.limit)} used=${JSON.stringify(owed?.used)} balance=${JSON.stringify(owed?.balance)}`)
  // 汇总 balance 行不铺负数（否则整家渠道看起来像坏了）
  ok(od.balance === undefined,
    `合计为负时不写 balance 行（交给各包自己报），实际 ${JSON.stringify(od.balance)}`)

  // ③ 恰为 0/0 的空包仍必须被丢掉（astudio 的「会员积分」实测形状）
  const empty = fn4.toMagpieUsage({
    provider: 'astudio', accountId: 'a', nickname: 'n',
    balance: { total: 7200, packages: [
      { name: '会员积分', unit: 'credit', remaining: 0, total: 0, used: 0, active: true },
      { name: '赠送积分', unit: 'credit', remaining: 7200, total: 7200, used: 0, active: true,
        cycleStartTime: '2026-11-01 00:00:00', cycleEndTime: '2026-11-30 23:59:59' },
    ] },
  }, 'astudio')
  ok(empty.windows.length === 1 && !empty.windows.some((w) => String(w.name).includes('会员积分')),
    `0/0 空包仍必须丢弃（否则画出「0/0、可用 100%」），实际 ${JSON.stringify(empty.windows.map((w) => w.name))}`)
}

// MonkeyCode「近 30 天收入之和为总窗口」（用户 2026-11-09 口径）。
//
// 上游没有积分包概念：`/wallet/credits` 等包接口全 404，流水
// `inout_type/kind/amount/amount_balance/amount_daily/remark/created_at`
// 不含任何到期时间；`/wallet` 只给标量 balance（单位千分之一积分，可为负）。
// 账目实测吻合：4 个负余额账号的 balance 与「30 天收入 − 30 天支出」逐位相等。
//
// 这里测**纯函数部分**（不联网）：把 withRollingIncomeWindow 的改写逻辑抽出来
// 求值，覆盖「负余额按 0」「分母=30天收入」「拿不到收入不改写」三条。
{
  console.log('')
  const fs5 = await import('node:fs')
  const src5 = fs5.readFileSync(new URL('../src/plugin.mjs', import.meta.url), 'utf8').replace(/\r\n/g, String.fromCharCode(10))

  // 从源码里截 withRollingIncomeWindow（它依赖 fmtNum，一并带上）
  const iFn = src5.indexOf('async function withRollingIncomeWindow(')
  ok(iFn > 0, '从 src/plugin.mjs 截到 withRollingIncomeWindow')
  if (iFn > 0) {
    const endFn = src5.indexOf('\n}\n', iFn)
    const body = src5.slice(iFn, endFn + 3)
    const iFmt = src5.indexOf('function fmtNum(')
    const endFmt = src5.indexOf('\n}\n', iFmt)
    const fmtBody = src5.slice(iFmt, endFmt + 3)
    // 桩：credentialOfAccount 返回假凭据，monkeycodeIncome30d 返回指定收入
    const make = (income) => new Function('fmtNum', 'MONKEYCODE_WINDOW_TTL_MS', 'monkeycodeWindowCache',
      'credentialOfAccount', 'monkeycodeIncome30d',
      fmtBody + String.fromCharCode(10) + body + String.fromCharCode(10) + 'return { withRollingIncomeWindow }',
    )(
      (n) => (Number.isInteger(n) ? String(n) : Number(n).toFixed(2)),
      60_000,
      new Map(),
      async () => ({ session_cookie: 'x' }),
      async () => income,
    ).withRollingIncomeWindow

    const mkBase = (unit, balance, text) => ({
      plan: 'MonkeyCode',
      windows: [
        { name: '积分余额', unit, ...(balance === undefined ? {} : { balance }), ...(text === undefined ? {} : { text }) },
        { name: '每日额度', unit: 'token', used: 0, display: '9560586 / 10000000 token', amount: 9560586, limit: 10000000 },
      ],
    })

    // ① 负余额 ⇒ 剩余按 0，分母 700
    const r1 = await make(700_000)(mkBase('credit', -16.616), 'monkeycode', {}, 'acc1', () => {})
    const w1 = r1.windows.find((w) => w.name === '积分余额')
    ok(w1 && w1.amount === 0, `负余额应显示 0（不是 -16.616），实际 ${JSON.stringify(w1?.amount)}`)
    ok(w1 && w1.limit === 700, `分母应为 30 天收入 700，实际 ${JSON.stringify(w1?.limit)}`)
    ok(w1 && w1.used === 100, `负余额 ⇒ 已用 100%，实际 ${JSON.stringify(w1?.used)}`)
    ok(w1 && w1.display === '0.00 / 700.00 credit', `展示串应含 0 / 700，实际 ${JSON.stringify(w1?.display)}`)

    // ② 正余额 ⇒ 正常算百分比
    const r2 = await make(700_000)(mkBase('credit', 146.341), 'monkeycode', {}, 'acc2', () => {})
    const w2 = r2.windows.find((w) => w.name === '积分余额')
    ok(w2 && w2.amount === 146.341 && w2.limit === 700, `正余额应给 146.341/700，实际 ${JSON.stringify(w2?.amount)}/${JSON.stringify(w2?.limit)}`)
    ok(w2 && w2.used === 79, `146.341/700 ⇒ 已用 79%，实际 ${JSON.stringify(w2?.used)}%`)

    // ③ 每日额度（token）不能被改写 —— 它有上游真总额
    const dayW = r2.windows.find((w) => w.name === '每日额度')
    ok(dayW && dayW.limit === 10000000, `每日额度必须保持上游总额 10000000，实际 ${JSON.stringify(dayW?.limit)}`)

    // ④ 拿不到收入 ⇒ 原样返回（退回钱包语义，不编分母）
    const base4 = mkBase('credit', -16.616)
    const r4 = await make(undefined)(base4, 'monkeycode', {}, 'acc4', () => {})
    ok(r4 === base4, '拿不到 30 天收入时必须原样返回 base（不编造分母）')

    // ⑤ 收入为 0 ⇒ 同样不改写（除以 0 会出 Infinity）
    const r5 = await make(0)(base4, 'monkeycode', {}, 'acc5', () => {})
    ok(r5 === base4, '收入为 0 时也不改写（避免除零）')

    // ⑥ text 形态（负数走 text 窗口时的兜底解析）
    const r6 = await make(700_000)(mkBase('credit', undefined, '已欠费 16.6 credit'), 'monkeycode', {}, 'acc6', () => {})
    const w6 = r6.windows.find((w) => w.name === '积分余额')
    ok(w6 && w6.amount === 0, `text 形态的负数也应解析成 0，实际 ${JSON.stringify(w6?.amount)}`)
  }
}

if (problems.length) {
  console.log('✗ ' + problems.length + ' 处不符：')
  for (const p of problems) console.log('  ' + p)
  process.exit(1)
}
console.log('✓ usage 契约与真实读数均正确')
process.exit(0)
