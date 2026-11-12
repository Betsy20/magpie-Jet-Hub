/**
 * 控制台「百智云积分拆成每日 / 长期」的契约测试。
 *
 * 背景：百智云官方钱包是两行读数（每日积分 99.64｜零点过期 + 充值积分 817.04｜
 * 长期有效），而我们控制台的账号卡只显示合计 —— 用户截图报障（2026-11-09）。
 * 拆分数据其实**一直在回包里**（`vendor/lib/baizhi-credits.js buildBaizhiBalance`
 * 产出「每日积分」「充值积分」两个资源包，`credits.balances` 原样透传 `packages`），
 * 缺口纯在 console 显示层。
 *
 * 这个文件盯三件事：
 *
 *   1. **口径真值源**：每日桶的名字集合必须和上游客户端逐字一致
 *      （`vendor/lib/client/jet-hub.js` 的 `DAILY_POOL_NAMES = ['每日赠送','每日积分']`）。
 *      两侧一分叉，控制台就会「不显示」或「显示错桶」。
 *   2. **边界语义穿透**：vendor 已审计过的四种口径（未领取 / 超额 / 标记缺失 /
 *      冻结）必须原样消费，不许在显示层编造分母或把冻结额算进「长期」。
 *   3. **不回归**：通用三档（`其余 / 临期 / 已失效`）与 stale 标记逐字不变。
 *
 * 做法照 `tests/t-console-credits.mjs`：**从真源码抽函数求值**（不复制粘贴实现），
 * 真实 builder 喂真实形状。跑法：`node tests/t-console-baizhi-split.mjs`
 * （不联网、不碰真实 ~/.dsh）
 *
 * ⚠️ dev1 可能尚未落地 `console/console.js` 改动（两人并行）。那时本文件会红在
 * 「找不到 formatBaizhiPoolSplit / BAIZHI_DAILY_POOL_NAMES」—— 属预期，**不要**
 * 改 console 去迁就测试。测试按计划书 §2 契约写，契约才是判据。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// 真 builder：直接用 vendor 的实现产 packages，不在测试里手写形状
// （手写一份 mock 会和实现一起错，2026-11-05 二审的教训）。
import { buildBaizhiBalance } from '../vendor/lib/baizhi-credits.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SRC = path.join(ROOT, 'console', 'console.js')
const CLIENT = path.join(ROOT, 'vendor', 'lib', 'client', 'jet-hub.js')

let bad = 0
// 断言条数自己数，不写死 —— 写死会随每次加断言漂
let total = 0
const ok = (cond, msg) => {
  total++
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) bad++
}

// 行尾归一化成 \n，否则 indexOf 的定位串一个都对不上
const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n')
const clientSrc = fs.readFileSync(CLIENT, 'utf8').replace(/\r\n/g, '\n')

/** 剥注释（源码守卫必须先剥：修复说明里会原样引用旧写法）。 */
function stripComments(code) {
  let out = ''
  let i = 0
  let quote = null
  while (i < code.length) {
    const c = code[i]
    const n = code[i + 1]
    if (quote !== null) {
      if (c === '\\') {
        out += c + (n ?? '')
        i += 2
        continue
      }
      if (c === quote) quote = null
      out += c
      i += 1
      continue
    }
    if (c === '/' && n === '/') {
      while (i < code.length && code[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && n === '*') {
      i += 2
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    out += c
    i += 1
  }
  return out
}

function sliceFn(prefix) {
  const start = src.indexOf(prefix)
  if (start < 0) throw new Error(`截不到源码片段：找不到 ${JSON.stringify(prefix)}`)
  const end = src.indexOf('\n}\n', start)
  if (end < 0) throw new Error(`截不到源码片段的结尾：${JSON.stringify(prefix)}`)
  return src.slice(start, end + 3)
}

/** 找不到不抛，返回 null —— 让后面每节自己记 ✗ 并把「dev1 未落地」写进结论。 */
function trySliceFn(prefix) {
  try {
    return sliceFn(prefix)
  } catch {
    return null
  }
}

/** 按「整行声明」截常量（保留 `const|let|var` 原文，注入 harness 时一个字符不改）。 */
function findDecl(name) {
  const re = new RegExp(`^(?:const|let|var)\\s+${name}\\s*=\\s*(\\[[^\\]]*\\])`, 'm')
  const m = src.match(re)
  if (m === null) return null
  // 数组字面量用 Function 求值（源码是单引号，JSON.parse 只吃双引号会直接抛）。
  const literal = new Function(`return ${m[1]}`)()
  return { decl: m[0], literal }
}

/* ── 1. 口径真值源：每日桶名字集合必须逐字一致 ───────────────────── */

console.log('--- 1) 每日桶名字集合：与上游客户端对账 ---')
const VENDOR_POOL_RE = /var DAILY_POOL_NAMES = (\[[^\]]*\]);/
const vendorMatch = clientSrc.match(VENDOR_POOL_RE)
let vendorPoolNames = null
ok(vendorMatch !== null, '在 vendor/lib/client/jet-hub.js 找到 `var DAILY_POOL_NAMES = [...]`')
if (vendorMatch !== null) {
  vendorPoolNames = JSON.parse(vendorMatch[1])
  ok(
    Array.isArray(vendorPoolNames) && vendorPoolNames.length === 2,
    `上游每日桶名字恰好两个（实际 ${Array.isArray(vendorPoolNames) ? vendorPoolNames.length : '非数组'}）`,
  )
}
ok(
  /DAILY_POOL_NAMES\.includes\(pkg\.name\)/.test(clientSrc),
  '上游判据是 `DAILY_POOL_NAMES.includes(pkg.name)`（精确相等，不是前缀/子串）',
)

const consoleDecl = findDecl('BAIZHI_DAILY_POOL_NAMES')
ok(
  consoleDecl !== null,
  'console/console.js 有 `BAIZHI_DAILY_POOL_NAMES = [...]` 常量（dev1 未落地时为 ✗）',
)
if (consoleDecl !== null && vendorPoolNames !== null) {
  ok(
    JSON.stringify(consoleDecl.literal) === JSON.stringify(vendorPoolNames),
    `两侧字面量逐字相等：console ${JSON.stringify(consoleDecl.literal)} vs vendor ${JSON.stringify(vendorPoolNames)}`,
  )
  ok(
    consoleDecl.literal.includes('每日积分') && consoleDecl.literal.includes('每日赠送'),
    '两侧都含「每日积分」与「每日赠送」两个名字',
  )
}

const splitFnSrc = trySliceFn('function formatBaizhiPoolSplit(')
ok(
  splitFnSrc !== null,
  'console/console.js 有顶层纯函数 `function formatBaizhiPoolSplit(packages)`（dev1 未落地时为 ✗）',
)

// 求值用的纯函数（常量声明 + 函数声明原样注入，只补 return）
let evalSplit = null
if (consoleDecl !== null && splitFnSrc !== null) {
  const factory = new Function(
    `
    ${consoleDecl.decl}
    ${splitFnSrc}
    return formatBaizhiPoolSplit
    `,
  )
  evalSplit = factory()
  ok(typeof evalSplit === 'function', '抽出的源码能求值成函数（不是空壳）')
}

if (splitFnSrc !== null) {
  const body = stripComments(splitFnSrc)
  ok(
    /BAIZHI_DAILY_POOL_NAMES\.includes\(/.test(body),
    'console 侧也用 `BAIZHI_DAILY_POOL_NAMES.includes(...)` 精确匹配',
  )
  // 子串匹配（`name.includes('每日')`）会把「每日赠送」和别的名字混不混无所谓，
  // 但会把任何含「每日」的自定义包误当每日桶 —— 与上游口径分叉，必须挡。
  ok(
    !/\.name\.(?:includes|startsWith|endsWith)\(\s*['"`]每日/.test(body),
    '没有退化成「含『每日』子串」的宽松匹配',
  )
}

/* ── 2. 真 builder 喂真形状（用户截图同形钱包）───────────────────── */

console.log('--- 2) 真 builder：{916.68, 99.64, 817.04} ⇒ {daily:99.64, rest:817.04} ---')
const SCREENSHOT_WALLET = {
  available: 916.68,
  temporary: 99.64,
  permanent: 817.04,
  frozen: 0,
  dailyClaimed: true,
}
{
  const bal = buildBaizhiBalance(SCREENSHOT_WALLET)
  ok(bal.total === 916.68, `builder 合计 = available（实际 ${bal.total}）`)
  ok(
    bal.packages.some((p) => p.name === '每日积分') &&
      bal.packages.some((p) => p.name === '充值积分'),
    'builder 产出「每日积分」+「充值积分」两个包',
  )
  const dailyPkg = bal.packages.find((p) => p.name === '每日积分')
  ok(
    dailyPkg !== undefined && dailyPkg.expiryNote === '每日 00:00（UTC+8）过期',
    '每日包 expiryNote 是「每日 00:00（UTC+8）过期」（note 真值源）',
  )

  if (evalSplit === null) {
    ok(false, '跳过行为断言：formatBaizhiPoolSplit 抽不到（dev1 未落地）')
  } else {
    const split = evalSplit(bal.packages)
    ok(split !== null && typeof split === 'object', '截图同形钱包 ⇒ 返回对象（不是 null）')
    if (split !== null && typeof split === 'object') {
      ok(split.daily === 99.64, `split.daily = 每日包 remaining 99.64（实际 ${split.daily}）`)
      ok(split.rest === 817.04, `split.rest = 其余 active 包之和 817.04（实际 ${split.rest}）`)
      ok(
        split.note === dailyPkg.expiryNote,
        `split.note 逐字取每日包 expiryNote（实际 ${JSON.stringify(split.note)}）`,
      )
    }
  }
}

/* ── 3. 边界：vendor 已审计的四条语义必须穿透 ──────────────────── */

console.log('--- 3) 边界（builder 已审计语义）---')
const boundary = (label, wallet, check) => {
  if (evalSplit === null) {
    ok(false, `${label}：跳过（formatBaizhiPoolSplit 抽不到）`)
    return
  }
  const bal = buildBaizhiBalance(wallet)
  const split = evalSplit(bal.packages)
  check(split, bal.packages)
}

{
  // 今天还没领：temporary=0 + dailyClaimed=false ⇒ daily=0，note 诚实说没领
  boundary(
    '未领取',
    { available: 817.04, temporary: 0, permanent: 817.04, frozen: 0, dailyClaimed: false },
    (split) => {
      ok(split !== null, '未领取 ⇒ 仍返回拆分（每日 0 + 长期 817.04）')
      ok(split !== null && split.daily === 0, `未领取 daily = 0（实际 ${split?.daily}）`)
      ok(
        split !== null && /今日尚未领取/.test(String(split.note)),
        `未领取 note 含「今日尚未领取」（实际 ${JSON.stringify(split?.note)}）`,
      )
      // 不显示假分母：note 里不出现「0 / 100」这类倒挂写法由 note 文案承担
      ok(split !== null && split.rest === 817.04, `未领取 rest 仍是 817.04（实际 ${split?.rest}）`)
    },
  )

  // 超额：temporary=150 > 100 ⇒ 总额不可知，不显示假分母
  boundary(
    '超额',
    { available: 967.04, temporary: 150, permanent: 817.04, frozen: 0, dailyClaimed: true },
    (split) => {
      ok(split !== null && split.daily === 150, `超额 daily = 150（实际 ${split?.daily}）`)
      ok(
        split !== null && /总额不可知/.test(String(split.note)),
        `超额 note 含「总额不可知」（实际 ${JSON.stringify(split?.note)}）`,
      )
    },
  )

  // 领取标记缺失：dailyClaimed undefined + temporary=0 ⇒ 不能猜，note 说未知
  boundary(
    '标记缺失',
    { available: 817.04, temporary: 0, permanent: 817.04, frozen: 0 },
    (split) => {
      ok(
        split !== null && /未知/.test(String(split.note)),
        `标记缺失 note 含「未知」（实际 ${JSON.stringify(split?.note)}）`,
      )
      ok(split !== null && split.daily === 0, `标记缺失 daily = 0（实际 ${split?.daily}）`)
    },
  )

  // 冻结：builder 把冻结额放进 active=false 的包 ⇒ 不得计入 rest
  const frozenWallet = {
    available: 916.68,
    temporary: 99.64,
    permanent: 817.04,
    frozen: 50,
    dailyClaimed: true,
  }
  boundary('冻结', frozenWallet, (split, packages) => {
    const frozenPkg = packages.find((p) => p.name === '冻结积分')
    ok(frozenPkg !== undefined && frozenPkg.active === false, '冻结包 active=false（builder 口径）')
    ok(
      split !== null && split.rest === 817.04,
      `frozen>0 不进 rest：rest 仍是 817.04（实际 ${split?.rest}）`,
    )
  })

  // 授信账户：没有「每日积分」桶 ⇒ null（回退旧渲染，绝不编造）
  boundary(
    'postpaid',
    { available: 500, temporary: 0, permanent: 0, frozen: 0, dailyClaimed: true, billingMode: 'postpaid', creditLimit: 1000 },
    (split, packages) => {
      ok(
        packages.some((p) => p.name === '授信额度'),
        '授信账户 builder 只给「授信额度」包',
      )
      ok(split === null, 'postpaid ⇒ null（回退旧渲染）')
    },
  )

  // packages 缺失 / 非数组 / 空数组 ⇒ null
  for (const [label, input] of [
    ['undefined', undefined],
    ['null', null],
    ['字符串', '每日积分'],
    ['对象非数组', { name: '每日积分', remaining: 1 }],
    ['空数组', []],
  ]) {
    ok(evalSplit === null ? false : evalSplit(input) === null, `packages 是${label} ⇒ null`)
  }

  // rest 只收 active===true 且 remaining 为正有限数（契约口径），note 缺失 ⇒ ''
  const synth = [
    { name: '每日积分', remaining: 10, active: true },
    { name: '充值积分', remaining: 5.5, active: true },
    { name: '负数包', remaining: -3, active: true },
    { name: '坏数据包', remaining: 'abc', active: true },
    { name: '冻结积分', remaining: 100, active: false },
  ]
  if (evalSplit === null) {
    ok(false, '合成包：跳过（formatBaizhiPoolSplit 抽不到）')
  } else {
    const s = evalSplit(synth)
    ok(s !== null && s.daily === 10, `合成包 daily = 10（实际 ${s?.daily}）`)
    ok(s !== null && s.rest === 5.5, `合成包 rest = 5.5（负数/非数/非 active 全排除，实际 ${s?.rest}）`)
    ok(s !== null && s.note === '', `每日包缺 expiryNote ⇒ note 是 ''（实际 ${JSON.stringify(s?.note)}）`)
  }
}

/* ── 4. loadBalances 穿透：真回包形状 ⇒ BAL 行带 split ──────────── */

console.log('--- 4) loadBalances 穿透（真回包 {accounts:[...]}）---')
const loadBalancesSrc = trySliceFn('async function loadBalances(')
ok(loadBalancesSrc !== null, '抽到 `async function loadBalances(` 的源码')

let makeHarness = () => null
if (loadBalancesSrc !== null) {
  makeHarness = () => {
    const factory = new Function(
      `
      let BAL = new Map()
      let rpc
      // 常量声明 / 纯函数照源码原样注入（一个字符不改）
      ${consoleDecl?.decl ?? ''}
      ${splitFnSrc ?? ''}
      ${loadBalancesSrc}
      // loadBalances 返回新 Map（切渠道守卫），抽出的源码一个字符没改，
      // 只在外面补「调用方把返回值写回」这一步（同 t-console-credits）。
      const load = async (...args) => { BAL = await loadBalances(...args); return BAL }
      return {
        load,
        getBAL: () => BAL,
        setRpc: (fn) => { rpc = fn },
      }
      `,
    )
    return factory()
  }
}

if (loadBalancesSrc === null) {
  ok(false, '跳过穿透断言：loadBalances 源码抽不到')
} else {
  {
    const h = makeHarness()
    h.setRpc(async () => ({
      accounts: [{ accountId: 'acc_bz', balance: buildBaizhiBalance(SCREENSHOT_WALLET) }],
    }))
    await h.load('baizhi')
    const bal = h.getBAL()
    ok(bal.size === 1, `baizhi 回包摊开 1 条（实际 ${bal.size}）`)
    const row = bal.get('acc_bz')
    ok(row !== undefined, '行按 accountId 作键')
    if (row !== undefined) {
      ok(row.total === 916.68, `旧字段 total 不变 = 916.68（实际 ${row.total}）`)
      ok(row.temp === null, '旧字段 temp = null（baizhi 不下发 expiringTotal，不编造 0）')
      ok(row.long === null, '旧字段 long = null（没有临期口径就不谈「其余」）')
      ok(row.expired === 0, `旧字段 expired = 0（实际 ${row.expired}）`)
      ok(row.error === null && row.stale === null, '旧字段 error / stale 不变（都是 null）')
      ok(row.split !== null && typeof row.split === 'object', '新字段 split 非 null')
      if (row.split !== null && typeof row.split === 'object') {
        ok(row.split.daily === 99.64, `split.daily = 99.64（实际 ${row.split.daily}）`)
        ok(row.split.rest === 817.04, `split.rest = 817.04（实际 ${row.split.rest}）`)
      }
    }
  }

  {
    // 通用渠道（无 packages）：split 必须为 null，旧三档逐字不变
    const h = makeHarness()
    h.setRpc(async () => ({
      accounts: [
        { accountId: 'acc_generic', balance: { total: 5100, expiringTotal: 1400, expiredTotal: 200 } },
      ],
    }))
    await h.load('buddy')
    const row = h.getBAL().get('acc_generic')
    ok(row !== undefined, '通用渠道行摊开')
    if (row !== undefined) {
      ok(row.total === 5100 && row.temp === 1400 && row.long === 3700 && row.expired === 200, '通用三档不变：5100 / 临期 1400 / 其余 3700 / 已失效 200')
      ok(row.split === null, '通用渠道 split = null（不碰通用渲染）')
    }
  }

  {
    // baizhi 的不同每日桶形状（未领取）也要穿透到 split.note
    const h = makeHarness()
    h.setRpc(async () => ({
      accounts: [
        {
          accountId: 'acc_pending',
          balance: buildBaizhiBalance({ available: 817.04, temporary: 0, permanent: 817.04, frozen: 0, dailyClaimed: false }),
        },
      ],
    }))
    await h.load('baizhi')
    const row = h.getBAL().get('acc_pending')
    ok(
      row !== undefined && row.split !== null && /今日尚未领取/.test(String(row.split.note)),
      '未领取回包穿过 loadBalances：split.note 带「今日尚未领取」',
    )
  }

  {
    // 失败行（balance null + error）⇒ split 为 null，error 照旧
    const h = makeHarness()
    h.setRpc(async () => ({
      accounts: [{ accountId: 'acc_bad', balance: null, error: '登录态失效，请重新登录' }],
    }))
    await h.load('baizhi')
    const row = h.getBAL().get('acc_bad')
    ok(row !== undefined && typeof row.error === 'string' && row.error.length > 0, '失败行落 error 分支')
    ok(row !== undefined && row.split === null, '失败行 split = null（不编造拆分）')
  }

  {
    // 兼顶旧读数：balance + error 同时有值 ⇒ stale 标注，split 照样算
    const h = makeHarness()
    h.setRpc(async () => ({
      accounts: [
        {
          accountId: 'acc_stale',
          balance: buildBaizhiBalance(SCREENSHOT_WALLET),
          error: '本次查询失败，显示的是 2026-11-09 13:04:20 的数据（上游不可达）',
        },
      ],
    }))
    await h.load('baizhi')
    const row = h.getBAL().get('acc_stale')
    ok(row !== undefined && typeof row.stale === 'string' && /查询失败/.test(row.stale), '兼顶行 stale 照旧')
    ok(
      row !== undefined && row.split !== null && row.split.daily === 99.64 && row.split.rest === 817.04,
      '兼顶行 split 照常算出（旧读数的拆分也要能显示）',
    )
  }

  {
    // 换渠道不残留：baizhi 之后切通用渠道，split 必须消失
    const h = makeHarness()
    h.setRpc(async () => ({
      accounts: [{ accountId: 'acc_x', balance: buildBaizhiBalance(SCREENSHOT_WALLET) }],
    }))
    await h.load('baizhi')
    ok(h.getBAL().get('acc_x')?.split !== null, '第一次（baizhi）有 split')
    h.setRpc(async () => ({ accounts: [{ accountId: 'acc_x', balance: { total: 42 } }] }))
    await h.load('buddy')
    ok(h.getBAL().get('acc_x')?.split === null, '换渠道后 split 清零（不沿用上一家）')
  }
}

/* ── 5. 渲染串：formatCreditAmount 组合 + renderAccounts 接线 ────── */

console.log('--- 5) 渲染串与 renderAccounts 接线 ---')
const fmtSrc = trySliceFn('function formatCreditAmount(')
ok(fmtSrc !== null, '抽到 `function formatCreditAmount(` 的源码（与客户端 formatCredits 同形）')

if (fmtSrc === null) {
  ok(false, '跳过渲染串断言：formatCreditAmount 抽不到')
} else {
  const fmtFactory = new Function(`${fmtSrc}\nreturn formatCreditAmount`)
  const fmt = fmtFactory()
  ok(fmt(817.04) === '817.04', `formatCreditAmount(817.04) = '817.04'（实际 '${fmt(817.04)}'）`)
  ok(fmt(99.64) === '99.64', `formatCreditAmount(99.64) = '99.64'（实际 '${fmt(99.64)}'）`)
  ok(fmt(100) === '100', `整数不带小数位（100 → '${fmt(100)}'）`)

  if (evalSplit === null) {
    ok(false, '跳过渲染串组合：formatBaizhiPoolSplit 抽不到')
  } else {
    const split = evalSplit(buildBaizhiBalance(SCREENSHOT_WALLET).packages)
    const line = split === null ? null : `长期 ${fmt(split.rest)} · 每日 ${fmt(split.daily)}`
    ok(line === '长期 817.04 · 每日 99.64', `组合串 = '长期 817.04 · 每日 99.64'（实际 '${line}'）`)
  }
}

// 源码级：renderAccounts 消费 bal.split，且 null 分支保留旧串（防静默丢渲染）
{
  const raSrc = trySliceFn('function renderAccounts(')
  ok(raSrc !== null, '抽到 `function renderAccounts(` 的源码')
  if (raSrc === null) {
    ok(false, '跳过 renderAccounts 接线断言')
  } else {
    const ra = stripComments(raSrc)
    ok(/bal\.split/.test(ra), 'renderAccounts 消费 `bal.split`（拆分不被静默丢弃）')
    // ⚠️ 取窗锚点必须是**拆分模板串所在的整段**：从 `bal.split` 第一处命中去切
    // 会命中 `bal?.split == null` 这个 null 判断（三元第一支），窗口里全是 null 分支
    // 与注释区，真正的模板串「长期 … · 每日 …」落在窗口外 —— 实现全对、测试却报红
    // （2026-11-09 队长核验实测踩到）。⇒ 用 `const splitPart` 到 `const creditDd`
    // 之间这一段定位，边界不靠长度猜。
    const iPart = ra.indexOf('const splitPart')
    const iDd = ra.indexOf('const creditDd', iPart < 0 ? 0 : iPart)
    const splitBranch = iPart < 0 ? '' : iDd < 0 ? ra.slice(iPart) : ra.slice(iPart, iDd)
    ok(iPart >= 0 && iDd > iPart, '定位到 `const splitPart = …` 到 `const creditDd` 之间的拆分段')
    ok(
      /bal\?\.split\s*==\s*null|bal\.split\s*==\s*null|bal\.split\s*===\s*null/.test(splitBranch),
      '有无每日桶的分叉由 `split == null` 判（不是按 provider 硬编）',
    )
    ok(/creditPoolPart/.test(splitBranch), '拆分分支复用 `.creditPoolPart` 类')
    ok(/formatCreditAmount\(/.test(splitBranch), '拆分分支用 `formatCreditAmount` 格式化（不在渲染处硬编码小数）')
    ok(/长期/.test(splitBranch) && /每日/.test(splitBranch), '拆分分支文案含「长期」「每日」')
    ok(
      /creditExpire/.test(splitBranch) && /title=/.test(splitBranch),
      '每日数带 `.creditExpire` + title（零点过期口径可悬停查看）',
    )
    // null 分支（split 为 null 时）逐字回退旧渲染：其余 / 临期 / 已失效 / 旧
    ok(/其余 \$\{bal\.long\} · 临期/.test(ra), 'null 分支保留旧串「其余 … · 临期 …」')
    // ⚠️ 已失效数 2026-11-11 起走 `formatScaledAmount(bal.expired, bal.unit)` ——
    // 原来是裸 `${bal.expired}`，token 计渠道会把千万级原始整数逐位写出来。
    // 文案（「另有 … 已失效」）与落位不变，只换数值表达式；credit 渠道
    // `formatScaledAmount` 对非 token 走 `String(value)`，与旧串逐字相同。
    ok(/另有 \$\{formatScaledAmount\(bal\.expired, bal\.unit\)\} 已失效/.test(ra), 'null 分支保留「另有 N 已失效」')
    ok(/formatScaledAmount\(bal\.total, bal\.unit\)/.test(ra), '合计值走 `formatScaledAmount`（token 计渠道量级压缩）')
    ok(/creditStale/.test(ra), 'null 分支保留 stale「旧」标记')
  }
}

console.log(`\n${bad === 0 ? '✓ 全部通过' : `✗ ${bad} 项失败`}（${total} 项）`)
if (bad > 0) process.exit(1)