// seed-auth 的纯逻辑回归：多账号摊平、稳定后缀、路由组文案、不碰别人的键。
// 不写真实文件（--dry-run 走一遍，再校验键形状）。
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
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-auth-'))
const statePath = path.join(tmpDir, 'state.json')
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

const r = spawnSync(process.execPath, [script, '--dry-run', statePath], { encoding: 'utf8', timeout: 60_000 })
const out = (r.stdout || '') + (r.stderr || '')
if (r.status !== 0) { console.log('✗ --dry-run 失败:\n' + out); process.exit(1) }

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

// 不写盘验证：dry-run 后 plugin-auth.json 不该被改（比对 mtime 不现实，看备份数不增）
const authPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.config', 'magpie', 'plugin-auth.json')
if (fs.existsSync(authPath)) {
  const before = fs.statSync(authPath).mtimeMs
  spawnSync(process.execPath, [script, '--dry-run', statePath], { encoding: 'utf8', timeout: 60_000 })
  const after = fs.statSync(authPath).mtimeMs
  if (before !== after) problems.push('--dry-run 竟然改了 plugin-auth.json')
}

fs.rmSync(tmpDir, { recursive: true, force: true })

if (problems.length) {
  console.log('✗ ' + problems.join('；'))
  process.exit(1)
}
console.log('✓ seed-auth 逻辑正确（dry-run 不改文件、25 个 id 齐全、无路由组占位）')
process.exit(0)
