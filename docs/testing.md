# 测试

## 一条命令

```bash
node scripts/test-all.mjs        # 全部不需要环境的单测，退出码即结论
node scripts/test-all.mjs --all  # 连需要环境的一起跑（要 magpie 网关 3425 与 web 3456 都在）
```

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
| `t-usage.mjs` | 用量换算、积分包合并与到期日排序 |
| `t-checkin.mjs` | 一键领积分 |
| `t-options.mjs` | `prefer_full` / `dead_account_skip` 真的改行为；另测 `auth.options` 契约（≤16 项、key 正则、label ≤60、无重复）与 23 家图标（`data:image`、≤1MB、互不相同） |
| `t-attachments.mjs` | 附件服务（内容寻址、去重、上限） |
| `t-plugin.mjs` | 23 个工厂契约一致（auth 字段、模型条数、`limit.context` 存在） |
| `t-models-nowait.mjs` | `models()` 不阻塞（计时判 > 5 秒即失败，进程额外撑 45 秒） |
| `t-seed-auth.mjs` | 账号摊平进 `plugin-auth.json`（占位键、不碰别人的键、回读校验） |
| `t-import-backup.mjs` | 备份导入：merge 判重、replace 还原但不碰黑名单、`--keep-disabled`、加密容器、错口令与非法格式被拒 |
| `t-backup-keep.mjs` | `keepDisabledModels` 三态 + merge 不碰黑名单 |
| `t-login-reclaim.mjs` | 放弃授权时回收占位账号（四字段判据：昵称等于 id 或白名单、无到期时间、不可 refreshable、10 分钟内创建；外加 `login.poll` 二次确认） |
| `t-console-backup.mjs` | 控制台解壳：与 CLI / 前端导出侧三方契约常量对账、口令不裁剪、非 JSON 不被说成口令错 |
| `t-new-account.mjs` | 「在 magpie 里新建账号」链路（两家豁免、只拿 URL 就返回、三种终态） |
| `t-magicrew-creds.mjs` | 超级麦吉凭据读取（在 IndexedDB 不在 localStorage；末节读真实 Edge，读到就验） |
| `t-snapshot-segment.mjs` | 快照脚本的分段归一（网关返回的 id 两种形态混着来） |
| `t-model-efforts.mjs` | 推理档位：`variants` 键列表、私有档位名翻规范名、能力字段不粘滞 |
| `t-rpc-cover.mjs` | 控制台接了本体哪些 RPC、哪些明确交给 magpie 或弃用 |

**ENV（要真环境，`--all` 才跑）**

| 文件 | 需要什么 |
|---|---|
| `t-console.mjs` | 真起容器（~40s），会读写真实 `state.json` |
| `t-direct.mjs` | 真起容器 + 真 chat（流式 / 非流式，~40s） |
| `t-gateway.py` | magpie 网关 3425 在跑 |
| `ui-check.cjs` | magpie web 3456 在跑 + `MAGPIE_WEB_KEY` |

## 要 magpie web 登录 key 的两个脚本

`tests/ui-check.cjs`、`scripts/shot-usage.cjs` 都要用 magpie web 的登录 key。**key 一律从环境变量 `MAGPIE_WEB_KEY` 取，代码里不写默认值。**

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
