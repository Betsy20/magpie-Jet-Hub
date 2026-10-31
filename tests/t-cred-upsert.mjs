// credentials.set() 必须能新增 ref —— 2026-10-30 真机报障回归
//
// 报障：超级麦吉网页登录成功，插件却一直显示「请在浏览器中完成登录」。
// 根因：本体给新账号写凭据用全新 ref（MAGICREW_ACCOUNT_963C771C 这种随机名），
// 而 FileCredentialProvider.set() 原来只走 writeRefsInto（只改已存在的 ref，
// 找不到就抛「未找到要更新的 ref」）。那条错把 account.create 整个打断：
// 占位留在池里、凭据没落地、login.poll 永远 done:false ⇒ magpie 卡在 waiting。
//
// 本测试守四件事：
//   ① set 一个全新 ref 必须成功，且真的落盘可 resolve；
//   ② 重复 set 同一个 ref 是更新、不是追加；
//   ③ unset 一个不存在的 ref 不能凭空造出空记录；
//   ④ 写入不许碰其它 ref（一个字节都不能变）。
//
// 2026-10-31 审查又抓出两个「本轮新引入」的退化，⑬⑭ 两节守它们：
//   ⑤ `parseRefs` 漏解的形态（裸 key 无值 `KEY:`、块标量 `KEY: |-`）不能被当成
//      「不存在」——否则 upsertRefsInto 会追加一条同名 key，落盘出现重复 key，
//      本体 yaml（uniqueKeys: true）报 `Map keys must be unique`，**整份凭据
//      文件读不了**（HEAD 只是这一条改不动、抛错不写，比整文件拒绝轻得多）。
//   ⑥ 块标量 ref 必须整块替换；只换首行会留下孤儿续行，本体同样拒绝整份文件。

import { FileCredentialProvider, parseRefs, scanRefKeys } from '../src/credentials.mjs'
import { chmodSync, copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// 本体校验凭据文件用的就是 yaml 的 `parseDocument(..., {uniqueKeys: true})`。
// 这里引同一个包来断言「插件写完的文件本体读得动」—— 光看内容对不够：上一轮
// 就是内容对、语法坏（孤儿续行 / 重复 key），本体整份拒绝，比改不动更糟。
// createRequire 的锚点必须是**文件**路径（传目录会 MODULE_NOT_FOUND）；
// 用 package.json 当锚点，解析起点就是那个 node_modules。
const YAML = createRequire(join(homedir(), '.dsh', 'profiles', 'desktop', 'package.json'))('yaml')
const yamlErrors = (text) =>
  YAML.parseDocument(text, { prettyErrors: true, uniqueKeys: true }).errors.map((e) => e.message)

// ⑩ 要从源码里切 `renameInto`（未导出）来验它的退避方式
const CRED_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'credentials.mjs')

let total = 0
let bad = 0
function ok(cond, message) {
  total++
  if (cond) console.log(`  ✓ ${message}`)
  else { bad++; console.log(`  ✗ ${message}`) }
}

// 「这份文件本体还读得动吗」—— 写盘类断言都要过这一关
function okYaml(text, message) {
  const errs = yamlErrors(text)
  ok(errs.length === 0, `${message}${errs.length ? `（实际 ${JSON.stringify(errs.slice(0, 2))}）` : ''}`)
}

// Service 基类要 ctx.reflect.provide，最小假 ctx 就够
const fakeCtx = { reflect: { provide: () => {} } }

const dir = mkdtempSync(join(tmpdir(), 'cred-upsert-'))
const file = join(dir, '.credentials.yaml')

// 夹具：单行 ref / 多行 ref / 最后一个 ref 是跨行的（最容易被插错位置）
const FIXTURE = [
  'refs:',
  "  PLAIN_ONE: '{\"a\":1}'",
  "  MULTI_LINE: '{\"token\":\"line1",
  '    line2',
  "    line3\"}'",
  "  TAIL_PLAIN: '{\"b\":2}'",
  '  BARE_SCALAR: plain-value-no-quotes',
  'records:',
  '  something: 1',
  '',
].join('\n')
writeFileSync(file, FIXTURE, 'utf8')

const p = new FileCredentialProvider(fakeCtx, { file })

// ① 全新 ref
await p.set('MAGICREW_ACCOUNT_TEST0001', '{"jwt":"abc"}')
const afterAdd = readFileSync(file, 'utf8')
ok(parseRefs(afterAdd).has('MAGICREW_ACCOUNT_TEST0001'), '① set 全新 ref 成功落盘')
ok((await p.resolve('MAGICREW_ACCOUNT_TEST0001'))?.value === '{"jwt":"abc"}', '① 新 ref 立刻能 resolve')
ok(parseRefs(afterAdd).size === 5, '① refs 数从 4 变成 5（没有多写）')
ok(/^records:/m.test(afterAdd), '① records: 段还在')
ok(afterAdd.includes('  something: 1'), '① records 段的内容没被动')

// ② 重复 set = 更新
await p.set('MAGICREW_ACCOUNT_TEST0001', '{"jwt":"def"}')
const afterUpd = readFileSync(file, 'utf8')
ok(parseRefs(afterUpd).size === 5, '② 重复 set 不追加（refs 仍 5 条）')
ok((await p.resolve('MAGICREW_ACCOUNT_TEST0001'))?.value === '{"jwt":"def"}', '② 值被更新成新值')

// ③ unset 不存在的 ref 不能造记录
await p.unset('NO_SUCH_REF_AT_ALL')
const afterUnsetMissing = readFileSync(file, 'utf8')
ok(parseRefs(afterUnsetMissing).size === 5, '③ unset 不存在的 ref 不新增记录')
ok(!afterUnsetMissing.includes('NO_SUCH_REF_AT_ALL'), '③ 文件里没留下那个名字')

// ④ 其它 ref 一个字节都不能变
const before = parseRefs(FIXTURE)
const after = parseRefs(afterUnsetMissing)
let changed = 0
for (const [k, v] of before) if (after.get(k) !== v) changed++
ok(changed === 0, `④ 原有 4 个 ref 的值全都没变（实际变了 ${changed} 个）`)
ok(afterUnsetMissing.includes("  TAIL_PLAIN: '{\"b\":2}'"), '④ 跨行 ref 之后的那条仍在原位')

// ⑤ 跨行 ref 之后再新增：不能插进多行标量中间
await p.set('AFTER_MULTILINE', '{"c":3}')
const afterMulti = readFileSync(file, 'utf8')
ok(parseRefs(afterMulti).get('MULTI_LINE')?.includes('line3'), '⑤ 跨行 ref 的完整值没被切断')
ok(parseRefs(afterMulti).size === 6, '⑤ 新增后共 6 条')

// ⑥ unset 已存在的 ref 是**整条删掉 key**（与本体契约一致：本体 set 明确拒绝空值、
//    unset 是 deleteSectionEntry；写 `KEY: ''` 会在文件里留一条空壳记录）
await p.unset('PLAIN_ONE')
ok((await p.resolve('PLAIN_ONE')) === undefined, '⑥ unset 后 resolve 返回 undefined')
ok(!parseRefs(readFileSync(file, 'utf8')).has('PLAIN_ONE'), '⑥ 记录被整条删掉（不留空值壳）')
ok(!readFileSync(file, 'utf8').includes('PLAIN_ONE'), '⑥ 文件里连 key 名都不剩')


// ⑧ 裸标量 ref（ 没引号）也必须能更新。
//    2026-10-30 实测真缺陷：writeRefsInto 原来只处理带引号的值，遇到裸标量
//    既不写新值也不标 done，收尾就抛「未找到要更新的 ref」。本机 .credentials.yaml
//    里 64 个 ref 有 3 个是裸标量（DEEPSEEK_API_KEY / MAGPIE_GATEWAY_KEY /
//    DSH_QQBOT_APP_SECRET_…），它们永远改不了 —— 而 DEEPSEEK_API_KEY 正是
//    运行时会被续期改写的那类。
let bareErr
try { await p.set('BARE_SCALAR', 'new-plain-value') } catch (e) { bareErr = e }
ok(bareErr === undefined, `⑧ 裸标量 ref 的 set 没抛错${bareErr ? `（实际抛了：${bareErr.message}）` : ''}`)
const afterBare = readFileSync(file, 'utf8')
ok((await p.resolve('BARE_SCALAR'))?.value === 'new-plain-value', '⑧ 裸标量 ref 能被 set 更新')
ok(parseRefs(afterBare).size === 5, `⑧ 更新裸标量不新增记录（实际 ${parseRefs(afterBare).size}）`)
ok(afterBare.includes("BARE_SCALAR: 'new-plain-value'"), '⑧ 裸标量被写成带引号形态（值里有特殊字符也安全）')

// ⑦ 写入失败时不许留下 .tmp-* 垃圾（真机踩过：并发续期 rename 撞 EPERM，
//    临时文件积在 %USERPROFILE%\.dsh 里没人清）
{
  const { readdirSync } = await import('node:fs')
  const leftovers = readdirSync(dir).filter((n) => n.includes('.tmp-'))
  ok(leftovers.length === 0, `⑦ 目录里没有残留的 .tmp-* 文件（实际 ${leftovers.length} 个）`)
}

// ⑨ unset 判存在性必须看**文件**，不能看进程内缓存。
//    2026-10-30 实测真缺陷：`unset` 原来用 `this._refs.has(name)` 早退，而 `_refs`
//    只在第一次 `_load()` 时填一次。每个 provider 容器各有一个 FileCredentialProvider
//    实例，A 实例写的 ref 对 B 实例的缓存不可见；用户手改文件同理。缓存过期时
//    `unset` 会误判「不存在」直接 return，调用方（account-pool 的 removeAccount、
//    magicrew/officeace 判重命中后回收临时 ref）指望它清值 —— 漏掉就是永不清除的孤儿凭据。
//    复现：先 resolve 一次把缓存填满，再往文件里补一条新 ref，然后 unset 它。
{
  const dir2 = mkdtempSync(join(tmpdir(), 'cred-stale-'))
  const file2 = join(dir2, '.credentials.yaml')
  writeFileSync(file2, `refs:\n  KNOWN: 'one'\n\nrecords:\n  x: 1\n`, 'utf8')
  const p2 = new FileCredentialProvider({ reflect: { provide: () => {} } }, { file: file2 })
  await p2.resolve('KNOWN') // 填缓存：此时缓存里只有 KNOWN
  // 模拟「另一个实例 / 用户手改」往文件里加了 LATE
  writeFileSync(file2, readFileSync(file2, 'utf8').replace("  KNOWN: 'one'", "  KNOWN: 'one'\n  LATE: 'two'"), 'utf8')
  await p2.unset('LATE')
  ok(!readFileSync(file2, 'utf8').includes('LATE'), '⑨ 缓存里没有、文件里有的 ref 也能被 unset 删掉')
  ok(parseRefs(readFileSync(file2, 'utf8')).size === 1, `⑨ unset 后只剩 KNOWN（实际 ${parseRefs(readFileSync(file2, 'utf8')).size} 条）`)
  ok(parseRefs(readFileSync(file2, 'utf8')).get('KNOWN') === 'one', '⑨ 相邻的 KNOWN 没被误删')
  rmSync(dir2, { recursive: true, force: true })
}

// ⑩ rename 的 EPERM 重试必须**异步**退避，不能用 `Atomics.wait` 同步阻塞。
//    2026-10-30 自查真缺陷：这个函数跑在本体容器的 HTTP 网关进程里，一次 set 最坏
//    退避 10+20+40+80+160+320 = 630 ms，同步阻塞会把整个网关（所有 provider 的请求、
//    控制台 RPC）一起卡住 0.6 秒。这里用「退避期间事件循环还能转」来守它。
{
  const src = readFileSync(CRED_SRC, 'utf8')
  const at = src.indexOf('async function renameInto(')
  ok(at > 0, '⑩ renameInto 是 async 函数')
  const LF = String.fromCharCode(10)
  const end = src.indexOf(LF + '}' + LF, at)
  ok(end > at, '⑩ 能切出 renameInto 的函数体')
  const fnSrc = src.slice(at, end + 3)
  ok(!fnSrc.includes('Atomics.wait'), '⑩ renameInto 里没有 Atomics.wait 同步阻塞')
  ok(fnSrc.includes('await new Promise'), '⑩ renameInto 用 await + setTimeout 退避')
  // 行为级：真跑一次「每次都 EPERM」的 renameInto，数退避期间事件循环转了几圈。
  // rmSync 必须传真的（原来传 `() => {}` ⇒「失败时删临时文件」从未真实执行，审查指出）。
  const { renameSync: realRename, rmSync: realRm } = await import('node:fs')
  const { renameInto } = new Function(
    'renameSync', 'rmSync', 'setTimeout',
    fnSrc + LF + 'return { renameInto }',
  )(() => { throw Object.assign(new Error('busy'), { code: 'EPERM' }) }, realRm, setTimeout)
  // 造一个真临时文件，验证重试耗尽后它被真删掉
  const tmpDir = mkdtempSync(join(tmpdir(), 'rename-'))
  const from = join(tmpDir, 'a.tmp')
  const to = join(tmpDir, 'b')
  writeFileSync(from, 'x', 'utf8')
  let ticks = 0
  const timer = setInterval(() => { ticks += 1 }, 5)
  let err
  try { await renameInto(from, to) } catch (e) { err = e }
  clearInterval(timer)
  ok(err?.code === 'EPERM', '⑩ 重试耗尽后把原始 EPERM 抛出来')
  ok(ticks > 10, `⑩ 退避期间事件循环仍在跑（转了 ${ticks} 次）`)
  const { existsSync } = await import('node:fs')
  ok(!existsSync(from), '⑩ 重试耗尽后临时文件被真删掉（不积 .tmp-* 垃圾）')
  rmSync(tmpDir, { recursive: true, force: true })
}

// ⑪ 裸标量分支必须折叠换行，否则会吞掉相邻的 ref。
//    2026-10-30 审查发现真缺陷：只转义单引号、不折换行时，值里的真换行让写出的
//    单引号标量跨行，后续行被 parseRefs 当续行折叠 —— 紧随其后的真实凭据整条消失。
//    上游 `vendor/lib/backup.js:506` 原样写入备份里的字符串，换机导入就会带真换行。
{
  const dir3 = mkdtempSync(join(tmpdir(), 'cred-nl-'))
  const file3 = join(dir3, '.credentials.yaml')
  writeFileSync(file3,
    "refs:\n  BARE: plain\n  NEXT_TOKEN: '{\"a\":1}'\n  AFTER: '{\"b\":2}'\n\nrecords:\n  x: 1\n", 'utf8')
  const p3 = new FileCredentialProvider({ reflect: { provide: () => {} } }, { file: file3 })
  await p3.set('BARE', "evil\n  NEXT_TOKEN: 'PWNED'")
  const text3 = readFileSync(file3, 'utf8')
  const refs3 = parseRefs(text3)
  ok(refs3.get('NEXT_TOKEN') === '{"a":1}', '⑪ 换行值不吞掉紧随其后的 ref（NEXT_TOKEN 完好）')
  ok(refs3.get('AFTER') === '{"b":2}', '⑪ 换行值不吞掉更后面的 ref（AFTER 完好）')
  ok(refs3.size === 3, `⑪ refs 仍是 3 条（实际 ${refs3.size}）`)
  // 2026-10-31 三审改口径：值里的换行不再折成空格，而是写**块标量**保住它。
  // 折成空格会把 PEM 私钥、多行 JSON 悄悄改掉，而 yaml 依然合法、校验看不出来 ——
  // 比写坏文件更难发现。所以这里断言的是「值原样保住 + 相邻 ref 完好 + 文件合法」。
  ok(refs3.get('BARE') === "evil\n  NEXT_TOKEN: 'PWNED'", `⑪ 换行值原样保住（实际 ${JSON.stringify(refs3.get('BARE'))}）`)
  // 这个值第二行以两个空格开头，块标量保不住行首缩进（写出去会被当成统一缩进切掉），
  // 所以 refLines 对它退回双引号 + 转义 —— 判据是「不许写成跨行单引号标量」。
  ok(/^  BARE: "/m.test(text3), '⑪ 含行首空白的换行值写成双引号（不是跨行单引号标量）')
  okYaml(text3, '⑪ 写完块标量后文件仍是本体合法文档')
  // 孤立 \r（老式 Mac 换行 / 手改过的备份）不能原样落盘 —— 裸 \r 会让
  // parseRefs 的 split(/\r?\n/) 把整行当一行。现在 refLines 对它退回双引号
  // 并把 \r 转义成 `\\r` 两个字符，所以值本身无损、文件里也没有裸 CR。
  await p3.set('BARE', 'sk-abc\rdef')
  const refs3b = parseRefs(readFileSync(file3, 'utf8'))
  ok(refs3b.get('BARE') === 'sk-abc\rdef', `⑪ 含 \\r 的值原样读回（实际 ${JSON.stringify(refs3b.get('BARE'))}）`)
  ok(!readFileSync(file3, 'utf8').includes('\r'), '⑪ 文件里没残留裸 \\r（转义成 \\r 两个字符）')
  ok(refs3b.size === 3, `⑪ 写含 \\r 的值后 refs 仍 3 条（实际 ${refs3b.size}）`)
  rmSync(dir3, { recursive: true, force: true })
}

// ⑫ 并发 set 不许丢更新。
//    2026-10-30 审查发现真缺陷：set 是「读 → 改 → await renameInto」，那个 await 之后
//    写回的是 await 之前读到的旧快照；两条并发 set 各自读同一份旧文件，后落盘的把
//    先落盘的新 ref 整条抹掉。真机上「后台续 token + 用户点连接」就是这么撞的。
{
  const dir4 = mkdtempSync(join(tmpdir(), 'cred-race-'))
  const file4 = join(dir4, '.credentials.yaml')
  writeFileSync(file4, "refs:\n  SEED: 'zero'\n\nrecords:\n  x: 1\n", 'utf8')
  const p4a = new FileCredentialProvider({ reflect: { provide: () => {} } }, { file: file4 })
  const p4b = new FileCredentialProvider({ reflect: { provide: () => {} } }, { file: file4 })
  // 两个实例（模拟两家 provider 各持一个）同时写不同的新 ref
  await Promise.all([p4a.set('RACE_A', '{"v":1}'), p4b.set('RACE_B', '{"v":2}')])
  const refs4 = parseRefs(readFileSync(file4, 'utf8'))
  ok(refs4.get('RACE_A') === '{"v":1}', '⑫ 并发 set：A 的新 ref 没被 B 覆盖掉')
  ok(refs4.get('RACE_B') === '{"v":2}', '⑫ 并发 set：B 的新 ref 也落地了')
  ok(refs4.get('SEED') === 'zero', '⑫ 并发 set：原有 ref 未被破坏')
  ok(refs4.size === 3, `⑫ 并发后共 3 条（实际 ${refs4.size}）`)
  // 更密的一轮：同一实例连发 5 条
  await Promise.all([1, 2, 3, 4, 5].map((n) => p4a.set(`BURST_${n}`, `v${n}`)))
  const refs5 = parseRefs(readFileSync(file4, 'utf8'))
  const got5 = [1, 2, 3, 4, 5].filter((n) => refs5.get(`BURST_${n}`) === `v${n}`).length
  ok(got5 === 5, `⑫ 同一实例并发 5 条全部落地（实际 ${got5}/5）`)
  rmSync(dir4, { recursive: true, force: true })
}

// ── ⑬ parseRefs 漏解形态不许写出重复 key ────────────────────────────────
// 用本体真实会写出来的两种形态做夹具：双引号空值 `KEY: ""`（yaml 序列化空串
// 就是它）、裸 key 无值 `KEY:`。再加块标量 `KEY: |-`。
{
  const Q = String.fromCharCode(39)
  const DQ = String.fromCharCode(34)
  // 数 refs 段里每个 key 出现几次（不看 parseRefs，直接看文本）
  const countKeys = (text) => {
    const counts = {}
    let inRefs = false
    for (const l of text.split('\n')) {
      if (/^refs:\s*$/.test(l)) { inRefs = true; continue }
      if (!inRefs) continue
      if (/^\s*records:\s*$/.test(l) || /^[A-Za-z_]+\s*:\s*$/.test(l)) break
      const m = /^ {2}([A-Za-z0-9_#.\-{}]+):/.exec(l)
      if (m) counts[m[1]] = (counts[m[1]] || 0) + 1
    }
    return counts
  }
  // ⚠️ 夹具必须用 **parseRefs 真的会漏解** 的形态，否则「把 scanRefKeys 换回
  // parseRefs」这个变异照样全绿（2026-10-31 二审实测抓不到就是这个原因：
  // `KEY: ""`、裸 key、`KEY: |-` 三种 parseRefs 现在都能解出来了）。
  // 第一个夹具是本体真会写出的「双引号值以反斜杠结尾」形态：值 `C:\` 落盘成
  // `BS: "C:\\"`，行尾是 `\"` —— isClose 判不闭合，一路往下吞掉 VICTIM 与 A。
  const cases = [
    ['双引号值以反斜杠结尾（parseRefs 真漏解）', `  BS: ${DQ}C:\\${DQ}\n  VICTIM: ${Q}{"v":0}${Q}\n  A: ${Q}a${Q}`],
    ['双引号空值', `  VICTIM: ${DQ}${DQ}\n  A: ${Q}a${Q}`],
    ['裸 key 无值', '  VICTIM:\n  A: ' + Q + 'a' + Q],
    ['块标量', `  A: ${Q}a${Q}\n  VICTIM: |-\n    line1\n    line2`],
  ]
  for (const [label, body] of cases) {
    const d13 = mkdtempSync(join(tmpdir(), 'cred-dup-'))
    const f13 = join(d13, '.credentials.yaml')
    writeFileSync(f13, `version: 1\nrefs:\n${body}\n\nrecords:\n  k: 1\n`, 'utf8')
    const p13 = new FileCredentialProvider(fakeCtx, { file: f13 })
    let err13 = null
    try { await p13.set('VICTIM', '{"v":1}') } catch (e) { err13 = e.message }
    const text13 = readFileSync(f13, 'utf8')
    const counts13 = countKeys(text13)
    ok(err13 === null, `⑬ ${label}：set 没抛错（实际 ${err13}）`)
    ok((counts13.VICTIM ?? 0) === 1, `⑬ ${label}：VICTIM 只出现 1 次（实际 ${counts13.VICTIM ?? 0}）`)
    // scanRefKeys 必须认得出所有形态（这是「在不在」判据的来源）
    ok(scanRefKeys(text13).has('VICTIM'), `⑬ ${label}：scanRefKeys 认得出 VICTIM`)
    // 落盘必须是本体读得动的文档 —— 这是本节的真正目的
    okYaml(text13, `⑬ ${label}：落盘仍是本体合法文档`)
    // VICTIM 的新值必须能被本体读到（不看 parseRefs：漏解夹具上它本来就读不全）
    const js13 = YAML.parseDocument(text13, { uniqueKeys: true }).toJS()
    ok(js13?.refs?.VICTIM === '{"v":1}', `⑬ ${label}：本体读到 VICTIM 的新值`, JSON.stringify(js13?.refs?.VICTIM))
    rmSync(d13, { recursive: true, force: true })
  }
}

// ── ⑭ 块标量 ref 必须整块替换（不留孤儿续行）─────────────────────────────
{
  const Q = String.fromCharCode(39)
  const hasOrphan = (text) => {
    // refs 段里出现缩进 >= 4 的行 ⇒ 孤儿续行（块标量已被替换掉后不该再有）
    let inRefs = false
    for (const l of text.split('\n')) {
      if (/^refs:\s*$/.test(l)) { inRefs = true; continue }
      if (!inRefs) continue
      if (/^\s*records:\s*$/.test(l) || /^[A-Za-z_]+\s*:\s*$/.test(l)) break
      if (/^ {4,}\S/.test(l)) return true
    }
    return false
  }
  const BLOCK = `  B: ${Q}b${Q}\n  A: |-\n    line1\n    line2`

  // (a) 追加新 ref：必须插在整块之后，不能插进块头与续行之间
  const d14 = mkdtempSync(join(tmpdir(), 'cred-blk-'))
  const f14 = join(d14, '.credentials.yaml')
  writeFileSync(f14, `version: 1\nrefs:\n${BLOCK}\n\nrecords:\n  k: 1\n`, 'utf8')
  const p14 = new FileCredentialProvider(fakeCtx, { file: f14 })
  await p14.set('NEW_REF', '{"n":1}')
  const t14 = readFileSync(f14, 'utf8')
  const lines14 = t14.split('\n')
  const aIdx = lines14.findIndex((l) => /^ {2}A: \|-/.test(l))
  const newIdx = lines14.findIndex((l) => /^ {2}NEW_REF:/.test(l))
  ok(aIdx >= 0 && newIdx > aIdx, '⑭ 追加的新 ref 在块标量之后')
  ok(/^ {4}line1$/.test(lines14[aIdx + 1] ?? ''), '⑭ 块标量的续行紧跟在块头后面')
  ok(parseRefs(t14).get('A') === 'line1\nline2', '⑭ 块标量值完整（line1\\nline2）')
  rmSync(d14, { recursive: true, force: true })

  // (b) set 块标量 ref 自身：整块换成单行标量，不留续行
  const d14b = mkdtempSync(join(tmpdir(), 'cred-blk2-'))
  const f14b = join(d14b, '.credentials.yaml')
  writeFileSync(f14b, `version: 1\nrefs:\n${BLOCK}\n\nrecords:\n  k: 1\n`, 'utf8')
  const p14b = new FileCredentialProvider(fakeCtx, { file: f14b })
  await p14b.set('A', '{"new":1}')
  const t14b = readFileSync(f14b, 'utf8')
  ok(!hasOrphan(t14b), '⑭ set 块标量 ref 后没有孤儿续行')
  ok(parseRefs(t14b).get('A') === '{"new":1}', '⑭ set 后 A 是新值')
  ok(parseRefs(t14b).get('B') === 'b', '⑭ set 后相邻的 B 没被破坏')
  rmSync(d14b, { recursive: true, force: true })

  // (c) unset 块标量 ref：同样不留续行
  const d14c = mkdtempSync(join(tmpdir(), 'cred-blk3-'))
  const f14c = join(d14c, '.credentials.yaml')
  writeFileSync(f14c, `version: 1\nrefs:\n${BLOCK}\n\nrecords:\n  k: 1\n`, 'utf8')
  const p14c = new FileCredentialProvider(fakeCtx, { file: f14c })
  await p14c.unset('A')
  const t14c = readFileSync(f14c, 'utf8')
  ok(!hasOrphan(t14c), '⑭ unset 块标量 ref 后没有孤儿续行')
  ok(parseRefs(t14c).get('B') === 'b', '⑭ unset 后相邻的 B 没被破坏')
  rmSync(d14c, { recursive: true, force: true })
}

// ── ⑯ unset 整条删 key 时不许留下孤儿续行 ────────────────────────────────
// 本体契约：set 拒绝空值、unset 是 deleteSectionEntry（整条删）。插件原来写
// `KEY: ''`，语义等价但会在文件里留空壳记录。改成删 key 之后，删的时候必须
// 把跨行标量 / 块标量的续行一起吃掉，否则续行成了孤儿 ⇒ 本体 yaml 报
// `All mapping items must start at the same column`，整份文件读不了。
{
  const Q = String.fromCharCode(39)
  const hasOrphan = (text) => {
    let inRefs = false
    for (const l of text.split('\n')) {
      if (/^refs:\s*$/.test(l)) { inRefs = true; continue }
      if (!inRefs) continue
      if (!/^\s/.test(l) && /^[^:\s][^:]*:(\s|$)/.test(l)) break
      if (/^ {4,}\S/.test(l)) return true
    }
    return false
  }

  // 第三个元素是「删掉之后不许在文件里残留」的正文片段。
  // 为什么需要它：跨行标量的续行只缩进 2 空格，hasOrphan 的 `/^ {4,}/` 抓不到，
  // 只靠孤儿行判据会让「不吞引号续行」这个变异假绿（实测过）。
  const cases = [
    ['跨行单引号标量', `  B: ${Q}b${Q}\n  V: '{\n  "k": "v"\n  }'\n  C: ${Q}c${Q}`, ['"k": "v"', "}'"]],
    ['块标量', `  B: ${Q}b${Q}\n  V: |-\n    line1\n    line2\n  C: ${Q}c${Q}`, ['line1', 'line2']],
    ['单行', `  B: ${Q}b${Q}\n  V: ${Q}v${Q}\n  C: ${Q}c${Q}`, []],
  ]
  for (const [label, body, residue] of cases) {
    const d16 = mkdtempSync(join(tmpdir(), 'cred-del-'))
    const f16 = join(d16, '.credentials.yaml')
    writeFileSync(f16, `version: 1\nrefs:\n${body}\n\nrecords:\n  k: 1\n`, 'utf8')
    const p16 = new FileCredentialProvider(fakeCtx, { file: f16 })
    await p16.unset('V')
    const t16 = readFileSync(f16, 'utf8')
    ok(!t16.includes('V:'), `⑯ ${label}：V 的 key 行没了`)
    ok(!hasOrphan(t16), `⑯ ${label}：没有孤儿续行`)
    const left = residue.filter((s) => t16.includes(s))
    ok(left.length === 0, `⑯ ${label}：值的正文没残留在文件里${left.length ? `（残留：${JSON.stringify(left)}）` : ''}`)
    ok(parseRefs(t16).get('B') === 'b', `⑯ ${label}：前面的 B 完好`)
    ok(parseRefs(t16).get('C') === 'c', `⑯ ${label}：后面的 C 完好`)
    ok(parseRefs(t16).size === 2, `⑯ ${label}：删完剩 2 条（实际 ${parseRefs(t16).size}）`)
    rmSync(d16, { recursive: true, force: true })
  }

  // 删不存在的 ref 什么都不做
  const d16b = mkdtempSync(join(tmpdir(), 'cred-del2-'))
  const f16b = join(d16b, '.credentials.yaml')
  const body16b = `version: 1\nrefs:\n  B: ${Q}b${Q}\n\nrecords:\n  k: 1\n`
  writeFileSync(f16b, body16b, 'utf8')
  const p16b = new FileCredentialProvider(fakeCtx, { file: f16b })
  const mtime16b = statSync(f16b).mtimeMs
  const ino16b = statSync(f16b).ino
  await p16b.unset('NO_SUCH_REF')
  ok(readFileSync(f16b, 'utf8') === body16b, '⑯ unset 不存在的 ref 时文件一字不动')
  // 内容不动 ≠ 没碰文件：`unset` 若把「存在性判断」删掉，仍会走完整读-改-写链，
  // 内容恰好不变（deleteRefsFrom 对不存在的 key 返回原文），但会多写一次盘、
  // 多一个 .bak。2026-10-31 二审实测：只断言内容时该变异 exit 0 全绿。
  ok(statSync(f16b).mtimeMs === mtime16b, '⑯ unset 不存在的 ref：没触发写盘（mtime 未变）')
  ok(!readdirSync(d16b).some((n) => n.includes('.bak')), '⑯ unset 不存在的 ref：没生成 .bak')
  ok(statSync(f16b).ino === ino16b, '⑯ unset 不存在的 ref：没 rename（inode 未变）')
  rmSync(d16b, { recursive: true, force: true })
}

// ── ⑮ 不同文件的写入互不排队 ────────────────────────────────────────────
// 单条全局 writeChain 会让无关文件被慢文件拖住（2026-10-31 审查实测 1ms → 359ms）。
// 这里把慢文件 chmod 0444，让它的 rename 真的 EPERM 并按 10/20/40… ms 退避
// （实测 Windows 上 chmod 只读确实让 renameSync 抛 EPERM），同时写另一个文件。
{
  const d15 = mkdtempSync(join(tmpdir(), 'cred-slow-'))
  const slow = join(d15, 'slow.yaml')
  const fast = join(d15, 'fast.yaml')
  writeFileSync(slow, "refs:\n  S: 's'\n", 'utf8')
  writeFileSync(fast, "refs:\n  F: 'f'\n", 'utf8')
  const pSlow = new FileCredentialProvider(fakeCtx, { file: slow })
  const pFast = new FileCredentialProvider(fakeCtx, { file: fast })
  // 只读 ⇒ rename 覆盖必然 EPERM；60ms 后恢复，让退避在第 3 次左右成功
  chmodSync(slow, 0o444)
  // 120ms 后才放开：退避序列 10/20/40/80 累计 150ms，让慢文件确实卡上一阵
  const restore = setTimeout(() => { try { chmodSync(slow, 0o666) } catch { /* ignore */ } }, 120)
  const tSlow0 = Date.now()
  const slowJob = pSlow.set('S2', 'v2').then(() => Date.now() - tSlow0)
  const t0 = Date.now()
  await pFast.set('F2', 'v2')
  const fastMs = Date.now() - t0
  const slowMs = await slowJob
  clearTimeout(restore)
  try { chmodSync(slow, 0o666) } catch { /* ignore */ }
  // 判据用**相对**比较：慢文件自己花了 slowMs，无关文件只该花零头。
  // 单条全局链时两者会几乎相等（fastMs ≈ slowMs）。
  ok(slowMs >= 50, `⑮ 慢文件确实被 EPERM 退避拖住了（实际 ${slowMs}ms）`)
  ok(fastMs < slowMs / 2, `⑮ 无关文件的写入没被慢文件拖住（快 ${fastMs}ms vs 慢 ${slowMs}ms）`)
  ok(parseRefs(readFileSync(fast, 'utf8')).get('F2') === 'v2', '⑮ 快文件的新 ref 落地')
  ok(parseRefs(readFileSync(slow, 'utf8')).get('S2') === 'v2', '⑮ 慢文件的新 ref 也落地')
  rmSync(d15, { recursive: true, force: true })
}

rmSync(dir, { recursive: true, force: true })

// ── ⑰ 块标量的缩进指示数字（`|2-`）────────────────────────────────────────
// 2026-10-31 二审实测真缺陷：`isBlockScalarHead` 原正则 `/^[|>][+-]?\d*\s*$/`
// 只认 `|-2`（非法写法），认不出 YAML 规范的 `|2-`。而本体 yaml 库在**值首行带
// 前导空格**时真会写出 `  A: |2-`。认不出 ⇒ 块头被当成值、续行成孤儿 ⇒ set/unset
// 之后整份凭据文件被本体拒绝（HEAD 是抛错不动文件，属新引入退化）。
{
  // 用本体同款 yaml 造夹具，保证「本体真会这么写」
  const doc = new YAML.Document({ version: 1, refs: { A: '  leading\nline2', B: '{"b":1}' }, records: { k: 1 } })
  const text = doc.toString()
  const head = /^ {2}A: (.*)$/m.exec(text)?.[1]
  ok(head === '|2-', `⑰ 夹具是本体真会写的 |2- 形态（实际 ${JSON.stringify(head)}）`)
  okYaml(text, '⑰ 夹具本身是本体合法文档')

  const pr17 = parseRefs(text)
  ok(pr17.get('A') === '  leading\nline2', `⑰ parseRefs 读出块标量真值（实际 ${JSON.stringify(pr17.get('A'))}）`)

  const d17 = mkdtempSync(join(tmpdir(), 'cred-hint-'))
  const f17 = join(d17, '.credentials.yaml')
  writeFileSync(f17, text, 'utf8')
  const p17 = new FileCredentialProvider(fakeCtx, { file: f17 })
  await p17.set('A', 'newval')
  const afterSet = readFileSync(f17, 'utf8')
  okYaml(afterSet, '⑰ set |2- 块标量之后，文件仍是本体合法文档')
  ok(!/^ {4,}\S/m.test(afterSet), '⑰ set 之后没有孤儿续行')
  ok(parseRefs(afterSet).get('A') === 'newval', '⑰ A 的值真的更新了')

  const p17b = new FileCredentialProvider(fakeCtx, { file: f17 })
  await p17b.unset('A')
  const afterUnset = readFileSync(f17, 'utf8')
  okYaml(afterUnset, '⑰ unset |2- 块标量之后，文件仍是本体合法文档')
  ok(!afterUnset.includes('leading'), '⑰ unset 之后块标量正文没残留')
  ok(parseRefs(afterUnset).get('B') === '{"b":1}', '⑰ 相邻的 B 完好')
  rmSync(d17, { recursive: true, force: true })

  // 三种指示形态都要认
  for (const h of ['|2-', '|2+', '>2-', '|3-']) {
    const t = `version: 1\nrefs:\n  V: ${h}\n    x\nrecords:\n  k: 1\n`
    const keys = [...scanRefKeys(t)]
    ok(JSON.stringify(keys) === JSON.stringify(['V']), `⑰ scanRefKeys 认得 ${h} 这个块头`, JSON.stringify(keys))
  }
}

// ── ⑱ refs 段的边界不能只认「纯字母 key」──────────────────────────────────
// 2026-10-31 二审实测真缺陷：段结束判据原来是 `/^[A-Za-z_]+\s*:\s*$/`，
// `x1:` / `x-y:` / `"quoted":` 这类顶层 key 都不匹配 ⇒ 它下面缩进 2 的子 key
// 被当成 ref。HEAD 遇到这种「假 ref」是抛错不动文件，而 set 改成 upsert 之后
// 会**把凭据写进那个段**（`x1:\n  y: '...'`），本体 toJS() 永远读不到 ——
// 静默丢凭据，比报错更糟。
// 第三个元素是 toJS() 之后的键名（YAML 里 `"quoted":` 的 key 就是 `quoted`）
for (const [label, top, topKey] of [['数字尾 x1', 'x1', 'x1'], ['中划线 x-y', 'x-y', 'x-y'], ['引号 "quoted"', '"quoted"', 'quoted']]) {
  const text = `version: 1\nrefs:\n  A: 'a'\n${top}:\n  y: 1\nrecords:\n  k: 1\n`
  okYaml(text, `⑱ ${label}：夹具本身合法`)
  const pr = [...parseRefs(text).keys()]
  ok(JSON.stringify(pr) === JSON.stringify(['A']), `⑱ ${label}：只认出 A（y 不算 ref）`, JSON.stringify(pr))
  ok(![...scanRefKeys(text)].includes('y'), `⑱ ${label}：scanRefKeys 也不认 y`)

  const d18 = mkdtempSync(join(tmpdir(), 'cred-sec-'))
  const f18 = join(d18, '.credentials.yaml')
  writeFileSync(f18, text, 'utf8')
  const p18 = new FileCredentialProvider(fakeCtx, { file: f18 })
  await p18.set('NEWREF', 'v')
  const after = readFileSync(f18, 'utf8')
  okYaml(after, `⑱ ${label}：set 之后仍是本体合法文档`)
  const js = YAML.parseDocument(after).toJS()
  ok(js?.refs?.NEWREF === 'v', `⑱ ${label}：新凭据落在 refs 段`, JSON.stringify(js?.refs))
  const other = js?.[topKey]
  ok(other?.y === 1 && other?.NEWREF === undefined, `⑱ ${label}：凭据没被写进 ${top} 段`, JSON.stringify(other))
  rmSync(d18, { recursive: true, force: true })
}

// ── ⑲ 折行标量必须吃掉续行前导缩进 ──────────────────────────────────────
// 2026-10-31 二审实测真缺陷：`parseRefs` 折行时把续行**原样**压入、只补一个空格，
// 而 YAML 折叠规则要求吃掉续行的前导缩进。真实凭据文件里 24/62 条值因此多出
// 「\ + 5 个空格」，其中 LOOMY_ACCOUNT_D54BD0DF 的 JSON 直接解析失败
// （消费方 20+ 处 parseCredential 返回 undefined ⇒ 该账号续期永久失效）。
// 更糟的是「resolve → set 回去」会把脏值落盘、静默损坏原值，而 yaml 语法仍合法。
{
  const Q = String.fromCharCode(39)
  const DQ = String.fromCharCode(34)
  const BS = String.fromCharCode(92)
  // 用本体同款 yaml 造夹具，保证期望值就是本体读到的值
  const roundtrip = (label, value) => {
    const text = new YAML.Document({ version: 1, refs: { K: value }, records: {} }).toString()
    const truth = YAML.parseDocument(text).toJS()?.refs?.K
    ok(truth === value, `⑲ ${label}：夹具往返无损（本体读回的就是原值）`)
    ok(parseRefs(text).get('K') === truth, `⑲ ${label}：parseRefs 与本体一致（实际 ${JSON.stringify(parseRefs(text).get('K')).slice(0, 80)}）`)
  }
  roundtrip('长 JSON 折行', JSON.stringify({ access_token: 'x'.repeat(80), nickname: 'Spring', expires_at: '1791609154261' }))
  roundtrip('中文值折行', JSON.stringify({ access_token: 'y'.repeat(60), nickname: '张三', userid: '260926131233458672' }))
  roundtrip('含换行的值', 'line1\nline2\nline3')

  // 手写跨行单引号标量：缩进必须被吃掉
  const t1 = `version: 1\nrefs:\n  K: ${Q}{"a":"1",\n    "b":"2"}${Q}\nrecords:\n  k: 1\n`
  ok(parseRefs(t1).get('K') === '{"a":"1", "b":"2"}', `⑲ 跨行单引号标量：缩进被吃掉（实际 ${JSON.stringify(parseRefs(t1).get('K'))}）`)

  // 双引号行尾反斜杠 = 续接，连空格都不插（`"xy\\` + 换行 + `z"` 读作 `xyz`）
  const t2 = `version: 1\nrefs:\n  K: ${DQ}xy${BS}\n    z${DQ}\nrecords:\n  k: 1\n`
  ok(parseRefs(t2).get('K') === 'xyz', `⑲ 双引号行尾反斜杠续接不插空格（实际 ${JSON.stringify(parseRefs(t2).get('K'))}）`)

  // 最关键：真实文件的形态 —— 62 条逐条与本体一致（读不到文件就跳过）
  try {
    const real = join(homedir(), '.dsh', '.credentials.yaml')
    const realText = readFileSync(real, 'utf8')
    const truth = YAML.parseDocument(realText).toJS()?.refs ?? {}
    const pr = parseRefs(realText)
    const badKeys = Object.entries(truth).filter(([k, v]) => pr.get(k) !== String(v)).map(([k]) => k)
    ok(badKeys.length === 0, `⑲ 真实凭据文件逐条与本体一致${badKeys.length ? `（不一致 ${badKeys.length} 条：${JSON.stringify(badKeys.slice(0, 3))}）` : ''}`)
  } catch {
    console.log('  – 跳过：读不到真实凭据文件')
  }
}

// ── ⑳ 多行 plain 标量的 ref（合法 YAML）：set/unset 不许留孤儿续行 ────────
// 2026-10-31 三审实测真缺陷（本轮新引入）：`  A: line1` + 续行 `    line2` 是合法 YAML，
// 而 deleteRefsFrom / writeRefsInto 只吃首行 ⇒ 续行成孤儿 ⇒ 本体报
// `Implicit keys need to be on a single line` / `All mapping items must start at
// the same column` ⇒ **整份凭据文件读不了**。HEAD 同输入是抛错不动文件。
{
  const mkPlain = () => {
    const d = mkdtempSync(join(tmpdir(), 'cred-plain-'))
    const f = join(d, '.credentials.yaml')
    writeFileSync(f, "version: 1\nrefs:\n  A: line1\n    line2\n  B: 'y'\nrecords: {}\n", 'utf8')
    return { d, f, p: new FileCredentialProvider(fakeCtx, { file: f }) }
  }
  const t0 = mkPlain()
  okYaml(readFileSync(t0.f, 'utf8'), '⑳ 夹具本身是合法 YAML')
  await t0.p.set('A', 'NEW')
  const afterSet = readFileSync(t0.f, 'utf8')
  okYaml(afterSet, '⑳ set 多行 plain 标量后文件仍是合法 YAML')
  ok(parseRefs(afterSet).get('A') === 'NEW', '⑳ set 后 A 是新值')
  ok(parseRefs(afterSet).get('B') === 'y', '⑳ set 后相邻 B 完好')
  ok(!/^ {3,}line2$/m.test(afterSet), '⑳ set 后没有孤儿续行 line2')
  rmSync(t0.d, { recursive: true, force: true })

  const t1 = mkPlain()
  await t1.p.unset('A')
  const afterUnset = readFileSync(t1.f, 'utf8')
  okYaml(afterUnset, '⑳ unset 多行 plain 标量后文件仍是合法 YAML')
  ok(parseRefs(afterUnset).get('A') === undefined, '⑳ unset 后 A 消失')
  ok(parseRefs(afterUnset).get('B') === 'y', '⑳ unset 后相邻 B 完好')
  ok(!/^ {3,}line2$/m.test(afterUnset), '⑳ unset 后没有孤儿续行 line2')
  rmSync(t1.d, { recursive: true, force: true })

  // 新增 ref 的插入点也必须跳过整块 plain 标量：插在标量首行与续行之间会把
  // 值劈成两半（line2 变成新 ref 的续行），而文件本身仍是合法 YAML ⇒ 只能靠
  // 「A 的值还对不对」来抓。2026-10-31 变异实测：不改这里，其余 173 项全绿。
  // 必须让 plain 标量是 refs 段**最后一条**，否则插入点本来就落在它后面，
  // 变异（不跳过续行）也会绿 —— 那是等价变异，抓不到真问题。
  const mkPlainTail = () => {
    const d = mkdtempSync(join(tmpdir(), 'cred-plaintail-'))
    const f = join(d, '.credentials.yaml')
    writeFileSync(f, "version: 1\nrefs:\n  B: 'y'\n  A: line1\n    line2\nrecords: {}\n", 'utf8')
    return { d, f, p: new FileCredentialProvider(fakeCtx, { file: f }) }
  }
  const t2 = mkPlainTail()
  await t2.p.set('NEWKEY', 'v')
  const afterAdd = readFileSync(t2.f, 'utf8')
  okYaml(afterAdd, '⑳ 新增 ref 后文件仍是合法 YAML')
  ok(parseRefs(afterAdd).get('A') === 'line1 line2', '⑳ 新增 ref 后 A 的多行值没被劈开',
    JSON.stringify(parseRefs(afterAdd).get('A')))
  ok(parseRefs(afterAdd).get('NEWKEY') === 'v', '⑳ 新增 ref 落到了文件里')
  ok(/^ {2}NEWKEY: 'v'$/m.test(afterAdd), '⑳ 新增 ref 在 refs 段里是独立一行', afterAdd)
  rmSync(t2.d, { recursive: true, force: true })
}

// ── ㉑ refs 段缩进不是 2 空格时，写侧必须拒绝写（不许追加出重复 key）──────
// 2026-10-31 三审实测真缺陷（本轮新引入）：scanRefKeys 原来只认恰好 2 空格，
// 1/3 空格或 tab 缩进时返回空集 ⇒ upsertRefsInto 认为「全都不存在」全走追加
// ⇒ 落盘重复 key ⇒ 本体读不了整份文件。HEAD 同输入是抛错不动文件。
{
  // tab 不进用例：YAML 规范禁止用 tab 做缩进（本体直接报 Tabs are not allowed as indentation），
  // 那不是「合法 YAML 被写坏」，不属本条要守的场景。
  for (const [label, indent] of [['1 空格', ' '], ['3 空格', '   ']]) {
    const d = mkdtempSync(join(tmpdir(), 'cred-indent-'))
    const f = join(d, '.credentials.yaml')
    const fixture = `version: 1\nrefs:\n${indent}A: 'x'\n${indent}B: 'y'\nrecords: {}\n`
    writeFileSync(f, fixture, 'utf8')
    okYaml(fixture, `㉑ ${label}缩进的夹具本身是合法 YAML`)
    ok(scanRefKeys(fixture).size === 2, `㉑ ${label}缩进时 scanRefKeys 仍认得出两条（实际 ${scanRefKeys(fixture).size}）`)
    const p = new FileCredentialProvider(fakeCtx, { file: f })
    let threw = false
    try { await p.set('A', 'NEW') } catch { threw = true }
    ok(threw, `㉑ ${label}缩进时 set 拒绝写（抛错而不是写坏）`)
    ok(readFileSync(f, 'utf8') === fixture, `㉑ ${label}缩进时 set 抛错后文件一字节未动`)
    // 四审 F 项 M3 的盲区：原来只测「改已存在」与 unset，没测「新增」——
    // 而 assertStandardIndent 恰好在新增路径上最关键（新增会往段里插新行）。
    let threwNew = false
    try { await p.set('BRAND_NEW', 'v') } catch { threwNew = true }
    ok(threwNew, `㉑ ${label}缩进时 set 一个不存在的 ref 也拒绝写`)
    ok(readFileSync(f, 'utf8') === fixture, `㉑ ${label}缩进时新增被拒后文件一字节未动`)
    let threwUnset = false
    try { await p.unset('A') } catch { threwUnset = true }
    ok(threwUnset, `㉑ ${label}缩进时 unset 也拒绝写`)
    ok(readFileSync(f, 'utf8') === fixture, `㉑ ${label}缩进时 unset 抛错后文件一字节未动`)
    rmSync(d, { recursive: true, force: true })
  }
}

// ── ㉒ 含换行的值必须写块标量保住它，不许折成空格 ─────────────────────
// 2026-10-31 三审实测真缺陷：四处写入分支都把 \n 折成空格，PEM 私钥 / 多行 JSON
// 折完之后 yaml 依然合法、本体读回同串 —— **值被悄悄改掉而校验看不出来**。
// 最现实入口 vendor/lib/backup.js:506 原样写入备份字符串。
{
  const d = mkdtempSync(join(tmpdir(), 'cred-nlkeep-'))
  const f = join(d, '.credentials.yaml')
  writeFileSync(f, "version: 1\nrefs:\n  A: 'old'\nrecords: {}\n", 'utf8')
  const p = new FileCredentialProvider(fakeCtx, { file: f })

  const PEM = '-----BEGIN KEY-----\nMIIBVAIBADAN\nBgkqhkiG9w0B\n-----END KEY-----'
  await p.set('A', PEM)
  const t1 = readFileSync(f, 'utf8')
  okYaml(t1, '㉒ 写 PEM 后文件仍是合法 YAML')
  ok(parseRefs(t1).get('A') === PEM, '㉒ PEM 原样读回（换行没被折成空格）')
  ok(/^  A: \|-$/m.test(t1), '㉒ PEM 写成 `|-` 块标量（结尾无换行 ⇒ strip）')
  ok(!parseRefs(t1).get('A').includes('-----END KEY----- '), '㉒ 值尾部没有被补空格')

  // chomping 三态：结尾无 \n / 恰好一个 / 两个以上
  await p.set('A', 'x\ny')
  ok(/^  A: \|-$/m.test(readFileSync(f, 'utf8')), '㉒ 结尾无换行 ⇒ `|-`')
  ok(parseRefs(readFileSync(f, 'utf8')).get('A') === 'x\ny', '㉒ 结尾无换行的值读回一致')
  await p.set('A', 'x\ny\n')
  ok(/^  A: \|$/m.test(readFileSync(f, 'utf8')), '㉒ 结尾一个换行 ⇒ `|`')
  ok(parseRefs(readFileSync(f, 'utf8')).get('A') === 'x\ny\n', '㉒ 结尾一个换行的值读回一致')
  // 结尾两个以上换行走双引号：`|+` 靠尾随空行记换行数，而「尾随空行」与
  // 「文件末尾的换行」在行数组里分不开，容易读回多一个换行。
  await p.set('A', 'x\ny\n\n')
  ok(/^  A: "x\\ny\\n\\n"$/m.test(readFileSync(f, 'utf8')), '③ 结尾两个以上换行 ⇒ 双引号 + 转义')
  ok(parseRefs(readFileSync(f, 'utf8')).get('A') === 'x\ny\n\n', '③ 结尾两个以上换行的值读回一致')

  // 新增 ref 走 upsert 追加分支时也要写块标量
  await p.set('FRESH', 'p\nq')
  const t2 = readFileSync(f, 'utf8')
  okYaml(t2, '㉒ 新增含换行的 ref 后文件仍是合法 YAML')
  ok(parseRefs(t2).get('FRESH') === 'p\nq', '㉒ 新增 ref 的换行也原样保住')
  ok(/^  FRESH: \|-$/m.test(t2), '㉒ 新增 ref 也写成块标量')

  rmSync(d, { recursive: true, force: true })
}

// ── ㉓ 任意值都要无损往返：parseRefs 读回 === 原值 === 本体 yaml 读回 ────
// 2026-10-31 四审前自查：`refLines` 只处理了「普通值」与「带换行的值」两档，
// 中间那一大片形态（纯换行、尾部空格、行首空格、CR、C0 控制字符……）会静默改值。
// 这一节把「写下去再读回来必须一模一样」当唯一判据，逐条覆盖那四类退回双引号的
// 情形与块标量的 chomping / 缩进剥离。以后谁改 refLines 或 blockScalarBody，
// 只要破坏了无损性，这里就会红。
{
  const d = mkdtempSync(join(tmpdir(), 'cred-roundtrip-'))
  const f = join(d, '.credentials.yaml')
  const p = new FileCredentialProvider(fakeCtx, { file: f })

  const VALUES = [
    ['plain', 'plain'],
    ['empty', ''],
    ['only-lf', '\n'],
    ['two-lf', '\n\n'],
    ['lead-lf', '\nx'],
    ['trail-spaces', 'x\n   '],
    ['trail-tab', 'x\n\t'],
    ['lead-spaces', '  leading\nline2'],
    ['crlf', 'x\r\ny'],
    ['bare-cr', 'x\ry'],
    ['two-trail-lf', 'x\ny\n\n'],
    ['three-trail-lf', 'x\ny\n\n\n'],
    ['one-trail-lf', 'x\ny\n'],
    ['no-trail-lf', 'x\ny'],
    ['blank-in-middle', 'a\n\nb'],
    ['indented-middle', 'a\n  b'],
    ['trailing-space-middle', 'a\nb '],
    ['pem', '-----BEGIN KEY-----\nMIIBVAIBADAN\n-----END KEY-----'],
    ['ctrl-bel', 'x\u0007y'],
    ['ctrl-esc', 'x\u001by'],
    ['tab-middle', 'x\ty'],
    ['json-multiline', '{\n  "a": 1\n}'],
    // U+2028 / U+2029 在 JS 里算行终止符（`.` 与 `$` 都不匹配），
    // 原样落盘会让行扫描错位 —— 必须转成 `\uNNNN` 两个字符。
    ['line-sep-u2028', 'x\u2028y'],
    ['para-sep-u2029', 'x\u2029y'],
    ['sep-mixed', 'a\u2028b\u2029c'],
    // 行尾是「转义引号 + 闭合引号」（落盘成 `\""`）时，闭合判据必须数反斜杠的奇偶，
    // 不能只看「闭合引号前一个字符不是反斜杠」—— 否则判成没闭合、一路吞掉后续行。
    ['trailing-escaped-quote', '?|#@>\r]!,"'],
    ['quote-then-backslash', 'a"\\'],
    ['only-quote', '"'],
    ['only-two-quotes', '""'],
  ]

  for (const [label, value] of VALUES) {
    writeFileSync(f, "version: 1\nrefs:\n  KEEP: 'k'\nrecords: {}\n", 'utf8')
    const q = new FileCredentialProvider(fakeCtx, { file: f })
    await q.set('V', value)
    const text = readFileSync(f, 'utf8')
    const got = parseRefs(text).get('V')
    ok(got === value, `㉓ ${label}：parseRefs 读回一致（实际 ${JSON.stringify(got)}）`)
    const doc = YAML.parseDocument(text, { prettyErrors: true, uniqueKeys: true })
    ok(doc.errors.length === 0, `㉓ ${label}：文件仍是本体合法文档（${doc.errors[0]?.message ?? ''}）`)
    ok(doc.toJS()?.refs?.V === value, `㉓ ${label}：本体 yaml 读回一致（实际 ${JSON.stringify(doc.toJS()?.refs?.V)}）`)
    ok(parseRefs(text).get('KEEP') === 'k', `㉓ ${label}：相邻的 KEEP 没被吞掉`)
  }

  rmSync(d, { recursive: true, force: true })
}

// ── ㉔ 读侧：手写的块标量夹具，parseRefs 必须与本体 yaml 完全一致 ─────────
// ㉓ 只覆盖「我们写出去、我们再读回来」。但 refs 段是本体与人手共写的文件：
// 本体自己会写 `|+`、会写「整行只有空格」的内容行、会写 `|2-`。这些形态
// 我们从来不产生，却一定要能读对 —— 读错一个字节，那条凭据就永久失效。
// 2026-10-31 变异验证发现：删掉 blockScalarBody 的「l.length <= cut 当空行」
// 与 `|+` 的 keep 分支，㉓ 全绿（写侧走不到），所以必须有这一节。
{
  const FIXTURES = [
    ['keep-两尾随空行', 'refs:\n  A: |+\n    a\n    b\n\n\nrecords: {}\n'],
    ['keep-一尾随空行', 'refs:\n  A: |+\n    a\n    b\n\nrecords: {}\n'],
    ['keep-空内容(带缩进)', 'refs:\n  A: |+\n    \nrecords: {}\n'],
    ['keep-空内容(无缩进)', 'refs:\n  A: |+\n\nrecords: {}\n'],
    ['clip-普通', 'refs:\n  A: |\n    a\n    b\nrecords: {}\n'],
    ['clip-空内容', 'refs:\n  A: |\n    \nrecords: {}\n'],
    ['strip-普通', 'refs:\n  A: |-\n    a\n    b\nrecords: {}\n'],
    // 四审 F 项 M5b 的盲区：原夹具正文不带尾随空行，把 `|-` 的 strip 分支
    // 改坏（退化成不剥）测试仍全绿。这条夹具的正文后面真的跟了一个空行，
    // 本体读 `"x"`，不剥就变 `"x\n"`。
    ['strip-尾随空行', 'refs:\n  A: |-\n    x\n\nrecords: {}\n'],
    ['显式缩进 |2-', 'refs:\n  A: |2-\n      leading\n    line2\nrecords: {}\n'],
    ['内容行整行空格', 'refs:\n  A: |-\n    x\n       \n    y\nrecords: {}\n'],
    ['内容行尾随空格', 'refs:\n  A: |-\n    x\n    y  \nrecords: {}\n'],
    ['单引号多行', "refs:\n  A: 'one\n    two'\nrecords: {}\n"],
    ['双引号转义', 'refs:\n  A: "x\\ny\\tz"\nrecords: {}\n'],
    ['双引号 \\x 转义', 'refs:\n  A: "x\\x41y"\nrecords: {}\n'],
    ['双引号 \\u 转义', 'refs:\n  A: "x\\u0041y"\nrecords: {}\n'],
    ['plain 多行折叠', 'refs:\n  A: one\n    two\nrecords: {}\n'],
    ['plain 多行含空行', 'refs:\n  A: one\n\n    two\nrecords: {}\n'],
  ]
  for (const [label, fixture] of FIXTURES) {
    const doc = YAML.parseDocument(fixture, { prettyErrors: true, uniqueKeys: true })
    ok(doc.errors.length === 0, `㉔ ${label}：夹具本身是合法 YAML（${doc.errors[0]?.message ?? ''}）`)
    const want = doc.toJS()?.refs?.A
    const got = parseRefs(fixture).get('A')
    ok(got === want, `㉔ ${label}：parseRefs 与本体一致（本体 ${JSON.stringify(want)} / 我们 ${JSON.stringify(got)}）`)
  }
}

// ── ㉕ 空的 refs 段（refs: {}）也要能写进去 ───────────────────────────────────
// 本体把 refs 删空时写的是流式映射 `refs: {}`，而定位 refs 段的正则只认裸的
// `refs:`。认不出就抛「找不到 refs: 段」——写入失败虽然安全（文件不动），
// 但那一次登录就白登了：用户在网页里登得好好的，插件却没法把凭据存下来。
// 2026-10-31 实测复现（修前 set 直接抛错）。
{
  for (const [label, fixture] of [
    ['refs: {}', 'version: 1\nrefs: {}\nrecords: {}\n'],
    ['refs: { }', 'version: 1\nrefs: { }\n'],
    ['refs: {} 在文件末尾', 'version: 1\nrefs: {}\n'],
  ]) {
    const d = mkdtempSync(join(tmpdir(), 'cred-empty-'))
    const f = join(d, '.credentials.yaml')
    writeFileSync(f, fixture, 'utf8')
    const p = new FileCredentialProvider({ reflect: { provide: () => {} } }, { file: f })
    let threw = ''
    try {
      await p.set('NEWKEY', 'v1')
    } catch (e) {
      threw = String(e?.message ?? e)
    }
    ok(threw === '', `㉕ ${label}：set 没报错（实际：${threw}）`)
    ok((await p.resolve('NEWKEY'))?.value === 'v1', `㉕ ${label}：新 ref 能读回来`)
    const after = readFileSync(f, 'utf8')
    const doc = YAML.parseDocument(after, { prettyErrors: true, uniqueKeys: true })
    ok(doc.errors.length === 0, `㉕ ${label}：落盘后仍是本体合法文档（${doc.errors[0]?.message ?? ''}）`)
    ok(doc.toJS()?.refs?.NEWKEY === 'v1', `㉕ ${label}：本体也能读到这个凭据`)
    rmSync(d, { recursive: true, force: true })
  }
}

// ── ㉖ 段头带注释 / 段内注释行 ───────────────────────────────────────────
// `refs:  # 凭据`是合法 YAML（本体读得好好的），但上游
// `vendor/lib/jet-hub-store.js` 的 extractCredentialRefNames 用 `/^refs:\s*$/`
// 认段头；注释跟在同一行就认不出来，那条「从 .credentials.yaml
// 恢复账号」的兜底路径就断了。所以归一时把注释挪成独立注释行。
{
  const d = mkdtempSync(join(tmpdir(), 'cred-cmt-'))
  const f = join(d, '.credentials.yaml')
  writeFileSync(f, 'version: 1\nrefs: {}  # 凭据\nrecords: {}\n', 'utf8')
  const p = new FileCredentialProvider({ reflect: { provide: () => {} } }, { file: f })
  let threw = ''
  try {
    await p.set('NEWKEY', 'v1')
  } catch (e) {
    threw = String(e?.message ?? e)
  }
  ok(threw === '', `㉖ 段头带注释时 set 不报错（实际：${threw}）`)
  const after = readFileSync(f, 'utf8')
  ok(/^refs:\s*$/m.test(after), '㉖ 空段归一后段头是裸的 `refs:`（上游的段头正则才认得出）')
  ok(!/^refs:.*#/m.test(after), '㉖ 注释没留在段头同一行')
  ok(after.includes('# 凭据'), '㉖ 注释没丢')
  const doc = YAML.parseDocument(after, { prettyErrors: true, uniqueKeys: true })
  ok(doc.errors.length === 0, `㉖ 落盘后仍是本体合法文档（${doc.errors[0]?.message ?? ''}）`)
  ok(doc.toJS()?.refs?.NEWKEY === 'v1', '㉖ 本体能读到新凭据')

  // 段内注释行：新 ref 不能被插到注释行前面（否则注释看起来在注释新凭据）
  const f2 = join(d, '.credentials.yaml')
  writeFileSync(f2, 'version: 1\nrefs:\n  A: \'a\'\n  # 尾注\nrecords: {}\n', 'utf8')
  const p2 = new FileCredentialProvider({ reflect: { provide: () => {} } }, { file: f2 })
  await p2.set('NEWKEY', 'v1')
  const a2 = readFileSync(f2, 'utf8')
  ok(a2.indexOf('# 尾注') < a2.indexOf('NEWKEY'), '㉖ 新凭据插在段内注释之后')
  ok(YAML.parseDocument(a2, { prettyErrors: true, uniqueKeys: true }).errors.length === 0, '㉖ 有段内注释时落盘也合法')
  rmSync(d, { recursive: true, force: true })
}


// ── ㉗ 四审三条必修：Unicode 空白 / 非标准缩进读侧 / 裸 key 吞续行 ─────────
// 2026-10-31 四审实测三组「合法 YAML 输入 ⇒ 凭据全毁」：
//   ① Unicode 空白行被 `trim()` 当空行（JS 的 trim 认 26 种 Unicode 空白，
//      YAML 的「空行」只认 ASCII 空格）⇒ 值静默丢成空串，再写一次就把整份
//      文件写成本体读不了。NBSP / 全角空格 / VT / FF / LS / BOM 六种全中招。
//   ② `parseRefs` 只认恰好 2 空格缩进（而 scanRefKeys 认任意缩进）⇒ 1/3 空格
//      缩进的 refs 段「读不到」：resolve 返回 undefined、unset 也救不回。
//   ③ 裸 key（`A:`）后跟深缩进续行 / 子映射时只吃首行 ⇒ 续行成孤儿，
//      unset / 新增 set 把整份文件写坏。
{
  // ① Unicode 空白：这些值本身合法，读回来必须一字不差
  const BLANKS = [
    ['NBSP U+00A0', '\u00a0'],
    ['全角空格 U+3000', '\u3000'],
    ['垂直制表 U+000B', '\u000b'],
    ['换页 U+000C', '\u000c'],
    ['行分隔 U+2028', '\u2028'],
    ['BOM U+FEFF', '\ufeff'],
  ]
  for (const [label, blank] of BLANKS) {
    const d = mkdtempSync(join(tmpdir(), 'cred-blank-'))
    const f = join(d, '.credentials.yaml')
    writeFileSync(f, 'version: 1\nrefs:\nrecords: {}\n', 'utf8')
    const p = new FileCredentialProvider(fakeCtx, { file: f })
    const value = `${blank}\n`
    let threw = ''
    try { await p.set('A', value) } catch (e) { threw = String(e?.message ?? e) }
    ok(threw === '', `㉗ ${label}：set 不报错（实际：${threw}）`)
    // resolve() 是 async 且返回 { value } 包装（本体契约）—— 忘了 await 会拿到
    // 一个 Promise，`?.value` 恒 undefined，断言看起来「读不到」其实是测试写错。
    const resolved = await p.resolve('A')
    ok(resolved?.value === value, `㉗ ${label}：读回来的值一字不差（${JSON.stringify(resolved?.value)}）`)
    const doc = YAML.parseDocument(readFileSync(f, 'utf8'), { prettyErrors: true, uniqueKeys: true })
    ok(doc.errors.length === 0, `㉗ ${label}：落盘仍是本体合法文档（${doc.errors[0]?.message ?? ''}）`)
    ok(doc.toJS()?.refs?.A === value, `㉗ ${label}：本体读到的值也一字不差`)
    // 再写一次别的 ref：这里最容易把整份文件写坏（旧实现二次写后 errs 非空）
    let threw2 = ''
    try { await p.set('B', 'SECOND') } catch (e) { threw2 = String(e?.message ?? e) }
    ok(threw2 === '', `㉗ ${label}：紧接着写第二个 ref 也不报错（实际：${threw2}）`)
    const doc2 = YAML.parseDocument(readFileSync(f, 'utf8'), { prettyErrors: true, uniqueKeys: true })
    ok(doc2.errors.length === 0, `㉗ ${label}：二次写入后文件仍合法（${doc2.errors[0]?.message ?? ''}）`)
    ok((await p.resolve('A'))?.value === value && (await p.resolve('B'))?.value === 'SECOND', `㉗ ${label}：二次写入后两条凭据都还在`)
    rmSync(d, { recursive: true, force: true })
  }

  // ② 非标准缩进：读侧必须与本体一致（写侧拒绝写在 ㉑ 已覆盖）
  for (const [label, indent] of [['1 空格', ' '], ['3 空格', '   ']]) {
    const fixture = `version: 1\nrefs:\n${indent}A: 'x'\n${indent}B: 'y'\nrecords: {}\n`
    const doc = YAML.parseDocument(fixture, { prettyErrors: true, uniqueKeys: true })
    ok(doc.errors.length === 0, `㉗ ${label}缩进夹具本身是合法 YAML`)
    const got = parseRefs(fixture)
    ok(got.size === 2, `㉗ ${label}缩进时 parseRefs 读出两条（实际 ${got.size}）`)
    ok(got.get('A') === 'x' && got.get('B') === 'y', `㉗ ${label}缩进时值也对（${JSON.stringify([got.get('A'), got.get('B')])}）`)
  }
  // 非标准缩进 + 块标量：cut 必须按「条目实际缩进 + 指示数字」，不能硬编码 2
  {
    const fixture = "version: 1\nrefs:\n A: |-\n     x\n     y\nrecords: {}\n"
    const want = YAML.parseDocument(fixture, { prettyErrors: true, uniqueKeys: true }).toJS()?.refs?.A
    ok(parseRefs(fixture).get('A') === want, `㉗ 1 空格缩进下的块标量读对（本体 ${JSON.stringify(want)} / 我们 ${JSON.stringify(parseRefs(fixture).get('A'))}）`)
  }

  // ③a 裸 key 的续行不能被当成 ref（M4 变异盲区）
  // 四审 F 项指出：只测 set/unset 抓不到 `parseRefs` 里「裸 key 不吞续行」的变异，
  // 因为写入侧走的是自己那套扫描。真正的后果在**读**侧：子映射的 key 会被解析成
  // 一条凭空出现的 ref（`A:\n    k: v` 里的 `k` 变成 ref `k = v`），
  // `listRefs()` / `scanRefKeys` 里就多出一条不存在的凭据名。
  {
    const fixture = "version: 1\nrefs:\n  A:\n    k: v\n  B: 'y'\nrecords: {}\n"
    ok(YAML.parseDocument(fixture, { prettyErrors: true, uniqueKeys: true }).errors.length === 0, '㉗ 裸key 子映射夹具是合法 YAML')
    const parsed = parseRefs(fixture)
    ok(!parsed.has('k'), `㉗ 裸key 的子映射 key 不能变成 ref（实际多出：${JSON.stringify([...parsed.keys()])}）`)
    // 子映射（`A:` 下面 `k: v`）我们不重建对象，只把续行按 plain 折叠成字符串 ——
    // 这是有意的取舍：凭据全是字符串，为嵌套映射造对象只会让下游 `JSON.parse` 更迷惑。
    // 关键是**不能**把 `k` 变成一条独立 ref，也不能把 `B` 吞掉。
    ok(typeof parsed.get('A') === 'string', `㉗ 裸key 的子映射折成字符串而不是对象（实际 ${typeof parsed.get('A')}）`)
    ok(parsed.get('A') !== '', `㉗ 裸key 的子映射不该读成空串（本体是有内容的，实际 ${JSON.stringify(parsed.get('A'))}）`)
    ok(parsed.get('B') === 'y', '㉗ 裸key 之后的正常 ref 照常读')
  }

  // ③b 3/4 空格缩进 + 块标量 + 同级兄弟 ref（五审必修 1 的回归）
  // 条目缩进放宽成 `[ \t]+` 之后，`blockScalarEnd` 如果还硬编码 `/^ {3,}/`，
  // 3/4 空格缩进下的**同级兄弟 ref 也会满足 >= 3**，被当成块标量的续行吞进值里：
  //   我们 {"A":"    x\nB: 'bbb'"}  /  本体 {"A":"x","B":"bbb"}
  // 污染值让 `JSON.parse` 抛错 ⇒ 账号有凭据却登不上（静默）。
  for (const [label, indent] of [['3 空格', '   '], ['4 空格', '    ']]) {
    for (const head of ['|', '|-', '|+', '|2-']) {
      const body = head === '|2-' ? `${indent}  x` : `${indent}  x`
      const fixture = `version: 1\nrefs:\n${indent}A: ${head}\n${body}\n${indent}B: 'bbb'\nrecords: {}\n`
      const doc = YAML.parseDocument(fixture, { prettyErrors: true, uniqueKeys: true })
      if (doc.errors.length !== 0) continue // 本体自己拒绝的形态不属「合法 YAML 被读错」
      const want = doc.toJS()?.refs ?? {}
      const got = Object.fromEntries(parseRefs(fixture))
      ok(JSON.stringify(got) === JSON.stringify(want), `㉗ ${label} + ${head} + 同级 ref：parseRefs 与本体一致（本体 ${JSON.stringify(want)} / 我们 ${JSON.stringify(got)}）`)
    }
  }

  // ③c 裸 key 的续行必须读出值来（五审必修 2 的回归）
  // `  A:` + `    line1` 在 YAML 里是多行 plain 标量，本体读 `"line1"`。
  // 原来一律 `out.set(key, '')` ⇒ `resolve()` 返回 undefined ⇒ 那条凭据在插件侧
  // 等于不存在（本体有值、我们读成空）。
  for (const [label, fixture, expectA] of [
    ['单行续行', "version: 1\nrefs:\n  A:\n    line1\n  B: 'y'\nrecords: {}\n", 'line1'],
    ['多行续行', "version: 1\nrefs:\n  A:\n    line1\n    line2\nrecords: {}\n", 'line1 line2'],
    ['3 空格缩进', "version: 1\nrefs:\n   A:\n     line1\n   B: 'bbb'\nrecords: {}\n", 'line1'],
  ]) {
    const doc = YAML.parseDocument(fixture, { prettyErrors: true, uniqueKeys: true })
    ok(doc.errors.length === 0, `㉗ 裸key ${label}：夹具本身是合法 YAML`)
    const got = parseRefs(fixture)
    ok(got.get('A') === expectA, `㉗ 裸key ${label}：读出值来（期望 ${JSON.stringify(expectA)} / 实际 ${JSON.stringify(got.get('A'))}）`)
    ok(got.get('A') === doc.toJS()?.refs?.A, `㉗ 裸key ${label}：与本体一致`)
  }

  // ③d plain 多行续行里的 Unicode 空白（五审 M1c 变异盲区）
  // `trimYaml` 如果退回 `String(text).trim()`，续行里「只由 NBSP / 全角空格 / VT 组成」
  // 的部分会被当成空行折成换行，而不是保留成内容 —— 435 项测试当时全绿，是真盲区。
  for (const [label, blank] of [
    ['NBSP U+00A0', '\u00a0'],
    ['全角空格 U+3000', '\u3000'],
    ['垂直制表 U+000B', '\u000b'],
  ]) {
    const fixture = `version: 1\nrefs:\n  A: one\n    ${blank}\n    two\nrecords: {}\n`
    const doc = YAML.parseDocument(fixture, { prettyErrors: true, uniqueKeys: true })
    if (doc.errors.length !== 0) continue
    const want = doc.toJS()?.refs?.A
    const got = parseRefs(fixture).get('A')
    ok(got === want, `㉗ plain 多行续行含 ${label}：与本体一致（本体 ${JSON.stringify(want)} / 我们 ${JSON.stringify(got)}）`)
  }

  // ②b 显式缩进指示数字（`|2-`）+ 非标准条目缩进（M7 变异盲区）
  // `cut` 必须按「条目实际缩进 + 指示数字」算。硬编码 2 + hint 在 1 空格缩进的
  // refs 段里会多切一个字符，值开头凭空少一个空格。
  {
    const fixture = "version: 1\nrefs:\n A: |2-\n     x\n     y\nrecords: {}\n"
    const want = YAML.parseDocument(fixture, { prettyErrors: true, uniqueKeys: true }).toJS()?.refs?.A
    const got = parseRefs(fixture).get('A')
    ok(got === want, `㉗ 1 空格缩进 + |2- 的块标量读对（本体 ${JSON.stringify(want)} / 我们 ${JSON.stringify(got)}）`)
  }

  // ③ 裸 key 后跟续行 / 子映射：unset 与新增 set 都不许把文件写坏
  const BARE = [
    ['裸key 中间', "version: 1\nrefs:\n  A:\n    line1\n  B: 'y'\nrecords: {}\n"],
    ['裸key 最后', "version: 1\nrefs:\n  B: 'y'\n  A:\n    line1\nrecords: {}\n"],
    ['裸key 子映射', "version: 1\nrefs:\n  A:\n    k: v\n  B: 'y'\nrecords: {}\n"],
  ]
  for (const [label, fixture] of BARE) {
    ok(YAML.parseDocument(fixture, { prettyErrors: true, uniqueKeys: true }).errors.length === 0, `㉗ ${label}：夹具本身是合法 YAML`)
    for (const action of ['unset', 'newRef', 'overwrite']) {
      const d = mkdtempSync(join(tmpdir(), 'cred-bare-'))
      const f = join(d, '.credentials.yaml')
      writeFileSync(f, fixture, 'utf8')
      const p = new FileCredentialProvider(fakeCtx, { file: f })
      let threw = ''
      try {
        if (action === 'unset') await p.unset('A')
        else if (action === 'newRef') await p.set('Z', 'NEW')
        else await p.set('A', 'REPLACED')
      } catch (e) { threw = String(e?.message ?? e) }
      ok(threw === '', `㉗ ${label} · ${action}：不报错（实际：${threw}）`)
      const after = readFileSync(f, 'utf8')
      const doc = YAML.parseDocument(after, { prettyErrors: true, uniqueKeys: true })
      ok(doc.errors.length === 0, `㉗ ${label} · ${action}：落盘仍是本体合法文档（${doc.errors[0]?.message ?? ''}）`)
      const js = doc.toJS() ?? {}
      if (action === 'unset') ok(js.refs?.A === undefined && js.refs?.B === 'y', `㉗ ${label} · unset：A 删掉了、B 还在`)
      if (action === 'newRef') ok(js.refs?.Z === 'NEW' && js.refs?.B === 'y', `㉗ ${label} · 新增：Z 写进去了、B 还在`)
      if (action === 'overwrite') ok(js.refs?.A === 'REPLACED' && js.refs?.B === 'y', `㉗ ${label} · 改值：A 是新值、B 还在`)
      rmSync(d, { recursive: true, force: true })
    }
  }
}

/* ── ㉘ 六审四条：|+ 文件末尾 / plain 后续注释 / plain 首行 Unicode 空白 / 条目正则 ── */
//
// 六审（2026-10-31）用 240 形态矩阵把 parseRefs 与本体 yaml 逐条对账，抓出四条：
//   A `|+` 位于**文件末尾**时多读一个换行 —— `text.split(/\r?\n/)` 在文件以换行
//     结尾时会多产一个末尾空串，被当成 `|+` 的尾随空行计入 keep。resolve 得
//     `"x\n\n"`（本体 `"x\n"`），set 回去就把多余换行永久写进文件。
//   B plain 值后面的**整行注释**被折进值里 —— 本体读 `"x"`、我们读 `"x # note"`。
//     这条是本轮把 plain 分支改成多行折叠时引入的退化（HEAD 版是对的）。
//   C plain **首行**还在用 `rest.trim()`，把前导/尾随 NBSP、全角、VT 也剥掉了
//     （续行早已改用 trimYaml）。
//   D 条目正则的 `:\s*(` 把值首行的非空格空白一起吃掉。
//
// 这节只做读侧对账（parseRefs vs 本体 toJS().refs）——写侧已有 ⑬–㉗ 覆盖。
{
  const H = (text) => {
    const doc = YAML.parseDocument(text, { prettyErrors: true, uniqueKeys: true })
    return { errs: doc.errors.length, refs: doc.toJS()?.refs ?? {} }
  }

  // A：`|+` 在文件末尾，尾随换行 0..3 个都必须与本体一致。
  // n=0 是「文件不以换行结尾」，n>=1 是 split 会多产末尾空串的那种形态。
  for (const n of [0, 1, 2, 3]) {
    const text = n === 0
      ? 'version: 1' + '\n' + 'refs:' + '\n' + '  A: |+' + '\n' + '    x'
      : 'version: 1' + '\n' + 'refs:' + '\n' + '  A: |+' + '\n' + '    x' + '\n'.repeat(n)
    const h = H(text)
    const ours = parseRefs(text).get('A')
    ok(h.errs === 0, `㉘ ${n === 0 ? 'A 文件不以换行结尾' : `A |+ 在文件末尾（尾随 ${n} 个换行）`}：夹具本身是合法 YAML`)
    ok(ours === h.refs.A, `㉘ A 尾随 ${n} 换行：parseRefs 与本体一致（本体 ${
      JSON.stringify(h.refs.A)} / 我们 ${JSON.stringify(ours)}）`)
  }
  // A 的写回面：resolve→set 不许把多余换行永久写进去。
  {
    const d = mkdtempSync(join(tmpdir(), 'cred-eof-'))
    const f = join(d, '.credentials.yaml')
    writeFileSync(f, 'version: 1' + '\n' + 'refs:' + '\n' + '  A: |+' + '\n' + '    x' + '\n', 'utf8')
    const p = new FileCredentialProvider(fakeCtx, { file: f })
    const r = await p.resolve('A')
    ok(r?.value === 'x' + '\n', `㉘ A resolve 得到 "x\\n"（不是 "x\\n\\n"），实际 ${JSON.stringify(r?.value)}`)
    if (r !== undefined) await p.set('A', r.value)
    ok(H(readFileSync(f, 'utf8')).refs.A === 'x' + '\n', '㉘ A resolve→set 回写后本体仍读 "x\\n"')
    rmSync(d, { recursive: true, force: true })
  }

  // B：plain / 裸 key 后面的整行注释不许折进值。
  for (const [label, fixture] of [
    ['B plain + 4 空格注释', 'version: 1' + '\n' + 'refs:' + '\n' + '  A: x' + '\n' + '    # note' + '\n' + "  B: 'y'" + '\n' + 'records: {}' + '\n'],
    ['B 裸key + 4 空格注释', 'version: 1' + '\n' + 'refs:' + '\n' + '  A:' + '\n' + '    # note' + '\n' + "  B: 'y'" + '\n' + 'records: {}' + '\n'],
    ['B 裸key + 2 空格注释', 'version: 1' + '\n' + 'refs:' + '\n' + '  A:' + '\n' + '  # note' + '\n' + "  B: 'y'" + '\n' + 'records: {}' + '\n'],
  ]) {
    const h = H(fixture)
    const ours = parseRefs(fixture).get('A')
    ok(h.errs === 0, `㉘ ${label}：夹具本身是合法 YAML`)
    // 本体对裸 key 回 null，我们对空值回 ''；语义等价，两者都不许含 '#'。
    ok(ours === undefined || !String(ours).includes('#'),
      `㉘ ${label}：注释没被折进值（本体 ${JSON.stringify(h.refs.A)} / 我们 ${JSON.stringify(ours)}）`)
  }
  // B 的反面：块标量里的 `#` 是内容，必须保留。
  {
    const text = 'version: 1' + '\n' + 'refs:' + '\n' + '  A: |-' + '\n' + '    x' + '\n' + '    # note' + '\n' + "  B: 'y'" + '\n' + 'records: {}' + '\n'
    ok(parseRefs(text).get('A') === 'x' + '\n' + '# note', '㉘ B 块标量里的 # 仍按内容处理')
  }

  // C/D：plain 首行前导/尾随的非 ASCII 空白必须保留（本体只剥空格与 tab）。
  for (const [label, fixture] of [
    ['C 前导 NBSP', 'version: 1' + '\n' + 'refs:' + '\n' + '  A: \u00a0x' + '\n' + 'records: {}' + '\n'],
    ['C 尾随全角', 'version: 1' + '\n' + 'refs:' + '\n' + '  A: x\u3000' + '\n' + 'records: {}' + '\n'],
    ['C 前导 VT', 'version: 1' + '\n' + 'refs:' + '\n' + '  A: \u000bx' + '\n' + 'records: {}' + '\n'],
    ['D 前导全角', 'version: 1' + '\n' + 'refs:' + '\n' + '  A: \u3000x' + '\n' + 'records: {}' + '\n'],
  ]) {
    const h = H(fixture)
    const ours = parseRefs(fixture).get('A')
    ok(h.errs === 0, `㉘ ${label}：夹具本身是合法 YAML`)
    ok(ours === h.refs.A, `㉘ ${label}：与本体一致（本体 ${JSON.stringify(h.refs.A)} / 我们 ${JSON.stringify(ours)}）`)
  }
}

/* ── ㉙ 七审两条必修 + 两处覆盖盲区 ── */
//
// 七审（2026-10-31）用「末行形态矩阵」与逐处变异又抓出两件事：
//   A（六审 A 的残留）`|+` 的 keep 只在「末行是空串」时减 1。末行是 `"   "`（只有
//     空格、且文件**不以换行结尾**）时它被当成真实空行计入 keep ⇒ 值多一个换行，
//     resolve→set 永久改值。修法：物理最后一行永远不算空行（`Math.max(0, len-1)`）。
//   B（新，比 A 严重）`blockScalarEnd` 不认整行注释。裸 key / plain 后面跟一行
//     **缩进不够深**的注释（`  # c`）时，注释不满足 `^ {3,}` ⇒ 判定「没有续行」⇒
//     读侧把值读成空串；写侧更糟：`set()` 一条**无关** ref 会把新行插到注释下面，
//     落盘成 `  A:` / `  # c` / `  Z: 'zzz'` / `    l3`，本体读回
//     `{"A":null,"Z":"zzz","l3":null}` —— 真实凭据被改写成 null 还多出假 key。
//     修法：`blockScalarEnd(lines, i, skipComments)`，裸 key / plain 传 true，
//     **块标量头必须传 false**（块里的 `#` 是内容）。
//
// 另补两处变异抓不到的盲区：M5b（只把多行分支的 `trimYaml(rest)` 换回 `rest.trim()`）
// 与 M8（`eof` 换成 `Math.max(0, len-1)` 的等价写法）在旧测试里都**全绿**。
{
  const H = (text) => {
    const doc = YAML.parseDocument(text, { prettyErrors: true, uniqueKeys: true })
    return { errs: doc.errors.length, refs: doc.toJS()?.refs ?? {} }
  }

  // ㉙-1 必修 1：`|+` 的 keep 不许把物理最后一行算进去。
  const PLUS_HEAD = 'version: 1' + '\n' + 'refs:' + '\n' + '  A: |+' + '\n' + '    x' + '\n'
  for (const [label, tail, want] of [
    ['末行三个空格（无尾随换行）', '   ', 'x' + '\n'],
    ['末行一个空格（无尾随换行）', ' ', 'x' + '\n'],
    ['末行三个空格 + 换行', '   ' + '\n', 'x' + '\n' + '\n'],
    ['块体末行后什么都没有（无尾随换行）', '', 'x' + '\n'],
    ['纯空格行 + 空行（无尾随换行）', '   ' + '\n' + '   ', 'x' + '\n' + '\n'],
  ]) {
    const text = PLUS_HEAD + tail
    const h = H(text)
    const ours = parseRefs(text).get('A')
    ok(h.errs === 0, `㉙ A ${label}：夹具本身是合法 YAML`)
    ok(ours === want, `㉙ A ${label}：读成 ${JSON.stringify(want)}（实际 ${JSON.stringify(ours)}）`)
  }
  // 写回面：resolve → set 不许改动值的换行数。
  for (const tail of ['   ', ' ', '   ' + '\n']) {
    const d = mkdtempSync(join(tmpdir(), 'cred-eof2-'))
    const f = join(d, '.credentials.yaml')
    writeFileSync(f, PLUS_HEAD + tail, 'utf8')
    const p = new FileCredentialProvider(fakeCtx, { file: f })
    const before = H(readFileSync(f, 'utf8')).refs.A
    const r = await p.resolve('A')
    ok(r?.value === before, `㉙ A 末行 ${JSON.stringify(tail)}：resolve 与本体一致（本体 ${JSON.stringify(before)} / 我们 ${JSON.stringify(r?.value)}）`)
    if (r !== undefined) await p.set('A', r.value)
    ok(H(readFileSync(f, 'utf8')).refs.A === before, `㉙ A 末行 ${JSON.stringify(tail)}：resolve→set 回写后值没变`)
    rmSync(d, { recursive: true, force: true })
  }

  // ㉙-2 必修 2 读侧：裸 key / plain + 浅缩进注释 + 深缩进续行，值必须读得出来。
  for (const [label, text] of [
    ['裸key + 2 空格注释', 'version: 1' + '\n' + 'refs:' + '\n' + '  A:' + '\n' + '  # c' + '\n' + '    l3' + '\n'],
    ['裸key + 0 空格注释', 'version: 1' + '\n' + 'refs:' + '\n' + '  A:' + '\n' + '# c' + '\n' + '    l3' + '\n'],
    ['裸key + 1 空格注释', 'version: 1' + '\n' + 'refs:' + '\n' + '  A:' + '\n' + ' # c' + '\n' + '    l3' + '\n'],
    ['裸key + 注释 + 空行', 'version: 1' + '\n' + 'refs:' + '\n' + '  A:' + '\n' + '  # c' + '\n' + '\n' + '    l3' + '\n'],
  ]) {
    const h = H(text)
    const ours = parseRefs(text).get('A')
    ok(h.errs === 0, `㉙ B ${label}：夹具本身是合法 YAML`)
    ok(ours === h.refs.A && ours === 'l3', `㉙ B ${label}：读成 "l3"（本体 ${JSON.stringify(h.refs.A)} / 我们 ${JSON.stringify(ours)}）`)
  }

  // ㉙-3 必修 2 写侧（最严重的那条）：set 一条无关 ref，不许把 A 写成 null 或造出假 key。
  for (const [label, text] of [
    ['七审原样（只有 A）', 'version: 1' + '\n' + 'refs:' + '\n' + '  A:' + '\n' + '  # c' + '\n' + '    l3' + '\n'],
    ['0 空格注释', 'version: 1' + '\n' + 'refs:' + '\n' + '  A:' + '\n' + '# c' + '\n' + '    l3' + '\n'],
    ['带同级 B', 'version: 1' + '\n' + 'refs:' + '\n' + '  A:' + '\n' + '  # c' + '\n' + '    l3' + '\n' + "  B: 'y'" + '\n'],
  ]) {
    const d = mkdtempSync(join(tmpdir(), 'cred-cmt-'))
    const f = join(d, '.credentials.yaml')
    writeFileSync(f, text, 'utf8')
    const p = new FileCredentialProvider(fakeCtx, { file: f })
    ok(H(text).refs.A === 'l3', `㉙ B 写侧 ${label}：夹具里 A 本来就是 "l3"`)
    await p.set('Z', 'zzz')
    const after = readFileSync(f, 'utf8')
    const h = H(after)
    ok(h.errs === 0, `㉙ B 写侧 ${label}：落盘仍是本体合法文档（${h.errs} 处错误）`)
    ok(h.refs.A === 'l3', `㉙ B 写侧 ${label}：A 还是 "l3"（实际 ${JSON.stringify(h.refs.A)}）`)
    ok(!('l3' in h.refs), `㉙ B 写侧 ${label}：没有造出假 key l3（${JSON.stringify(h.refs)}）`)
    ok(h.refs.Z === 'zzz', `㉙ B 写侧 ${label}：Z 写进去了`)
    rmSync(d, { recursive: true, force: true })
  }
  // ㉙-3c 写侧（set 替换裸 key 本身）：上面那组只测了「set 一条无关 ref」，
  // 走的是 upsertRefsInto（那侧正确传了 skipComments）。而替换裸 key 自身走的是
  // writeRefsInto。它曾经漏传 skipComments，把「裸 key + 同级注释 + 续行」写成
  // `A: 'NEW'` / `  # c` / `    l3` 的孤儿续行，本体报 2 处错误、还造出假 key l3。
  // 这组断言就是专门锁那条的——只测「set 无关 ref」的话，把那行改回漏传也全绿。
  for (const [label, text] of [
    ['裸key+2空格注释', 'version: 1' + '\n' + 'refs:' + '\n' + '  A:' + '\n' + '  # c' + '\n' + '    l3' + '\n' + "  B: 'keep'" + '\n' + 'records: {}' + '\n'],
    ['裸key+0空格注释', 'version: 1' + '\n' + 'refs:' + '\n' + '  A:' + '\n' + '# c' + '\n' + '    l3' + '\n' + "  B: 'keep'" + '\n' + 'records: {}' + '\n'],
    ['plain多行无注释', 'version: 1' + '\n' + 'refs:' + '\n' + '  A: l1' + '\n' + '    l2' + '\n' + "  B: 'keep'" + '\n' + 'records: {}' + '\n'],
    ['块标量含#', 'version: 1' + '\n' + 'refs:' + '\n' + '  A: |' + '\n' + '    x' + '\n' + '    #y' + '\n' + "  B: 'keep'" + '\n' + 'records: {}' + '\n'],
  ]) {
    const d = mkdtempSync(join(tmpdir(), 'cred-setbare-'))
    const f = join(d, '.credentials.yaml')
    writeFileSync(f, text, 'utf8')
    const p = new FileCredentialProvider(fakeCtx, { file: f })
    ok(H(text).errs === 0, `㉙ C ${label}：夹具本身是合法 YAML`)
    await p.set('A', 'NEW')
    const after = readFileSync(f, 'utf8')
    const h = H(after)
    ok(h.errs === 0, `㉙ C ${label}：set 裸 key 后仍是合法文档（${h.errs} 处错误）`)
    ok(h.refs.A === 'NEW', `㉙ C ${label}：A 已改成 NEW（实际 ${JSON.stringify(h.refs.A)}）`)
    ok(h.refs.B === 'keep', `㉙ C ${label}：B 原样留着（${JSON.stringify(h.refs)}）`)
    ok(!('l3' in h.refs) && !('l2' in h.refs) && !('x' in h.refs), `㉙ C ${label}：没有孤儿续行变成假 key（${JSON.stringify(h.refs)}）`)
    rmSync(d, { recursive: true, force: true })
  }

  // ㉙-3b 写侧（unset 的裸 key 分支）：删掉裸 key 时必须连它注释下面
  // 的续行一起吃掉，否则落盘变成 `  # c` + `    l3`，本体报 1 处错误。
  for (const [label, text] of [
    ['2 空格注释', 'version: 1' + '\n' + 'refs:' + '\n' + '  A:' + '\n' + '  # c' + '\n' + '    l3' + '\n' + "  B: 'y'" + '\n' + 'records: {}' + '\n'],
    ['0 空格注释', 'version: 1' + '\n' + 'refs:' + '\n' + '  A:' + '\n' + '# c' + '\n' + '    l3' + '\n' + "  B: 'y'" + '\n' + 'records: {}' + '\n'],
  ]) {
    const d = mkdtempSync(join(tmpdir(), 'cred-delb-'))
    const f = join(d, '.credentials.yaml')
    writeFileSync(f, text, 'utf8')
    const p = new FileCredentialProvider(fakeCtx, { file: f })
    ok(H(text).refs.A === 'l3', `㉙ B unset ${label}：夹具里 A 本来就是 "l3"`)
    await p.unset('A')
    const after = readFileSync(f, 'utf8')
    const h = H(after)
    ok(h.errs === 0, `㉙ B unset ${label}：落盘仍是本体合法文档（${h.errs} 处错误）`)
    ok(!('A' in h.refs), `㉙ B unset ${label}：A 已删掉`)
    ok(h.refs.B === 'y', `㉙ B unset ${label}：B 原样留着（${JSON.stringify(h.refs)}）`)
    ok(!('l3' in h.refs), `㉙ B unset ${label}：没有孤儿续行变成假 key（${JSON.stringify(h.refs)}）`)
    rmSync(d, { recursive: true, force: true })
  }

  // ㉙-4 反向守卫：块标量里的 `#` 是内容，跳注释不能跳到这里。
  for (const [label, text, want] of [
    ['| + x + #y', 'version: 1' + '\n' + 'refs:' + '\n' + '  A: |' + '\n' + '    x' + '\n' + '    #y' + '\n' + 'records: {}' + '\n', 'x' + '\n' + '#y' + '\n'],
    ['| 只有 #y', 'version: 1' + '\n' + 'refs:' + '\n' + '  A: |' + '\n' + '    #y' + '\n' + 'records: {}' + '\n', '#y' + '\n'],
    ['|- + x + #y', 'version: 1' + '\n' + 'refs:' + '\n' + '  A: |-' + '\n' + '    x' + '\n' + '    #y' + '\n' + 'records: {}' + '\n', 'x' + '\n' + '#y'],
  ]) {
    const ours = parseRefs(text).get('A')
    ok(ours === want, `㉙ C ${label}：块里的 # 仍是内容（实际 ${JSON.stringify(ours)}）`)
  }

  // ㉙-5 M5b 盲区：多行 plain 的**首行**也带 Unicode 空白时，得走 trimYaml 不能走 trim()。
  for (const [label, lead, want] of [
    ['前导 NBSP', '\u00a0', '\u00a0x y'],
    ['前导全角', '\u3000', '\u3000x y'],
    ['前导 VT', '\u000b', '\u000bx y'],
  ]) {
    const text = 'version: 1' + '\n' + 'refs:' + '\n' + '  A: ' + lead + 'x' + '\n' + '    y' + '\n' + 'records: {}' + '\n'
    const h = H(text)
    const ours = parseRefs(text).get('A')
    ok(h.errs === 0, `㉙ M5b ${label}：夹具本身是合法 YAML`)
    ok(ours === h.refs.A, `㉙ M5b ${label}：多行 plain 首行未被 trim 吃掉（本体 ${JSON.stringify(h.refs.A)} / 我们 ${JSON.stringify(ours)}）`)
  }
}

console.log(bad === 0 ? `\n✓ 全部通过（${total} 项：credentials.set 能新增 ref —— 新建账号写全新 ref 不再被打断）`
  : `\n✗ ${bad} 项失败（共 ${total} 项）`)
process.exit(bad === 0 ? 0 : 1)
