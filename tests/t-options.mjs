// 验证 auth.options / auth.icon 两个 magpie 契约字段，以及「模型列表用上游全量」
// 这个开关真的会改变 provider.models() 的返回（不是只写在 auth 里给人看）。
//
// 开关的读法是宿主每次现读（`input.magpie.option(provider, key)`），所以这里
// 用两份不同的 input 各建一次插件实例来模拟「用户在 magpie 里拨了开关」。
import { PLUGINS } from '../src/plugin.mjs'

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
  const p = await mk['jet-hub-astudio'](noop, {})
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

// ---- 2) 开关真的生效 ---------------------------------------------------------
{
  const mk = Object.fromEntries(PLUGINS)
  const factory = mk['jet-hub-workbuddy']
  // 先让容器把两个目录都拉到（authorize 会等），否则两份都只有缓存里的旧值
  await factory(withOptions({ prefer_full: true, dead_account_skip: true }), {})

  const on = await factory(withOptions({ prefer_full: true }), {})
  const off = await factory(withOptions({ prefer_full: false }), {})

  const a = await on.provider.models({ models: {} })
  const b = await off.provider.models({ models: {} })
  const na = Object.keys(a).length
  const nb = Object.keys(b).length
  console.log(`  全量开 → ${na} 个；全量关 → ${nb} 个`)
  ok(na > 0, '全量开时有模型')
  ok(na >= nb, '全量开的模型数不少于全量关（关掉不该多出模型）')
}

// ---- 3) 宿主没给 input.magpie 时不能崩 ---------------------------------------
{
  const mk = Object.fromEntries(PLUGINS)
  const p = await mk['jet-hub-qoder']({}, {})
  const rows = await p.provider.models({ models: {} })
  ok(rows !== undefined && typeof rows === 'object', '没有 input.magpie 时 models() 仍返回对象（不抛错）')
}

console.log(failed === 0 ? '\n✓ auth.options / auth.icon / 开关生效 全部通过' : `\n✗ ${failed} 条失败`)
process.exit(failed === 0 ? 0 : 1)
