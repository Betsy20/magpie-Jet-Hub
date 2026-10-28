# magpie-jet-hub

[![repo](https://img.shields.io/badge/github-Betsy20/magpie--Jet--Hub-blue)](https://github.com/Betsy20/magpie-Jet-Hub)

把 **deepseek-harness-codearts 插件本体**装进 magpie。

不是"重写一份 CodeArts 能力"（那样只搬一家），而是把本体「路由中枢」原样跑起来：
内嵌一个 cordis 容器加载 `deepseek-harness-codearts`（= `dsh-providers-hub`，其中 24 个 provider），
让它自己开一个只监听回环的 OpenAI 兼容网关，magpie 侧只把请求转发进去。

```
magpie 网关 (3425)
  └─ provider `jet-hub-*` ×24      ← 本插件（每家一个供应商）
       └─ auth.loader().fetch       ← 只改这一层：剥 provider 前缀 + 转发
            └─ JetHubContainer（内嵌 cordis + 本体 lib/index.js）
                 └─ 本体自带网关 127.0.0.1:<动态端口>
                      └─ 24 家 provider 的真实上游
```

## 模型目录：上游全量，不是「当前可用」

这里有两套目录，**不要混用**（实测数据）：

| 来源 | 含义 | astudio | cline | workbuddy |
|---|---|---|---|---|
| 网关 `/v1/models` | 此刻**能用**的 | 1 | 1 | 2 |
| 本体 `model.list` RPC | 上游**全量** | 9 | 540 | 32 |

magpie 里 `jet-hub-*` 每个 provider 的模型列表用的是**后者**（全量 893 个 / 24 家），
因为用户要的是「供应商上游全部模型」。全量里已在 Jet Hub 关闭的模型照样列出，
名字后缀 `· 已在 Jet Hub 关闭`、页面里显示为灰，提示你先去控制台打开。

取数链路：

```
插件进程（bun）  容器启动 → 网关 /v1/models（可用）+ model.list RPC（全量）
                 ↓ 落盘 ~/.config/magpie/jet-hub-models.json  { at, models, full }
magpie 宿主      provider.models() / config().models 同步读盘 → 立刻返回，不阻塞
页面            node scripts/snapshot-models.mjs 读同一份盘 → page/models.js
```

为什么要落盘：magpie 给 `provider.models` 的超时是 20 秒，而本体冷启动 + 拉全量
要 20–40 秒；直接 await 必然超时，只能「先给上次的、后台再刷」。

⚠️ `writeCache` 只写**有值**的那一份。全量要 20+ 秒才到，若先到的实时目录把
`full: undefined` 写进去，会把上一次落盘的全量覆盖掉（踩过：缓存被写成只剩 35 条）。

⚠️ 进程内缓存有 **60 秒 TTL**（`src/plugin.mjs` 的 `CACHE_TTL_MS`）。插件进程是常驻的，
若 `allModels` / `fullModels` 一旦有值就永不重读，你在别的进程刷新了盘上缓存，
常驻宿主仍报旧数字，直到 magpie 重启（踩过：`plugin list` 显示 cline 540，界面里仍是 1）。

刷新：`node scripts/snapshot-models.mjs`；上游上新模型后跑一次即可（页面与
`provider.models()` 会在 60 秒内跟上）。

## 为什么这么做

| 做法 | 结果 |
|---|---|
| 重写一份 CodeArts | 只能覆盖一家；本体的账号池、续期、选号、目录全丢 |
| 桥接 DSH 网关 8326 | 要先起 DSH 进程；本插件不依赖 DSH |
| **本插件：装本体** | 本体 24 家全在，升级跟着走，**不依赖 DSH 进程** |

代价：本体以 npm 包形式随 `vendor/` 分发（17 MB）。

## 安装

```bash
# 1) 先装运行时依赖（vendor/ 里的本体靠根 node_modules 解析 @deepseek-ai/*）
npm install          # 或 bun install

# 2) 装进 magpie 并登录
magpie plugin add D:/dsh-build/magpie-Jet-Hub
magpie plugin login jet-hub
```

> ⚠️ **必须用目录路径**，不要写包名。npm 上同名包可能是别人的 cordis 插件，
> 装上会报 `TypeError: undefined is not an object (evaluating 'self.ctx.reflect.provide')`。
>
> 换机器时把 `magpie-Jet-Hub` 换成自己的绝对路径即可。目录式安装是**直接引用**
> （不复制、不建软链），所以改完代码 `magpie plugin list` 重载即生效。

## 24 个供应商，不是一个

本体里有 24 个 provider。本插件把它们**各注册成 magpie 的一个供应商**，
而不是塞进一个 `jet-hub` 里：

| magpie provider id | 显示名 | 本体 provider |
|---|---|---|
| `jet-hub` | Jet Hub · 自动选号 | `jet-hub-auto` |
| `jet-hub-codearts` | Jet Hub · CodeArts（华为云） | `codearts` |
| `jet-hub-workbuddy` | Jet Hub · WorkBuddy | `workbuddy` |
| `jet-hub-minimax` | Jet Hub · MiniMax | `minimax` |
| `jet-hub-accio` | Jet Hub · Accio（阿里） | `accio` |
| `jet-hub-gemini` | Jet Hub · Gemini | `gemini` |
| `jet-hub-codely` | Jet Hub · Codely | `codely` |
| `jet-hub-autoclawintl` | Jet Hub · AutoClaw 国际 | `autoclawintl` |
| …（共 24 个） | | |

> 名单来自本体 `provider.getOrder`（**22 家真渠道 + 2 个路由组**：`aggregate` 与
> `jet-hub-auto`，合计 24）。路由组的判据在本体侧是它们没有自己的账号池
> （`scripts/seed-auth.mjs` 的 `ROUTE_GROUPS` 就按这两家判）。
> 早期版本只接了 19 家，漏掉 `minimax` / `accio` / `gemini` / `codely` /
> `autoclawintl` —— 这 5 家在 `provider.status` 里查不出来（传空数组返回
> `statuses: {}`），必须用 `provider.getOrder` 才看得全。

模型 id 就是 `<provider>/<model>`，例如：

```
jet-hub-codearts/deepseek-v4.1-flash
jet-hub-workbuddy/deepseek-v4.1-flash
jet-hub-qoder/qfmodel
```

> **为什么能这么做**：magpie 宿主 `servers(mod)` 取模块导出的**每一个函数**，
> `auths()` 再按 `hooks.auth.provider` 建映射 —— 所以一个插件包导出 24 个
> 插件工厂，就能注册 24 个 provider id。`index.mjs` 正好导出 24 个
> `JetHub*Plugin`。
>
> ⚠️ 容器是**模块级单例**：24 个工厂共用一个 cordis 容器与一个内部网关。
> 各起一个的话会拉 24 个网关端口，冷启动直接炸。

### 账号也按 provider 分开

`plugin-auth.json` 里的键决定 magpie 显示哪些账号：

```
jet-hub-workbuddy            → betsy024
jet-hub-workbuddy#a1b2c3     → betsy54
jet-hub-codearts             → codearts-8e65da6c
jet-hub-codearts#d4e5f6      → codearts-a40ab885
```

`node scripts/seed-auth.mjs` 把本体账号池（`~/.dsh/jet-hub/state.json`，实测
56 个账号 / 24 个 provider）按 provider 摊平写进 magpie，写入前自动备份，
只动本插件自己的键。

> ⚠️ **一句实话**：本体自己的 HTTP 网关没有「按请求指定账号」的入口 ——
> 账号是适配器内部用 `getAvailableAccount(provider, model)` 按启用状态与限流
> 现选的。所以这些行在 magpie 里是**看得见**（与 DSH / 控制台里的账号池一致、
> 能看停用状态），但挑某一行**不会**改变本体实际用哪个账号。

路由组（`jet-hub` 自动选号、`jet-hub-aggregate` 聚合）本体里没有自己的账号，
请求由池里其它渠道承接，所以它们那行写的是「路由组 · 请求由池内其它渠道承接」。

## 凭据：不需要再登一次

本插件**不向用户要任何凭据**。DSH 已经把账号写在
`~/.dsh/.credentials.yaml` 的 `refs:` 段里，`src/credentials.mjs` 用一个
`FileCredentialProvider` 把它桥成容器的 `credentials` 服务 —— 本体读到的
就是它平时读的那份。

⇒ 在 DSH 里登录过的账号，在 magpie 里立刻可用；反之，本体刷新出的新 token
也会写回同一个文件（`src/credentials.mjs` 的 `set()` 走原子替换 + `.bak`）。

三个踩过的坑（都在 `src/credentials.mjs` 头部注释里）：

1. `resolve()` 必须返回 `{ value }` 包装对象 —— 返回裸字符串会让所有账号被判"未配置"，chat 全 502
2. `.credentials.yaml` 的值可能是跨多行的单引号标量，必须做 YAML 折行折叠
3. 写入必须落回 `.credentials.yaml`，否则 refresh 出的新 token 只活在内存里

## 模型名

magpie 侧看到的 id 是 `<magpie provider>/<model>`，一层前缀：

```
jet-hub-workbuddy/deepseek-v4.1-flash
jet-hub-zcode/GLM-5.3
jet-hub/auto                     ← 本体的自动选号路由组
```

`auth.loader().fetch` 把 magpie 的 provider 前缀换成本体要的
`<dsh provider>/<model>` 再交给本体 —— 本体按这个前缀分派到对应上游。
已知前缀按长度降序匹配，避免 `jet-hub/` 抢掉 `jet-hub-auto/`。

## 冷启动与目录

本体冷启动要建容器、拉账号凭据链、预热目录，实测 **3–30 秒**。
而 magpie 给 `provider.models` 的超时只有 **20 秒** —— 在 `models()` 里
`await` 必然超时（日志刷 `the plugin's model list didn't finish in 20s`）。

故 `models()` 分三档（`src/plugin.mjs` 的 `currentModels()`）：

1. 内存缓存命中 → 立刻返回，后台刷新
2. 磁盘缓存（`~/.config/magpie/jet-hub-models.json`）→ 立刻返回真实目录
3. 都没有 → 返回静态表（16 条），启动甩到后台

`authorize()` 与 `usage()` 由用户点击/后台触发，允许长时间，走 `liveModels()` 真等。

## 侧栏页面

`package.json` 的 `magpie.page` 声明页面，`magpie.permissions` 声明只读数据：

```json
"permissions": ["providers:list", "usage:summary"]
```

> ⚠️ **必须是字符串数组**。写成对象（`{reads:[...]}`）会让页面注册静默失败，
> 侧栏根本不出现 —— 这个坑实际卡过两轮。

页面在沙箱 iframe 里跑，只能通过 `_magpie/bridge.js` 拿声明过的数据，不联网、
不碰 magpie 的 `/api`。

### 六个标签

| 标签 | 内容 | 数据来源 |
|---|---|---|
| 接入 | 网关地址、模型前缀、curl/Python/Node/DSH 四种客户端片段（可复制） | 快照 + 本地常量 |
| 模型 | 按 provider 分组的全部模型 ID，可搜索 / 全部展开 / 复制全部 | `page/models.js` 快照 |
| 用量 | 今天 / 近 7 天 / 近 30 天的请求、失败、输入输出 token、缓存命中、费用，及前 20 个模型明细 | `magpie.read('usage:summary')` 实时 |
| 供应商 | 本体带来的全部 provider，标出哪些有模型、各几个 | 快照 + `providers:list` 实时 |
| 设置 | 默认模型、用量默认周期、复制是否带前缀（存 `plugins.json`，只属本插件） | `magpie.options` |
| 控制台 | 本地控制台地址（一键复制）+ 能在里面做什么的清单 | 本地常量 |

（侧栏页这六个标签是**只读**的概览；所有写操作在下面说的本地控制台里。）

### 控制台：完整功能走本地服务

页面只能**只读**（`providers:list` + `usage:summary`），这是 magpie 写死的：
受管页面的 CSP 是 `sandbox allow-scripts` + `connect-src 'none'` + `frame-src 'none'`
（见官方 `docs/subsystems/plugin-runtime.md`），页面既发不出请求，也嵌不进 iframe，
更没有调用插件的写入口（`magpie.actions` 只是往页面里 `postMessage` 菜单事件）。

所以**登录 / 换号 / 续期 / 积分领取 / 模型开关 / 账号池 / 备份导入导出**都在插件自己的
本地控制台里做 —— 那是一个真 HTTP 服务，浏览器打开即可：

```
http://127.0.0.1:18500/          # 默认端口，被占用自动 +1
```

准确地址写在 `~/.config/magpie/jet-hub-console.json` 的 `url` 字段（每次宿主启动时更新）。
侧栏页面的「控制台」标签就是把这个地址摆出来，附一键复制。

⚠️ 侧栏页 CSP 是 `connect-src 'none'`，**它自己问不到端口**，所以地址是
`scripts/snapshot-models.mjs` 一起写进 `page/models.js` 的 `console` 字段 ——
端口变了要重跑一次快照，否则页面还显示旧端口（会连到别的实例上）。

![控制台](docs/screenshot-console.png)

控制台背后的 RPC 端点（`POST /api/jet-hub`，`{type:"client-request",method:"jet-hub",payload:{method,payload}}`，
响应 `{result:{ok:true,value}}` / `{result:{ok:false,error}}`）。

控制台是八个标签的管理界面，覆盖本体可调度 RPC 的**大部分**（不是全部，覆盖率与
方法总数由 `tests/t-rpc-cover.mjs` 从源码解析后自动统计，本文不硬编码这两个数）：

| 标签 | 能做什么 |
|---|---|
| 概览 | 本体/网关/模型/账号统计，网关六项状态，自动签到今日情况，provider 清单，接入代码 |
| 账号 | 每个 provider 的账号池：登录、续期、测试、复测、重置、新人奖励、补偿、上下移、删除、批量复测/重置 |
| 积分 | 状态 / 余额 / 徽章 / 全部领取；每日签到（含 24 个渠道的今日结果）；Cline 额度与请求流水；OfficeAce 状态；**永久积分锁定** |
| 模型 | 模型开关（单条 / 勾选批量 / 全开全关 / 清理失效）；聚合路由的候选目录、排序模式、到期排序、当前渠道、拒绝表，以及**候选级逐个打开/拒绝/调序** |
| 供应商 | 全部 provider 的模型数/账号数/启用状态、逐个停用启用、顺序保存 |
| 用量 | token 账本（6 项汇总 + 明细）、历史、删除某天、徽章偏好 |
| 设置 | 网关启用、局域网、渠道原生搜索、面板入口、MiniMax XFF、验证码三件套 |
| 备份 | 账号总数/缺有效期统计、导出下载、merge/replace 导入 |

![控制台 · 模型](docs/console-models.png)
![控制台 · 积分](docs/console-credits.png)
![控制台 · 供应商](docs/console-providers.png)

三个**格式陷阱**（都实测踩过，本体不会报错，只会静默做错事）：

1. `aggregate.setOrder` 的条目是 `provider\u0000realId`（**NUL 分隔**），不是 `provider/realId`。
   传斜杠会被 `setAggregateOrder` 全部丢弃 → 返回空数组 → 顺手删键（等于清空手工顺序）。
2. `usage.autoCheckin` 的 `channels` 形状是 `{provider, text}`（`text` 是「1 个 +100积分，1 个失败」这类
   一句话），不是 `{enabled, lastDate, lastResult}`。按后者读会渲染出一整列空。
3. `account.resetAll` / `account.retestAll` / `buddy.compensationStatus` / `buddy.claimCompensation` /
   `cline.requestLog` / `onboarding.*` 都**必须**带 `accountId`（本体在守卫之后才解析凭据）。

改完控制台后跑一次 `node scripts/shot-console.cjs`：它用 Edge headless + CDP 逐个点开八个标签、
断言表格行数/卡片数/按钮数/错误消息，并把每页截到 `docs/console-<tab>.png`。
`node scripts/run-console.mjs` 则单独起一个容器 + 控制台（不重启 magpie），打印 `CONSOLE_URL`。

### 两个必须记住的渲染事实

1. **模型目录拿不到实时值**。页面 `connect-src 'none'`，`providers:list` 只给
   `{id, name}` 不给模型。所以模型清单是**快照**：`scripts/snapshot-models.mjs`
   读一次内嵌网关的 `/v1/models` 写成 `page/models.js`。换账号/加模型后重跑一次
   即可（页面上会显示快照时间，不假装实时）。
2. **页面是 OOPIF，主文档读不到它的 DOM**。`sandbox="allow-scripts"`（没有
   `allow-same-origin`）⇒ opaque origin ⇒ 独立进程。所以 `ui-check.cjs`
   不能从主窗口 `contentWindow` 进去，而是从 `/json/list` 里找 `type=iframe`
   那个目标、直连它自己的 `webSocketDebuggerUrl`。这一点踩过：在主 target 的
   `Runtime.executionContextCreated` 里永远只看得到 2 个上下文，抓不到页面。

## 入口只导出插件工厂

`index.mjs` 只导出 24 个 `JetHub*Plugin`，一个都不多。

> ⚠️ **绝不能多导出常量/工具函数**。magpie 宿主加载插件时遍历**全部导出**并
> 探测性调用，任何一个非插件工厂的导出都会让它抛错、整个插件加载失败
> （`plugin list` 报 failed）—— 实测过一次：多导出 `DISPLAY_NAME` /
> `PROVIDER_IDS` 之类的常量对象就会炸。所以常量表都留在 `src/plugin.mjs`，
> 需要单测内部函数请直接 import 那里。

## 测试

```bash
# 一把梭：跑全部不需要环境的单测（退出码即结论）
node scripts/test-all.mjs

# 连环境的一起跑（要 magpie 3425 与 web 3456 都在）
node scripts/test-all.mjs --all
```

逐项：

```bash
# 插件契约全链路（模拟宿主探测 → config → authorize → models → 真转发）
"C:/Users/Betsy/.cache/magpie/bun/1.4.4/magpie-bun.exe" tests/t-plugin.mjs

# models() 不阻塞（必须 < 2s，否则会被 magpie 的 20s 超时打断）
"C:/Users/Betsy/.cache/magpie/bun/1.4.4/magpie-bun.exe" tests/t-models-nowait.mjs

# 死号过滤判据（13 条断言，不联网）
"C:/Users/Betsy/.cache/magpie/bun/1.4.4/magpie-bun.exe" tests/t-dead-account.mjs

# .credentials.yaml 写回不吞行（14 条断言，不联网）
"C:/Users/Betsy/.cache/magpie/bun/1.4.4/magpie-bun.exe" tests/t-writerefs.mjs

# 经 magpie 网关 3425 真转发（非流式 / 流式 / 工具调用 / 路由组）
python tests/t-gateway.py

# 界面自检（CDP 驱动 Edge → 点侧栏 → 连进页面 OOPIF → 六个标签逐个截图 + DOM 断言 + 收集 JS 报错）
node tests/ui-check.cjs
# 截图落在 %TEMP%/jethub-ui/tab-*.png；有 JS 报错或标签没渲染就退出码非 0
```

测试用 magpie 自带的 bun（`~/.cache/magpie/bun/*/magpie-bun.exe`），因为宿主就是 bun。

## 已知限制

- 账号自身的额度/refresh token 过期与本插件无关：`officeace` 等会报
  `STS5.1806 invalid refresh token: 'the refresh token has been used'`，
  需要在 DSH 里重新登录（refresh token 是一次性的，这是上游设计）。
- **死号会拖垮整个渠道**：本体的选号只看 `enabled` 与限流，不看 `expiresAt` /
  `refreshable`，所以「已过期且不可续期」的账号一旦排在手动顺序前面，每次请求
  都会撞 502，而健康账号其实可用。本插件在容器层过滤掉这类死号
  （`src/container.mjs` 的 `_filterDeadAccounts`，详见 `VERIFICATION.md` 第七点五节）。
  注意：过滤只让死号不参与选号，**不会删除**它 —— 彻底清掉请去 DSH 的 Jet Hub 删账号。
- `zcode` 可能报"上游并发限流"：本体自带退避，属上游限流，非插件缺陷。
- 本体的 Jet Hub **设置界面**（`lib/client/jet-hub.js`）是 DSH 的前端 UI，搬不过来；
  magpie 里由本插件自己的侧栏页 + 本地控制台替代 —— 登录、换号、续期、积分、签到、
  模型开关、聚合路由、备份迁移都在控制台里做，功能上不再需要回 DSH。
- 侧栏「模型」页是**快照**，不随账号变化自动更新；页面里显示的也是快照时间。
  真正的实时模型清单与控制台在本地 HTTP 服务里（`console/`）。
- 侧栏页能读的只有 `providers:list` 与 `usage:summary` 两项（magpie 的白名单，
  `connect-src 'none'` 写死），所以侧栏里做不出「点一下就登录/换号」的按钮；
  这类写操作全部在本地控制台（`http://127.0.0.1:18500/`）里。
- 控制台覆盖本体可调度方法的大部分，未接清单以 `tests/t-rpc-cover.mjs` 的输出为准。
  数这个数有几个坑，都踩过：只数小写首段会漏掉 `nativeSearch.*` / `panelEntry.*`
  这类驼峰首段；直接 grep 关键字面量会把 `claimed` / `inactive` / `failed` /
  `already-claimed` 这四条非 RPC 的枚举 case 算进去；在控制台里
  `grep rpc('...')` 会漏掉**以字符串常量传入**的调用 —— `account.resetAll` /
  `account.retestAll` 就是这样接的（「全部重置」「全部复测」两个按钮把方法名当参数
  传给 `accBulk()`），它们是真接了的，别当成未接。
- 方法总数也不是主 `switch (method)` 的 case 标签数：另有一批方法**根本不走主
  switch**，在它之前先被 `handleMethod()` 按 `opencode.` / `gemini.` / `qoder.` /
  `minimaxintl.` / `modelscope.` 五个前缀改道接管。按 case 扫会整体漏掉这一批
  （这几家的账号级代理、匿名账号、指定 provider 加号等入口都在里面）。
- `loomy.permanentLock` 与 `credits.permanentLock` 是同一实现的**两个 label**，
  传 `provider:'loomy'` 走哪个名字都行（实测回包一致）。

## 供应商编辑器里的开关（`auth.options`）

magpie 的 auth 契约允许插件声明若干开关，用户在「供应商 → 高级」里拨，插件在
需要时现读（`input.magpie.option(provider, key)`，**不重启就生效**）。本插件声明两个：

| key | 默认 | 打开 | 关掉 |
|---|---|---|---|
| `prefer_full` | 开 | 模型列表用上游全量（含已关闭） | 只列网关此刻可用的模型 |
| `dead_account_skip` | 开 | 已过期且 `refreshable=false` 的账号不参与选号 | 死号也参与（会 502） |

两个开关都不是装饰：`prefer_full` 直接决定 `provider.models()` 走全量还是走实时
（实测 workbuddy 全量开 32 个、关掉 2 个）；`dead_account_skip` 直接决定容器层
`_filterDeadAccounts` 的取舍。`tests/t-options.mjs` 用两份不同的 `input.magpie`
各建一次插件实例来验证这一点，而不是只断言字段存在。

`auth.icon` 是内联 SVG 的 `data:image/svg+xml;base64,…`（不依赖外部图床），
magpie 落盘成 `file:<hash>.svg` 供 GUI 引用。

## 目录

```
index.mjs              入口，只导插件契约
src/plugin.mjs         插件工厂：config / auth / provider
src/container.mjs      内嵌 cordis 容器，加载本体并转发
src/credentials.mjs    把 .credentials.yaml 桥成 credentials 服务
src/connection.mjs     补 connection 服务，让本体的 jet-hub-rpc 端点注册起来
src/hub-server.mjs     本地控制台 HTTP 服务（静态页 + /__meta + /api/jet-hub）
vendor/                本体（deepseek-harness-codearts 2.7.261027 的 lib/）
page/                  侧栏页面（index.html / page.js / page.css / models.js 快照 / icon.svg）
console/               控制台界面（八个标签，RPC 覆盖率见 tests/t-rpc-cover.mjs）
scripts/seed-auth.mjs  把本体账号池按 provider 摊平写进 magpie 的签入记录
scripts/snapshot-models.mjs  重新生成 page/models.js
scripts/shot-console.cjs     控制台八标签实拍 + DOM 断言（Edge headless + CDP）
scripts/run-console.mjs      单独起容器 + 控制台，不重启 magpie
scripts/test-all.mjs   测试总入口
tests/                 验证脚本（t-plugin / t-models-nowait / t-dead-account / t-writerefs / t-usage / t-checkin / t-options / t-seed-auth / t-console / t-gateway / ui-check）
docs/screenshot.png    侧栏页面实拍
docs/console-*.png     控制台八个标签实拍
```

## 实现细节补充

- 内部网关端口**动态探测**（从 18390 起向上找一个空闲端口）—— magpie 会给每个
  插件开独立 bun 进程，固定端口会撞。
- 凭据桥是 **双向** 的：本体 refresh 出的新 token 会原子写回
  `~/.dsh/.credentials.yaml`（临时文件 + `rename` + `.bak`），所以在 magpie 里
  用过之后，DSH 侧也是最新的。
- 内部网关带随机 API key（`jethub-<24 hex>`），并只监听 `127.0.0.1`，
  不对外暴露。
- 控制台端口从 `18500` 起动态探测，实际 `url` 写入
  `~/.config/magpie/jet-hub-console.json`；控制台与内嵌网关都只监听回环地址。

