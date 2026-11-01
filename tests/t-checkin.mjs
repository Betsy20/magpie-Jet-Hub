// auth.checkin 契约测试。
//
// ⚠️ 签到是**有副作用**的真操作（会真的给账号领积分）。所以这里分两层：
//   1) 纯映射层（toMagpieCheckin）：所有 kind → outcome 的对应关系，不联网；
//   2) 真调用层：只打一个**明确不支持签到**的渠道（workbuddy），
//      它固定回 `ineligible`（能力缺失，不是故障），不会给任何账号产生副作用。
import * as mod from '../src/plugin.mjs'

// ⚠️ 本文件会真起容器，必须隔离（否则 `resolveHome(undefined)` 退回 `homedir()`，
// 把本体 `DSH_HOME` 指向用户真实凭据目录 —— 实测会真实轮换 access_token）。
// 三层隔离与踩过的坑写在 `tests/_iso.mjs` 文件头。
import { isolate, live, skipLive } from './_iso.mjs'

const iso = isolate()

const problems = []
const ok = (cond, msg) => { if (!cond) problems.push(msg) }

// ---- 1) 映射层 -------------------------------------------------------------
const map = mod.PLUGINS[0][1]
const probe = await map({}, iso.options())
const toMagpieCheckin = probe._internal?.toMagpieCheckin
ok(typeof toMagpieCheckin === 'function', '_internal 应导出 toMagpieCheckin')

if (typeof toMagpieCheckin === 'function') {
  const cases = [
    [{ kind: 'claimed', credit: 100 }, 'claimed', 100],
    [{ kind: 'already-claimed' }, 'done', undefined],
    [{ kind: 'inactive', message: '活动未开启' }, 'inactive', undefined],
    [{ kind: 'exhausted' }, 'done', undefined],
    [{ kind: 'failed', message: '网络错误' }, 'failed', undefined],
    [{ kind: 'captcha', message: '需要验证码' }, 'captcha', undefined],
    [{ kind: '某种没见过的 kind' }, 'failed', undefined],
  ]
  for (const [outcome, want, wantCredit] of cases) {
    const got = toMagpieCheckin({ accountId: 'a', outcome })
    ok(got.outcome === want, `kind=${outcome.kind} 应映射为 ${want}，实际 ${got.outcome}`)
    if (wantCredit !== undefined) ok(got.credit === wantCredit, `kind=${outcome.kind} 应带 credit=${wantCredit}，实际 ${got.credit}`)
    // magpie 只认这六种 outcome
    ok(
      ['claimed', 'done', 'ineligible', 'inactive', 'captcha', 'failed'].includes(got.outcome),
      `outcome 越界：${got.outcome}`,
    )
  }
  // ── 「这家没有签到功能」必须报 ineligible，不能报 failed ──
  //
  // 2026-11-01 用户报「部分供应商签到失败」：magpie 把 `failed` 画成红旗，
  // 而实测 plugin-checkin.json 里 40 条失败中 33 条是「本体明确说这家没有签到」。
  // 下面四条文案逐字取自那份文件（也是 vendor 的 claimUnavailableReason）。
  const unsupported = [
    'unsupported provider: modelscope',
    'Cline 不支持每日签到（其后端没有签到接口）',
    '超级麦吉暂不支持每日签到（本插件未接该端点）',
    'WorkBuddy 国际版不支持每日签到（其后端没有签到接口）',
    'Raccoon Work 不支持每日签到（每日积分由服务端自动发放；登录奖励请在「新手任务」中领取）',
    // ⚠️ 这条刻意**只含「不支持每日签到」一个关键词**：其余几条都同时命中两个模式，
    // 删掉其中一条正则测试仍然绿。留一条单一依赖的，每个模式才都有人守。
    '某渠道不支持每日签到',
  ]
  for (const msg of unsupported) {
    const got = toMagpieCheckin({ accountId: 'a', outcome: { kind: 'failed', message: msg } })
    ok(got.outcome === 'ineligible', `不支持签到的文案应映射为 ineligible，实际 ${got.outcome}（${msg.slice(0, 24)}…）`)
    ok(got.message === msg, 'ineligible 仍要保留原文，方便用户在控制台看到原因')
  }
  // 真失败不能被误判成 ineligible
  for (const msg of [
    '凭据已失效（HTTP 401）：invalid access token',
    '账户信息查询失败：HTTP 401：APIG.0301 Incorrect IAM authentication information: Unauthorized',
    'fetch failed',
  ]) {
    const got = toMagpieCheckin({ accountId: 'a', outcome: { kind: 'failed', message: msg } })
    ok(got.outcome === 'failed', `真失败仍应是 failed，实际 ${got.outcome}（${msg.slice(0, 24)}…）`)
  }
  // credit 为 0 / 负数不该当成"领到了积分"
  const zero = toMagpieCheckin({ outcome: { kind: 'claimed', credit: 0 } })
  ok(zero.credit === undefined, 'credit=0 时不该带 credit 字段')
}

// ---- 2) 契约层：每个 provider 都要有 checkin -------------------------------
for (const [id, fn] of mod.PLUGINS) {
  const plugin = await fn({}, iso.options())
  ok(typeof plugin.auth.checkin === 'function', `${id}: 缺 auth.checkin`)
}

// ---- 3) 真调用：workbuddy 明确不支持签到（无副作用）------------------------
// 真调用要真凭据（隔离沙箱里没有 ⇒ 默认跳过）。
// ⚠️ 即使上游说「不支持签到」，这条链路也真发了一次 RPC —— 所以必须是 opt-in。
if (live()) {
  iso.restore()
  const wb = mod.PLUGINS.find(([i]) => i === 'jet-hub-workbuddy')[1]
  const wbPlugin = await wb({}, {})
  const r = await wbPlugin.auth.checkin(async () => ({ uid: 'workbuddy-c1d2e3f4' }), { id: 'jet-hub-workbuddy' })
  console.log('workbuddy checkin =', JSON.stringify(r))
  ok(r.outcome === 'ineligible', `workbuddy 不支持签到，应为 ineligible（能力缺失，不是故障），实际 ${r.outcome}`)
  ok(typeof r.message === 'string' && r.message !== '', 'ineligible 必须带 message 说明原因')
} else {
  skipLive('真调用 checkin（workbuddy）')
}

if (problems.length) {
  console.log('✗ ' + problems.length + ' 处不符：')
  for (const p of problems) console.log('  ' + p)
  process.exit(1)
}
console.log('✓ checkin 映射与契约均正确')
process.exit(0)
