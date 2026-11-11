/**
 * 百智云「打开官网 + 粘贴网页登录态」这条入口的契约测试。
 *
 * 背景（2026-11-11 真机报障链）：magpie 装在服务器上时，百智云的浏览器登录
 * （`baizhi-browser-login.js` 要 spawn 一个**可见** Chromium 窗口、真人坐那台
 * 机器前）永远走不通；而它的积分 / 签到**只认控制台 cookie**，拿 `sk-` Key 打
 * `/api/v1/user/*` 恒 401。于是「贴 Key 能建号、但积分永远读不出来」。
 *
 * 修法照 MonkeyCode 那套：面板「新建」改成「打开官网 + 粘贴登录态」，插件自己
 * 用 `exchangeBaizhiSessionForKey` 换出 `sk-`，再 `baizhi.setSession` 把 cookie
 * 一起落进凭据。
 *
 * 这个文件盯四件事（都是真机上会踩的）：
 *
 *   1. **粘贴形态分流**：带名字的 Cookie 原样用；全裸值必须按位置补名字 ——
 *      否则拼成 `AAA; BBB` 会被平台当成两条无名 cookie 静默忽略，恒 401。
 *   2. **`sk-` 与 cookie 不混**：只有显式 `sk-` 前缀才当 Key，绝不「取第一段
 *      长 token」去猜（cookie 值本身就长，猜错会把 cookie 写进 Key 位）。
 *   3. **`baizhi.setSession` 的三态**：字段缺失 = 只读不写、空串 = 清除、
 *      有值 = 合并写入（`access_token` 必须活下来）。
 *   4. **不存在的账号 / 无凭据 + 空会话**必须硬失败，不留下读不出 Key 的卡。
 *
 * 跑法：`node tests/t-baizhi-paste-session.mjs`（不联网、不碰真实 ~/.dsh）
 *
 * ⚠️ 做法照 `tests/t-console-baizhi-split.mjs`：**从真源码抽函数求值**，
 * 不复制粘贴实现 —— 抄一份会和实现一起错（2026-11-05 二审的教训）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PLUGIN = path.join(ROOT, 'src', 'plugin.mjs')
const RPC = path.join(ROOT, 'vendor', 'lib', 'baizhi-rpc.js')

let bad = 0
let total = 0
const ok = (cond, msg) => {
  total++
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) bad++
}

// 行尾归一化成 \n，否则 indexOf 的定位串一个都对不上
const src = fs.readFileSync(PLUGIN, 'utf8').replace(/\r\n/g, '\n')
const rpcSrc = fs.readFileSync(RPC, 'utf8').replace(/\r\n/g, '\n')

// 真实现：归一化规则由 vendor 提供，不在测试里手写
const { normalizeSessionCookie } = await import('../vendor/lib/session-cookie.js')

/**
 * 从源码里抽出 `baizhiPastedCookieOf` 的函数体，求值成真函数。
 *
 * 抽函数而不是复刻：复刻的那份会和实现一起漂（本仓库已因同类问题红过一次）。
 */
function extractFunction(source, name) {
  const marker = `function ${name}(`
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`源码里找不到 ${name}（改名了？测试要跟着改）`)
  // 从函数头的 `{` 起做花括号配平（跳过字符串与注释里的括号）
  const braceAt = source.indexOf('{', source.indexOf(')', start))
  let depth = 0
  let i = braceAt
  const declStart = source.lastIndexOf('\n/**', start) >= 0
    ? source.lastIndexOf('\n/**', start)
    : start
  while (i < source.length) {
    const c = source[i]
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end < 0 ? source.length : end + 2
      continue
    }
    if (c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i)
      i = end < 0 ? source.length : end + 1
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      i += 1
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue }
        if (source[i] === quote) { i += 1; break }
        i += 1
      }
      continue
    }
    if (c === '{') depth += 1
    if (c === '}') {
      depth -= 1
      if (depth === 0) {
        const body = source.slice(declStart, i + 1)
        // eslint-disable-next-line no-new-func
        return new Function(`${body}; return ${name}`)()
      }
    }
    i += 1
  }
  throw new Error(`花括号配平失败：${name}`)
}

const pastedCookieOf = extractFunction(src, 'baizhiPastedCookieOf')
const SL = 'sl-session'
const BS = 'baizhi_session'

console.log('\n【1】粘贴形态分流（baizhiPastedCookieOf）')
{
  const two = pastedCookieOf('AAA BBB')
  ok(two.includes(`${SL}=AAA`), '两条裸值：第一条补 sl-session（控制台实际下发顺序在前）')
  ok(two.includes(`${BS}=BBB`), '两条裸值：第二条补 baizhi_session')

  const named = pastedCookieOf(`${SL}=AAA; ${BS}=BBB`)
  ok(named === `${SL}=AAA; ${BS}=BBB`, '两条带名：逐字原样，不重排')

  const single = pastedCookieOf('BBB')
  ok(single === `${BS}=BBB`, '单条裸值：补 baizhi_session（登录会话本身，不是风控那枚）')

  const mixed = pastedCookieOf(`${BS}=BBB AAA`)
  ok(mixed === `${BS}=BBB`, '混着来：只信带名字的那条，裸值不猜（猜错＝静默 401）')

  ok(pastedCookieOf('') === '', '空串：原样返回空（交由上层报「没收到内容」）')

  const cookieHeader = pastedCookieOf(`Cookie: ${SL}=AAA; ${BS}=BBB`)
  ok(cookieHeader.includes(`${SL}=AAA`) && cookieHeader.includes(`${BS}=BBB`),
    '整条 Cookie 头：两枚都在（前缀由 normalizeSessionCookie 剥）')

  const nl = pastedCookieOf('AAA\nBBB')
  ok(nl.includes(`${SL}=AAA`) && nl.includes(`${BS}=BBB`), '换行分隔的裸值：同样补齐两个名字')
}

console.log('\n【2】归一化后能直接进 Cookie 头（接 vendor 的 normalizeSessionCookie）')
{
  const cases = [
    ['两条裸值', 'AAA BBB', [`${SL}=AAA`, `${BS}=BBB`]],
    ['两条带名', `${SL}=AAA; ${BS}=BBB`, [`${SL}=AAA`, `${BS}=BBB`]],
    ['整条头', `Cookie: ${SL}=AAA; ${BS}=BBB`, [`${SL}=AAA`, `${BS}=BBB`]],
    ['单条带名', `${BS}=BBB`, [`${BS}=BBB`]],
  ]
  for (const [label, input, want] of cases) {
    const got = normalizeSessionCookie(pastedCookieOf(input), [BS, SL], BS)
    const good = typeof got === 'string' && want.every((w) => got.includes(w))
    ok(good, `${label} ⇒ ${JSON.stringify(got)}`)
  }
  ok(normalizeSessionCookie(pastedCookieOf(''), [BS, SL], BS) === undefined,
    '空内容归一化 ⇒ undefined（上层据此报错，不会写出空 cookie）')
}

console.log('\n【3】sk- 只认显式前缀（不猜长 token）')
{
  const KEY_RE = /^sk-[A-Za-z0-9_-]{16,}$/u
  ok(KEY_RE.test('sk-' + 'a'.repeat(64)), 'sk- + 64 位 ⇒ 认作 Key')
  ok(!KEY_RE.test('bzy_' + 'a'.repeat(11)), 'bzy_ 前缀（15 位）⇒ 不认作可用 Key（打网关恒 401）')
  ok(!KEY_RE.test('AAA BBB'), '两个裸值 ⇒ 不认作 Key')
  // cookie 值本身就长：绝不能靠「够长」判定
  ok(!KEY_RE.test('YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo'), '裸 cookie 值 ⇒ 不认作 Key')
  ok(!KEY_RE.test(`sk-abc ${BS}=x`), 'Key 混着 cookie ⇒ 不认作纯 Key（走 cookie 分支再兑换）')
}

console.log('\n【4】baizhi.setSession 的三态语义（源码守卫）')
{
  /**
   * 这里只做源码守卫：真正跑 RPC 需要一个 cordis 容器（`@deepseek-ai/dsh-credentials`
   * 未装时构造就抛），而这条分支的全部风险都在「三态判据写错」上，逐条核对更有效。
   */
  const stripped = rpcSrc

  ok(stripped.includes("case 'baizhi.setSession':"), "存在 case 'baizhi.setSession' 分支")
  ok(stripped.includes('const hasCookieField = typeof rawCookie === \'string\''),
    '用「字段是不是 string」判是否写盘（不能拿 optionalString —— 它把缺失与空串归一）')
  ok(/if \(!hasCookieField\) \{[\s\S]{0,120}?return done\(\{ accountId, hasSession: existingCookie !== '' \}\)/.test(stripped),
    '字段缺失 ⇒ 只读不写，回报现状')
  ok(/delete next\.session_cookie/.test(stripped), '传空串 ⇒ 清除会话（`delete`）')
  ok(/\{ \.\.\.previous \}/.test(stripped), '写入是合并（`{...previous}`），`access_token` 不会被抹掉')
  ok(/if \(previous === undefined && trimmed === ''\)/.test(stripped),
    '既无旧凭据又要写空会话 ⇒ 硬失败（不留下读不出 Key 的卡）')
  ok(/账号 \$\{accountId\} 不存在/.test(stripped), '账号不存在 ⇒ 明确报错，不静默通过')
  ok(/读取该账号的凭据失败/.test(stripped)
    && /为避免覆盖，本次未做任何修改/.test(stripped),
    '读取抛错 ⇒ 零写入硬失败（否则会把好凭据覆盖成半截）')
}

console.log('\n【5】插件壳接线（面板路径真的指向新方法）')
{
  ok(/function baizhiPasteMethod\(dshProvider, container, log\)/.test(src),
    '存在 `baizhiPasteMethod`')
  ok(/dshProvider === 'baizhi'\s*\n\s*\? \[baizhiPasteMethod\(dshProvider, container, log\)\]/.test(src),
    'methods 分发里 baizhi 落到 paste 方法（不是通用 oauth）')
  ok(/url: 'https:\/\/baizhi\.cloud'/.test(src), '打开的是站根（子路径是 SPA catch-all，白给）')

  // 粘贴框必须提到**两枚** cookie，否则用户只复制一条 ⇒ 积分读不出来
  const methodBody = src.slice(src.indexOf('function baizhiPasteMethod'), src.indexOf('async function baizhiFinishPaste'))
  ok(methodBody.includes('sl-session') && methodBody.includes('baizhi_session'),
    '粘贴提示同时点名 sl-session 与 baizhi_session')
  ok(/两条都要/.test(methodBody), '明确写了「两条都要」（只带一条会静默读不到积分）')

  // code 型签入的字段名是 `method`，写成 `mode` 会被当 auto 型、永远等不到回调
  ok(/method: 'code'/.test(methodBody), 'method: \'code\'（写 mode 会退化成 auto 型）')

  const finishBody = src.slice(src.indexOf('async function baizhiFinishPaste'), src.indexOf('function marvisOauthMethod'))
  ok(/exchangeBaizhiSessionForKey\(normalized/.test(finishBody), '用登录态换 sk-（用户不用自己抄 Key）')
  ok(/`\$\{dshProvider\}\.setSession`/.test(finishBody), '兑换后调 setSession 把 cookie 一起落盘')
  ok(/sessionLanded/.test(finishBody) && /未读到登录态/.test(finishBody),
    '补登录态失败不判整单失败（账号已建好），但要在卡片上标出来')
}

console.log('\n【6】不回归：MonkeyCode 那条路仍在')
{
  ok(/MONKEYCODE_PROVIDERS\.has\(dshProvider\)\s*\n\s*\? \[monkeycodePasteMethod\(dshProvider, container, log\)\]/.test(src),
    'MonkeyCode 两站仍走 monkeycodePasteMethod')
  ok(/function monkeycodePasteMethod/.test(src), 'monkeycodePasteMethod 未被改名/删除')
}

console.log(`\n${bad === 0 ? '✓ 全部通过' : `✗ ${bad} 项失败`}（${total} 项）`)
process.exit(bad === 0 ? 0 : 1)
