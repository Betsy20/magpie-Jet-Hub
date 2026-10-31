// 验证 auth.options / auth.icon 两个 magpie 契约字段，以及「模型列表用上游全量」
// 这个开关真的会改变 provider.models() 的返回（不是只写在 auth 里给人看）。
//
// 开关的读法是宿主每次现读（`input.magpie.option(provider, key)`），所以这里
// 用两份不同的 input 各建一次插件实例来模拟「用户在 magpie 里拨了开关」。
import { DSH_PROVIDERS, PLUGINS, PROVIDER_IDS, pickModels } from '../src/plugin.mjs'
import { iconProviders } from '../src/icons.mjs'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ⚠️ 本文件建插件实例会真起容器，必须隔离（理由见 `tests/_iso.mjs` 文件头）。
import { isolate } from './_iso.mjs'

const iso = isolate()

// 给模型缓存种一份假目录：`src/plugin.mjs` 的 `cacheFileOf()` 现在按 `homedir()`
// 现算（改 USERPROFILE/HOME 即改道），所以这里写进沙箱，绝不会碰
// 真实 `~/.config/magpie/jet-hub-models.json`。干净机器（没有真实缓存）上，
// 这份种子保证容器级那段至少能拿到模型；真实上游起来后会被后台刷新覆盖。
mkdirSync(join(iso.root, '.config', 'magpie'), { recursive: true })
writeFileSync(
  join(iso.root, '.config', 'magpie', 'jet-hub-models.json'),
  JSON.stringify({
    at: new Date().toISOString(),
    models: ['workbuddy/wb-seed-live'],
    full: [{ id: 'workbuddy/wb-seed-live', name: 'WB Seed' }],
    meta: {},
  }),
)

let failed = 0
const ok = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) failed += 1
}

const noop = { client: { app: { log: () => {} } } }
const withOptions = (values) => ({ ...noop, magpie: { option: (p, k) => values[k] === true } })

// ---- 1) 契约形状 -------------------------------------------------------------
{
  const mk = Object.fromEntries(PLUGINS)
  const p = await mk['jet-hub-astudio'](noop, iso.options())
  const opts = p.auth.options
  ok(Array.isArray(opts) && opts.length > 0, `auth.options 是数组（${opts?.length} 项）`)
  ok(opts.length <= 16, 'auth.options 不超过 MAX_OPTIONS=16')
  const KEY = /^[a-z0-9_-]{1,40}$/
  ok(opts.every((o) => KEY.test(o.key)), '每个 option.key 都符合 [a-z0-9_-]{1,40}')
  ok(opts.every((o) => typeof o.label === 'string' && o.label.length > 0 && o.label.length <= 60), '每个 label 非空且 ≤60 字')
  ok(new Set(opts.map((o) => o.key)).size === opts.length, 'option.key 无重复')

  const icon = p.auth.icon
  ok(typeof icon === 'string' && /^(https:\/\/|data:image\/)/i.test(icon), `auth.icon 是 data:image 或 https（${String(icon).slice(0, 24)}…）`)
  ok(String(icon).length <= 1 << 20, 'auth.icon 不超过 1 MB')
}

// ---- 1b) 每家一个图标：以前所有 provider 全用插件自己那个六向星 -------
{
  const mk = Object.fromEntries(PLUGINS)
  const icons = new Map()
  for (const [id, factory] of PLUGINS) {
    const p = await factory(noop, iso.options())
    icons.set(id, p.auth.icon)
  }
  ok(icons.size === PROVIDER_IDS.length, `${PROVIDER_IDS.length} 个 provider 都拿到了工厂（${icons.size}）`)
  const covered = new Set(iconProviders())
  const noIcon = DSH_PROVIDERS.filter((p) => !covered.has(p))
  ok(noIcon.length === 0, `每个 provider 都登记了图标（缺：${noIcon.join(', ')}）`)
  // ZCode 只有官方 PNG，所以这里要求「内联图像」而不是「内联 SVG」
  ok(
    [...icons.values()].every((v) => typeof v === 'string' && v.startsWith('data:image/')),
    '每个 provider 的 icon 都是内联图像（离线可显示）',
  )
  const byUri = new Map()
  for (const [id, v] of icons) {
    if (!byUri.has(v)) byUri.set(v, [])
    byUri.get(v).push(id)
  }
  const same = [...byUri.values()].filter((ids) => ids.length > 1)
  ok(same.length === 0, `每家图标互不相同（重复：${same.map((ids) => ids.join('=')).join(', ')}）`)
  const biggest = Math.max(...[...icons.values()].map((v) => v.length))
  ok(biggest <= 1 << 20, `最大图标 ${biggest}B 不超过 1 MB`)
}

// ---- 2a) prefer_full 的语义（纯函数 + 固定数据）-------------------------------
// 容器级断言只能证明「接线没断」，证明不了语义：上游此刻有没有「不可用模型」
// 取决于数据状态 —— 2026-10-31 清空 920 条黑名单之后，全量目录与可用目录是
// 同一个集合（workbuddy 恒 32/32），「关掉后变少」根本无从发生，那条断言等于
// 没跑过（变异把 `optionOn('prefer_full', true)` 写死也照样绿）。语义由这里钉死。
{
  const live = ['workbuddy/wb-live']
  const full = [
    { id: 'workbuddy/wb-live', name: 'WB Live' },
    { id: 'workbuddy/wb-gone', name: 'WB Gone', disabled: true },
  ]

  const wide = pickModels('workbuddy', { live, full }, true)
  const wideKeys = Object.keys(wide?.models ?? {})
  ok(wide?.from === 'full', `全量开 → 用上游全量目录（from=${wide?.from}）`)
  ok(wideKeys.length === 2, `全量开 → 上游全部 2 个都列出（实数 ${wideKeys.length}）`)
  ok(
    String(wide?.models?.['wb-gone']?.name ?? '').includes('已在 Jet Hub 关闭'),
    `全量开 → 已关闭的模型名字带后缀（${wide?.models?.['wb-gone']?.name}）`,
  )

  const narrow = pickModels('workbuddy', { live, full }, false)
  const narrowKeys = Object.keys(narrow?.models ?? {})
  ok(narrow?.from === 'live', `全量关 → 退回实时可用目录（from=${narrow?.from}）`)
  ok(narrowKeys.length === 1, `全量关 → 只剩可用的 1 个（实数 ${narrowKeys.length}）`)
  ok(narrowKeys[0] === 'wb-live', `全量关 → 剩下的正是可用那个（${narrowKeys[0]}）`)

  ok(pickModels('workbuddy', { live: [], full: [] }, true) === null, '两份目录都空 → 返回 null 交给静态兜底')
  ok(pickModels('trae', { live, full }, true) === null, '目录里没有这家 → 返回 null（不串到别家）')
  ok(pickModels('workbuddy', {}, true) === null, '没传目录 → 返回 null（不抛错）')
}

// ---- 2b) 开关真的接到了 currentModels（接线，不是语义）-------------------------
// 2a 段证明 `pickModels` 的两个分支各自正确，但证明不了「工厂里真的把 magpie
// 开关读出来传进去」—— 把 `optionOn('prefer_full', true)` 换成恒 true，2a 全绿。
// 容器级那段又只能冒烟（上游没有不可用模型时全量与可用同集合）。所以这里对
// `currentModels` 的函数体做文本断言：它必须同时出现「读开关」与「把开关值当
// 第三参传给 pickModels」。
{
  const raw = readFileSync(new URL('../src/plugin.mjs', import.meta.url), 'utf8')
  // ⚠️ 必须先归一化行尾：仓库里 plugin.mjs 是 LF，但 autocrlf 检出后会变 CRLF，
  //    不归一化的话下面的 `\n    }` 定位全落空（踩过）。
  const src = raw.replace(/\r\n/g, '\n')
  const at = src.indexOf('function currentModels(provider)')
  ok(at > 0, '在 src/plugin.mjs 里找到 currentModels')
  const body = src.slice(at, src.indexOf('\n    }', at))
  ok(/optionOn\('prefer_full',\s*true\)/.test(body), 'currentModels 里真的读了 prefer_full 开关（不是恒值）')
  ok(
    /pickModels\(\s*dshProvider,\s*\{ live, full \},\s*optionOn\('prefer_full',\s*true\)\s*\)/.test(body),
    'currentModels 把开关值作为第 3 参传给 pickModels（接线完整）',
  )
  ok(/picked\?\.models\s*\?\?/.test(body), 'currentModels 用 pickModels 的结果、空时退回调用方给的兜底')
}

// ---- 2) 开关真的生效 ---------------------------------------------------------
{
  const mk = Object.fromEntries(PLUGINS)
  const factory = mk['jet-hub-workbuddy']
  // 先让容器把两个目录都拉到（authorize 会等），否则两份都只有缓存里的旧值
  await factory(withOptions({ prefer_full: true, dead_account_skip: true }), iso.options())

  const on = await factory(withOptions({ prefer_full: true }), iso.options())
  const off = await factory(withOptions({ prefer_full: false }), iso.options())

  const a = await on.provider.models({ models: {} })
  const b = await off.provider.models({ models: {} })
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  const na = ka.length
  const nb = kb.length
  console.log(`  全量开 → ${na} 个；全量关 → ${nb} 个`)
  ok(na > 0, '全量开时有模型')
  // 容器级只做冒烟。开关语义由上面 2a 段对 `pickModels` 的固定数据断言覆盖；
  // 这里不断言「关掉后变少」—— 上游没有不可用模型时全量与可用同集合，硬断言
  // 会变成长期假红，而软跳过又会让这条断言永远不执行（两种都是假绿）。
  // 能抓的是接线级错误：关掉后凭空多出模型（子集断言）与整段拿不到东西。
  const setA = new Set(ka)
  ok(kb.every((k) => setA.has(k)), '关掉后列出的模型是「全量」的子集（只筛掉，不凭空多出）')
}

// ---- 2b) dead_account_skip 真的接到了容器（不是死代码）------------------------
// t-dead-account 验的是容器侧契约：`deadSkipCheck(provider)` 回 false 就放行死号。
// 但「magpie 开关 → container.deadSkipCheck」这段接线只在 plugin.mjs 里，
// 没有测试就可能是死代码。这里用假 input 拨开关，直接问真容器的回调要答案。
{
  const mk = Object.fromEntries(PLUGINS)

  const plugOn = await mk['jet-hub-codearts'](withOptions({ dead_account_skip: true }), iso.options())
  const plugOff = await mk['jet-hub-codearts'](withOptions({ dead_account_skip: false }), iso.options())

  // 工厂内部是模块级单例容器，所以两个插件对象拿到的是同一个实例；
  // 最后一次工厂调用的闭包生效（同一宿主下 input 是同一份）。
  const c = plugOn._internal?.container ?? plugOff._internal?.container
  ok(c !== undefined, '插件对象暴露了容器实例（_internal.container）')
  ok(typeof c?.deadSkipCheck === 'function', '容器上挂了 deadSkipCheck 回调')

  // 拨到 false 后问回调：必须回 false（= 放行死号）。
  const offVal = c.deadSkipCheck('codearts')
  ok(offVal === false, `开关拨到 false 时 deadSkipCheck('codearts') === false（实测 ${String(offVal)}）`)
  // 其它 provider 不受影响（开关是按 provider 拨的）。
  const otherVal = c.deadSkipCheck('qoder')
  ok(otherVal !== false, `其它 provider 仍跳过死号（deadSkipCheck('qoder') = ${String(otherVal)}）`)

  // 再拨回 true，同一个容器的回调必须立刻变回真（现读，不用重启）。
  const plugBack = await mk['jet-hub-codearts'](withOptions({ dead_account_skip: true }), iso.options())
  const backVal = (plugBack._internal?.container ?? c).deadSkipCheck('codearts')
  ok(backVal !== false, `拨回 true 后立即恢复过滤（实测 ${String(backVal)}）`)
}


// ---- 3) 宿主没给 input.magpie 时不能崩 ---------------------------------------
{
  const mk = Object.fromEntries(PLUGINS)
  const p = await mk['jet-hub-qoder']({}, iso.options())
  const rows = await p.provider.models({ models: {} })
  ok(rows !== undefined && typeof rows === 'object', '没有 input.magpie 时 models() 仍返回对象（不抛错）')
}

console.log(failed === 0 ? '\n✓ auth.options / auth.icon / 开关生效 全部通过' : `\n✗ ${failed} 条失败`)
process.exit(failed === 0 ? 0 : 1)
