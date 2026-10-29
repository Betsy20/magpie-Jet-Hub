// 变异验证：证明 t-plugin.mjs 的 limit.output 护栏真有牙。
//
// 每条变异：改 src/plugin.mjs（单行锚点，CRLF/LF 都先归一）→ 跑 t-plugin.mjs
// → 期望**失败**。只要有一条变异没被抓住（SURVIVED），护栏就是没牙的。
//
// 用法：node tests/_mut-output.mjs
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const target = join(root, 'src', 'plugin.mjs')
const backup = join(root, 'src', '_plugin.mjs.bak')
const node = process.execPath

const MUTATIONS = [
  {
    name: 'M1 兜底表删掉 DeepSeek 系',
    from: '  [/deepseek.*flash/i, 393_216],',
    to: '',
  },
  {
    name: 'M2 兜底表删掉 GLM 系',
    from: '  [/glm-5/i, 131_072],',
    to: '',
  },
  {
    name: 'M3 兜底值退回 8192',
    from: '  [/deepseek.*flash/i, 393_216],',
    to: '  [/deepseek.*flash/i, 8192],',
  },
  {
    name: 'M4 兜底覆盖已申报值（忽略 declared）',
    from: '  if (typeof declared === \'number\' && Number.isFinite(declared) && declared > 0) return declared',
    to: '  void declared',
  },
  {
    name: 'M5 认不出的系列也编一个 8192',
    from: '  return undefined\n}\n\n/** 供回归测试',
    to: '  return 8192\n}\n\n/** 供回归测试',
  },
  {
    name: 'M6 modelEntry 里把 output 又写成 ?? 8192',
    from: '  const output = outputLimit(id, meta?.output ?? def?.limit?.output)',
    to: '  const output = meta?.output ?? def?.limit?.output ?? 8192',
  },
  {
    name: 'M7 modelsOfFull 把展示名当 id',
    from: "    out[bare] = modelEntry(bare, label === bare ? undefined : { name: label }, metaOf(id))",
    to: "    out[bare] = modelEntry(label, undefined, metaOf(id))",
  },
]

const original = readFileSync(target, 'utf8')
copyFileSync(target, backup)

const results = []
try {
  for (const m of MUTATIONS) {
    const norm = original.replace(/\r\n/g, '\n')
    if (!norm.includes(m.from)) {
      results.push([m.name, 'PATCH-NOT-APPLIED', '锚点没找到（先修变异脚本，别当成通过）'])
      continue
    }
    const mutated = norm.replace(m.from, m.to)
    writeFileSync(target, mutated, 'utf8')
    let killed = false
    let detail = ''
    try {
      execFileSync(node, [join(here, 't-plugin.mjs')], { cwd: root, stdio: 'pipe', timeout: 300_000 })
    } catch (error) {
      killed = true
      const out = `${error?.stdout ?? ''}${error?.stderr ?? ''}`
      const hit = out.split('\n').find((l) => l.includes('✗') || l.includes('应为') || l.includes('兜底'))
      detail = (hit ?? `exit ${error?.status}`).trim().slice(0, 120)
    }
    results.push([m.name, killed ? 'KILLED' : 'SURVIVED', detail])
  }
} finally {
  writeFileSync(target, original, 'utf8')
  try {
    unlinkSync(backup)
  } catch {
    /* 备份本来就可能不存在 */
  }
}

let bad = 0
for (const [name, verdict, detail] of results) {
  if (verdict !== 'KILLED') bad += 1
  console.log(`${verdict.padEnd(18)} ${name}${detail ? '  ← ' + detail : ''}`)
}
console.log(bad === 0 ? `\n✓ ${results.length}/${results.length} KILLED` : `\n✗ ${bad} 条没被抓住`)
process.exit(bad === 0 ? 0 : 1)
