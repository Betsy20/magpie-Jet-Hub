// gh-patrol.mjs 契约测试（不需要网络，不需要凭证）。
//
// 巡检最容易出错的地方不是「调不通 API」，而是**增量判断**：
//   - 首次运行把「全部存量」误报成「新增」；
//   - 只改标题 / 加标签 / 新评论没被认成变化；
//   - 条目被关闭后静默消失，没人发现。
// 这三类都在这里断言，用伪造的 GitHub 对象喂纯函数，不联网。
import { normalize, fingerprint, diffSnapshots } from '../scripts/gh-patrol.mjs'

const problems = []
const ok = (cond, msg) => { if (!cond) problems.push(msg) }
const eq = (got, want, msg) => ok(got === want, `${msg}：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`)

// ---- 1) normalize：issue 与 PR 必须能区分 ----------------------------------
// GitHub 的 /issues 接口会把 PR 一起返回，靠 pull_request 字段区分。
// 认错这个字段，PR 就会被当成 issue 报出去。
{
  const rawIssue = {
    number: 7,
    title: '登录后白屏',
    user: { login: 'alice' },
    state: 'open',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
    comments: 3,
    labels: [{ name: 'bug' }, 'ui'],
    html_url: 'https://github.com/o/r/issues/7',
  }
  const i = normalize(rawIssue)
  eq(i.kind, 'issue', '没有 pull_request 字段应判为 issue')
  eq(i.number, 7, 'issue 编号')
  eq(i.user, 'alice', 'issue 作者')
  eq(i.comments, 3, 'issue 评论数')
  eq(i.labels.join(','), 'bug,ui', '标签对象与裸字符串都要能吃')
  eq(i.draft, null, 'issue 没有 draft 概念，应为 null')

  const rawPR = {
    number: 9,
    title: '补测试',
    user: { login: 'bob' },
    state: 'open',
    draft: true,
    created_at: '2026-10-03T00:00:00Z',
    updated_at: '2026-10-04T00:00:00Z',
    comments: 0,
    labels: [],
    pull_request: { url: 'https://api.github.com/...' },
    html_url: 'https://github.com/o/r/pull/9',
  }
  const p = normalize(rawPR)
  eq(p.kind, 'pr', '有 pull_request 字段应判为 pr')
  eq(p.draft, true, 'PR 的 draft 要保留')

  // user 被删号时 GitHub 会返回 null user
  const ghost = normalize({ number: 1, title: 'x', user: null, state: 'open' })
  eq(ghost.user, 'ghost', 'user 为 null 时不该崩，应回退成 ghost')
  eq(ghost.comments, 0, '缺 comments 时按 0 算')
}

// ---- 2) fingerprint：什么算「变了」 ----------------------------------------
// 判据必须覆盖：状态、更新时间、评论数、标签、草稿态。
// 漏掉任何一项，那类变化就会永远静默。
{
  const base = normalize({
    number: 1, title: 'a', user: { login: 'u' }, state: 'open',
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z',
    comments: 0, labels: [], html_url: 'https://x/1',
  })
  const f0 = fingerprint(base)

  const withComment = fingerprint({ ...base, comments: 1 })
  ok(withComment !== f0, '新评论必须算变化')

  const withLabel = fingerprint({ ...base, labels: ['bug'] })
  ok(withLabel !== f0, '加标签必须算变化')

  const withUpdate = fingerprint({ ...base, updatedAt: '2026-10-05T00:00:00Z' })
  ok(withUpdate !== f0, '更新时间变化必须算变化')

  const asClosed = fingerprint({ ...base, state: 'closed' })
  ok(asClosed !== f0, '状态变化必须算变化')

  const asDraft = fingerprint({ ...base, draft: true })
  ok(asDraft !== f0, '草稿态变化必须算变化')

  // 只改标题**不**算变化：标题改动不刷新 updated_at 的情况极少，
  // 而把标题塞进指纹会让「编辑标题」和「新评论」两类事件混在一起报。
  // 这里明确锁定当前取舍，避免以后有人无声改掉。
  eq(fingerprint({ ...base, title: '完全不同的标题' }), f0, '标题不进指纹（有意为之）')
}

// ---- 3) diffSnapshots：三组分类 -------------------------------------------
{
  const mk = (n, kind, extra = {}) =>
    normalize({
      number: n, title: `${kind}-${n}`, user: { login: 'u' }, state: 'open',
      created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z',
      comments: 0, labels: [], html_url: `https://x/${kind}/${n}`,
      ...(kind === 'pr' ? { pull_request: {} } : {}),
      ...extra,
    })

  // 首跑：上次快照为空 → 全部算新增（这是预期的，报告里会标注「首次」）
  {
    const r = diffSnapshots([mk(1, 'issue'), mk(2, 'pr')], {})
    eq(r.added.length, 2, '首跑全部算新增')
    eq(r.changed.length, 0, '首跑没有「更新」')
    eq(r.closed.length, 0, '首跑没有「关闭」')
    eq(Object.keys(r.curItems).join(','), 'issue#1,pr#2', '快照 key 带类型前缀，避免 issue/PR 编号撞车')
  }

  // 稳定态：一模一样 → 三组都空
  {
    const items = [mk(1, 'issue'), mk(2, 'pr')]
    const first = diffSnapshots(items, {})
    const second = diffSnapshots(items, first.curItems)
    eq(second.added.length, 0, '无变化时不该报新增')
    eq(second.changed.length, 0, '无变化时不该报更新')
    eq(second.closed.length, 0, '无变化时不该报关闭')
  }

  // 混合态：新增 1、更新 1、关闭 1
  {
    const prev = diffSnapshots([mk(1, 'issue'), mk(2, 'issue')], {}).curItems
    const now = [
      mk(1, 'issue', { comments: 5 }), // 有更新
      mk(3, 'issue'),                  // 新增
      // #2 消失 → 关闭
    ]
    const r = diffSnapshots(now, prev)
    eq(r.added.length, 1, '应识别 1 条新增')
    eq(r.added[0].number, 3, '新增的是 #3')
    eq(r.changed.length, 1, '应识别 1 条更新')
    eq(r.changed[0].number, 1, '更新的是 #1')
    eq(r.closed.length, 1, '应识别 1 条关闭')
    eq(r.closed[0].key, 'issue#2', '关闭的是 issue#2')
  }

  // issue #5 和 PR #5 同时存在时不能互相覆盖 —— 编号空间是共享的，
  // 只按 number 做 key 会丢一条。这是真实的 GitHub 行为。
  {
    const r = diffSnapshots([mk(5, 'issue'), mk(5, 'pr')], {})
    eq(Object.keys(r.curItems).length, 2, 'issue#5 与 pr#5 必须各占一条')
  }
}

if (problems.length) {
  console.log('✗ ' + problems.length + ' 处不符：')
  for (const p of problems) console.log('  ' + p)
  process.exit(1)
}
console.log('✓ gh-patrol 契约全部通过（normalize / fingerprint / diffSnapshots）')
