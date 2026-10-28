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

const UNIT = ['t-writerefs.mjs', 't-dead-account.mjs', 't-usage.mjs', 't-checkin.mjs', 't-options.mjs', 't-plugin.mjs', 't-models-nowait.mjs', 't-seed-auth.mjs', 't-rpc-cover.mjs']
const ENV = [
  { file: 't-console.mjs', cmd: process.execPath, label: '控制台（真容器，~40s）' },
  // 直连层回归：真起容器跑一次 chat（流式 + 非流式）。取代了原来「内嵌网关端口」
  // 那条断言 —— 现在没有端口了，契约变成「进程内直连仍出得出内容」。
  { file: 't-direct.mjs', cmd: process.execPath, label: '直连链路（真容器 + 真 chat，~40s）' },
  { file: 't-gateway.py', cmd: process.env.PYTHON || 'python', label: '网关（需 magpie 3425）' },
  { file: 'ui-check.cjs', cmd: process.execPath, label: '页面 UI（需 web 3456）' },
]

const all = process.argv.includes('--all')
// `--all` 不只是「多加几条测试」：对 t-rpc-cover 还意味着打开探活。
// t-rpc-cover 自己认 `--all` 这个参数来开探活，但它只收到自己的文件路径，
// 收不到本脚本的命令行 —— 所以必须在这里显式补 `--probe`。
// 踩过的坑（2026-10-28）：本文件注释写着「--all 会补 --probe」，代码却没补，
// 于是 `test-all.mjs --all` 里那条最关键的「78 个方法真发请求都不回 unknown」
// 从来没跑过，探活那条一直是空跑。注释和代码对不上就是缺陷。
const extraArgs = (f) => (all && f === 't-rpc-cover.mjs' ? ['--probe'] : [])
const cases = all
  ? [...UNIT.map((f) => ({ file: f, cmd: process.execPath, label: f, args: extraArgs(f) })), ...ENV]
  : UNIT.map((f) => ({ file: f, cmd: process.execPath, label: f, args: [] }))

// 环境前置条件：**缺凭据/缺服务算跳过，不算失败**（文件头约定：NOT RUN ⇒ 跳过）。
// 踩过的坑（2026-10-28 14:1x）：`ui-check.cjs` 没设 MAGPIE_WEB_KEY 时 exit 2，
// 于是 `--all` 报「11 通过 / 1 失败」—— 但当时 3456 活着（curl 给 401 而非拒连），
// 唯一的问题是这台 shell 没设 key。判据工具把「没条件测」说成「失败」是假的信号，
// 会逼人去查产品代码。key 本身**不能**写进仓库（这台机器的凭据），只能外部注入。
const PRECONDITION = (c) => {
  if (c.file === 'ui-check.cjs' && !process.env.MAGPIE_WEB_KEY) {
    return '跳过（缺 MAGPIE_WEB_KEY，web 登录 key 不入仓库；3456 是否在跑需另验）'
  }
  return null
}

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
  const pre = PRECONDITION(c)
  if (pre) {
    rows.push(['-', c.label, pre])
    skip++
    continue
  }
  // 沙箱下管道 stdio 被禁（spawnSync 直接 EPERM，status=null），改用文件描述符
  // 重定向抓输出：退出码语义不变，且能同时拿到 stdout+stderr。
  //
  // `JET_HUB_NO_ADDR_FILE=1`：真起容器的用例（t-console）会在
  // `src/container.mjs:214` 写 `~/.config/magpie/jet-hub-console.json`。测试实例跑完就退，
  // 它绝不是这个文件的所有者；带这个开关让所有子用例彻底闭嘴（插件侧的正式开关，
  // 由内核在 2026-10-28 加）。t-console 自己也设了，这里是第二道闸：以后再加真起
  // 容器的用例，不用记得逐个人工设。
  const runOnce = (attempt) => {
    const capPath = path.join(ROOT, `.tmp-test-all-${process.pid}-${c.file}-${attempt}.log`)
    const capFd = fs.openSync(capPath, 'w')
    const t0 = Date.now()
    let r
    try {
      r = spawnSync(c.cmd, [file, ...(c.args ?? [])], {
        cwd: ROOT,
        stdio: ['ignore', capFd, capFd],
        timeout: 600_000,
        env: { ...process.env, JET_HUB_NO_ADDR_FILE: '1' },
      })
    } finally {
      fs.closeSync(capFd)
    }
    let out = ''
    try { out = fs.readFileSync(capPath, 'utf8') } catch {}
    try { fs.unlinkSync(capPath) } catch {}
    return { status: r.status, out, ms: Date.now() - t0 }
  }

  // 非确定性是这套测试的真实属性，不是偶发噪声：2026-10-28 13:0x 同一提交、同一环境
  // 跑 `--all`，t-plugin 崩在 0xC0000409、t-rpc-cover 误报 clearRejected 写盘、
  // ui-check 在 console 标签抛 Uncaught；三个单独跑和紧接着重跑都全绿。
  // 判据工具的结论不能一秒变一次，所以：失败先重试一次，重试结果为准，
  // 但第一次失败必须打印出来（不吞），并在汇总行标注「重试后通过」——
  // 这样「现在到底绿不绿」有确定答案，「有没有不稳定」也有证据。
  let r = runOnce(1)
  let retried = false
  const firstOut = r.out
  if (r.status !== 0) {
    retried = true
    r = runOnce(2)
  }
  const ms = r.ms
  const out = r.out
  if (r.status === 0) {
    if (out.includes('NOT RUN')) {
      rows.push(['-', c.label, '跳过（环境不具备）'])
      skip++
    } else if (retried) {
      rows.push(['✓', c.label, `${ms} ms（重试后通过）`])
      pass++
      const tail = firstOut.trim().split('\n').slice(-8).join('\n')
      console.log(`\n--- ${c.file} 第 1 次失败、重试通过（不稳定，需查） ---\n${tail}\n`)
    } else {
      rows.push(['✓', c.label, `${ms} ms`])
      pass++
    }
  } else {
    rows.push(['✗', c.label, `exit ${r.status} · ${ms} ms${retried ? '（重试仍失败）' : ''}`])
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
