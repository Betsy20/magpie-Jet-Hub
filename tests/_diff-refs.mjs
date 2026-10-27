import { readFileSync } from 'node:fs'
import { parseRefs } from '../src/credentials.mjs'

const CUR = 'C:/Users/Betsy/.dsh/.credentials.yaml'
const BAK = 'C:/Users/Betsy/.dsh/.credentials.yaml.bak-lead-20261028-003623'

const cur = parseRefs(readFileSync(CUR, 'utf8'))
const bak = parseRefs(readFileSync(BAK, 'utf8'))

const lost = [...bak.keys()].filter((k) => !cur.has(k))
const added = [...cur.keys()].filter((k) => !bak.has(k))
console.log('备份 refs:', bak.size, ' 当前 refs:', cur.size)
console.log('丢失:', lost.length ? lost : '无')
for (const k of lost) console.log('   原值前 100:', String(bak.get(k)).slice(0, 100))
console.log('新增:', added.length ? added : '无')
