// 账号列表缓存 / 挑号失败 / 账号 id 归一 —— 三处 2026-10-30 修复的回归。
//
// 锁住的都是「静默走错账号」的同一类故障：用户以为自己钉了 A，实际走了 B，
// 而且界面上没有任何异常。三处修法各不相同，所以分三节测：
//   A) `listAccountsOf` 失败**不进缓存**（原先会把空数组缓存 15 秒）；
//   B) `authorize()` 挑了账号却找不到 ⇒ **抛错让用户重选**（原先 log 一行照样签入）；
//   C) `usage()` / `checkin()` 与 `loader()` 用**同一个** `dshAccountIdOf()` 认账号
//      （原先两处手写，`??` 与优先序都和 `dshAccountIdOf` 不一致）。
//
// 手法与 `t-new-account.mjs` 一致：从 `src/plugin.mjs` 截出被测段落用
// `new Function` 求值 —— 这样测的是**源码里真正跑的那段逻辑**，不是抄一份副本
// （抄副本的测试会在源码改坏时依然全绿，那才是最常见的假绿）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACCOUNT_INPUT } from '../src/plugin.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
// 必须归一化行尾：仓库在 Windows 上是 CRLF，而下面按 `\n` 拼标记。
const SRC = fs.readFileSync(path.join(ROOT, 'src/plugin.mjs'), 'utf8').replace(/\r\n/g, '\n')

let failed = 0
function ok(cond, name, extra = '') {
  if (cond) console.log(`✓ ${name}${extra ? ' — ' + extra : ''}`)
  else {
    failed += 1
    console.log(`✗ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

/** 按标记截取源码片段；标记找不到就直接失败（静默截空会让后面全绿）。 */
function slice(from, to) {
  const a = SRC.indexOf(from)
  const b = SRC.indexOf(to, a + from.length)
  if (a < 0) throw new Error(`源码里找不到标记起点：${JSON.stringify(from.slice(0, 60))}`)
  if (b < 0) throw new Error(`源码里找不到标记终点：${JSON.stringify(to.slice(0, 60))}`)
  return SRC.slice(a, b)
}

/**
 * 剥掉注释（保留字符串/模板里的内容）。
 *
 * 源码守卫必须先剥注释：修复说明里会原样引用「原先那种写法」，不剥就会把
 * 注释当成代码命中 —— 下面 C-8b 正是这么误报过一次。
 */
function stripComments(code) {
  let out = ''
  let i = 0
  let quote = null // 当前所处的引号：' / " / `
  while (i < code.length) {
    const c = code[i]
    const n = code[i + 1]
    if (quote !== null) {
      if (c === '\\') { out += c + (n ?? ''); i += 2; continue }
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

// ═══════════════════════════════════════════════════════════════════════════
// A) listAccountsOf：失败不缓存
// ═══════════════════════════════════════════════════════════════════════════
//
// 截 ACCOUNTS_TTL_MS → 新建账号大注释之间那段（含 accountsCache / listAccountsOf
// / accountById，三者只互相引用，可独立求值）。
const listSrc = slice('const ACCOUNTS_TTL_MS = 15_000', '/* ── 新建账号')
const listMod = new Function(`${listSrc}\nreturn { listAccountsOf, accountById, accountsCache, ACCOUNTS_TTL_MS }`)()

{
  const { listAccountsOf, accountById, accountsCache } = listMod

  // A-1 失败后紧接着重试：必须真的再问一次本体（若失败被缓存，第二次直接返 [])
  accountsCache.clear()
  let calls = 0
  let failing = true
  const container = {
    async rpc(method, payload) {
      calls += 1
      if (failing) throw new Error('本体还没起来')
      return { accounts: [{ id: 'acc-1', nickname: 'betsy030' }] }
    },
  }
  const rows1 = await listAccountsOf(container, 'workbuddy', null)
  ok(Array.isArray(rows1) && rows1.length === 0, 'A-1a 失败时返回空数组（不抛给调用方）')
  ok(!accountsCache.has('workbuddy'), 'A-1b 失败**不进**缓存（这是主修复点）')

  failing = false
  const rows2 = await listAccountsOf(container, 'workbuddy', null)
  ok(calls === 2, 'A-1c 失败后重试真的又调了一次 rpc', `calls=${calls}`)
  ok(rows2.length === 1 && rows2[0].id === 'acc-1', 'A-1d 重试拿到了账号（没被缓存空数组堵住）')

  // A-2 成功**要**缓存：第二次不再问本体
  calls = 0
  const rows3 = await listAccountsOf(container, 'workbuddy', null)
  ok(calls === 0, 'A-2a 成功后命中缓存，不再调 rpc', `calls=${calls}`)
  ok(rows3.length === 1, 'A-2b 缓存内容正确')

  // A-3 成功但确实没账号 ⇒ 也缓存（本体对聚合/路由组就是这么回的）
  accountsCache.clear()
  calls = 0
  const emptyC = { async rpc() { calls += 1; return { accounts: [] } } }
  await listAccountsOf(emptyC, 'aggregate', null)
  await listAccountsOf(emptyC, 'aggregate', null)
  ok(calls === 1, 'A-3 成功返回空账号时缓存生效（只问一次）', `calls=${calls}`)

  // A-4 accountById：空 id 不发请求；找不到返 undefined
  accountsCache.clear()
  calls = 0
  const found = await accountById(emptyC, 'aggregate', '', null)
  ok(found === undefined && calls === 0, 'A-4a 空 id 直接返 undefined，不发请求')
  const miss = await accountById(container, 'workbuddy', 'no-such-id', null)
  ok(miss === undefined, 'A-4b 找不到时返 undefined（交给 authorize 抛错）')
  const hit = await accountById(container, 'workbuddy', 'acc-1', null)
  ok(hit?.id === 'acc-1', 'A-4c 找得到时返那一条')
}

// ═══════════════════════════════════════════════════════════════════════════
// B) authorize()：挑了但找不到 ⇒ 抛错
// ═══════════════════════════════════════════════════════════════════════════
//
// 截「picked → hit → 抛错 → key」这一小段决策逻辑，注入假 accountById 求值。
// 不截整个 authorize()：它前面还有 `liveAll` / `refreshFullCatalog` 真网络调用。
{
  const blockSrc = slice(
    "const picked = String(inputs?.[ACCOUNT_INPUT] ?? '').trim()",
    '\n\n              return {',
  )
  const decide = new Function(
    'inputs', 'ACCOUNT_INPUT', 'accountById', 'container', 'dshProvider', 'log',
    `return (async () => {${blockSrc}\nreturn { picked, hit, key }})()`,
  )

  const fakeLookup = (row) => async () => row

  // B-1 挑了、池里有 ⇒ key 编进账号 id（钉号生效的前提）
  const r1 = await decide({ [ACCOUNT_INPUT]: 'acc-1' }, ACCOUNT_INPUT, fakeLookup({ id: 'acc-1' }), {}, 'workbuddy', null)
  ok(r1.key === 'jet-hub-local:workbuddy/acc-1', 'B-1 挑到账号时 key 里编进账号 id', r1.key)

  // B-2 没挑 ⇒ 老形状的标记 key（整家一个槽）
  const r2 = await decide({}, ACCOUNT_INPUT, fakeLookup(undefined), {}, 'workbuddy', null)
  ok(r2.key === 'jet-hub-local:workbuddy:direct', 'B-2 没挑时退回整家一个槽', r2.key)

  // B-3 挑了但找不到 ⇒ 必须抛错（主修复点），且错误里要能看出是哪个账号、该怎么办
  let err = null
  try {
    await decide({ [ACCOUNT_INPUT]: 'gone-9' }, ACCOUNT_INPUT, fakeLookup(undefined), {}, 'workbuddy', null)
  } catch (e) { err = e }
  ok(err instanceof Error, 'B-3a 挑了但找不到时抛错（不再静默走池内顺序）')
  ok(/gone-9/.test(String(err?.message)), 'B-3b 错误里带着那个账号 id', String(err?.message ?? '').slice(0, 60))
  ok(/重新点「连接」/.test(String(err?.message)), 'B-3c 错误里说了该怎么办')

  // B-4 空白字符串等同没挑（不能因为 magpie 回填空串就抛错）
  const r4 = await decide({ [ACCOUNT_INPUT]: '   ' }, ACCOUNT_INPUT, fakeLookup(undefined), {}, 'workbuddy', null)
  ok(r4.key === 'jet-hub-local:workbuddy:direct', 'B-4 纯空白按「没挑」处理')
}

// ═══════════════════════════════════════════════════════════════════════════
// C) dshAccountIdOf：三来源归一，且 usage/checkin 都用它
// ═══════════════════════════════════════════════════════════════════════════
{
  const idSrc = slice('function dshAccountIdOf(record, provider) {', '\n}\n') + '\n}'
  const { dshAccountIdOf } = new Function(`${idSrc}\nreturn { dshAccountIdOf }`)()

  // C-1 metadata 优先（宿主 save() 只落 metadata，这才是实际生效的那个）
  ok(dshAccountIdOf({ metadata: { dshAccountId: 'm-1' }, uid: 'u-1' }, 'workbuddy') === 'm-1',
    'C-1 metadata.dshAccountId 优先于 uid')

  // C-2 `uid: ''` 不得遮蔽 metadata —— 这是 `||` 与 `??` 的分水岭
  ok(dshAccountIdOf({ uid: '', metadata: { dshAccountId: 'm-2' } }, 'workbuddy') === 'm-2',
    "C-2 uid 为空串时不遮蔽 metadata（用 || 而非 ??）")

  // C-3 没有 metadata 时退回 uid（seed-auth 直接写 auth.json 的那种记录）
  ok(dshAccountIdOf({ uid: 'u-only' }, 'workbuddy') === 'u-only', 'C-3 退回 uid')

  // C-4 最后退路：key 尾巴
  ok(dshAccountIdOf({ key: 'jet-hub-local:workbuddy/acc-9' }, 'workbuddy') === 'acc-9',
    'C-4 退回 key 尾巴')

  // C-5 全都没有 ⇒ 空串；且 provider 必须对得上（别把别家的尾巴认成自己）
  ok(dshAccountIdOf({}, 'workbuddy') === '', 'C-5 三来源都没有时返空串')
  ok(dshAccountIdOf({ key: 'jet-hub-local:cline/acc-9' }, 'workbuddy') === '',
    'C-6 别家 provider 的 key 尾巴不认')
  ok(dshAccountIdOf({ key: 'jet-hub-local:workbuddy:direct' }, 'workbuddy') === '',
    'C-7 `:direct` 标记 key 不含账号 id，认成空串')

  // C-8 源码守卫：usage / checkin 里不能再出现手写的取值表达式
  const usageSrc = slice('async usage(getAuth) {', 'async checkin(getAuth) {')
  const checkinSrc = slice('async checkin(getAuth) {', 'provider: {')
  for (const [name, seg] of [['usage', usageSrc], ['checkin', checkinSrc]]) {
    const code = stripComments(seg)
    ok(/dshAccountIdOf\(account, dshProvider\)/.test(code), `C-8a ${name} 走 dshAccountIdOf`)
    ok(!/account\?\.uid \?\?/.test(code), `C-8b ${name} 没有手写的 \`?? uid\` 取值（那会和 dshAccountIdOf 分叉）`)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// D) 元测试：凡是会起容器的测试，都必须关掉「写地址文件」
// ═══════════════════════════════════════════════════════════════════════════
//
// 真实缺陷（2026-10-30 实测）：`~/.config/magpie/jet-hub-console.json` 属于**用户的
// magpie 实例**，测试跑完就退、绝不是它的所有者。单跑（不经 `scripts/test-all.mjs`，
// 那是第二道闸）时，容器抢到 18500 就会把用户文件改写 —— 实测 mtime 与 `at` 都被改。
// 判据取「导入了插件入口」：只有这些文件会调工厂、才会起容器。
{
  const TESTS = path.join(ROOT, 'tests')
  const files = fs.readdirSync(TESTS).filter((f) => f.endsWith('.mjs'))
  // 判据取「真的会调插件工厂」：`index.mjs` / `PLUGINS` / `JetHubXxxPlugin`。
  // 只导 `PROVIDER_IDS` 这类常量的文件（t-seed-auth）不起容器，不该算进来 ——
  // 判据放宽会把它们误报成缺失，逼人加不必要的开关。
  //
  // 必须先剥注释（本文件自己的说明里就写着 `PLUGINS`，不剥会把自己也算进去）。
  const startsContainer = (text) => {
    const code = stripComments(text)
    return /\bPLUGINS\b/.test(code)
      || /from '\.\.\/index\.mjs'/.test(code)
      || /\bJetHub[A-Za-z]+Plugin\b/.test(code)
  }
  const missing = []
  for (const f of files) {
    const text = fs.readFileSync(path.join(TESTS, f), 'utf8')
    if (!startsContainer(text)) continue
    // 判据要求**真的做了隔离**，不能只看提到这个名字 —— 注释里写「见 JET_HUB_NO_ADDR_FILE」
    // 也算提到，变异测试实测过：只匹配名字时把赋值删掉仍然全绿。
    //
    // 2026-10-30 扩展：隔离统一收口到 `tests/_iso.mjs` 之后，多数文件不再自己
    // 赋值，而是 `const iso = isolate()`（`_iso.mjs` 里一次性设了五个环境变量）。
    // 判据因此要认两种写法，否则这些文件会被误报成「没设开关」。
    if (!/process\.env\.JET_HUB_NO_ADDR_FILE\s*=/.test(text) && !/\bisolate\s*\(/.test(stripComments(text))) {
      missing.push(f)
    }
  }
  ok(missing.length === 0, 'D-1 每个会起容器的测试都做了隔离（直接赋值或 _iso.isolate()）', missing.join(', '))
}

if (failed > 0) {
  console.log(`\n✗ ${failed} 项失败`)
  process.exit(1)
}
console.log('\n✓ 全部通过')
