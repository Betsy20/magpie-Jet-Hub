// `scripts/snapshot-models.mjs` 的 `magpieIdOfSegment()` 判据回归。
//
// ## 为什么要有这个测试（2026-10-31 实测真缺陷）
//
// 快照脚本有三条取数路：宿主 `/__meta`（主路，本体名）、插件缓存（本体名）、
// 网关 `/v1/models`（兜底）。前两条的 id 形如 `workbuddy/xxx`（本体 provider 名），
// 需要过 `idOf()` 加 `jet-hub-` 前缀；但**网关那条返回的分段两种形态混着来**：
//
//   ① 已带前缀：`jet-hub-magicrew/…`、`jet-hub-workbuddy/…`  —— 实测 28 条
//   ② 仍是本体名：`workbuddy/…`、`officeace/…`、`zcode/…`     —— 实测 16 条
//
// 而这两组**完全不重叠**（同一批数据里 `REGISTERED.has(seg)` 与
// `REGISTERED.has(idOf(seg))` 的交集是 0）。所以：
//   · 只用 ②（无条件 `idOf()`）→ ① 那 28 条拼成 `jet-hub-jet-hub-*`，全丢；
//   · 只用 ①（分段直接比白名单）→ ② 那 16 条全丢。
// 两种都错，正确判据是**并集**：先试 ①，再试 ②，都不中才算「不是本插件的」。
//
// 这个测试从源码文本切出 `magpieIdOfSegment` 求值，不复制粘贴实现。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DSH_PROVIDERS, idOf } from '../src/plugin.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'snapshot-models.mjs'), 'utf8').replace(/\r\n/g, '\n')

let total = 0
let bad = 0
function ok(cond, message) {
  total += 1
  if (cond) {
    console.log(`  ✓ ${message}`)
  } else {
    bad += 1
    console.log(`  ✗ ${message}`)
  }
}

/** 从源码切出 `magpieIdOfSegment` 并用真实的 REGISTERED/idOf 求值。 */
function loadSegmentFn() {
  const from = SRC.indexOf('function magpieIdOfSegment(')
  if (from < 0) return undefined
  const to = SRC.indexOf('\n}\n', from)
  if (to < 0) return undefined
  const fnSrc = SRC.slice(from, to + 3)
  const REGISTERED = new Set(DSH_PROVIDERS.map(idOf))
  // eslint-disable-next-line no-new-func
  const build = new Function('REGISTERED', 'idOf', `${fnSrc}\nreturn magpieIdOfSegment`)
  return build(REGISTERED, idOf)
}

const seg = loadSegmentFn()

console.log('\n[1] 能从源码切出 magpieIdOfSegment 并求值')
ok(typeof seg === 'function', `切出来是个函数（实际 ${typeof seg}）`)
ok(SRC.includes('function magpieIdOfSegment('), '源码里有这个函数')
ok(/magpieIdOfSegment\(String\(r\.id\)\.split\('\/'\)\[0\]\)/.test(SRC), '网关兜底的 filter 用的是它，不是内联的单一判据')
ok(/const head = magpieIdOfSegment\(seg\)/.test(SRC), 'byId.set 那处也用它归一前缀')

if (typeof seg !== 'function') {
  console.log(`\n✗ ${bad} 项失败：切不出 magpieIdOfSegment，后面的行为断言无法进行`)
  process.exit(1)
}

console.log('\n[2] ① 已带前缀的分段原样通过（网关 28 条那一组）')
for (const p of ['workbuddy', 'magicrew', 'officeace', 'zcode', 'trae', 'modelscope']) {
  const withPrefix = idOf(p)
  ok(seg(withPrefix) === withPrefix, `seg('${withPrefix}') === '${withPrefix}'`)
}

console.log('\n[3] ② 本体名的分段加上前缀（网关 16 条那一组）')
for (const p of ['workbuddy', 'magicrew', 'officeace', 'zcode', 'trae', 'modelscope', 'accIo'.toLowerCase()]) {
  if (!DSH_PROVIDERS.includes(p)) continue
  ok(seg(p) === idOf(p), `seg('${p}') === '${idOf(p)}'`)
}

console.log('\n[4] 两组判据确实不重叠 —— 这正是需要并集的原因')
{
  // 用真实的 23 家里随便挑一家构造：带前缀的形态与本体名形态，各自只被一种判据命中。
  const REGISTERED = new Set(DSH_PROVIDERS.map(idOf))
  const sample = DSH_PROVIDERS[0]
  const withPrefix = idOf(sample)
  ok(REGISTERED.has(withPrefix) && !REGISTERED.has(idOf(withPrefix)), `'${withPrefix}'：① 命中、② 不命中`)
  ok(!REGISTERED.has(sample) && REGISTERED.has(idOf(sample)), `'${sample}'：② 命中、① 不命中`)
}

console.log('\n[5] 不是本插件的分段一律 null（网关里那 12 条）')
for (const notOurs of ['group', 'auto', 'workbuddy-ai', 'trae-cn', 'trae-global', 'qoder-cn', 'autoclaw-cn', 'magicrew-intl', '']) {
  ok(seg(notOurs) === null, `seg('${notOurs}') === null（实际 ${JSON.stringify(seg(notOurs))}）`)
}
ok(seg(undefined) === null, 'seg(undefined) === null')
ok(seg(null) === null, 'seg(null) === null')

console.log('\n[6] 组合起来：两组合计一条不丢、坏 id 一个不出')
{
  // 造一批混合 id，模拟网关实测的 56 条形态。
  const ours = DSH_PROVIDERS.slice(0, 5)
  const raw = [
    ...ours.map((p) => `${idOf(p)}/with-prefix-model`),
    ...ours.map((p) => `${p}/bare-model`),
    'group/auto',
    'auto/auto',
    'workbuddy-ai/x',
  ]
  const kept = []
  for (const r of raw) {
    const i = r.indexOf('/')
    const head = seg(r.slice(0, i))
    if (head === null) continue
    kept.push(`${head}/${r.slice(i + 1)}`)
  }
  ok(kept.length === ours.length * 2, `两种形态各 ${ours.length} 条都保留（实际 ${kept.length} / 期望 ${ours.length * 2}）`)
  ok(kept.every((k) => !/^jet-hub-jet-hub-/.test(k)), '没有 jet-hub-jet-hub-* 这种双重前缀坏 id')
  const heads = new Set(kept.map((k) => k.split('/')[0]))
  const REGISTERED = new Set(DSH_PROVIDERS.map(idOf))
  ok([...heads].every((h) => REGISTERED.has(h)), '保留下来的每个分段都在白名单里')
  ok(
    kept.filter((k) => k.endsWith('/with-prefix-model')).length === ours.length &&
      kept.filter((k) => k.endsWith('/bare-model')).length === ours.length,
    '两种来源的模型一条都没丢',
  )
}

console.log(`\n${bad === 0 ? '✓' : '✗'} ${bad === 0 ? '全部通过' : `${bad} 项失败`}（${total} 项：快照脚本的分段归一 —— 带前缀与本体名两种形态都要认，判据是并集）`)
process.exit(bad === 0 ? 0 : 1)
