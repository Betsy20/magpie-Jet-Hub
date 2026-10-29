/**
 * `scripts/import-backup.mjs` 的离线单测。
 *
 * 全部在临时目录里跑（`--dsh-home` 指过去），**不碰**真实的 `~/.dsh` 与
 * `~/.config/magpie/plugin-auth.json` —— 导入脚本会改写凭据与账号池，
 * 单测要是碰到真文件就是灾难。
 *
 * 覆盖的六件事（都是脚本里写了分支的地方）：
 *  1. `--list` / `--dry-run` 不写盘；
 *  2. merge 按账号 id 判重，已存在的跳过；
 *  3. merge **不覆盖**被别的现有账号占用的 ref（否则等于偷换别人的 token），
 *     但**要补**已存在账号在本机缺失的凭据（本机缺 = 那个号其实登不上，
 *     旧备份里的 token 虽旧也比没有强；本机有值则一律保留，因为运行时
 *     refresh 会把新 token 写回同一 ref，用旧备份盖掉等于打回上一代）；
 *  4. replace 整体还原账号池 + 模型黑名单；
 *  5. 加密备份（PBKDF2 310000 + AES-256-GCM）能解，错口令必须失败；
 *  6. 不是本插件备份的文件必须被拒（format / version 两道校验）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pbkdf2Sync, randomBytes, createCipheriv } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parseRefs } from '../src/credentials.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(here, '..', 'scripts', 'import-backup.mjs')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-import-test-'))

const problems = []
const check = (ok, msg) => { if (!ok) problems.push(msg) }

/** 造一份凭据 JSON（形状与真实登录产物一致）。 */
const cred = (nick) => JSON.stringify({
  access_token: `at-${nick}`,
  refresh_token: `rt-${nick}`,
  expires_at: '1793238274000',
  token_type: 'Bearer',
  user_id: `u-${nick}`,
  nickname: nick,
})

const payload = {
  format: 'dsh-codearts-auth/backup',
  version: 1,
  exportedAt: '2026-10-28T00:00:00.000Z',
  credentials: {
    '{{SECRET_aaa111}}': cred('alpha'),
    CLINE_ACCOUNT_DEADBEEF: cred('beta'),
    WORKBUDDY_ACCOUNT_99999999: cred('gamma'),
  },
  accounts: [
    { id: 'cline-aaaa1111', provider: 'cline', nickname: 'alpha@qq.com', enabled: true, credentialRef: '{{SECRET_aaa111}}' },
    { id: 'workbuddy-bbbb2222', provider: 'workbuddy', nickname: 'gamma', enabled: false, credentialRef: 'WORKBUDDY_ACCOUNT_99999999' },
    // 这条引用 CLINE_ACCOUNT_DEADBEEF，而本机那个 ref 已被**另一个**账号
    // （cline-9999eeee）占着 —— merge 必须拒绝覆盖，否则等于偷换别人的 token。
    { id: 'cline-cccc3333', provider: 'cline', nickname: 'beta', enabled: true, credentialRef: 'CLINE_ACCOUNT_DEADBEEF' },
  ],
  disabledModels: { cline: { 'cline-free/x': true } },
}

const backupFile = path.join(root, 'backup.json')
fs.writeFileSync(backupFile, JSON.stringify(payload, null, 2))

/** 每个场景一份干净的家目录。 */
function makeHome(name) {
  const home = path.join(root, name)
  fs.mkdirSync(path.join(home, 'jet-hub'), { recursive: true })
  // 本机已有：workbuddy-bbbb2222（与备份同 id，用来测判重）
  //           cline-9999eeee（占用 CLINE_ACCOUNT_DEADBEEF，用来测不覆盖）
  fs.writeFileSync(path.join(home, 'jet-hub', 'state.json'), JSON.stringify({
    accounts: [
      { id: 'workbuddy-bbbb2222', provider: 'workbuddy', nickname: '已在', enabled: true, credentialRef: 'WORKBUDDY_ACCOUNT_99999999' },
      { id: 'cline-9999eeee', provider: 'cline', nickname: '本机旧号', enabled: true, credentialRef: 'CLINE_ACCOUNT_DEADBEEF' },
    ],
    disabledModels: {},
  }, null, 2))
  fs.writeFileSync(path.join(home, '.credentials.yaml'),
    `version: 1\nrefs:\n  CLINE_ACCOUNT_DEADBEEF: '${cred('local-beta').replace(/'/g, "''")}'\nrecords:\n`)
  return home
}

const readPool = (home) => JSON.parse(fs.readFileSync(path.join(home, 'jet-hub', 'state.json'), 'utf8'))
const readRefs = (home) => parseRefs(fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8'))

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...env },
  })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

// ---- 1. --list / --dry-run 不写盘 ------------------------------------------

{
  const home = makeHome('h1')
  const before = fs.readFileSync(path.join(home, 'jet-hub', 'state.json'), 'utf8')
  const beforeCred = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8')

  const listed = run([backupFile, '--dsh-home', home, '--list'])
  check(listed.code === 0, `--list 应成功，实际退出码 ${listed.code}：${listed.out}`)
  check(/只看不写/.test(listed.out), '--list 应提示「只看不写」')
  check(/账号: 3 个/.test(listed.out), '--list 应报出 3 个账号')

  const dried = run([backupFile, '--dsh-home', home, '--dry-run'])
  check(dried.code === 0, `--dry-run 应成功，实际退出码 ${dried.code}：${dried.out}`)
  check(/未写盘/.test(dried.out), '--dry-run 应提示未写盘')

  check(fs.readFileSync(path.join(home, 'jet-hub', 'state.json'), 'utf8') === before, '--list/--dry-run 不该改 state.json')
  check(fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8') === beforeCred, '--list/--dry-run 不该改 .credentials.yaml')
}

// ---- 2 & 3. merge：判重 + 不覆盖别人的 ref ----------------------------------

{
  const home = makeHome('h2')
  const r = run([backupFile, '--dsh-home', home, '--no-seed'])
  check(r.code === 0, `merge 应成功，实际退出码 ${r.code}：${r.out}`)
  check(/跳过 1 个已存在/.test(r.out), `merge 应报告跳过 1 个已存在：${r.out}`)
  check(/已被本机账号 cline-9999eeee 占用/.test(r.out), `merge 应点名被占用的 ref：${r.out}`)

  const pool = readPool(home)
  const ids = pool.accounts.map((a) => a.id)
  check(ids.includes('cline-aaaa1111'), 'merge 应新增 cline-aaaa1111')
  check(ids.filter((id) => id === 'workbuddy-bbbb2222').length === 1, 'merge 不该重复添加已存在的账号')
  check(pool.accounts.find((a) => a.id === 'workbuddy-bbbb2222').nickname === '已在', 'merge 不该覆盖已存在账号的字段')
  check(JSON.stringify(pool.disabledModels) === '{}', 'merge 不该碰模型黑名单')

  const refs = readRefs(home)
  check(refs.get('{{SECRET_aaa111}}') === cred('alpha'), 'merge 应写入新增账号的凭据')
  check(refs.get('CLINE_ACCOUNT_DEADBEEF') === cred('local-beta'), 'merge 不该覆盖被别的账号占用的凭据')
  // 已存在账号 workbuddy-bbbb2222 的凭据在本机缺失 —— merge 要补上（这是真实
  // 缺陷：旧实现只在「本批新增账号」里找 ref，于是已存在账号的缺失凭据永远补不上）。
  check(refs.get('WORKBUDDY_ACCOUNT_99999999') === cred('gamma'), 'merge 应补齐已存在账号在本机缺失的凭据')

  const baks = fs.readdirSync(home).filter((f) => f.startsWith('.credentials.yaml.bak-import-'))
  check(baks.length === 1, `写入前应留一份 .bak-import- 备份，实际 ${baks.length} 份`)
  if (baks.length === 1) {
    check(fs.readFileSync(path.join(home, baks[0]), 'utf8').includes(cred('local-beta').slice(0, 20)),
      '备份文件应保存改动前的原文')
  }
}

// ---- 4. replace：整体还原 ---------------------------------------------------

{
  const home = makeHome('h3')
  const r = run([backupFile, '--dsh-home', home, '--mode', 'replace', '--no-seed'])
  check(r.code === 0, `replace 应成功，实际退出码 ${r.code}：${r.out}`)
  const pool = readPool(home)
  check(pool.accounts.length === 3, `replace 后应只剩备份里的 3 个账号，实际 ${pool.accounts.length}`)
  check(!pool.accounts.some((a) => a.id === 'cline-9999eeee'), 'replace 应丢弃本机原有账号')
  check(JSON.stringify(pool.disabledModels) === JSON.stringify(payload.disabledModels), 'replace 应整体还原模型黑名单')
  check(readRefs(home).get('CLINE_ACCOUNT_DEADBEEF') === cred('beta'), 'replace 应把被占用的凭据也换成备份里的')
}

// ---- 5. 加密备份 -----------------------------------------------------------

{
  const home = makeHome('h4')
  const passphrase = 'test-passphrase-42'
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = pbkdf2Sync(passphrase, salt, 310000, 32, 'sha256')
  const c = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final(), c.getAuthTag()])
  const encFile = path.join(root, 'backup.enc.json')
  fs.writeFileSync(encFile, JSON.stringify({
    format: 'dsh-codearts-auth/backup.encrypted',
    kdf: 'PBKDF2',
    hash: 'SHA-256',
    iterations: 310000,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ct.toString('base64'),
  }))

  const good = run([encFile, '--dsh-home', home, '--list'], { JET_HUB_BACKUP_PASSPHRASE: passphrase })
  check(good.code === 0, `加密备份应能解，实际退出码 ${good.code}：${good.out}`)
  check(/加密容器/.test(good.out), '应标出这是加密容器')
  check(/账号: 3 个/.test(good.out), '解密后应能读到 3 个账号')

  const bad = run([encFile, '--dsh-home', home, '--list'], { JET_HUB_BACKUP_PASSPHRASE: 'wrong-passphrase' })
  check(bad.code === 1, `错口令应失败，实际退出码 ${bad.code}`)
  check(/解密失败/.test(bad.out), `错口令应提示解密失败：${bad.out}`)
}

// ---- 6. 拒绝非本插件备份 ---------------------------------------------------

{
  const home = makeHome('h5')
  const wrongFormat = path.join(root, 'wrong-format.json')
  fs.writeFileSync(wrongFormat, JSON.stringify({ format: 'someone-else/backup', version: 1, accounts: [] }))
  const r1 = run([wrongFormat, '--dsh-home', home, '--list'])
  check(r1.code === 1, `格式不对应失败，实际退出码 ${r1.code}`)
  check(/不是 dsh-codearts-auth\/backup 备份文件/.test(r1.out), `应说明格式不对：${r1.out}`)

  const wrongVersion = path.join(root, 'wrong-version.json')
  fs.writeFileSync(wrongVersion, JSON.stringify({ format: 'dsh-codearts-auth/backup', version: 99, accounts: [] }))
  const r2 = run([wrongVersion, '--dsh-home', home, '--list'])
  check(r2.code === 1, `版本不对应失败，实际退出码 ${r2.code}`)
  check(/不支持的备份版本/.test(r2.out), `应说明版本不支持：${r2.out}`)
}

// ---- 7. permanent-locks.json 独立文档（只有 replace 写）---------------------

{
  const home = makeHome('h6')
  // 本机先有 3 项锁定，备份只带 1 项 —— replace 要整体换掉，并警告被清掉的
  fs.writeFileSync(path.join(home, 'jet-hub', 'permanent-locks.json'), JSON.stringify({
    schema: 'dsh-codearts-auth/permanent-locks/v1',
    locks: { workbuddy: true, loomy: true, trae: true },
  }, null, 2))
  const locksBackup = path.join(root, 'locks.json')
  fs.writeFileSync(locksBackup, JSON.stringify({ ...payload, permanentLocks: { workbuddy: true } }))

  const r = run([locksBackup, '--dsh-home', home, '--mode', 'replace', '--no-seed'])
  check(r.code === 0, `replace 写锁定表应成功，实际退出码 ${r.code}：${r.out}`)
  check(/会被清掉.*loomy/.test(r.out), `清掉本机锁定时必须警告并点名：${r.out}`)

  const doc = JSON.parse(fs.readFileSync(path.join(home, 'jet-hub', 'permanent-locks.json'), 'utf8'))
  check(doc.schema === 'dsh-codearts-auth/permanent-locks/v1', `锁定表 schema 应保持上游形态，实际 ${doc.schema}`)
  check(doc.locks.workbuddy === true, 'replace 应写入备份里的锁定项')
  check(doc.locks.loomy === undefined, 'replace 应清掉备份里没有的锁定项')
  check(readPool(home).permanentLocks === undefined, '锁定表不该被塞进 state.json（那是无效写入）')

  // merge 完全不碰锁定表
  const home2 = makeHome('h7')
  fs.writeFileSync(path.join(home2, 'jet-hub', 'permanent-locks.json'), JSON.stringify({
    schema: 'dsh-codearts-auth/permanent-locks/v1', locks: { loomy: true },
  }, null, 2))
  const m = run([locksBackup, '--dsh-home', home2, '--no-seed'])
  check(m.code === 0, `merge 应成功，实际退出码 ${m.code}：${m.out}`)
  const doc2 = JSON.parse(fs.readFileSync(path.join(home2, 'jet-hub', 'permanent-locks.json'), 'utf8'))
  check(doc2.locks.loomy === true && doc2.locks.workbuddy === undefined, 'merge 不该动锁定表')
}

// ---- 8. 参数与边界 ---------------------------------------------------------

{
  const home = makeHome('h8')

  // --mode 非法值必须报错，不能静默降级成 merge
  const bad = run([backupFile, '--dsh-home', home, '--mode', 'bogus', '--list'])
  check(bad.code === 1, `--mode 非法值应失败，实际退出码 ${bad.code}`)
  check(/只接受 merge 或 replace/.test(bad.out), `应说明 --mode 取值：${bad.out}`)

  // --mode=replace 等号形式要认
  const eq = run([backupFile, '--dsh-home', home, '--mode=replace', '--dry-run'])
  check(eq.code === 0, `--mode=replace 应成功，实际退出码 ${eq.code}：${eq.out}`)
  check(/模式: replace/.test(eq.out), `--mode=replace 应被认成 replace：${eq.out}`)

  // 加密容器缺 format 必须报「格式不认识」，不能误导成「口令错」
  const noFormat = path.join(root, 'nofmt.json')
  fs.writeFileSync(noFormat, JSON.stringify({ kdf: 'PBKDF2', hash: 'SHA-256', iterations: 310000, salt: 'AAAA', iv: 'BBBB', ciphertext: 'CCCC' }))
  const nf = run([noFormat, '--dsh-home', home, '--list'])
  check(nf.code === 1, `缺 format 的加密容器应失败，实际退出码 ${nf.code}`)
  check(/不认识的加密容器格式/.test(nf.out), `应说明格式不认识而不是口令错：${nf.out}`)
  check(!/解密失败/.test(nf.out), `不该把格式问题报成解密失败：${nf.out}`)

  // 账号引用的 ref 两边都没有值 → 必须告警（否则账号进池子却登不上）
  const orphan = path.join(root, 'orphan.json')
  fs.writeFileSync(orphan, JSON.stringify({
    format: 'dsh-codearts-auth/backup', version: 1, exportedAt: '2026-10-28T00:00:00.000Z',
    credentials: {}, disabledModels: {},
    accounts: [{ id: 'cline-nocred01', provider: 'cline', nickname: '没凭据', enabled: true, credentialRef: 'CLINE_ACCOUNT_GHOST001' }],
  }))
  const or = run([orphan, '--dsh-home', home, '--no-seed', '--dry-run'])
  check(or.code === 0, `孤儿 ref 不该让导入失败，实际退出码 ${or.code}：${or.out}`)
  check(/既不在本机、备份里也没有值/.test(or.out), `应告警孤儿 ref：${or.out}`)
  check(/cline-nocred01/.test(or.out), `应点名受影响的账号：${or.out}`)

  // --dsh-home 指向不存在的目录：要能建出来，不能崩栈
  const deep = path.join(root, 'deep', 'er', 'home')
  const d = run([backupFile, '--dsh-home', deep, '--no-seed'])
  check(d.code === 0, `不存在的 --dsh-home 应自动创建，实际退出码 ${d.code}：${d.out}`)
  check(fs.existsSync(path.join(deep, '.credentials.yaml')), '应把凭据写进新建的 dsh home')
}

// ---- 收尾 ------------------------------------------------------------------

try {
  fs.rmSync(root, { recursive: true, force: true })
} catch {
  // 临时目录清不掉不影响结论
}

if (problems.length > 0) {
  console.error(`✗ ${problems.length} 项失败:`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log('✓ import-backup 逻辑正确（merge 判重/不覆盖他人凭据、replace 整体还原、加密备份解密、错口令与非法格式被拒）')
