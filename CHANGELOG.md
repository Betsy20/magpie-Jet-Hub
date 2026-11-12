# 变更记录

本仓库还没有打 tag、也没有发布到 npm，所以下面按**日期**分段，而不是按版本号。
每次合并进 `main` 的改动都应在这里补一条：读者据此判断「要不要升级」，
而不是去翻提交记录猜哪条影响自己。

格式：`类型(范围): 一句话说清「改了什么」与「为什么」`。
类型用 `feat` / `fix` / `refactor` / `docs` / `test` / `chore`。

---

## 1.0.0（未发布）

- `chore(security)`: **移除运维坐标与凭据，补两道机器守卫**（2026-11-12 安全事件）。

  `scripts/deploy-plugin-*.sh`（两个）是**本地部署脚本**，
  不是插件的一部分 —— 但它们把 magpie web 面板的 **18 位明文 key**、两台生产服务器的
  **公网 IP**、远程登录账号（`root`）、服务器上**私钥的绝对路径与文件名**一起带进了这个
  public 仓库（提交 `9003611` / `4fb5459`）。`raw.githubusercontent.com` 与 `.patch`
  都匿名可读，**泄露在推送那一刻就已发生**。

  同仓自己早就写过两条禁令（`scripts/test-all.mjs` 的 `PRECONDITION` 注释、
  `docs/testing.md`「别把 key 写进任何脚本或文档」）—— 但「写在文档里」不是机制，
  没人会在 `git add -A` 时想起它。

  - **删**：两个 `deploy-plugin-*.sh` + `docs/plan-install-local-plugin-*.md`
  - **补** `scripts/deploy-plugin.sh.example`：同样的流程，主机 / 账号 / 私钥 / 面板 key
    全部从环境变量读。原脚本里真正有价值的不是机器坐标，是那 6 条踩过的坑
    （`magpie plugin add <tarball>` 换源 → 502、`bun.lock` 锁旧 sha 静默装旧版、
    bun 写 7 位短 sha 只能前缀比、重启硬切在途 SSE、`--no-restart` 下要跳过「新增日志」
    探针、面板 key 不要回显），一条不落搬进了注释
  - **守卫** `tests/t-repo-purity.mjs`：8 条内容规则 + 1 条结构规则，
    带 **19 条匹配器自检样本**（删规则或把正则改坏到永不命中 ⇒ 自检立刻红，
    专防「扫了 0 处却报绿」）
  - **守卫** `.github/workflows/secret-scan.yml` + `.gitleaks.toml`：扫 git 历史。
    实测 gitleaks **默认规则对这两个脚本 0 命中**（18 位纯数字 key / IP / root 都不是
    「云厂商 key 形状」），所以写了本仓专用规则。拆成 `tree`（必过，拦新泄露）与
    `history`（定时跑，历史欠账的进度条）两个 job —— 只有一个 job 的话会从今天起长期红，
    大家学会忽略它，新泄露也看不见
  - `.gitignore` 按形状挡凭据：`.ssh/` / `id_rsa*` / `*.pem` / `.env` /
    `scripts/deploy-*.sh` 等 27 行（当时一条都没有，`git add -A` 想拦也拦不住）

  > ⚠️ **这个 PR 只清理工作区**。已经被提交过的副本仍在历史里，需要 `git filter-repo`
  > + force-push（破坏性操作，不在本 PR 里做）。完整命令见
  > `docs/security-incident-20261112.md`。**轮换 key 才是唯一实质补救** ——
  > 清史挡不住已经下载过的人。

- `fix(usage)`: **令牌量级收敛——千万级额度不再逐位写全**（2026-11-11 用户报障「我这里显示的
  不是 1m 而是每个数字都写出来了」，截图上是 `余额 9999976 token` 与
  `24 / 10,000,000 token`）。根因在 `fmtNum()`：它只 `toFixed(2)` 收小数位、**压量级为零**，
  于是 Marvis 的 `avail_tokens` 原样贴出去；而 `balance` 是纯文本字段，magpie 逐字照搬
  （卡片那一行因此位数差三个数量级，一眼读不出还剩多少）。
  - 新增 `fmtScaled(n, unit)`：`unit === 'token'` 时 `>= 1e6` → `M`、`>= 1e3` → `K`，
    其余仍走 `fmtNum`。**积分（credit）刻意不走量级压缩**——实测都是两位数
    （`146.341` / `4584.44`），压成 `0.15K` 只会更难核对；`unit` 比较**不分大小写**
    （OfficeAce 报的是 `'Token'`）。
  - 两处刻意的偏离 `vendor/lib/credits.js:487` 的 `formatTokenAmount`：
    ① **向下截断而非四舍五入** —— 这一行报的是剩余额度，舍入会向上虚报，最坏把
    `9999976 / 10000000`（只用了 24）渲染成 `10M / 10M · 剩余 100%`，与「满额未用」逐字相同，
    等于抹掉已用量；② **去掉尾零**（`10M` 而不是 `10.00M`），与同一行其余读数同一写法。
  - 5 个拼接点全部换到 `fmtScaled`：合计行 `balanceText`、钱包水位窗口、每日桶窗口、
    默认配额窗口、欠费 `text` 行。（`windowedTotal` 保持 `fmtNum`：它只服务
    `WALLET_WINDOW_POOLS` 那几家 credit 渠道，不在本次范围。）
  - 控制台同一问题一并修掉：`console/console.js` 的「积分」行原本直接输出 `bal.total`
    原始整数（`9931000`，且**无单位**），与账号徽标的 `9.93MToken` 两处读数对不上。
    现在走 `formatScaledAmount(value, unit)`（同一口径、同样向下截断），token 计渠道
    另补一个弱化的 ` token` 后缀（`.creditUnit`），免得被读成积分。
  - `tests/t-console-baizhi-split.mjs` 同步：断言从裸 `${bal.expired}` 改为
    `formatScaledAmount(bal.expired, bal.unit)`，并新增一条钉住合计值也走该函数。
    文案与落位不变，credit 渠道对非 token 走 `String(value)` ⇒ 旧串逐字保留。

- `fix(usage)`: **用量卡分母口径整套重做**（用户 2026-11-09 连续反馈：先是「剩余永远是 100%」，
  再是「这都变成负数了」，最后是「总额度也要有窗口」）。根因是插件一直把 `remaining` 冗余填进
  `limit`，而 magpie 用 `limit` 当进度条分母 ⇒ 分母 == 余额 ⇒ 刚查完就是 100%。
  `vendor/lib/credits.d.ts:184-196` 早写死了契约：`totalKnown:false` 时面板**不得**把
  `remaining / total` 并列显示。现在按数据来源分四种口径：
  - **钱包**（上游只给余额）：只给 `w.balance`，magpie 见到 balance 即不画进度条、只写「N left」。
  - **每日额度**（`每日积分`/`每日赠送`/`每日额度`/`每日签到奖励`，且上游没给可信总额）：
    分母 = **当天首见的余额**，跨天重置；余额中途上涨则抬基线（防「已用为负」）。
  - **MonkeyCode 积分余额**：没有积分包概念（`/wallet/credits` 等 7 个端点全 404），只有
    `/wallet/transaction` 流水 ⇒ 分母 = **近 30 天收入之和**（严格滚动、实时拉流水、翻页上限 5 页、
    60 秒缓存）。上游余额本来就可能为负（实测 -16.616，即 30 天收入 − 支出），负值时剩余显示 0。
  - **百智云「充值积分」**：长期积分，上游 `/balance` 只回 6 个字段、无初始总额无累计充值
    （~45 个流水/订单端点全 404，控制台 SPA 分包里也无相关 API 字面量）⇒ 分母 = **历史水位**
    （只抬不降，充值即抬），等价于「充值会让窗口扩大」。白名单 `WALLET_WINDOW_POOLS` 控制范围，
    其它渠道的钱包语义一律不动。
  - 行内配额只画前 2 条窗口（`ws.slice(0, 2)`），所以「总额度」不另开窗口，而是写进合计行
    （`699.96 / 699.96 credit`）；任一条窗口缺分母则合计行不加 `/`。
  - 负数与已过期积分改走 `text` 窗口（magpie 的 `balance` 会被 `Math.max(0, …)` clamp 且
    「说了 0」）；`text` 形态的「已欠费 10.4」解析时须补回负号（`parseFloat` 会丢掉）。
  - 新增 `tests/t-baseline-store.mjs` 锁持久化契约（水位跨天存活 / 每日基线按天失效 /
    老文件缺 `kind` 兼容）；`t-usage.mjs` 扩到 10 组分母断言。两处均做过反证（改坏代码必红）。

- `feat(marvis)`: **接入腾讯 Marvis**（2026-11-10）。上游 `5aad869 → 1d12f80` 引入的新渠道，
  这次连 vendor 一起追到 master 头 `6ad2e241` 并把它注册成第 **29** 家 magpie provider。
  - **登录不碰本机浏览器**：上游 marvis 的登录是「自己拉一个 Chromium，用 CDP 在
    `marvis_oauth` 请求发出**前一刻** `Fetch.fulfillRequest` 截下来」，前提是机器上有
    headful Chromium + X display（`--headless=new` 与 `chrome-headless-shell` 实测恒
    `F001`）。只有 sshd 的服务器上这个前提永远不成立 —— 用户点「新建账号」只收到
    「Marvis 找不到可用的浏览器」（2026-11-10 报障）。
    现在改走宿主自带的 `mode: 'code'` 通道（`internal/provider/pluginsignin_paste.go`；
    `/opt/magpie` 里 8 个社区登录插件全这么写）：`authorize()` 用 `authorizeUrlOf()`
    纯函数算出授权页地址返回给 magpie，由宿主显示「登录链接 + 粘贴框」，用户把登录后
    那个页面的**整条地址栏**（或只 code 那串）粘回来，`callback(pasted)` 里
    `marvisCodeOf()` 抠出 code、带 `Ual-Access-Guid` 调 `container.ctx.get('marvisAuth').exchangeCode()`
    兑换凭据，再拼成 `importCredentialFromMagpie()` 认的形状交给
    `account.create { mode: 'magpie-import', magpieCredential }` 落库（同一条腿、同一套
    openid 判重、同一套写池写凭据，宿主侧零改动）。
    能这么做的依据是三条实测：授权页地址是纯函数；`exchangeCode` **先校参数后兑 code**
    （不带 guid 头一律 `-109 RC_PARAMS_INVALID`，故浏览器那次跳转不烧 code，我们再兑一次仍有效）；
    宿主对 `mode: 'code'` 就是这么用的。
    **删掉了原来那条 `mode: 'browser'` 腿**：`startNewAccount` 去掉了 `extra` 形参、
    `startNewAccountSmart` 去掉了 marvis 分流 —— 现在 29 家里只有超级麦吉两站要试多种 mode。
  - **`account.create` 的两条 marvis 腿仍都以 `req.mode` 为条件**（`magpie-import` / `browser`），
    不带 `mode` 会一路落到 `unknown provider: marvis` —— 本插件只走 `magpie-import`。
  - **QQ / 微信各占一个新建方法**（`marvisOauthMethods()`）：面板先弹「用哪种方式登录」，
    用户当场挑 QQ 授权或微信扫码。两家凭据不通用（`login_type` 不同、续期端点不认另一边
    的 refresh），让用户自己选，比猜一个默认值再让他去开关里改更不会选错。
    **不能**做成 oauth 方法的 `ask()` —— `tests/t-new-account.mjs` 钉着「有 oauth 方法的
    provider 必须 `m.ask === undefined`」；多个方法不需要 magpie 侧任何改动。
  - **模型目录只有一条**（`main-auto`，展示名 DeepSeek V4.1 Flash）：上游实测 9 个远端
    目录端点全 404，目录就是 vendor 里的静态常量，真实 id `deepseek-v4-1-flash-261017`
    不能直传。`contextWindow` 声明 1_000_000、收图，刻意不声明 `maxTokens`
    （32k/65k/131k/1M 都返 200，上游不校验上界）。
  - **凭据 / 额度**：`MARVIS_ACCOUNT_DEFAULT` 前缀；钱包走 `/v3/marvis_get_wallet`
    （只有余额、无到期时间 ⇒ `expiryUnknown`）；续期走 `/marvis_client_login/marvis_refresh_token`
    （refresh_token 一次性轮换、可能回空串 ⇒ vendor 侧保留旧值）。
    **推理腿绝不能带 `Ual-Access-Signature`**（带了会 403 伪装成 401），业务腿 `/v3/*` 必须带 ——
    这些都在 vendor 的 marvis 模块里，插件层不碰 HTTP。
  - 本轮插件层 8 处接线：`DSH_PROVIDERS` / `NAMES`（`腾讯 Marvis`）/ `FALLBACK_MODELS`
    （`marvis/main-auto`）/ `index.mjs` 具名工厂 / `src/icons.mjs`（上游只有占位图：蓝底白 M）/
    `console/icons.js`（29 → 30 条）/ `scripts/snapshot-models.mjs` 的 `NAMES` / oauth 方法的 `mode: 'code'` 分支。
  - 测试侧：`EXPECTED_PROVIDER_COUNT` 28 → 29、两处 `NAMES` 计数 28 → 29、
    `SNAPSHOT_MISSING` 加 `jet-hub-marvis`（目录是 vendor 静态常量、本轮未重跑快照）。

- `feat(vendor)`: **同步上游到 `6ad2e241`（master 头）**（自上次 pin `3812738f` 起 **7 个提交**；2026-11-10）。
  上一轮（同日早些时候）有意停在 `3812738f`，理由是「其后的 master 只有腾讯 Marvis 一项新功能、
  magpie 用不到」—— **这条理由被推翻了**：Marvis 是真渠道（`channel: true`、有账号池、
  有钱包额度、有 `account.create`），接一下就能用。本次带入两块：腾讯 Marvis provider
  （见上一条 feat(marvis)），以及 4 个纯文档提交（README 渠道表 18 → 29、
  `docs/agent-notes/providers-marvis.md`，不进 `lib/`）。
  `vendor/lib` 从 1138 → **1170** 个文件（新增 32 个 `lib/marvis*` 文件，无删除），
  上游另改 41 个既有文件（`jet-hub-rpc.js` / `jet-hub-store.js` / `provider-registry.js` /
  `provider-credits.js` / `canonical-models.js` 等）。10 个补丁文件全部重打到位
  （`jet-hub-rpc.js` 与 `types.d.ts` 按语义移植，其余 8 个上游源码未动、原样保留），
  与上游 `6ad2e241` 原版构建逐字节比对：**恰差 10 个补丁文件**，`locale/` /
  `package.json` / `LICENSE` 三者上游无变化（`package.json` 只多一条 `test:e2e:marvis`
  脚本，本仓没取 —— vendored 快照不跑它自己的测试）。

- `feat(vendor)`: **同步上游到 `3812738f`**（自上次 pin `498a76e` 起 **10 个提交**；2026-11-10）。
  本次带入三块：
  - **Qoder 企业资源包解析**：企业账号（`userType=enterprise`）的额度在 `orgResourcePackage`
    而非个人积分桶，含 cap 兜底 / 到期未知 / available 三个边界修正 —— 纯 vendor 侧修复，
    插件层零改动。
  - **「严格手动顺序」开关**（默认关 = 升级前行为逐字节一致）：修「拖拽/序号排序时灵时不灵」——
    分档渠道的选号器先按积分到期档位、档内才看手动顺序，卡片序号对它们只是一半真话。
  - **PR #52 的 DSH 宿主 UI**（页头按钮搬侧边栏 / 设置弹窗 / 供应商开关）：改的是 `lib/client/`
    bundle，magpie 有自己的控制台、不执行那份代码，纯随快照带入的 inert 代码。
  `vendor/lib` 仍是 1138 个文件；10 个补丁文件全部重打到位（其中 `jet-hub-rpc.js` 与
  `types.d.ts` 上游有真改动，补丁按语义移植；其余 8 个上游源码未动、补丁版原样保留），
  与上游 3812738f 原版构建逐字节比对：**恰差 10 个补丁文件**，locale/package.json/LICENSE
  三者上游无变化。取源改走 Gitee 镜像归档包（`iJetLi/deepseek-harness-codearts`，与 GitHub
  同历史同 commit）—— git clone 常断，见 `docs/vendor.md` 的取法。

- `feat(console)`: **账号面板新增「严格按手动顺序选号」开关**（接上行的 vendor 开关）。
  账号卡片一直写着「序号 = 自动选号优先级」，但对 14 家走余额到期分档的渠道
  （buddy / workbuddy / lobsterai / qoder / qodercn / trae / loomy / minimax / minimaxintl /
  autoclaw / autoclawintl / magicrew / magicrewintl / astudio）实际执行的是「先按档位、档内
  才看序号」，用户把某号拖到首位、只要它不再持有临期积分，请求就**静默**落到别的号上。
  开关挂在账号面板操作条（仅这 14 家渲染，`BALANCE_TIERED_PROVIDERS` 必须与
  `vendor/lib/provider-registry.js:1221` 一一对应）：**开** = 序号是唯一优先级判据
  （档位只判可用性，「锁定永久积分」照旧生效）；**关**（缺省）= 升级前行为。写回以后端
  落盘后回读的值为准，不做乐观更新；读取失败不打断账号列表（显示层尽力而为）。
  `tests/t-rpc-cover.mjs` 总数锚点 91 → 93（`strictManualOrder.getEnabled/setEnabled`），
  两方法计入控制台已接（65 → 67）。

- `fix(plugin)`: **冷启动时后台刷新没有 in-flight 去重，最多 58 条链并发**。
  `currentAll()` 的判据是 `allModels === undefined || fullModels === undefined || stale`，
  而**干净机器上没有磁盘缓存**（`readCache()` 返回 `{}`）⇒ 前两项恒为真，每次调用都新起
  一条 `refreshInBackground()`。而 magpie 宿主 `providers()` 是
  `Promise.all([...auths()].map(row))` —— 29 家**并行**各调一次 `provider.models()`，
  `config` 钩子另外 29 次串行。次生故障：① `container._absorbModels()` 的
  `modelMeta.clear()` 与 `refreshFullCatalog()` 的 `set()` 并发互清 ⇒ 能力声明（上下文
  窗口 / 图片 / 推理档位）随机丢；② 上千次 `rpc('model.list')` 打满容器；③ 58 次**同步**
  写盘；④ 20 秒超时到点，magpie 拿到的是空列表 —— 而**没有任何错误**。
  用户看到的就是「新装的插件第一次打开 magpie，模型列表是空的」。
  修法：加 `refreshing` 标记，一次只跑一条链，`finally` 里清空（用 `finally` 而不是
  `then` —— 失败也要能重试，否则一次网络抖动就把刷新永久卡死）。`tests/` 里
  `refreshInBackground|currentAll` 此前**零命中**。

- `fix(plugin)`: **oauth 型 `authorize()` 的目录拉取没套超时，Key 型套了**。
  `liveAll` / `refreshFullCatalog` 内部走 `container.rpc()`，那条路径**不会自己超时**
  （`route.fetch(req)` 没有 AbortSignal）。Key 型的 `addAccount` 分支早就为此套了
  `withDeadline` 并写了注释「实测上游挂住时 authorize() 能一直不返回（60 秒没回）」，
  oauth 这条**没修** —— 同样的两条调用、同样的风险，行为却不一致，上游挂住时「Sign in」
  按钮永远转圈。现在两条一起套 `START_TIMEOUT_MS`；目录拉不到不影响签入本身
  （凭据已经在池里），超时只记一行日志、按「没有目录」继续。

- `fix(plugin)`: **`usage()` / `checkin()` 的 RPC 无超时，也不吃宿主的 `signal`**。
  宿主 `usageOf(provider, account, signal)` 把 `{ signal }` 作为**第三参数**传给
  `a.usage(getAuth, info, { signal })`，而插件只声明了一个形参 —— signal 直接丢掉，
  `container.rpc()` 又不吃它。于是上游一挂住：用量卡永远转圈、promise 永远不 settle
  （泄漏）、`balanceCache` 也永远不写。表现是「点开账号卡片，余额那一行一直是空的」。
  现在两条都接住 `{ signal }`（入口先看一眼，已取消就不发请求），并套
  `USAGE_TIMEOUT_MS = 20_000`（`credits.balances` 要为**每个账号**发一次上游请求，
  比单次 `login.poll` 慢一档）。

- `fix(plugin)`: **`toMagpieCheckin()` 的 `failed` 分支透传空串**。`message ?? (…)` 在
  `message === ''`（上游偶尔回空串，不是 `undefined`）时求值就是 `''` ⇒ 落盘
  `{outcome:'failed', message:''}`，用户看到一张**空白**的失败卡，连「为什么失败」都没有。
  改成 `String(message ?? '').trim() || …`：空串 / 纯空白都算「没说到」，
  退回 `kind` 或兜底文案。

- `fix(plugin)`: **`windows[].display` 没走 `fmtNum`，且注释对宿主的描述是错的**。
  注释写「magpie 对 `windows[].display` 会自己按数字格式化」，但核过宿主 `_mp_host.js`：
  `display: text(w?.display)` 与 `balance: text(u.balance)` 走的是**同一条** `text()`，
  都不格式化。同一条 officeace 数据会显示成 `balance:"10000 积分"` +
  `display:"4584.442685714286 / 10000 积分"` —— 一个整齐、一个满屏小数。现在两处都收敛。

- `fix(plugin)`: **`usage()` 的 catch 路径缺 `plan`**。同文件其它 4 条 `usage` 返回路径
  都带 `plan`，宿主 `plan: text(u.plan)` 缺失即空串 ⇒ 一张**没有标题**的错误卡 ——
  而它恰好是用户最可能看到的那条（网络故障）。

- `fix(console)`: **`loadAccounts()` 失败时不清空旧卡片 ⇒ 跨 provider 误删账号（不可逆）**。
  `setProvider()` 是**同步**改 `#accProvider` 的，`loadAccounts()` 是异步的 —— 两者一旦
  在失败路径上分叉，页面就进入「标题是 B、卡片是 A」的混合态。而 `onAccAction()` 取的是
  `$('#accProvider').value`（B）、`btn.dataset.id` 却是 A 家的 accountId ⇒ 点「删除」会
  真的删掉 **A 家**的账号，并连带 `credentials.unset`（**没有 undo**）。
  触发条件只是「任何一次 `account.list` 失败」（本地服务重启 / 端口漂移到 18501+ /
  上游超时），而 `rpc()` 是裸 fetch、没有 `AbortSignal` / 超时，失败窗口**不是毫秒级而是
  无限长**。修法：`loadAccounts()` 开头发请求**之前**先清场（`ACC` / `BAL` 清空 +
  渲染空态），失败时把空态文案换成「读取失败：…」（两种情况都渲染成空列表，但含义
  完全相反 —— 一个是真的没号，一个是没读到，文案不能混）。
  顺带修 `account.update` 的 `a?.enabled === false`：`ACC.find()` 返回 `undefined` 时
  求值是 `false` = **停用**，方向正好反 —— 卡片不在列表里时点一下反而把活号停掉。
  现在找不到就抛错让用户重试。

- `fix(console)`: **`loadStrictOrder()` 的 `catch` 分支缺 provider 守卫**。
  切到 buddy 发请求 → 切到 zcode（zcode 的 `getEnabled` 成功、开关打开且可交互）→
  buddy 的请求超时失败 —— 没有守卫时，buddy 的失败回包会无条件把
  `checked=false; disabled=true` 写到**当前**的 `#accStrict` 上，用户看到「zcode 的严格
  手动顺序被关掉了」。成功路径早就有这道守卫（`if ($('#accProvider').value !== provider) return`），
  失败路径漏了。`tests/t-console-strict-order.mjs` 的 3.3 / 3.4 只覆盖了成功路径的守卫与
  「本来就没切走」的失败，这条竞态是测试盲区。

- `fix(console)`: **`saveSetting()` 失败后不把控件拨回 ⇒ 四个设置项停在假保存状态**。
  `#setSearch` / `#setSession` 是 checkbox、`#setPanel` 是 select、`#setXff` 是 input，
  全由 `change` 事件触发 —— 落盘失败时浏览器已经把控件改掉了，`catch` 只写一条红字，
  控件**保持在用户刚改出来的位置**。下次进设置页之前，「渠道原生搜索 = 开」都是假的。
  同文件的 `saveStrictOrder()` 做对了（「落盘失败就把开关拨回去，别让界面停在假状态」），
  而且 `t-console-strict-order.mjs` 的 3.7 已经把「失败后回读」锁定成契约。
  现在 `saveSetting()` 也回读（先 `loadSettings()` 再覆盖错误消息 —— 错误比「读取中」重要）。

- `fix(console)`: **`loadSettings()` 用 `.catch(() => ({}))` 吞掉四个 RPC 失败 ⇒ 假状态 +
  死代码**。四个 `.catch` 把失败压成空对象，于是「读不到」被渲染成「确认是关的」：
  用户在设置页看到「渠道原生搜索：关」，实际可能是开的，他会去点一下「开」，
  反而把本来开着的**关掉**。同时外层 `catch` 是**死代码**（`Promise.all` 的四个 promise
  都被兜住，永远不 reject），出问题时页面完全静默。现在把每一项包成
  `{ ok, value, error }`：能读到的照常渲染，读不到的明确说「有几项没读出来」，
  并提示「显示的可能不是真实状态」。

- `fix(console)`: **`startLogin()` 的旧轮询迟到回包会停掉新登录的轮询**。
  `setInterval` 的回调是 async，`clearInterval` 只能取消**未来**的 tick，取消不了已经
  `await` 在飞的那一次。旧登录的 `login.poll` 若在新 `startLogin()` 之后才返回
  `done:true`，就会：① 停掉**新**登录的轮询（新弹窗永远「等待中…」）；
  ② 抹掉新登录的占位账号 id（之后 `closeLogin()` 不再 `reclaimPlaceholder` 它，
  池里留一条**幽灵账号**）；③ `#lmState` 被写成「✓ 登录成功」而明明还在授权中。
  900ms 那套 `settledId` 守卫只防住了 `setTimeout`，没防住 `await`。
  现在每个 tick 记下自己的句柄，`await` 之后校验 `loginTimer !== myTimer` 就作废。

- `fix(console)`: **`rotateFingerprint()` 的结果文案被自己的重读覆盖，且双倍 RPC**。
  它内部 `say('#accMsg', '指纹代次 → N')` 之后立刻 `await loadAccounts()`，而
  `loadAccounts()` 开头就是 `say('#accMsg', '读取中…')` —— 用户**永远看不到**那条结果
  （卡片上「指纹代次」那行只是数字悄悄变了，不会注意到）。而且外层 `onAccAction()`
  还会再 `loadAccounts()` 一遍 ⇒ 双倍 `account.list` + `credits.balances`（后者要为每个
  账号发一次上游请求）。改成 `flash` 模式（`test` / `retest` / `comp` 都是这个模式），
  重读交给外层。

- `fix(console)`: **可访问性两处**。① `#accStrict` 的文字标签在 `<label>` **外面**，
  点「严格手动顺序」四个字（用户最自然的点击目标）不会切换开关，只有点那个 34×20px 的
  小滑块才会；现在文字也是 `<label for="accStrict">`（配 `.swText { cursor: pointer }`）。
  ② `#nav` 的三个按钮只有 `class="on"` 表示选中，**没有** `role="tab"` / `aria-selected`，
  `<nav>` 也没有 `role="tablist"` —— 屏幕阅读器完全感知不到「当前在哪一页」。
  对照 `page/index.html` 的 `#tabs` 是**有**这套语义的，两个页面同一语义不该两种实现；
  `console.js` 的 `wireTabs()` 同步维护 `aria-selected`。

- `fix(page)`: **`flash()` 的失败路径不清除 `data-done` ⇒ 「复制失败」继承上一次成功的
  绿色**。`page.css` 有 `button.mini[data-done] { color: var(--jh-ok); … }`，而
  `flash()` 只在成功时设 `data-done`、失败时**不清**。1.6 秒窗口内第一次点成功、
  第二次点失败，按钮就会「绿色 + 复制失败」—— 正是注释里声称要避免的「失败看起来像成功」。
  这是个「状态机少了一条边」，补上 `else delete btn.dataset.done`。

- `test(console)`: **上面三条前端静默缺陷各补一格断言**（原来都是测试盲区）：
  `t-console-strict-order.mjs` 新增 **3.4b** —— 失败路径的竞态（切到 buddy 发请求 →
  切到 zcode → buddy 超时失败，不许把 zcode 的开关拨回 false 并置灰）。原有用例
  3.3 只测了**成功**路径的守卫、3.4 只测了「本来就没切走」的失败。
  `t-page-contract.mjs` 新增 **第 7 节** —— `flash()` 的两条边（成功变绿 / 紧接着失败
  必须清绿），用假定时器把真函数抽出来求值。
  `t-account-cache.mjs` 新增 **C-9a/b/c** —— 后台刷新 `refreshInBackground` 的
  in-flight 去重（并发 10 次只启动 1 条链 / 链跑完标记复位 / 串行两次跑两条 ——
  去重只挡并发、不挡重试）。**四条变异实测都变红**：删 catch 守卫 / 删 `else` 分支 /
  删 `if (refreshing) return`。

- `fix(test)`: **两条用例在受限沙箱下静默失败，而失败信息是一片空白**。
  `tests/t-seed-auth.mjs` 与 `tests/t-import-backup.mjs` 都用
  `spawnSync(process.execPath, [script, …], { encoding: 'utf8' })` —— `encoding` 是
  **管道模式**的选项，等价于 `stdio: 'pipe'`。受限环境（Windows AppLocker / 容器 /
  企业策略 / DSH 沙箱）**禁止创建管道**，`spawnSync` 直接给出
  `error.code === 'EPERM'`、`status === null`，`stdout` 与 `stderr` 全空。
  于是 `scripts/test-all.mjs` 打印的失败尾部是「`✗ --dry-run 失败:`」后面
  **什么都没有**（`t-import-backup` 是 12 行「实际退出码 null：」），重试仍失败、
  却给不出任何线索 —— 看起来像被测脚本坏了，实际是被测环境不给跑。
  **为什么这条特别难查**：本机与 CI 都不限制管道，两边全绿，只有换环境才暴露。
    不是「某台机器的特例」—— 任何把 DSH 跑在受限沙箱里的人都撞得上。
  `scripts/test-all.mjs` 早就踩过同一个坑并改用 fd 重定向（见那里的注释），
  这两个测试没跟上。现在把这件事收进 `tests/_iso.mjs`：
  - 新增 `runNode(args, opts)` —— fd 重定向抓合并输出，退出码语义不变、两条流都拿得到、
    受限环境里也能跑，并**回传 `error`**；
  - 新增 `describeFailure(r)` —— 把「子进程压根没启动（EPERM / ENOENT）」与
    「跑完了但退出码非 0」**分开说**，两者的处置完全不同（前者去查沙箱，后者去查实现）；
  - 两个测试改用它，39 处断言消息一处没动（`run()` 在 `out` 为空时兜底补原因）。

- `test(spawn)`: **新增 `tests/t-spawn-stdio.mjs`（3 条判据），把上面那条缺陷钉死**。
  这是「只有换环境才暴露」的静默故障，必须用机器守：① 每个
  `spawnSync(` / `execFileSync(` / `execSync(` 调用**必须**显式传 `stdio`（不传就是默认管道）；
  ② `stdio` 不许是 `'pipe'`，也不许是含 `'pipe'` 的数组；③ 不许写 `encoding` ——
  那个选项只对管道模式有意义，出现就说明有人把 fd 重定向改回了旧写法。扫 `tests/` +
  `scripts/` + `src/` 的全部调用点（`scripts/import-backup.mjs` 的 `stdio: 'inherit'`
  是合法写法，收敛后由本用例一并守住）。
  **三条变异实测都变红**：改回 `encoding: 'utf8'` / 显式写 `'pipe'` / 干脆删掉 `stdio`。
  ⚠ 第二条变异抓出一个真缺陷：初版只拿「涂空后的源码」判，而 `'pipe'` 的**内容**已被
  涂成空格 ⇒ 显式写管道**绿着通过**。现在括号配对用涂空副本、取实参回原始源码（两者等长）。

- `chore(pkg)`: **补上 `scripts` 标准入口**。原来 `package.json` 一个 `scripts` 都没有，
  `npm test` 直接报缺脚本 —— 而来这个仓库的人第一件事就是跑测试。现在转发到
  `scripts/` 里真正的那条：`test` / `test:all` / `verify:vendor` / `snapshot` / `console`。
  ⚠ `files` 白名单里没有 `scripts/` 与 `tests/`，所以这几个入口只对**从源码 clone**
  的目录有效（发布出去的插件包里不需要测试）；`docs/testing.md` 里一并写明了。

- `fix(test)`: **`isolate()` 建的沙箱目录永不回收**。`tests/_iso.mjs` 的 `isolate()`
  只 `mkdtemp` 不清理，每跑一次全量测试就在 `%TEMP%` 留 5 个 `jet-hub-test-*`
  （2026-11-11 实测：连跑三次留下 **15 个目录 / 0.52 MB**）。单次不大，但**永不回收**
  —— 开发机跑几个月就是几百个目录，而且里面是测试造出来的**真凭据假副本**
  （`access_token` / `refresh_token` 形状与真实一致）。现在在 `isolate()` 里挂
  `process.once('exit')` 同步 `rmSync` 掉。
  为什么用 `exit` 而不是 `afterEach`：这里没有测试框架，且要覆盖「用例里
  `process.exit(1)` 直接退」那条路（好几个用例就是这么写的）；`exit` 回调只能跑
  同步代码，`rmSync` 正好是同步的。实测：全量跑完残留数**不再增长**（15 → 15）。

- `chore(index)`: **`JetHubMarvisPlugin` 缺 JSDoc 注释**。`index.mjs` 里 29 个工厂
  都带一致的 `/** 本体 xxx（magpie id xxx）。 */`，只有 `1d12f80` 同步 Marvis 时
  漏了这一行 —— 后续维护者按模式扫过去会以为「这个是有意不同的」。补上。

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
