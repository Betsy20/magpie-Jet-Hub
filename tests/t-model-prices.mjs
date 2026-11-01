/**
 * 模型计价（`cost` 字段）的回归测试。
 *
 * ## 为什么需要
 *
 * magpie 用量页的「费用」列一直显示「—」：它算钱时调
 * `provider.ListPrice(model)`，而那条链路里的 `pricedNames()` 只按**整串**模型名
 * 查目录、不剥 `provider/` 前缀。本插件的模型 id 是 `workbuddy/deepseek-v4.1-flash`
 * 这种形状 ⇒ 目录里查不到 ⇒ 永远没有价格。
 *
 * 插件的解法是在 `provider.models()` 的条目里带 `cost`（magpie 的
 * `pluginListPrice()` → `pluginPrice()` 读它）。本文件守五件事：
 *
 * 1. 价格表本身格式正确（每条 4 个非负数字、至少 input 或 output > 0、有来源登记）；
 * 2. `cost` 的形状与 magpie 的 `plugin.Cost` 一致（`input` / `output` /
 *    `cache.read` / `cache.write`，USD / 1M tokens）；
 * 3. **表里没有就绝不发** —— magpie 的判据是 `Cost == nil || (Input <= 0 && Output <= 0)`，
 *    发一个全 0 的对象等于「确认免费」，会把「不知道」说成 0；
 * 4. 发出的价与表**逐字相等**（不是「有个数就行」）；
 * 5. **三条取数腿都挂价**：全量目录（`modelsOfFull`）、实时目录（`modelsOf`）、
 *    静态兜底（`fallbackFor`）。只验一条腿的话，另外两条漏传价格不会被发现。
 *
 * 跑法：`node tests/t-model-prices.mjs`（不联网、不碰真实 ~/.dsh）
 */
import { MODEL_PRICES, MODEL_PRICE_SRC } from '../src/model-prices.mjs'
import { fallbackFor, pickModels } from '../src/plugin.mjs'

// 测试绝不写真实 magpie 配置（2026-11-01 事故：单跑这个文件曾把用户 60 行账号写塌）
process.env.JET_HUB_NO_AUTH_SYNC = '1'

let total = 0
let bad = 0
const ok = (cond, what) => {
  total += 1
  if (cond) return
  bad += 1
  console.log(`  ✗ ${what}`)
}

/* ── 1. 表本身 ── */
console.log('价格表：')
{
  const names = Object.keys(MODEL_PRICES)
  ok(names.length > 0, `价格表非空（实际 ${names.length} 条）`)
  ok(names.length < 5000, `价格表不该大得离谱（实际 ${names.length} 条）`)
  let shapeBad = 0
  let zeroBad = 0
  for (const [name, v] of Object.entries(MODEL_PRICES)) {
    if (!Array.isArray(v) || v.length !== 4 || !v.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) {
      shapeBad += 1
      if (shapeBad <= 3) console.log(`  ✗ ${name} 的形状不是 4 个非负数字：${JSON.stringify(v)}`)
    }
    // magpie 的 pluginPrice 要求 input 或 output > 0，否则整条判成「没有价」
    if (Array.isArray(v) && !(v[0] > 0 || v[1] > 0)) {
      zeroBad += 1
      if (zeroBad <= 3) console.log(`  ✗ ${name} 的 input/output 都是 0，magpie 会判成「没有价」`)
    }
  }
  ok(shapeBad === 0, `${shapeBad} 条形状不对`)
  ok(zeroBad === 0, `${zeroBad} 条全 0`)

  // 来源登记：二审要求「这条价是谁的」可审 —— 少一条就意味着有人把价贴上去却说不出来源
  const srcNames = Object.keys(MODEL_PRICE_SRC)
  ok(
    JSON.stringify([...srcNames].sort()) === JSON.stringify([...names].sort()),
    `MODEL_PRICE_SRC 与 MODEL_PRICES 的键集必须一致（表 ${names.length} 条 / 来源 ${srcNames.length} 条）`,
  )
  const badSrc = srcNames.filter((n) => !/^(official:[a-z0-9-]+|median\(\d+\))$/.test(String(MODEL_PRICE_SRC[n])))
  ok(badSrc.length === 0, `这些条目的来源写法不认识：${badSrc.slice(0, 5).join(', ')}`)
  const officialN = srcNames.filter((n) => String(MODEL_PRICE_SRC[n]).startsWith('official:')).length
  console.log(`  ${names.length} 条，格式与取值都合规（官方直营价 ${officialN} 条 / 中位数 ${names.length - officialN} 条）`)

  // 路由名不是型号名：`auto` 这类在目录里撞上的同名条目属于别家产品，贴过来就是编数字
  for (const route of ['auto', 'standard', 'professional', 'ultimate']) {
    ok(MODEL_PRICES[route] === undefined, `路由/档位名 ${route} 不该有价（会撞上别家同名型号）`)
  }
}

/* ── 2. modelEntry 按传进来的价格决定要不要发 cost ── */
console.log('\nmodelEntry 的 cost：')
{
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../src/plugin.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  // 从源码截出 modelEntry 单独求值：它依赖 OUTPUT_FALLBACKS 与 outputLimit 这两个
  // 纯函数/常量，跟着一起截进来即可（不引入容器）。
  const slice = (from, to) => {
    const a = src.indexOf(from)
    const b = src.indexOf(to, a + from.length)
    if (a < 0 || b < 0) throw new Error(`截段失败：${from.slice(0, 40)}`)
    return src.slice(a, b)
  }
  const helpers = slice('const OUTPUT_FALLBACKS = [', 'function modelEntry(')
  const entrySrc = slice('function modelEntry(', '// ---- 共享容器与模型缓存')
  // 截出来的段里带着给测试用的 `export { outputLimit, fallbackFor }`，
  // `new Function` 不认 ESM 语法（SyntaxError: Unexpected token 'export'），先摘掉。
  const strip = (t) => t.replace(/^export \{[^}]*\}\s*$/gm, '')
  const makeEntry = new Function(`${strip(helpers)}\n${strip(entrySrc)}\nreturn modelEntry`)()
  ok(typeof makeEntry === 'function', '能从源码里截出 modelEntry 并求值')

  const priced = makeEntry('deepseek-v4.1-flash', undefined, undefined, [0.3, 1.2, 0.0075, 0])
  ok(priced?.cost !== undefined, '传了价格就该带 cost')
  ok(priced?.cost?.input === 0.3 && priced?.cost?.output === 1.2, `cost.input/output 对（实际 ${JSON.stringify(priced?.cost)}）`)
  ok(priced?.cost?.cache?.read === 0.0075, `cost.cache.read 对（实际 ${JSON.stringify(priced?.cost?.cache)}）`)
  ok(priced?.cost?.cache?.write === 0, 'cost.cache.write 缺省补 0')

  for (const [label, price] of [
    ['不传', undefined],
    ['传 null', null],
    ['传空数组', []],
    ['传全 0', [0, 0, 0, 0]],
  ]) {
    const e = makeEntry('x-model', undefined, undefined, price)
    ok(e?.cost === undefined, `${label}时不该带 cost（否则 magpie 会把「不知道」当成「免费」）`)
  }
  // 只有 input 有价、output 为 0 时也要发（magpie 判据是「任一个 > 0」）
  const half = makeEntry('y-model', undefined, undefined, [1, 0, 0, 0])
  ok(half?.cost !== undefined && half.cost.input === 1, '只有 input 有价时仍要发 cost')
}

/* ── 3. 全量目录那条腿：真跑 23 个工厂 ── */
console.log('\n接进 provider.models()（全量目录）：')
{
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-price-home-'))
  fs.mkdirSync(path.join(TMP, '.dsh'), { recursive: true })
  const prevHome = process.env.DSH_HOME
  const prevState = process.env.DSH_JET_HUB_STATE_DIR
  process.env.DSH_HOME = path.join(TMP, '.dsh')
  process.env.DSH_JET_HUB_STATE_DIR = TMP
  process.env.JET_HUB_NO_ADDR_FILE = '1'
  try {
    const mod = await import('file://' + ROOT.replace(/\\/g, '/') + '/index.mjs')
    let rows = 0
    let withCost = 0
    let wrongShape = 0
    const missingCost = []
    const extraCost = []
    const mismatched = []
    for (const [id, fn] of Object.entries(mod)) {
      if (typeof fn !== 'function') continue
      const p = await fn({ client: { app: { log: () => {} } } }, { home: TMP })
      const models = (await p.provider.models({})) ?? {}
      for (const [bare, entry] of Object.entries(models)) {
        rows += 1
        const want = MODEL_PRICES[bare]
        if (entry?.cost === undefined) {
          // 表里有价、条目却没挂 ⇒ 有一条腿漏传了价格
          if (want !== undefined) missingCost.push(`${id}/${bare}`)
          continue
        }
        withCost += 1
        const c = entry.cost
        const got = [c.input, c.output, c.cache?.read, c.cache?.write]
        if (!got.every((n) => typeof n === 'number') || !(c.input > 0 || c.output > 0)) wrongShape += 1
        // 表里没有价、条目却挂了 ⇒ 有人编了数字
        if (want === undefined) {
          extraCost.push(`${id}/${bare} 实=${JSON.stringify(got)}`)
          continue
        }
        // 挂了价就要与表逐字相等（「有个数就行」会让打折、缩放这类错位蒙混过去）
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          mismatched.push(`${id}/${bare} 表=${JSON.stringify(want)} 实=${JSON.stringify(got)}`)
        }
      }
    }
    ok(rows > 0, `拿到模型条目（实际 ${rows}）`)
    ok(withCost > 0, `有模型带上了 cost（实际 ${withCost} / ${rows}）`)
    ok(wrongShape === 0, `${wrongShape} 个条目的 cost 形状不对`)
    ok(missingCost.length === 0, `这些模型价格表里有、却没挂上 cost：${missingCost.slice(0, 5).join(', ')}`)
    ok(extraCost.length === 0, `这些模型价格表里没有、却挂了 cost（编数字）：${extraCost.slice(0, 5).join(', ')}`)
    ok(mismatched.length === 0, `这些模型的 cost 与价格表不一致：${mismatched.slice(0, 5).join(' | ')}`)
    console.log(`  ${withCost} / ${rows} 个模型带上了目录价`)
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    if (prevState === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
    else process.env.DSH_JET_HUB_STATE_DIR = prevState
    fs.rmSync(TMP, { recursive: true, force: true })
  }
}

/* ── 4. 另外两条腿：实时目录与静态兜底 ── */
console.log('\n接进另外两条腿（实时目录 / 静态兜底）：')
{
  // 实时腿（`modelsOf`）：容器刚起、全量还没拉到时走这条。
  const liveMiss = pickModels('codearts', { live: ['codearts/standard'] })
  ok(
    liveMiss?.models?.standard?.cost === undefined,
    `实时腿：表里没有 standard 却挂了 cost ${JSON.stringify(liveMiss?.models?.standard?.cost)}`,
  )
  const liveHit = pickModels('codearts', { live: ['codearts/deepseek-v4.1-flash'] })
  const liveCost = liveHit?.models?.['deepseek-v4.1-flash']?.cost
  ok(liveCost !== undefined, '实时腿：表里有价却没挂 cost')
  // 只断言「有 cost」不够 —— 实时腿把价打了折、或换了个数，一样会漏过去。
  // 三条腿的值必须与表逐字相等。
  const liveWant = MODEL_PRICES['deepseek-v4.1-flash']
  ok(
    liveCost !== undefined
      && JSON.stringify([liveCost.input, liveCost.output, liveCost.cache?.read, liveCost.cache?.write])
        === JSON.stringify(liveWant),
    `实时腿的价与表不一致：表=${JSON.stringify(liveWant)} 实=${JSON.stringify(liveCost)}`,
  )

  // 静态兜底腿（`fallbackFor`）：两份目录都空时走这条，是最容易被漏掉的一条。
  // 只测一家不够：每家的静态兜底恰好只有 1 个模型，
  // 只选一家的话「表里没价却挂了 cost」这条断言恒为空。
  // 注意：三家的模型名互不相同，合并不会互相覆盖。
  const fb = Object.assign({}, ...['codearts', 'loomy', 'qoder'].map((p) => fallbackFor(p)))
  const fbNames = Object.keys(fb)
  ok(fbNames.length > 0, `静态兜底有模型（实际 ${fbNames.length}）`)
  const fbMissing = fbNames.filter((n) => MODEL_PRICES[n] !== undefined && fb[n].cost === undefined)
  const fbExtra = fbNames.filter((n) => MODEL_PRICES[n] === undefined && fb[n].cost !== undefined)
  ok(fbMissing.length === 0, `静态兜底：表里有价却没挂 cost：${fbMissing.join(', ')}`)
  ok(fbExtra.length === 0, `静态兜底：表里没价却挂了 cost（编数字）：${fbExtra.join(', ')}`)
  const fbMismatch = fbNames.filter((n) => {
    if (fb[n].cost === undefined) return false
    const c = fb[n].cost
    return JSON.stringify([c.input, c.output, c.cache?.read, c.cache?.write]) !== JSON.stringify(MODEL_PRICES[n])
  })
  ok(fbMismatch.length === 0, `静态兜底的价与表不一致：${fbMismatch.join(', ')}`)
  const fbPriced = fbNames.filter((n) => fb[n].cost !== undefined)
  console.log(`  静态兜底 ${fbNames.length} 个模型，其中 ${fbPriced.length} 个带价`)
}

console.log(
  bad === 0
    ? `\n✓ 全部通过（${total} 项：表格式与来源 / cost 形状 / 不编数字 / 与表逐字相等 / 三条腿都挂价）`
    : `\n✗ ${bad} 项失败（${total} 项）`,
)
process.exit(bad === 0 ? 0 : 1)
