# 测试

## 一条命令

```bash
node scripts/test-all.mjs        # 全部不需要环境的单测，退出码即结论
node scripts/test-all.mjs --all  # 连需要环境的一起跑（要 magpie 网关 3425 与 web 3456 都在）

npm test                         # 等价于第一条
npm run test:all                 # 等价于第二条
```

> `package.json` 里只放**转发**的脚本（`test` / `test:all` / `verify:vendor` /
> `snapshot` / `console`），真正的逻辑都在 `scripts/` 里 —— 直接用 `node` 跑
> 与 `npm test` 完全等价，CI 用的是前者（不依赖 npm 的生命周期）。
> ⚠ `files` 白名单里**没有** `scripts/` 与 `tests/`，所以 `npm test` 只对
> 从源码 clone 的目录有效；发布出去的插件包里跑不了（也不需要）。

⚠ **两个 script 有副作用 / 要传参，别按「等价」当无参命令跑**：

| script | 怎么跑 | 注意 |
|---|---|---|
| `verify:vendor` | `npm run verify:vendor -- /path/to/upstream` | **必须**用 `--` 传上游目录，否则 exit 2（只打印用法） |
| `snapshot` | `npm run snapshot` | **会改写** `page/models.js`（它本来就是自动生成的快照），跑完记得 `git diff` 看一眼 |

汇总行会标出哪些用例有「真实资源断言未跑」，例如

```text
✓ t-usage.mjs  123 ms（另有 4 节真实资源断言未跑，设 JET_HUB_LIVE=1 才会跑）
```

那些断言默认跳过（会碰真实账号、可能轮换 token），但**不算成通过**。「整个用例都没法跑」（比如缺 `MAGPIE_WEB_KEY`）走另一条路，算「跳过」并单独列出。

`tests/t-models-nowait.mjs` 验的是 `models()` 不阻塞：它内部计时后判 **> 5 秒即失败**，之后还有一个 45 秒的定时器撑着进程，
所以全量跑时它会占 **45 秒左右**（其余用例合计十秒上下）。判据是「返回快不快」，不是「整个文件跑得快不快」。

## 分两层

**UNIT（不联网、不碰真实账号，`node scripts/test-all.mjs` 全跑）**

| 文件 | 测什么 |
|---|---|
| `t-writerefs.mjs` | `.credentials.yaml` 写回不吞行（单行 / 跨行 / 相邻 ref） |
| `t-cred-upsert.mjs` | 新增 ref 不被 `writeRefsInto` 打断；块标量、缩进指示、段边界、折行、非标准缩进、Unicode 空白行、裸 key 续行、任意值无损往返 |
| `t-deps.mjs` | 扫 Node 侧全部源码的 import，与 `package.json` / `vendor/package.json` 对账（含 `engines` 逐字与禁止变量动态 import） |
| `t-dead-account.mjs` | 死号过滤判据 |
| `t-account-pin.mjs` | 选号钉住：并发隔离、钉住死号仍被拦、两个入口判据一致 |
| `t-account-cache.mjs` | 账号列表缓存与失败路径 |
| `t-cred-alive.mjs` | 凭据还在不在：真容器判路径推导与五种情形（ref 在 / ref 不在 / 文件缺失放行 / 结构不认识放行 / 有 refs 段但段内为空不放行），以及 `ask()` 与 `authorize()` 的接线方向 |
| `t-baseline-store.mjs` | 积分分母的**持久化**契约（真读写临时磁盘）：水位跨天存活、每日基线按天失效、老文件缺 `kind` 兼容、白名单判定、同 key 取大值防倒挂。改坏 `saveDailyBaseline` 的 `kind === 'peak'` 或 `loadDailyBaseline` 的默认 kind ⇒ 必红 |
| `t-usage.mjs` | 用量换算、积分包合并与到期日排序；钱包 / 每日基线 / 历史水位三种分母口径（含白名单边界与合计行的 `/` 总和）；第 7 节是「凭据不在了」的文案 + 一段直接 import `vendor/lib/jet-hub-rpc.js` 的行为锁（删 `product` 判空守卫会红） |
| `t-checkin.mjs` | 一键领积分 |
| `t-options.mjs` | `prefer_full` / `dead_account_skip` 真的改行为；另测 `auth.options` 契约（≤16 项、key 正则、label ≤60、无重复）与 29 家图标（`data:image`、≤1MB、互不相同） |
| `t-attachments.mjs` | 附件服务（内容寻址、去重、上限） |
| `t-plugin.mjs` | 29 个工厂契约一致（auth 字段、模型条数、`limit.context` 存在） |
| `t-models-nowait.mjs` | `models()` 不阻塞（计时判 > 5 秒即失败，进程额外撑 45 秒） |
| `t-seed-auth.mjs` | 账号摊平进 `plugin-auth.json`（占位键、不碰别人的键、回读校验） |
| `t-auth-sync.mjs` | 启动时自动对齐 `plugin-auth.json`：摊平规则、只清本插件旧记录、别人的 oauth 登录态一条不删、幂等不重写、文件不存在能创建 |
| `t-import-backup.mjs` | 备份导入：merge 判重、replace 还原但不碰黑名单、`--keep-disabled`、加密容器、错口令与非法格式被拒 |
| `t-backup-keep.mjs` | `keepDisabledModels` 三态 + merge 不碰黑名单 |
| `t-login-reclaim.mjs` | 放弃授权时回收占位账号（四字段判据：昵称等于 id 或白名单、无到期时间、不可 refreshable、10 分钟内创建；外加 `login.poll` 二次确认） |
| `t-console-backup.mjs` | 控制台解壳：与 CLI / 前端导出侧三方契约常量对账、口令不裁剪、非 JSON 不被说成口令错 |
| `t-console-credits.mjs` | 控制台余额卡片：真实回包形状（`{accounts:[...]}`）摊平、三个额度字段方向（`total` 是可用合计、`expiringTotal` 是「total 中即将到期」仍可用、`expiredTotal` 是「已失效不可用」）、兼顶旧读数（`balance` + `error` 同时有值时打 `stale`）、`prefetched` 不重复发 RPC、`unsupported provider` 静默降级、每次调用重置 |
| `t-console-baizhi-split.mjs` | 百智云积分「每日 / 长期」拆分：每日桶名字集合与上游客户端 `DAILY_POOL_NAMES` 逐字对账（且不退化子串匹配）、真 `buildBaizhiBalance` 喂截图同形钱包（916.68 ⇒ 每日 99.64 / 长期 817.04）、四条已审计边界（未领取 / 超额「总额不可知」/ 领取标记缺失「未知」/ 冻结不进长期）与 postpaid、packages 缺失-非数组-空 ⇒ null、`loadBalances` 穿透（baizhi 带 `split`、通用渠道 `split:null` 且旧三档逐字不变、兼顶行照样拆、换渠道清零）、`formatCreditAmount` 组合串 = `长期 817.04 · 每日 99.64` 与 `renderAccounts` 接线（消费 `bal.split`、null 分支保留旧串） |
| `t-new-account.mjs` | 「在 magpie 里新建账号」链路（三家豁免、只拿 URL 就返回、三种终态） |
| `t-key-account.mjs` | Key 型渠道（modelscope / opencode）的「贴 Key 新建」：一条 `api` + `keyless` 方法、`ask()` 收 Key、`authorize(inputs)` 里调 `*.addAccount` |
| `t-magicrew-creds.mjs` | 超级麦吉凭据读取（在 IndexedDB 不在 localStorage；末节读真实 Edge，读到就验） |
| `t-magicrew-modes.mjs` | 超级麦吉两站的「新建」按 provider 决定试哪几条腿、顺序是 `browser` 在前、两条腿都失败时抛首条并附其余原因；断言常量真实值（先剥注释，防「注释里写一行同样文本」骗绿） |
| `t-snapshot-segment.mjs` | 快照脚本的分段归一（网关返回的 id 两种形态混着来） |
| `t-model-efforts.mjs` | 推理档位：`variants` 键列表、私有档位名翻规范名、能力字段不粘滞 |
| `t-model-prices.mjs` | 用量费用的目录价：价格表格式、`cost` 形状、**表里没有就不发**、真挂到 `provider.models()` 上 |
| `t-rpc-cover.mjs` | 控制台接了本体哪些 RPC、哪些明确交给 magpie 或弃用 |
| `t-console-strict-order.mjs` | 「严格手动顺序」开关：本体侧 RPC 契约（`{enabled}` 回包、只接布尔、不猜默认值）+ 控制台侧接线（按供应商存、切家重读、`change` 不是 `click`）+ 六个运行时行为（严格 `=== true`、**await 期间切走不许覆盖新渠道**、问不出来就置灰、空 provider 不发请求、成功/失败文案、失败后回读拨回） |
| `t-vendor-patches.mjs` | `vendor/` 的本地补丁还在不在：gemini 两个默认 client 常量**拆成两段**（含 `.d.ts`）且拼出来长度不变、`types.d.ts` 两处 `closeProvider`、magicrew 两个 `.d.ts` 的声明与实现对齐（同步整片覆盖时这几处都是静默丢） |
| `t-page-contract.mjs` | 侧栏页（`page/`）的结构性契约：沙箱里**不许有网络 API**（`fetch` / XHR / WebSocket / `EventSource` / `eval` / `new Function`，`connect-src 'none'` 下全是静默死代码）、HTML 无内联 `on*=`、`data-tab` 与 `data-panel` 一一对应、`data-copy` 目标存在、四种 `data-snippet` 各有**专属**实现（只判「非空 + 带网关」会被「落回 curl 分支」骗过）、控制台地址**优先取快照**（缺快照才退 18500） |
| `t-error-shape.mjs` | 错误出口三件套：不支持的路径回 **501**（不是 404，否则 magpie 只搁置模型、换个同样坏的端点重试）、`errorResponse` 抛错也带 code、上游 404/503 原样透传、`jsonResponse` 形状 |
| `t-hub-cors.mjs` | 控制台跨站防线：只认实际绑定的那一个端口、只认 `http`、`Host` 必须回环（挡 DNS rebinding）、跨站 Origin 与 `null`、跨站导航 403、写操作连 `same-site` 也拒、多值 `Sec-Fetch-Site` 绕不过；同源不误伤，被拦的请求不进 handler |
| `t-spawn-stdio.mjs` | 子进程 stdio 守卫：`spawnSync` / `execFileSync` / `execSync` **一律不许**用默认管道（受限沙箱禁管道 ⇒ EPERM、`status=null`、两条流全空，失败信息退化成一片空白），且不许写只对管道有效的 `encoding`；扫 `tests/` + `scripts/` + `src/` 全部调用点 |

**ENV（要真环境，`--all` 才跑）**

| 文件 | 需要什么 |
|---|---|
| `t-console.mjs` | 真起容器（~40s），会读写真实 `state.json` |
| `t-direct.mjs` | 真起容器 + 真 chat（流式 / 非流式，~40s） |
| `t-gateway.py` | magpie 网关 3425 在跑 |
| `ui-check.cjs` | magpie web 3456 在跑 + `MAGPIE_WEB_KEY` |

## 要 magpie web 登录 key 的两个脚本

`tests/ui-check.cjs`、`scripts/shot-usage.cjs` 都要用 magpie web 的登录 key。
**`shot-usage.cjs` 只认环境变量 `MAGPIE_WEB_KEY`；`ui-check.cjs` 两者都认**（位置参数优先，其次环境变量），
两个脚本里都不写默认值。

```bash
MAGPIE_WEB_KEY=<key> node tests/ui-check.cjs
MAGPIE_WEB_KEY=<key> node scripts/shot-usage.cjs
```

key 在启动 web 实例时打印：`● magpie web on http://127.0.0.1:3456/?k=<key>`。

没设 `MAGPIE_WEB_KEY` 时这两个脚本**直接退出码 2**，不会静默用一个内置值去连 —— 内置 key 曾随仓库公开过一次，这是修掉那个问题留下的判据。别把 key 写进任何脚本或文档。

（`scripts/shot-console.cjs` 不在这两个里面：它**不读** `MAGPIE_WEB_KEY`，走的是自己的 CDP 连接。）

## 截控制台截图

`scripts/shot-console.cjs` 要三件事同时成立，缺一样就退出码 1：

1. 控制台在跑（`http://127.0.0.1:18500/`，端口顺延时按实际那个填）；
2. `page/models.js` 快照与这台宿主的模型数**对得上** —— 对不上会打印
   `快照的模型数(N)不是这台宿主(:PORT)的(M)，快照过期或指向别的宿主` 并提示重跑 `node scripts/snapshot-models.mjs`；
3. **Windows** + 装了 Edge：脚本写死 `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe` 与调试端口 9341。

## 用哪个运行时

`scripts/test-all.mjs` 自己用 `node` 跑。要模拟宿主环境时用 magpie 自带的 bun（宿主就是 bun）：

```bash
# 路径随安装位置与版本变，先自己找：
#   Windows  %USERPROFILE%\.cache\magpie\bun\<版本>\magpie-bun.exe
#   macOS    ~/.cache/magpie/bun/<版本>/magpie-bun
#   Linux    ~/.cache/magpie/bun/<版本>/magpie-bun
# <版本> 与平台自己换：Windows 才带 .exe，macOS/Linux 不带
MAGPIE_BUN="$HOME/.cache/magpie/bun/<版本>/magpie-bun"   # Windows: ...\magpie-bun.exe
"$MAGPIE_BUN" tests/t-plugin.mjs
```

## 不重启 magpie 调试控制台

```bash
node scripts/run-console.mjs
```

单独起一个容器 + 控制台（不装进 magpie、不影响正在跑的那个实例），改完控制台代码刷新页面即可。排查「控制台某个操作没反应」这类问题用它最快。

## 改代码时的约定

- **每条修复都要有能证伪的断言**。写完先自己做一次变异：把修复改回旧写法，确认测试真的变红；再还原，确认变绿。只有「改坏了还绿」的断言等于没写。
- 断言里**不写死会漂的数字**（模型条数、账号数、RPC 条数、键数）——那些值随登录状态和上游更新当天就会变。用形状描述或从源头现算。
- 非默认路径的探针（起真容器、读写 `state.json`）必须设 `DSH_JET_HUB_STATE_DIR` 指向临时目录。本体的优先级是 `DSH_JET_HUB_STATE_DIR` > `profileContext.home` > `DSH_HOME` > `~/.dsh`，只传 `home` 参数会写进真实的 `~/.dsh/jet-hub/state.json`。
- 临时脚本放临时目录，跑完删掉；**绝不用 `git checkout <file>` 做临时还原**（会把未提交的修复一起回滚），要备份就 `cp`。
