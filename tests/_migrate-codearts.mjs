// 把 magpie plugin-auth.json 里 `codearts-dsh` 那条仍然健康的凭据
// 迁到 DSH 的 .credentials.yaml（CODEARTS_ACCOUNT_* ref），
// 使 jet-hub 的 codearts 渠道恢复可用。
//
// 为什么需要这一步：卸载 magpie-codearts-auth 之后，它持有的那条 refresh 链
// 没人再用了；而 .credentials.yaml 里原有的两条 CODEARTS_ACCOUNT_* 都已过期。
// 两条链的字段形状完全一致（access_key_id / secret_access_key / security_token /
// expires_at / refresh_token / code_verifier / dpop_private_key_jwk），可直接搬。
import { readFileSync, writeFileSync, copyFileSync, existsSync, renameSync } from 'node:fs'
import { parseRefs, writeRefsInto } from '../src/credentials.mjs'

const CRED = 'C:/Users/Betsy/.dsh/.credentials.yaml'
const AUTH = 'C:/Users/Betsy/.config/magpie/plugin-auth.json'
const TARGET_REF = process.argv[2] || 'CODEARTS_ACCOUNT_92D5F562'

const auth = JSON.parse(readFileSync(AUTH, 'utf8'))
const entry = auth['codearts-dsh']
if (!entry) throw new Error('plugin-auth.json 里没有 codearts-dsh 条目')

const access = typeof entry.access === 'string' ? JSON.parse(entry.access) : entry.access
if (!access?.access_key_id) throw new Error('codearts-dsh.access 缺 access_key_id')

const expiresAt = Date.parse(access.expires_at ?? '')
const now = Date.now()
if (!Number.isFinite(expiresAt)) throw new Error('expires_at 无法解析: ' + access.expires_at)

const value = JSON.stringify(access)
const raw = readFileSync(CRED, 'utf8')
const before = parseRefs(raw)

console.log('目标 ref:', TARGET_REF)
console.log('  迁移前 expires_at:', (() => {
  try { return JSON.parse(before.get(TARGET_REF)).expires_at } catch { return '(解析失败)' }
})())
console.log('  迁入 expires_at  :', access.expires_at)
console.log('  access 剩余(分钟):', Math.round((expiresAt - now) / 60000))
console.log('  refresh_token 存在:', Boolean(access.refresh_token))

if (!before.has(TARGET_REF)) throw new Error(`.credentials.yaml 里没有 ${TARGET_REF}`)

const next = writeRefsInto(raw, new Map([[TARGET_REF, value]]))
if (existsSync(CRED)) copyFileSync(CRED, `${CRED}.bak`)
const tmp = `${CRED}.tmp-${process.pid}`
writeFileSync(tmp, next, 'utf8')
renameSync(tmp, CRED)

// 回读校验
const after = parseRefs(readFileSync(CRED, 'utf8'))
const back = JSON.parse(after.get(TARGET_REF))
console.log('\n回读校验:')
console.log('  expires_at 一致:', back.expires_at === access.expires_at)
console.log('  access_key_id 一致:', back.access_key_id === access.access_key_id)
console.log('  refresh_token 一致:', back.refresh_token === access.refresh_token)
console.log('  refs 总数不变:', after.size === before.size, `(${before.size} -> ${after.size})`)
