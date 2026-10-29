// writeRefsInto 回归测试：单行 ref 后面的那个 ref 不能被吞掉。
//
// 真实缺陷（2026-10-28）：改 CODEARTS_ACCOUNT_92D5F562（单行闭合）时，
// 紧随其后的 WORKBUDDY_ACCOUNT_6EF844A1 整段消失，refs 从 47 掉到 46。
// 根因：j 从 i+1 起算，单行闭合时 i = j+1 = i+2，跳过一行。
import { writeRefsInto, upsertRefsInto, parseRefs } from '../src/credentials.mjs'

const failures = []
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`)
  if (!ok) failures.push(name)
}

// 构造一个和真实文件同构的样本：
//  - 单行 ref 后面紧跟另一个单行 ref
//  - 单行 ref 后面紧跟一个跨 3 行的 ref
//  - 跨行 ref 后面跟单行 ref
const SAMPLE = [
  'version: 1',
  'refs:',
  `  CODEARTS_ACCOUNT_92D5F562: '{"a":1}'`,
  `  WORKBUDDY_ACCOUNT_6EF844A1: '{"token":"head`,
  '    profile offline_access',
  `    email","x":2}'`,
  `  ASTUDIO_ACCESS_TOKEN: '{"b":3}'`,
  'records:',
  '  some/record:',
  '    kind: grant',
  '',
].join('\n')

// 1) 改单行 ref，后面的 ref 必须还在
{
  const out = writeRefsInto(SAMPLE, new Map([['CODEARTS_ACCOUNT_92D5F562', '{"a":9}']]))
  const refs = parseRefs(out)
  check('单行 ref 后面不吞行', refs.size === 3, `refs=${refs.size} (期望 3)`)
  check('  被改的 ref 值正确', refs.get('CODEARTS_ACCOUNT_92D5F562') === '{"a":9}')
  check('  后面的 WORKBUDDY 还在', refs.has('WORKBUDDY_ACCOUNT_6EF844A1'))
  check('  WORKBUDDY 跨行值完整', String(refs.get('WORKBUDDY_ACCOUNT_6EF844A1')).includes('email'))
  check('  再后面的 ASTUDIO 还在', refs.get('ASTUDIO_ACCESS_TOKEN') === '{"b":3}')
  check('  records 段保留', out.includes('records:') && out.includes('kind: grant'))
}

// 2) 改跨行 ref，前后都不受影响
{
  const out = writeRefsInto(SAMPLE, new Map([['WORKBUDDY_ACCOUNT_6EF844A1', '{"token":"new"}']]))
  const refs = parseRefs(out)
  check('改跨行 ref 不吞行', refs.size === 3, `refs=${refs.size}`)
  check('  跨行 ref 值已替换', refs.get('WORKBUDDY_ACCOUNT_6EF844A1') === '{"token":"new"}')
  check('  前面的 CODEARTS 还在', refs.get('CODEARTS_ACCOUNT_92D5F562') === '{"a":1}')
  check('  后面的 ASTUDIO 还在', refs.get('ASTUDIO_ACCESS_TOKEN') === '{"b":3}')
  check('  跨行被压成单行', out.split('\n').length < SAMPLE.split('\n').length)
}

// 3) 一次改多个 ref
{
  const out = writeRefsInto(SAMPLE, new Map([
    ['CODEARTS_ACCOUNT_92D5F562', '{"a":7}'],
    ['ASTUDIO_ACCESS_TOKEN', '{"b":8}'],
  ]))
  const refs = parseRefs(out)
  check('多 ref 同时改', refs.size === 3 && refs.get('CODEARTS_ACCOUNT_92D5F562') === '{"a":7}'
    && refs.get('ASTUDIO_ACCESS_TOKEN') === '{"b":8}', `refs=${refs.size}`)
}

// 4) 值里带单引号要正确转义
{
  const out = writeRefsInto(SAMPLE, new Map([['ASTUDIO_ACCESS_TOKEN', `{"k":"it's"}`]]))
  const refs = parseRefs(out)
  check('单引号转义往返', refs.get('ASTUDIO_ACCESS_TOKEN') === `{"k":"it's"}`,
    JSON.stringify(refs.get('ASTUDIO_ACCESS_TOKEN')))
}

// 5) 不存在的 ref 必须报错，不能静默
{
  let threw = false
  try { writeRefsInto(SAMPLE, new Map([['NO_SUCH_REF', 'x']])) } catch { threw = true }
  check('改不存在的 ref 会抛错', threw)
}

// 6) upsertRefsInto：新增 ref 必须插在 refs 段**最后一个完整条目**之后
//
// 真实缺陷（2026-10-29，审查发现）：原实现只把「两空格 + ref 名开头的行」记为
// lastEntry，不认多行标量的续行。当 refs 段最后一条是多行标量时，新 ref 被插进
// 标量首行与续行之间 —— 值被劈成两半，JSON 由合法变非法，新 ref 也没落地。
// 本机真实 .credentials.yaml 最后一条正是跨 3 行的 BUDDY_ACCOUNT_49872581，
// 而「换机导入」全是新增 ref，必然触发。所以这里专门造「最后一条是多行标量」的样本。
const TAIL_MULTILINE = [
  'version: 1',
  'refs:',
  `  ASTUDIO_ACCESS_TOKEN: '{"b":3}'`,
  `  BUDDY_ACCOUNT_49872581: '{"access_token":"at-head`,
  '    profile offline_access',
  `    email","personal":"p"}'`,
  'records:',
  '  some/record:',
  '    kind: grant',
  '',
].join('\n')

{
  const out = upsertRefsInto(TAIL_MULTILINE, new Map([['{{SECRET_newone}}', '{"access_token":"at-new"}']]))
  const refs = parseRefs(out)
  const buddy = String(refs.get('BUDDY_ACCOUNT_49872581') ?? '')
  check('最后一条是多行标量时，新增 ref 不劈开它', refs.size === 3, `refs=${refs.size} (期望 3)`)
  check('  多行标量仍以 profile 开头、email 结尾', buddy.includes('profile offline_access') && buddy.includes('email'), buddy.slice(0, 60))
  check('  多行标量 JSON 仍合法', (() => { try { JSON.parse(buddy); return true } catch { return false } })())
  check('  新增 ref 落地', refs.get('{{SECRET_newone}}') === '{"access_token":"at-new"}')
  // 关键：新 ref 必须在 BUDDY 的**续行之后**，不能夹在中间
  const li = out.split('\n')
  const buddyAt = li.findIndex((l) => l.includes('BUDDY_ACCOUNT_49872581'))
  const newAt = li.findIndex((l) => l.includes('{{SECRET_newone}}'))
  const recordsAt = li.findIndex((l) => /^records:/.test(l))
  check('  新 ref 排在多行标量之后、records 之前', newAt > buddyAt + 2 && newAt < recordsAt,
    `buddy=${buddyAt} new=${newAt} records=${recordsAt}`)
}

// 7) upsertRefsInto：已存在的 ref 走原逻辑，不能被重复追加
{
  const out = upsertRefsInto(TAIL_MULTILINE, new Map([['ASTUDIO_ACCESS_TOKEN', '{"b":9}']]))
  const refs = parseRefs(out)
  check('upsert 改已存在 ref 不重复追加', refs.size === 2 && refs.get('ASTUDIO_ACCESS_TOKEN') === '{"b":9}',
    `refs=${refs.size}`)
}

// 8) upsertRefsInto：值里的换行要折成空格（refs 段保持一行一个 ref）
{
  const out = upsertRefsInto(TAIL_MULTILINE, new Map([['{{SECRET_nl}}', 'a\nb\nc']]))
  const refs = parseRefs(out)
  check('新增 ref 的值里换行折成空格', refs.get('{{SECRET_nl}}') === 'a b c', JSON.stringify(refs.get('{{SECRET_nl}}')))
}

// 9) upsertRefsInto：值里的单引号要转义成 ''
{
  const out = upsertRefsInto(TAIL_MULTILINE, new Map([['{{SECRET_q}}', `{"k":"it's"}`]]))
  const refs = parseRefs(out)
  check('新增 ref 的单引号转义往返', refs.get('{{SECRET_q}}') === `{"k":"it's"}`, JSON.stringify(refs.get('{{SECRET_q}}')))
}

console.log()
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('✓ 全部通过')
