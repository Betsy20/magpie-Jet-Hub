/**
 * 把本体账号池**摊平**进 magpie 的 `plugin-auth.json`，让 magpie 每个 provider
 * 名下显示它自己的账号，且一行对应一个 DSH 账号。
 *
 * ## 为什么从脚本搬进插件
 *
 * 原先只有 `scripts/seed-auth.mjs` 干这件事，得手动跑。账号一旦被删掉或重新登录
 * 换了 id，magpie 里就留着指向旧 id 的记录 —— 界面上表现为「一个渠道显示 3 个
 * 账号，其中两个叫 `API key ...4aaa`」（2026-11-01 用户报障：超级麦吉只有 1 个
 * 账号，magpie 却显示 3 个）。所以现在插件启动后自己对齐一次，脚本仍保留给
 * 「不想重启 magpie 就想同步」的场景。
 *
 * ## 只动自己的键
 *
 * `jet-hub` / `jet-hub-*` 及其 `#<后缀>` 分支是本插件的；别的插件记录一律保留。
 * 另外会清掉「**本插件自己写的、但键名不是 `jet-hub-*`**」的记录（早期如果直接
 * 拿 DSH 的 provider 名当 magpie id 就会留下这种）。判据见 `legacyKeysOf`。
 *
 * ⚠️ 这类记录**实际上从来没产生过**：查过 git 历史（`571bcc8` 初提交起），
 * `seed-auth.mjs` 一直用 `idOf(dsh)`（`jet-hub-` 前缀）+ `type:'api'`。
 * 保留这段逻辑只是防未来变体，别把它当成「正在清理什么」的证据。
 *
 * ⚠️⚠️ 而键名恰好等于 DSH provider 名（`magicrew` / `workbuddy` / `zcode` …）的
 * 那些记录，**是别的插件的登录态**（`magpie-magicrew-auth` /
 * `opencode-autoclaw-auth` / `opencode-codearts-auth` 等，见
 * `~/.config/magpie/plugin-providers.json` 的 `spec` 字段），形状是
 * `{type:'oauth', refresh, access}`。2026-11-01 曾按名字判断把它们当自家垃圾删了
 * **18 条**，是真实事故 —— 所以判据只认内容、绝不认名字。
 *
 * ## 幂等
 *
 * 内容没变就**不写盘**：每次启动都重写一遍对用户没有好处，还会不断生成
 * `.bak-lead-*` 备份文件。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 本插件管辖的 magpie 键。 */
export function isOurKey(k) {
  return k === 'jet-hub' || String(k).startsWith('jet-hub-')
}

/** 稳定短后缀：同一个 DSH 账号每次算出来都落到同一个 magpie 键。 */
export function suffixOf(id) {
  let h = 0
  const s = String(id)
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h.toString(36).slice(0, 6).padStart(6, '0')
}

/**
 * 默认路径：`~/.config/magpie/plugin-auth.json`。
 *
 * `JET_HUB_AUTH_PATH` 可覆盖 —— 测试必须靠它把写入引到临时目录。这条**不是**可选项：
 * 2026-11-01 两次真实事故都是因为测试把「临时 home 的账号集」写进了用户真实配置
 * （`os.homedir()` 不受 `DSH_HOME` 约束），而异常又被吞掉，测试照样全绿。
 */
export function defaultAuthPath(home = os.homedir()) {
  const override = process.env.JET_HUB_AUTH_PATH
  if (typeof override === 'string' && override.trim() !== '') return override
  return path.join(home, '.config', 'magpie', 'plugin-auth.json')
}

/**
 * 目标路径是否落在**真实用户**的 magpie 配置目录里。
 *
 * 用来做最后一道拒写防线：`os.homedir()` 不受 `DSH_HOME` / `USERPROFILE` 的
 * 隔离约束（Windows 上它读的是环境变量，但测试里改晚了就还是真值），
 * 所以「测试态 + 真实路径」必须直接拒绝，而不是指望调用方记得设开关。
 */
export function isRealUserConfig(authPath) {
  const real = path.resolve(os.homedir(), '.config', 'magpie') + path.sep
  return path.resolve(authPath).startsWith(real)
}

/**
 * 纯函数：账号数组 → magpie 记录表。
 *
 * @param {Array<{provider?: string, id?: string, nickname?: string, enabled?: boolean}>} accounts
 * @param {{providers: readonly string[], idOf: (dsh: string) => string}} deps
 * @returns {{next: Record<string, unknown>, report: Array<[string, number, string]>}}
 */
export function planAuthRecords(accounts, { providers, idOf, skipProviders }) {
  const skip = skipProviders instanceof Set ? skipProviders : new Set(skipProviders ?? [])
  const byProvider = new Map()
  for (const a of accounts) {
    const p = String(a?.provider ?? '')
    if (!p) continue
    if (!byProvider.has(p)) byProvider.set(p, [])
    byProvider.get(p).push(a)
  }

  const next = {}
  const report = []
  for (const dsh of providers) {
    // 这家这次没读成功（RPC 抛错）⇒ 不要生成占位，由调用方保留它原有的记录。
    // 否则一次瞬时失败就会把「20 个账号」整批换成一条「未登录该渠道」。
    if (skip.has(dsh)) continue
    const magpieId = idOf(dsh)
    const mine = (byProvider.get(dsh) ?? [])
      .slice()
      // 启用的排前面：第一行是 magpie 的「默认账号」，别让停用的号占位
      .sort((a, b) => Number(b?.enabled !== false) - Number(a?.enabled !== false))

    if (mine.length === 0) {
      // 本体里没有这个渠道的账号：仍写一条占位记录，否则 magpie 报
      // `no plugin signs in to <id>`，卡片点不动。
      const why = '（本机 DSH 未登录该渠道）'
      next[magpieId] = {
        type: 'api',
        key: `jet-hub-local:${dsh}`,
        accountId: why,
        metadata: { via: 'jet-hub', dshProvider: dsh },
      }
      report.push([magpieId, 0, why])
      continue
    }

    mine.forEach((a, i) => {
      const key = i === 0 ? magpieId : `${magpieId}#${suffixOf(a.id)}`
      const off = a.enabled === false ? '（已停用）' : ''
      next[key] = {
        type: 'api',
        key: `jet-hub-local:${dsh}/${a.id}`,
        accountId: `${a.nickname || a.id}${off}`,
        uid: String(a.id),
        metadata: { via: 'jet-hub', dshProvider: dsh, dshAccountId: a.id, enabled: a.enabled !== false },
      }
    })
    report.push([magpieId, mine.length, mine.map((a) => a.nickname || a.id).join(' / ')])
  }
  return { next, report }
}

/**
 * 旧版 provider id 的残留键：键名（去掉 `#后缀`）本身就是某个 DSH provider 名，
 * 却不是本插件的 `jet-hub-*` 形态。
 *
 * 排除 `jet-hub-*` 是必须的：`jet-hub-auto` 也在 `providers` 里，但它是本插件
 * 自己的旧键，由 `isOurKey` 负责替换，不能在这里被当成「别人的」保留下来。
 */
/**
 * 判断哪些键是「本插件早期版本写在别人名下」的记录。
 *
 * ## 判据为什么必须是「内容特征」而不是「名字」
 *
 * 2026-11-01 踩过的真实事故：最初用「键名归一到某个 DSH provider 名」来判，
 * 结果把**别的插件**的登录态整批删了 —— `plugin-auth.json` 里同时装着
 * `magpie-magicrew-auth`、`opencode-autoclaw-auth`、`opencode-codearts-auth`
 * 等插件的 provider（`magicrew` / `magicrew-intl` / `autoclaw-cn` / `codearts` /
 * `officeace` / `raccoon` / `workbuddy` / `zcode` / `qoder` / `cline` / `loomy`），
 * 名字与 DSH 的 provider 名一模一样，靠名字分不出是谁的。实测误删了 18 条
 * `{type:'oauth'}` 登录态。
 *
 * 靠得住的区分是**内容**：
 *
 * - 本插件写的永远是 `{ type: 'api', key: 'jet-hub-local:<dsh>[/<id>]' }`；
 * - magpie 替别的插件保存的永远是 `{ type: 'oauth', refresh, access, … }`。
 *
 * 所以这里只认「不是 `jet-hub-*` 键、但值是我们写的那种 api 记录」——
 * 那是本插件极早期直接拿 DSH provider 名当 magpie id 时留下的。
 * 别人的 oauth 记录，**一条都不碰**。
 */
export function legacyKeysOf(all) {
  return Object.keys(all).filter((k) => {
    if (isOurKey(k)) return false
    const v = all[k]
    if (v === null || typeof v !== 'object') return false
    return v.type === 'api' && typeof v.key === 'string' && v.key.startsWith('jet-hub-local:')
  })
}

function sameRecords(a, b) {
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return kb.every((k) => a[k] !== undefined && JSON.stringify(a[k]) === JSON.stringify(b[k]))
}

/**
 * 读 -> 组装 -> 备份 -> 原子写 -> 回读校验。
 *
 * @returns {{changed: boolean, wrote: boolean, keys: number, removed: string[], report: Array<[string, number, string]>, backup?: string}}
 */
export function syncPluginAuth({
  accounts,
  providers,
  idOf,
  authPath = defaultAuthPath(),
  dryRun = false,
  failedProviders = [],
}) {
  // ⚠️ 最后一道防线：测试态绝不写真实用户配置。2026-11-01 因为少了这道，
  // 跑一次 `node tests/t-key-account.mjs` 就把用户 60 行真实账号塌成 23 条占位。
  if (process.env.NODE_ENV === 'test' && isRealUserConfig(authPath)) {
    throw new Error(`测试环境拒绝改写真实 magpie 配置（${authPath}）`)
  }
  const skipProviders = new Set(failedProviders)
  let all = {}
  let raw = null
  let hadFile = false
  try {
    raw = fs.readFileSync(authPath, 'utf8')
    all = JSON.parse(raw)
    if (!all || typeof all !== 'object' || Array.isArray(all)) throw new Error('不是对象')
    hadFile = true
  } catch (e) {
    // 文件不存在是正常的（第一次启动）；存在但读不动就拒绝改写 —— 覆盖掉的可能是
    // 别的插件的登录态。
    if (raw !== null) throw new Error(`plugin-auth.json 读不动（${e.message}）—— 拒绝改写`)
    all = {}
  }

  const { next, report } = planAuthRecords(accounts, { providers, idOf, skipProviders })
  const legacy = legacyKeysOf(all)
  // 没读成功的那几家：它们的旧键**原样保留**（`next` 里没有它们的条目，
  // 若这里再按 isOurKey 全删，就等于用「空」覆盖了真实账号行）。
  //
  // 只对**这几家**生效。曾经写成「只要有任意一家失败就保留所有非 next 的键」，
  // 而本机 accio / autoclawintl / codely / gemini 常年零账号、失败是常态 ——
  // 那等于本插件的旧记录（以及 legacy 垃圾）永远清不掉。
  const skipIds = new Set([...skipProviders].map((p) => idOf(p)))
  const keepDueToFailure = (k) => skipIds.has(k.split('#')[0])
  const kept = Object.fromEntries(
    Object.entries(all).filter(([k]) => (!isOurKey(k) && !legacy.includes(k)) || keepDueToFailure(k)),
  )
  const removed = [
    ...Object.keys(all).filter((k) => isOurKey(k) && kept[k] === undefined),
    ...legacy.filter((k) => kept[k] === undefined),
  ]
  const merged = { ...kept, ...next }

  const changed = !sameRecords(all, merged)
  if (!changed || dryRun) {
    return { changed, wrote: false, keys: Object.keys(next).length, removed, report }
  }

  // 首次启动时文件还不存在，没有可备份的（无条件 copyFileSync 会 ENOENT）
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
  const backup = hadFile ? `${authPath}.bak-lead-${stamp}` : undefined
  if (backup !== undefined) fs.copyFileSync(authPath, backup)

  const tmp = `${authPath}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2))
  fs.renameSync(tmp, authPath)

  const after = JSON.parse(fs.readFileSync(authPath, 'utf8'))
  const missing = Object.keys(next).filter((k) => after[k] === undefined)
  const lost = Object.keys(kept).filter((k) => after[k] === undefined)
  if (missing.length > 0 || lost.length > 0) {
    throw new Error(`写回校验失败 —— 缺: ${missing.join(',')} / 丢: ${lost.join(',')}`)
  }
  return { changed, wrote: true, keys: Object.keys(next).length, removed, report, backup }
}

/**
 * 插件启动后的一次性对齐。
 *
 * 失败只记日志：账号格式、磁盘权限、并发写都可能出问题，但**绝不能因此**
 * 让插件加载失败或拖住第一次请求。
 */
export async function syncAuthQuietly({
  accounts,
  providers,
  idOf,
  authPath,
  failedProviders = [],
  log = () => {},
}) {
  // ⚠️ 这条闸门是**事故换来的**（2026-11-01）：测试用临时 home 起容器时账号集是
  // 空的/假的，而 `defaultAuthPath()` 读的是 `os.homedir()` —— 跑一次测试就把用户
  // 真实的 magpie 账号列表塌成 23 条占位。`syncAuthQuietly` 又把异常吞成日志，
  // 所以测试还是全绿，没人发现。
  if (process.env.JET_HUB_NO_AUTH_SYNC === '1') return null
  try {
    const r = syncPluginAuth({ accounts, providers, idOf, authPath, failedProviders })
    if (r.wrote) {
      log(
        `magpie 登录记录已对齐：${r.keys} 条（替换 ${r.removed.length} 条旧键）` +
          (r.backup ? `，备份 ${path.basename(r.backup)}` : ''),
      )
    }
    return r
  } catch (e) {
    log(`magpie 登录记录对齐失败（不影响使用）：${e?.message ?? e}`)
    return null
  }
}
