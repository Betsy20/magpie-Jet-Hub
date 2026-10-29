// 控制台端到端自检：真启动容器（真网关 + 真控制系统），全部走真实 HTTP。
//
// 只断言「结构与非空」，不依赖具体账号数量 —— 那是用户数据，会变。
// 退出码即结论。
//
// ⚠️ 这个用例会**真起容器**，于是必须对「容器的落盘副作用」做隔离，否则跑一次测试就
// 把用户真实 `~/.config/magpie/jet-hub-console.json` 写成测试实例的端口（2026-10-28
// 事故：被写成 18502 而 18502 上无人监听，控制台的快照脚本照着它连不上）。
//
// 隔离是两条腿，缺一不可，且都不是「凭感觉」：
//  ① `JET_HUB_NO_ADDR_FILE=1`：插件侧的正式开关（`src/container.mjs:211`），设了就完全不写。
//  ② `USERPROFILE` / `HOME` 改到临时目录：`src/container.mjs:214` 用的是 `os.homedir()`，
//     即使开关失效、或以后有人加了别的家目录写盘，落点也在临时目录里 —— 兜底而非主修。
//
// 两个洞必须分清（先前被混为一谈）：写地址文件的是 `homedir()`（`:214`），**不是**
// 构造函数里的 `home` 选项。`home` 只喂给 `FileCredentialProvider`（`:110`），
// 而本用例要读真实账号池（`account.list` 要有账号），所以 `home` 仍传真实家目录 ——
// 传临时目录会让「有账号」这条断言变成永假。副作用因此由上面两条腿挡住，另加
// 「真配置内容指纹跑前跑后一致」这条硬断言，任何漏写都会变红。
//
// ⚠️ 2026-10-30 补一条：**凭据目录本身也是用户的**。用真实 `home` 跑本用例会经
// `account.list` 拉一遍账号，上游据此**真实轮换** `~/.dsh/jet-hub/state.json` 里的
// `expiresAt`（实测跑一次 2 行 `expiresAt` 变、`refresh-journal.jsonl` 追加记录）。
// 这是「要真账号就得真数据」的固有代价，挡不掉，只能不默认跑：
// 与 `tests/_iso.mjs` 的 `live()` 同源，要求显式 `JET_HUB_LIVE=1` 才继续，
// 否则打印跳过并退出 0 —— 让「默认不碰用户文件」成为可验证的硬契约。
import { live, skipLive } from './_iso.mjs'
import { homedir, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JetHubContainer } from '../src/container.mjs'

const entryPath = fileURLToPath(new URL('../vendor/lib/index.js', import.meta.url))
const log = (m) => console.log('  ·', m)

// —— 隔离装置（在容器构造之前生效）——
const realHome = homedir()
const tempHome = mkdtempSync(join(tmpdir(), 'jet-hub-t-console-'))
const REAL_ADDR_FILE = join(realHome, '.config', 'magpie', 'jet-hub-console.json')
const fingerprint = (p) => {
  if (!existsSync(p)) return 'ABSENT'
  // 用内容指纹而不是 mtime/字节 sha1：mtime 会被并发写方刷新，字节级 sha1 与
  // 前面的指纹不可比。canon 化后取 sha1，读的是「写没写进去」而不是「何时写的」。
  const text = readFileSync(p, 'utf8')
  let canon = text
  try { canon = JSON.stringify(JSON.parse(text)) } catch {}
  return createHash('sha1').update(canon).digest('hex')
}
const addrBefore = fingerprint(REAL_ADDR_FILE)
const savedEnv = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, JET_HUB_NO_ADDR_FILE: process.env.JET_HUB_NO_ADDR_FILE }
process.env.USERPROFILE = tempHome
process.env.HOME = tempHome
process.env.JET_HUB_NO_ADDR_FILE = '1'

// ⚠️ 本用例用**真实** home 起容器（要读真实账号池），于是会经 `account.list`
// 触发上游真实续期：实测 `~/.dsh/jet-hub/state.json` 的 `expiresAt` 被改写、
// `refresh-journal.jsonl` 追加记录。这是「要真账号就得真数据」的固有代价，
// 挡不掉，只能不默认跑。与 `tests/_iso.mjs` 的 `live()` 同源。
if (!live()) {
  skipLive('控制台端到端（真容器 + 真账号，会真实续期）')
  process.exit(0)
}

let failed = 0
function ok(name, cond, extra = '') {
  if (cond) console.log(`✓ ${name}${extra ? ' — ' + extra : ''}`)
  else {
    failed += 1
    console.log(`✗ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

const container = new JetHubContainer({ home: realHome, entryPath, log })
let consoleUrl

try {
  console.log('启动容器（最久 60s）…')
  await container.start()
  consoleUrl = container.consoleUrl
  ok('控制台已启动', typeof consoleUrl === 'string' && consoleUrl.startsWith('http://127.0.0.1:'), consoleUrl)

  // 0) 副作用断言：这一条是「跑测试不许写用户家目录」的判据本身，不是附带检查。
  //    它故意放在最前面 —— 越早断言，越不会因为后面的用例崩掉而漏检。
  const addrAfter = fingerprint(REAL_ADDR_FILE)
  ok('未改写用户真实 jet-hub-console.json', addrAfter === addrBefore, `${addrBefore === 'ABSENT' ? 'ABSENT' : addrBefore.slice(0, 8)} → ${addrAfter === 'ABSENT' ? 'ABSENT' : addrAfter.slice(0, 8)}`)
  const tempAddrFile = join(tempHome, '.config', 'magpie', 'jet-hub-console.json')
  ok('临时家目录里也没有落地址文件（JET_HUB_NO_ADDR_FILE 生效）', !existsSync(tempAddrFile), tempAddrFile)
  ok('环境隔离确实生效（homedir() 已改道临时目录）', homedir() === tempHome, `homedir()=${homedir()}`)

  // 1) /__meta
  const metaRes = await fetch(`${consoleUrl}__meta`)
  const meta = await metaRes.json()
  ok('/__meta 200', metaRes.status === 200)
  ok('/__meta 有 provider', Array.isArray(meta.providers) && meta.providers.length > 0, `${meta.providers?.length} 个`)
  ok('/__meta 有模型', meta.models > 0, `${meta.models} 个`)
  // 直连模式：没有本地网关端口，`gateway` 字段据实说明这一点
  // （老契约要求 `baseURL` 是字符串 —— 那条断言随内嵌网关一起废掉了）
  ok('/__meta 标了直连模式', meta.gateway?.mode === 'direct' && meta.gateway?.port === null, JSON.stringify(meta.gateway))
  ok('/__meta 带版本', typeof meta.version === 'string', meta.version)

  // 2) 静态界面
  const pageRes = await fetch(consoleUrl)
  const html = await pageRes.text()
  ok('GET / 200', pageRes.status === 200)
  ok('页面标题正确', html.includes('Jet Hub 控制台'))
  for (const f of ['console.css', 'console.js']) {
    const r = await fetch(`${consoleUrl}${f}`)
    ok(`静态资源 ${f}`, r.status === 200, `HTTP ${r.status}`)
  }

  // 3) CORS 预检（sandbox iframe 的 opaque origin 必需）
  const opt = await fetch(`${consoleUrl}api/jet-hub`, { method: 'OPTIONS' })
  ok('OPTIONS 预检 204', opt.status === 204, `HTTP ${opt.status}`)
  ok('回 ACAO *', opt.headers.get('access-control-allow-origin') === '*')

  // 4) RPC 转发：account.list
  const rpcCall = async (method, payload = {}) => {
    const body = { type: 'client-request', rpcId: 't1', method: 'jet-hub', payload: { method, payload } }
    const r = await fetch(`${consoleUrl}api/jet-hub`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const j = await r.json()
    return { status: r.status, result: j.result }
  }

  const providers = meta.providers.map((p) => p.id)
  let total = 0
  let firstProvider = null
  for (const pv of providers) {
    const { result } = await rpcCall('account.list', { provider: pv })
    if (result?.ok !== true) continue
    const n = result.value?.accounts?.length ?? 0
    total += n
    if (n > 0 && firstProvider === null) firstProvider = pv
  }
  ok('account.list 可调用且有账号', total > 0, `${providers.length} 个 provider 共 ${total} 个账号，首个有账号的是 ${firstProvider}`)

  // 5) RPC 转发：model.list（挑第一个有模型的 provider）
  const withModels = meta.providers.find((p) => (p.models?.length ?? 0) > 0)
  if (withModels) {
    const { result } = await rpcCall('model.list', { provider: withModels.id })
    ok('model.list 可调用', result?.ok === true && Array.isArray(result.value?.models), `${withModels.id}：${result?.value?.models?.length ?? 0} 个`)
  }

  // 6) 错误路径：非法 method 应回 ok:false，而不是 500
  const bad = await rpcCall('__no_such_method__', {})
  ok('未知方法回 ok:false', bad.result?.ok === false && bad.status === 200, `${bad.status} ${bad.result?.error?.code ?? ''}`)

  // 7) 直连层仍能出模型目录（原来这条打的是内嵌网关的 HTTP 端口；
  //    直连后 `forward()` 进程内调 `ctx.llm`，语义不变、不再有端口）
  const gwRes = await container.forward('/v1/models', {})
  const gwJson = await gwRes.json()
  ok('直连 /v1/models 200', gwRes.status === 200, `HTTP ${gwRes.status}`)
  ok('直连 /v1/models 有 data 数组', Array.isArray(gwJson?.data), `${gwJson?.data?.length ?? '—'} 条`)

  console.log(failed === 0 ? '\n结论：✓ 控制台链路正常' : `\n结论：✗ ${failed} 项失败`)
} catch (e) {
  console.error('✗ 异常：', e?.stack ?? e)
  failed += 1
} finally {
  await container.console?.close?.()
  // 收尾：还原环境变量，删掉临时家目录；最后再核一次真实配置指纹（进程被杀也不影响这条，
  // 它读的是「此刻文件内容」，不是「有没有收到信号」）。
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try { rmSync(tempHome, { recursive: true, force: true }) } catch {}
  const addrFinal = fingerprint(REAL_ADDR_FILE)
  ok('收尾后用户真实配置仍未变', addrFinal === addrBefore, addrFinal === 'ABSENT' ? 'ABSENT' : addrFinal.slice(0, 8))
}

process.exit(failed === 0 ? 0 : 1)
