// 核 `vendor/` 是否仍是「上游构建产物 + 13 个补丁文件」——把 docs/vendor.md 的
// 「怎么自己核一遍」那堆 shell 收成一条命令。
//
//   node scripts/verify-vendor.mjs /path/to/upstream     # upstream = 跑过 npm install 的上游仓库根
//
// 为什么需要它：`docs/vendor.md` 里「1170 个文件、其中 1157 个与上游逐字节一致」这条
// 基线是**整份快照唯一可复核的地方**。原来只能手动 `find … sha256sum | sort | diff`，
// 一旦临时目录被清掉就再也说不清「这 13 个差异到底是补丁还是被人手改了」。这个脚本
// 把两件事钉死：
//
//   1. 差异文件集合必须**恰好等于** PATCH_FILES（13 个）—— 多一个就是快照被污染，
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
 * 本仓库对上游构建产物做的**全部**改动（docs/vendor.md 的差异表，7 类 / 13 个文件）。
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
  'lib/types.d.ts',                     // ⑥ RpcModelSetDisabledManyRequest.closeProvider
  'lib/baizhi-rpc.js',                  // ⑦ 新增 baizhi.setSession（补网页登录态）
  'lib/baizhi-rpc.d.ts',                // ⑦ 同上，类型声明
].sort()

/**
 * 13 个补丁文件**内容**的 sha256 指纹。
 *
 * ## ⚠️⚠️ 为什么光有「差异集合 = 补丁表」还不够（2026-11-10 对抗审查 P1-4）
 *
 * 上面那条只核「这 13 个文件**与上游不同**」，不核「**怎么**不同」——
 * 实测把 `jet-hub-rpc.js` 的 `closeProvider ? true : 'keep'` 改回 `closeProvider`
 * （正是 CHANGELOG 说 `t-rpc-cover` 盯着的那个回归）、或给 `leveldb-sstable.js`
 * 加一行注释，脚本照样打印「无污染、无漏打」并 exit 0。
 *
 * ⇒ 补丁文件被人手改是本脚本**唯一**该抓、却又抓不到的一类。这里给每个文件存
 * sha256：任何字符改动都会红。
 *
 * ## 怎么更新
 *
 * 有意改补丁时跑 `node scripts/verify-vendor.mjs --print-hashes`，把它打印的
 * 13 行原样贴回来。**不要**为了让脚本变绿就跳过校验 —— 那等于把这条门禁拆掉。
 */
const PATCH_SHA256 = {
  'lib/backup.d.ts': '0f1169ae4beca9f5757a348e65385705deac52ea6226c3f9843eba9fff1b83b0',
  'lib/backup.js': '53631bb8e2c0022b8794c638089a2013ffff7da0291c37e796c7f4a829e431ba',
  'lib/gemini-oauth.d.ts': 'cbc9c21e0b39ecedee4eaf3749bc81439cbe45f77550b1d6bea5b38d3e332c52',
  'lib/gemini-oauth.js': '0e78a047d0ea62f70d30e54e16196a9530abf0c77e60ae027e4fb93d17220320',
  'lib/jet-hub-rpc.js': 'b72491d639a62e56dbdaf6eff7f8db6ee3f541229776122aa90ce3e55ccb52d9',
  'lib/leveldb-sstable.js': '2d6954eccdb63a46ec68d0cf57fdd7ded2d31df5463d77e5569ed29457ddb853',
  'lib/magicrew-browser-login.d.ts': '5e7c3359790c77badfb1f9ebe9de6c4d26509075957dd7ac9813861ff5d7fc97',
  'lib/magicrew-browser-login.js': 'e81f252e2cea662c336d39122b3ec8d0094bd54ec04256c0ae48d67afdbf42c4',
  'lib/magicrew-local-browser.d.ts': '7198b59278585fa3da5afbc68a23fa917575cc17a8ec096b2da3a31da3a30758',
  'lib/magicrew-local-browser.js': '6adc02a9116267151dd1c0f5fccb56e714637160512b5c27b44e33493143b435',
  'lib/types.d.ts': 'c259c4878f5f526494f9ebf28066d88a730ce519b4ef6a2ee0adfefe60849add',
  'lib/baizhi-rpc.js': 'a7aeabc1e0b156b29d42520b41bad9b696546a0d4e293782925a559f7d3ec9de',
  'lib/baizhi-rpc.d.ts': '87628eedb198b8f8e15f6d00854c3bc8fd909de52484506c9983701f81b39b42',
}

/**
 * 文档里写死的两个数（docs/vendor.md「与上游构建产物的差异」）。
 *
 * ⚠ `identical` 是「**归一化后**算一致」的数（**1157**），不是真逐字节（**1156**）：
 * `lib/client/jet-hub.js` 由 esbuild 打包，`__export` 的变量名取入口 basename ——
 * 本仓 `package.json` 的 `esbuild ^0.24.0` 给 `client_exports`、上游作者用的 0.25.x
 * 给 `index_exports`，差 3 字节。见 `BUILD_ARTIFACTS` / `normalizeExports`：
 * **归一化后仍要求逐字节相等**（不是整份文件豁免），所以干净快照算「一致」、
 * 手改任何一位都会进 `differing` 判污染。
 */
const EXPECT = { libFiles: 1170, identical: 1157, localeFiles: 2, maps: 584, mapMiB: '4.00' }

/**
 * 上游构建产物里**随工具链版本漂移**的文件 —— 既不是补丁，也不是污染。
 *
 * esbuild 给 `__export` 生成的变量名取入口 basename（`entryPoints: [index.js]`），
 * 不同版本命名不同：
 *
 * | esbuild | `lib/client/jet-hub.js` 里是 |
 * |---|---|
 * | 0.24.x（`package.json` 的 `^0.24.0` 只能装到这档） | `client_exports` |
 * | **0.25.x**（上游作者构建快照用的版本，逐字节复现） | `index_exports` |
 * | 0.27+ | 另外多一条 `@__PURE__` 注解 |
 *
 * ⇒ 直接比 sha256 会把 `lib/client/jet-hub.js` 报成「手改或污染」（实测：任何按
 * `docs/vendor.md` 取法 `npm install` 的人都拿到 1156 而不是 1157）。
 *
 * ## ⚠️⚠️ 修法：归一化后仍要求**逐字节相等**，**不是**整份文件豁免
 *
 * 2026-11-10 一审实测：`BUILD_ARTIFACTS` 式的「白名单豁免」会把**真手改**一起吞掉
 * （改 1 个字符仍然 exit 0、还打印「无污染」）。正确做法是把这个变量名抹平成
 * `EXPORTS` **再比** —— 干净快照仍然算「一致」（文档 1157 成立），手改一位就红。
 */
const BUILD_ARTIFACTS = new Set(['client/jet-hub.js'])
const normalizeExports = (buf) => buf.toString('latin1').replace(/\b(?:client|index)_exports\b/g, 'EXPORTS')

/**
 * `lib/client/jet-hub.js` 里 `__export` 变量名的**拼写一致性**。
 *
 * ⚠️⚠️ 光做归一化比较**不够**（2026-11-10 对抗审查 P1-1）：文件里 3 处出现这个标识符
 * （`var X_exports = {}` / `__export(X_exports, …)` / `module.exports = __toCommonJS(X_exports)`）。
 * 把其中**任意 1 处**改成另一种拼写，归一化后仍是 3 个 `EXPORTS`、**逐位相等 ⇒ 绿**，
 * 而 vm 实测那是 `ReferenceError`（`var` 声明与 `__export` 用了不同标识符）—— 插件完全
 * 无法加载。8 种拼写组合里 6 种是这种破的。
 *
 * ⇒ 单独钉「两种拼写**恰有一个出现 3 次、另一个 0 次**」。这比「整份文件豁免」严格，
 * 也不受 esbuild 版本影响（0.24 给 `client_exports`、0.25 给 `index_exports`，都是 3/0）。
 */
const exportsSpellings = (buf) => {
  const s = buf.toString('latin1')
  return { index: (s.match(/\bindex_exports\b/g) ?? []).length, client: (s.match(/\bclient_exports\b/g) ?? []).length }
}

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
  // `--print-hashes`：有意改补丁后，把这里打印的 13 行原样贴回 PATCH_SHA256。
  if (process.argv.includes('--print-hashes')) {
    for (const f of PATCH_FILES) console.log(`  '${f}': '${sha256(path.join(VENDOR, f))}',`)
    process.exit(0)
  }
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
  /** 靠「归一化 esbuild 变量名」才算一致的构建产物 —— 干净快照下应有 1 个，且只允许这一个。 */
  const artifactNormalized = []
  for (const rel of ups) {
    if (!vendSet.has(rel)) continue
    const a = fs.readFileSync(path.join(upLib, rel))
    const b = fs.readFileSync(path.join(VENDOR, 'lib', rel))
    if (a.equals(b)) { identical += 1; continue }
    // ⚠️ 只对 BUILD_ARTIFACTS 里的文件做归一化重比 —— 干净快照仍算「一致」；
    //    真手改（任何字符）归一化后仍不相等 ⇒ 进 differing 判污染。
    if (BUILD_ARTIFACTS.has(rel) && normalizeExports(a) === normalizeExports(b)) {
      // ⚠️⚠️ 归一化只能证明「抹平拼写后相等」，**证明不了拼写本身一致**（P1-1）。
      //     把 3 处里任意 1 处换成另一种拼写，归一化后仍相等 —— 而那是 ReferenceError。
      const sp = exportsSpellings(b)
      const consistent = (sp.index === 3 && sp.client === 0) || (sp.client === 3 && sp.index === 0)
      if (!consistent) {
        bad(`lib/client/jet-hub.js 的 __export 变量名**混合拼写**（index_exports=${sp.index} / client_exports=${sp.client}）`
          + ` —— 必须是 3/0 或 0/3；混合会让模块 ReferenceError（插件完全无法加载）`)
        differing.push(rel)
        continue
      }
      identical += 1
      artifactNormalized.push(rel)
      continue
    }
    differing.push(rel)
  }
  differing.sort()

  console.log(`  vendor/lib ${vend.length} 个文件｜上游 ${ups.length} 个｜逐字节一致 ${identical} 个`)

  if (vend.length !== EXPECT.libFiles) bad(`vendor/lib 文件数应为 ${EXPECT.libFiles}，实际 ${vend.length}（同步后请更新文档与 EXPECT）`)
  else ok(`文件数 ${vend.length} 与文档一致`)
  const byteExact = identical - artifactNormalized.length
  if (identical !== EXPECT.identical) bad(`一致数应为 ${EXPECT.identical}（真逐字节 ${byteExact} + 归一化 ${artifactNormalized.length}），实际 ${identical}（同步后请更新文档与 EXPECT）`)
  else ok(`一致 ${identical} 个（真逐字节 ${byteExact} + 归一化 ${artifactNormalized.length}）与文档一致`)

  if (upstreamOnly.length) bad(`上游有、vendor 缺：${upstreamOnly.join(', ')}（同步漏拷）`)
  if (vendorOnly.length) bad(`vendor 有、上游没有：${vendorOnly.join(', ')}（快照被别的动作污染过）`)
  // 归一化只该命中那 1 个构建产物；多于 1 个说明白名单被滥用，逐个人工看。
  if (artifactNormalized.length > 1) bad(`靠归一化才算一致的构建产物应最多 1 个，实际 ${artifactNormalized.length}：${artifactNormalized.join(', ')}（检查 BUILD_ARTIFACTS）`)
  else if (artifactNormalized.length === 1) ok(`其中 1 个靠归一化 esbuild 变量名才算一致：${artifactNormalized[0]}`)

  // `differing` 里是相对 `lib/` 的路径；补丁表按仓库路径写（`lib/xxx`），比较时归一。
  const PATCH_REL = new Set(PATCH_FILES.map((f) => f.replace(/^lib\//, '')))
  const extra = differing.filter((f) => !PATCH_REL.has(f))
  const missing = [...PATCH_REL].filter((f) => !differing.includes(f)).sort()
  if (missing.length) bad(`这些补丁**不在**差异里，说明被同步覆盖了：${missing.join(', ')}`)
  if (extra.length) bad(`这些文件与上游不同，但不在补丁表里（手改或污染）：${extra.join(', ')}`)
  if (!missing.length && !extra.length) ok(`差异集合恰好等于补丁表（${PATCH_FILES.length} 个文件 / 7 类）${artifactNormalized.length ? `；另有 ${artifactNormalized.length} 个构建产物靠归一化算一致` : ''}`)

  // ⚠️⚠️ 上面只核「这 13 个文件**与上游不同**」，不核「**怎么**不同」（2026-11-10 对抗审查 P1-4）。
  // 实测把 `jet-hub-rpc.js` 的 `closeProvider ? true : 'keep'` 改回 `closeProvider`、
  // 或给 `leveldb-sstable.js` 加一行注释，上面那条照样绿 —— 而这是本脚本**唯一**该抓
  // 却又抓不到的一类（补丁被人手改）。逐个核 sha256。
  const hashDrift = PATCH_FILES.filter((f) => {
    const want = PATCH_SHA256[f]
    if (want === undefined) return false
    // ⚠️ 文件**整个缺失**时 `sha256()` 会抛 ENOENT，把前面所有 `bad()` 全冲掉
    //    （2026-11-10 对抗审查 P2-1）—— 而那正是「补丁被同步覆盖」最该给诊断的
    //    形态。缺文件已由上面 `上游有、vendor 缺` 那条报，这里跳过。
    let got
    try { got = sha256(path.join(VENDOR, f)) } catch { return false }
    return got !== want
  })
  const hashMissing = PATCH_FILES.filter((f) => PATCH_SHA256[f] === undefined)
  if (hashMissing.length) bad(`PATCH_SHA256 少了这些文件的期望值：${hashMissing.join(', ')}（跑 --print-hashes 补上）`)
  if (hashDrift.length) bad(`这些补丁文件的**内容**与期望 sha256 不符（被手改？）：${hashDrift.join(', ')}`)
  if (!hashMissing.length && !hashDrift.length) ok(`${PATCH_FILES.length} 个补丁文件的内容 sha256 全部与期望一致`)

  // ── 2. .map 数量与体积 ─────────────────────────────────────────────
  console.log('· 2  source map')
  const maps = vend.filter((f) => f.endsWith('.map'))
  const mapBytes = maps.reduce((n, f) => n + fs.statSync(path.join(VENDOR, 'lib', f)).size, 0)
  const mapMiB = (mapBytes / 1024 / 1024).toFixed(2)
  const upMaps = ups.filter((f) => f.endsWith('.map'))
  // 文档写死的两个数（docs/vendor.md「564 个 .map / 约 3.91 MiB」那一节）——
  // 原来只 `ok()` 打印、从不判定，2026-11-10 对抗审查 P3-10 指出「文档说核」名不副实。
  if (maps.length !== EXPECT.maps) bad(`lib/*.map 应为 ${EXPECT.maps} 个，实际 ${maps.length}（同步后请更新文档与 EXPECT）`)
  else ok(`lib/*.map ${maps.length} 个（文档 ${EXPECT.maps} 个）`)
  if (mapMiB !== EXPECT.mapMiB) bad(`lib/*.map 应为 ${EXPECT.mapMiB} MiB，实际 ${mapMiB} MiB（同步后请更新文档与 EXPECT）`)
  else ok(`lib/*.map ${mapMiB} MiB（文档约 ${EXPECT.mapMiB} MiB）`)
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
  console.log(`\n✓ vendor/ 与上游 ${upstream} 完全一致：${identical} 个一致（真逐字节 ${identical - artifactNormalized.length} + 归一化 ${artifactNormalized.length}）+ ${PATCH_FILES.length} 个补丁文件，无污染、无漏打。`)
}

main()
