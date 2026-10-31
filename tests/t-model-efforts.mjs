// 推理档位（模型「推理强度」下拉）链路回归。
//
// ## 为什么要有这个测试（2026-10-31 用户报「使用插件模型无法修改推理强度」）
//
// magpie 的推理强度下拉只认模型条目里的 `variants` 键列表：
//
//   宿主 `host-*.js`：`variants: Object.keys(m.variants ?? {})` → magpie `plugin.Model.Variants`
//   magpie `internal/provider/plugins.go:294`：`if m.Reasoning { c.Efforts, c.Reasoning = m.Variants, true }`
//
// 而插件此前**只发了一个布尔** `capabilities.reasoning: true`，一个档位都没发：
// `container.mjs` 的 `_absorbModels` 把 `reasoning.openai_efforts` 压成
// `openai_efforts.length > 0`。于是 magpie 认为「这模型会思考，但一档都挑不了」，
// 下拉是空的、改不动 —— 这就是用户看到的现象。
//
// 修法三条腿，本文件逐条锁住：
//   ① `src/llm-bridge.mjs` 的 `openAiEfforts()` 把本体私有档位翻成 magpie 认识的规范名；
//   ② `src/container.mjs` 两条采集腿都存 `meta.efforts`（不再压成布尔）；
//   ③ `src/plugin.mjs` 的 `modelEntry()` 把它写成 `variants`。
//
// 手法与 `t-account-cache.mjs` 一致：从源码截段用 `new Function` 求值，
// 测的是源码里真正跑的那段逻辑（抄副本的测试会在源码改坏时依然全绿）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openAiEfforts } from '../src/llm-bridge.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
// 仓库在 Windows 上是 CRLF，下面按 `\n` 拼标记，必须先归一化。
const PLUGIN = fs.readFileSync(path.join(ROOT, 'src', 'plugin.mjs'), 'utf8').replace(/\r\n/g, '\n')
const CONTAINER = fs.readFileSync(path.join(ROOT, 'src', 'container.mjs'), 'utf8').replace(/\r\n/g, '\n')

let total = 0
let bad = 0
function ok(cond, name, extra = '') {
  total += 1
  if (cond) {
    console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`)
  } else {
    bad += 1
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

/** 按标记截源码段；标记找不到就抛（静默截空会让后面全绿）。 */
function slice(text, from, to) {
  const a = text.indexOf(from)
  if (a < 0) throw new Error(`找不到起点：${JSON.stringify(from.slice(0, 60))}`)
  const b = text.indexOf(to, a + from.length)
  if (b < 0) throw new Error(`找不到终点：${JSON.stringify(to.slice(0, 60))}`)
  return text.slice(a, b)
}

/** 剥注释（源码守卫必须先剥：修复说明里会原样引用旧写法）。 */
function stripComments(code) {
  let out = ''
  let i = 0
  let quote = null
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
    if (c === '/' && n === '/') { while (i < code.length && code[i] !== '\n') i += 1; continue }
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

/** magpie `internal/provider/modelprefs.go:234` 的 `Levels`：它认识的档位全集。 */
const MAGPIE_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

// ═══════════════════════════════════════════════════════════════════════════
// ① openAiEfforts()：本体私有档位 → 规范名
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n① openAiEfforts()')

{
  // 真实形状（2026-10-31 实测 workbuddy/deepseek-v4.1-flash）
  const real = { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'high' } }
  const got = openAiEfforts(real)
  ok(JSON.stringify(got) === JSON.stringify(['low', 'high', 'max']), '① -1 真实形状翻出三档', JSON.stringify(got))

  // 私有档位名：astudio 的 none/high/max、codearts 的 off/on
  const priv = openAiEfforts({ reasoning: { efforts: [{ id: 'none' }, { id: 'high' }, { id: 'max' }] } })
  ok(priv.length === 3, '① -2 私有档位名照样翻', JSON.stringify(priv))
  const onOff = openAiEfforts({ reasoning: { efforts: [{ id: 'off' }, { id: 'on' }] } })
  ok(onOff.length > 0 && onOff.every((e) => MAGPIE_LEVELS.includes(e)), '① -3 off/on 也翻成 magpie 认识的档位', JSON.stringify(onOff))

  // 所有产出必须落在 magpie 的 Levels 里 —— 落不进去的档位 magpie 会拒（keptEfforts 抛
  // `has no reasoning level`），等于给了个挑不动的选项。
  const all = [...got, ...priv, ...onOff]
  ok(all.every((e) => MAGPIE_LEVELS.includes(e)), '① -4 产出全部落在 magpie 的 Levels 里', JSON.stringify(all))

  // 没声明 / 空数组 / null 一律空表（不猜、不发）
  ok(openAiEfforts(undefined)?.length === 0, '① -5 undefined → 空表')
  ok(openAiEfforts({})?.length === 0, '① -6 无 reasoning → 空表')
  ok(openAiEfforts({ reasoning: { efforts: [] } })?.length === 0, '① -7 空数组 → 空表')
  ok(openAiEfforts({ reasoning: { efforts: null } })?.length === 0, '① -8 null → 空表')
  ok(Array.isArray(openAiEfforts(null)), '① -9 传 null 也不抛，返数组')

  // 脏数据：非字符串 / 空串不能被带进 variants（`variants: {"": {}}` 会变成一个空选项）
  const dirty = openAiEfforts({ reasoning: { efforts: [{ id: '' }, { id: null }, { id: 'low' }, {}] } })
  ok(dirty.every((e) => typeof e === 'string' && e !== ''), '① -10 脏数据被过滤成干净字符串数组', JSON.stringify(dirty))
}

// ═══════════════════════════════════════════════════════════════════════════
// ② modelEntry()：有档位才发 variants
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n② modelEntry()')

// modelEntry 依赖 outputLimit()（OUTPUT_FALLBACKS 系列兜底），一起截进来求值。
// 截段里带着给测试用的 `export { outputLimit }`，`new Function` 不认 ESM 语法，先摘掉。
const entrySrc = slice(PLUGIN, 'const OUTPUT_FALLBACKS = [', '// ---- 共享容器与模型缓存')
  .replace(/^export \{[^}]*\}\s*$/gm, '')
const { modelEntry } = new Function(`${entrySrc}\nreturn { modelEntry }`)()

{
  const m1 = modelEntry('deepseek-v4.1-flash', undefined, { reasoning: true, efforts: ['low', 'high', 'max'] })
  ok(JSON.stringify(Object.keys(m1.variants ?? {})) === JSON.stringify(['low', 'high', 'max']), '② -1 有档位 → variants 键就是那些档位', JSON.stringify(Object.keys(m1.variants ?? {})))
  ok(m1.reasoning === true, '② -2 reasoning 仍为 true（magpie 靠它才读 variants）')

  // variants 的每个值都得是对象：宿主只取键，但 magpie 的 `plugin.Model.Variants`
  // 走 JSON 反序列化，值给 null/字符串不会崩，给成 `{low: undefined}` 会被省掉。
  ok(Object.values(m1.variants ?? {}).every((v) => v !== null && typeof v === 'object'), '② -3 variants 的值都是对象（不是 null）')

  // 会思考但没有档位：保持老行为 —— 不发 variants。发了空对象 `{}` 等于发了个空下拉，
  // 与「不知道」看着一样，但宿主会 `Object.keys({})` 得到 [] 覆盖 `was` 缓存。
  const m2 = modelEntry('x', undefined, { reasoning: true })
  ok(m2.variants === undefined, '② -4 会思考但无档位 → 不发 variants')
  ok(m2.reasoning === true, '② -5 同上，reasoning 仍 true')

  // 不思考但有档位（上游数据矛盾）：不发 —— magpie 只在 `m.Reasoning` 为真时才读
  // Variants，发了也是丢弃，反而让条目形状与 magpie 的判据不一致。
  const m3 = modelEntry('y', undefined, { reasoning: false, efforts: ['high'] })
  ok(m3.variants === undefined, '② -6 不思考 → 即使有档位也不发 variants')

  // 完全没有 meta（纯静态兜底目录）
  const m4 = modelEntry('z', { name: 'Z' }, undefined)
  ok(m4.variants === undefined && !m4.reasoning, '② -7 无 meta → 无 variants、无 reasoning')

  // 脏 efforts：不是数组就当没有（`meta.efforts` 来自缓存 JSON，可能是字符串）
  const m5 = modelEntry('w', undefined, { reasoning: true, efforts: 'low,high' })
  ok(m5.variants === undefined, '② -8 efforts 不是数组 → 当没有，不抛')
}

// ═══════════════════════════════════════════════════════════════════════════
// ③ 源码守卫：两条采集腿都必须留住档位数组
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n③ 源码守卫')

{
  const absorb = slice(CONTAINER, '  _absorbModels(json) {', '\n  }\n')
  ok(/meta\.efforts\s*=/.test(absorb), '③ -1 实时目录腿存了 meta.efforts（主修复点）')
  ok(!/meta\.reasoning\s*=\s*Array\.isArray\(m\.reasoning\?\.openai_efforts\)\s*\n?\s*\?\s*m\.reasoning\?\.openai_efforts\.length > 0/.test(stripComments(absorb))
    || /meta\.efforts/.test(absorb), '③ -2 档位不再只压成布尔')

  const full = slice(CONTAINER, '  async refreshFullCatalog(', '\n  }\n')
  ok(/openAiEfforts\(/.test(stripComments(full)), '③ -3 全量目录腿也调 openAiEfforts（这条腿直接调 resolveModelInfo，不走 modelsPayload）')
  ok(/meta\.efforts\s*=/.test(full), '③ -4 全量目录腿也存了 meta.efforts')

  // 两条腿的模型 id 形态相同（`toOpenAiModelId` = `${provider}/${model}`），
  // 所以全量腿会覆盖实时腿写的那份 meta。整体替换会把实时腿独有的字段
  // （适配器 `listModels` 声明的输入模态）抹掉 —— 症状是「照着模型列表选了
  // 能看图的模型却传不了图」。必须合并。
  ok(/\.\.\.\(this\.modelMeta\.get\(row\.id\) \?\? \{\}\)/.test(stripComments(full)), '③ -10 全量目录腿是合并旧 meta，不是整体替换（否则会抹掉输入模态）')
  ok(!/const meta = \{\}/.test(stripComments(full)), '③ -11 全量目录腿没有退回「新建空 meta」')

  const entry = slice(PLUGIN, 'function modelEntry(id, def, meta) {', '\n}\n')
  ok(/efforts/.test(stripComments(entry)), '③ -5 modelEntry 读了 meta.efforts')
  ok(/variants/.test(stripComments(entry)), '③ -6 modelEntry 写出了 variants')
  ok(/\[e, \{\}\]/.test(stripComments(entry)), '③ -7 variants 的值是空对象（只提供键）')

  // 回归锚点：这几处一旦被改回「只发布尔」，本文件必须变红。
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'llm-bridge.mjs'), 'utf8').replace(/\r\n/g, '\n')
  ok(/export function openAiEfforts/.test(bridge), '③ -8 llm-bridge 导出了 openAiEfforts')
  ok(/effortView\(/.test(stripComments(slice(bridge, 'export function openAiEfforts', '\n}\n'))), '③ -9 openAiEfforts 复用 effortView（不另写一份映射）')
}

// ═══════════════════════════════════════════════════════════════════════════
// ④ 接线：meta 表里的档位真能走到 magpie 的模型条目
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n④ metaOf → modelsOfFull 接线')

{
  // 把 `metaById` / `metaOf` / `modelsOfFull` / `modelsOf` 这一段整体截出来求值。
  // 段内还有别的函数用到没定义的全局（`cacheFile`、`readFileSync`），但它们不被调用，
  // 解析期不会报错；`new Function` 只在真正执行到那行时才 ReferenceError。
  const region = slice(PLUGIN, 'let metaById = new Map()', '// ---- 插件工厂')
    .replace(/^export \{[^}]*\}\s*$/gm, '')
    .replace(/^export /gm, '')
  // `modelsOfFull` 内部要调 `modelEntry`，而它在截段之外 —— 作为参数注入，
  // 顺带也把「接线」这件事本身锁住了（谁把 modelEntry 换了，这里就跟着换）。
  const entrySrc2 = slice(PLUGIN, 'const OUTPUT_FALLBACKS = [', '// ---- 共享容器与模型缓存')
    .replace(/^export \{[^}]*\}\s*$/gm, '')
  const { modelEntry: entry2 } = new Function(`${entrySrc2}\nreturn { modelEntry }`)()
  const { metaOf, modelsOfFull, modelsOf } = new Function('modelEntry', `${region}\nreturn { metaOf, modelsOfFull, modelsOf }`)(entry2)

  // metaById 是模块级、改不了；用 modelsOfFull 的真实实现，把行喂进去即可
  // —— 它内部靠 metaOf(id) 取 meta，而 metaById 为空时返回 undefined，
  //    于是「没 meta ⇒ 没 variants」也能一并验到。
  const rows = [
    { id: 'workbuddy/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
    { id: 'workbuddy/hy3', name: 'HY3' },
    { id: 'other/thing', name: '别的家' },
  ]
  const out = modelsOfFull('workbuddy', rows)
  ok(Object.keys(out).length === 2, '④ -1 只收本家的模型（前缀匹配）', JSON.stringify(Object.keys(out)))
  ok(out['deepseek-v4.1-flash'] !== undefined, '④ -2 键是剥掉 provider 前缀的模型名')
  ok(out['deepseek-v4.1-flash']?.variants === undefined, '④ -3 空 meta 表 ⇒ 没有 variants（不凭空造档位）')

  // 实时腿同样走 metaOf
  const liveOut = modelsOf('workbuddy', ['workbuddy/hy3', 'other/thing'])
  ok(Object.keys(liveOut).length === 1 && liveOut.hy3 !== undefined, '④ -4 实时腿也只收本家')

  ok(metaOf('不存在的 id') === undefined, '④ -5 metaOf 查不到时返 undefined（不发空对象）')
  ok(/metaById\.get\(fullId\)/.test(stripComments(region)), '④ -6 metaOf 读的就是 metaById（不是另建一份表）')
  ok(/metaOf\(id\)/.test(stripComments(region)), '④ -7 两条腿都经 metaOf 取 meta')

  // 真跑一遍完整链路：把 metaById 灌成「带档位」的样子（它是截段里的 `let`，
  // 在同一个 Function 体里可以直接赋值），再看 magpie 拿到的模型条目。
  const seeded = new Function(
    'modelEntry',
    `${region}
metaById = new Map([
  ['workbuddy/deepseek-v4.1-flash', { context: 1000000, output: 64000, input: ['text','image'], reasoning: true, efforts: ['low','high','max'] }],
  ['workbuddy/hy3', { reasoning: true, efforts: ['low','high'] }],
])
return { modelsOfFull, modelsOf }`,
  )(entry2)

  const wired = seeded.modelsOfFull('workbuddy', rows)
  ok(JSON.stringify(Object.keys(wired['deepseek-v4.1-flash']?.variants ?? {})) === JSON.stringify(['low', 'high', 'max']), '④ -8 全量腿：magpie 拿到的条目真的带三档 variants', JSON.stringify(Object.keys(wired['deepseek-v4.1-flash']?.variants ?? {})))
  ok(wired['deepseek-v4.1-flash']?.reasoning === true, '④ -9 同一条目 reasoning 为 true（magpie 靠它才读 variants）')
  ok(wired['deepseek-v4.1-flash']?.limit?.context === 1000000, '④ -10 上下文窗口照旧带出（没被档位改动挤掉）')
  ok(JSON.stringify(Object.keys(wired.hy3?.variants ?? {})) === JSON.stringify(['low', 'high']), '④ -11 另一条模型走自己的档位，不串门')

  const wiredLive = seeded.modelsOf('workbuddy', ['workbuddy/hy3'])
  ok(JSON.stringify(Object.keys(wiredLive.hy3?.variants ?? {})) === JSON.stringify(['low', 'high']), '④ -12 实时腿同样把档位带到 magpie 的条目里')
}

console.log('')
if (bad === 0) console.log(`✓ 全部通过（${total} 项）`)
else console.log(`✗ ${bad}/${total} 项失败`)
process.exit(bad === 0 ? 0 : 1)
