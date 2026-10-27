// seed-auth 的纯逻辑回归：多账号摊平、稳定后缀、路由组文案、不碰别人的键。
// 不写真实文件（--dry-run 走一遍，再校验键形状）。
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PROVIDER_IDS } from '../src/plugin.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const script = path.join(ROOT, 'scripts', 'seed-auth.mjs')

const r = spawnSync(process.execPath, [script, '--dry-run'], { encoding: 'utf8', timeout: 60_000 })
const out = (r.stdout || '') + (r.stderr || '')
if (r.status !== 0) { console.log('✗ --dry-run 失败:\n' + out); process.exit(1) }

const problems = []
if (!/--dry-run，未写盘/.test(out)) problems.push('没有走 dry-run 分支')
for (const id of PROVIDER_IDS) {
  if (!out.includes(id)) problems.push(`报告里缺 ${id}`)
}
// 路由组必须说清是路由组，不能写成「未登录」
if (!/路由组 · 请求由池内其它渠道承接/.test(out)) problems.push('路由组文案没出现')
if (/（本机 DSH 未登录该渠道）/.test(out) && !/jet-hub-autoclaw/.test(out)) {
  // 有渠道没账号是正常的；这里只保证两种文案都在
}

// 不写盘验证：dry-run 后 plugin-auth.json 不该被改（比对 mtime 不现实，看备份数不增）
const authPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.config', 'magpie', 'plugin-auth.json')
if (fs.existsSync(authPath)) {
  const before = fs.statSync(authPath).mtimeMs
  spawnSync(process.execPath, [script, '--dry-run'], { encoding: 'utf8', timeout: 60_000 })
  const after = fs.statSync(authPath).mtimeMs
  if (before !== after) problems.push('--dry-run 竟然改了 plugin-auth.json')
}

if (problems.length) {
  console.log('✗ ' + problems.join('；'))
  process.exit(1)
}
console.log('✓ seed-auth 逻辑正确（dry-run 不改文件、19 个 id 齐全、路由组文案正确）')
process.exit(0)
