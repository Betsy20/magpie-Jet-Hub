# magpie-jet-hub

[![repo](https://img.shields.io/badge/github-Betsy20/magpie--Jet--Hub-blue)](https://github.com/Betsy20/magpie-Jet-Hub)

把 **deepseek-harness-codearts 插件本体**装进 magpie。

不是"重写一份 CodeArts 能力"（那样只搬一家），而是把本体「路由中枢」原样跑起来：
内嵌一个 cordis 容器加载 `deepseek-harness-codearts`（= `dsh-providers-hub`，24 个 provider），
让它自己开一个只监听回环的 OpenAI 兼容网关，magpie 侧只把请求转发进去。

```
magpie 网关 (3425)
  └─ provider `jet-hub`            ← 本插件
       └─ auth.loader().fetch       ← 只改这一层：剥 provider 前缀 + 转发
            └─ JetHubContainer（内嵌 cordis + 本体 lib/index.js）
                 └─ 本体自带网关 127.0.0.1:<动态端口>
                      └─ 24 家 provider 的真实上游
```

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

## 19 个供应商，不是一个

本体里有 19 个 provider。本插件把它们**各注册成 magpie 的一个供应商**，
而不是塞进一个 `jet-hub` 里：

| magpie provider id | 显示名 | 本体 provider |
|---|---|---|
| `jet-hub` | Jet Hub · 自动选号 | `jet-hub-auto` |
| `jet-hub-codearts` | Jet Hub · CodeArts（华为云） | `codearts` |
| `jet-hub-workbuddy` | Jet Hub · WorkBuddy | `workbuddy` |
| …（共 19 个） | | |

模型 id 就是 `<provider>/<model>`，例如：

```
jet-hub-codearts/deepseek-v4.1-flash
jet-hub-workbuddy/deepseek-v4.1-flash
jet-hub-qoder/qfmodel
```

> **为什么能这么做**：magpie 宿主 `servers(mod)` 取模块导出的**每一个函数**，
> `auths()` 再按 `hooks.auth.provider` 建映射 —— 所以一个插件包导出 19 个
> 插件工厂，就能注册 19 个 provider id。`index.mjs` 正好导出 19 个
> `JetHub*Plugin`。
>
> ⚠️ 容器是**模块级单例**：19 个工厂共用一个 cordis 容器与一个内部网关。
> 各起一个的话会拉 19 个网关端口，冷启动直接炸。

### 账号也按 provider 分开

`plugin-auth.json` 里的键决定 magpie 显示哪些账号：

```
jet-hub-workbuddy            → betsy024
jet-hub-workbuddy#a1b2c3     → betsy54
jet-hub-codearts             → codearts-8e65da6c
jet-hub-codearts#d4e5f6      → codearts-a40ab885
```

`node scripts/seed-auth.mjs` 把本体账号池（`~/.dsh/jet-hub/state.json`，实测
56 个账号 / 19 个 provider）按 provider 摊平写进 magpie，写入前自动备份，
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

![控制台](docs/screenshot-console.png)

控制台背后的 RPC 端点（`POST /api/jet-hub`，`{type:"client-request",method:"jet-hub",payload:{method,payload}}`，
响应 `{result:{ok:true,value}}` / `{result:{ok:false,error}}`）实测可用的方法：

| 方法 | 作用 |
|---|---|
| `account.list` / `account.create` / `account.update` / `account.delete` | 账号池增删改查（`account.update` 的 `patch` 只认 `nickname/enabled/expiresAt/refreshable`） |
| `account.refresh` / `account.test` / `account.reset` / `account.reorder` | 强制续期、真发一次请求验证、重置、排序 |
| `login.poll` | 轮询登录流程状态（`account.create` 起流程） |
| `credits.status` / `credits.balances` / `credits.claimAll` | 积分状态、余额、一键领取 |
| `model.list` / `model.setDisabled` | 模型列表（带 disabled/dead 标记）、开关 |
| `backup.status` / `backup.export` / `backup.import` | 账号池备份与迁移 |
| `gateway.getEnabled` / `gateway.setEnabled` | 内嵌网关开关与状态（含 apiKey） |

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

`index.mjs` 只导出 19 个 `JetHub*Plugin`，一个都不多。

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

# 界面自检（CDP 驱动 Edge → 点侧栏 → 连进页面 OOPIF → 五个标签逐个截图 + DOM 断言 + 收集 JS 报错）
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
- 本体的 Jet Hub **设置界面**（`lib/client/jet-hub.js`）是本插件搬不过来的部分 ——
  它是 DSH 前端 UI，magpie 里由本插件自己的侧栏页替代；账号登录/续期仍在 DSH 侧做。
- 侧栏「模型」页是**快照**，不随账号变化自动更新；页面里显示的也是快照时间。
- 页面能读的只有 `providers:list` 与 `usage:summary` 两项（magpie 的白名单），
  所以做不出「点一下就登录/换号」的按钮 —— 那需要写接口，magpie 没给。

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
console/               完整控制台界面（账号 / 登录 / 积分 / 模型 / 路由 / 备份）
scripts/seed-auth.mjs  把本体账号池按 provider 摊平写进 magpie 的签入记录
scripts/snapshot-models.mjs  重新生成 page/models.js
scripts/test-all.mjs   测试总入口
tests/                 验证脚本（t-plugin / t-models-nowait / t-dead-account / t-writerefs / t-seed-auth / t-console / t-gateway / ui-check）
docs/screenshot.png    侧栏页面实拍
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

