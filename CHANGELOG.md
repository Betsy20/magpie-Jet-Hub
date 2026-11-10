# 变更记录

本仓库还没有打 tag、也没有发布到 npm，所以下面按**日期**分段，而不是按版本号。
每次合并进 `main` 的改动都应在这里补一条：读者据此判断「要不要升级」，
而不是去翻提交记录猜哪条影响自己。

格式：`类型(范围): 一句话说清「改了什么」与「为什么」`。
类型用 `feat` / `fix` / `refactor` / `docs` / `test` / `chore`。

---

## 1.0.0（未发布）

- `test(page)`: **新增 `tests/t-page-contract.mjs`（36 条断言），把侧栏页「静默失效」的
  几类钉死**。侧栏页跑在 magpie 的窗口沙箱里（CSP `connect-src 'none'` + opaque origin），
  任何网络调用都**不报错、只哑掉** —— 用户看到的是「这个页面坏了」，而这条链路原来
  **一条自动化断言都没有**（`ui-check.cjs` 要真跑 magpie web，不进单测）。六类判据：
  ① `page.js` 里不许有 `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` /
  `eval` / `new Function`；② `index.html` 无内联 `on*=`；③ `data-tab` 与
  `data-panel` 集合相等（对不上时点标签什么都不发生）；④ 每个 `data-copy="#id"` 的目标
  真的存在；⑤ 四种 `data-snippet` 各有**专属**实现 —— ⚠ 只判「非空 + 带网关」会被
  「删掉分支后落回 curl 默认分支」骗过（本文件第一版就是这样，变异实测发现的），所以每种
  语言再钉一个独有标记、并断言四项两两不同；⑥ 控制台地址**优先取快照**
  `JET_HUB_CATALOG.console`（缺快照才退 18500，非 http 不认），`otherHosts` 只报
  别的宿主。五条变异（加 fetch / 改 data-tab / 删 node 分支 / 改 conUrl / 加内联 onclick）
  都实测变红。

- `test(console)`: **新增 `tests/t-console-strict-order.mjs`（36 条断言），把「严格手动顺序」
  开关的契约钉死**。这个开关是同步 `1d12f80` 时接进来的，回答的是「拖拽排序到底算不算数」
  —— **关着**的时候走余额分档的渠道会**盖过**卡片顺序，正是「拖拽时灵时不灵」那条报障的根，
  接反了用户得到的结论正好相反。原来**零覆盖**。三类判据：① 本体侧 RPC 契约（`enabled` 回包
  是对象不是裸布尔、`setEnabled` 只接布尔且**不猜默认值**、两参顺序）；② 控制台接线
  （按供应商存、`setProvider` 切家重读、`change` 不是 `click`）；③ 六个运行时行为 ——
  严格 `=== true`（`1` / `"yes"` 不算开启）、**await 期间用户切走时不许把上家的值盖到新
  渠道**、问不出来就置灰（「没有这个能力」而不是「点了没反应」）、空 provider 一个请求都不发、
  成功/失败文案、**失败后回读把开关拨回真实状态**。五条变异（删竞态守卫 / 失败不置灰 /
  `=== true` 改 truthy / 失败不回读 / 切家不重读）都实测变红。

- `fix(vendor)`: **`verify-vendor.mjs` 的「逐字节一致 1159」在本机必然失败**（2026-11-10 复核
  发现）。脚本把 `identical` 硬编码成 1159，但本仓 `package.json` 声明 `esbuild ^0.24.0`，
  而 `lib/client/jet-hub.js` 由 `plugin-src/client/build.mjs` 用 esbuild 打包、`__export`
  的变量名取入口 basename（`entryPoints: [index.js]`）—— 0.24 给 `client_exports`，上游作者
  用的更新版本给 `index_exports`，**差 3 字节**。⇒ 任何人按文档重建都会得到 **1158**，
  而脚本把 `client/jet-hub.js` 归进「手改或污染」并 exit 1 —— **一条必然误报的基线等于没有**。
    不是「整份文件豁免」—— 那会**把真手改一起吞掉**（2026-11-10 一审实测：改 1 个字符仍
    exit 0、还打印「无污染」）。正确做法是**归一化后仍要求逐字节相等**：把这个变量名
    抹平成 `EXPORTS` 再比 —— 干净快照仍算「一致」（1159 成立）；**另外单独钉「两种拼写恰
    有一个出现 3 次、另一个 0 次」**，因为混合拼写（3 处里改 1 处）归一化后仍相等，而那是
    `ReferenceError`（插件完全无法加载）。
  `docs/vendor.md` 的「它做四件事」同步补这句说明。

- `chore(snapshot)`: **`page/models.js` 重跑**（894 → **979** 个模型 / 28 → **29** 家，含
  `jet-hub-marvis/main-auto`）。上一版 PR 里写「需要加载了新 vendor 的宿主在跑，所以没硬跑」——
  但宿主早已重启（`:18500` 的 `magpie-bun` 是 22:25 起的，`/__meta` 报 29 家、`fullCatalogAt`
  就是当天），理由不成立。重跑后 `tests/t-new-account.mjs` 的 `SNAPSHOT_MISSING` 白名单
  **三条全部如约变红**（`magicrew` / `magicrewintl` 的凭据已恢复、`marvis` 也有目录了），
  按那个反向锚点的设计清空 —— 这条白名单的用途就是「能拿到时必须删掉」，留着等于永久
  掩盖真缺失。

- `chore(vendor)`: **新增 `scripts/verify-vendor.mjs`，把「1170 个文件 / 1159 个与上游逐字节一致 / 11 个补丁」
  这条快照基线变成一条可执行命令**。原来 `docs/vendor.md` 的「怎么自己核一遍」
  只有一堆 shell，而临时目录一清就说不清「这 11 个差异到底是补丁还是被人手改过」——
  这条基线是整份快照**唯一**可复核的地方。现在四件事一次核完：① `lib/` 逐文件 sha256，
  文件数与一致数必须对上文档；② 差异集合必须**恰好等于**补丁表那 11 个文件，**且每个补丁文件的 sha256 指纹必须与 `PATCH_SHA256` 一致**（否则「补丁被人手改」看不见；有意改补丁时跑 `--print-hashes` 更新那 11 行）—— 少一个
  说明补丁被同步覆盖（静默故障），多一个说明快照被污染；③ `lib/*.map` 584 个 / 4.00 MiB、
  `locale/` 2 个逐字节一致；④ `vendor/package.json` 版本号与上游同提交一致，并打出依赖树
  （换机漏依赖的表现是「控制台打不开」）。两条变异（把补丁文件换回上游原样 / 手改一个
  非补丁文件）都实测退出码 1。

- `test(vendor)`: **新增 `tests/t-vendor-patches.mjs`（13 条断言），把「同步会把补丁整片覆盖」
  里最静默的两类钉成断言**。`vendor/` 那 11 个补丁文件在「版本怎么升」第 2 步会被整片
  覆盖，而其中两类**没有任何测试**（`docs/vendor.md` 原来只承认 gemini 一条）：
  ① gemini 的两个默认 OAuth client 常量必须「拆成两段」—— 恢复成整串明文时本地一切
  正常，**只有 `git push` 那一刻被 push protection 拒**，所以判据刻意用**源码形态**
  （`.js` 单引号 / `.d.ts` 双引号各一条）加「拼出来的长度 73 / 35」**再加 sha256 指纹**，
  把整串 client id 写进断言等于把这条补丁要躲的东西原样搬回来；② `lib/types.d.ts` 的
  两处 `closeProvider?: boolean`，以及两个 magicrew `.d.ts` 的声明
  （`CDP_CREDENTIAL_EXPRESSION: string`、`leveldbTextFor(…, hostname?: string)`、
  `idbCredentialsIn`）必须跟实现对齐 —— 2026-11-08 P2-4 就是「实现改了、声明没跟上」
  的复发面。三条变异（改回明文 / 少一个参数 / 删空目录守卫）都实测变红。

- `fix(test)`: **`t-rpc-cover` 第 8 节的「全关即意图」判据补上空目录守卫**。原来那条正则
  只钉 `catalog.complete`，把 `catalog.ids.length > 0` 删掉照样全绿 —— 而空目录下
  `every()` **恒真**，正是「关一个模型就关掉整个供应商」那个缺陷的入口。现在整段
  `complete && ids.length > 0 && ids.every(…)` 一起钉，删任意一项立刻红。

- `docs(vendor)`: **npm 口径与「6 类」的定义一起对齐**。① `npm view deepseek-harness-codearts version`
  现在是 `2.21.261109`（不是文档里写的 `2.14.261103`），`lib/` **1138** 个文件；与
  vendor 的 1170 个比，少的 32 个正是 `marvis-*`，两边都有的文件里 **79 个不同** =
  11 个本仓补丁 + 68 个上游在 npm 发布之后又往前走的提交（`package.json` 的
  `upstream.version` / `upstream.note` 一并更新）。② 「6 类」原来只在两处各写一半
  （表格按行铺、正文按逗号列，数出来是 5 项），现在 ①–⑥ 逐类点名并与顶部差异表
  一一对应；「哪几类有测试盯着」那半句也按新用例重写（唯一没有自动断言的是
  「`.d.ts.map` 不重生成」—— 它只影响编辑器跳转行号，按基线人工核）。

- `feat(vendor)`: **同步上游到 `1d12f80`，接入腾讯 Marvis（家数 28 → 29）**。
  `vendor/lib` 1138 → **1170** 文件（+32：`marvis-*` 8 个源文件各自的 `.js` / `.d.ts` / `.map`），
  逐字节一致 1127 → **1159**（补丁仍是 11 个文件 / 6 类）。上游这 13 个提交里对我们
  **零影响**的几个源文件（`magicrew-*` / `leveldb-sstable` / `backup` / `gemini-oauth`）
  直接沿用已打补丁的版本，只有 `types.ts` / `jet-hub-rpc.ts` 需要手工重打。

  上游这一版的重点：
  - **腾讯 Marvis**（QQ / 微信 OAuth + `auto` 槽位 + 钱包额度）。它**没有**模型目录
    端点（9 条候选全 404），目录只能静态兜底，且只有一个 `main-auto` 槽位 ——
    真实模型 id（`deepseek-v4-1-flash-261017`）不能直传，上游回 400「无效模型id」。
  - 「严格手动顺序」开关（`strictManualOrder.getEnabled` / `setEnabled`）。它回答的是
    「拖拽排序到底算不算数」：关着时走余额分档的渠道会**盖过**卡片顺序 —— 那正是
    「拖拽时灵时不灵」这条报障的根。**按供应商存**，所以接在账号页而不是设置页。
  - qoder 企业账号额度在 `orgResourcePackage` 里（补解析 + 三个边界）。
  - 页头按钮搬进侧边栏底部操作行 + 「设置」弹窗 + 供应商开关。

  同步点（加/减 provider 时必须一起改的地方全部同步到 29）：`src/plugin.mjs` 的
  `DSH_PROVIDERS` / `NAMES` / `FALLBACK_MODELS`、`index.mjs` 的具名工厂、
  `src/icons.mjs`（Marvis 自绘：品牌蓝 + 对话气泡里一颗星）、`scripts/snapshot-models.mjs`
  的 `NAMES`、`console/console.js` 的「严格手动顺序」开关、`tests/t-plugin.mjs` 的
  `EXPECTED_PROVIDER_COUNT`、`tests/t-new-account.mjs` 的两处 `=== 29` 与
  `SNAPSHOT_MISSING`（Marvis 本机没凭据 ⇒ 快照里没有它）、`tests/t-rpc-cover.mjs` 的
  `EXPECTED_RPC_METHOD_COUNT` 91 → **93**（控制台接 65 → **67**）。

  全量 **31 通过 / 0 失败 / 0 跳过**（新增 `t-vendor-patches` 一条）。

- `fix(vendor)`: **修掉 `lib/magicrew-browser-login.d.ts` 的 `CDP_CREDENTIAL_EXPRESSION` 声明失配**
  （2026-11-08 gitee 重审 P2-4）。上游源码是 `` `JSON.stringify({...})` ``（只读 `localStorage`），
  本仓补丁早就换成了读 IndexedDB 的 **async IIFE**，但 `.d.ts` 仍停在旧值 ⇒ 声明的字面量类型
  让整个表达式在编辑器里**看不见**（`declare const` 的初始值按 TS 规范只能是字面量，
  而真实值是一段几百行的 IIFE，写成字面量既不现实也没意义）。改成 `string`。
  补丁文件 10 → **11 个**（6 类改动数不变），逐字节一致 1128 → **1127**。
- `docs(vendor)`: **`docs/vendor.md` 的两处上游信息写错**（同一轮 gitee 重审发现）。
  ① **上游仓库地址写成了 GitHub 镜像** —— `498a76e` 只在
  [`gitee.com/iJetLi/deepseek-harness-codearts`](https://gitee.com/iJetLi/deepseek-harness-codearts)，
  `gh api repos/iJetLi/dsh-providers-hub/commits/498a76e` 返回 **422 No commit found**
  （`5042cec` 才是 200）；而同一份文档别处又写「上游同步到 `5042cec` 后」，两个 sha 打架。
  照文档 `git checkout 498a76e` **必然失败**。改为主仓 gitee + 注明 GitHub 是落后镜像，
  两处 `git clone` 命令跟着改。
  ② **补丁归属写错** —— `indexedDbRawTextOfDir` 不在 `lib/leveldb-sstable.js`
  （那里只有 `readWalRecords`），在 `lib/magicrew-local-browser.js`。拆成两句各说各的，
  免得下次同步的人按文档去 `leveldb-sstable.js` 找 IndexedDB 读取。
- `feat(vendor)`: **同步上游到 `498a76e`**（自上次 pin `5042cec` 起 **7 个提交**）。
  `vendor/lib` 仍是 1138 个文件，逐字节一致数按实际 diff 是 **1128**（1138 − 10）；6 类改动不变，
  补丁文件实际是 **10 个** —— 此前文档写 9 个，漏了承载 magicrew IndexedDB 读取与 WAL 分片重组的
  `lib/leveldb-sstable.js`，本次核实补上。上游这几版的重点都在渠道可用性：
  - **astudio**：推理 / 目录网关从 `astronstudio-api-volces-prod.xf-yun.com` 迁到
    `maas-api.cn-huabei-1.xf-yun.com/v1`（`e86a8a2` / `f2ca0c1`）——旧域名的请求会失效。
  - **monkeycode / baizhi**：声明逐模型 `maxTokens`（monkeycode deepseek 系 128000；baizhi
    qwen 系列 65536、qwen-flash 32768），修「宿主不 materialize 输出预算 ⇒ 适配器 4096 兜底
    ⇒ 长回答被静默截断」（`054f778`）；baizhi 还补了能力表大小写不敏感匹配与 minimax-m3.1-flash。
  - **qoder**：积分「永久」改口径为「到期未知」（`CreditPackage.expiryUnknown`；展示层只改文案，
    选号 / 永久锁 / 聚合轮换行为不变，`e4c2c9e`）。
  - **magicrew**：五处 UA 副本收敛成唯一 `MAGICREW_USER_AGENT`，且必须是真实 build 号
    `Chrome/141.0.7390.55` —— 旧的 `Chrome/141.0.0.0` 命中阿里 WAF 黑名单，国际站积分 / 目录 /
    聊天**整站 405**（`498a76e`，issue IKTPRV）。本仓既有的 magicrew IndexedDB 补丁与新 UA 改动
    落在不同文件，互不冲突。
  - 其余为 monkeycode / baizhi 的三域审计返工（`5cee5be` / `0c467a3`）。

- `feat(vendor)`: **同步上游到 `5042cec`**（自上次 pin `fddb875` 起 **47 个提交**）。
  `vendor/lib` 1130 → **1138** 文件，逐字节一致数 1122 → **1129**（仍是 6 类改动，但补丁文件
  从 8 个变 **9 个**：`lib/magicrew-local-browser.d.ts` 补了 `idbCredentialsIn` 声明与
  `leveldbTextFor` 的 `hostname` 第三参）。
  上游这一版的重点是 `fix(qoder): 目录并 app 场景（QoDuck 只发布在那里）+ COSY_VERSION 抬到
  1.1.79`；对我们影响最大的是 **`lib/magicrew-local-browser.js` 被重写**（底层从
  `readFileSync().toString('latin1')` 换成 SSTable/WAL 解析 + Snappy 解压 + 按 sequence 去重），
  所以 IndexedDB 那条补丁要**换实现**而不是平移：
  - `leveldbRecordsText` 里的 `decodeValue` 能还原 localStorage 的值（`0x00` ⇒ utf16le、
    `0x01` ⇒ latin1），但**解不了 IndexedDB 的值** —— 那是 V8 结构的
    `"<字段名>"<长度字节><值>`。⇒ 新增 `indexedDbRawTextOfDir`，只用 `record.key` /
    `record.value` 的 latin1 原文、**不** `decodeValue`；再由 `idbCredentialsIn` 按 UTF-16LE 的
    `e\0y\0J\0` 头切 JWT、按三个 `*_organization_code` 字段切组织码。
  - **不要**退回「扫原始字节」的老路：从原始字节里匹配会**编造**凭据（2026-11-05 对抗审计 P3-3）。
  - 上游把 `pickCredential` 改名成 `credentialOfPair(jwt, organization, teamshare)`，
    `parseEvaluatedCredential` 的三套回退跟着改；`CDP_CREDENTIAL_EXPRESSION` 换成 async IIFE
    （读 IndexedDB 要 `await`），`Runtime.evaluate` 必须带 `awaitPromise: true`，否则
    `returnByValue` 下拿到的是 `{}`。
- `fix(vendor)`: **`model.setDisabledMany` 的 `closeProvider` 改成三态**（第 6 类本地补丁）。
  上游已吸收我们 2026-11-05 那版「黑名单覆盖全量即补设意图」（`071c220`），但它把第三参写死
  `true`。现在与 `setAllDisabled` 走同一条契约：`req.closeProvider !== false ? true : 'keep'`。
  **不能传布尔 `false`** —— `writeModelsWithProviderClosed(provider, ids, false)` 的语义是
  `delete providerClosed[provider]`，会**主动删掉**用户设好的意图（2026-11-04 真机报障
  「更新插件后停用的供应商被启用了」）；表达「只关模型、不动供应商意图」要用 `'keep'`。
  另外 `setAllDisabled` 那条**旧补丁已退役**：上游自己改成了三态，我们保留上游版本。

- `fix(vendor)`: **补掉 magicrew IndexedDB 这条腿上的 5 条残余风险**（同步上游时只做到「能跑」，
  2026-11-08 复核逐条修）：
  - **不再编造配对**：`idbCredentialsIn` 找不到「这条 jwt 之后最近的」组织码时原来退回文本里
    **第一个**，会产出**从未同时写入过**的 `{旧 jwt × 新 org}` ⇒ 上游 HTTP 200 + `code:403`，
    极难归因（平时被「未过期优先 → 同档取 iat 最新」掩盖，只在最新 jwt 的 iat 解不出、而旧的
    可解时暴露）。改成与 `credsNear()` 同一纪律：找不到就**不产出**，降级去开窗口登录。
  - **跨文件去重**：`indexedDbRawTextOfDir` 原来直接逐条渲染 `content.records`，同一 user key
    的新旧多版本（`.ldb` 里的旧值 + `.log` 里的新值 / tombstone）会同时进文本 —— 那正是上一条
    的触发条件，也会让已删除的记录「复活」。改成与 `leveldbTextOfDir` 一样走
    `leveldbVisibleRecords`。
  - **WAL 分片要能拼回来**：`readWalRecords` 原来只要 `type !== kFullType` 就整体返回
    `undefined`，而真实 Edge 的 `000003.log` 里有一条 WriteBatch 正好落在 32 KiB 块边界上、被
    `log_writer.cc` 切成 `FIRST` / `MIDDLE` / `LAST` —— 那是**正常**形态。于是一份完好的 WAL
    让整条腿退回原始字节扫描，「不许从原始字节里编造凭据」（2026-11-05 对抗审计 P3-3）实际
    从未在这条腿上生效。现在按 `log_reader.cc` 的语义重组分片（块尾补零 ⇒ 跳到下一块），
    真损坏（SOLO MIDDLE / SOLO LAST / 未知 type）才返回 `undefined`。
  - **JWT 判据统一**：`idbJwtsIn` 原来只查「长度 ≥ 80 且三段」，不查 base64url 字符集，与
    `magicrew-browser-login.js` 的 `isJwtShaped()` 不一致（同一份数据两条腿两套判据）。抽成
    同一个正则 `IDB_JWT_PART`，逐字对齐。
  - **`.d.ts` 补齐**：`lib/magicrew-local-browser.d.ts` 原来缺 `idbCredentialsIn` 声明，
    `leveldbTextFor` 也少 `hostname` 第三参 —— 按 `.d.ts` 写 `leveldbTextFor(root, hostname)`
    会让 hostname 落到 `log` 位，**静默**关掉 IndexedDB 这条腿（症状与「用户没登录」同形）。
  - 测试：`t-magicrew-creds.mjs` 从 99 项加到 **116 项** —— 新增 §14（WAL 分片行为级，逐段
    验 key / value / sequence 与块尾补零）、§15（去重的源码级锁），并把 §8 那条把 bug 锁成
    期望行为的断言掉头。

- `fix(console)`: **修掉三路代码审查出的 6 个 P1 + 5 个 P2**。
  - 「新人奖励」读 `claimable` / `canClaim` —— 这两个字段**任何 provider 都不返回**
    （`RpcOnboardingStatusResponse` 只有 tasks / earned / total / titles / points），条件恒为
    `false`，`onboarding.claim` 成了没有 UI 入口的死端点。改成 status → claim 两步都调。
  - 「新人奖励」按钮对全部 28 家渲染，但只有 loomy / raccoon / magicrew / magicrewintl 四家有
    onboarding 实现，其余 24 家点了必报 `unsupported provider`。加 `ONBOARDING_PROVIDERS` 门控。
  - `credits.balances` 没传 `force`：后端默认吃 120 秒共享读数缓存，而 `claimAll` 只清折算缓存、
    **刻意不清余额缓存** ⇒ 点完「全部领取」卡片积分 120 秒内不变。`loadBalances` 加第三参数。
  - `creditsClaim` 在 `await loadBalances` 之后没再校验 `#accProvider`，切渠道时会把旧 provider
    的余额写进新渠道的卡片。补第二次守卫。
  - `loadAccounts` 先 `await loadBalances` 再渲染，余额挂起时整页停在「读取中…」，连「停用 /
    删除 / 换 Key」都点不到。改成先渲染列表、再异步补余额。
  - `loadBalances` 在 `await` 之前就清空全局 `BAL`：切渠道时旧渠道的回包晚到会**无条件覆盖**
    新渠道的读数（卡片显示「—」或旧值）。改成返回局部 `Map`，调用方在 `#accProvider` 守卫
    **通过之后**才 `BAL = next`。
  - `onboarding.status` 是硬依赖：它失败时 `onboarding.claim` 一次都不发，而两者响应形状本来
    就不同。status 改成 best-effort（失败只 `console.warn`），详情以 claim 的回包为准。
  - AStudio 的 `{ accountId, loginUrl: '', reused: true }` 是**合法**路径（复用本机会话、没有
    授权地址），原实现会掉进 `else` 分支抛「本体没有返回 loginUrl」。补 `reused === true` 分支。
  - 领取摘要用跨单位求和的 `totalCredit` 展示积分（ZCode 的 1 亿 token + 100 积分 =
    `100000100`）。改用 `totalByUnit`。
  - OAuth 登录地址没有协议白名单，`javascript:` 会被 `window.open` 执行。加 `safeLoginUrl()`。
  - 「概览」页切回时不刷新（`TAB_LOADERS` 缺 `overview`）。补上 loader。
  - 账号上下移动的守卫只检查 `j` 没检查 `i`，stale id 下 `orderedIds[0] === null`。补 `i < 0`。
  - `scripts/shot-console.cjs` 默认 tab 列表还带着已不存在的 `credits`，且 `accounts` 不是 nav
    按钮 —— 直接跑会在 `overview` 之后 `.click()` 抛 `TypeError`，退出码 1，`proc.kill()` 与
    临时 profile 清理被跳过（Windows 残留 headless Edge 进程）。默认列表改成
    `['overview', 'accounts', 'settings', 'backup']`。

- `docs`: **文档与代码对齐**。① 供应商家数统一成「注册 28 家、有目录的 26 家」——
  `README.md` 与 `CHANGELOG.md` 原来直接写「26 家」，读者会以为插件只接了 26 家；②
  `README.md` 的 `tests/` 从「27 个 t-*.mjs」改成「30 个 UNIT + 2 个 ENV」；③ `CHANGELOG.md`
  的「82 条从空串变成裸 id」是错误归因，实际是 48 条空串→裸 id、21 条空串→非裸 id、13 条原本
  非空的值被改写；④ `docs/testing.md` 的 UNIT 表补上漏掉的 `t-console-credits.mjs`，并纠正
  「key 一律从环境变量取」（`ui-check.cjs` 也认位置参数）；⑤ `docs/vendor.md` 的补丁表补上
  `types.d.ts`（8 个文件 / 6 类 / 1122 个逐字节一致），并把「`types.d.ts.map` **保持上游
  原样**、不重生成」的裁决写进文档 —— 否则下次同步的人会把它当成漏改再纠结一遍。

- `fix(vendor)`: **`model.setDisabledMany` 在「黑名单覆盖该家全量目录」时补设供应商关闭意图**
  （第 5 类本地补丁）。上游两个关闭入口的语义不一致：`model.setAllDisabled`（关闭全部）默认
  `closeProvider = true`，而 `model.setDisabledMany` **从不落意图**。magpie 的 provider 弹窗把
  「全部未勾选」原样传成 `modelIds`（实测 34 个全传）⇒ 黑名单 = 该家全量 ⇒ 下次打开弹窗
  34 个模型全带「已在 Jet Hub 关闭」⇒ 勾选状态仍是 0 ⇒ 再保存还是全传，**死循环**（用户
  2026-11-05 报「模型又显示已在 JetHub 关闭」）。补设意图后「打开供应商」能一把全恢复，
  配置里只多一个布尔而不是 34 条死键。
  两个关键判据：① 必须用 `fullCatalogIds` 的**纯净并集** —— `readableCatalogIds` 返回的
  `known` 已经把黑名单并进去了（那是为了清理历史死键），拿它判「全量覆盖」**恒真**，等于
  「关一个模型就关掉整个供应商」；② 目录不完整（`complete === false`）时**不猜**。未覆盖
  全量时一个字节都不变。
  **同时接受 `closeProvider` 入参**（与 `setAllDisabled` 同一条契约，默认 `true`）：只补意图
  不管 `closeProvider` 的话，同一份黑名单状态经两个入口会得到不同的意图 —— 随后打开任意模型时
  `account-pool.js` 又清掉意图，状态反向跳变。`lib/types.d.ts` 的
  `RpcModelSetDisabledManyRequest` 同步补上该字段。
  `tests/t-rpc-cover.mjs` 第 8 节钉了 3 条**补丁存在性断言**：这 6 类补丁打在上游编译产物上，
  下次按 `docs/vendor.md` 重跑同步会被整片覆盖，且这六类都静默（不报错、只出症状）。

- `fix(console)`: **buddy 补偿改成点一次直接领取**。原来卡片上的「补偿」只查状态，真正领取
  要去页脚那一行输入框（`#accCompId`）+「查补偿」+「领取补偿」再点一次 —— 卡片本来就带着
  accountId，这一行纯属多此一举。现在点「补偿」= 先查 `buddy.compensationStatus`，可领就直接
  `buddy.claimCompensation`，领完再查一次拿最新数字；三种结论（领到 / 已经领过 / 活动未开启或
  已过期）都走同一条消息通道。页脚那一行连同 `compAction()` 一起删掉。
  顺手修一个既有问题：`onAccAction()` 末尾的 `loadAccounts()` 会把 `#accMsg` 覆写成
  「N 个账号」，所以动作自己的提示要等列表刷完再说（`flash` 变量），否则用户点完只看到
  「2 个账号」，不知道到底成没成。

- `feat(console)`: 左栏改成**供应商列表**（照上游控制台的排法）。26 家有目录的供应商各一张最小 48px 的卡片
  （品牌图标 + 名称 + 模型数），列表自己滚动、点一家就切到它的账号池；「概览 / 设置 / 备份」
  三个切页按钮固定在左栏底部一行（图标在上、文字在下）。图标来自新增的 `console/icons.js`
  —— 上游 `plugin-src/client/provider-icons.js` 那 29 个 data URI 直接搬过来（内联比多 29 个
  请求省事，也不用维护构建步骤）；没登记的那几家退回「首字 + 色相」，不是空白。
  **「账号」不再是一个标签** —— 侧栏点供应商就是看账号池，它不值得和另外三个并列；
  账号页顶部补一行当前供应商名，窄屏时也能看见自己在看谁。顺带把 `__meta` 的
  `providers[].name` 从「原样 id」改成显示名（`buddy` → `CodeBuddy (腾讯)`）——
  名字表本来就在 `plugin.mjs` 的 `NAMES` 里，现在通过 `JetHubContainer` 的
  `providerNames` 注入 `meta()`，定义只留一处。
  两个 `all: unset` 的坑顺手填了：它会连 `box-sizing` 和 UA 焦点环一起打回初始值 ——
  前者让每张卡右缘溢出 22px（侧栏底部常驻一条横向滚动条），后者让 26+3 个按钮
  Tab 过去完全看不见焦点（WCAG 2.4.7）。选中态的品牌色文字也从 `#1677ff`（3.81:1）
  换成新的 `--brand-ink`（亮 `#0f5fce` 5.49:1 / 深 `#6ba4ff` 6.69:1）。

- `feat(console)`: 控制台换成**上游同款视觉语言**。颜色、圆角、阴影、字号全部改取
  `vendor/lib/client/jet-hub.js` 里的 `--dsw-alias-*` token（品牌 `#1677ff`、卡片 14px 圆角、
  `0 2px 8px rgb(31 35 41/3%)` 阴影），左栏从文字导航换成 48px 高的**图标 + 名称 + 副标题**分组按钮。
  账号标签的结构性改动最大：七列表格换成**卡片流**，每张卡把凭据 ref / 有效期 / 可续期 / 出口代理 /
  积分收在一处，操作按钮贴在「操作」行最右（`grid-template-columns: 52px minmax(0,1fr)`），
  容器窄于 420px 时自动落到「操作」标签下方换行。**「积分」不再是独立标签** —— 积分是账号的属性，
  现在摊到每张账号卡上（`credits.balances` 一次拉整家渠道、按 accountId 摊开，四个坑都处理了：
  渠道 `unsupported provider` 降级成「—」、单账号 `error` 原样展示、
  「有 balance + 有 error」是**兼顶旧读数**（标一个「旧」badge，别把过期积分当实时值）、
  三个额度字段别弄反 ——「临期」是 `expiringTotal`（没下发就只显示合计，不编造「临期 0」），
  `expiredTotal` 是「已失效」另起一句「另有 N 已失效」；余数那档叫「其余」不叫「长期」，
  因为它是 `total - 临期`、把「永久」也算进去了）；
  原标签里的批量操作（查状态 / 查余额 / 查徽章 / 全部领取 / 永久锁定）挪到账号页第二行工具栏，
  每日签到与专项额度挪到概览。标签数 **5 → 4**，功能与 ID 契约一个没丢。
  > 几处**刻意偏离**上游，都是为了过 WCAG：① 正文灰 `--fg3` 从 `#8f959e` 压到 `#7c838e`
  > （3.02:1 → 3.82:1）；② 橙色小字用 `--orange-ink`（亮 `#92400e` 对白底 7.09:1、
  > 深 `#fbbf24` 对深底 10.63:1），标签底色写死 `rgb(180 83 9 / 12%)`；
  > ③ `.accountTag[data-tone=warn]` 亮 `#92400e` / 深 `#fbbf24`，
  > `[data-tone=off]` 用 `--fg2`（`--fg3` 只有 3.42:1）；④ 状态圆点 off 态用 `--fg3`
  > （`--fg4` 只有 2.64:1，非文本 UI 要 3:1）；
  > ⑤ 补 `color-scheme: light dark`，否则深色模式下原生 `<select>` / 滚动条还是亮的。

- `fix(console)`: 修「导入备份成功却报错」。`doImport()` 里的 `const passEl = $('#bkPass')`
  声明在 `if (parsed?.format === ENCRYPTED_FORMAT) {…}` 块内，块外引用是
  `ReferenceError: passEl is not defined`，被外层 `catch` 吞掉后把「导入完成」覆盖成一条报错。

- `test(console)`: 新增 `tests/t-console-credits.mjs`（31 条断言）。回包形状的**判据取自
  `vendor/lib/jet-hub-rpc.js` 的 handler 源码**，不自己写 `{accounts:[…]}` 字面量 ——
  否则测试和实现会一起错（这个坑真踩过：按裸数组取时循环体 0 次执行、每张卡显示「—」，
  而当时 29 个测试全绿）。含「裸数组形状必须摊出 0 条」的回归锚点。

- `feat(vendor)`: 同步上游到 `fddb875`（自上次 pin `6fa74723` 起 **110 个提交**、263 个文件）。
  `vendor/lib` 1058 → **1130** 文件，`docs/vendor.md` 的 pin / 文件数 / 逐字节一致数一并更新。
  ⚠️ 那时的逐字节一致数是 **1124**（6 个文件不同）；`74fc440` 补上 `lib/jet-hub-rpc.js` 后
  变成 **1123**（7 个文件不同）；`types.d.ts` 补上 `closeProvider` 类型后是 **1122**（8 个文件
  不同），以 `docs/vendor.md` 的当前值为准 —— 本条描述的是同步当时的快照。
  本地补丁从 **5 类降到 4 类** —— `lib/jet-hub-rpc.js` 的 `product.id` 判空守卫**退役**：
  上游 `1b03f33` 自己改成 `(product as { id?: string } | undefined)?.id === ASTUDIO.id`（两处），
  语义等价，那一行不再是本仓库独有的差异。

- `feat(providers)`: 接入上游新增的三家渠道 —— `baizhi`（百智云）、`monkeycode`（MonkeyCode）、
  `monkeycodeintl`（MonkeyCode 国际站），家数 **25 → 28**。同步点：`src/plugin.mjs` 的
  `DSH_PROVIDERS` / `NAMES` / `FALLBACK_MODELS`、`index.mjs` 的 3 个具名工厂、`src/icons.mjs`
  （两家自绘 + `intl()` 套国际站环）、`scripts/snapshot-models.mjs` 的 `NAMES`，以及家数锚点
  （`tests/t-plugin.mjs` 的 `EXPECTED_PROVIDER_COUNT`、`tests/t-new-account.mjs` 的两处 `=== 28`）。
  MonkeyCode 两站的网关 `GET /v1/models` 恒 405，目录只能来自上游内置常量
  （`monkeycode-basic/deepseek-flash`）；百智云取 `BAIZHI_KNOWN_CAPABILITIES` 首条 `deepseek-v4-flash`。

- `test(rpc)`: `tests/t-rpc-cover.mjs` 适配本体的新写法 —— import 改成支持**多名导入**
  （`import { parseBaizhiCredential, handleBaizhiRpc, baizhiSlotNamesOf }` 这种，旧正则只认单名）、
  扫前缀时补上**单方法改道**（`method === 'baizhi.startSession'`）、`prefixCases` 改成按 handler
  聚合前缀（`handleMonkeycodeRpc` 同时服务两站）、裸名 `case` 按每个前缀各展开一份。
  结果：`本体实际可调度方法总数 91（主 switch 67 + 前缀改道 23 + 单方法改道 1）`，控制台接 59 个
  （下面 `feat(console)` 补完 6 个后再到 65）。

- `feat(console)`: 控制台补上新三家的 Key 型入口 —— `KEY_CHANNELS`（建号）与 `REKEY_CHANNELS`
  （换 Key）各加三条，`submitRekey` 的按家分支跟着从两路补成五路（qiniu / baizhi /
  monkeycode / monkeycodeintl / modelscope）。控制台可调度方法数 **59 → 65**。
  仍缺的 3 个（`baizhi.startSession`、`monkeycode.setSession`、`monkeycodeintl.setSession`）是
  「给已有账号补 session cookie」的高级入口，控制台历来只做建号 / 换 Key 两类，本轮不做。

- `chore(snapshot)`: `page/models.js` 重跑（894 个模型 / 26 家有目录 —— 注册总数 28 家，
  `magicrew` 两家仍拿不到目录，见下；控制台地址回到 `:18500`）。
  上一版是用 `JET_HUB_META_PORT` 指定临时容器取的数，快照于是把「数据源宿主」和「控制台地址」
  都记成了那台临时容器的 `:18501` —— 容器早杀了，插件页「完整控制台」那张卡点进去必然
  `ERR_CONNECTION_REFUSED`。宿主 `:18500` 现在返回的目录已经是 894 条（临时容器那版只有 885，
  当时的宿主则是 870），直接探默认端口即可，不再需要那个逃生口。
  ⚠️ 数据源从临时容器切回宿主后，`lobsterai` 家是**一次回退式大换血**而不是单纯加模型
  （删 14 加 13：`glm-5.3`→`glm-5`、`kimi-k3`→`kimi-k2.5`、`qwen3.8`→`qwen3.6`……，总数 20→19）。
  宿主的实时 `/__meta`（19 条）与本次快照逐条一致，不是快照写错；净增 +9 来自
  cline / modelscope / opencode / qiniu / workbuddy 五家。
  ⚠️ `magicrew` / `magicrewintl` 两家**仍然拿不到目录**（凭据失效、目录接口返 405），
  `tests/t-new-account.mjs` 的 `SNAPSHOT_MISSING` 白名单保持两条；凭据恢复后重跑快照会自动
  出现，届时那条反向锚点会红、提醒删掉白名单。
  ⚠️ `detail[].disabled` 这一轮从「全 false」翻成「886 true / 8 false」、`detail[].name` 有
  82 条变了（48 条空串→裸 id、21 条空串→非裸 id、13 条原本非空的值被改写）——
  那是 `~/.config/magpie/jet-hub-models.json` 里机器本地的开关状态
  被写进了受版本控制的快照。`page/page.js` 不消费 `detail`（只读 `gateway` / `models` /
  `providers`），所以**无用户可见影响**；将来谁要用这个字段，先想清楚它会随本机状态漂移。

- `fix(providers)`: `FALLBACK_MODELS` 里 `lobsterai` 的兜底模型从 `deepseek-flash` 换成
  `deepseek-v4-flash`。上游 2026-11-05 把 LobsterAI 目录里的 `deepseek-flash` 下架了
  （现只剩 `deepseek-v4-flash` / `deepseek-v4-pro` 等），旧 id 在新快照里不存在，
  `tests/t-new-account.mjs` 的「兜底 id 必须在快照里」那条会红。

- `docs` / `test`: 全仓仍写「23 家」的**现状描述**统一改成实际家数 **25**（这一轮只修到 25；
  随后同步上游又把家数升到 28，见上面 `feat(providers)` 那条）—— README 四处
  （架构段、容器必须共享的理由、目录结构两行）、`index.mjs` 与 `scripts/import-backup.mjs`
  的注释，以及 `tests/` 里 `t-model-prices` / `t-plugin` / `t-snapshot-segment` /
  `t-new-account` 的注释；其中 `tests/t-new-account.mjs` 的两条 `>= 23` 阈值一并收紧成
  `=== 25`（两处 `NAMES` 表实测都是 25 键；原来写 `>=` 挡不住表里多出过期键）。
  `tests/t-plugin.mjs` 的具名导出护栏另补一个**绝对家数锚点** `EXPECTED_PROVIDER_COUNT`（当时 25，本轮升到 28）：
  原来那两条检查都是**相对**的（正向只问「`PROVIDER_IDS` 里每个 id 都有对应导出」，反向只问
  「没有对不上 provider 的孤儿导出」），两边同时删掉一家（`DSH_PROVIDERS` 去掉 `'zcode'`、
  `index.mjs` 删掉对应那行 export）依然全绿，这条护栏就查不出来；加减 provider 必须同步改它。

- `fix(credentials)`: 凭据缓存改成**按文件戳失效**。`FileCredentialProvider._load()` 原来只在
  第一次读盘、之后永不刷新 —— 桌面版 DSH 与 magpie 插件是**两个进程**共用同一份
  `.credentials.yaml`，任一方续期 token，另一方的缓存就停在旧值；用户手改文件、
  跑 `scripts/import-backup.mjs` 写进来的新 ref 同样看不见，非得重启才行。而这里存的是
  access_token / refresh_token 这类**一次性**凭据，用旧值就是上游 401，旧 refresh_token
  被前一个进程消耗后更是彻底作废。现在每次读之前比对 `mtime + size`，变了才重读
  （一次 `statSync`，微秒级，换掉整份文件的读+解析）；文件被删时**保留**旧缓存不抛错
  —— 删文件不等于「旧值失效」，不该让运行中的请求瞬间全 500，真正的读盘失败仍由
  `readFileSync` 抛出，错误语义不变。`tests/t-cred-upsert.mjs` 新增 ㉚ 组 **12** 条断言
  （外部改值 / 外部新增 ref / `describe` / `listRefs` / 跨实例可见 / 删文件保留缓存 /
  文件重现后读新内容 / 等长改写），把缓存判据改回旧写法这 **9** 条立刻红；戳只比
  `size` 不比 `mtime` 时**只有**「等长改写」那条红（加它之前那一版 582 项全绿 ——
  也就是说缺了它就完全测不出来）。写路径（`set` / `unset`）
  同步缓存时，戳必须在 `renameInto` **之前**从临时文件上取 —— 放在替换之后取，
  会把「另一个进程那份新文件的戳」配到「本进程的旧内容」上，下次判「戳没变」
  就永久返回旧值（一审实测：500 次并发 `set` 有 18% 落进该状态，构造出来后
  连续 5 次 `resolve` 全返回旧值）。

- `fix(security)`: 控制台服务 `src/hub-server.mjs` 收掉**通配 CORS**。此前每个响应都带
  `Access-Control-Allow-Origin: *`，等于把 `/api/jet-hub`（含各渠道 access_key_id /
  access_key_secret / refresh_token）开放给**任意网页**跨域读取；`/api/jet-hub`
  还接 POST，等于同时是一个 CSRF 入口。初版写 `*` 的理由是「magpie 用 sandbox iframe
  嵌控制台，opaque origin 必须通配」，但 `page/index.html` 早就改成只显示地址、
  由用户在浏览器顶层打开，那条理由已经失效（`page/page.js` 里 `conUrlBox` 只读展示，无 iframe）。
  现在：
  - `Access-Control-Allow-Origin` **只回显控制台自己那一个来源** —— 协议 `http`
    （本服务不跑 TLS，`https` 来源不可能是自己）+ 主机 `127.0.0.1` / `localhost` /
    `[::1]`（允许 FQDN 尾随点 `localhost.`）+ **本次真正绑定的端口**。
    不按 `startHubServer({from, tries})` 的探测区间放行：容器调它时只传 `from: 18500`
    不传 `tries`，区间会变成 18500–18559 —— 那 60 个端口里任何一个本机页面都能读走凭据。
    同源 GET 浏览器不带 `Origin`；同源 POST 会带，带的就是控制台自己。
  - 非白名单 `Origin` 与 `Sec-Fetch-Site: cross-site` 直接 **403**：前者挡「读得到响应」的
    跨站读，后者挡 `<form>` 提交 / `fetch(mode:'no-cors')` 这类**读不到响应但会执行副作用**的请求
    —— CORS 头对它们完全不起作用，只能靠服务端拒。
  - **写操作**（POST/PUT/PATCH/DELETE）再收紧到 `Sec-Fetch-Site: same-site`：
    它的 site 不含端口，本机 `127.0.0.1:3000` 的页面与 `127.0.0.1:18500` 是 same-site，
    不收紧就能用 `<form enctype="text/plain">` 拼 JSON body 打写接口。读请求不收紧：
    能救的只有 `same-site` 导航（本机另一个端口的页面里点链接打开控制台），
    跨站导航本来就被上面那条 `cross-site` 挡住。
  - `Sec-Fetch-Site` 按**逗号拆开逐个判**，不做整体严格比较：同一个头来多行时 Node 会拼成
    `"a, b"`，于是 `Sec-Fetch-Site: same-site` + `Sec-Fetch-Site: cross-site` 拼成
    `"same-site, cross-site"`，整体比较两个分支都不命中就被漏过去了（实测过，是真绕过）。
  - `Host` 头必须是回环地址，否则 **403**：挡 DNS rebinding（攻击者域名解析到 127.0.0.1
    绕过 Origin 白名单）。
  实测（临时 PoC，已删）：`evil.example` / `null`（sandbox iframe）/ 伪造 `Host` /
  跨站 POST / 跨站预检 全部 403 且不带任何 CORS 头；同源 GET/POST 功能不变；
  `OPTIONS` 仍回 204，但不再挂 `*`（只对白名单 Origin 回显）。
  **副作用（用户可见）**：跨站**顶层导航**也会 403 —— 从聊天软件/文档里点
  `http://127.0.0.1:18500/` 这个链接，会看到一屏 `forbidden origin`。
  处置：把地址复制到地址栏直接打开（那种导航是 `Sec-Fetch-Site: none`，会放行），
  或走侧栏页上的「复制地址」按钮（`page/index.html`）。本机另一个端口的页面里点同一个链接是 `same-site`
  导航，放行。
  已知边界：`Sec-Fetch-Site` 是挡「读不到响应但有副作用」这类请求的唯一手段，
  它 Safari 16.4 / Firefox 90 / Chrome 76 起才有；更老的浏览器上跨站 `<form>` 仍能打写接口。
  影响面是本机用户的浏览器版本，不是网络可达面，故未再加 `Referer` 之类更脆的判据。
  回归闸 `tests/t-hub-cors.mjs`（47 条断言，已登记进 `scripts/test-all.mjs`，CI 自动跑）：
  逐处回退十道防线（通配回显 / `crossSite` / `loopbackHost` / 端口精确 / 协议 `https` 多认 /
  多值 `Sec-Fetch-Site` / 写操作 same-site / `Origin` 尾随点 / `Host` 尾随点 / 绑定端口写回）
  分别红 6 / 20 / 2 / 4 / 2 / 4 / 5 / 2 / 2 / 15 条 —— 十处没有一处是摆设。
  （数字对测试强度敏感：把「该放行的正向用例至少 N 次」那个下限调高，尾随点与端口两格
  会各多红一条，因为放行数掉到下限以下。所以这串数只在 `ALLOWED_THROUGH = 7` 时成立。）
  其中「绑定端口写回」是二轮安全审查揪出来的缺口：线上 18500 被占是常态，白名单若停在
  `from` 就是 fail-open（别人占着的那个端口的页面能读凭据），控制台自己反而进不去；
  而测试里的起始端口永远空闲，不专门造「被占」场景这条就永远抓不到。
  同时改了文件头那段「为什么单独起服务」的说明 —— 它还在描述已经废弃的 iframe 方案。
- `chore(ci)`: 补上 `.github/workflows/ci.yml` —— 此前仓库**完全没有 CI**，
  28 个离线单测只能靠人手动跑，PR 合进来之前没有任何自动门槛。
  现在 push 与 PR 都要求「离线单测全绿 + `npm pack --dry-run` 通过」。
  只跑不带 `--all` 的那一组：`--all` 需要 magpie 在跑（3425 网关 / 3456 web / 真凭据），
  CI 上没有这些。
  跑 `ubuntu-latest` + `windows-latest` 两档：`tests/t-cred-upsert.mjs` 的 ⑮ 组靠
  「chmod 0444 让 rename 抛 EPERM」造慢写，而 POSIX 的 `rename(2)` 只看目录写权限、
  覆盖只读文件照样成功，那一组在 Linux 上会自己跳过并打印理由。它测的
  `renameInto()` 退避是 Windows 上真实发生的路径，所以 windows 那一档不能省。
- `test(ci)`: CI 首跑暴露两个测试**从来没在干净环境跑过**（本机有那些文件，所以
  一直是绿的），以及三处「断言在 CI 上根本不执行」的假绿 —— 两档修完都是
  28 通过 / 0 失败 / 0 跳过。
  - `tests/t-cred-upsert.mjs` 的 `yaml` 改成优先从本仓库解析（`devDependencies`
    新增 `yaml`），本机没装 devDependencies 才退回 `~/.dsh/profiles/desktop` 那个；
    `catch` 收窄成只吞 `MODULE_NOT_FOUND`，包装坏了（dist 语法不兼容、目录残缺）
    必须原样抛出 —— 裸 `catch` 会把它改写成「去 `~/.dsh` 找桌面版的」，而那个
    路径在 CI 上并不存在，报错会指向一个误导性的 requireStack。
  - 同文件 ⑲ 节原来只读真实 `~/.dsh/.credentials.yaml` 与本体对账，干净环境
    必然走 `catch` 跳过 —— 补一份内联的 12 种落盘形态样本（单行 plain / 单引号 /
    双引号转义 / 双引号行尾反斜杠续接 / 块标量 `|` / plain 多行 / 中文 /
    长 base64 / 空值 / 双引号空串 / 含冒号 / 含井号），用 `yaml` 官方解析与
    `parseRefs` 逐条对比，任何环境都跑。
  - `tests/t-seed-auth.mjs` 的「`--dry-run` 不写盘」原来按 `USERPROFILE`/`HOME`
    推算目标、又要求文件已存在，在干净环境从未执行；改用 `JET_HUB_AUTH_PATH`
    引到临时目录，预置一份「别人的键」，内容与 mtime 双条件都比。
  - 同文件临时目录清理挪进 `finally`：原来 `process.exit(1)` 在 `rmSync` 之前，
    spawn 一失败就留下一个 `seed-auth-*` 目录。
- `fix(providers)`: 插件卡片补 `magpie.icon`。magpie 的 `ownIcon()`
  （`internal/plugin/market.go`）只认 `https://` 与 `data:image/` 开头的字符串，
  写成 `page/icon.svg` 这样的路径会被判成空串 —— 此前只有 `magpie.page.icon`
  （内嵌页面的图标）与 provider 的 `auth.icon`，两个都不是卡片图标，于是卡片那一行
  **回落显示了第一家 provider（accio）的图标**（内嵌 web UI 的兜底是
  `l?.icon || l?.npm?.icon || e.icon || subs[0]?.icon || ag?.icon`）。
  现在挂的是与 `page/icon.svg` 逐字节相同的 751 字节 SVG，以 data URI 内联。
- `fix(providers)`: **8 家**显示名补中文括注，让中文也能搜到 ——
  旧表里纯英文的是 7 家（`AStudio` / `Cline` / `Codely` / `Gemini Code Assist` /
  `OfficeAce` / `OpenCode` / `Qoder`），加上纯中文没有 ASCII 的 `超级麦吉`，
  这一轮统一成 `AStudio (讯飞)` / `Cline (开源)` / `Codely (Unity 团结引擎)` /
  `Gemini Code Assist (谷歌)` / `超级麦吉 (MagiCrew)` / `OfficeAce (果办)` /
  `OpenCode (开源)` / `Qoder (国际版)`。`src/plugin.mjs` 与
  `scripts/snapshot-models.mjs` 两张表同步，测试做双向对账。
  旧描述写 OfficeAce 是「华为云」，改成「果办」时**保留了归属**：
  `vendor/lib/officeace-adapter.js` 指向 `officeace.cn-southwest-2.huaweicloud-agentarts.com`，
  `vendor/lib/officeace-auth.js` 的 `CLAW_BASE` 与 STS 也都是 `myhuaweicloud.com`，
  登录文案写「请启动 OfficeAce 并登录华为云账号」⇒ 描述取 `果办 OfficeAce（华为云）`。
  「果办」这个中文名在我们的自有文档里没出现过（只在参考仓库 magpie-plugin-scaffold 的文档里
  见到），但上游 `vendor/lib` 自己就在用 —— `officeace-auth.js` / `login.js` /
  `provider-registry.js` 多处把 OfficeAce 官方客户端称作「果办」。两者不互斥，都留着。
- `chore(package)`: `keywords` 补 `opencode` / `auth` / `provider` ——
  magpie 市场搜索走的是 npm `<query> opencode`，缺这个关键词就搜不到。
- `chore(package)`: `files` 补 `CHANGELOG.md`，免得发出去的包里没有这份记录。
  （参考脚手架建议补 `magpie.name` 显示名，但你要求卡片继续显示 `magpie-jet-hub`，
  所以没加 —— 代价是 scaffold 的 `check.mjs` 会多报一条「显示名未设置」。）
- `docs`: 标题与目录里的「23 个供应商」改回 **25 家**（HEAD 停在 23，比实际少两家），
  供应商列表同步 `Codely (Unity 团结引擎)` 与 `超级麦吉 (MagiCrew)` 两个新显示名；
  `docs/testing.md` 里 `t-plugin.mjs` 的工厂条数与用例表一并同步。
- `fix(gateway)`: 不支持的路径从 **404 改成 501**（`code: unsupported_path` → `not_implemented`）。
  magpie 见 404 只会「搁置这个模型」，于是它换个同样不存在的端点继续试；
  501 是原样透出，不会被误判成模型坏了。新增 `tests/t-error-shape.mjs`
  把「status / code / message 三者齐全」钉成断言。
- `chore(ci)`: 新增 `tests/t-error-shape.mjs` 并挂进 `scripts/test-all.mjs`，离线用例 27 → **28 条**。

### 参考 `magpie-plugin-scaffold` 后**没有采纳**的（写在这里，免得下次被当成遗漏）

- `publish:npm` / `release.yml` / `registry-entry.json`：本插件是经 GitHub 仓库
  `magpie plugin add <目录>` 直接装的，**不发 npm、也不上 magpie 社区 registry**。
  补上这三样只会多一条没人走的发布链，而且会让人以为「发了 npm 才算发布」。
- `tests/` 改用 `*.test.*` 命名：我们用自己的 `scripts/test-all.mjs` 统一跑 28 条
  （它自己处理隔离目录、跳过条件、重试），CI 已把它挂成门禁。
  为对齐命名去重命名 31 个测试文件，收益只是让外部检查工具少报一条。
- 参考仓库的 `score.mjs`（100 分评分卡）**不适用于本仓库**，别看它的分数：
  它的身份门要求「`registry-entry` 的 package 与 npm 包名一致」「PROVIDER / BASE 不是模板占位」，
  B 组更是直接数 `tests/*.test.*` —— 这三条都假定你是从模板 `create` 出来的新插件。
  我们是已有 28 条自建用例、走 GitHub 目录安装的成熟插件，跑它必然报
  「这是模板原样，不是你的插件」并封顶 60 分，那是**口径不适用**，不是缺陷。
  真正通用的是同目录的 `check.mjs`（11 类合规规则），我们按它收口。
  以上对参考仓库行为的描述来自 <https://github.com/MYCF711/magpie-plugin-scaffold>
  （v0.3.7）的 `scripts/score.mjs` / `scripts/check.mjs` 源码，属他项目实现细节、会随其改版而变，
  照抄口径前请以该仓库当前版本为准。
- `privacy-scan.mjs` 那类脱敏扫描：实测对我们仓库跑出 **23 处命中，没有一处真凭据** ——
  21 处在上游 `vendor/lib`（`C:\Users\<user>\...` 这类示例路径、5 处形如 11 位手机号的
  示例号码、`ssoSessionId=${ssoSessionId}` 模板串），另外 2 处是
  `tests/t-import-backup.mjs` 的邮箱占位符与本文件自己举的这个例子。
  直接移植会引入 23 条噪音，需要另配白名单才有意义 —— 留给真要公开仓库时再做。
- **`errorResponse` 补显式 `code`**：`check.mjs` 报的这条是**静态文本匹配的误报** ——
  `vendor/lib/openai-gateway/stream.js` 的 `failureToOpenAiError()` 内部已经兜底
  `code: typeof value?.code === "string" ? value.code : "upstream_error"`，实测
  `errorResponse(new Error("boom"))` 一定带 `code`。而且那三处 `errorResponse(error)`
  **不能**改成传 code：传了就会覆盖掉上游 `LlmError` 里真实的原因码
  （限流 / 余额不足 / 模型不存在），把它们全压成同一个自选值。

## 2026-11-02

- `fix(accounts)`: 超级麦吉（国内 / 国际两站）在 magpie 里点「新建」改为**先真开浏览器**。
  `MAGICREW_CREATE_MODES` 原来是 `['local-browser','browser']`，而 `local-browser` 是
  「读本机已有登录态并导入」而不是新建 —— 本机浏览器登着超级麦吉时，点「新建」永远只导入老号；
  它返回的 `loginUrl` 还是空串，GUI 既不开窗也没链接。顺序调成 `['browser','local-browser']`。
  PR #14。
- `feat(vendor)`: 同步 gitee 上游到 **0.2.1-rc.2**，新增 `qiniu`（七牛云）与
  `magicrewintl`（MagiCrew 国际版），provider 23 → **25 家**。
  新增依赖 `wreq-js`（上游刻意用变量做动态 `import`，依赖守卫要能认出这种写法）。
- `test`: 补超级麦吉两站的多 mode 回归、贴 Key 三张表的对账、模型快照的**家级**白名单
  （此前是「整段文本前缀」匹配，把某一家整个删掉也照样绿）。

## 2026-11-01

- `fix(accounts)`: 凭据已经丢了的账号不再能签进来 —— 此前凭据文件被清掉后，
  账号池里仍留着条目，签入成功但一调用就 401。
- `feat(auth)`: 启动时自动把 magpie 的账号记录与本体的账号池对齐，修「本体里删了账号，
  magpie 那边还显示已登录」。
- `feat(usage)`: 发放日不同的积分包归成一类（`groupName`），余额只留两位小数；
  `aside: true` 的窗口按 magpie 的规矩不再塞 `amount` / `limit`（塞了就是假占比）。
- `feat(pricing)`: 给每个模型挂目录价（`src/model-prices.mjs`，464 条），
  修「用量页费用列全是 —」。根因是 magpie 的 `pricedNames()` 不剥 `provider/` 前缀，
  所以 `entry.cost` 必须挂在**带前缀**的 id 上。
- `fix(checkin)`: 只给上游真的支持签到的渠道声明签到；「这家没有签到功能」报 `ineligible`，
  不再标成失败。
- `feat(providers)`: `modelscope` / `opencode` 支持直接贴 API Key 新建账号。

## 2026-10-31

- `fix(deps)`: 补回 `jose` 与 `undici` —— 这两项此前只写在 `vendor/package.json` 里，
  而 magpie 的路径式安装**只 stat 目录、不跑 npm install**，于是从 GitHub 装、
  或路径装但没手动装依赖时，容器启动即 `Cannot find package 'jose'`，**控制台根本不存在**。
  同时加 `tests/t-deps.mjs` 依赖守卫（扫 Node 侧源码的 import，与 `vendor` 的声明对账）。
- `refactor(console)`: 「模型」标签删掉（模型开关交给 magpie 的 Providers 编辑器）；
  「用量」标签删掉（magpie 的 Usage 页读同一份 `usage.jsonl` 且更强）；
  徽章偏好搬进设置并修枚举（原来存的 `always` / `never` 与代码读的 `auto` / `subscription` / `credits` 对不上）。
- `feat(providers)`: 23 家换成官方标识，显示名对齐上游 `displayName`，
  模型缓存改为惰性求值。
- `feat(console)`: 控制台导入备份支持**加壳**的那一种
  （PBKDF2-SHA256 310000 轮 + AES-256-GCM），CLI 报错按原因分类。
- `fix(backup)`: 导入备份不再顺手替换模型黑名单，要还原得显式 `--keep-disabled`。
- `feat(plugin)`: 多账号与请求级钉号（`single: false` + `ask()` + 用 `AsyncLocalStorage`
  把选中的账号钉到这一次请求上）、去掉「Jet Hub · 」前缀、路由组收敛、凭据加固、
  超级麦吉临时 profile 回收（加单轮上限与删除复核）。
- `fix(models)`: 补上推理档位，修「推理强度改不动」；两条采集腿合并时不让能力声明粘滞。

## 2026-10-30

- 初始提交：把 `dsh-providers-hub`（`deepseek-harness-codearts`）的构建产物装进 `vendor/`，
  用内嵌 cordis 容器直调 `ctx.llm`，24 个 provider 各注册成独立的 magpie provider，
  凭据直接共用 DSH 的 `.credentials.yaml`，不依赖 DSH 进程。
