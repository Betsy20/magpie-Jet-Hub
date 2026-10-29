#!/usr/bin/env node
/**
 * gh-patrol.mjs —— GitHub issue / PR 收件箱巡检
 *
 * 用途：给「每 30 分钟巡检一次」的自动化任务提供唯一的数据入口。
 * 只读：本脚本**不**发评论、不打标签、不关单，只抓取 + 比对 + 落盘 + 打印。
 *
 * 用法：
 *   node scripts/gh-patrol.mjs                # 巡检默认仓库（origin），有变化才详细输出
 *   node scripts/gh-patrol.mjs --repo owner/name
 *   node scripts/gh-patrol.mjs --all          # 强制输出全部条目，忽略增量
 *   node scripts/gh-patrol.mjs --json         # 只输出机器可读 JSON
 *   node scripts/gh-patrol.mjs --notify       # 有新增时弹 Windows 通知
 *
 * 退出码：0 = 正常（无论有无新增）；1 = 抓取失败；2 = 凭证缺失
 *
 * 凭证来源（按优先级）：
 *   1. 环境变量 GH_TOKEN / GITHUB_TOKEN
 *   2. `git credential fill`（与 git push 用同一套凭据，不额外落盘明文）
 *
 * 落盘：
 *   ~/.dsh/jet-hub/patrol/state.json     上次巡检快照（用于增量比对）
 *   ~/.dsh/jet-hub/patrol/latest.md      最近一次巡检的 Markdown 报告
 *   ~/.dsh/jet-hub/patrol/history.jsonl  每次巡检一行，便于回溯
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

// 状态目录可用 GH_PATROL_STATE_DIR 覆盖：测试要隔离，别污染真实巡检基线。
const STATE_DIR = process.env.GH_PATROL_STATE_DIR || join(homedir(), '.dsh', 'jet-hub', 'patrol')
const STATE_FILE = join(STATE_DIR, 'state.json')
const LATEST_MD = join(STATE_DIR, 'latest.md')
const HISTORY = join(STATE_DIR, 'history.jsonl')

const API = 'https://api.github.com'

// ---------- 参数 ----------

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name, fallback = null) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const FORCE_ALL = flag('--all')
const JSON_ONLY = flag('--json')
const NOTIFY = flag('--notify')
const REPO_ARG = opt('--repo')

// ---------- 凭证 ----------

function resolveToken() {
  const fromEnv = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (fromEnv) return fromEnv.trim()

  try {
    // git credential fill 从 stdin 读查询、从 stdout 吐 username/password。
    // 这是唯一不额外存明文又能复用既有 GitHub 凭据的路径。
    const out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const line = out.split('\n').find((l) => l.startsWith('password='))
    if (line) return line.slice('password='.length).trim()
  } catch {
    /* 落到下面的报错 */
  }
  return null
}

function resolveRepo() {
  if (REPO_ARG) return REPO_ARG
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    // https://github.com/owner/name.git  |  git@github.com:owner/name.git
    const m = url.match(/github\.com[:/]+([^/]+)\/([^/.]+)/)
    if (m) return `${m[1]}/${m[2]}`
  } catch {
    /* 下面报错 */
  }
  return null
}

// ---------- HTTP ----------

async function gh(token, path) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dsh-gh-patrol',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  const body = await res.text()
  let data
  try {
    data = body ? JSON.parse(body) : null
  } catch {
    data = body
  }
  if (!res.ok) {
    const msg = data && data.message ? data.message : String(body).slice(0, 200)
    const err = new Error(`GET ${path} → ${res.status}: ${msg}`)
    err.status = res.status
    err.rateLimit = {
      remaining: res.headers.get('x-ratelimit-remaining'),
      reset: res.headers.get('x-ratelimit-reset'),
    }
    throw err
  }
  return { data, headers: res.headers }
}

// ---------- 归一化 ----------

/** 把 GitHub 的 issue / PR 对象压成只留巡检要用的字段。 */
function normalize(item) {
  const isPR = Boolean(item.pull_request)
  return {
    kind: isPR ? 'pr' : 'issue',
    number: item.number,
    title: item.title,
    user: item.user?.login ?? 'ghost',
    state: item.state,
    draft: isPR ? Boolean(item.draft) : null,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    comments: item.comments ?? 0,
    labels: (item.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
    // PR 专属：是否已合并、是否可合、评审状态要另拉一次，这里只留能一次拿到的
    mergedAt: isPR ? item.pull_closed_at && item.merged_at ? item.merged_at : null : null,
    url: item.html_url,
  }
}

/** 一条条目的指纹：只要这些字段没变，就认为「这条没动过」。 */
function fingerprint(entry) {
  return [
    entry.state,
    entry.updatedAt,
    entry.comments,
    entry.labels.join(','),
    entry.draft ?? '',
  ].join('|')
}

/**
 * 比对「本次抓到的条目」与「上次快照」，得出新增 / 更新 / 关闭三组。
 *
 * 纯函数，不碰网络和文件 —— 这是巡检最容易出错的地方（首跑误报、改标题不报、
 * 关闭没捕捉），所以单独抽出来给 tests/t-patrol.mjs 覆盖。
 *
 * @param {Array} items     本次 normalize 后的条目
 * @param {Object} prevItems 上次快照的 items（key → {fp, number, kind, title, url}）
 */
function diffSnapshots(items, prevItems) {
  const curItems = {}
  const added = []
  const changed = []
  const closed = []

  for (const it of items) {
    const key = `${it.kind}#${it.number}`
    const fp = fingerprint(it)
    curItems[key] = { fp, number: it.number, kind: it.kind, title: it.title, url: it.url }
    if (!prevItems[key]) added.push(it)
    else if (prevItems[key].fp !== fp) changed.push(it)
  }

  // 上次还在、这次不在 open 列表里 → 已关闭 / 已合并 / 被删
  for (const key of Object.keys(prevItems)) {
    if (!curItems[key]) closed.push({ key, ...prevItems[key] })
  }

  return { curItems, added, changed, closed }
}

// ---------- 主流程 ----------

async function main() {
  const token = resolveToken()
  if (!token) {
    console.error('[gh-patrol] 找不到 GitHub 凭证：请设置 GH_TOKEN，或先让 git 记住 github.com 的凭据。')
    process.exit(2)
  }

  const repo = resolveRepo()
  if (!repo) {
    console.error('[gh-patrol] 无法确定仓库：请在 git 仓库内运行，或用 --repo owner/name 指定。')
    process.exit(2)
  }

  const [owner, name] = repo.split('/')
  const now = new Date()

  // 一次拿全：issues 接口会连 PR 一起返回，用 pull_request 字段区分。
  // 100 条/页对本仓库足够；真超过时下面会显式提示。
  const { data: rawIssues, headers } = await gh(
    token,
    `/repos/${owner}/${name}/issues?state=open&per_page=100&sort=updated&direction=desc`,
  )

  const items = rawIssues.map(normalize)
  const issues = items.filter((i) => i.kind === 'issue')
  const prs = items.filter((i) => i.kind === 'pr')

  // 读上次快照
  const prev = existsSync(STATE_FILE)
    ? JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    : { items: {}, lastRun: null }

  const prevItems = prev.items ?? {}

  // 增量比对抽成纯函数，测试可以脱离网络直接喂快照。
  const { curItems, added, changed, closed } = diffSnapshots(items, prevItems)

  const isFirstRun = !prev.lastRun
  const hasNews = added.length + changed.length + closed.length > 0

  // 落盘
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        repo,
        lastRun: now.toISOString(),
        counts: { open: items.length, issues: issues.length, prs: prs.length },
        items: curItems,
      },
      null,
      2,
    ),
  )

  const report = renderReport({ repo, now, issues, prs, added, changed, closed, prev, isFirstRun, headers })
  writeFileSync(LATEST_MD, report)

  appendFileSync(
    HISTORY,
    JSON.stringify({
      at: now.toISOString(),
      repo,
      open: items.length,
      added: added.length,
      changed: changed.length,
      closed: closed.length,
    }) + '\n',
  )

  // 输出
  if (JSON_ONLY) {
    console.log(
      JSON.stringify(
        {
          repo,
          at: now.toISOString(),
          counts: { open: items.length, issues: issues.length, prs: prs.length },
          added: added.map(brief),
          changed: changed.map(brief),
          closed,
          isFirstRun,
          hasNews,
          rateRemaining: headers.get('x-ratelimit-remaining'),
          reportPath: LATEST_MD,
        },
        null,
        2,
      ),
    )
  } else if (hasNews || FORCE_ALL || isFirstRun) {
    // 有变化（或首跑、或强制）才详细打印，避免每 30 分钟刷一屏噪音
    console.log(report)
  } else {
    const r = headers.get('x-ratelimit-remaining')
    console.log(`[gh-patrol] ${repo} 无变化 · open ${items.length}（issue ${issues.length} / PR ${prs.length}）· 限额剩 ${r}`)
  }

  if (NOTIFY && hasNews && !isFirstRun) {
    toast(`${repo} 有 ${added.length + changed.length + closed.length} 处变化`, summarizeBrief(added, changed, closed))
  }
}

function brief(it) {
  return { kind: it.kind, number: it.number, title: it.title, user: it.user, url: it.url }
}

function summarizeBrief(added, changed, closed) {
  const parts = []
  if (added.length) parts.push(`新 ${added.length}`)
  if (changed.length) parts.push(`变 ${changed.length}`)
  if (closed.length) parts.push(`关 ${closed.length}`)
  return parts.join(' / ')
}

function renderReport({ repo, now, issues, prs, added, changed, closed, prev, isFirstRun, headers }) {
  const L = []
  L.push(`# GitHub 巡检 · ${repo}`)
  L.push('')
  L.push(`- 时间：${now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（Asia/Shanghai）`)
  L.push(`- 上次巡检：${prev.lastRun ? new Date(prev.lastRun).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '（无记录，本次为首次）'}`)
  L.push(`- 当前 open：**${issues.length + prs.length}**（issue ${issues.length} / PR ${prs.length}）`)
  L.push(`- 本次变化：新增 ${added.length} · 更新 ${changed.length} · 关闭/合并 ${closed.length}`)
  const r = headers.get('x-ratelimit-remaining')
  if (r) L.push(`- API 限额剩余：${r}`)
  L.push('')

  if (isFirstRun) {
    L.push('> 首次巡检，已建立基线。之后只报告变化。')
    L.push('')
  }

  const section = (title, arr, extra) => {
    if (!arr.length) return
    L.push(`## ${title}（${arr.length}）`)
    L.push('')
    for (const it of arr) {
      const tags = []
      if (it.kind === 'pr') tags.push(it.draft ? '草稿' : 'PR')
      if (it.labels?.length) tags.push(it.labels.join(','))
      L.push(`- [#${it.number}](${it.url}) ${it.title} — @${it.user}${tags.length ? ` · ${tags.join(' · ')}` : ''}`)
      if (extra) L.push(`  - ${extra(it)}`)
    }
    L.push('')
  }

  section('新增', added, (it) => `创建于 ${fmt(it.createdAt)}，评论 ${it.comments}`)
  section('有更新', changed, (it) => `更新于 ${fmt(it.updatedAt)}，评论 ${it.comments}`)

  if (closed.length) {
    L.push(`## 已关闭 / 已合并（${closed.length}）`)
    L.push('')
    for (const c of closed) L.push(`- ${c.kind}#${c.number} ${c.title ?? ''}`)
    L.push('')
  }

  if (!added.length && !changed.length && !closed.length) {
    L.push('本次无变化。')
    L.push('')
  }

  // 待办清单始终附上，方便一眼看到「还压着哪些」
  if (prs.length) {
    L.push(`## 当前待处理 PR（${prs.length}）`)
    L.push('')
    for (const it of prs) L.push(`- [#${it.number}](${it.url}) ${it.title} — @${it.user}${it.draft ? ' · 草稿' : ''}`)
    L.push('')
  }
  if (issues.length) {
    L.push(`## 当前待处理 Issue（${issues.length}）`)
    L.push('')
    for (const it of issues) L.push(`- [#${it.number}](${it.url}) ${it.title} — @${it.user}`)
    L.push('')
  }

  return L.join('\n')
}

function fmt(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
}

/** Windows 桌面通知（失败静默：巡检本身不该因为弹不出气泡而失败）。 */
function toast(title, body) {
  try {
    const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$tpl = @"
<toast><visual><binding template="ToastGeneric"><text>${escapeXml(title)}</text><text>${escapeXml(body)}</text></binding></visual></toast>
"@
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($tpl)
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('GitHub 巡检').Show($toast)
`
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      stdio: 'ignore',
      timeout: 15000,
    })
  } catch {
    /* 通知失败不影响巡检 */
  }
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c])
}

// 供测试导入的纯函数。被 import 时不该产生任何副作用，因此 main 只在
// 「被 node 直接执行」时调用（见文件末尾的入口判断）。
export { normalize, fingerprint, diffSnapshots, renderReport }

// 被 node 直接执行时才跑；被 import（测试）时保持安静。
const isEntry = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

if (isEntry) {
  main().catch((err) => {
    console.error(`[gh-patrol] 失败：${err.message}`)
    if (err.rateLimit?.reset) {
      console.error(`[gh-patrol] 限额重置时间：${new Date(Number(err.rateLimit.reset) * 1000).toLocaleString('zh-CN')}`)
    }
    process.exit(1)
  })
}
