/**
 * Key 型渠道（modelscope / opencode）的「贴 Key 新建」方法 —— 行为级回归。
 *
 * 这两家没有 `account.create`（会回 `unknown provider`），上游 UI 走的是各自的
 * `*.addAccount`。本插件照抄同一条路：一条 `api` 型 + `keyless: true` 的方法，
 * 用 `ask()` 收 Key，在 `authorize(inputs)` 里调 `container.rpc('xxx.addAccount')`。
 *
 * ## 这里刻意**不写**「查源码文本」的静态断言
 *
 * 第一版用过 `src.slice(i, j + 900)` 这类字符窗口 + 正则。2026-11-01 两轮审查
 * 各抓出一种假绿（注释里的字样就能骗过；把真调用换成 `container.rpc` 只留注释字样
 * 仍全绿）与四种假红（签名改跨行、纯重构改名、错误消息里出现一个 `}`、
 * `apiKey: undefined` 挪出 `metadata` 后测试仍绿而明文真落盘）。
 * ⇒ 全部改成**行为级**：真跑工厂、真调 `authorize()`，断言它产生的**数据结构**。
 *
 * ## 守的六件事（错了用户会卡住或泄漏密钥）
 *
 * 1. `keyless: true` —— 否则 magpie 会先弹它自己的 key 框，而那个框的值**不会**
 *    传给 `authorize(inputs)`（宿主 `save()` 只把 inputs 当 metadata），用户粘完
 *    Key 会得到「没填 API Key」且无法自救。
 * 2. `ask()` 返回 `type: 'password'`、`key` 是 `KEY_INPUT`、答过之后返回 null。
 * 3. `ask()` 对**纯空格**不能算「答过」—— 否则用户粘了一串空白就永久卡死
 *    （`ask()` 永远 null、`authorize()` 永远抛，界面回不到输入框）。
 * 4. `authorize()` 调的是**本家**的 `*.addAccount`（给 opencode 一把不以 `ms-`
 *    开头的 Key，若误调到 modelscope 会当场报形状错）。
 * 5. 返回的 `key` 里编进了账号 id（宿主判重靠 key 字符串相等）。
 * 6. **明文 Key 不能落进 `plugin-auth.json`** —— 宿主 `save()` 是
 *    `{ ...inputs, ...result.metadata }`，插件必须用同名键把 `inputs.apiKey` 盖掉。
 *    这条按宿主真实合并逻辑 + `JSON.stringify` 断言**最终记录**，不看源码文本。
 *
 * 跑法：`node tests/t-key-account.mjs`（不联网；容器冷启动约 20–30 秒；
 * 全程在临时 home 里，不碰真实 `~/.dsh`）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.JET_HUB_NO_ADDR_FILE = '1'

// 路径含空格/中文时 `pathname` 会被百分号编码，用 fileURLToPath。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src', 'plugin.mjs')
const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n')

let total = 0
let bad = 0
const ok = (cond, what) => {
  total += 1
  if (cond) return
  bad += 1
  console.log(`  ✗ ${what}`)
}

/**
 * 照抄宿主 `save()` 的 api 分支（magpie 的 `internal/plugin/host.js`）：
 *   const md = { ...(inputs && Object.keys(inputs).length ? inputs : {}), ...(result.metadata ?? {}) }
 *   setAuth(key, { type: "api", key: result.key ?? apiKey, ...(md 非空 ? { metadata: md } : {}) })
 * 再按宿主写盘那样 `JSON.stringify`。**顺序不能改**：inputs 在前、metadata 在后，
 * 「盖掉同名键」正是靠这个顺序 + `undefined` 被 JSON 丢弃。
 */
function hostRecord(provider, result, inputs, apiKey) {
  const md = { ...(inputs && Object.keys(inputs).length ? inputs : {}), ...(result.metadata ?? {}) }
  const record = { type: 'api', key: result.key ?? apiKey, ...(Object.keys(md).length ? { metadata: md } : {}) }
  return { record, disk: JSON.stringify({ [provider]: record }, null, 2) }
}

/** 各家一把**形状合法**的假 Key —— 只为把流程走通，不联网校验。 */
const FAKE_KEY = {
  // modelscope：^ms-[A-Za-z0-9_-]{16,}$
  modelscope: 'ms-' + 'A'.repeat(20),
  // opencode：^[A-Za-z0-9_.-]{20,}$ —— 刻意**不以 ms- 开头**，调错 RPC 会当场报错
  opencode: 'B'.repeat(24),
}

/* ── 1. 源码里能解析出 KEY_ACCOUNT_RPC / NO_NEW_ACCOUNT（真源，不抄名单） ── */
console.log('KEY_ACCOUNT_RPC：')
{
  const m = src.match(/const KEY_ACCOUNT_RPC = new Map\(\[([\s\S]*?)\]\)/)
  ok(m !== null, '能从 src/plugin.mjs 里解析出 KEY_ACCOUNT_RPC')
  const pairs = [...(m?.[1] ?? '').matchAll(/\[\s*'([^']+)'\s*,\s*'([^']+)'\s*\]/g)].map((x) => [x[1], x[2]])
  ok(pairs.length === 2, `应恰好 2 家（实际 ${pairs.length}）`)
  const map = new Map(pairs)
  ok(map.get('modelscope') === 'modelscope.addAccount', `modelscope → ${map.get('modelscope')}`)
  ok(map.get('opencode') === 'opencode.addAccount', `opencode → ${map.get('opencode')}`)
  // 与 NO_NEW_ACCOUNT 必须一致：不能走 account.create 的正是走 addAccount 的
  const nona = src.match(/const NO_NEW_ACCOUNT = new Set\(\[([^\]]*)\]\)/)
  const nonaSet = new Set((nona?.[1] ?? '').split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean))
  ok(
    [...map.keys()].sort().join(',') === [...nonaSet].sort().join(','),
    `KEY_ACCOUNT_RPC 与 NO_NEW_ACCOUNT 是同一批：${[...map.keys()].sort().join(',')} / ${[...nonaSet].sort().join(',')}`,
  )
}

/* ── 2. 真跑工厂，逐条方法验行为 ── */
console.log('\n方法行为（真容器 + 临时 home）：')
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-keyacct-home-'))
fs.mkdirSync(path.join(TMP_HOME, '.dsh'), { recursive: true })
// ⚠️ 必须先建好这个文件：本体写凭据走的是「 copyFileSync 到 .bak → 写临时文件 → rename」，
// 文件不存在时会抛 ENOENT。真实機器上 DSH 安装后它一定在；空 home 场景要自己造。
// 内容必须带 `refs:` 段（空文件会报「找不到 refs: 段」）。
fs.writeFileSync(path.join(TMP_HOME, '.dsh', '.credentials.yaml'), 'refs:\n')
process.env.DSH_HOME = path.join(TMP_HOME, '.dsh')
process.env.DSH_JET_HUB_STATE_DIR = TMP_HOME

try {
  const mod = await import(`file://${SRC.replace(/\\/g, '/').replace('/src/plugin.mjs', '/index.mjs')}`)
  const seen = []
  for (const [name, fn] of Object.entries(mod)) {
    if (typeof fn !== 'function') continue
    const p = await fn({ client: { app: { log: () => {} } } }, { home: TMP_HOME })
    // 与 tests/t-new-account.mjs 同一条判据：**第二条** api+keyless+有 ask。
    // 不看 label（改文案会假红）、也不只看结构（第一条接已有账号也长这样）。
    const methods = p.auth.methods ?? []
    const keyed = methods.length > 1
      ? methods.find((x, i) => i > 0 && x.type === 'api' && x.keyless === true && typeof x.ask === 'function')
      : undefined
    if (!keyed) continue
    const provider = p.auth.provider
    const dshProvider = provider.replace(/^jet-hub-/, '')
    const fakeKey = FAKE_KEY[dshProvider]
    seen.push(provider)

    ok(keyed.type === 'api', `${provider}: 方法是 api 型（实际 ${keyed.type}）`)
    ok(keyed.keyless === true, `${provider}: keyless=true（否则 magpie 自己的 key 框会抢走输入）`)
    ok(typeof keyed.ask === 'function', `${provider}: 有 ask()`)
    ok(typeof keyed.authorize === 'function', `${provider}: 有 authorize()`)

    // ask()：第一次要 Key，答过就 null
    const q = await keyed.ask({})
    ok(q !== null && q.type === 'password', `${provider}: ask() 要的是 password 型输入（实际 ${q?.type}）`)
    ok(q?.key === 'apiKey', `${provider}: ask() 的 key 是 apiKey（实际 ${q?.key}）`)
    ok(typeof q?.placeholder === 'string' && q.placeholder.length > 0, `${provider}: ask() 有占位提示`)
    ok((await keyed.ask({ apiKey: 'x' })) === null, `${provider}: 答过之后再 ask() 返回 null（不会死循环）`)
    // M-3 回归：纯空格不能算「答过」，否则用户粘贴带空白就永久卡死在报错页
    ok((await keyed.ask({ apiKey: '   ' })) !== null, `${provider}: 纯空格不算答过（否则用户永久回不到输入框）`)
    ok((await keyed.ask({ apiKey: '\n\t ' })) !== null, `${provider}: 换行+制表符也不算答过`)

    // 空 Key：必须抛可读错误，且不该打 RPC（真打会写一条空凭据）
    let emptyMsg = ''
    try { await keyed.authorize({}) } catch (e) { emptyMsg = String(e?.message ?? e) }
    ok(/没有填 API Key/.test(emptyMsg), `${provider}: 空 Key 报「没有填 API Key」（实际：${emptyMsg}）`)

    // 形状非法的 Key：应打到本体、由本体回一句形状错误（证明 RPC 真的通了）
    let shapeMsg = ''
    try { await keyed.authorize({ apiKey: 'short' }) } catch (e) { shapeMsg = String(e?.message ?? e) }
    ok(/形状不对/.test(shapeMsg), `${provider}: 非法 Key 由本体回形状错误（实际：${shapeMsg.slice(0, 80)}）`)

    // ── 真建号（临时 home，写的是假 Key，不联网校验） ──
    let result
    try {
      result = await keyed.authorize({ apiKey: fakeKey })
    } catch (e) {
      ok(false, `${provider}: 用形状合法的假 Key 建号应成功，实际抛：${String(e?.message ?? e).slice(0, 120)}`)
      continue
    }
    ok(result?.type === 'success', `${provider}: authorize() 返回 type=success（实际 ${result?.type}）`)

    const accountId = String(result?.metadata?.dshAccountId ?? '')
    ok(accountId !== '', `${provider}: metadata.dshAccountId 非空（实际 ${JSON.stringify(accountId)}）`)
    // 本家 RPC 判据：误调到别家时 id 前缀不对（modelscope 的 id 是 `modelscope-…`）
    ok(accountId.startsWith(`${dshProvider}-`), `${provider}: 账号 id 前缀是本家（实际 ${accountId}，应 ${dshProvider}-…）`)
    ok(
      String(result?.key ?? 'x').includes(accountId),
      `${provider}: key 里编进了账号 id（宿主判重靠 key 字符串相等；实际 ${result?.key}）`,
    )

    // ── M1 回归：明文 Key 不能落进 plugin-auth.json ──
    // 按宿主 save() 的真实合并顺序 + JSON.stringify 断言**最终记录**。
    // 这条与源码排版无关：把 `apiKey: undefined` 挪出 metadata、改写成占位常量、
    // 或者换个写法，只要最终记录里出现明文/键名就会红。
    const { record, disk } = hostRecord(provider, result, { apiKey: fakeKey }, '')
    ok(!disk.includes(fakeKey), `${provider}: 落盘记录里不含明文 Key`)
    ok(!/"apiKey"/.test(disk), `${provider}: 落盘记录里连 "apiKey" 键名都不出现（实际 ${disk.slice(0, 200)}）`)
    ok(record?.metadata?.apiKey === undefined, `${provider}: 合并后 metadata.apiKey 是 undefined`)
    ok(record?.metadata?.dshAccountId === accountId, `${provider}: 合并后 metadata.dshAccountId 仍在本家账号 id`)
  }
  ok(seen.sort().join(',') === 'jet-hub-modelscope,jet-hub-opencode', `有「贴 Key 新建」方法的正是那两家（实际 ${seen.sort().join(',')}）`)
} finally {
  fs.rmSync(TMP_HOME, { recursive: true, force: true })
}

console.log(bad === 0 ? `\n✓ 全部通过（${total} 项：Key 型新建 —— keyless/ask/空白/错误分类/本家 RPC/明文不外泄）` : `\n✗ ${bad} 项失败（${total} 项）`)
process.exit(bad === 0 ? 0 : 1)
