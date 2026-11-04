// seed-auth 的纯逻辑回归：多账号摊平、稳定后缀、路由组文案、不碰别人的键。
// 全程在临时目录里跑，不碰真实 ~/.config/magpie 与 ~/.dsh。
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { PROVIDER_IDS } from '../src/plugin.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const script = path.join(ROOT, 'scripts', 'seed-auth.mjs')

// 不能依赖真实账号池：CI 上没有 ~/.dsh/jet-hub/state.json，而脚本读不到就直接 exit 1。
// 自己造一份最小池，覆盖「有账号（含已停用）」与「一家都没有」两条路径；
// statePath 作为位置参数传进去（seed-auth.mjs 就是用 argv 里那个 .json 覆盖默认路径）。
//
// 写入目标也一并引到临时目录：seed-auth.mjs 的 authPath 来自 defaultAuthPath()，
// 它优先读 JET_HUB_AUTH_PATH。原来只按 USERPROFILE/HOME 推算、又要求文件已存在，
// 于是「dry-run 不写盘」这条断言在干净环境里**从未执行**（PR #15 审查 B6）。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-auth-'))
const statePath = path.join(tmpDir, 'state.json')
const authPath = path.join(tmpDir, 'plugin-auth.json')
const OTHER_PLUGIN = { 'some-other-plugin': { type: 'api', key: 'other', metadata: {} } }

try {
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      accounts: [
        { id: 'trae-00000001', provider: 'trae', nickname: '示例一', enabled: true },
        { id: 'trae-00000002', provider: 'trae', nickname: '示例二', enabled: false },
        { id: 'workbuddy-00000003', provider: 'workbuddy', nickname: '示例三', enabled: true },
      ],
    }),
    'utf8',
  )
  // 预置一份「别人的键」：dry-run 之后它必须一个字节都没动
  fs.writeFileSync(authPath, JSON.stringify(OTHER_PLUGIN), 'utf8')
  const beforeText = fs.readFileSync(authPath, 'utf8')
  const beforeMtime = fs.statSync(authPath).mtimeMs

  const env = { ...process.env, JET_HUB_AUTH_PATH: authPath }
  const r = spawnSync(process.execPath, [script, '--dry-run', statePath], { encoding: 'utf8', timeout: 60_000, env })
  const out = (r.stdout || '') + (r.stderr || '')
  if (r.status !== 0) {
    console.log('✗ --dry-run 失败:\n' + out)
    process.exitCode = 1
  } else {
    const problems = []
    if (!/--dry-run，未写盘/.test(out)) problems.push('没有走 dry-run 分支')
    for (const id of PROVIDER_IDS) {
      if (!out.includes(id)) problems.push(`报告里缺 ${id}`)
    }
    // 路由组（aggregate / jet-hub-auto）自 2026-10-31 起不再注册成 provider，
    // 所以报告里不该再出现「路由组」占位；出现的必须都是真渠道的「未登录」占位。
    if (/路由组 · 请求由池内其它渠道承接/.test(out)) problems.push('不该再有路由组占位（两家已不接入）')
    for (const gone of ['jet-hub-aggregate', 'jet-hub ']) {
      if (out.includes(gone)) problems.push(`报告里不该出现 ${gone}`)
    }

    // dry-run 不写盘：内容与 mtime 都必须原样。只看 mtime 拦不住「写了同样的内容」，
    // 只看内容拦不住「原样重写」—— 两者一起才等于「确实没碰这个文件」。
    if (fs.readFileSync(authPath, 'utf8') !== beforeText) problems.push('--dry-run 竟然改了 plugin-auth.json 的内容')
    if (fs.statSync(authPath).mtimeMs !== beforeMtime) problems.push('--dry-run 竟然写了 plugin-auth.json（mtime 变了）')

    if (problems.length) {
      console.log('✗ ' + problems.join('；'))
      process.exitCode = 1
    } else {
      console.log('✓ seed-auth 逻辑正确（dry-run 不改文件、28 个 id 齐全、无路由组占位）')
    }
  }
} finally {
  // 失败路径也要清干净：原来 `process.exit(1)` 在 `rmSync` 之前，spawn 一失败就
  // 留下一个 seed-auth-* 目录（PR #15 审查 B7）。
  fs.rmSync(tmpDir, { recursive: true, force: true })
}
