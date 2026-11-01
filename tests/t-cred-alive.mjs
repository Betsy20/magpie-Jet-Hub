// 「凭据还在吗」的真容器行为锁。
//
// 为什么必须起真容器：`tests/t-account-cache.mjs` 把 `credentialAliveOf` 当**形参**注入，
// 假容器 `{}` 永远走「没有这个方法 ⇒ 放行」那条路 —— 真实的 `container.credentialAlive`
// （路径推导、读盘、判据）零覆盖。审查实测过：把 catch 里的 `return true` 改成
// `false`，全套测试仍然 25 通过 / 0 失败。
//
// 本文件只用 `credentialAlive()`，**不 start()** —— 它设计上就不需要容器起来。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

import { JetHubContainer } from '../src/container.mjs'

let total = 0
const fails = []
const ok = (cond, what) => {
  total += 1
  if (!cond) fails.push(what)
}

let root
try {
  root = mkdtempSync(join(os.tmpdir(), 'cred-alive-'))
  const credDir = join(root, '.dsh')
  mkdirSync(credDir, { recursive: true })
  const credFile = join(credDir, '.credentials.yaml')

  const make = () =>
    new JetHubContainer({ home: root, entryPath: join(root, 'no-such-entry.js'), log: () => {} })
  const write = (text) => writeFileSync(credFile, text, 'utf8')

  // ---- 1. 路径推导 ----
  {
    const c = make()
    ok(c.credentialFile() === credFile, `credentialFile() 指到 <home>/.dsh/.credentials.yaml（实际 ${c.credentialFile()}）`)
    const c2 = new JetHubContainer({ home: join(root, '.dsh'), entryPath: join(root, 'x.js'), log: () => {} })
    ok(c2.credentialFile() === credFile, 'home 已经是 .dsh 时不再叠一层（实际会叠成 .dsh/.dsh）')
  }

  // ---- 2. 文件根本不在：放行（宁可不拦）----
  {
    const c = make()
    ok(c.credentialAlive('ANY_REF') === true, '凭据文件不存在时放行（不能把所有人判空壳）')
  }

  // ---- 3. 正常文件：在 → true，不在 → false，值为空串 → false ----
  {
    write(
      [
        'refs:',
        '  BUDDY_ACCOUNT_AAAAAA: \'{"access_token":"t"}\'',
        '  EMPTY_ACCOUNT_BBBBBB: ""',
        '',
      ].join('\n'),
    )
    const c = make()
    ok(c.credentialAlive('BUDDY_ACCOUNT_AAAAAA') === true, '文件里有这条且值非空 ⇒ 活着')
    ok(c.credentialAlive('NOT_THERE_CCCCCC') === false, '文件认得但没这条 ⇒ 不可用')
    ok(c.credentialAlive('EMPTY_ACCOUNT_BBBBBB') === false, '这条在但值是空串 ⇒ 不可用')
    ok(c.credentialAlive('') === false, 'ref 是空串 ⇒ 不可用')
    ok(c.credentialAlive(undefined) === false, 'ref 不是字符串 ⇒ 不可用')
  }

  // ---- 4. 结构不认识：一律放行 ----
  // 这一节是必修 1 的核心：parseRefs 对「读到了但结构不认识」不抛错、返回空表，
  // 只看 `refs.size === 0` 会让这几种文件把所有人判成空壳。
  {
    const shapes = [
      ['空文件（0 字节）', ''],
      ['只有注释', '# nothing here\n\n'],
      ['只有 records 段', 'records:\n  a: 1\n'],
      ['半截 JSON', '{"refs": {"A_ACCOUNT_111111": "x"'],
      ['refs 段名拼错', 'Ref:\n  BUDDY_ACCOUNT_AAAAAA: x\n'],
    ]
    for (const [name, text] of shapes) {
      write(text)
      const c = make()
      ok(c.credentialAlive('BUDDY_ACCOUNT_AAAAAA') === true, `结构不认识时放行：${name}`)
    }
  }

  // ---- 5. 认得 refs 段，但段内是空的：不可用 ----
  // 必修 A（二审）：`refs:` 段存在而里面没有条目时，不能当成「结构不认识」全放行。
  // 宿主（DSH 本体）删空 refs 后会写成 `refs: {}`；本插件的 deleteRefsFrom 删掉最后
  // 一条后写的是裸 `refs:` —— 两种形态都要拦，所以下面两种都有。
  // 而账号池与 refs 是两套数据 —— 此时池里可能还有账号，正是要拦的空壳。
  {
    const empty = [
      ['宿主删空后写的 refs: {}', 'records:\n  a: 1\nrefs: {}\n'],
      ['裸 refs: 后无条目', 'records:\n  a: 1\nrefs:\n'],
      ['refs: 段里只有注释', 'refs:\n  # 空\n'],
    ]
    for (const [name, text] of empty) {
      write(text)
      const c = make()
      ok(c.credentialAlive('BUDDY_ACCOUNT_AAAAAA') === false, `有 refs 段但段内为空 ⇒ 不可用：${name}`)
    }
  }

  // ---- 6. 源码里的两处接线（label 与 hint 的方向）----
  // 截取范围必须止于 `authorize()` —— 那里也有 `credentialAliveOf(container, …)`，
  // 截过头会让「ask() 真的问了凭据」这条断言被 authorize 满足（二审抓到的假绿）。
  {
    const src = readFileSync(new URL('../src/plugin.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    const at = src.indexOf('async ask(')
    ok(at > 0, 'find ask()')
    const azAt = src.indexOf('async authorize(', at)
    ok(azAt > at, 'ask() 之后能找到 authorize()，可以定界')
    const body = src.slice(at, azAt > at ? azAt : at + 3000)
    ok(!body.includes('async authorize('), 'ask() 的截段没有越过 authorize()（否则断言会被 authorize 满足）')
    ok(/credentialAliveOf\(\s*container\s*,/.test(body), 'ask() 里真的问了 credentialAliveOf')
    ok(
      /const alive = credentialAliveOf\(\s*container\s*,\s*a\?\.credentialRef\s*\)/.test(body),
      'ask() 问的是**这条账号的 credentialRef**（换成 a?.id 会让所有账号都判空壳）',
    )
    ok(/无登录凭据/.test(body), 'ask() 里真的有「（无登录凭据）」标记')
    ok(/label:\s*alive\s*\?\s*accountLabel/.test(body), 'label 方向是「活着→正常名，不活→加标记」，不是反过来')
    ok(/hint:\s*!alive/.test(body), 'hint 只在 alive 为假时出现（不是恒显示）')

    const azBody = src.slice(azAt, azAt + 4000)
    ok(/!credentialAliveOf\(\s*container\s*,\s*hit\.credentialRef\s*\)/.test(azBody), 'authorize() 里凭据不在就拒签，且判的是命中那条的 credentialRef')
    ok(/登录凭据已不可用/.test(azBody), 'authorize() 的报错说清是凭据问题')

    // fail-open 的契约本身也要有锁：credentialAliveOf 恒 return true 就等于整个功能失效，
    // 而上面那些断言全都还会绿。
    const aliveAt = src.indexOf('function credentialAliveOf(')
    ok(aliveAt > 0, 'find credentialAliveOf()')
    const aliveBody = src.slice(aliveAt, aliveAt + 600)
    ok(/container\?\.credentialAlive !== 'function'/.test(aliveBody), 'credentialAliveOf 在「拿不到能力」时才放行（不是恒 true）')
    ok(/container\.credentialAlive\(ref\) !== false/.test(aliveBody), 'credentialAliveOf 用 !== false 判（只有明确判死才拦）')
  }
} finally {
  if (root) rmSync(root, { recursive: true, force: true })
}

for (const f of fails) console.log('✗', f)
console.log(fails.length === 0 ? `✓ 全部通过（${total} 项）` : `✗ ${fails.length}/${total} 项失败`)
if (fails.length > 0) process.exitCode = 1
