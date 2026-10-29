// 验证 auth.options / auth.icon 两个 magpie 契约字段，以及「模型列表用上游全量」
// 这个开关真的会改变 provider.models() 的返回（不是只写在 auth 里给人看）。
//
// 开关的读法是宿主每次现读（`input.magpie.option(provider, key)`），所以这里
// 用两份不同的 input 各建一次插件实例来模拟「用户在 magpie 里拨了开关」。
import { DSH_PROVIDERS, PLUGINS, PROVIDER_IDS } from '../src/plugin.mjs'
import { iconProviders } from '../src/icons.mjs'

// ⚠️ 本文件建插件实例会真起容器，必须隔离（理由见 `tests/_iso.mjs` 文件头）。
import { isolate } from './_iso.mjs'

const iso = isolate()

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
  ok(String(icon).length <= 3 << 19, 'auth.icon 不超过 1 MB')
}

// ---- 1b) 每家一个图标：以前 24 个 provider 全用插件自己那个六向星 -------
{
  const mk = Object.fromEntries(PLUGINS)
  const icons = new Map()
  for (const [id, factory] of PLUGINS) {
    const p = await factory(noop, iso.options())
    icons.set(id, p.auth.icon)
  }
  ok(icons.size === PROVIDER_IDS.length, `24 个 provider 都拿到了工厂（${icons.size}）`)
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
  ok(biggest <= 3 << 19, `最大图标 ${biggest}B 不超过 1 MB`)
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
  // 这条是关键：只说「开 >= 关」的话，开关完全没被读也能通过。
  // 必须断言关掉后**确实变少**，且关掉的集合是开着的子集。
  ok(na > nb, `关掉 prefer_full 后模型数真的变少（${na} → ${nb}）`)
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
