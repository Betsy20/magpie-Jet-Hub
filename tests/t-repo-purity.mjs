// 仓库纯洁性守卫：这个仓库里**只许有插件本身**，不许有「某台机器」的坐标与凭据。
//
// 为什么要有这个测试（真实事故，2026-11-12）：
//   两个运维脚本 `scripts/deploy-plugin-hcss*.sh` 被原样提交进这个 public 仓库，
//   里面写死了 magpie web 面板的 18 位明文登录 key（`PROBE_WEB_KEY`）、两台生产
//   服务器的公网 IP、以 root 登录的账号名、以及服务器上私钥的绝对路径与文件名。
//   引入提交 `9003611` / `4fb5459` 一旦推送，泄露就已经发生（匿名 curl 即可下载
//   `.patch`）—— 事后改源码只是止血，撤销不了已公开的历史。
//
//   当时仓库里**一条防线都没有**：`.gitignore` 没有 `.ssh/` / `*.pem` / `.env`
//   任何一条，CI 没有 secret 扫描，也没有 pre-commit 钩子。而本仓自己早就写过
//   两条禁令（`scripts/test-all.mjs` 的 PRECONDITION 注释、`docs/testing.md`
//   「别把 key 写进任何脚本或文档」）—— 但「写在文档里」不是机制，没人会在
//   `git add -A` 时想起它。
//
// 所以这里把禁令变成一条会红的用例。它查两类东西：
//
//   ① **坐标**：IPv4 字面量、`~/.ssh/<名>`、`/mnt/workspace`、`hcss<N>` 这类
//      只有作者本机/生产环境才有的标识。它们与插件功能无关，却是攻击面清单。
//   ② **凭据**：PEM 私钥头、GitHub/AWS token 前缀、以及 `<名字>="<非占位值>"`
//      形态的硬编码 key（`PROBE_WEB_KEY="516…"` 就是这种）。
//
// 判据必须自己先被验过，否则「扫了 0 处」会变成假绿 —— 文件末尾的 SELF-TEST
// 用合成样本逐条确认每个匹配器**真能命中**，再拿真实仓库跑一遍。删掉任一条
// 匹配器，自检立刻红。
//
// 豁免（都是「这确实属于插件本身」的情形，逐条给理由，不是图省事）：
//   · `127.0.0.1` / `0.0.0.0` / `255.255.255.255` —— 回环与通配，控制台文档
//     必须写它们（`docs/testing.md` 的 `http://127.0.0.1:3456/?k=<key>`）。
//   · `1.2.3.4` / `192.0.2.*` / `198.51.100.*` / `203.0.113.*` —— RFC 5737
//     文档保留段，模板就该拿它们当占位符。
//   · `Chrome/<版本号>` 这类 UA 串（`Chrome/1xx.0.0.0`）与 SVG path 的 `d="M11.99…"`
//     数字串 —— 它们是**点分数字**但不是地址，靠「前后必须是分隔符」挡掉。
//   · `vendor/**` —— 上游本体原样拷贝，不由本仓负责；它的 IP 出现在解释
//     XFF 判定的注释里（公共 DNS 段），改它会让 vendored
//     文件与上游不一致，而 `t-vendor-patches` 正是守这件事的。
//   · `docs/known-issue-*.md` 允许出现主机**角色**（「部署实例上」），但不许
//     出现主机名/地址 —— 与其它文件同一套规则，无额外豁免。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)

// 只扫会被用户看到的文本形态。二进制（png/ico）与锁文件不参与。
const EXTS = new Set([
  '.md', '.mjs', '.js', '.cjs', '.json', '.yml', '.yaml',
  '.sh', '.bash', '.html', '.css', '.txt', '.example', '.toml',
])
// 这些目录不属于「本仓要为之负责的内容」：.git 是历史本身（清史由 doc 处理，
// 不是这条用例的事）、node_modules 是安装产物、vendor 是上游原样拷贝。
const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', '.cache'])

// ── 匹配器 ────────────────────────────────────────────────────────────────────

// IPv4：前后必须是非数字非点的分隔符。这一条同时挡掉
//   SVG `d="…0 .133.108.236.223.247l…"`（点后接点再数字）
//   与 `Chrome/131.0.0.0`（前面是 `/`）。
const IPV4 = /(?<![0-9./])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![0-9])(?!\.\d)/g

/** 允许出现的地址：回环/通配 + RFC 5737 文档段 + 常见占位符。 */
function allowedIp(o) {
  const [a, b] = o
  if (a === 127 || a === 0 || (a === 255 && o.every((x) => x === 255))) return true
  if (a === 192 && b === 0 && o[2] === 2) return true // 192.0.2.0/24
  if (a === 198 && b === 51 && o[2] === 100) return true // 198.51.100.0/24
  if (a === 203 && b === 0 && o[2] === 113) return true // 203.0.113.0/24
  if (a === 1 && b === 2 && o[2] === 3 && o[3] === 4) return true // 占位符
  return false
}

const RULES = [
  {
    id: 'ipv4',
    why: '服务器地址（与插件功能无关，是攻击面清单）',
    find(text) {
      const out = []
      for (const m of text.matchAll(IPV4)) {
        const o = m.slice(1, 5).map(Number)
        if (o.some((x) => x > 255)) continue
        if (allowedIp(o)) continue
        out.push(m.index)
      }
      return out
    },
  },
  {
    id: 'ssh-key-body',
    why: 'PEM 私钥本体',
    find: (text) => indices(text, /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g),
  },
  {
    id: 'ssh-key-path',
    why: '本机私钥路径/文件名（指向谁的钥、放在哪）',
    // `~/.ssh/config` 与 `~/.ssh/known_hosts` 是人人都会用的通用文件，
    // 不指向任何一把钥 —— 把它们算违规只会让这条规则在正常文档里乱响，
    // 然后被 `|| true` 掉。真正该拦的是**具体的钥文件名**。
    find: (text) => indices(text, /(?:~|\/mnt\/workspace|\/home\/[A-Za-z0-9._-]+)\/\.ssh\/(?!config\b|known_hosts\b)[A-Za-z0-9._-]+/g),
  },
  {
    id: 'gh-token',
    why: 'GitHub token',
    find: (text) => indices(text, /\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g),
  },
  {
    id: 'aws-key',
    why: 'AWS access key',
    find: (text) => indices(text, /\bAKIA[0-9A-Z]{16}\b/g),
  },
  {
    id: 'hardcoded-secret',
    why: '硬编码凭据（值看起来是真的凭据，不是占位符）',
    // 只认「名字里带 key/token/secret/pass」且等号右边是**像凭据**的字面量。
    //
    // 判据必须够窄：这条规则一旦误报，就会挡住正常改动（测试夹具里
    // `NEXT_TOKEN: 'PWNED'`、CLI 用法里的 `JET_HUB_BACKUP_PASSPHRASE='…'`
    // 都是合法文本），而误报多了这条用例就会被 `|| true` 掉 —— 那才是真完蛋。
    // 所以要求「长度 ≥16 且字母数字混合」或「≥16 位纯数字」。占位符
    // （`<…>` / `${VAR}` / `…` / `...` / `%s`）与文档保留地址一律放行。
    find(text) {
      const out = []
      const re = /(?:^|[\s;'"`{(])([A-Za-z_][A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASS|PASSWORD|PWD)[A-Za-z0-9_.-]*)\s*[:=]\s*(['"])([^'"\n]*)\2/g
      for (const m of text.matchAll(re)) {
        const val = m[3].trim()
        if (!val) continue
        if (/^[<${%]/.test(val)) continue // <占位> / ${VAR} / %s
        if (/^(?:\.{3}|…)$/.test(val)) continue // 省略号占位
        if (/^(?:1\.2\.3\.4|null|undefined|true|false)$/i.test(val)) continue
        if (/^https?:/.test(val)) continue // 公网端点不是本机坐标（且已被 ipv4 规则覆盖）
        const hasLetter = /[A-Za-z]/.test(val)
        const hasDigit = /\d/.test(val)
        const looksReal = val.length >= 16 && ((hasLetter && hasDigit) || !hasLetter)
        if (!looksReal) continue // 'PWNED' / 'wrong-passphrase' 这类夹具不算
        out.push(m.index)
      }
      return out
    },
  },
  {
    id: 'host-alias',
    why: '生产主机别名（与本机拓扑绑定）',
    find: (text) => indices(text, /\bhcss\d+\b/g),
  },
  {
    id: 'env-path',
    why: '生产机器的绝对路径（哪台机器、装在哪）',
    find: (text) => indices(text, /\/opt\/magpie\/|\/mnt\/workspace\//g),
  },
]

function indices(text, re) {
  const out = []
  for (const m of text.matchAll(re)) out.push(m.index)
  return out
}

// ── 自检：先证明每条匹配器真的会命中，再拿去扫仓库 ───────────────────────────
//
// 没有这一段，`RULES` 里正则写错（比如少个 `g`、把 `\b` 写成 `b`）会静默扫出
// 0 处，于是用例长绿而防线已经没了 —— 和 `t-baizhi-paste-session` 那次
// 「假守卫」是同一类缺陷。

const SELFTEST = [
  ['ipv4', 'const HOST = "' + ['111', '91', '17', '9'].join('.') + '"', true],
  ['ipv4', 'const HOST = "127.0.0.1"', false],
  ['ipv4', 'const UA = "Chrome/131.0.0.0 Safari/537.36"', false],
  ['ipv4', 'const d = "0 .133.108.236.223.247l.021"', false],
  ['ipv4', 'REMOTE_HOST=1.2.3.4', false],
  // 样本本身不能写成「真的」形态，否则这条用例会把自己扫出来。一律拆开拼。
  ['ssh-key-body', '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----\nAAAA', true],
  ['ssh-key-path', 'SSH_KEY="/mnt/' + 'workspace/.ssh/' + 'k"', true],
  ['ssh-key-path', 'SSH_KEY=~/.ssh/' + 'id_ed25519', true],
  ['ssh-key-path', '走本机 ~/.ssh/' + '<私钥文件名> 的别名', false],
  ['ssh-key-path', '密钥写在 ~/.ssh/' + 'config 里', false],
  ['gh-token', 'token=ghp_' + 'a'.repeat(36), true],
  ['aws-key', 'AKIA' + 'ABCDEFGHIJKLMNOP', true],
  ['hardcoded-secret', 'PROBE_WEB_KEY="516' + '0123456789abc"', true],
  ['hardcoded-secret', 'PROBE_WEB_KEY="${PROBE_WEB_KEY:?必须设}"', false],
  ['hardcoded-secret', 'MAGPIE_WEB_KEY=<key>', false],
  ['hardcoded-secret', 'REMOTE_HOST="${HOST:?必须设 REMOTE_HOST=<服务器地址>}"', false],
  ['host-alias', '在 hc' + 'ss2 上实测过', true],
  ['host-alias', '在部署实例上实测过', false],
  ['env-path', '跑 /opt/' + 'magpie/cache/bun', true],
]

const broken = []
for (const [id, sample, shouldHit] of SELFTEST) {
  const rule = RULES.find((r) => r.id === id)
  if (!rule) { broken.push(`${id}: 自检引用了不存在的规则`); continue }
  const hit = rule.find(sample).length > 0
  if (hit !== shouldHit) {
    broken.push(`${id}: 样本应${shouldHit ? '命中' : '不命中'}却相反 —— ${JSON.stringify(sample)}`)
  }
}
if (broken.length) {
  console.log('✗ 匹配器自检失败（守卫本身已失效，先修它）：')
  for (const b of broken) console.log('  ' + b)
  process.exit(1)
}

// ── 扫真实仓库 ────────────────────────────────────────────────────────────────

function walk(dir, out = []) {
  let rows
  try { rows = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const d of rows) {
    if (SKIP_DIRS.has(d.name) || d.name.startsWith('.') && d.name !== '.github') continue
    const p = path.join(dir, d.name)
    if (d.isDirectory()) walk(p, out)
    else if (EXTS.has(path.extname(d.name))) out.push(p)
  }
  return out
}

const files = walk(ROOT)
const hits = []
for (const f of files) {
  let text
  try { text = readFileSync(f, 'utf8') } catch { continue }
  const lines = text.split('\n')
  // 行号：把字节偏移换算回行，报错要能直接跳到那一行。
  const lineOf = (idx) => text.slice(0, idx).split('\n').length
  for (const rule of RULES) {
    for (const idx of rule.find(text)) {
      const ln = lineOf(idx)
      hits.push({
        file: path.relative(ROOT, f).split(path.sep).join('/'),
        line: ln,
        rule: rule.id,
        why: rule.why,
        text: (lines[ln - 1] ?? '').trim().slice(0, 100),
      })
    }
  }
}

// 结构守卫：部署脚本按「文件存在」判违规，不看内容。
// `.example` 模板允许 —— 它只含占位符，是「需要部署脚本时」的正确形态。
//
// 为什么**不**把 `docs/plan-*.md` 也列进来（原本列了，2026-11-12 收窄）：
//   那几篇是插件行为的上游实测记录（百智云拆分、MonkeyCode 403、额度窗口），
//   属于这个仓库真正的知识 —— 删掉它，下一个接手的人要重新踩一遍同样的坑。
//   里面有问题的只是顺带写下的机器坐标（主机别名 / 实例绝对路径），
//   那些**已经在上面 8 条内容规则里**被覆盖了。
//   「整类文件封杀」和「按内容判违规」在这里的区别是：
//   前者逼人删知识，后者只逼人把坐标换成占位符 —— 后者才是可执行的规矩。
const FORBIDDEN = [
  { test: (f) => /^scripts\/deploy-.*\.sh$/.test(f) && !f.endsWith('.example'), why: '部署脚本属于私有运维仓库，不进插件仓库（要留就提交 .example 模板）' },
]
for (const f of files) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/')
  for (const r of FORBIDDEN) {
    if (r.test(rel)) hits.push({ file: rel, line: 0, rule: 'forbidden-file', why: r.why, text: '(整个文件)' })
  }
}

if (hits.length) {
  console.log(`✗ ${hits.length} 处「与插件无关」的内容：`)
  for (const h of hits) {
    console.log(`  ${h.file}${h.line ? ':' + h.line : ''}  [${h.rule}] ${h.why}`)
    if (h.text) console.log(`      ${h.text}`)
  }
  console.log('\n这类内容该放哪：')
  console.log('  · 部署脚本 → scripts/deploy-plugin.sh.example（只从环境变量读，本仓已有这一份）')
  console.log('  · 施工计划/排障记录 → 可以进仓库，但里面的主机别名与实例绝对路径换成占位符')
  console.log('  · 凭据 → 一律走环境变量，见 docs/testing.md')
  process.exit(1)
}

console.log(
  `✓ 仓库纯洁：扫了 ${files.length} 个文本文件 × ${RULES.length} 条规则 + ${FORBIDDEN.length} 条结构规则，` +
    `无服务器地址 / 无凭据 / 无部署脚本（匹配器自检 ${SELFTEST.length} 条全过）`,
)
process.exit(0)
