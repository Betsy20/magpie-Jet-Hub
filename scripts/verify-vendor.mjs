// 核 `vendor/` 是否仍是「上游构建产物 + 11 个补丁文件」——把 docs/vendor.md 的
// 「怎么自己核一遍」那堆 shell 收成一条命令。
//
//   node scripts/verify-vendor.mjs /path/to/upstream     # upstream = 跑过 npm install 的上游仓库根
//
// 为什么需要它：`docs/vendor.md` 里「1170 个文件、其中 1159 个与上游逐字节一致」这条
// 基线是**整份快照唯一可复核的地方**。原来只能手动 `find … sha256sum | sort | diff`，
// 一旦临时目录被清掉就再也说不清「这 11 个差异到底是补丁还是被人手改了」。这个脚本
// 把两件事钉死：
//
//   1. 差异文件集合必须**恰好等于** PATCH_FILES（11 个）—— 多一个就是快照被污染，
//      少一个就是补丁被同步覆盖（都属于静默故障，不报错的）；
//   2. 文件数 / `.map` 数 / `locale` / 版本号与文档里写的数字一致。
//
// 出口约定：0 = 与文档口径完全一致；1 = 有不一致（逐条打印）。
//
// ⚠ 只读：不写任何文件。要「修」就按 docs/vendor.md 的「版本怎么升」重跑同步。
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VENDOR = path.join(HERE, '..', 'vendor')

/**
 * 本仓库对上游构建产物做的**全部**改动（docs/vendor.md 的差异表，6 类 / 11 个文件）。
 *
 * 这份清单是**契约**，不是「已知差异」的备注：同步上游后如果少了其中任何一个，
 * 说明补丁被整片覆盖了（静默故障）；如果多出一个，说明快照被别的动作污染过。
 */
const PATCH_FILES = [
  'lib/backup.d.ts',                    // ④ keepDisabledModels 的类型
  'lib/backup.js',                      // ④ keepDisabledModels 的实现
  'lib/gemini-oauth.d.ts',              // ① 两个默认 client 常量拆两段
  'lib/gemini-oauth.js',                // ① 同上
  'lib/jet-hub-rpc.js',                 // ⑤ 黑名单覆盖全量即补设供应商关闭意图
  'lib/leveldb-sstable.js',             // ⑤ WAL 分片重组（Snappy 压缩块）
  'lib/magicrew-browser-login.d.ts',    // ② 声明跟上实现（CDP_CREDENTIAL_EXPRESSION）
  'lib/magicrew-browser-login.js',      // ② IndexedDB 读取 + ③ 一次性 profile 回收
  'lib/magicrew-local-browser.d.ts',    // ② 声明跟上实现（leveldbTextFor 三参 / idbCredentialsIn）
  'lib/magicrew-local-browser.js',      // ② IndexedDB 读取
  'lib/types.d.ts',                     // ⑤ RpcModelSetDisabledManyRequest.closeProvider
].sort()

/** 文档里写死的两个数（docs/vendor.md「与上游构建产物的差异」）。 */
const EXPECT = { libFiles: 1170, identical: 1159, localeFiles: 2 }

const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex')

/** 递归列出目录下所有文件的相对路径（POSIX 分隔符，便于跨平台比对）。 */
function walk(root) {
  const out = []
  const stack = ['']
  while (stack.length) {
    const rel = stack.pop()
    const dir = path.join(root, rel)
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) stack.push(child)
      else if (e.isFile()) out.push(child)
    }
  }
  return out.sort()
}

function main() {
  const upstream = process.argv[2]
  if (!upstream) {
    console.error('用法：node scripts/verify-vendor.mjs <上游仓库根目录>')
    console.error('  <上游仓库根目录> = 按 docs/vendor.md 的「取法」clone 并 npm install 过的那个目录')
    process.exit(2)
  }
  const upLib = path.join(upstream, 'lib')
  if (!fs.existsSync(upLib)) {
    console.error(`找不到上游构建产物：${upLib}`)
    console.error('  先在上游仓库里跑 `rm -rf lib && npm install`（它会 tsc + copy-assets + build）')
    process.exit(2)
  }

  const problems = []
  const bad = (msg) => problems.push(msg)
  const ok = (msg) => console.log(`  ✓ ${msg}`)

  // ── 1. lib/ 逐文件哈希 ──────────────────────────────────────────────
  console.log('· 1  lib/ 逐文件哈希')
  const vend = walk(path.join(VENDOR, 'lib'))
  const ups = walk(upLib)
  const vendSet = new Set(vend)
  const upSet = new Set(ups)
  const vendorOnly = [...vendSet].filter((f) => !upSet.has(f)).sort()
  const upstreamOnly = [...upSet].filter((f) => !vendSet.has(f)).sort()

  const differing = []
  let identical = 0
  for (const rel of ups) {
    if (!vendSet.has(rel)) continue
    if (sha256(path.join(upLib, rel)) === sha256(path.join(VENDOR, 'lib', rel))) identical += 1
    else differing.push(rel)
  }
  differing.sort()

  console.log(`  vendor/lib ${vend.length} 个文件｜上游 ${ups.length} 个｜逐字节一致 ${identical} 个`)

  if (vend.length !== EXPECT.libFiles) bad(`vendor/lib 文件数应为 ${EXPECT.libFiles}，实际 ${vend.length}（同步后请更新文档与 EXPECT）`)
  else ok(`文件数 ${vend.length} 与文档一致`)
  if (identical !== EXPECT.identical) bad(`逐字节一致数应为 ${EXPECT.identical}，实际 ${identical}（同步后请更新文档与 EXPECT）`)
  else ok(`逐字节一致 ${identical} 个与文档一致`)

  if (upstreamOnly.length) bad(`上游有、vendor 缺：${upstreamOnly.join(', ')}（同步漏拷）`)
  if (vendorOnly.length) bad(`vendor 有、上游没有：${vendorOnly.join(', ')}（快照被别的动作污染过）`)

  // `differing` 里是相对 `lib/` 的路径；补丁表按仓库路径写（`lib/xxx`），比较时归一。
  const PATCH_REL = new Set(PATCH_FILES.map((f) => f.replace(/^lib\//, '')))
  const extra = differing.filter((f) => !PATCH_REL.has(f))
  const missing = [...PATCH_REL].filter((f) => !differing.includes(f)).sort()
  if (missing.length) bad(`这些补丁**不在**差异里，说明被同步覆盖了：${missing.join(', ')}`)
  if (extra.length) bad(`这些文件与上游不同，但不在补丁表里（手改或污染）：${extra.join(', ')}`)
  if (!missing.length && !extra.length) ok(`差异集合恰好等于补丁表（${PATCH_FILES.length} 个文件 / 6 类）`)

  // ── 2. .map 数量与体积 ─────────────────────────────────────────────
  console.log('· 2  source map')
  const maps = vend.filter((f) => f.endsWith('.map'))
  const mapBytes = maps.reduce((n, f) => n + fs.statSync(path.join(VENDOR, 'lib', f)).size, 0)
  const mapMiB = (mapBytes / 1024 / 1024).toFixed(2)
  ok(`lib/*.map ${maps.length} 个 / ${mapMiB} MiB（文档写 584 个 / 约 4.00 MiB）`)
  const upMaps = ups.filter((f) => f.endsWith('.map'))
  if (maps.length !== upMaps.length) bad(`.map 数量与上游不同：${maps.length} vs ${upMaps.length}`)

  // ── 3. locale/ 与 package.json ──────────────────────────────────────
  console.log('· 3  locale/ 与版本号')
  const localeDiff = []
  for (const name of fs.readdirSync(path.join(VENDOR, 'locale'))) {
    const a = path.join(VENDOR, 'locale', name)
    const b = path.join(upstream, 'locale', name)
    if (!fs.existsSync(b)) localeDiff.push(`${name}（上游没有）`)
    else if (sha256(a) !== sha256(b)) localeDiff.push(name)
  }
  const localeCount = fs.readdirSync(path.join(VENDOR, 'locale')).length
  if (localeCount !== EXPECT.localeFiles) bad(`locale/ 应为 ${EXPECT.localeFiles} 个文件，实际 ${localeCount}`)
  if (localeDiff.length) bad(`locale/ 与上游不同：${localeDiff.join(', ')}`)
  if (!localeDiff.length && localeCount === EXPECT.localeFiles) ok(`${localeCount} 个 locale 文件全部一致`)

  const vpkg = JSON.parse(fs.readFileSync(path.join(VENDOR, 'package.json'), 'utf8'))
  const upkgPath = path.join(upstream, 'package.json')
  if (!fs.existsSync(upkgPath)) bad('上游没有 package.json，无法核版本号')
  else {
    const upkg = JSON.parse(fs.readFileSync(upkgPath, 'utf8'))
    if (vpkg.version !== upkg.version) bad(`vendor/package.json 版本 ${vpkg.version} ≠ 上游 ${upkg.version}`)
    else ok(`版本号 ${vpkg.version} 与上游一致`)
    // 依赖树必须能解析（换机时漏依赖就 ERR_MODULE_NOT_FOUND，表现为「控制台打不开」）
    const deps = Object.keys(vpkg.dependencies ?? {})
    ok(`vendor 依赖 ${deps.length} 个：${deps.join(', ')}`)
  }

  // ── 4. 结论 ────────────────────────────────────────────────────────
  if (problems.length) {
    console.log(`\n✗ ${problems.length} 条不一致：`)
    for (const p of problems) console.log(`  - ${p}`)
    console.log('\n同步/修复口径见 docs/vendor.md 的「版本怎么升」。')
    process.exit(1)
  }
  console.log(`\n✓ vendor/ 与上游 ${upstream} 完全一致：${identical} 个逐字节相同 + ${PATCH_FILES.length} 个补丁文件，无污染、无漏打。`)
}

main()
