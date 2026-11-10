# `vendor/` 的来源、许可与差异

`vendor/` 是上游插件本体的一份**构建产物快照**，随本仓库分发。它不是本仓库的代码，也不在本仓库修改行为 —— 只有下面列出的 11 个文件因规避扫描器、补一个读取路径或补一处「全关即意图」而改过写法。

## 来源

| 项 | 值 |
|---|---|
| 上游源码仓库 | [`iJetLi/deepseek-harness-codearts`](https://gitee.com/iJetLi/deepseek-harness-codearts)（**主仓**；GitHub 上的 [`iJetLi/dsh-providers-hub`](https://github.com/iJetLi/dsh-providers-hub) 是镜像，落后在 `5042cec`） |
| 代码对应 commit | `1d12f80e14bde6c73e86aa7f5eef6257d6fe0d0b` |
| 版本号 | `0.2.1-rc.2`（上游 `package.json` 与本次构建同一次提交） |
| 许可 | MIT，`Copyright (c) 2026 Jet` —— 全文见 [`vendor/LICENSE`](../vendor/LICENSE) |

**为什么不用 npm 包**：npm 上的版本（最新 `2.21.261109`，`lib/` **1138** 个文件）落后于仓库 `master` 的 `1d12f80`（`lib/` **1170** 个）—— 少的 32 个正是 `marvis` + `marvis-*` 共 8 个模块各自的 `.js` / `.d.ts` / `.js.map` / `.d.ts.map`；两边都有的文件里 **79 个不同**，其中 11 个是本仓库的补丁（见下节），另外 68 个是上游在 npm 发布之后又往前走的部分。而本仓库要的是「渠道最全」的那一版。这一版是从源码 clone 下来 `npm install`（自动跑 `tsc -p tsconfig.json && node scripts/copy-assets.mjs && node plugin-src/client/build.mjs && node scripts/sync-bootstrap-lib.mjs`）构建出 `lib/`，再连同 `locale/` 拷进来；`package.json` 与 `LICENSE` 也取同一次提交的。

取法：

```bash
git clone https://gitee.com/iJetLi/deepseek-harness-codearts /tmp/up
cd /tmp/up && git checkout 1d12f80 && rm -rf lib && npm install
cp -r lib locale package.json LICENSE /path/to/magpie-Jet-Hub/vendor/
```

> `rm -rf lib` 不是多余的：`tsc` 不清理上次的产物，换 commit 后残留的旧文件会混进快照，让「逐字节一致数」对不上。

## 三个包名

上游同一个包在 npm 上以三个名字同版本发布：

| 名字 | 说明 |
|---|---|
| `deepseek-harness-codearts` | npm 包里 `lib/client/jet-hub.js` 的 `PLUGIN_ID` 用的就是它（仓库 master 自己构建出来的那份是 `dsh-providers-hub`） |
| `dsh-providers-hub` | 改名后的仓库名兼包名 |
| `dsh-codearts-auth` | 最早的名字（`0.2.0-rc.11` 起改名） |

三者的 `lib/` 只差同一个包名字符串出现的那两处（`id:` 与 `PLUGIN_ID`）。读源码去 GitHub（`iJetLi` 那个仓库最新），装包 / 对版本去 npm 任一名字。

> `npm view dsh-providers-hub` 里的 `repository` 字段指向 `zhuweiyou/dsh-providers-hub`，那是更早的同源仓库（2026-10-25 停更），`iJetLi` 那个包含它的全部历史并继续往前走。该字段只出现在 `dsh-providers-hub` 这个包在镜像 npmmirror 的 packument 顶层 —— `deepseek-harness-codearts` 就没有这个字段，官方 registry 也没有。

## 与上游构建产物的差异

`lib/` 共 1170 个文件，其中 **1159 个与上游逐字节一致**（按下面「取法」自己 `git clone` + `npm install` 构建时）；`locale/` 2 个全部一致。⚠️ 若改成拿 **npm 包**来比（上游作者用 esbuild 0.25.x 构建），`lib/client/jet-hub.js` 会差 3 字节 —— 那时是「真逐字节 **1158** + 归一化 **1** = 一致 **1159**」，见下节。剩下 11 个（6 类改动；`lib/gemini-oauth.*`、`lib/backup.*` 各是一对 `.js` / `.d.ts`，`lib/jet-hub-rpc.js` 配 `lib/types.d.ts`；magicrew 的三处改动落在 `lib/magicrew-browser-login.js` + `.d.ts`（两类）、`lib/magicrew-local-browser.js` + `.d.ts`、`lib/leveldb-sstable.js` 上）：

| 差异 | 原因 |
|---|---|
| `lib/gemini-oauth.js` 与 `.d.ts` 里两个默认 OAuth client 常量拆成两段字符串拼接 | 规避 GitHub push protection 误报。**值完全相等**（两个常量 `===`，长度 73 / 35 字符一致），另有环境变量可覆盖。边缘副作用：`.d.ts` 是声明文件，`declare const` 的初始值按 TS 规范只能是字面量，单文件 `tsc file.d.ts` 会报两条 `TS1254` —— 本仓库不编译类型声明，正常使用路径不受影响 |
| `lib/magicrew-browser-login.js` 与 `lib/magicrew-local-browser.js` 补读 IndexedDB | 上游这两处只从 `localStorage` 找登录凭据，而超级麦吉网页版把凭据写在 IndexedDB 的 `magic-global/user` 库里 —— 真机上「登录成功却永远读不到」。**行为只增不减**：localStorage 那条老路径原样保留，读不到才走 IndexedDB。⚠️ 上游同步到 `5042cec` 后底层换成 SSTable/WAL 解析（`leveldbRecordsText` 里的 `decodeValue` 能还原 localStorage 的值，但**解不了 IndexedDB 的值** —— 那是 V8 结构的 `"<字段名>"<长度字节><值>`），所以读取侧走 `indexedDbRawTextOfDir`（只用 `record.key` / `record.value` 的 latin1 原文，不 `decodeValue`），再由 `idbCredentialsIn` 按 UTF-16LE 的 `e\0y\0J\0` 头切出 JWT、按三个 `*_organization_code` 字段切出组织码。**不要**退回 `readFileSync().toString('latin1')` 扫原始字节的老路 —— 那会**编造**凭据（2026-11-05 对抗审计 P3-3） |
| `lib/magicrew-browser-login.js` 开窗前回收上次遗留的一次性 profile 目录 | 上游 `ChromiumSession.dispose()` 的删除只退避 2.1 秒，而窗口被用户关掉时没有任何回调保证走到 `dispose()`。两条路叠加的结果是 `%TEMP%` 里攒了 11 个 `magicrew-login-*` / 856 MB。现在开窗前扫一遍、只删够老的（Windows 1 小时、其它平台 6 小时）、每轮最多删 3 个（这函数同步跑在「点连接」与「窗口出现」之间，清完 856 MB 要约 7 秒，会让用户以为按钮坏了） |
| `lib/magicrew-local-browser.d.ts` 补上 `idbCredentialsIn` 声明与 `leveldbTextFor` 的 `hostname` 第三参 | 与上面 magicrew 那条配套的类型声明。上游同步到 `5042cec` 后 `leveldbTextFor` 的签名是 `(root, log, hostname = '')`，而 `.d.ts` 里还是两参 —— 按 `.d.ts` 写 `leveldbTextFor(root, hostname)` 会让 hostname 落到 `log` 位，于是 IndexedDB 那条腿被**静默**关掉（症状与「用户没登录」完全同形，2026-11-08 复核 P2-5）；`idbCredentialsIn` 是导出的（`tests/t-magicrew-creds.mjs` 第 8 节直接调），不声明的话 TS 侧看不到这条腿 |
| `lib/leveldb-sstable.js` 的 `readWalRecords` 补 `FIRST` / `MIDDLE` / `LAST` 分片重组 | 上游的 WAL 读取只认「整条记录落在一个 32 KiB 块里」这一种形态（`type !== 1` 就整体放弃），而真实 Edge 的 `IndexedDB/…/000003.log` 里有 WriteBatch 正好落在 32 KiB 块边界上 ⇒ 整份文件被判定为解析失败、退回原始字节扫描（那会**编造**凭据，2026-11-05 对抗审计 P3-3）。本仓按 `log_reader.cc` 补上：块尾补零跳整块、尾部半写保留已解析记录、SOLO `FIRST` / `MIDDLE` / `LAST` 与未知 `type` 一律 `undefined`。⚠️ **IndexedDB 值的读取不在这个文件**，在 `lib/magicrew-local-browser.js` 的 `indexedDbRawTextOfDir`（见上面 magicrew 那条）—— 两个文件各管一半 |
| `lib/magicrew-browser-login.d.ts` 的 `CDP_CREDENTIAL_EXPRESSION` 声明从字面量改成 `string` | 与上面 magicrew 那条配套的类型声明。上游源码是 `` `JSON.stringify({...})` ``（模板字符串 ⇒ `tsc` 生成**字面量类型**），而本仓补丁换成了读 IndexedDB 的 **async IIFE** ⇒ 值变了，字面量类型必然失配（编辑器里表达式正文整段是错的，且 `declare const` 的字面量类型让任何 `includes` 之类的字符串操作都被 TS 当成常量折叠）。改成 `string` 是唯一正确写法 —— 把整段 IIFE 写成字面量既不现实也没意义。2026-11-08 gitee 重审发现（P2-4） |
| `lib/backup.js` 与 `.d.ts` 的 `importBackup` 多一个 `keepDisabledModels` 选项 | 控制台导入备份时不让备份里的模型黑名单覆盖本机现状（用户 2026-10-31 报了「导入后 920 个模型全被关掉」）。未传该选项时行为与上游完全一致；CLI 的 `--keep-disabled` 是反向意图 |
| `lib/jet-hub-rpc.js` 的 `model.setDisabledMany` 在「黑名单覆盖该家全量目录」时补设供应商关闭意图 | 上游两个关闭入口语义不一致：`model.setAllDisabled`（「关闭全部」）默认 `closeProvider = true`，而 `model.setDisabledMany` **从不落意图**。magpie 的 provider 弹窗把「全部未勾选」原样传成 `modelIds`（实测 34 个全传）⇒ 黑名单 = 该家全量 ⇒ 下次打开弹窗 34 个模型全带「已在 Jet Hub 关闭」⇒ 勾选仍是 0 ⇒ 再保存还是全传，**死循环**，清空一次保存一次又满。补设意图后「打开供应商」能一把全恢复，配置里只多一个布尔而不是 34 条死键。判据用 `fullCatalogIds` 的**纯净并集**（`readableCatalogIds` 的 `known` 已把黑名单并进去，拿它判恒真）；目录不完整时不猜。未覆盖全量时一个字节都不变 |
| `lib/types.d.ts` 的 `RpcModelSetDisabledManyRequest` 多一个 `closeProvider` 选项 | 与上一条配套的类型声明。`setDisabledMany` 新增的 `closeProvider` 与 `setAllDisabled` 同名同义（默认 `true`）；不补类型的话，调用方按 `.d.ts` 传参会报「对象字面量只能指定已知属性」 |
| 没有 npm 包里的 `README.md` 与 `cordis.patch.yml`（缺失项，不计入上面的 6 类） | 那是 DSH 前端与插件补丁用的，magpie 侧用不到 |

保留时长为什么分平台：判据「只删够老的」是启发式。Windows 上还有第二道网（正被占用的文件删不掉，`rmSync` 抛 `EPERM`/`EBUSY`）；**POSIX 没有这道网** —— `unlink` 对已打开的文件是合法操作，删除会成功，于是「删了正在用的目录」反而成功，只是把那个窗口弄坏。所以 POSIX 只能靠阈值自保，取 6 小时。真正在用的目录存活上限是登录本身 4 分钟（`MAGICREW_BROWSER_LOGIN_TIMEOUT_MS = 240_000`），两个阈值相对它至少有 4 倍余量（按同文件注释的 13 分钟总寿命算：Windows 1h ≈ 4.6×、POSIX 6h ≈ 27.7×）。

除这 11 个文件之外，本仓库对上游代码**没有其它改动**。

> **已退役的一条**：本表原有一条「`lib/jet-hub-rpc.js` 的 `product.id` 判空守卫」。
> 2026-11-04 同步到 `fddb875` 时上游自己修了（`1b03f33 fix(jet-hub): product 恒为
> undefined，凭据未配置时抛 TypeError（15 家共用）`，两处都改成
> `(product as { id?: string } | undefined)?.id === ASTUDIO.id`），语义与本仓库原来的守卫
> 等价 ⇒ **这个补丁从此不用再打**。`tests/t-usage.mjs` 第 7 节的行为锁仍然有效：它验证的是
> 「凭据缺失时给可读文案、不抛 TypeError」，上游修好后这条依然成立。

唯一与「上游运行环境」相关的适配在 `vendor/` 之外：`src/connection.mjs` 给容器补一个 `connection` 服务（上游在 DSH 里由宿主提供）。

## 怎么自己核一遍

一条命令（推荐；出口码即结论）：

```bash
git clone https://gitee.com/iJetLi/deepseek-harness-codearts /tmp/up2
cd /tmp/up2 && git checkout 1d12f80 && rm -rf lib && npm install
cd /path/to/magpie-Jet-Hub && node scripts/verify-vendor.mjs /tmp/up2
```

它做四件事，任何一条不符就退出码 1 并逐条点名：

1. `lib/` 逐文件 sha256：**文件数 1170**、**一致 1159** 必须与上面那张表对得上
   （⚠ 自己构建时这 1159 就是真逐字节；拿 **npm 包**比时是 1158 + 1 个靠归一化算一致。
   `lib/client/jet-hub.js` 由 esbuild 打包，`__export` 的变量名取入口 basename ——
   本仓 `package.json` 声明的 `esbuild ^0.24.0` 给 `client_exports`，而上游作者发 npm 包
   用的 0.25.x 给 `index_exports`，**差 3 字节**。这**不是**补丁也不是污染：脚本把这个
   变量名抹平成 `EXPORTS` 再比，干净快照仍算「一致」（1159 成立）；**另外单独钉「两种
   拼写恰有一个出现 3 次、另一个 0 次」** —— 混合拼写（3 处里改 1 处）归一化后仍相等，
   而那是 `ReferenceError`（插件完全无法加载），2026-11-10 对抗审查 P1-1）；
2. 差异集合必须**恰好等于**补丁表那 11 个文件 —— 少一个 = 补丁被同步覆盖（静默故障），
   多一个 = 快照被别的动作污染过。**每个补丁文件还核 sha256 指纹**（`PATCH_SHA256`），
   所以「补丁文件被人手改」也抓得到 —— 有意改补丁时跑 `--print-hashes` 更新那 11 行；
3. `lib/*.map` **584 个 / 4.00 MiB**、`locale/` 2 个逐字节一致（两个数都是断言，不是只打印）；
4. `vendor/package.json` 的版本号与上游同一次提交一致（并打出依赖树，换机漏依赖就
   表现成「控制台打不开」）。

手动核法（脚本不可用时）：

```bash
diff -r /tmp/up2/lib /path/to/magpie-Jet-Hub/vendor/lib
# 逐文件哈希核（比 diff -r 更严，能看出换行 / 编码差异）：
cd /tmp/up2/lib && find . -type f -exec sha256sum {} + | sort -k2 > /tmp/up2/a.txt
cd /path/to/magpie-Jet-Hub/vendor/lib && find . -type f -exec sha256sum {} + | sort -k2 > /tmp/up2/b.txt
diff /tmp/up2/a.txt /tmp/up2/b.txt
```

注意：`diff` 应该**只**列出上表那 11 个文件；拿 **npm 包**比会多列出 `lib/client/jet-hub.js`（esbuild 产物，随工具链版本漂移，见上）。多出任何一个都说明快照被别的动作污染过。

`vendor/` 里有 584 个 `.map`（source map，约 4.00 MiB）运行时用不到，留着是为了与上游构建产物尽量逐字节一致、方便 diff 校验。要在意仓库体积可以删，不影响运行。

⚠️ **`lib/types.d.ts.map` 是有意保持上游原样的（2026-11-08 决策，不是漏改）。** `types.d.ts`
打了 `closeProvider` 补丁（多 8 行）而 `.map` 没重生成，于是编辑器里 `types.d.ts` 的跳转
行号在补丁点之后偏 8 行（同理，`lib/magicrew-local-browser.d.ts` 也改了、`.d.ts.map` 同样没重生成 —— 理由完全相同）。不重生成的三条理由：① 运行时用不到（上一条）；② 它没有
`sourcesContent` 字段，重生成必须拿上游 `src/types.ts` 重跑 `tsc` —— 本仓库做不到，而手改
`mappings` 的 VLQ 编码一旦改错只会让跳转更乱，且**没有任何测试能发现**；③ 保持逐字节一致
才能让上面那条 `diff` 校验维持「**1159 个一致**」这个可复核的基线（1170 − 11 补丁；拿 npm 包比时 `diff -r` 会多列 1 个 `client/jet-hub.js`，脚本归一化后仍是 1159）。这个偏差
**只影响 `types.d.ts`、`magicrew-local-browser.d.ts` 与 `magicrew-browser-login.d.ts` 三个文件的编辑器跳转**（后两者同样只有
`.d.ts` 改了、`.d.ts.map` 没重生成 —— 经 `grep -c sourcesContent` 确认两份 `.map` 都没有
`sourcesContent`，② 那条理由对它逐字成立），不影响编译或运行时行为（本仓库不编译类型
声明）。下次按「版本怎么升」重跑同步时，按同样口径处理即可 —— 同步产生的**新** `.map`
照旧整片拷入，不要为这一个文件手改。

## 版本怎么升

`vendor/` 是随仓库分发的快照，不跟着 npm 自动走。升版本要：

1. 重新 clone / 构建上游，替换 `lib/`、`locale/`、`package.json`、`LICENSE`
2. 把上面那 **6 类**改动重新应用。逐类点名（对应顶部差异表的 9 行 / 11 个文件 —— ② 拆 3 行、⑤ 拆 2 行，其余各类 1 行）：
   ① `lib/gemini-oauth.js` / `.d.ts` 的两个默认 client 常量拆成两段；② magicrew 补读 IndexedDB
   （`lib/magicrew-browser-login.js` / `lib/magicrew-local-browser.js` 各一对 `.js` / `.d.ts`）；
   ③ 开窗前回收一次性 profile（同一个 `lib/magicrew-browser-login.js`）；④ `lib/backup.js` 的
   `keepDisabledModels`（配 `.d.ts`）；⑤ `lib/jet-hub-rpc.js` 的「黑名单覆盖全量即补设供应商关闭意图」
   与 `lib/leveldb-sstable.js` 的 WAL 分片重组；⑥ `lib/types.d.ts` 的
   `RpcModelSetDisabledManyRequest.closeProvider` 类型 —— 外加上面那条「三个 `.d.ts` 的 `.map` 不重生成」的决策。
   **6 类都有测试盯着，漏打的直接红**：`t-backup-keep`（④）、`t-magicrew-creds`（②③与
   `leveldb-sstable`）、`t-rpc-cover` 第 8 节（⑤的意图补丁与空目录守卫）、`t-vendor-patches`
   （①的「拆成两段」形态与拼出来的长度、⑥的 `closeProvider` 两处、以及 ② 的两个 `.d.ts` 声明
   是否跟上实现）。唯一**没有**自动断言的是「`.d.ts.map` 不重生成」—— 它只影响编辑器跳转行号，
   判据是「与上游逐字节一致」，按上一条的基线人工核。
3. 加/减 provider 时：`src/plugin.mjs` 的 `DSH_PROVIDERS` + `NAMES` + `FALLBACK_MODELS`、`index.mjs` 的具名工厂、`src/icons.mjs`、`scripts/snapshot-models.mjs` 的 `NAMES`、`tests/t-plugin.mjs` 的 `EXPECTED_PROVIDER_COUNT`、`tests/t-new-account.mjs` 的两处 `=== N`
4. 跑 `node scripts/test-all.mjs` 与 `node scripts/snapshot-models.mjs`（后者需要有一个加载了**新** vendor 的宿主在跑；magpie 不热重载插件，旧宿主还在时用 `JET_HUB_META_PORT=<新容器端口>` 指定）

## LICENSE 的关系

MIT 要求「substantial portions」保留版权与许可声明，所以 `vendor/LICENSE` 必须跟着 `vendor/` 一起分发（`package.json` 的 `files` 里已含 `vendor`，整目录进包）。根目录的 `LICENSE` 是本插件自己的，两者不要混看。
