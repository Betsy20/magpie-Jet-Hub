// 跑本仓库的测试，退出码即结论。
//
//   node scripts/test-all.mjs          跑 node 单测（不需要 magpie 在跑）
//   node scripts/test-all.mjs --all    额外跑需要环境的：网关测试 + UI 自检
//
// 约定：测试脚本自己断言，输出里带 "NOT RUN" 视为跳过（环境不具备）。

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const ROOT = path.dirname(HERE)
const TESTS = path.join(ROOT, 'tests')

const UNIT = ['t-writerefs.mjs', 't-dead-account.mjs', 't-usage.mjs', 't-checkin.mjs', 't-options.mjs', 't-plugin.mjs', 't-models-nowait.mjs', 't-seed-auth.mjs']
const ENV = [
  { file: 't-console.mjs', cmd: process.execPath, label: '控制台（真容器，~40s）' },
  { file: 't-gateway.py', cmd: process.env.PYTHON || 'python', label: '网关（需 magpie 3425）' },
  { file: 'ui-check.cjs', cmd: process.execPath, label: '页面 UI（需 web 3456）' },
]

const all = process.argv.includes('--all')
const cases = all
  ? [...UNIT.map((f) => ({ file: f, cmd: process.execPath, label: f })), ...ENV]
  : UNIT.map((f) => ({ file: f, cmd: process.execPath, label: f }))

let pass = 0
let fail = 0
let skip = 0
const rows = []

for (const c of cases) {
  const file = path.join(TESTS, c.file)
  if (!fs.existsSync(file)) {
    rows.push(['-', c.label, '文件不存在'])
    skip++
    continue
  }
  const t0 = Date.now()
  const r = spawnSync(c.cmd, [file], { cwd: ROOT, encoding: 'utf8', timeout: 600_000 })
  const ms = Date.now() - t0
  const out = `${r.stdout || ''}${r.stderr || ''}`
  if (r.status === 0) {
    if (out.includes('NOT RUN')) {
      rows.push(['-', c.label, '跳过（环境不具备）'])
      skip++
    } else {
      rows.push(['✓', c.label, `${ms} ms`])
      pass++
    }
  } else {
    rows.push(['✗', c.label, `exit ${r.status} · ${ms} ms`])
    fail++
    const tail = out.trim().split('\n').slice(-12).join('\n')
    if (tail) console.log(`\n--- ${c.file} 失败输出（尾部） ---\n${tail}\n`)
  }
}

const w = Math.max(...rows.map((r) => r[1].length), 4)
for (const [mark, label, note] of rows) {
  console.log(`${mark} ${label.padEnd(w)}  ${note}`)
}
console.log(`\n${pass} 通过 / ${fail} 失败 / ${skip} 跳过`)
process.exit(fail ? 1 : 0)
