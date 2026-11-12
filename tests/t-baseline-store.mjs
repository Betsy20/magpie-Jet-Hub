// 基线/水位持久化契约测试：跨进程重启、跨天边界、老文件兼容。
//
// 为什么单独一个文件：`t-usage.mjs` 把 `dailyTotalOf` / `walletPeakOf` 当桩注入，
// 只能验证**调用方的窗口形状**；而这里最容易出事的两行代码 ——
//
//   saveDailyBaseline() 里 `if (v.kind === 'peak' || v.day === today)`
//   loadDailyBaseline() 里 `const kind = v.kind === 'peak' ? 'peak' : 'daily'`
//
// —— 恰好都在桩里被替换掉了。少了第一句，水位隔天被清空 ⇒ 分母退回余额 ⇒
// 「永远 100%」无声复发；少了第二句，升级时把线上已有的 4 条百智云每日基线
// 判成「无 kind ⇒ 丢弃」，当天立刻同样复发。两者都不报错，只显示错数字。
//
// 所以这里**真读写磁盘**（用临时文件，不碰 `~/.config`），并直接截真实源码求值。

const problems = []
const ok = (cond, msg) => { if (!cond) problems.push(msg) }

const fs = await import('node:fs')
const os = await import('node:os')
const path = await import('node:path')
const { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } = fs

const src = readFileSync(new URL('../src/plugin.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// 截 [DAILY_POOL_NAMES … 账号 RPC 段] 之间：正好是基线的全部实现。
const from = src.indexOf('const DAILY_POOL_NAMES')
const to = src.indexOf('/* ── 按账号：列出 / 解析')
ok(from > 0 && to > from, '从 src/plugin.mjs 截不到基线模块（DAILY_POOL_NAMES … 按账号段）')
if (!(from > 0 && to > from)) {
  console.log('✗ 截取失败，无法继续')
  process.exit(1)
}
const body = src.slice(from, to)

/**
 * 造一个**独立的**基线环境：每次调用都是全新的 Map / 负载标志 / 临时文件，
 * 模拟一次进程重启。返回的对象里 `env` 就是那个文件路径。
 */
const mkEnv = (file) => new Function(
  'readFileSync', 'writeFileSync', 'mkdirSync', 'dirname', 'join', 'homedir', 'process',
  `${body}
   return { localDay, loadDailyBaseline, saveDailyBaseline, dailyTotalOf, isDailyPool,
            isWalletWindowPool, walletPeakOf, dailyBaseline, WALLET_WINDOW_POOLS }`,
)(
  readFileSync, writeFileSync, mkdirSync, path.dirname, path.join, () => '/nonexistent-home',
  { env: { JET_HUB_DAILY_BASELINE: file } },
)

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'jet-hub-baseline-'))
const file1 = path.join(tmpdir, 'nested', 'baseline.json') // 目录还不存在，验证 mkdir 递归

try {
  // ① 首次写：目录不存在也要能建出来，条目形状带 kind/day/total
  {
    const e = mkEnv(file1)
    const total = e.walletPeakOf('baizhi\u0000acc1\u0000充值积分', 500)
    ok(total === 500, `首次水位应为余额 500，实际 ${total}`)
    ok(fs.existsSync(file1), '基线文件应被创建（含不存在的父目录，需 mkdir -p）')
    const disk = JSON.parse(readFileSync(file1, 'utf8'))
    const rec = disk['baizhi\u0000acc1\u0000充值积分']
    ok(rec !== undefined, '水位条目应落盘')
    ok(rec?.kind === 'peak', `水位条目必须带 kind:'peak'（否则隔天会被当每日基线清掉），实际 ${JSON.stringify(rec?.kind)}`)
    ok(rec?.total === 500, `落盘 total 应为 500，实际 ${JSON.stringify(rec?.total)}`)
  }

  // ② 模拟「重启 + 隔天」：把 day 改成一个过去的日期，再读 —— 水位必须在
  //    每日基线被清掉的同时**活下来**。这是「永远 100%」复发的唯一入口。
  //
  // ⚠️ 必须**触发一次落盘**才有判别力：只读不写时钱包水位根本不经过
  //    `saveDailyBaseline` 的保留条件（实测：不写盘时把保留条件改坏，断言照样
  //    绿 —— 假绿）。真实链路上每次刷新都会顺带刷每日桶，落盘必然发生。
  {
    const disk = JSON.parse(readFileSync(file1, 'utf8'))
    for (const k of Object.keys(disk)) disk[k].day = '2000-01-01'
    writeFileSync(file1, JSON.stringify(disk, null, 2))
    const e = mkEnv(file1)
    // 先刷一次每日桶（跨天 ⇒ 重置 + saveDailyBaseline），正常生产就是这个顺序
    const dayTotal = e.dailyTotalOf('baizhi\u0000acc1\u0000每日积分', 150)
    ok(dayTotal === 150, `隔天首刷每日桶应为今天的新分母 150，实际 ${dayTotal}`)
    const total = e.walletPeakOf('baizhi\u0000acc1\u0000充值积分', 420)
    ok(total === 500, `跨天后水位必须仍是 500（分母不跟着余额掉），实际 ${total}（退回 420 说明水位被当每日基线清掉了）`)
    const after = JSON.parse(readFileSync(file1, 'utf8'))
    ok(after['baizhi\u0000acc1\u0000充值积分']?.total === 500,
      `落盘的水位跨天仍是 500，实际 ${JSON.stringify(after['baizhi\u0000acc1\u0000充值积分']?.total)}`)
    ok(after['baizhi\u0000acc1\u0000充值积分']?.kind === 'peak',
      '落盘的水位条目 kind 必须仍是 peak（否则下一次落盘就丢）')
  }

  // ③ 每日基线必须**按天失效**：昨天的残值不能当今天的分母（否则今天一开局
  //    就显示「已用 60%」这种荒谬读数）。
  {
    const e = mkEnv(file1)
    e.dailyBaseline.set('baizhi\u0000acc2\u0000每日积分', { kind: 'daily', day: '2000-01-01', total: 199.96 })
    e.saveDailyBaseline()
    const disk = JSON.parse(readFileSync(file1, 'utf8'))
    ok(disk['baizhi\u0000acc2\u0000每日积分'] === undefined,
      '昨天的每日基线必须被清掉（每日额度零点重置），实际仍在盘上')
    const total = e.dailyTotalOf('baizhi\u0000acc2\u0000每日积分', 150)
    ok(total === 150, `跨天首次读到 150 ⇒ 今天的分母应是 150，实际 ${total}`)
  }

  // ④ 同一天的每日基线保留；余额上涨时抬基线（补发/叠加活动）
  {
    const e = mkEnv(file1)
    const k = 'baizhi\u0000acc3\u0000每日积分'
    ok(e.dailyTotalOf(k, 199.96) === 199.96, '首见 199.96 ⇒ 分母 199.96')
    ok(e.dailyTotalOf(k, 180) === 199.96, '消耗到 180 ⇒ 分母保持 199.96')
    ok(e.dailyTotalOf(k, 260) === 260, '补发到 260 ⇒ 分母抬到 260（否则出现负已用）')
    const disk = JSON.parse(readFileSync(file1, 'utf8'))
    ok(disk[k]?.total === 260 && disk[k]?.kind === 'daily',
      `每日条目落盘 shape 应为 {kind:'daily', total:260}，实际 ${JSON.stringify(disk[k])}`)
  }

  // ⑤ 老文件兼容：线上真实文件是 `{day:"2026-11-09", total:199.96}`（无 kind）。
  //    必须按每日基线读进来，不能因为缺 kind 整条丢掉 —— 丢了当天的基线，
  //    4 个百智云账号的「每日积分」立刻退回「分母==余额 · 永远 100%」。
  {
    const file2 = path.join(tmpdir, 'legacy.json')
    const today = mkEnv(file2).localDay()
    writeFileSync(file2, JSON.stringify({
      'baizhi\u0000accL\u0000每日积分': { day: today, total: 199.96 },
    }, null, 2))
    const e = mkEnv(file2)
    const total = e.dailyTotalOf('baizhi\u0000accL\u0000每日积分', 180)
    ok(total === 199.96,
      `老条目（无 kind、日期是今天）应被按每日基线认回 199.96，实际 ${total}（读到 undefined 说明整条被丢）`)
  }

  // ⑥ 白名单：只有列出来的渠道+池子才走水位，其它一律拒绝
  {
    const e = mkEnv(file1)
    ok(e.isWalletWindowPool('baizhi', '充值积分') === true, 'baizhi「充值积分」应在白名单')
    ok(e.isWalletWindowPool('baizhi', '每日积分') === false, '每日积分不该走水位（它按天重置）')
    ok(e.isWalletWindowPool('monkeycode', '积分余额') === false, 'MonkeyCode 走 30 天收入窗口，不该被水位接管')
    ok(e.isWalletWindowPool('cline', 'Cline 账户余额') === false, '其它渠道的钱包语义保持不变')
  }

  // ⑦ 水位遇到底数更大的老条目时取大值（防进度条溢出：limit < amount）
  {
    const file3 = path.join(tmpdir, 'clash.json')
    writeFileSync(file3, JSON.stringify({
      'baizhi\u0000acc5\u0000充值积分': { kind: 'daily', day: mkEnv(file3).localDay(), total: 900 },
    }, null, 2))
    const e = mkEnv(file3)
    const total = e.walletPeakOf('baizhi\u0000acc5\u0000充值积分', 500)
    ok(total === 900, `同 key 已有更大的底数时必须取 900（否则分母 500 < 余额 500 之外会倒挂），实际 ${total}`)
  }
} finally {
  rmSync(tmpdir, { recursive: true, force: true })
  ok(!fs.existsSync(tmpdir), '临时目录应被清理（测试不留垃圾）')
  ok(!readdirSync(os.tmpdir()).some((n) => n.startsWith('jet-hub-baseline-') && statSync(path.join(os.tmpdir(), n)).mtimeMs > Date.now()),
    '不应在系统临时目录留下基线文件')
}

if (problems.length) {
  console.log('✗ ' + problems.length + ' 处不符：')
  for (const p of problems) console.log('  ' + p)
  process.exit(1)
}
console.log('✓ 基线/水位持久化契约正确')
process.exit(0)