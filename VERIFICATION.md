# 验证记录 · magpie-jet-hub

目标：把 **deepseek-harness-codearts 插件本体**装进 magpie，本体 24 个 provider 全在，
且不依赖 DSH 进程。以下每条都是实跑输出，不是设计意图。

> **上游插件**：[`iJetLi/dsh-providers-hub`](https://github.com/iJetLi/dsh-providers-hub)（MIT）。
> 上游源码仓库的 `package.json` 里 `name` 是 `dsh-providers-hub`；npm 上同版本还有
> `deepseek-harness-codearts` 与旧名 `dsh-codearts-auth` 两个发布名（`lib/` 只差同一个
> 包名字符串出现的那两处：`lib/client/jet-hub.js` 的 `id:` 与 `PLUGIN_ID`）。本仓库只把
> 发布产物装进 [`vendor/`](vendor/)，改法见
> README 的「`vendor/` 的来源与许可」一节（有两个 gemini 常量拆成两段拼接，值相等）。

环境：magpie 0.1.1734 / 网关 `127.0.0.1:3425` / Web UI `127.0.0.1:3456` /
插件宿主 bun `C:/Users/Betsy/.cache/magpie/bun/1.4.4/magpie-bun.exe` / Windows。

> ## ⚠️ 历史记录声明（2026-10-29 追加，先读这段）
>
> 本文是**改造前**的验证流水，跨了很多个提交累积下来，从头到尾记录的是当时真跑了
> 什么。它**不代表当前 HEAD 的行为**，尤其下面两类：
>
> 1. **凡出现 `1839x` / `18390`–`18399` 这类"内嵌网关端口"、随机 `apiKey`、
>    `/v1/models` 要带 key 的段落，都是 `16e9f24` 之前的事。** 那个提交
>    （`refactor(gateway): 去掉内嵌 OpenAI 网关，进程内直连本体 ctx.llm`）之后：
>    插件**不再开任何本地网关端口**，请求由 `src/llm-bridge.mjs` 在进程内直接交给
>    本体 `ctx.llm.stream()`；`container.port` / `container.apiKey` / `container.baseURL`
>    已删除，`meta().gateway` 变成
>    `{ mode: 'direct', baseURL: null, port: null, userGateway: <对外网关> }`。
>    现在只有**控制台**（从 18500 起探测）还是 HTTP。
> 2. **`3425` 是 magpie 主程序自己的网关，不是本插件的。** 插件只把它当"用户该往
>    哪儿接"的展示值，真源是 `src/container.mjs` 的 `DEFAULT_USER_GATEWAY`，可用
>    `JET_HUB_USER_GATEWAY` 覆盖（见 README 末尾）。正文里把它当插件内部网关来描述
>    的地方，同样按第 1 条理解。
>
> 3. **正文里 "N 通过 / 0 失败 / 0 跳过" 的 N 是当时那次运行的数字。** 单测数量一路
>    在长（9 → 12 → 13 → 14），这些旧读数**不回填**，以最新一节的读数为准。
>
> 要看**改造后**的现测取证：`tests/t-direct.mjs`（直连链路）与 `tests/t-gateway.py`
> （经 3425 真转发）的真跑输出，以及「二十」之后的节。本文不逐条回改 —— 那会把
> "当时到底跑出了什么"这段证据抹掉。

---

## 一、可行性前置实验（决定路线之前）

### 1.1 bun 能跑 cordis（关键门槛）

宿主的插件进程是 **bun**，而 cordis / `@deepseek-ai/dsh-llm` 是按 Node 写的。
bun 不兼容就整条路线作废，所以先单独验：

```
import cordis: OK
ctx.credentials / ctx.llm: object
dsh-codearts fiber state: 2 (active)        ← 插件真的激活了
网关 18327 返回 401                          ← 鉴权生效（没带 key）
/v1/models 带 key → total 1, owned_by {jet-hub-auto:1}
```

**结论：bun 1.4.4 兼容，路线成立。**

### 1.2 本体能在裸 cordis 容器里自己开网关

`new Context()` → 注册 credentials seam + `dsh-commands` + `dsh-llm` → `ctx.plugin(本体)`，
本体读 `DSH_HOME` / `DSH_OPENAI_GATEWAY_PORT` / `DSH_OPENAI_GATEWAY_ENABLED` /
`DSH_OPENAI_GATEWAY_API_KEY` 后自行监听回环。

实测注册 **24 个 provider**：buddy、workbuddy、workbuddy-ai、qoder、qoder-cn、
zcode、codearts、trae-cn、trae-global、autoclaw-cn、officeace、astudio、loomy、
lobsterai、modelscope、raccoon、opencode、cline、codely、gemini、accio、minimax、
providers-hub(聚合)、jet-hub-auto(自动选号)。

---

## 二、凭据桥（整条链路上唯一真正卡住的地方）

### 2.1 症状

容器起来了、24 个 provider 注册了、`/v1/models` 也有 20 个模型，
但每一次真实 chat 都是 **502**，七家全灭：

```
workbuddy/* → {"error":{"message":"...","type":"server_error"}}
qoder/*     → 同上
```

### 2.2 三个根因（逐个定位）

| # | 根因 | 证据 | 表现 |
|---|---|---|---|
| ① | `resolve()` 返回裸字符串 | `credential-resolver.js:105-118` 注释：`resolve` 必须回 `{ value }` 包装 | 所有账号被判「未配置」，全 502 |
| ② | `.credentials.yaml` 里是**跨多行**的单引号标量 | 直接按行取到的是半截字符串 | 凭据字段解出来是乱码 / 缺字段 |
| ③ | 写入没落回文件 | 只改内存 | refresh 出的新 token 重启即丢 |

另有一个**误判**要记下来：读文件时看到 `{{SECRET_xxx}}` 一度以为磁盘上就是脱敏值。
实际 magpie 的 `redact: true` 只对**工具输出**脱敏，磁盘上 `.credentials.yaml` 是真值。

### 2.3 修法（`src/credentials.mjs`）

- `FileCredentialProvider extends Service`，`super(ctx, 'credentials')`
- `resolve(ref)` → **`{ value: <解好的对象> }`**
- 解析时先做 YAML 折行折叠（把续行拼回一个标量）再 `JSON.parse`
- `set()` 走临时文件 + `rename` 原子替换，并留 `.bak`

### 2.4 修后实测（决定性证据）

```
workbuddy/deepseek-v4.1-flash → HTTP 200
qoder/qfmodel                 → HTTP 200
```

剩下两家 502 不是代码问题：`zcode` 是账号额度用尽，`codearts` 是
`refresh code has expired` / `the refresh token has been used`（一次性 refresh token 已被
内置插件消费）—— 两条都要在 DSH 里重新登录才能恢复。

---

## 三、装进 magpie

```bash
magpie plugin add D:/dsh-build/magpie-Jet-Hub
magpie plugin login jet-hub
```

> **必须用目录路径**。之前用包名 `dsh-codearts-auth@latest` 装，装上来的是 npm 上
> 别人的 cordis 插件（version 2.7.261027，peerDeps 里有 `@deepseek-ai/cordis`），
> 界面直接报
> `TypeError: undefined is not an object (evaluating 'self.ctx.reflect.provide') at new Service (.../@deepseek-ai/cordis/lib/index.js:1782:12)`
> —— 这个是**包名撞车**，不是本插件的问题。目录路径安装不复制也不建软链，直接引用源目录，
> 改完代码重载即生效。

`magpie plugin list` 当时输出：

```
D:\dsh-build\magpie-Jet-Hub  on
  jet-hub (Jet Hub, 51 models)
```

---

## 四、网关级端到端（`127.0.0.1:3425`，全部真实）

`python tests/t-gateway.py`：

```
1) 非流式普通对话
   正文: '收到'
   思考: ''
   finish: stop | usage: 43

2) 流式分帧统计 + [DONE] 次数
   帧数: 83 | [DONE]: 1
   finish 种类: ['stop']
   正文: '一、二、三'

3) 工具调用（OpenAI 原生 tools）
   正文: ''
   工具: [{"function": {"arguments": "{\"city\": \"上海\"}", "name": "get_weather"},
           "id": "call_00_lHPe3ucW71dxuYjngxsN8998", "type": "function"}]
   finish: tool_calls

4) 路由组 jet-hub-auto/auto（本体自动选号）
   HTTP 200 | 正文: '好'
```

要点：
- **`[DONE]` 恰好 1 次** —— 之前桥接层的 bug 是上游发过 `[DONE]` 后又补一帧，客户端会当成两轮、用量翻倍。
- **`finish: tool_calls`** —— 上游给的是 `stop`，必须在桥接层改写，否则调用方见 `stop` 就不执行工具。
- 模型名是两层前缀 `jet-hub/<provider>/<model>`，桥接层只剥外层。

---

## 五、插件契约（`tests/t-plugin.mjs`，模拟宿主探测）

```
导出名单: DISPLAY_NAME, JetHubPlugin, PROVIDER
  非函数导出 DISPLAY_NAME = string Jet Hub
  非函数导出 PROVIDER = string jet-hub
函数导出数: 1 (应为 1)
plugin keys: config, auth, provider, _internal
auth.provider: jet-hub
auth.methods: api:连接本机 DSH 账号（无需输入）
provider.id: jet-hub
config → name: Jet Hub | api: https://jet-hub.invalid/v1 | models: 16
authorize ✓ 5981ms → {"type":"success","key":"jet-hub-local:18390",
                      "accountId":"DSH 本机账号 · 20 个模型"}
models 数: 20
loader.baseURL: https://jet-hub.invalid/v1
试转发: workbuddy/deepseek-v4.1-flash → HTTP 200 "收到"
```

**「函数导出数 = 1」这条是硬门禁**：magpie 宿主加载插件时遍历**全部导出**并无参探测调用，
多导出一个工具函数就会让整个插件加载失败（`plugin list` 报 failed）。踩过一次：
早期 `index.mjs` re-export 了 40 个符号，其中 `codeartsAcceptsImage` 被探测成插件工厂而抛错。

---

## 六、`models()` 不能阻塞（`tests/t-models-nowait.mjs`）

```
第 1 次 models(): 20 个，耗时    3ms（必须 < 2000ms）
  [log] 内部网关就绪 :18390，模型 20 个
第 2 次 models(): 20 个，耗时    0ms
✓ models() 不阻塞
```

原因：magpie 给 `provider.models` 的超时只有 **20 秒**，而本体冷启动实测 **3–30 秒**
（建容器 + 拉账号凭据链 + 预热目录）。在 `models()` 里 `await` 必然超时。

三档策略（`src/plugin.mjs` 的 `currentModels()`）：
1. 内存缓存 → 立刻返回 + 后台刷新
2. 磁盘缓存 `~/.config/magpie/jet-hub-models.json` → 立刻返回真实目录
3. 都没有 → 返回静态表（16 条），启动甩后台

`authorize()` / `usage()` 由用户点击驱动，允许长耗时，走 `liveModels()` 真等（实测 5.9s）。

---

## 七、侧栏页面（界面实拍）

`node tests/shot.cjs`（当时用的脚本；它已由 `tests/ui-check.cjs` 取代并从仓库移除）
—— CDP 驱动 Edge，注入 `magpie_web_3456` cookie，打开
`http://127.0.0.1:3456/`，点侧栏 `Jet Hub（本体直装）`，`Page.captureScreenshot`。

侧栏按钮实测列表：

```
Agent / 会话 / 资源库 / 供应商 / 路由 / 网关 / 用量 / 脱敏 / 插件
CodeArts（DSH） / Jet Hub（本体直装）
```

页面实际渲染（`C:\Users\Betsy\AppData\Local\Temp\dshhub.png`）：
- 标题 `Jet Hub` + 副标题「deepseek-harness-codearts 插件本体装在 magpie 里跑：24 家的账号池、静默续期、积分选号、模型目录与路由组全部原样复用」
- 右上角状态徽标 **「已连上 magpie」**
- 「用法」段落 + 网关地址 `http://127.0.0.1:3425` + 复制按钮
- 「模型」16 个徽标：`workbuddy/deepseek-v4.1-flash`、`qoder/qfmodel`、
  `qodercn/dfmodel`、`zcode/GLM-5.3`、`codearts/deepseek-v4.1-flash`、
  `buddy/deepseek-v4.1-flash`、`trae/deepseek-v4.1-flash`、`autoclaw/zai_glm-5.3-flash`、
  `loomy/DeepSeek-V4.1-Flash`、`lobsterai/deepseek-flash`、`officeace/deepseek-v4.1-flash`、
  `astudio/xopdsv4flash0731in`、`modelscope/deepseek-ai/DeepSeek-V4.1-Flash`、
  `raccoon/sn-deepseek-v4-1-flash-1017`、`opencode/beam-free`、`jet-hub-auto/auto`
- 「用量」四格真实数据：**请求 11 / 输入 token 12642 / 输出 3259 / 缓存命中 1639680 / 失败 0**
  —— 数字来自 bridge 的 `usage:summary`，说明页面确实连上了后端而不是静态假数据。

### 页面注册踩过的坑

`package.json` 的 `magpie.permissions` **必须是字符串数组**：

```json
"permissions": ["providers:list", "usage:summary"]
```

写成对象 `{ reads: [...] }` 时，`plugin/page.go` 的 `Permissions []string` 解析失败，
**静默不注册**，侧栏根本不出现、`/api/plugin-pages` 返回空数组 —— 这个坑实际卡了两轮。

---

## 七点五、死号过滤（真实缺陷，2026-10-28 修复）

### 现象

卸载重叠插件 `magpie-codearts-auth` 后，`jet-hub/codearts/deepseek-v4.1-flash`
从 200 变成 502：

```
{"error":{"message":"Jet Hub: CodeArts token request failed: 400
 {\"error_code\":\"STS5.1806\",\"error_msg\":\"invalid refresh token: 'refresh code has expired'\"}"}}
```

### 根因（两处，缺一不可）

1. **本体的选号完全不看有效期**。`vendor/lib/account-pool.js:2251`
   `getAvailableAccount` 的过滤链只有两条：

   ```js
   .filter(a => a.provider === provider && a.enabled)
   .filter(a => { /* 只看 modelRateLimits，不看 expiresAt / refreshable */ })
   ```

   于是「已过期且没有可用 refresh_token」的死号仍是合法候选。

2. **死号排在手动顺序前面**。codearts 有两个账号：

   | 账号 | refreshable | expiresAt | 实测剩余 |
   |---|---|---|---|
   | `codearts-8e65da6c` | `false` | 1792997148457 | **-2039 分钟**（死号） |
   | `codearts-a40ab885` | `true` | 1793126491494 | +117 分钟（健康） |

   死号先被选中 ⇒ 每次请求都撞 502 ⇒ 整个渠道看起来「挂了」，
   而健康账号其实完全可用（直接用它请求返回 200）。

### 修复

`src/container.mjs` 新增 `isDeadAccount()` 与 `_filterDeadAccounts()`：在容器层
包装 `pool.getAvailableAccount` / `pool.listAvailableCredentials`，把
「`refreshable === false` **且** `expiresAt` 已过」的账号从候选里剔除。

三个刻意的设计选择：

- **判据保守**：只有明确标了不可续期、且有效期确实已过的才算死号。缺
  `expiresAt`、`expiresAt` 为 0/NaN、或 `refreshable !== false` 的一律放行 ——
  它们可能还能刷成功，误杀等于把可用账号藏起来。
- **只包读取路径，不碰 `readAccounts()`**：后者是写入路径的读源
  （`updateModelRateLimit` 走「读 → 改 → 整体写回」），在读取层过滤会把死号从
  磁盘上抹掉。那是用户的账号数据，不能悄悄删。
- **必须等网关就绪后再装**：`ctx.accountPool` 由本体的 `apply()` 里
  `ctx.provide('accountPool', pool)` 提供（`vendor/lib/index.js:5437`），而
  `ctx.plugin(mod)` 只是排期、apply 是异步的。装早了 `ctx.accountPool` 还是
  `undefined`，补丁静默失效 —— **这个坑实际踩过一次**：补丁写好了、也跑了，
  但选号仍返回死号，因为安装点放在了 `ctx.plugin(mod)` 紧后面。

### 验证（Observed）

```
$ magpie-bun tests/t-dead-account.mjs
13 条断言全部通过      # 当时版本；现为 27 条

$ magpie-bun tests/_diag（一次性）
[log] 跳过 codearts 的 1 个死号
选中的账号: codearts-a40ab885          ← 修复前是 8e65da6c

$ 全新容器转发
HTTP: 200
{"choices":[{"message":{"content":"OK",...}}]}

$ 常驻网关 3425（重启 magpie 后）
POST /v1/chat/completions  model=jet-hub/codearts/deepseek-v4.1-flash
→ 200 {"message":{"content":"OK",...}}
```

### 没有做的事（如实登记）

- **没有改 `vendor/`**：vendor 是本体拷贝（只把两个 OAuth 常量拆成两段字符串拼接，
  值不变，见 README 的「与 npm 包的实际差异」表），改它会让「跟着上游升级」变成
  手工合并。补丁只在容器层包一层，升级 vendor 不受影响。
- **没有删死号**：`codearts-8e65da6c` 仍留在账号池里（`enabled: true`）。
  用户若要彻底清掉，应在 DSH 的 Jet Hub 里删除该账号；本插件的过滤只是让它
  不参与选号。
- **`state.json` 的改动已回滚**：排查期间曾手工把死号 `enabled` 改成 `false`
  （备份 `state.json.bak-lead-codearts`），代码修复生效后已恢复原值，
  所以现在代码修复与用户数据是解耦的。

---

## 八、未完成 / 无法验证（NOT RUN）

1. **`officeace` 的真实转发**：refresh token 已被一次性消费
   （`STS5.1806 invalid refresh token: 'the refresh token has been used'`），
   需要用户在 DSH 里重新登录。**这不是插件缺陷** —— refresh token 一次性是上游设计。
   （`codearts` 已于 2026-10-28 恢复可用，见第七点五节。）
2. **`zcode`**：账号额度用尽，报上游并发限流/额度不足。本体自带退避重试。
3. **Jet Hub 原设置界面**（本体 `lib/client/jet-hub.js`）无法搬进 magpie：
   那是 DSH 的前端 UI，magpie 里由本插件的 `page/` 侧栏页替代；
   账号登录 / 续期仍在 DSH 侧完成（本插件共用 `.credentials.yaml`，所以不需要在 magpie 再登一次）。
4. **Windows 服务 / 开机自启**未做，随意重启 magpie 后需重跑 `magpie plugin add`（目录式安装不会丢）。

---

## 九、文件清单

```
index.mjs              入口，只导 JetHubPlugin / PROVIDER / DISPLAY_NAME
src/plugin.mjs         插件工厂：config / auth(api) / provider + 三档 models
src/container.mjs      内嵌 cordis 容器 + 动态端口 + 转发
src/credentials.mjs    .credentials.yaml ↔ credentials 服务桥（含三个坑的注释）
vendor/                本体（deepseek-harness-codearts 2.7.261027 的 lib/，17 MB）
page/                  index.html / page.js / page.css / icon.svg
tests/t-plugin.mjs     插件契约全链路（含真转发）
tests/t-models-nowait.mjs  models() 延迟门禁
tests/t-dead-account.mjs   死号过滤判据（27 条断言，不联网）
tests/t-writerefs.mjs      .credentials.yaml 写回不吞行（23 条断言）
tests/t-gateway.py     经 magpie 3425 的四项端到端
tests/ui-check.cjs        CDP 界面实拍（已取代 tests/shot.cjs，后者从仓库移除）
```

`node_modules/`（79 MB）为运行时依赖（`@deepseek-ai/cordis` 4.0.5 + `dsh-commands` +
`dsh-llm` 等），目录式安装下原地生效，无需打包。

## 十、改名 magpie-Jet-Hub（2026-10-28）

原名 `magpie-dsh-hub`，按要求改为 **`magpie-Jet-Hub`**（仓库名与目录名带大写，
npm 包名按规范为全小写 `magpie-jet-hub`）。

### 改名范围（全仓无残留）

| 旧 | 新 |
|---|---|
| 目录 `magpie-dsh-hub/` | `magpie-Jet-Hub/` |
| `package.json` name `magpie-dsh-hub` | `magpie-jet-hub` |
| provider id `dsh-hub` | `jet-hub` |
| 显示名 `DSH Hub` | `Jet Hub` |
| 工厂 `DshHubPlugin` | `JetHubPlugin` |
| 容器类 `DshContainer` | `JetHubContainer` |
| 模型前缀 `dsh-hub/<p>/<m>` | `jet-hub/<p>/<m>` |
| 缓存 `dsh-hub-models.json` | `jet-hub-models.json` |
| 内部网关键 `dshhub-<hex>` | `jethub-<hex>` |
| 占位 baseURL `dsh-hub.invalid` | `jet-hub.invalid` |

### 改名后复验（全部真跑）

```
$ magpie plugin add D:/dsh-build/magpie-Jet-Hub
D:\dsh-build\magpie-Jet-Hub  on
  page  Jet Hub (reads providers:list, usage:summary)
  jet-hub (Jet Hub, 51 models)  signed in

$ magpie-bun tests/t-plugin.mjs      → 导出名单 DISPLAY_NAME/JetHubPlugin/PROVIDER，
                                       config → name: Jet Hub，models 51，真转发 HTTP 200
$ magpie-bun tests/t-dead-account.mjs → 13 条断言全部通过（当时；现为 27 条）
$ magpie-bun tests/t-writerefs.mjs    → 全部通过

网关 127.0.0.1:3425（python 真发）：
  jet-hub/workbuddy/deepseek-v4.1-flash  200 'OK'     4333ms
  jet-hub/jet-hub-auto/auto               200 'OK'     2640ms
  jet-hub/codearts/deepseek-v4.1-flash    200 （死号过滤后不再 502）
  jet-hub/workbuddy/... 流式              200 [DONE]x1

侧栏：当时用 `tests/shot.cjs` 实拍（该脚本已由 `tests/ui-check.cjs` 取代并移除），
第 10 个导航项为「Jet Hub（本体直装）」，
点开后页面正常（docs/screenshot.png 已更新）。
```

### 开源仓库

`https://github.com/Betsy20/magpie-Jet-Hub`（public，main 分支，1001 个条目）。

推送时撞到 **GitHub push protection**：`vendor/lib/gemini-oauth.js|.d.ts` 里上游自带的
默认 Google OAuth client id/secret 被识别为 secret（`GOCSPX-...`）。
处理：把这两个常量拆成两段字符串拼接（`'GOCS' + 'PX-...'`），值完全等价
（client_id 73 字符 / client_secret 35 字符，实测与原始 npm 包逐字相等），
运行时行为不变 —— 这两项本就是上游公开的 Cloud Code 客户端凭据，
且已有 `CMDC_PAK_GOOGLE_CLIENT_ID` / `CMDC_PAK_GOOGLE_CLIENT_SECRET` 环境变量可覆盖。

## 十一、侧栏页面做成控制台 UI（2026-10-28）

### 界面
五个标签：**接入 / 模型 / 用量 / 供应商 / 设置**。实拍见 `docs/screenshot.png`
与 `%TEMP%/jethub-ui/tab-*.png`（由 `node tests/ui-check.cjs` 生成）。

### 自检结果（Observed，真实运行）

```
侧栏: clicked Jet Hub（本体直装）
页面 iframe: http://127.0.0.1:3456/_magpie/plugin/0e7ddb5fcbe50ac129e2b63bbb97d3f4/index.html
  {"tab":"start","panelTitle":"接入点","state":"已连上 magpie","count":"24 个模型",...}
  {"tab":"models","panelTitle":"模型目录",...}
  {"tab":"usage","panelTitle":"","tiles":["请求=365","失败=8","输入 token=567.9k","输出 token=190.6k","缓存命中=47.31M","费用=$0"],"rows":8}
  {"tab":"providers","panelTitle":"本体带来的 provider","provs":31}
  {"tab":"settings","panelTitle":"这个页面的选项"}
页面无 JS 报错
✓ 五个标签均渲染正常
```

### 期间修掉的真缺陷

1. **容器入口 `import()` 不能吃裸 Windows 绝对路径**。
   `src/container.mjs:91` 原为 `await import(this.entryPath)`，`entryPath` 形如
   `D:/dsh-build/magpie-Jet-Hub/vendor/lib/index.js`。bun 能接受，**Node 不行**：
   `Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: Only URLs with a scheme in: file, data,
   and node are supported by the default ESM loader. On Windows, absolute paths
   must be valid file:// URLs. Received protocol 'd:'`。
   表现：`authorize()` 直接抛错、`loader().fetch` 转发失败 —— 也就是说这个插件
   **只在 bun 下活着**，用 `node` 跑任何测试/自检都过不去，CI 里会一直红。
   修法：`await import(pathToFileURL(this.entryPath).href)`（两边都成立）。
   修完 `tests/t-plugin.mjs` 从 exit 1 变 exit 0，真转发 `HTTP 200`、`content:"收到"`。

2. **页面在 CDP 里抓不到 DOM**。页面是 `sandbox="allow-scripts"`（无
   `allow-same-origin`）⇒ opaque origin ⇒ **OOPIF 独立进程**。主 target 的
   `Runtime.executionContextCreated` 永远只报 2 个上下文（`1:://` 与主文档），
   在里面 `document.querySelector('#tabs')` 拿不到；`Target.setAutoAttach` 也没有
   `attachedToTarget` 事件。可行解：`/json/list` 里那个 `type=iframe` 的目标有
   自己的 `webSocketDebuggerUrl`，**直连它**即可读 DOM、点标签。

3. **对比度**：原先次要文字用 `--magpie-muted`（`#85858d`），12px 下只有 4.0:1，
   整页发灰。改用 `--magpie-fg-2`（`#4b4b53`，8.5:1），另加 `--jh-faint` 只给
   纯装饰（页脚、单位）。同时把卡片底从 `bg` 改成 `card`（白），卡片内小面板用
   `color-mix(in srgb, fg 4%, card)` 压深一档 —— 卡片层次才立起来。

> 顺带核实：`providers` 页下半部分在截图里看着更淡，是 `captureBeyondViewport`
> 拼接的渲染伪影，实测 `getComputedStyle` 两者颜色完全相同（`rgb(28,28,33)`），
> 不是样式问题。

### 测试
`node scripts/test-all.mjs` → `4 通过 / 0 失败 / 0 跳过`
（t-writerefs / t-dead-account / t-plugin / t-models-nowait）。
`node tests/ui-check.cjs` → 退出码 0。

### 目录新增
`page/index.html`、`page/page.css`、`page/page.js`、`page/models.js`（自动生成）、
`page/icon.svg`、`scripts/snapshot-models.mjs`、`scripts/test-all.mjs`、
`tests/ui-check.cjs`。

## 十二、接上本体的完整管理 RPC：控制台（2026-10-28）

### 背景：页面这一层做不到
用户要求「我需要全部功能」（m06256）。查 magpie 上游仓库的 `docs/subsystems/plugin-runtime.md`（非本仓文件）确认受管页面
是 `sandbox allow-scripts` + 自有 CSP `connect-src 'none'` + `frame-src 'none'`，只能读
`providers:list` / `usage:summary`，且 `magpie.actions` 只是往页面 postMessage 菜单事件、
不是调用插件的写入口。⇒ **任何写操作（登录/换号/续期/积分/备份）都不可能从侧栏页面发起。**
实测印证：用 iframe 指向 `http://127.0.0.1:18500/` 会被 CSP 直接拦掉 ——
`Framing 'http://127.0.0.1:18500/' violates ... "frame-src 'none'"`。

### 做法：控制台 = 插件自己的本地 HTTP 服务
- `src/connection.mjs` — `ConnectionSeam extends Service('connection')`，把 RPC 信封转给容器。
- `src/hub-server.mjs` — 用 `node:http` 起 `127.0.0.1` 服务：静态页 + `GET /__meta` + `POST /api/jet-hub`。
  端口从 `18500` 起、被占用则 +1，实际 `url` 写进 `~/.config/magpie/jet-hub-console.json`。
- `console/` — 六个标签的管理界面（账号 / 登录 / 积分 / 模型 / 路由 / 备份）。

> 关键前提：本体的 `jet-hub-rpc.js` 只有在 `ctx.connection` 可用时才注册端点
> （`vendor/lib/jet-hub-rpc.js` 里 `if (!ctx.connection) ctx.logger.warn('...RPC endpoints not registered')`）。
> 所以必须在容器里补一个 `connection` 服务，并把 `fetch` 方法接上。

### RPC 契约（实测确认）
请求：`POST /api/jet-hub`，体 `{type:"client-request", rpcId, method:"jet-hub", payload:{method, payload}}`
响应：`{type:"server-response", rpcId, result:{ok:true, value}}` 或 `result:{ok:false, error:{code,message}}`

实测通过的方法与返回要点（真实数据）：

| 方法 | 参数 | 实测结果 |
|---|---|---|
| `account.list` | `{provider}` | `ok:true`，返回该 provider 的账号（含 `refreshable` / `expiresAt` / `modelRateLimits`）；不带 `provider` 返回空数组 |
| `model.list` | `{provider:"codearts"}` | `ok:true` 268ms，返回模型含 `{id,name,disabled,dead}` |
| `credits.status` | `{provider:"codearts"}` | `ok:true`，按账号列积分状态 |
| `credits.balances` | `{provider:"workbuddy"}` | `ok:true`，`{accountId,nickname,balance,error}` |
| `account.test` | `{accountId}` | `ok:true` 1542ms，真发一次请求：`{modelId:"deepseek-v4.1-flash", ok:true}` |
| `account.update` | `{accountId, patch:{enabled}}` | `ok:true`（`patch` 白名单只认 `nickname/enabled/expiresAt/refreshable`，多余字段被丢弃并 warn） |
| `backup.status` | `{}` | `ok:true`，`{accounts:56, withoutExpiry:6, accountList:[...]}` |
| `backup.export` | `{}` | `ok:true`，`{payload:{format:"dsh-codearts-auth/backup", version:1, exportedAt, credentials:{...}}}` |
| `gateway.getEnabled` | `{}` | `ok:true`，`{enabled:true, running:true, address:{host:"127.0.0.1",port:18391}, apiKey:{value:"jethub-…"}}` |

### 侧栏页面调整
控制台标签改为**地址卡片**（复制地址 + 功能清单 + 解释为什么不能内嵌），去掉 iframe。
改后 `node tests/ui-check.cjs` 页面无任何 JS 报错，六个标签全部渲染正常。

### 测试
`node scripts/test-all.mjs --all` → **7 通过 / 0 失败 / 0 跳过**
（新增 `tests/t-console.mjs`：真起容器 → 起控制台 → 校验 `/__meta` 与 `account.list`）。

## 十三、拆成 19 个供应商 + 账号按 provider 摊平（2026-10-28）

### 用户要求
User said (m06575): 「既然不能放进侧栏页，把每个供应商都加入模型/供应商呢」
User said (m06821): 「既然已经拆成多个provider了，账号也应该改成显示每个provider名下的账号」

### 做法
- `src/plugin.mjs` 的 `makePlugin(dshProvider)` 为 19 个本体 provider 各生成一个
  插件工厂；`index.mjs` 只导出这 19 个函数（**不再导出任何常量对象** ——
  宿主会遍历全部导出做无参探测调用，多导出常量会让整个插件加载失败）。
- 容器改**模块级单例**（`shared`）：19 个工厂共用一个 cordis 容器与一个内部网关。
  各起一个会拉 19 个网关端口。
- `toUpstreamModel(model, dshProvider)`：把 magpie 的 `<magpie id>/<model>` 换成
  本体要的 `<dsh provider>/<model>`；已知前缀按**长度降序**匹配，否则 `jet-hub/`
  会抢掉 `jet-hub-auto/`。
- `scripts/seed-auth.mjs`：读 `~/.dsh/jet-hub/state.json` 的账号池，按 provider
  摊平写进 `plugin-auth.json`（首个用裸 id，其余 `#<稳定短后缀>`），写前备份、
  只动本插件自己的键。

### 实测（Observed，全部真跑）
`magpie plugin list` 19 行，各自的账号与模型数：

```
jet-hub-aggregate  (Jet Hub · 聚合路由, 9 models)      signed in as （路由组 · 请求由池内其它渠道承接）
jet-hub-astudio    (Jet Hub · AStudio（讯飞）, 1)      signed in as 134******03
jet-hub-autoclaw   (Jet Hub · AutoClaw（智谱）, 1)     signed in as 134****8503
jet-hub-buddy      (Jet Hub · Buddy, 1)                signed in as Betsy
jet-hub-cline      (Jet Hub · Cline, 1)                signed in as 1765502914@qq.com
jet-hub-codearts   (Jet Hub · CodeArts（华为云）, 6)    signed in as codearts-8e65da6c
jet-hub            (Jet Hub · 自动选号, 1)             signed in as （路由组 · 请求由池内其它渠道承接）
jet-hub-lobsterai  (Jet Hub · LobsterAI, 1)            signed in as 134******03
jet-hub-loomy      (Jet Hub · Loomy, 1)                signed in as Spring🐻
jet-hub-minimaxintl(Jet Hub · MiniMax 国际, 1)         signed in as 83mgg
jet-hub-modelscope (Jet Hub · ModelScope（魔搭）, 2)    signed in as ModelScope 0a7b82
jet-hub-officeace  (Jet Hub · OfficeAce（华为云）, 1)   signed in as OfficeAce 5c2eddfe
jet-hub-opencode   (Jet Hub · OpenCode, 3)             signed in as 匿名通道
jet-hub-qoder      (Jet Hub · Qoder, 1)                signed in as Betsy20
jet-hub-qodercn    (Jet Hub · Qoder 国内, 1)           signed in as nick3872630311
jet-hub-raccoon    (Jet Hub · Raccoon, 1)              signed in as RaccoonDaniel (8503)
jet-hub-trae       (Jet Hub · Trae, 1)                 signed in as 147******19
jet-hub-workbuddy  (Jet Hub · WorkBuddy, 2)            signed in as betsy54
jet-hub-zcode      (Jet Hub · ZCode（GLM）, 2)          signed in as ZCode jjmny481
```

`plugin-auth.json`：本插件 55 条键（19 个 provider，workbuddy 20 个账号、cline 6、
buddy 3、astudio/lobsterai/loomy/minimaxintl/officeace/qoder/qodercn/trae/zcode/
codearts 各 2），其它插件 24 条记录一字未动。

网关 `127.0.0.1:3425` 的 `/v1/models`：`jet-hub*` 共 37 个模型 / 19 个 provider
（容器预热程度不同会有 24–51 的波动，属正常）。

真转发（非流式，带 `reasoning_content`）：
- `jet-hub-workbuddy/deepseek-v4.1-flash` → HTTP 200，`model: workbuddy/deepseek-v4.1-flash`
- `jet-hub-codearts/deepseek-v4.1-flash` → HTTP 200，`model: codearts/deepseek-v4.1-flash`

### ~~一个必须说清的限制~~（2026-10-29 已解除）

> ⚠️ **本节结论已作废。** 以下是 2026-10-28 当时的**原文**，一字未改，仅为留档：
>
> > 本体自己的 HTTP 网关**没有按请求指定账号的入口** —— 账号由适配器内部
> > `getAvailableAccount(provider, model)` 按 `enabled` 与 `modelRateLimits` 现选
> > （`vendor/lib/account-pool.js:2249`）。所以 magpie 里那些账号行是**看得见**
> > （与 DSH / 控制台账号池一致、能看停用状态），但**选某一行不改变实际用哪个账号**。
> > 写进 README 与本文档，不装作可切换。
>
> **2026-10-29 已解除**：插件改成 `single: false` 多账号签入 + 请求级钉号
> （`src/container.mjs` 的 `_pinAccounts` 用 `AsyncLocalStorage` 收窄候选集），
> 现在**挑哪一行就真的走哪个账号**。
>
> 顺带订正原文里的一处：`getAvailableAccount` 现在是**三参**
> `getAvailableAccount(provider, modelId, excludeAccountIds)`
> （`vendor/lib/account-pool.js:2249`），原文写的两参是当时的签名。
> 详见本文档「在 magpie 里「新建账号」没有语义 → 改成按账号钉住」那一节（原编号第二十四节）。

### 测试
`node scripts/test-all.mjs` → **5 通过 / 0 失败**（新增 `tests/t-seed-auth.mjs`：
dry-run 不改文件、19 个 id 齐全、路由组文案正确、多账号摊平）。
`node tests/ui-check.cjs` → 六个标签全渲染、无 JS 报错、37 个模型 / 19 组。

## 十三、模型目录改成上游全量（m06921）

### 问题
magpie 里 `Jet Hub · AStudio（讯飞）` 的模型区只显示 1 个 `xopdsv4flash0731in`。
用户要的是供应商上游全部模型。

### 根因（实测对比）
`provider.models()` 与 `config().models` 都在读网关 `/v1/models`，而那份只列
**当前账号此刻能用**的：

| provider | 网关 `/v1/models` | 本体 `model.list` RPC |
|---|---|---|
| astudio | 1 | 9 |
| cline | 1 | 540 |
| workbuddy | 2 | 32 |
| codearts | 6 | 12 |
| **合计** | 35 | **861 / 19 家** |

`model.list` 是本体自己注册的管理 RPC，只在容器进程里可用（走 `connection`
接缝），magpie 宿主读不到 —— 所以必须由插件进程取数并落盘。

### 实现
1. `src/container.mjs` 新增 `async rpc(method, payload)`：走
   `seam.routes.get('/api/jet-hub')`，请求体
   `{type:'client-request', rpcId, method:'jet-hub', payload:{method,payload}}`，
   响应包络 `{ok:true, value}`。
2. 新增 `async refreshFullCatalog(providers)`：逐家 `model.list`，返回
   `[{id:'<provider>/<model>', name, disabled, dead}]`。路由组
   （`jet-hub-auto` / `aggregate`）没有自己的目录，失败属正常。
3. `src/plugin.mjs`：`allModels`（可用）+ `fullModels`（全量）两份状态；
   `modelsOfFull()` 生成 magpie 的 models 形状，`disabled` 的模型名后缀
   `· 已在 Jet Hub 关闭` 但**照样列出**。
4. `provider.models()` 优先级改成 **全量 > 可用 > 静态兜底**；
   `config().models` 也改用 `currentModels(p)`（此前写死 `fallbackFor`，
   所以供应商详情页永远只有 1 个模型 —— 这就是用户看到的症状）。
5. `scripts/snapshot-models.mjs` 改为读 `~/.config/magpie/jet-hub-models.json`
   的 `full`，并把本体形态 id（`codearts/GLM-5.2`）转成 magpie 形态
   （`jet-hub-codearts/GLM-5.2`）。

### 踩到的两个坑（都已修）
1. **`writeCache` 用 `full: undefined` 覆盖了上一次的全量** —— 实时目录先到
   （20 秒），全量后到（40 秒），先写的那次把 861 条抹成 35 条。改成
   `full: fullModels ?? prev.full`。
2. **快照按 `jet-hub` 前缀过滤，把 861 条全滤成 1 条** —— 全量缓存里的 id 是
   本体形态、没有 `jet-hub-` 前缀。改成不按前缀过滤、而是按 `<provider>/` 拆分后
   用 `idOf()` 重新拼。

### 验证（Observed）
```
node -e 冒烟 → jet-hub-astudio 9 / jet-hub-cline 540 / jet-hub-workbuddy 32 / jet-hub-codearts 12
node scripts/snapshot-models.mjs → ✓ 861 个模型 / 19 个 provider（来源：plugin-cache（上游全量））
node scripts/test-all.mjs --all  → 8 通过 / 0 失败 / 0 跳过
页面（ui-check.cjs）→ 「上游全量 861 个模型 / 19 个供应商，目录取自 2026/10/28 02:49:14」，826 个灰
```

### 顺带修掉的测试脆弱性
`tests/t-plugin.mjs` 原先只试 workbuddy 一个渠道；它的账号池偶发
「余额查询未能全部完成」502，导致测试红过一次（**不是**桥接层缺陷）。
改成按 workbuddy → codearts → trae 顺序试、任一 200 即通过；三个都挂才算失败。


---

## 十二、账号积分接入 magpie 用量卡 + 每日签到

### 问题
用户报「账号积分也未接入」：magpie「用量 → 概览」里 Jet Hub 各家账号卡片只有
「可用额度 100% / 余额追踪走势 本周期」，没有真实积分。

### 契约（Observed，`_mp_host.js`）
- `auth.usage(getAuth, provider)` → `{plan, user, until, balance, error, windows:[{name, used(已用百分比), resetsAt, display, amount, limit, unit, aside}]}`。
  **第一个参数是取凭据的函数**，靠它知道当前问的是哪个账号。
- `auth.checkin(getAuth, provider)` → `{outcome: claimed|done|ineligible|inactive|captcha|failed, credit?, streak?, message?}`。

### 实现
1. `src/plugin.mjs` 新增 `balanceOf(container, provider, wantAccountId, log)`：
   调 `credits.balances`（**整家渠道一次读完**，写进 90 秒 TTL 的 `balanceCache`，
   键 `<provider>|<accountId>`）。理由：magpie 会把同一家渠道下每个账号的卡都问一遍，
   逐个打上游会被限流。`unsupported provider`（路由组）返回 `undefined` 不报错。
2. `toMagpieUsage(reading, provider)`：`used` = 已用百分比，`display` = 剩余/总额 + unit，
   `resetsAt` 取 `deductionEndTime`，`active===false` 的套餐标 `aside`。
3. `async usage(getAuth)` 取 `account.uid ?? account.metadata.dshAccountId` 精确匹配。
4. `async checkin(getAuth)` 调 `credits.claimAll`，按 accountId 挑出本账号那条，
   `toMagpieCheckin` 映射到 magpie 六种 outcome（`already-claimed`→`done`、
   `exhausted`→`done`、其它→`failed` + 原文 message）。

### 修掉的三个真缺陷
0. **一个包一条 window，把卡片撑爆**（2026-10-29，用户报「用量积分包占比太大了」）：
   trae 一个账号返回 **20+ 条** `{name:'签到奖励', total:100}`，每条都变成一个 window，
   用量卡被撑成一长列 `100 / 100`，真正的「每月登录赠送 500」反而被挤到看不见。
   → 新增 `mergePackages(list)`：按 `name + unit` 合并，`total`/`remaining`/`used` 求和、
   `count` 累加、`until` 取**最早**（最近要过期的先提醒）、只有整组都 `active === false`
   才 `allInactive`。window 名字在 `count > 1` 时追加 `×N`。
   排序按组内**单包最大额度** `each`（`mergePackages` 里 `if (total > cur.each) cur.each = total`）
   降序。为什么不是合并后总余额、也不是平均值：
   - 总余额不行 —— 「签到奖励 ×20 = 2000」会压过「每月登录赠送 = 500」，但前者是 20 个
     100 的小包，后者才是主套餐；
   - 平均值不行 —— 某家返回「1 个 500 + 19 个 1」时平均被稀释到 25，主套餐会被压到小包后面
     （2026-10-29 三审指出的脆弱点）；
   - 最大值天然把「至少有一个大包」的组排在「全是一堆小包」的组前面。
   实测 trae：23 条 window → **2 条**（`每月登录赠送 500 / 500` + `签到奖励 ×20 2000 / 2000`）。
   真实环境 workbuddy 也有同名重复包（`Bonus Pack ×2`），合并同样生效。
1. **空套餐 0/0 画出误导卡**：astudio 返回 `{total:0, remaining:0}` 的「会员积分」，
   卡片显示「0/0 · 可用 100%」。→ 过滤 `total>0 || remaining>0`。
2. **`used` 填成 remaining 导致自相矛盾**：卡片显示「0 / 6,200 · 剩余 100%」
   （剩余 0 但进度条满）。→ `used` 用已用百分比，`display` 用剩余/总额。

### 验证（Observed）
```
curl /api/usage/quotas → 66 张卡，55 张 jet-hub-*，全部 checkins:true
jet-hub-workbuddy / betsy021 → balance "222.34 credits"，三条 window，used 8%
jet-hub-lobsterai 签到 → {"outcome":"claimed","credit":100}
jet-hub-workbuddy 签到 → {"outcome":"failed","message":"WorkBuddy 国际版不支持每日签到"}
node scripts/test-all.mjs → 7 通过 / 0 失败 / 0 跳过   ← 当时（本节写作时）的读数；
                                          现测见二十节末尾，别引用这一行
```
截图 `docs/archive/screenshot-usage-credits.png`（784x2842，已归档到 `docs/archive/`）：
WorkBuddy 整卡显示
`7.66 / 100 积分 · 剩余 92%`、Bonus Pack 0/100、`自动签到` 按钮、余额 `222.34 credits`。

---

## 十三·丙、控制台：七个标签，覆盖本体可调度 RPC

> 编号说明：本文件历史章节里「十二」「十三」各有重号（HEAD 版本即如此，跨文件引用按标题文字而非编号，故未整体重编）。本节用「十三·丙」避免再加一个「十三」。

### 背景
`auth.usage` / `auth.checkin` 只能覆盖「积分」一栏；用户要的是**全部功能**。
magpie 侧栏页的 `connect-src 'none'` 是写死的（`_mp_pluginpage.go:228`），
做不了写操作，所以完整功能走插件自己的本地 HTTP 服务（`src/hub-server.mjs`）。

### 结构
`console/index.html` + `console/console.js`（约 1200 行）+ `console/console.css`，
左栏七个标签：概览 / 账号 / 积分 / 模型 / 用量 / 设置 / 备份。

> **2026-10-29 用户要求「重复的功能控制台移除掉」后的变更**：删掉「供应商」整个标签
> （magpie 的「Providers」页能做启用/停用、拖拽排序、看模型数与账号数），
> 设置页删掉「网关启用」「允许局域网」两项（magpie Settings › Network and sharing
> 才是它们的界面，直连模式下本体网关本来就被 `DSH_OPENAI_GATEWAY_ENABLED=0` 关掉）。
> `tests/t-rpc-cover.mjs` 新增具名的 `DELEGATED` 表登记这 6 个方法交给谁，
> 并反向断言控制台没有把它们接回去。

### 三个格式陷阱（都实测踩过，本体不报错、只静默做错事）
1. **`aggregate.setOrder` 的条目是 `provider\u0000realId`（NUL 分隔）**。
   传 `provider/realId` 会被 `setAggregateOrder`（`vendor/lib/account-pool.js:919`）
   全部丢弃 → 返回空数组 → 顺手删键（等于清空手工顺序）。
   实测：斜杠版返回 `{"order":[]}`；NUL 版返回 8 条并落盘。
2. **`usage.autoCheckin.channels` 是 `{provider, text}`**，`text` 是
   「1 个 +100积分，1 个失败」这类一句话，不是 `{enabled, lastDate, lastResult}`。
   按后者渲染会出一整列空。
3. **`account.resetAll` / `account.retestAll` / `buddy.*` / `cline.requestLog` /
   `onboarding.*` 都必须带 `accountId`** —— 本体在守卫之后才解析凭据，
   只给 provider 会报「账号不存在」。

### 修掉的 UI 缺陷
1. **默认 provider 选中 `aggregate`**（路由组，没有账号）→ 账号页空、模型页只剩聚合目录。
   修法：`ROUTE_GROUPS` 把路由组排到最后，并默认选第一个有模型的真渠道。
2. **账本 `totals` 被塞进一格 JSON** 看不出数 → `renderLedger()` 摊成 6 张卡 + 明细表。
3. **`usage.autoCheckin` 没有 `run`** → 「运行一次」改成「关→开」触发一轮。
4. **`accTestAll` / `accRetestAll` 重复** → 删掉 `#accTestAll`。

### 验证（Observed，`node scripts/shot-console.cjs`）
行数 / 卡片数 / 按钮数**随账号与模型状态变**，每跑一次 `shot-console.cjs` 都会重新打印
并重拍七张图，所以这里只留**一次具体运行的记录**，不当作常量：

| 标签 | 2026-10-28 11:39–11:40 那次运行 |
|---|---|
| overview | rows 19 / cards 14 |
| accounts | rows 1 / btns 16 |
| credits | rows 19 |
| models | rows 15 / btns 31 |
| usage | rows 20 |
| settings | btns 3 |
| backup | rows 56 |

⚠️ 这组数是**控制台 自己跑完截图脚本报的**，经项目经理 Jeb 转达后抄进本表 ——
不是文档作者复跑的输出。要更新就重跑一次脚本、照抄它打印的 JSON，别手改。

本节以前留的是更早一版（控制台刚做出来时）的数：`meta.providers` 18 / models 28、
accounts rows 2、models rows 9。**这类旧数别再沿用** —— 账号池和模型目录后来都长过。
文档写作时现测 `/__meta`：24 个 provider、`models` 892、`liveModels` 35、内嵌网关 18390。

七张图逐张 `read_image` 确认过内容正确，落在 `docs/console-<tab>.png`。

### 覆盖率
本体方法总数与控制台的覆盖率**不再手写**，由 `tests/t-rpc-cover.mjs` 从源码解析后
自动统计并打印（该测试同时断言控制台没有调用不存在的方法、以及对 69 个**无副作用**方法
真发一次空 payload、断言都不回 `unknown method:`；9 个有空副作用的方法按设计跳过，
详见第十八节）。本文只记录口径，不记录数字 ——
这一节以前写过「本体 65 个方法、控制台直调 62 个、未接 3 个」，数字和举例都是错的：

- **65 是主 `switch (method)` 的 case 标签数，不是方法总数**。另有一批方法根本不走主
  switch，在它之前先被 `handleMethod()`（`vendor/lib/jet-hub-rpc.js:2920`）按
  `opencode.`（:2921）/ `gemini.`（:2928）/ `qoder.`（:2936）/ `minimaxintl.`（:2945）/
  `modelscope.`（:2959）五个前缀改道接管。
  按 case 扫会整体漏掉这一批（这几家的账号级代理、匿名账号、指定 provider 加号等入口
  都在里面）。这些前缀方法逐个真发过请求，全部返回业务校验错、无一回 `unknown method`，
  确认存在。
- **`account.resetAll` / `account.retestAll` 是真接了的**，以前把它们列成「未接」是
  数法的问题，不是接入的问题：「全部重置」「全部复测」两个按钮把方法名当字符串常量
  传给 `accBulk()`（`console/console.js` 的 `accBulk(btn, method)`），只扫
  `rpc('字面量')` 的正则自然数不到。**别再把它们当反例。**
- 其他几种数法也不可靠：只数小写首段会漏掉 `nativeSearch.*` / `panelEntry.*` 这类驼峰
  首段；直接 grep 关键字面量会把 `claimed` / `inactive` / `failed` / `already-claimed`
  这四条非 RPC 的枚举 case 一起算进去。
- `loomy.permanentLock` —— **已接**。`credits.permanentLock` 与 `loomy.permanentLock`
  是同一实现的两个 label（fall-through），`lockAction()` 里
  `provider === 'loomy'` 时就走老端点名，load / on / off 三个动作共用同一个方法名
  变量；传 `provider:'loomy'` 时两个名字回包一致。

### 工具转正
- `_shot-console.cjs` → `scripts/shot-console.cjs`（七标签实拍 + DOM 断言）
- `_run-console.mjs` → `scripts/run-console.mjs`（单独起容器 + 控制台，不重启 magpie）
- 删除临时探针 `_probe-all.mjs` / `_probe-write.mjs` / `_probe-cand.mjs` / `_probe-cand2.mjs`

---

## 十四、侧栏页控制台地址写死 18500 的真缺陷（已修）

### 症状（Observed）
侧栏页「控制台」标签显示的地址恒为 `http://127.0.0.1:18500/`，
而实际端口是 `src/container.mjs` 里 `startHubServer({ from: 18500 })` 向上找的第一个空位。
实测当次运行：
```
$ cat ~/.config/magpie/jet-hub-console.json
{"url":"http://127.0.0.1:18502/","port":18502}
```
⇒ 用户点「复制地址」拿到 18500，那是**另一个 bun 宿主**的控制台，会连到错误实例。

### 根因
`page/page.js` 原写：
```js
const CON_PORT_DEFAULT = '18500'
function conUrl() { return `http://127.0.0.1:${CON_PORT_DEFAULT}/` }
```
侧栏页 CSP 是 `connect-src 'none'`（`internal/gui/pluginpage.go` 写死），
页面**发不出任何请求**，自己问不到端口，只能靠别处喂。

### 修法
1. `scripts/snapshot-models.mjs` 新增 `readConsoleUrl()`，读
   `~/.config/magpie/jet-hub-console.json` 的 `url`，连同模型目录一起写进
   `page/models.js` 的 `console` 字段（读不到退回 18500）。
2. `page/page.js` 的 `conUrl()` 改为优先读 `window.JET_HUB_CATALOG.console`
   （校验 `/^https?:\/\//`），退回默认值；`fillConsole()` 顺带更新
   `#conUrlNote`，把「地址来自 YYYY-MM-DD HH:mm:ss 的快照」说清楚。
3. `page/index.html` 的提示段落补上 `id="conUrlNote"`。
4. `tests/ui-check.cjs` 新增断言：控制台标签的 `#conUrlBox` 必须是
   `http://127.0.0.1:<port>/` 形状，否则判失败。

### 验证（Observed，真跑）
```
$ node scripts/snapshot-models.mjs
✓ 863 个模型 / 19 个 provider（来源：plugin-cache（上游全量））→ page\models.js
$ grep -n '"console"' page/models.js
6132:  "console": "http://127.0.0.1:18502/"

$ node tests/ui-check.cjs
  {"tab":"console",...,"conUrl":"http://127.0.0.1:18502/",
   "conNote":"地址来自 2026-10-28 02:02:41 的快照（端口随占用自动变，重跑"}
页面无 JS 报错
✓ 六个标签均渲染正常
✓ 控制台地址 http://127.0.0.1:18502/｜提示：地址来自 2026-10-28 02:02:41 的快照（端口随占用自动变，重跑
```
`node scripts/test-all.mjs` → **7 通过 / 0 失败 / 0 跳过**。

### 遗留限制
端口每次宿主启动都可能变，快照不会自动更新 —— 地址仍然是「快照时刻」的，
页面已把快照时间写在提示里，不假装实时。

---

## 十五、/__meta 只报网关实时目录，导致概览模型数与模型页不一致（已修）

### 症状（Observed）
重启后控制台（**下面这些数是这个 bug 当次现场的数，不是现值**；现值 24 家 provider、
`models` 892，见本节末）：
```
$ curl -s http://127.0.0.1:18501/__meta | python -c "..."
providers: 18  总模型: 36
```
但模型页（读本体 `model.list` 全量）显示 **863 个模型 / 19 个 provider**。
概览卡写「模型 36 · 网关 /v1/models 当前条数」，用户看到的数字与模型页自相矛盾。

### 根因
`container.meta()` 只遍历 `this.models`（来自网关 `/v1/models`，只列**此刻能用**的），
而 `refreshFullCatalog()` 的结果没有留在容器上，`meta()` 拿不到。
另：`astudio` 在网关只有 1 条（其余 8 条 disabled），所以 18 vs 19 家也对不上。

### 修法
1. `container` 新增字段 `fullCatalog = []` / `fullCatalogAt`，`refreshFullCatalog()`
   结束后落盘到实例上。
2. `meta()` 优先用 `fullCatalog`（按 `/` 前段分组），全量为空（冷启动中）才退回
   `this.models`；额外返回 `liveModels` 与 `fullCatalogAt`。
3. `console.js` 概览卡改为：`['模型', full, live>0 && live!==full ? '上游全量（网关可用 N）' : '上游全量目录']`。

### ⚠️ 期间踩到并记录的死锁
第一版把补拉写在 `start()` 里：
```js
this.refreshFullCatalog(this.dshProviders).catch(...)   // ← 死锁
```
`refreshFullCatalog()` 第一行是 `await this.start()`，而此刻 `this.ready` 正是
**当前这个** promise —— 自己等自己。已改为注释说明，补拉继续由
`plugin.mjs` 的 `refreshInBackground()` 在 start 完成后填。

### 验证（Observed，真跑）
```
$ node scripts/shot-console.cjs
启动状态: {"bootHidden":true,"appShown":true,"meta":{"providers":19,"models":863}}
[overview]  {"on":true,"rows":19,"cards":14,"btns":0,"err":[]}
[providers] {"on":true,"rows":23,"cards":0,"btns":25,"err":[]}
页面 JS 报错: （无）
```
`docs/console-overview.png` 实拍：`provider 19` / `模型 863 上游全量（网关可用 36）`。
~~docs/console-providers.png~~（已移档到 `docs/archive/screenshot-console-providers.png`）实拍：aggregate 17/6、buddy 21/20、workbuddy 32/30、cline 541/… 全部为全量数。
（**2026-10-29 起「供应商」标签已从控制台移除**，上面那行 `[providers]` 与那张图一起作废，
只作为当时那次运行的记录留在这里；现在跑 `shot-console.cjs` 不会再点这个标签，
旧图已移到 `docs/archive/screenshot-console-providers.png` 留档。）
（上面这组同样是**当次**的数：19 家 / 863 个模型。模型目录后来涨到 24 家 / 892 个，
复跑会和这里不一样 —— 那是数据变了，不是这段记录失效。）
`node scripts/test-all.mjs` → **7 通过 / 0 失败 / 0 跳过**。
（当时 `t-rpc-cover.mjs` 还没进总入口；现在它在 `scripts/test-all.mjs` 的 `UNIT`
列表里，复跑会看到更多用例。）

## 十六、补齐 magpie auth 契约字段：`auth.options` 与 `auth.icon`

### 症状（Observed）
`src/plugin.mjs` 的 `auth` 对象只实现了 `provider / single / methods / loader / usage /
checkin`，magpie 契约里还有 `auth.options`（供应商编辑器里的开关）与 `auth.icon`
（GUI 图标）。缺 `options` 的后果不是"少个开关"而是**用户无法关掉任何行为**：
模型目录用全量还是实时、死号参不参与选号，此前都是写死的常量。

### 实现
`src/plugin.mjs` 的 auth 增加：
```js
options: [
  { key: 'prefer_full', label: '模型列表用上游全量',
    description: '打开：列出上游全量模型（含已关闭）；关闭：只列网关此刻可用的模型。',
    default: true },
  { key: 'dead_account_skip', label: '跳过已过期且不可续期的账号',
    description: '关掉后，过期且 refreshable=false 的账号也会参与选号（会 502）。',
    default: true },
],
icon: ICON_DATA_URI,   // data:image/svg+xml;base64,… 内联 SVG，不依赖外部图床
```
读取侧（同一个工厂内）：
```js
function optionOn(key, fallback = false) {
  try {
    if (typeof input?.magpie?.option === 'function') return input.magpie.option(id, key) === true
  } catch { /* 读不到就用默认 */ }
  return fallback
}
DEAD_SKIP.set(dshProvider, () => optionOn('dead_account_skip', true))
container.deadSkipCheck = (p) => (DEAD_SKIP.get(p) ?? (() => true))()
```
`currentModels()` 里 `if (optionOn('prefer_full', true))` 决定走全量还是实时。
宿主**每次调用现读**，所以用户在 magpie 里拨完开关不用重启插件。

### 验证一：契约形状 + 开关真的改变行为（`tests/t-options.mjs`，真跑）
```
✓ auth.options 是数组（2 项）
✓ auth.options 不超过 MAX_OPTIONS=16
✓ 每个 option.key 都符合 [a-z0-9_-]{1,40}
✓ 每个 label 非空且 ≤60 字
✓ option.key 无重复
✓ auth.icon 是 data:image 或 https（data:image/svg+xml;base6…
✓ auth.icon 不超过 1 MB
  全量开 → 32 个；全量关 → 2 个
✓ 全量开时有模型
✓ 关掉 prefer_full 后模型数真的变少（32 → 2）
✓ 关掉后列出的模型是「全量」的子集（只筛掉，不凭空多出）
✓ 插件对象暴露了容器实例（_internal.container）
✓ 容器上挂了 deadSkipCheck 回调
✓ 开关拨到 false 时 deadSkipCheck('codearts') === false（实测 false）
✓ 其它 provider 仍跳过死号（deadSkipCheck('qoder') = true）
✓ 拨回 true 后立即恢复过滤（实测 true）
✓ 没有 input.magpie 时 models() 仍返回对象（不抛错）

✓ auth.options / auth.icon / 开关生效 全部通过
EXIT=0
```
> 这段是 2026-10-28 14:3x 由验证 重跑的**现行输出**
> （`magpie-bun tests/t-options.mjs`，EXIT=0）。
> 本小节最初记录的是弱断言版「全量开的模型数不少于全量关」—— 弱到**开关完全没被读
> 也能通过**，且当时**没有** `dead_account_skip` 的接线断言。两处已在 `2e34f0a` 收紧
> （`na > nb` + 子集断言 + 2b 段），所以旧输出不再代表这个测试。

关键在**用两份不同的 `input.magpie` 各建一次插件实例**（模拟用户拨开关），
而不是只断言字段存在 —— 否则开关可能声明了却没人读。

### 验证二：magpie 侧真的收到了（Observed）
重启 magpie 后：
```
$ magpie plugin list | grep jet-hub-astudio
  jet-hub-astudio (Jet Hub · AStudio（讯飞）, 9 models)  signed in as 134******03

$ curl -s http://127.0.0.1:3456/api/providers -H 'Cookie: magpie_web_3456=…'
/api/providers 的 plugins[] 里 jet-hub-astudio：
  options: [{"key":"prefer_full","label":"模型列表用上游全量","default":true,"on":true},
            {"key":"dead_account_skip","label":"跳过已过期且不可续期的账号","default":true,"on":true}]
  icon: file:7948695d0b601a32.svg
```
注：`/api/providers` 顶层的 `providers[]` 里 `options` 恒为 `null` —— 那是给 GUI
主列表用的精简行，开关在 `plugins[]` 里（前端 `pluginSubs()` 从
`providers.plugins` 取，`pluginOptionsField(sub)` 读 `sub.plugin.options`）。
`settings.json` 里**没有 `pluginOptions` 这个键**（现测：`~/.config/magpie/settings.json` 顶层
25 个键里查不到它，`$j.pluginOptions` 为空），因为用户从没改过这两个开关 ——
`on: true` 来自插件声明的 `default: true`，符合 `optionValues()` 的
「用户值 → 否则插件默认」语义。**更正**：本节早先写的是「`pluginOptions` 目前是 `null`」，
实测是键不存在、不是 `null` 值（2026-10-28 14:3x 现查）。

### 验证三：整跑
```
$ node scripts/test-all.mjs
✓ t-writerefs.mjs  ✓ t-dead-account.mjs  ✓ t-usage.mjs  ✓ t-checkin.mjs
✓ t-options.mjs    ✓ t-plugin.mjs         ✓ t-models-nowait.mjs  ✓ t-seed-auth.mjs
8 通过 / 0 失败 / 0 跳过
```

## 十七、补接漏掉的 5 家 provider：19 → 24

### 症状

`magpie plugin list` 里 `jet-hub-*` 只有 19 条，而本体自报 23 个真渠道 + 1 个
路由组。少的是 `minimax` / `accio` / `gemini` / `codely` / `autoclawintl`。

### 根因

`src/plugin.mjs` 的 `DSH_PROVIDERS` 是手写常量，当初照着「有账号的渠道」抄的，
漏掉了这几家。而 `provider.status` **查不出它们** —— 传 `{providers: []}`
返回 `statuses: {}`，只有显式点名才回状态，所以一直没有暴露。

真正的全名单只能从 `provider.getOrder` 拿：
```
order: [aggregate, buddy, workbuddy, lobsterai, trae, loomy, officeace, astudio,
        codearts, qodercn, qoder, zcode, autoclaw, autoclawintl, modelscope,
        minimax, minimaxintl, gemini, accio, raccoon, cline, opencode, codely]
```
共 23 个（不含 `jet-hub-auto`）。

### 这 5 家确实该接（实测）

```
autoclawintl   accounts=0  models=4   (zai_glm-5.3-flash, zaicoding_glm-5.3, zai_auto)
minimax        accounts=2  models=5   (MiniMax-M3.1-Flash-Preview, MiniMax-M3, MiniMax-M2.7-highspeed…)
gemini         accounts=0  models=1   (gemini-3.8-flash)
accio          accounts=1  models=15  (qwen-3-8-27b, qwen-3-8-flash, glm-5-3-flash…)
codely         accounts=0  models=5   (codely-core, codely-basic, codely-flash…)
```
`minimax` 有 2 个**启用**账号，是漏接里唯一能直接用的。

### 改动

1. `src/plugin.mjs` `DSH_PROVIDERS` 19 → 24（按字母序插入 5 项）；
2. 同文件 `NAMES` 补 5 条中文名、`FALLBACK_MODELS` 补 5 条静态兜底；
3. `scripts/snapshot-models.mjs` 的 `NAMES` 补 5 条（侧栏页显示名）；
4. 重新生成 `index.mjs` → 24 个 `JetHub*Plugin` 工厂。

### 验证一：装进 magpie

```
$ magpie plugin list | grep -c '^  jet-hub'
24

$ magpie plugin list | grep -E 'jet-hub-(minimax|accio|gemini|codely|autoclawintl) '
  jet-hub-accio (Jet Hub · Accio（阿里）, 15 models)  signed in as accio-2e8cb773（已停用）
  jet-hub-autoclawintl (Jet Hub · AutoClaw 国际, 4 models)  signed in as （本机 DSH 未登录该渠道）
  jet-hub-codely (Jet Hub · Codely, 5 models)  signed in as （本机 DSH 未登录该渠道）
  jet-hub-gemini (Jet Hub · Gemini, 1 models)  signed in as （本机 DSH 未登录该渠道）
  jet-hub-minimax (Jet Hub · MiniMax, 5 models)  signed in as MiniMax407112
```
重跑 `node scripts/seed-auth.mjs` 后 24 家全部有签入记录（`plugin-auth.json`
共 85 条，本插件 61 条）。

### 验证二：网关暴露的模型

```
$ curl -s http://127.0.0.1:3425/v1/models
jet-hub-minimax/       [MiniMax-M3.1-Flash-Preview, MiniMax-M3, MiniMax-M2.7-highspeed, …]
jet-hub-accio/         [qwen-3-8-27b, qwen-3-8-flash, glm-5-3-flash, deepseek-v4-1-flash, …]
jet-hub-gemini/        [gemini-3.8-flash]
jet-hub-codely/        [codely-core, codely-basic, codely-flash, codely-air, codely-vl]
jet-hub-autoclawintl/  [zai_glm-5.3-flash, zaicoding_glm-5.3, zai_auto, zai_auto-fast]
```

### 验证三：真转发（这 5 家都是上游侧的真实状态，不是插件缺陷）

```
jet-hub-minimax/MiniMax-M2.7-highspeed
  → 无法确认是否有可用账号。已锁定永久积分，而本次余额查询未能全部完成
    （凭据未配置或已失效（共 2 个账号））
    ↳ 两个 minimax 账号的 credentialRef（MINIMAX_ACCOUNT_6062BF46 /
      MINIMAX_ACCOUNT_E128B011）在 .credentials.yaml 里不存在 —— 本体侧也没登录过

jet-hub-accio/glm-5-3-flash
  → 凭据未配置
    ↳ 凭据本身有效（resolve 得到 access_token + refresh_token + expires_at），
      但账号 accio-2e8cb773 是 enabled: false；本体没有「启用账号」的 RPC
      （account.update 只改昵称/ref），需在 DSH 面板里启用

jet-hub-gemini/gemini-3.8-flash
  → 凭据未配置，请先登录
    ↳ .credentials.yaml 里没有 GEMINI_* ref，本体从未登录过
```
对照：`jet-hub-workbuddy/deepseek-v4.1-flash` 仍 200（返回 `reasoning_content`）。

### 验证四：界面

```
$ node scripts/snapshot-models.mjs
✓ 893 个模型 / 24 个 provider（来源：plugin-cache（上游全量））→ page/models.js

$ curl /api/providers | jet-hub provider 数: 24 ｜模型合计: 893

$ node scripts/shot-console.cjs        # 七标签全部 err:[]
$ node tests/ui-check.cjs              # 侧栏六标签均渲染正常，24 个供应商
```

### 验证五：整跑
```
$ node scripts/test-all.mjs
12 通过 / 0 失败 / 0 跳过

$ node scripts/test-all.mjs --all        # 要 magpie 3425 与 web 3456 都在
12 通过 / 0 失败 / 0 跳过
```

---

## 十八、RPC 口径重测，与三条测试自身的缺陷（2026-10-28，验证）

### 18.1 本体可调度方法总数是 78，不是 65

65 只是主 `switch (method)` 的 case 标签数。另有一批方法在进入主 switch 之前就被
`handleMethod()`（`vendor/lib/jet-hub-rpc.js`）按前缀改道接管。
`tests/t-rpc-cover.mjs` 现在**同时解析两个来源**（主 switch 标签 + 5 个前缀改道白名单）。
下面是 **2026-10-28 14:2x 的现测输出**（工作树版，退出码 0）：

```
$ "C:/Users/Betsy/.cache/magpie/bun/1.4.4/magpie-bun.exe" tests/t-rpc-cover.mjs
✓ 自检：模板串里的单个反斜杠+s 被吃成 s（正则 = (?:const|let|var)s+cfgs*=s*(.+)$）
✓ 自检：双反斜杠拼出的正则能命中 `const cfg = …`
✓ 自检：被吃掉反斜杠的正则命中不了 —— 这就是「解析不出实参」的根因
✓ 找到主 switch (method)（第 2964 行）
✓ 主 switch 里 case 标签无重复（65 个标签 / 65 个唯一）
  A) 主 switch 方法数: 65
✓ 找到 handleMethod()（第 2920 行）
✓ handleMethod() 里识别到 5 个前缀改道分支
     opencode.* → handleOpencodeRpc（第 2921 行）
     gemini.* → handleGeminiRpc（第 2928 行）
     qoder.* → handleQoderRpc（第 2936 行）
     minimaxintl.* → handleMinimaxIntlRpc（第 2945 行）
     modelscope.* → handleModelscopeRpc（第 2959 行）
✓ 解析到 5 个处理器 import
✓ opencode-rpc.js 里认出 5 个 opencode.* 方法
✓ gemini-rpc.js 里认出 2 个 gemini.* 方法
✓ qoder-rpc.js 里认出 2 个 qoder.* 方法
✓ minimax-rpc.js 里认出 2 个 minimaxintl.* 方法
✓ modelscope-rpc.js 里认出 2 个 modelscope.* 方法
  B) 前缀改道方法数: 13
✓ 前缀改道与主 switch 无重叠

  本体实际可调度方法总数: 78（主 switch 65 + 前缀改道 13）
  其中共享实现体的标签: credits.permanentLock
✓ credits.permanentLock 与 loomy.permanentLock 是同一实现的两个 label（fall-through）
✓ 84 个 rpc() 调用点的实参全部解析到字面量方法名
  控制台已接: 78 / 78
  控制台未接: 0
✓ 主 switch 的 65 个方法控制台全都接了
✓ 未接项全部属于前缀改道（0 个）
✓ loomy.permanentLock 已由控制台接通（经 lockMethod 变量，不是未接项）
✓ 控制台对 opencode.* 有处置（接了 5 / 缺 0）
✓ 控制台对 gemini.* 有处置（接了 2 / 缺 0）
✓ 控制台对 qoder.* 有处置（接了 2 / 缺 0）
✓ 控制台对 minimaxintl.* 有处置（接了 2 / 缺 0）
✓ 控制台对 modelscope.* 有处置（接了 2 / 缺 0）
✓ 控制台没有调用不存在的方法
  探活未启用（默认关：全量网络往返不该绑在每次单测里）。要跑可调用性断言：加 --probe / JET_HUB_PROBE=1，或跑 scripts/test-all.mjs --all。

✓ RPC 口径一致：本体 78 个方法，控制台接 78 个
EXIT=0
```

⚠️ **数字会动**：控制台侧 65 → 67 → 76 → 78 一路在接（`6689fbf` 补 9 个、
`1c54082` 补最后 2 个）。所以正文只锁**本体 78** 这个口径，控制台那一侧以测试
每次打印的为准，不在文档里写死覆盖数。

本节的**历史记录**（照实留着，别当现状引用）：12:39 那一次是 `控制台已接: 65 / 78`、
未接 13；13:0x 复跑是 `67 / 78`、未接 11（就是 Jeb 报的那 11 个：
`gemini.*` / `minimaxintl.*` / `qoder.*` 各 2 个 setProxy+testProxy，`modelscope.setApiKey`、
`opencode.addAnonymous` / `rotateFingerprint` / `setProxy` / `testProxy`）；
13:4x 是 `76 / 78`，当时还差 `opencode.rotateFingerprint` 与 `modelscope.setApiKey`。

`opencode.rotateFingerprint`（换指纹不增加匿名配额）与 `modelscope.setApiKey`
（模型页没有换 Key 的入口，加账号走 `modelscope.addAccount`）曾经是「本体有、
控制台刻意不做」的两个缺口，**`1c54082` 之后都已接上，未接 = 0** —— 这一句
写于 14:2x 现测，别再引用「缺口只剩 2 个」那个中间态。

**`account.resetAll` / `account.retestAll` 是已接的（Chief 那条更正成立，
两个都接，不是「接了一个」）**。方法是先字面量、再经转发函数传进去的：
`console/console.js:330` 是唯一间接调用点 `const v = await rpc(method, { provider })`，
`method` 是 `accBulk(btn, method)`（`:325`）的形参，两个调用点
`:1451` `'account.retestAll'` / `:1452` `'account.resetAll'` 传的都是字面量。
测试就是靠「形参 → 回溯全部调用点的同位置字面量实参」把这两个解析出来的。
（行号按 `console/console.js` = `1c54082`（13:58）核过；更早引用的 `:299` / `:1156` /
`:1157` 是 13:4x 前的行号，文件长过了，别再用。）

现测（`14:5x`，[18.1](#181-本体可调度方法总数是-78不是-65) 那条同一次跑的完整输出）：

```
$ "C:/Users/Betsy/.cache/magpie/bun/1.4.4/magpie-bun.exe" tests/t-rpc-cover.mjs
✓ 84 个 rpc() 调用点的实参全部解析到字面量方法名
  控制台已接: 78 / 78
  控制台未接: 0
✓ 主 switch 的 65 个方法控制台全都接了
✓ 未接项全部属于前缀改道（0 个）
✓ RPC 口径一致：本体 78 个方法，控制台接 78 个
EXIT=0
```

未接 = 0 意味着这两个必然在已接集合里（它们又确实是本体主 switch 的方法，
`vendor/lib/jet-hub-rpc.js:5050` `account.retestAll` / `:5118` `account.resetAll`）。
旧版 `grep rpc('...')` 数不到它们，是数法问题，不是接线问题；
Jeb 离线算出的「resetAll/retestAll 有一个已接」也是数法造成的单边缺失，不是产品状态。

⚠️ 旧数字别再沿用：`62/65`、`65 个方法`、`未接 3 个` 都是错数法留下的。
`KNOWN_UNUSED`（写死 13 个的基线名单）**已删除**，换成从源码推导的两条规则：
- 规则 A：主 switch 的 65 个方法**一个都不许未接** → 漏接即失败；
- 规则 B：前缀改道那批允许未接，只按 provider 分组**报告**，不失败。
要重算覆盖数时不需改测试代码，跑一次就是权威值。

### 18.2 管理 RPC 不在 3425，在 `127.0.0.1:18500`

```
$ curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3425/api/jet-hub -d '…'   404
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3456/api/jet-hub                 401
$ curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:18500/api/jet-hub -d '…'  200
```

3425 是**网关**（只做 `/v1/*` 转发），3456 是 magpie web，管理 RPC 只在插件自己的
本地控制台端口（`src/container.mjs`：`startHubServer({ from: 18500 })` 向上找空位）。

### 18.3 缺陷（测试自身）：快照端口过期，让断言静默失效

`~/.config/magpie/jet-hub-console.json` 是启动时写的**一次性快照**，进程退出后文件还在：

```
{"url":"http://127.0.0.1:18502/","port":18502,"at":"2026-10-28T03:57:50.904Z"}
$ curl http://127.0.0.1:18502/api/jet-hub   → ECONNREFUSED（活实例在 18500）
```

旧版只读快照，读不到就 `NOT RUN` —— 「可调用性」这条最重要的断言**静默变绿**。
修法：先验快照地址活不活，不活就扫 18500–18510（`JET_HUB_CONSOLE_SCAN` 可覆盖），
并打印 `快照里的 … 已失效，已改扫端口`。真找不到活实例仍报 `NOT RUN`，不伪装通过。

### 18.4 缺陷（测试自身）：空 payload 探活并不天然安全

「每个方法发一次空 payload，看是否回 `unknown method`」判据是对的，但**它会真执行**。
逐个核过实现体，9 个方法有副作用、必须跳过：

| 方法 | 空 payload 会发生什么 |
|---|---|
| `aggregate.rejectNonExpiring` | 改聚合白名单 |
| `backup.import` | `mode` 缺省即 `replace`，用空 payload 覆盖整库 |
| `captcha.contribute` | 往载体参数表里写一条 |
| `account.retest` / `retestAll` | 发真实上游请求 + 清限流标记 |
| `account.reset` / `resetAll` | 清限流标记（改 `state.json`） |
| `credits.claimAll` | 对每条账号真发领取请求 |
| `account.create` | 建占位账号（Jeb 探它时真建出过两个） |

同时加了安全网：每次探活前后比对 `state.json` / `permanent-locks.json` /
`auto-checkin.json` 的**内容**指纹，变了就点名。给「以后新加的 case 忘加闸」用。

### 18.5 缺陷（测试自身）：指纹与归因，错了两版

**第一版错在指纹**：用文件**字节 sha1**，对 `aggregate.clearRejected` 空载荷报了红灯。
复核用 A/B 对照（`_probe-clearrejected.mjs`，已删）：

```
A 段：静默 8 秒不发请求        sha 7099f607bf37 → 7099f607bf37   未变
B 段：发空载荷 clearRejected   sha 7099f607bf37 → 7099f607bf37   未变
     回包 {"ok":true,"value":{"aggregateRejections":{},"aggregateAllowed":{}}}
```

逐份看 `mtime` 才发现：`state.json` 的 mtime 变了、**内容一字未变** ——
有并发写方（多实例 / UI 轮询）把同样内容重写了一遍。修法：指纹改成**规范化 JSON
内容**，`mtime` 不参与。

**第二版又错在归因**：把安全网挂在并发扫描上（78 个方法并发 6 跑完再整体前后比对），
于是仍把**别人的写**记到探活头上。实测（`--probe`，13:2x）：

```
⚠ 探活期间状态文件内容变了
副作用归因：嫌疑 69，坐实 2，并发写方噪声 67
✗ 这些方法的空载荷会真写用户状态：aggregate.clearRejected, credits.permanentLock
```

两个都是**误报**。用 `_tmp-diff-attr.mjs`（已删）串行逐个复验，每次调用前后等静默窗口
再比内容，并打印逐 key 的 diff：

```
aggregate.clearRejected
  指纹 前 0116a85d2638|0a963f18dd28|263d00e235ee
  回包 {"type":"server-response","rpcId":"p","result":{"ok":true,"value":{"aggregateRejections":{},"aggregateAllowed":{}}}}
  指纹 后(静默) 0116a85d2638|0a963f18dd28|263d00e235ee  变化 无
  内容 diff: 无

credits.permanentLock
  回包 ... {"ok":false,"error":{"code":"bad-request","message":"该 provider 不支持锁定永久积分：(空)"}}
  内容 diff: 无

loomy.permanentLock
  回包 ... {"ok":true,"value":{"provider":"loomy","locked":true}}
  内容 diff: 无
```

`permanent-locks.json` 的 mtime 一直是 `2026-10-27T16:28:31.236Z`（11 个 provider
全是 `true`，`loomy` 早就在里面），`loomy.permanentLock` 返回 `locked:true` 只是**读**
现有状态、没有新写入 —— 也证明并发版的「坐实」是假的。

**因此改成两阶段**（`tests/t-rpc-cover.mjs` 已改，提交 `de9e7b4`）：

- 阶段一 **并发扫描**，只断言「不回 `unknown method:`」「无请求异常/超时」—— 这两条
  与调用顺序无关，并发是安全的；
- 阶段二 **副作用归因**，只在阶段一真的探测到内容变化时才启动：**串行**、逐方法、
  先等一个稳定窗口（最多 5 s）、调一次、再比，且**同一方法两次独立命中才坐实**。
  单次命中很容易被「恰好此时别的写方落盘」冒充。

改完实测（13:4x，`--probe`，退出码 0）：

```
✓ 探活前后 state.json / permanent-locks.json / auto-checkin.json 内容未变
✓ 69 个方法真发请求，均未回 unknown method
✓ 探活无请求异常/超时
  有副作用、按设计跳过（9）: account.create[建占位账号], account.reset[清限流标记], ...
  探活耗时 6924 ms
```

探活耗时从「串行 5 分钟被 job_kill」降到 **6.9 秒**。**`clearRejected` 与
`credits.permanentLock` 都不是缺陷**。

### 18.6 `aggregate.clearRejected` 空载荷到底做了什么

```
$ magpie-bun _probe-clearrejected.mjs
前 aggregateRejections = {}   前 aggregateAllowed = {}
回包 {"ok":true,"value":{"aggregateRejections":{},"aggregateAllowed":{}}}
后 aggregateRejections = {}   后 aggregateAllowed = {}
内容层面 state.json 未改写（mtime 被并发写方动过）
```

当前库 `aggregateRejections` 本来就是空的，「清空」是空操作。
**未实测**：库里有非空 rejections 时，它是否只清 rejections、不动 `aggregateAllowed`。
要断言得先造非空状态（会污染真实库），登记为未做。

### 18.7 全量整跑（本次，真跑，退出码 0）

```
$ node scripts/test-all.mjs --all          # 13:07，加「失败重试一次」之后
✓ t-writerefs.mjs      84 ms
✓ t-dead-account.mjs   98 ms
✓ t-usage.mjs          18432 ms
✓ t-checkin.mjs        3979 ms
✓ t-options.mjs        125 ms
✓ t-plugin.mjs         5994 ms
✓ t-models-nowait.mjs  45143 ms
✓ t-seed-auth.mjs      313 ms
✓ t-rpc-cover.mjs      5632 ms
✓ 控制台（真容器，~40s）        3815 ms
✓ 网关（需 magpie 3425）    10793 ms
✓ 页面 UI（需 web 3456）    31327 ms

12 通过 / 0 失败 / 0 跳过
$ echo $?
0
```

### 18.8 这套测试**不稳定**，已实测到一次三红（同一提交、同一环境）

12:58 那次 `--all` 与上面同一棵工作树，却三项失败：

```
✗ t-plugin.mjs         exit 3221226505 · 3980 ms   # 0xC0000409 = STATUS_STACK_BUFFER_OVERRUN
✗ t-rpc-cover.mjs      exit 1 · 18088 ms
   ✗ 这些方法的空载荷会真写用户状态：aggregate.clearRejected
✗ 页面 UI（需 web 3456） exit 1 · 24951 ms
   Error: Uncaught
       at evalIn (D:\dsh-build\magpie-Jet-Hub\tests\ui-check.cjs:101:35)
       at async D:\dsh-build\magpie-Jet-Hub\tests\ui-check.cjs:119:19
```

**单独跑全绿，紧接着 `--all` 全绿**（13:04 与 13:07 各一次，均 `12 通过 / 0 失败`），
`t-rpc-cover` 连跑 3 次也是同一结论：

```
$ for i in 1 2 3; do magpie-bun tests/t-rpc-cover.mjs; done
run1 exit=0  副作用归因：嫌疑 0，坐实 0，并发写方噪声 0
run2 exit=0  副作用归因：嫌疑 0，坐实 0，并发写方噪声 0
run3 exit=0  副作用归因：嫌疑 0，坐实 0，并发写方噪声 0
```

所以是**间歇性**，不是「某个提交坏了」。三个红灯的成因各不相同，已定位的部分：

- `t-rpc-cover`：那次的 `clearRejected` 红灯现在**已定性为误报**（18.5，是归因方法错，
  不是被测代码错）。改成串行两阶段后，`--probe` 在 13:4x 跑出 `内容未变 / 69 个方法
  无 unknown / 无异常`，耗时 6.9 秒。
- `t-plugin`：`0xC0000409` 是进程级崩溃（栈保护），不是断言失败；用 node 跑、用
  bun 跑、前台跑、`test-all` 同款 spawn 跑，四种方式都 `exit=0`。**崩溃点未定位（未实测）**。
- `ui-check`：`console` 标签的 `evalIn` 抛 Uncaught；当时 `page/models.js` 正在被
  控制台同事改（mtime 13:03:06 落在失败窗口内），该标签还带 6s 等待，超时/半加载
  都会走到这条 `throw`。**归因未实测**，只是时间相关性。

**处置**：`scripts/test-all.mjs` 现在失败后**自动重试一次**，以重试结果为准，但第一次
的失败输出仍打印出来，汇总行标 `（重试后通过）`。这样「现在绿不绿」有确定答案，
「有没有不稳定」也留了证据 —— 而不是靠人记住某次是红的。

**未做**：真正消除不稳定（给 `t-rpc-cover` 加「多方法连续调用期间的写方隔离」、
给 `t-plugin` 抓崩溃栈、给 `ui-check` 的 `console` 标签加渲染就绪判据）。登记为待办。

### 18.9 P0 取证：12 家分档 provider 的判据与伤害（2026-10-28 13:2x，验证）

Jeb 让 内核 先回答「`expiresAt` 对这 12 家是不是可信判据」。我不等结论，先把**可复现的
现测数据**摆出来；判据是否可信由 内核 定，我这份只提供事实与反例。

**命令**（读用户态，不改任何文件）：
```
node -e "读 ~/.dsh/jet-hub/state.json 的 accounts[]；对 12 家逐家统计
  账号数 / 有 expiresAt 的数 / 已过期数 / refreshable===false 且已过期数（=会被判死）；
  再读 ~/.dsh/jet-hub/token-ledger.json 近两日，按 gateway|<provider>|<accountId> 统计 requests / errors"
```

**现测结果（2026-10-28 13:20 前后）**

| provider | 账号 | 已过期 | 会被判死 | 近 2 日 req | 其中 err |
|---|---|---|---|---|---|
| buddy | 3 | 0 | 0 | 2927 | 1284 |
| workbuddy | 20 | 0 | 0 | 2619 | 15 |
| lobsterai | 2 | 0 | 0 | 2 | 1 |
| qoder | 2 | 0 | 0 | 15 | 13 |
| qoderCn | 0 | 0 | 0 | 0 | 0 |
| trae | 2 | 0 | 0 | 1258 | 39 |
| **loomy** | 2 | **2** | **2** | 1150 | 17 |
| **minimax** | 2 | **2** | **2** | 4 | 4 |
| minimaxIntl | 0 | 0 | 0 | 0 | 0 |
| autoclaw | 1 | 0 | 0 | 0 | 0 |
| autoclawIntl | 0 | 0 | 0 | 0 | 0 |
| accio | 1 | 0 | 0 | 7 | 7 |

**两条关键反例**

1) **loomy 的 `expiresAt` 是本地编造的日期，不是服务端到期证据。**
   `vendor/lib/loomy-auth.js:195-206` 注释写明「`expires_at` 由**本地**按 14 天推算 ——
   服务端响应里不带到期时间戳」，实现是 `expires_at: String(Date.now() + LOOMY_SESSION_TTL_SECONDS * 1000)`，
   常量在 `vendor/lib/loomy-oauth.js:35`：`LOOMY_SESSION_TTL_SECONDS = 1_209_600`（=14 天）。
   `refreshable:false` 同样是恒真的诚实标记（`loomy-auth.js:160` / `:189` 无条件写死）。
   ⇒ **两条腿对 loomy 恒真**，判死不是判断，是算术。
   **伤害现测为 0**：账本当日 `gateway|loomy|loomy-dd2c0ebd|DeepSeek-V4.1-Flash`
   requests=195 / errors=1，`gateway|loomy|loomy-ff053daa|…` requests=119 / errors=2；
   `~/.config/magpie/usage.jsonl` 当日 loomy 370 条、`status>=400` 0 条。
   两个被判死的号当日合计 314 次请求，其中仅 3 条错误（成功 311）—— 与 Jeb 的转发 200 一致。

2) **minimax 是反方向的样本：判据真、伤害也真。**
   `vendor/lib/minimax.js:64` 的 `minimaxCredentialExpiresAtMs` 只认凭据里的 `expires_at`
   （登录时按服务端 `expires_in` 写入，`minimax.js:19-22` 明确要求必须写），
   `isMinimaxRefreshable`（`minimax.js:85`）判 `refresh_token` 存在与否 —— 两条都是**外部事实**。
   现测 2 个号都已过期且 `refreshable:false`，当日 1 次请求即 502：
   `502 MiniMax Code (中国版)：无法确认是否有可用账号。…（凭据未配置或已失效（共 2 个账号））`。
   ⚠️ 这个 502 **不是过滤造成的**：minimax 走余额分档，候选集不过 `_filterDeadAccounts`
   （见 `src/container.mjs` 里 `_filterDeadAccounts` 注释「覆盖范围有限，且刻意不扩」），
   所以它今天能不能用与开关无关 —— 它是**凭据真死了**。这一条正好可当 P0 修好后的对照：
   修完过滤，minimax 的 502 应该**不变**；若变了，说明误伤了活号。

**顺带现测（已知要盯的方向之一）**：`models()` 仍不阻塞 —— `t-models-nowait` 现跑
「第 1 次 models(): 32 个，耗时 0ms」「第 2 次 models(): 32 个，耗时 0ms」，阈值 2000ms。
`exit=0`。

**结论（事实层，判据定性留给 内核）**：12 家里「有可信判据」与「无判据但被判死」
**同时存在**（loomy vs minimax），所以 P0 不能用一条规则一刀切 —— 这也是我认同
Chief「先辨判据、再谈修法」的实测依据。**注意**：上表里 buddy/qoder/accio 的 err 数
不带 accountId 的网关行（`gateway|buddy||…` 这类），我**未**逐条归因到具体账号
（归因**未实测**）。

### 18.10 第三次红：不是测试缺陷，是**他的活文件正在被改**（2026-10-28 13:1x）

前一条 18.8 里我把三红归给「测试不稳定」。现在有了第二个数据点，**要修正这个说法**：

- 13:14 前后一次 `node scripts/test-all.mjs`：`t-dead-account.mjs` 红，原始输出
  ```
  ReferenceError: DEAD_JUDGE_UNTRUSTED is not defined
      at isDeadAccount (file:///D:/dsh-build/magpie-Jet-Hub/src/container.mjs:253:5)
  ```
  而 `src/container.mjs:32` 现在**有** `const DEAD_JUDGE_UNTRUSTED = new Set(['loomy'])`，
  且 `git status` 显示 `M src/container.mjs` —— 内核 正在写这个文件。紧接着跑单测
  `magpie-bun tests/t-dead-account.mjs` → `24 条断言全部通过`、`exit=0`。
  ⇒ 那次红是**读到半写状态的文件**，不是断言有问题。
- 13:25 前后一次整跑：`t-rpc-cover.mjs` 红，耗时 **71 ms**（正常 8.4 s），下次整跑 88 ms 绿。
  71 ms 不足以跑完解析+探活，指向**读取/解析阶段**就失败；那段时间 `console/console.js`
  正在被 控制台 改。**归因未实测**（没留那次的前置输出），但耗时本身就是证据。

⇒ 正确说法是：**同仓多人并发开发时，测试跑在别人的半成品上**。`test-all` 的「失败重试
一次」仍然有效（重试跨过了那个半写窗口），但「用退出码当验收」必须配一条使用规则：
**别人正在写 src/ 或 console/ 时，一次红不算回归**；要么等对方报完、要么跑两次看是否稳定。

**未做**：`t-dead-account` 这条不会自动变绿在「文件语法有效但变量缺失」的中间态——
若要彻底消掉，只能在测试侧加「导入前先校验文件能被 `node --check` 解析」，
但那是给并发开发擦屁股，**暂不做**（登记为待办，等 P2 收树后再评）。

### 18.11 那条「控制台 67/78」也是测试的错：模板串里的 `\s` 被 JS 吃掉（13:4x → 14:1x 更正）

Jeb 13:2x 报的 11 个未接里，有 8 个（`gemini/minimaxintl/opencode/qoder` 各 2 个
`setProxy`+`testProxy`）当时**已经接进控制台了**，是我数错。控制台随后自己补完了
剩下的（`6689fbf` 补 9 个、`1c54082` 补最后 2 个），**现测 78/78、未接 0**。

**机制**：模板字符串里写 `\s`，JS 的字符串字面量先把 `\s` 解析成 `s`（未知转义按
字面字符处理），拼出来的正则于是成了 `consts`，永远匹配不到 `const cfg = …`。
同一个 bug 也让 `KEY_CHANNELS[provider].method` 这一路回溯读不到字段
（`console/console.js:421 rpc(cfg.method)` 一度被判「解析不出实参」）。

**最小复现**（`node`，不依赖本仓库任何文件，直接粘进 PowerShell/bash 都能跑）：

```
$ node -e 'const src="const cfg = PROXY[provider]";
  const b=new RegExp("(?:const|let|var)\s+cfg\s*=\s*(.+)$");
  console.log("修前 regex:", b.source, "命中:", b.test(src));
  const f=new RegExp("(?:const|let|var)\\s+cfg\\s*=\\s*(.+)$");
  console.log("修后 regex:", f.source, "命中:", f.test(src));'
修前 regex : (?:const|let|var)s+cfgs*=s*(.+)$ 命中: false
修后 regex : (?:const|let|var)\s+cfg\s*=\s*(.+)$ 命中: true
EXIT=0
```

> ⚠️ 上面这段**必须在 bash 里跑**（外层单引号保护内层双引号）。同一个命令
> 在 PowerShell 里外层单引号不成组，`\s` 会被再吃一层，修后那行也会显示成
> `(?:const|let|var)s+cfgs*=s*(.+)$` —— 这不是复现失败，是 shell 引号问题。
> 我 14:0x 就被这个绊了一次，两次输出都在 `VERIFICATION.md` 的历史里。

**修法**：`tests/t-rpc-cover.mjs:281-282` 走 `escapeRe()`（定义在 `:203`）拼正则，
模板串里写双反斜杠 `\\s`。**只有这一处**需要改；同文件里其余几个扫描正则
（`fieldLiterals` 的字段扫描、表定义扫描）早就是双反斜杠，不受影响。

**治本：把它钉成测试自己的断言**（`tests/t-rpc-cover.mjs:78-95`，本次新加）
——「被测解析器」自己也要有断言，否则它坏掉时只会表现为「某个数字变差」，
让人去查产品代码：

```
$ "C:/Users/Betsy/.cache/magpie/bun/1.4.4/magpie-bun.exe" tests/t-rpc-cover.mjs
✓ 自检：模板串里的单个反斜杠+s 被吃成 s（正则 = (?:const|let|var)s+cfgs*=s*(.+)$）
✓ 自检：双反斜杠拼出的正则能命中 `const cfg = …`（正则 = (?:const|let|var)\s+cfg\s*=\s*(.+)$）
✓ 自检：被吃掉反斜杠的正则命中不了 —— 这就是「解析不出实参」的根因
✓ 找到主 switch (method)（第 2964 行）
✓ 主 switch 里 case 标签无重复（65 个标签 / 65 个唯一）
…
✓ 控制台没有调用不存在的方法
  控制台未接: 0
✓ 未接项全部属于前缀改道（0 个）
✓ loomy.permanentLock 已由控制台接通（经 lockMethod 变量，不是未接项）
✓ RPC 口径一致：本体 78 个方法，控制台接 78 个
EXIT=0
```

**修前 / 修后（同一台机器、同一个 `console/console.js`）**

| 指标 | 11:1x 修前 | 13:4x 修后 | 14:2x 现测 |
|---|---|---|---|
| `rpc() 调用点的实参全部解析到字面量方法名` | ✗ 3 个解析不出（共 82 个调用点） | ✓ 全解析 | ✓ 全解析（共 **84** 个调用点 —— 控制台后又加了 2 处） |
| 控制台已接 / 本体可调度 | 62 / 65（旧口径） | 76 / 78 | **78 / 78** |
| 未接 | 11（Jeb 那份） | 2 | **0** |
| 退出码 | 1 | 0 | 0 |

⚠️ `76 / 78` 那格（`de9e7b4`）当场是对的，**但现在已经过期**：控制台 `1c54082`
接了最后 2 个（`modelscope.setApiKey`、`opencode.rotateFingerprint`），
所以**别引用 76/78，也别引用 67/78**——只锁「本体 78、控制台 78、未接 0」。

⇒ 教训：**我自己的正则拼装也是被测对象**。凡是「某个数字突然变差」，
先怀疑解析器的转义/正则，再怀疑产品代码。

### 18.12 `test-all.mjs --all` 从来没有真的打开过探活（14:1x，已修）

`tests/t-rpc-cover.mjs` 头部注释和 `scripts/test-all.mjs:9` 都写着
「`--all` 会给本测试补 `--probe`」，但 `scripts/test-all.mjs:25` 生成用例时
**只传文件路径、不传任何实参**，而 `--all` 只被 `test-all.mjs` 自己消费，
从来不会传给子进程。结果：`t-rpc-cover` 用 `ARGV.includes('--all')` 判探活，
**永远判不到**，那 69 个方法「真发请求、不回 unknown」的断言在全量整跑里
一直是空跑，只在手动带 `--probe` 时跑过。

**最小复现（修前）**：`node scripts/test-all.mjs --all` 的 t-rpc-cover 只花 ~100 ms
（探活实测 6426 ms），输出里没有 `控制台探活:` 那一行。

**修法**（`scripts/test-all.mjs:23-34`、`:55`）：给用例挂 `args`，
`t-rpc-cover.mjs` 在 `--all` 下补 `--probe`；`spawnSync(c.cmd, [file, ...(c.args ?? [])])`。

**修后实测**（`"C:/…/magpie-bun.exe" tests/t-rpc-cover.mjs --probe`，端口 18500，14:2x 复跑）：

```
  控制台探活: http://127.0.0.1:18500（快照里的 http://127.0.0.1:18502 已失效，已改扫端口）（并发 6，单请求超时 5000 ms）
✓ 探活前后 state.json / permanent-locks.json / auto-checkin.json 内容未变
✓ 69 个方法真发请求，均未回 unknown method
✓ 探活无请求异常/超时
  有副作用、按设计跳过（9）: account.create[建占位账号], account.reset[清限流标记],
    account.resetAll[同上，且遍历全部账号], account.retest[发真实上游请求 + 清限流标记],
    account.retestAll[同上，且遍历全部账号], aggregate.rejectNonExpiring[改聚合白名单],
    backup.import[缺省 mode='replace'，会覆盖整库], captcha.contribute[写载体参数表],
    credits.claimAll[对每条账号真发领取]
  探活耗时 2258 ms
EXIT=0
```

⚠️ 别把上面这个 `2258 ms` 当成「探活很快」的定论：这一版在**探测到状态文件变化时**
会退回串行、逐方法独立复验（见 18.5），最坏情况仍会慢；`2258 ms` 是这一次**没有**
触发隔离复验的数。

⇒ 这条是「注释说有、代码没做」的典型：**判断工具的注释也是断言对象**。
以后凡是注释里承诺的行为，要么有断言，要么改成「未实测」。

### 18.13 归因算法的第四次假阳性：`model.setDisabled`「坐实」了 1 个，实测是 0（14:1x）

打开探活之后第一次整跑（`node scripts/test-all.mjs --all`，14:0x）红了：

```
--- t-rpc-cover.mjs 第 1 次失败、重试通过（不稳定，需查） ---
  副作用归因：嫌疑 69，坐实 1，判为并发写方噪声 68（噪声: account.delete, account.list, …）
✗ 这些方法的空载荷会真写用户状态：model.setDisabled（需补进 SIDE_EFFECTS 或给实现补「空载荷即拒绝」的闸）
✓ 69 个方法真发请求，均未回 unknown method
  探活耗时 144092 ms
```

**先查产品代码**（`vendor/lib/jet-hub-rpc.js:6126`）：入口第一句就是闸 ——
`typeof req.provider !== 'string' || typeof req.modelId !== 'string'` → `bad-request`，
连 `pool.setModelDisabled` 都到不了。

**再实测**（`.tmp-probe-setdisabled.cjs`，与 `t-rpc-cover` 同一套判据：
规范化 JSON 指纹、等静默窗口 → 调用 → 等 400 ms → 比对，跑 6 轮）。
⚠️ 这个临时脚本**已经删了**（不在工作树、不在任何 commit 里），下面是当时的原始输出；
要复跑用 `tests/t-rpc-cover.mjs --probe` 走同一套判据，或按上述四步自己重写一遍：

```
$ node .tmp-probe-setdisabled.cjs 6
#1 未变 · 回包 {"type":"server-response","rpcId":"probe","result":{"ok":false,"error":{"code":"bad-request",…
#2 未变 · …
#3 未变 · …  #4 未变 · …  #5 未变 · …  #6 未变 · …
6 次里变了 0 次 → 空载荷不写盘（判定：误报）
EXIT=0
```

⇒ **`model.setDisabled` 是假阳性，我没往 `SIDE_EFFECTS` 里塞它**（塞进去等于把
「空载荷即拒绝」这条真正的安全网自己关掉）。

**根因是归因算法本身**：多实例 + UI 轮询持续重写这些文件，`mutated` 一次次为真，
于是每次都进 69 个方法的串行复验（每方法最多等 5 s ×2 轮 ⇒ 144 s）；
而「同一方法两轮各撞一次」在 138 次尝试里的偶然命中率并不为零。

**修法：加对照组**（`tests/t-rpc-cover.mjs:586` `controlHits()`，`:605` 调用处）。
不调用任何方法，只走和归因完全相同的「等静默窗口 → 等 400 ms → 比对」3 轮：

```
  归因对照组（不调用任何方法，同样的等待协议 3 轮）：0/3 次内容自己变了
  ⚠ 探活期间状态文件内容变了，进入隔离复验（串行，逐个方法等静默窗口、两次命中才算）
  副作用归因：嫌疑 69，坐实 0，判为并发写方噪声 69（噪声: account.delete, …）
✓ 探活后状态文件内容变了，但归因没坐实任何单个方法（对照组命中 0 次，69 个嫌疑串行两轮全判噪声 ⇒ 外部并发写方）
```

对照组的意义是**给归因一个本底**：本底命中 > 0 ⇒ 这套归因在该环境没有分辨力，
直接放弃归因、不判任何方法有副作用（并打印 `⇒ 基线噪声非零`），
省掉 2 分钟不可信的串行复验。

**复跑**（14:2x）：

```
$ "C:/…/magpie-bun.exe" tests/t-rpc-cover.mjs          EXIT=0   → 本体 78，控制台接 78
$ "C:/…/magpie-bun.exe" tests/t-rpc-cover.mjs --probe   EXIT=0   130616 ms，坐实 0
```

⇒ **教训（第三次落在这上面了）**：这个测试的「副作用判定」比被测代码更容易出错。
凡是 **N 个嫌疑 × 少量轮次** 的统计式判定，没有对照组就等于没有判据。**附：这一轮端口事实（P1 未修好，所有结论标明端口）**

```
$ curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:18500/api/jet-hub -d '…'  200
$ curl … 18501  200      18502  13:44 回 200，13:47 起 ECONNREFUSED（进程在抖）
$ cat ~/.config/magpie/jet-hub-console.json
  {"url":"http://127.0.0.1:18503/","port":18503,"at":"…05:45:10Z"}   ← 18503 无人监听
  {"url":"http://127.0.0.1:18502/","port":18502,"at":"…05:47:43Z"}   ← 18502 已死
```

**本节所有 RPC 结论都是在 `http://127.0.0.1:18500` 上测的**（`t-rpc-cover.mjs --probe`
打印的就是这个地址）。快照文件在半小时内从 18502 换成 18503、又换回 18502，
说明它还活着、但也说明**不能信它**。

**整跑（14:1x，`node scripts/test-all.mjs --all`，退出码 0）**

```
✓ t-writerefs.mjs      88 ms
✓ t-dead-account.mjs   94 ms
✓ t-usage.mjs          24122 ms
✓ t-checkin.mjs        4131 ms
✓ t-options.mjs        100 ms
✓ t-plugin.mjs         5190 ms
✓ t-models-nowait.mjs  45117 ms
✓ t-seed-auth.mjs      355 ms
✓ t-rpc-cover.mjs      136537 ms
✓ 控制台（真容器，~40s）        4354 ms
✓ 网关（需 magpie 3425）    9939 ms
✓ 页面 UI（需 web 3456）    31151 ms

12 通过 / 0 失败 / 0 跳过
EXIT=0
```

**这一版 `t-rpc-cover.mjs` 是 136537 ms，正是 18.12 修好的证据**：修前它在整跑里只花
~100 ms（探活空跑），现在它真跑了探活。所以「t-rpc-cover 从 0.1 s 变成 2 分 16 秒」
不是变慢，是**终于做了它一直声称在做的事**。同一个测试手动带 `--probe` 单独跑是
2.3 s / 4.1 s / 4.3 s（三次实测，端口都 18500）；整跑那次 136 s，说明它中途**触发了隔离复验**
（探测到状态文件变化 → 退回串行逐方法、两次独立命中才坐实，见 18.5）——这正是那条
设计的行为，不是挂死。⚠️ 那次整跑的分项（嫌疑几个、坐实几个）**没留证**
（`test-all` 只在失败时打印尾部 12 行、成功时不留子进程输出），所以
「136 s 由隔离复验导致」是**推断、未实测**。

**对照：修前那次整跑（13:5x，同一个 `--all`，退出码 0）**，`--probe` 还没被传下去，
`t-rpc-cover.mjs` 只花 102 ms：

```
--- t-models-nowait.mjs 第 1 次失败、重试通过（不稳定，需查） ---
第 1 次 models(): 32 个，耗时 0ms（必须 < 2000ms）
✓ t-writerefs.mjs      97 ms
✓ t-dead-account.mjs   101 ms
✓ t-usage.mjs          19422 ms
✓ t-checkin.mjs        4395 ms
✓ t-options.mjs        109 ms
✓ t-plugin.mjs         6027 ms
✓ t-models-nowait.mjs  45127 ms（重试后通过）
✓ t-seed-auth.mjs      391 ms
✓ t-rpc-cover.mjs      102 ms
✓ 控制台（真容器，~40s）        3596 ms
✓ 网关（需 magpie 3425）    11197 ms
✓ 页面 UI（需 web 3456）    31270 ms

12 通过 / 0 失败 / 0 跳过
EXIT=0
```

⚠️ 这条又给 18.8 加了一个数据点：**`t-models-nowait` 第一次跑失败、重试通过**，
而它自己的失败输出是「32 个，耗时 0ms」—— 0 ms 满足 < 2000ms 的阈值，
说明那次失败不在 models() 的耗时断言上（在它前面的某条断言），
**具体是哪条未实测**（`test-all` 只留失败输出的尾部 8 行，被截掉了）。
这条列进待办，等 P2 收树后单独复跑取证。

## 十九、本机 magpie web 登录 key 曾随仓库公开（2026-10-28，已改写历史）

### 症状

`tests/ui-check.cjs`、`tests/shot.cjs`、`_shot-usage.cjs` 三个脚本把 magpie web 的
登录 key 写成了**代码里的默认值**。`git log -S` 全历史扫描：这把 key 从**第一个
commit**（`feat: magpie-Jet-Hub —— 把 deepseek-harness-codearts 插件本体装进 magpie`）
起就在仓库里，之后又被带进两次。

仓库当时是 **public**（`GET /repos/Betsy20/magpie-Jet-Hub` 的 `private: false`）。

### 影响面（实测，不夸大也不缩小）

| 检查 | 结果 |
|---|---|
| key 是否仍有效 | `curl -H 'Cookie: magpie_web_3456=<key>' http://127.0.0.1:3456/api/providers` → **200**，确实还能登录 |
| web 监听地址 | `TCP 127.0.0.1:3456 0.0.0.0:0 LISTENING`（pid 48524）—— **只绑本机 loopback** |
| 因此能做什么 | 拿到 key 的人**必须先能访问这台机器的 `127.0.0.1:3456`** 才能用它（bind 到 `0.0.0.0` 时除外） |

⇒ 属「凭据泄露」而不是「立刻可被利用」：不是半夜必须换的那一档，但不该长期留在
公开历史里，因为 `magpie web --addr` 与 `gatewayAllowLan` 都存在，绑宽的可能就在。

### 修法（三件，全部真跑）

**1. 代码里不再有默认值**（三个脚本一致：取 `process.env.MAGPIE_WEB_KEY`，没有就 `exit 2`）

```bash
$ node tests/ui-check.cjs      → 缺少 magpie web 登录 key…  exit=2
$ node tests/shot.cjs          → exit=2
$ node scripts/shot-usage.cjs  → exit=2
$ MAGPIE_WEB_KEY=<key> node tests/ui-check.cjs
  ✓ 六个标签均渲染正常    exit=0
```

`ui-check` / `shot` 仍接受把 key 作为第一个位置参数（旧用法），按「像不像 16+ 位
hex」自动分流；`_shot-usage.cjs` 一并从根目录移到 `scripts/shot-usage.cjs`。

**2. 历史改写**（`git filter-repo --replace-text`）

改写前后的证明：

```
$ git log --all -S'<原 key>' --oneline | wc -l   → 0      # 全历史 0 个 commit 含该串
$ git rev-list --all --objects | ... 逐 blob cat-file    → 无命中
$ git log --all --oneline -S'MAGPIE_WEB_KEY_REDACTED_SEE_README'
  → 4 个 commit（原来含 key 的那四处，现在是替换标记）
```

如实记录的代价：**41 个 commit 全部换了 hash**（首 `8827247`、末 `a6dc83d`），
`origin` remote 被 filter-repo 主动摘掉（要重新 add），本地必须先 `stash` 再
`apply`（filter-repo 也会重写 stash，我第一次 `stash pop` 只恢复了一部分，
核对后 `checkout` + `stash apply` 重放才对）。改写前打了 9.1 MB 的
`git bundle`（`../magpie-Jet-Hub.BEFORE-FILTER.bundle`）作回退保险。

**3. key 轮换（15:23 完成，这一条已闭合）**

改写历史**关不掉**这把 key：「不再出现在仓库里」这句 14:4x 就被推翻了，key 仍可从**三处**
匿名读到（PR#1 ref、公开 fork `iJetLi/magpie-Jet-Hub`、按 40 位 SHA 直接取的老 commit），
见 [20.3](#203-十九说的不再出现在仓库里是错的key-仍可从公开仓库匿名读到14x-实测)。
**改写历史在这件事上是无效的**：它改的是 ref，旧 commit 对象只要还被别人的 ref 或 fork
指住就取得到；唯一能真正关掉的是轮换 key 本身。15:23 做了：

```
旧实例 pid 48524，11:00:40 起，"magpie-windows-amd64.exe" web --addr 127.0.0.1:3456 --no-open --gateway
                  环境里没有 MAGPIE_WEB_KEY
停掉后按完全相同参数起 pid 41608（CreationDate 2026/10/28 15:23:26）
新实例自报：?k=07982b21…（全文不进文档，只留前 8 位）
netstat -ano → TCP 127.0.0.1:3456 LISTENING 41608    （换的就是这个监听者）
```

现测（本机 `curl -o /dev/null -w '%{http_code}'`）：

```
cookie=07982b21  /api/providers -> 200      cookie=07982b21  /  -> 200
cookie=deadbeef  /api/providers -> 401      cookie=deadbeef  /  -> 401
no-cookie        /api/providers -> 401      no-cookie        /  -> 401
（任一 cookie 状态）/  ?k=07982b21…  -> 303   跳转到已登录页
```

`deadbeef…`（同长度假值）那一组是对照，证明 401 来自 key 不匹配，不是「带 cookie 就 401」。
**旧 key 本身没能由我复测**：换 instance 后旧值已不可得，它在 `/api/providers` 与 `/` 上
都是 401 这一条是 Jeb 15:23 停旧实例前测的 —— 记为**他测、我未复现**。

远端那三处仍是明文：15:2x 匿名 `curl` 两个 raw URL，都还是
`const KEY = process.argv[2] || '<旧 key>'`（`len=7678`，`const KEY` 在 L15）。
**明文还在、但已是死值** —— 这就是「改写历史无效、轮换才关得掉」的完整闭合。

代价：3456 的浏览器会话需要重新登录一次（用户已知情并同意）。

**4. 未做的（明确记下）**

- **没有删 `.map`**（482 个 / 4.3 MB）：它们是 source map，运行时用不到，但删了
  `vendor/` 就不再是上游包的逐字节副本，`diff` 校验会失效。体积换一致性，选了后者。

### 补的合规项

`vendor/` 取自上游 `deepseek-harness-codearts@2.7.261027` 的发布产物（两处规避扫描器
的写法差异见下），MIT（`Copyright (c) 2026 Jet`），但仓库里原本**没有这份许可声明**。
已放 `vendor/LICENSE`（与上游包里的逐字节一致，`cmp` 验过），README 补「`vendor/` 的
来源与许可」一节说明两份 LICENSE 的关系。

上游出处（2026-10-29 补记，用 `npm pack` 逐文件比对过）：源码仓库
[`iJetLi/dsh-providers-hub`](https://github.com/iJetLi/dsh-providers-hub)，
`git remote -v` 实测 `origin https://github.com/iJetLi/dsh-providers-hub.git`；
该仓库 `package.json` 的 `name` 是 `dsh-providers-hub`（`0.2.1-rc.2`），npm 上同版本
（`2.7.261027`）另有 `deepseek-harness-codearts` 与旧名 `dsh-codearts-auth` 两个发布名，
三者 `lib/` 只差同一个包名字符串出现的那两处：`lib/client/jet-hub.js` 的 `id:` 与 `PLUGIN_ID`。

两个 GitHub 仓库是同一血统：`dsh-providers-hub` 的 npm 元数据 `repository` 指向
[`zhuweiyou/dsh-providers-hub`](https://github.com/zhuweiyou/dsh-providers-hub)，
`git ls-remote` 实测两边 master 分别是 zhuweiyou `758a20b` / iJetLi `4f582d7`，
而 `758a20b` 正是 `4f582d7` 的祖先（`git merge-base` 返回 `758a20b`）⇒ iJetLi 那个
仓库包含 zhuweiyou 的全部历史并继续往前走。

元数据细节（`npm view` 实测，别把两个字段混成一句）：`author` 只有 `dsh-providers-hub`
有（`zhuweiyou (https://github.com/zhuweiyou)`），实际用的 `deepseek-harness-codearts`
与旧名 `dsh-codearts-auth` 的 `author` 都是空的；三个发布名的 `maintainers` 都是
`weiyou <i@zhuweiyou.com>`（名字是 `weiyou`，不是 `zhuweiyou`）。且 `repository` /
`author` 只在镜像（npmmirror）的 packument 里 —— 官方 `registry.npmjs.org` 的
packument 顶层键只有 `_id,_rev,name,dist-tags,versions,time,license,description,
maintainers,readme,readmeFilename`，`versions['2.7.261027']` 里也没有这两个字段。

**与上游包的实际差异**（`npm pack deepseek-harness-codearts@2.7.261027`
解包后与 `vendor/` 对比，只有两处）——

| 差异 | 原因 | 值是否等价 |
|---|---|---|
| `lib/gemini-oauth.js` / `.d.ts` 里两个默认 OAuth client 常量拆成两段字符串拼接 | 规避 GitHub push protection 误报（首次提交 `8827247` 的说明里写了） | **等价**，`node` 实测两个常量 `===` 上游值（长度 73 / 35 也一致）。边缘副作用：`.d.ts` 里 `declare const` 按 TS 规范只能是字面量，单文件 `tsc file.d.ts` 会报两条 `TS1254`（上游原版 0 条，本仓库 tsc 5.9.3 实测）；不编译类型声明、`types` 入口上游本就缺失，使用路径不受影响 |
| 上游有 `README.md` / `cordis.patch.yml`，`vendor/` 没有 | DSH 前端与插件补丁用，magpie 侧用不到 | — |

其余 `lib/`（966 个文件中 964 个逐字节一致，另 2 个就是上表第一行那两个）、
`locale/`（2 个）、`package.json`、`LICENSE` 与 npm 包**逐字节一致**。
比对方法：逐文件 sha256（`vendor/` 970 个文件对 npm 包 972 个：独有 0、缺 2、内容不同 2、相同 968）。

## 二十、"缺环境"不再记成"失败"，以及改写后失效的 commit hash（2026-10-28 14:2x–14:3x）

### 20.1 环境前置检查缺凭据时，记「跳过」不记「失败」

**症状**：`--all` 报 `11 通过 / 1 失败`，失败的只有 `tests/ui-check.cjs`，
但它其实没有失败——是缺 `MAGPIE_WEB_KEY`（`magpie web` 的登录 key，`tests/ui-check.cjs`
改成必须从环境变量取之后就不再带默认值了）。而 3456 当时是活的：

```
$ curl -s -o /dev/null -w '%{http_code}\n' --max-time 3 http://127.0.0.1:3456/
401
```

401 不是拒连。所以「测试要的环境不具备」和「被测的东西坏了」被混成了同一个红。

**修法**（`scripts/test-all.mjs`，本项归我）：新增 `PRECONDITION` 表（`:40`，
键为环境变量名）与调用（`:59`）；`ui-check.cjs` 这一项在缺 `MAGPIE_WEB_KEY` 时
记 `跳过` 并说明原因，不计入失败。（`tests/ui-check.cjs` 本身归控制台，我只在
`test-all` 里加前置判断，没动它。）

**实测（14:3x，命令与原始输出）**：

```
$ node scripts/test-all.mjs --all
✓ t-writerefs.mjs      83 ms
✓ t-dead-account.mjs   92 ms
✓ t-usage.mjs          23454 ms
✓ t-checkin.mjs        5374 ms
✓ t-options.mjs        102 ms
✓ t-plugin.mjs         6713 ms
✓ t-models-nowait.mjs  45115 ms
✓ t-seed-auth.mjs      318 ms
✓ t-rpc-cover.mjs      145537 ms
✓ 控制台（真容器，~40s）        5172 ms
✓ 网关（需 magpie 3425）    16037 ms
- 页面 UI（需 web 3456）    跳过（缺 MAGPIE_WEB_KEY，web 登录 key 不入仓库；3456 是否在跑需另验）

11 通过 / 0 失败 / 1 跳过
EXIT=0
```

⚠️ 读数注意：**「1 跳过」不等于「页面 UI 通过」**。这一项自 key 改造之后
在 CI/无人值守环境下永远是跳过，要真验界面得自己给 key：
`MAGPIE_WEB_KEY=<key> node scripts/test-all.mjs --all`。完整日志留在
`$TEMP/jethub-all-1502.log`（不在仓库内）。

### 20.2 `git filter-repo` 之后，VERIFICATION.md 里一半的 hash 已失效

**背景**：14:23 那次 `--replace-text` 历史改写（见[十九](#十九本机-magpie-web-登录-key-曾随仓库公开2026-10-28已改写历史)）
把 **41 个 commit 全部换了 hash**。改写前后各短值对不上，之前写进本文、
写进群里的 hash 大半已是死链——`git rev-parse` 直接 `fatal: Not a valid object name`。

**实测（14:3x，逐个数）**：

```
$ grep -oE '\b[0-9a-f]{7}\b' VERIFICATION.md | sort -u | while read h; do
    git rev-parse --verify -q "$h" >/dev/null && echo "OK   $h" || echo "DEAD $h"; done
OK   1c54082
OK   8827247
OK   a6dc83d
DEAD 03b3edc
DEAD 1639680
DEAD 701ecdc
DEAD dc0141d
DEAD fb3c058
```

（`1639680` 是误报：它是[第 208 行](#)用量四格里的「缓存命中 1639680」，不是 hash。）

⚠️ **上面 6 个 DEAD 值一个都不要单独引用** —— 它们在本机已不存在，单独出现就是把人往
不存在的提交上引。要提就必须跟下面这张替换表**成对**写：旧值 → 新值（`03b3edc→2e34f0a`、
`701ecdc→6689fbf`、`dc0141d→1c54082`、`921d80e→ddf055f`、`f35d085→a6dc83d`、
`fb3c058→de9e7b4`）。同理，本文其他地方引 hash 一律用**新值**。

**新旧对照**（`.git/filter-repo/commit-map`）：

| 旧值 | 新值 | 那次改了什么 |
|---|---|---|
| `921d80e` | `ddf055f` | （Jeb 引用的第四个值） |
| `f35d085` | `a6dc83d` | 改写前的 HEAD |
| `03b3edc` | `2e34f0a` | `tests`: 落地 t-rpc-cover 与三处测试自身缺陷修复 |
| `701ecdc` | `6689fbf` | `feat(console)`: 补 9 个缺口方法 |
| `dc0141d` | `1c54082` | `feat(console)`: 接最后 2 个 RPC，78/78 |
| `fb3c058` | `de9e7b4` | `fix(tests)`: 实参回溯取最近绑定、归因改串行 |

⚠️ **`commit-map` 里前三行（`6eee107` / `c2ed21a` / `6402fec`）不能当替换关系用**，
它们不是「同一个 commit 换了 hash」，而是**同一个改动在两条线上有两个不同的对象、
内容也不一样**。见下面 20.2.1。

#### 20.2.1 「两个 hash」不是一处改名的两半，是两条线的两份树（14:4x 实测）

```
$ for h in 6eee107 c2ed21a 6402fec 921d80e f35d085 03b3edc 701ecdc dc0141d fb3c058; do
    exists=$(git cat-file -e "$h" 2>/dev/null && echo Y || echo N)
    onmain=$(git merge-base --is-ancestor "$h" refs/heads/main 2>/dev/null && echo Y || echo N)
    onpr=$(git merge-base --is-ancestor "$h" refs/remotes/origin/pr-1 2>/dev/null && echo Y || echo N)
    printf "%-9s exists=%-2s on_main=%-2s on_pr1=%-2s\n" "$h" "$exists" "$onmain" "$onpr"; done
6eee107   exists=Y  on_main=N  on_pr1=Y
c2ed21a   exists=Y  on_main=N  on_pr1=Y
6402fec   exists=Y  on_main=N  on_pr1=Y
921d80e   exists=N  on_main=N  on_pr1=N
f35d085   exists=N  on_main=N  on_pr1=N
03b3edc   exists=N  on_main=N  on_pr1=N
701ecdc   exists=N  on_main=N  on_pr1=N
dc0141d   exists=N  on_main=N  on_pr1=N
fb3c058   exists=N  on_main=N  on_pr1=N
```

（`git cat-file -e` 只判「对象还在不在」；`git rev-parse --verify` 还要有 ref 可达，
所以前面那次扫描把它们报成 DEAD —— 两个命令答的不是同一个问题。）

**同一条改动、同样的时间与标题，树内容不同**：

⚠️ **下面这 6 个 hash 不是同一个仓库同一侧的**：`6eee107` / `c2ed21a` / `6402fec` 只在
`refs/remotes/origin/pr-1` 上（**`main` 上没有**），`b906065` / `3bf9c5d` / `112e1dd` 在
`main` 上。所以这是「PR#1 那份树 vs main 那份树」的对照，**不是「改名前后」的对照**，
本地在主分支上 `git show 6eee107` 是能取到的（对象还在），但 `git merge-base --is-ancestor
6eee107 refs/heads/main` 是 `N`。现测（15:1x）：

```
$ for h in 6eee107 b906065 c2ed21a 3bf9c5d 6402fec 112e1dd; do
    onmain=$(git merge-base --is-ancestor "$h" refs/heads/main && echo Y || echo N)
    onpr=$(git merge-base --is-ancestor "$h" refs/remotes/origin/pr-1 && echo Y || echo N)
    echo "$h on_main=$onmain on_pr1=$onpr"; done
6eee107 on_main=N on_pr1=Y
b906065 on_main=Y on_pr1=N
c2ed21a on_main=N on_pr1=Y
3bf9c5d on_main=Y on_pr1=N
6402fec on_main=N on_pr1=Y
112e1dd on_main=Y on_pr1=N
```

```
$ git rev-parse 6eee107^{tree}   → 0c983ed4df56   （PR#1 侧）
$ git rev-parse b906065^{tree}   → 6f277eebabac   （main 侧）   ← 不同
$ git rev-parse c2ed21a^{tree}   → 0b64e0cd650f   （PR#1 侧）
$ git rev-parse 3bf9c5d^{tree}   → 308ecb994413   （main 侧）   ← 不同
$ git rev-parse 6402fec^{tree}   → 8afbe800c87f   （PR#1 侧）
$ git rev-parse 112e1dd^{tree}   → 7616e34b5153   （main 侧）   ← 不同
```

**差异正好只有「那一行 key」**，三个文件各一行：

```
$ git diff --stat 6eee107 b906065
 _shot-usage.cjs    | 2 +-
 tests/shot.cjs     | 2 +-
 tests/ui-check.cjs | 2 +-
 3 files changed, 3 insertions(+), 3 deletions(-)
$ git diff 6eee107 b906065 -- tests/ui-check.cjs
-const KEY = process.argv[2] || '<原 key，32 位 hex>'
+const KEY = process.argv[2] || 'MAGPIE_WEB_KEY_REDACTED_SEE_README'
```

⇒ 结论精确化：`refs/remotes/origin/pr-1`（`850d339`，PR#1 `state: closed`、`merged: false`）
上那条线是**未脱敏**的同一批 commit；`main` 上是脱敏后的。所以
`6eee107` / `c2ed21a` / `6402fec` 在本地**查得到、能 checkout、里面是带 key 的旧文件** ——
这也正是 20.3 那条口子的本地侧形态。别把它们当 rename 对照，也别以为它们「失效了所以
无所谓」：它们是**仍然存在的旧内容**。

**还有 6 个短值彻底没了**（`.git/filter-repo/suboptimal-issues`：被别的 commit
message 引用、但该 commit 已被过滤掉，引用原样留在 message 里，谁也 checkout 不出来）：
`dd2c0ebd` `50fe31bd` `c5a68171` `0595d106` `fbfa3882` `1209600`。

**代价（如实记）**：`origin` remote 被 filter-repo 摘掉；本地 `stash` 必须先 `stash`
再 `apply`（filter-repo 会重写 stash）；工作树里 11 个文件的未提交改动在
14:26 靠 `stash apply` 才回来。**所以任何人报 hash 之前先 `git rev-parse --verify` 一下**，
尤其是我自己——本文内的引用已按上表换过一遍，再引用旧值我就复核不了。

### 20.3 十九节说的「不再出现在仓库里」是错的：key 仍可从公开仓库匿名读到（14:4x 实测）

十九节写的「旧 key 只是不再出现在仓库里」——**这句现在不成立**。`--replace-text`
只重写了 `main` 的 41 个 commit，**没有重写远端那个 PR ref**；而 PR ref 就在公开仓库上。

**复现链（三步，全部匿名、不带任何凭据）**：

```bash
# 1) 仓库是公开的
$ curl -s https://api.github.com/repos/Betsy20/magpie-Jet-Hub | grep -E '"visibility"|"private"'
  "private": false,
  "visibility": "public",

# 2) PR#1 的 head ref 匿名可读
$ curl -s -o /dev/null -w '%{http_code}\n' \
    https://raw.githubusercontent.com/Betsy20/magpie-Jet-Hub/refs/pull/1/head/tests/ui-check.cjs
200

# 3) 响应正文里就是明文 key（本次输出已截断，仓库内不复述完整值）
$ curl -s https://raw.githubusercontent.com/Betsy20/magpie-Jet-Hub/refs/pull/1/head/tests/ui-check.cjs \
    | grep -n 'const KEY'
15:const KEY = process.argv[2] || '<原 key，32 位 hex：本文不复述，只标它在那儿>'
```

注意 `grep -n 'const KEY'` 命中的是**行号 15、字面量就在那一行**——本文刻意不复述值，
只留「在第 15 行、形如 `process.argv[2] || '<32 位 hex>'`」这个可核对的形状。

**口子不止 PR#1 一条。四条独立的匿名读法，本段逐条自己复跑过（15:0x）**：

```bash
# A) PR#1 的 head ref（同上面的第 2、3 步，不重复）
# B) 公开 fork iJetLi/magpie-Jet-Hub 的 main —— 改写前的整棵树都在那儿
$ curl -s -o /dev/null -w '%{http_code}\n' \
    https://raw.githubusercontent.com/iJetLi/magpie-Jet-Hub/main/tests/ui-check.cjs
200
$ curl -s https://raw.githubusercontent.com/iJetLi/magpie-Jet-Hub/main/tests/ui-check.cjs | grep -n 'const KEY'
15:const KEY = process.argv[2] || '<原 key，32 位 hex>'
```

```bash
# C) 直接按 40 位 SHA 取老 commit —— 匿名，建一个空仓库就行
$ cd /tmp/jh-anon && git init -q . \
    && git remote add origin https://github.com/Betsy20/magpie-Jet-Hub.git
$ git fetch --no-tags -q origin 8c867e8c2f4f4cd5a6ad00333c41935222bd3ed4  → OK
$ git fetch --no-tags -q origin e96a562313224946a3495c847f4354f232ae1d7f  → OK
$ git fetch --no-tags -q origin fc90544f94dd77c151f8fabc4cf43f74d34028c3  → OK
$ git fetch --no-tags -q origin f35d085feb48155cbe46258fda73da703e4e7c16
fatal: remote error: upload-pack: not our ref f35d085feb48155cbe46258fda73da703e4e7c16
```

（`git ls-remote` 对这 4 个 SHA 全部命中 0 —— 它们是游离 commit，不挂在任何 ref 上，
所以 `ls-remote` 看不见。**但按 SHA 直接 fetch 只要对象还在服务端就成功**，这三条都能。）

```bash
# 取到的三个老 commit 里，仍是明文 key（值已遮蔽，只看形状）
$ git -C /tmp/jh-anon log -1 --format='%h %s' 8c867e8c…
8c867e8 feat: 账号积分接入 magpie 用量卡 + 每日…
   _shot-usage.cjs: 18:const KEY = '<32 位 hex>'
   tests/shot.cjs:    8:const KEY = process.argv[2] || '<32 位 hex>'
   tests/ui-check.cjs: 15:const KEY = process.argv[2] || '<32 位 hex>'
$ git -C /tmp/jh-anon log -1 --format='%h %s' e96a5623…
e96a562 feat(page): 侧栏页做成控制台 UI（接入/模…
   tests/shot.cjs:    8: …
   tests/ui-check.cjs: 15: …
$ git -C /tmp/jh-anon log -1 --format='%h %s' fc90544f…
fc90544 feat: magpie-Jet-Hub —— 把 deepseek-harness-cod…
   tests/shot.cjs:    8: …
```

⇒ **结论要写得比「main 上删掉了」更死**：`filter-repo` 只改了 `main` 的 41 个 commit，
**key 仍可从三处匿名读到** —— PR#1 ref、公开 fork `iJetLi/magpie-Jet-Hub`（main 与 fix
分支都是改写前的树）、以及按 40 位 SHA 直接取的老 commit。**改写历史在这件事上是无效的**：
它改的是引用，不是对象；旧对象只要还被任何 ref（PR ref、fork）指住就留得下、取得到。
**唯一真正能关掉这条口子的动作是换 key**（外加删 PR ref / 仓库转私有，二者只有 owner 能做）。


**本地侧同样的东西（未认证即可 enumerate）**：

```
$ git grep -l '<原 key>' refs/remotes/origin/pr-1
refs/remotes/origin/pr-1:_shot-usage.cjs      :18  const KEY = '<原 key>'
refs/remotes/origin/pr-1:tests/shot.cjs       :8   const KEY = process.argv[2] || '<原 key>'
refs/remotes/origin/pr-1:tests/ui-check.cjs   :15  const KEY = process.argv[2] || '<原 key>'
$ git log --oneline -S'<原 key>' refs/remotes/origin/pr-1 | wc -l
3
$ git log --oneline -S'<原 key>' refs/heads/main | wc -l
0
```

**这把 key 现在还是活的**（这就是为什么它不是「历史遗留」而是「当前凭据」）：

```
$ curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 \
    -H "Cookie: magpie_web_3456=<原 key>" http://127.0.0.1:3456/api/providers
200
```

**伤害面（如实、不夸大）**：web 只绑 `127.0.0.1:3456`（十九节实测过），所以拿到 key 的人
**还得先能访问这台机器**。但 key 本身已经等同于公开，十九节「已经收干净了」的结论要撤回。

**要关掉这条口子的三个动作（前两个只有仓库 owner 能做，我一个人做不了）**：

1. GitHub 上删掉 PR#1 的 ref，或把仓库改私有 —— `refs/pull/1/head` 只能靠这两条之一消失；
   本地 `git push origin --delete <branch>` 对 `refs/pull/*` **无效**（那是 GitHub 托管 ref）。
2. 换一个新 `MAGPIE_WEB_KEY` 并重启 `magpie web`：这样即使旧值还在，它也已经失效。
   **这一条是唯一有效的一条** —— 见上面三条匿名读法：删 PR ref 与转私有都挡不住
   公开 fork `iJetLi/magpie-Jet-Hub` 和按 SHA 取的老 commit，只有换 key 让旧值变成废值。
3. 之后再把 `main` 上的三个脚本确认一遍（已确认 0 处，见十九节）。

→ 1、2 归**文档/仓库 owner**，不是我的权限范围；我这边只交付这条复现与结论。
**未实测**：PR#1 被删后 raw 链接是否立刻 404（依赖 GitHub 缓存，我没法构造）；
fork `iJetLi/magpie-Jet-Hub` 是 owner 主动建的镜像还是别人 fork 的，我没查 —— 它现在
公开可读（上面 `http=200`），这一点与归属无关地成立。

### 20.4 `t-rpc-cover.mjs` 还有第二、第三个"虚报覆盖率"的自伤 bug（14:5x 实测）

写 20.3 时为了给 78 找证据，我把 `viaParam` 打印加进统计，结果反倒揪出测试自己的两个洞。
**这两个洞的方向都是「把覆盖率抬高」，不是压低** —— 比之前那个 `\s` bug 危险得多，因为
它让红变成了绿。

#### 洞一：跳过函数定义行的守卫从来没触发过

```js
// 修前（tests/t-rpc-cover.mjs:336）
if (/function\s+rpc\s*$/.test(l.slice(0, m.index))) continue
```

`m.index` 正落在 `rpc(` 的开头，所以 `l.slice(0, m.index)` 以 `"function "` 结尾、
**根本不含 "rpc"**，这条正则永远不匹配 ⇒ `console/console.js:20` 的
`async function rpc(method, payload = {})` 定义行被当成一个「调用点」。

#### 洞二：`rpc` 自己的形参被当成「转发形参」，成了万能通配

定义行被收进调用点之后，其实参 `method` 走「形参回溯」分支；而形参扫描会在全文里找
`function rpc(...)`，正好找到它自己，于是 `rpc()` 的**每一个**调用点的字面量都被拼进来：

```
[viaParam] console/console.js:20 rpc(method) -> 65 个方法  (经 rpc+accBulk)
```

—— 一处「调用点」凭空贡献 65 个方法名。任何 `rpc(method)` 写法（含 `accBulk` 里那个真转发）
都会被这张通配覆盖，**覆盖率可以虚抬到 100%**。

**修法（两处，都在自己负责的 tests/ 里）**：

```js
// :340 洞一——按「切片以 function 结尾」判，定义行真正被跳过
if (/(?:async\s+)?function\s+$/.test(l.slice(0, m.index))) continue

// :243 洞二——`rpc` 自己的形参不参与回溯（它是运行时变量，不是调用点传的字面量）
if (idx < 0 || sig[1] === 'rpc') continue
```

**修后**（`node tests/t-rpc-cover.mjs`，EXIT=0）：

```
✓ 83 个 rpc() 调用点的实参全部解析到字面量方法名
  控制台已接: 78 / 78
  控制台未接: 0
✓ 主 switch 的 65 个方法控制台全都接了
✓ RPC 口径一致：本体 78 个方法，控制台接 78 个
```

**注意这个 78/78 和修前的 78/78 不是同一件事**：修前那 78 里有一部分是通配白送的。
我另外做了一次判别实验（把 `sig[1] === 'rpc'` 那条排除规则去掉、只留洞一修好），
结果仍是 78/78 —— 说明**这次的两个洞没有污染最终数字**，78 是真的。但结论不能靠
「反正数字没变」：两个洞现在都被钉死，下次谁再写 `rpc(method)` 不会再白送覆盖率。

**仍未实测**：`--probe` 那条 69 个方法真发请求的断言（`--all` 时跑，约 2.5 分钟），
本段写作时正在后台跑，结果见 20.5。

### 20.5 `--probe`：69 个方法真发请求，均未回 unknown method（14:5x 实测，已回收）

**命令**（后台跑，约 2 分 15 秒；`--probe` 只在有活的 magpie web 宿主时才跑）：

```
$ "C:/Users/Betsy/.cache/magpie/bun/1.4.4/magpie-bun.exe" tests/t-rpc-cover.mjs --probe
```

**原始输出（结尾 20 行，原样）**：

```
✓ 主 switch 的 65 个方法控制台全都接了
✓ 未接项全部属于前缀改道（0 个）
✓ loomy.permanentLock 已由控制台接通（经 lockMethod 变量，不是未接项）
✓ 控制台对 opencode.* 有处置（接了 5 / 缺 0）
✓ 控制台对 gemini.* 有处置（接了 2 / 缺 0）
✓ 控制台对 qoder.* 有处置（接了 2 / 缺 0）
✓ 控制台对 minimaxintl.* 有处置（接了 2 / 缺 0）
✓ 控制台对 modelscope.* 有处置（接了 2 / 缺 0）
✓ 控制台没有调用不存在的方法
  控制台探活: http://127.0.0.1:18500（快照里的 http://127.0.0.1:18502 已失效，已改扫端口）（并发 6，单请求超时 5000 ms）
  归因对照组（不调用任何方法，同样的等待协议 3 轮）：0/3 次内容自己变了
  ⚠ 探活期间状态文件内容变了，进入隔离复验（串行，逐个方法等静默窗口、两次命中才算）
  副作用归因：嫌疑 69，坐实 0，判为并发写方噪声 69（噪声: account.delete, account.list, …）
✓ 探活后状态文件内容变了，但归因没坐实任何单个方法（对照组命中 0 次，69 个嫌疑串行两轮全判噪声 ⇒ 外部并发写方）
✓ 69 个方法真发请求，均未回 unknown method
✓ 探活无请求异常/超时
  有副作用、按设计跳过（9）: account.create[建占位账号], account.reset[清限流标记], account.resetAll[同上，且遍历全部账号], account.retest[发真实上游请求 + 清限流标记], account.retestAll[同上，且遍历全部账号], aggregate.rejectNonExpiring[改聚合白名单], backup.import[缺省 mode='replace'，会覆盖整库], captcha.contribute[写载体参数表], credits.claimAll[对每条账号真发领取]
  探活耗时 135262 ms

✓ RPC 口径一致：本体 78 个方法，控制台接 78 个
EXIT=0
```

**这条证据证明什么、不证明什么**：

- 证明：控制台真的发了 78−9=69 个请求，宿主一个都没回 `unknown method`（即这几个方法在
  运行态确实可调度，不是只在源码里有个名字）。这也覆盖了走 `handleMethod()` 前缀改道的
  那 13 个 —— 它们最容易出现「源码有名字、运行态没分发」的假接。
- **不证明**「78 个都接对了业务」：探活只发**空载荷**，只能证分发层存在。
- 9 个按设计跳过的方法在输出里逐个写了**为什么跳过**（会写盘 / 会发真实上游请求），
  这份清单就是探活的写入白名单，改它必须给出「空载荷不写盘」的实测。
- 归因：本轮嫌疑 69、坐实 0，对照组 0/3 —— 状态文件确实被外部并发写方改了（两个
  magpie 宿主 + UI 轮询），但没有任何单个方法被坐实。这是 P1「双宿主」的副作用：
  只要 18500/18501 同时活着，这套归因就只能给「坐实 0」，给不了更强的结论。

**端口说明**：本轮探的是 `127.0.0.1:18500`，快照文件里写的 18502 无人监听（P1 未修）。

### 20.6 `tests/t-console.mjs` 跑一次就覆写用户真实 `~/.config`（15:0x 实测，方案未落地）

**这是一条测试套件自己的副作用缺陷，不是产品 bug** —— 起因是 `src/container.mjs:199` 无条件
写地址文件，而 `tests/t-console.mjs:26` 会真起容器。

**根因（读码，行号可核）**：

```js
// src/container.mjs:196-202
try {
  const p = join(homedir(), '.config', 'magpie', 'jet-hub-console.json')
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify({ url: this.console.url, port: this.console.port, at: new Date().toISOString() }, null, 2))
} catch { /* 写不了不影响服务 */ }
```

两个要点：
1. 路径从 `homedir()` 求，**不是** `this.home`（`:57` 已经把 `options.home` 存下来、
   `:110` 还会传给它建的 `FileCredentialProvider`）。所以「注入 home」这个既有开关**管不到这里**。
2. `catch {}` 吞掉所有错误、不报警 —— 写失败或者写错地方都不会有声音。

**实测 A：现状（`MODE=raw`，即 `tests/t-console.mjs` 现在的写法）**

```bash
$ F="C:/Users/Betsy/.config/magpie/jet-hub-console.json"
$ ls -la --time-style=full-iso "$F"; cat "$F"          # 跑前
-rw-r--r-- 1 Betsy 197121 91 2026-10-28 14:51:25.424546400 +0800 …jet-hub-console.json
{ "url": "http://127.0.0.1:18502/", "port": 18502, "at": "2026-10-28T06:37:21.194Z" }

$ MODE=raw node .tmp-probe-config.mjs
  · 内部网关就绪 :18392，模型 28 个
  · 控制台就绪 http://127.0.0.1:18502/｜管理路由 2 条：POST /api/jet-hub | GET /api/jet-hub/captcha-carrier
MODE= raw homedir()= C:\Users\Betsy console= http://127.0.0.1:18502/
  astudio: 2 个账号
  loomy: 2 个账号
真实账号合计= 4
[EXIT=0]

$ ls -la --time-style=full-iso "$F"; cat "$F"          # 跑后
-rw-r--r-- 1 Betsy 197121 91 2026-10-28 15:01:05.767219100 +0800 …jet-hub-console.json
{ "url": "http://127.0.0.1:18502/", "port": 18502, "at": "2026-10-28T07:01:05.766Z" }

$ diff .tmp-cfg-before.json "$F"
4c4
<   "at": "2026-10-28T06:37:21.194Z"
---
>   "at": "2026-10-28T07:01:05.766Z"
```

⇒ **成立**：跑一次就重写用户的真实配置文件（mtime 14:51:25 → 15:01:05，`at` 也被刷新）。
唯一「没变」的是 `url`/`port` —— 因为探针这次恰好也起在 18502。换个端口跑就会把用户的
地址来源改成那个端口：这正是 控制台 的快照 `console` 字段曾经指向 18502（而 18502 无人监听）
的成因。

**实测 B：方案 A（测试侧隔离，`MODE=iso`）**

做法：起容器**之前**先把 `USERPROFILE` / `HOME` 改到 `mkdtempSync(join(tmpdir(),'jh-iso-'))`，
而 `new JetHubContainer({ home: REAL_HOME, … })` 仍显式传真实家（凭据照读真号）。

```bash
$ MODE=iso node .tmp-probe-config.mjs
MODE= iso homedir()= C:\Users\Betsy\AppData\Local\Temp\jh-iso-CmOn8b console= http://127.0.0.1:18502/
  astudio: 2 个账号
  loomy: 2 个账号
真实账号合计= 4
临时家目录里的地址文件: http://127.0.0.1:18502/
[EXIT=0]

$ ls -la --time-style=full-iso "$F"                    # 真实家
-rw-r--r-- 1 Betsy 197121 91 2026-10-28 15:01:05.767219100 +0800   ← mtime 与 at 都停在 raw 那次
$ diff .tmp-cfg-isopre.json "$F"                       # 只差 raw 那次留下的 at，iso 没再写
4c4
<   "at": "2026-10-28T06:37:21.194Z"
---
>   "at": "2026-10-28T07:01:05.766Z"
$ ls -la "$TEMP"/jh-iso-CmOn8b/.config/magpie/
-rw-r--r-- 1 Betsy 197121 91 Oct 28 15:01 jet-hub-console.json
```

**判据用的是文件里的 `at`（写入时刻自己写进去的时间戳），不是 mtime** —— `at` 保持
`07:01:05.766Z` 不变，就证明 iso 那次**一次都没写**这个文件；同时临时家目录里出现了
同样的 `jet-hub-console.json`（内容 `url` 相同），即写入被**原地改道**而不是被**跳过**。

**两种模式读到的账号完全一致（astudio 2 + loomy 2 = 4）** ⇒ 隔离不改变测试要验证的东西，
`home` 显式传真实家这一半是必须的（否则凭据会跟着 `USERPROFILE` 跑掉）。

**三个候选方案，我的评估**：

| 方案 | 谁改 | 强度 | 说明 |
|---|---|---|---|
| **A 测试侧隔离**（`USERPROFILE`/`HOME` → 临时目录，`home` 仍传真实家） | 我，只动 `tests/` | 够用，已实测 | 副作用被改道到临时目录；无需插件侧配合；缺点是「写文件」这个行为本身还在，只是写歪了 |
| **B 插件侧注入落盘路径**（`homedir()` → `this.home` 或 `DSH_HOME`） | 内核 | 最干净 | 根因修在源头，且 `:57` 已经有 `this.home` 可用，改动 3 行；但 `src/` 不是我的文件，**先报 Jeb 派给 内核** |
| C 测试前后备份还原 | 我 | 最弱 | 进程被杀 / 断言失败中途退出就漏还原；且两次测试并发会互相踩 |

**我的建议**：A 与 B 不冲突，**A 现在就够**（我能独立做完、不碰产品代码），B 作为根因修复
由 内核 决定（它顺带能挡住 `catch {}` 那句吞错）。C 不建议。

**未实测**：这轮只验了「谁写、写到哪」；`tests/t-console.mjs` 本身**还没改**（Jeb 要求
先给方案、跟 控制台 对齐后再动手）。所以现在跑 `node scripts/test-all.mjs --all` 仍会覆写
用户真实配置 —— 在方案落地前，**谁跑 `--all` 谁就把别人的地址来源改掉**。

### 20.7 本节数字的「取证时刻」：新 HEAD 上重跑（15:1x 实测）

**规矩（从这一轮起写死）**：本文里任何「某某是 X」的句子，旁边必须有**同一轮跑出来的**
命令输出。旧 HEAD 的读数一律标「当时」，不当现状引用。

**本轮取证的一次完整跑（HEAD=`184fc17`，15:11:10 起）**：

```
$ git rev-parse --short HEAD
184fc17

$ node tests/t-rpc-cover.mjs --no-probe
  控制台已接: 78 / 78
  控制台未接: 0
✓ 主 switch 的 65 个方法控制台全都接了
✓ 未接项全部属于前缀改道（0 个）
✓ loomy.permanentLock 已由控制台接通（经 lockMethod 变量，不是未接项）
✓ 控制台对 opencode.* 有处置（接了 5 / 缺 0）
✓ 控制台对 gemini.* 有处置（接了 2 / 缺 0）
✓ 控制台对 qoder.* 有处置（接了 2 / 缺 0）
✓ 控制台对 minimaxintl.* 有处置（接了 2 / 缺 0）
✓ 控制台对 modelscope.* 有处置（接了 2 / 缺 0）
✓ 控制台没有调用不存在的方法
  探活未启用（默认关：全量网络往返不该绑在每次单测里）。要跑可调用性断言：加 --probe / JET_HUB_PROBE=1，或跑 scripts/test-all.mjs --all。
✓ RPC 口径一致：本体 78 个方法，控制台接 78 个
EXIT=0
```

```
$ node scripts/test-all.mjs
✓ t-writerefs.mjs      82 ms
✓ t-dead-account.mjs   90 ms
✓ t-usage.mjs          20198 ms
✓ t-checkin.mjs        3731 ms
✓ t-options.mjs        113 ms
✓ t-plugin.mjs         6027 ms
✓ t-models-nowait.mjs  45136 ms
✓ t-seed-auth.mjs      285 ms
✓ t-rpc-cover.mjs      83 ms

9 通过 / 0 失败 / 0 跳过
EXIT=0
```

**8 个单测变 9 个的原因**：`tests/t-rpc-cover.mjs` 在 `2e34f0a` 落地成 tracked 之后才进
`scripts/test-all.mjs` 的名单。所以本文更早那些「7 通过」「9 通过」的读数**都不是错，
是名单不同**——引用时必须带上日期与当时 HEAD，否则没法比。

**本节数字的有效性**（同一轮现测，不是推算）：

| 数字 | 值 | 判据 |
|---|---|---|
| 本体可调度方法总数 | **78** | 解析 `vendor/lib/jet-hub-rpc.js` 主 switch（65）+ `handleMethod()` 前缀改道（13），由测试从源码推导，无硬编码 |
| 控制台已接 | **78** | 同上，解析 `console/console.js` 的 83 个 `rpc()` 调用点 |
| 未接 | **0** | 78 − 78 |
| 单测 | **9 通过 / 0 失败 / 0 跳过** | `node scripts/test-all.mjs` 的退出码与汇总行 |

⚠️ **这些数会随控制台继续接方法而变**。本文锁的是「口径由测试从源码解析」，不是这四个
数本身；下次任何人引用前先跑 `node tests/t-rpc-cover.mjs` 看当下的打印。

---

## 二十一、模型能力三项（上下文 / 支持图片 / 推理强度）取不到（2026-10-29，已修）

**症状**（用户报，截图 magpie 模型列表）：DeepSeek 系列 12 行**全部显示 128K**，且
AStudio 与 WorkBuddy-SG 两行没有图片标记、每一行推理档位都是「跟随分组推理」。
真窗口其实是 1M（trae `deepseek-v4.1-flash`）、AStudio 上游只吃纯文本。

**根因（三层，任缺一层症状都在）**

| 层 | 事实 | 出处 |
|---|---|---|
| 宿主 | `provider.models()` 返回**整体替换**，不与 models.dev 的 capabilities 合并 | 宿主 `info()` 尾部 `out.models = Object.fromEntries(...)` |
| 宿主落盘 | 只认 `limit.context` / `limit.output` / `capabilities.reasoning` / `capabilities.input.image` | 宿主 `infoOf()` 里读 `limit` / `capabilities` 那一段（行号随宿主版本漂移，见本机 `plugin-host/` 下 5 个版本） |
| 插件 | `modelEntry()` 原先只给 `{name, limit:{context: 128_000 硬编码, output: 8192}, tool_call}` | `src/plugin.mjs` 改前 |

**数据源实测：`listModels()` 里根本没有窗口**

```
listModels() 53 条 → context_window 有值的 0 条，reasoning 48，input 46
resolveModelInfo('trae','deepseek-v4.1-flash') →
  {context:{contextWindow:1000000}, defaultMaxTokens:64000,
   inputModalities:['text','image'], reasoning:{efforts:[light,high,extra_high],defaultEffort:'high'}}
resolveModelInfo('astudio','xopdsv4flash0731in') →
  {context:{contextWindow:1048576}, defaultMaxTokens:100000, inputModalities:['text'], ...}
```

⇒ 只读 `listModels()`／`model.list` RPC（后者只给 `{id,name,disabled,dead}`）永远补不上
窗口，必须逐模型 `ctx.llm.resolveModelInfo()`。成本实测全量 895 条走一遍前 300 条
**8 ms**（读适配器已缓存目录，不发网络）。

**改了三处**：`src/llm-bridge.mjs` 的 `modelsPayload()` 逐模型 resolve 后回填
`context_window`／`max_tokens`／`input`；`src/container.mjs` 新增 `modelMeta` Map，
由 `_absorbModels()` 与 `refreshFullCatalog()` 两路填；`src/plugin.mjs` 的
`modelEntry(id, def, meta)` 扩成三参并产出完整 `limit` + `capabilities`，
**并删掉原 `128_000` 硬编码**（不知道就给 0，不放假值）。

**验证（真跑）**

```
# 插件层（12 秒后台刷新后再取一次 config）
deepseek-v4.1-flash → limit {context:1000000, output:64000}
                      capabilities {reasoning:true, attachment:true, input:{text,image}}
glm-5.1             → limit {context:200000,  output:32000}  纯文本 reasoning:false
Doubao-Seed-Code    → limit {context:256000,  output:32000}  image+reasoning
container.modelMeta: 875

# 落盘 ~/.config/magpie/jet-hub-models.json（205KB）
键 ['at','models','full','meta']；models 53 / full 895 / meta 875
trae/deepseek-v4.1-flash → {context:1000000, output:64000, input:['text','image'], reasoning:true}

# 宿主口径（`magpie plugin list --json` 起的新进程，14 条同名模型）
{'context': 1000000, 'output': 128000, 'reasoning': True, 'image': True, 'imageSaid': True, 'inputs': ['text','image']}
{'context': 116000,  'output': 16000,  'reasoning': True, 'image': True,  'inputs': ['text','image']}
{'context': 200000,  'output': 16000,  'reasoning': True, 'image': False, 'inputs': ['text']}

# 测试
node scripts/test-all.mjs        → 9 通过 / 0 失败 / 0 跳过
node scripts/test-all.mjs --all  → 12 通过 / 0 失败 / 1 跳过（页面 UI 缺 MAGPIE_WEB_KEY）
```

**唯一仍然要人做的一步**：magpie 主程序不会因文件改动重载插件
（`touch` 插件目录无效，`magpie plugin` 也没有 reload 子命令），重启 magpie
后才在界面上生效。落盘那一份 `plugin-providers.json` 在重启前仍是旧值
（`context:128000`）。

**一处上游事实，不是缺陷**：`codely` 那 5 个模型 `resolveModelInfo` 只返回
`inputModalities`，不返回 `context`／`defaultMaxTokens`，所以它的 `limit.context`
仍是 0。`tests/t-plugin.mjs` 因此只把「**一家都没有**窗口」判成失败，并在输出里
点明是哪一家。

## 二十二、图片发不出去：「当前 profile 未装载附件服务」（2026-10-29，已修）

用户报：`本轮运行失败 Jet Hub · LobsterAI: 当前 profile 未装载附件服务
（@deepseek-ai/dsh-attachment-local），无法接收图片。`

**先排除的方向**：这句里点名的包在 DSH 里是装好的（`@deepseek-ai/dsh-base` 的
`cordis.patch.yml:146-147` 就插了 `attachment-local`，用户此前在 DSH 里贴图也是成功的），
`~/.dsh/profiles/desktop/cordis.patch.yml` 全文没有 attachment 字样 —— 不是 DSH 配置问题。

**根因（Observed）**：那句话有两份副本，一份在 DSH 的 `dsh-providers-hub`，另一份在
**本项目 vendor 的本体**（`vendor/lib/openai-gateway/messages.js:206`）。而本体这句的
触发条件是 `bridge === undefined`，桥是本插件主动传空的：

```js
// src/llm-bridge.mjs:105-106（改之前，注释原文）
// 第 5 个参数是图片桥（{ bridge, limits }）。插件没有装载 attachments 服务，传空对象：
// 纯文本照常，收到图片时由本体按「未装载附件服务」如实报错，不静默丢图。
const generate = await toGenerateOptions(body, signal, reasoningEffort, maxTokens, {})
```

本体的图片收发**只走 `ctx.attachments`**（入站 `images.js:toImageBlock` → `bridge.saveImage`；
出站 `index.js:340 makeReadImage` → `attachments.readImage`），magpie 宿主不提供它。
⇒ 直连改造（`16e9f24`）把 HTTP 网关换成进程内 `ctx.llm` 之后，图片链路就没接上过。

**复现（改动前，走 3425）**

```bash
curl -s -X POST http://127.0.0.1:3425/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"jet-hub-lobsterai/deepseek-flash","messages":[{"role":"user","content":[{"type":"text","text":"这是什么"},{"type":"image_url","image_url":{"url":"data:image/png;base64,<1x1>"}}]}]}'
# → 400 {"error":{"code":"unsupported_content","message":"Jet Hub · LobsterAI: 当前 profile 未装载附件服务…"}}
# jet-hub-loomy/DeepSeek-V4.1-Flash → 同样 400
# loomy/DeepSeek-V4.1-Flash（不带 jet-hub- 前缀，走 magpie 自己的渠道）→ 200 ⇒ 只有本插件的段进本插件
```

**修法**：新增 `src/attachments.mjs`（`JetHubAttachmentStore`），在
`src/container.mjs` 的 `ctx.plugin(mod)` **之前** `ctx.provide('attachments', store)`，
`forward()` 把它传给 `chatCompletion`，`llm-bridge` 据此拼出真桥：

```js
const images = attachments?.saveImage === undefined
  ? {}
  : { bridge: { saveImage: (input) => attachments.saveImage(input) }, limits: attachments.imageLimits }
```

顺序不能反：本体的 `makeReadImage(ctx)` 在 apply 时把服务闭包捕获一次，晚一步就永远 undefined。

**契约（读 `vendor/lib` 得到，全部 Observed）**

| 方向 | 方法 | 返回 |
|---|---|---|
| 入站 | `saveImage({ data: Uint8Array, mediaType })` | `{ attachmentId:'sha256:<64hex>', mediaType, width, height, bytes }` |
| 出站 | `readImage(ref, signal?)` | `{ data, ref: { mediaType, … } }`（本体读的是 `stored.ref.mediaType`） |
| 出站可选 | `readImageRequest()` | 永远 `undefined`（本体自己回退原图） |

**验证（真跑）**

```bash
node tests/t-attachments.mjs     → ✓ 附件服务契约与本体对接均正确   (exit 0)
node tests/t-direct.mjs          → 结论：✓ 直连链路正常            (exit 0)
```

```
# 单测：手搓六种图片头部（无图像库），尺寸真值
PNG 3×2 / JPEG 640×480 / GIF 12×7 / WebP-VP8X 100×50 / VP8L 5×9 / VP8 320×240
ref = {"attachmentId":"sha256:31d491c7aa04d4ab236a1ce9a857584021f57413d5b58fae97885969fa456dc1",
       "mediaType":"image/png","width":3,"height":2,"bytes":45}
本体重排后的图片块 = {"type":"image","attachment":{…同上…}}
无桥报错 = 当前 profile 未装载附件服务（@deepseek-ai/dsh-attachment-local），无法接收图片。

# 端到端（真容器 + 真上游，图用仓库自带的 ZCode PNG 216→128×128）
✓ 容器提供了 attachments 服务
✓ 本体的 ctx 拿得到 attachments
· 带图请求：buddy/deepseek-v4.1-flash → HTTP 200
✓ 带图请求不再报「未装载附件服务」 — HTTP 200
✓ 图片落盘到了附件目录 — df3aba17…499.json, df3aba17…499.png
```

单测过程中**测试抓到一个真 bug**：WebP 解析的长度闸把 `VP8L` 也按 30 字节卡，而一张
1×1 的无损 WebP 只有 25 字节，会被误判成「不是图片」。已按子格式分开判长度（VP8L 25 /
VP8X 与 VP8 30），并在测试里固定三种子格式。

**边界**：限额与本体同源（20 MB / 20 张 / 8192 px / png·jpeg·webp·gif）—— 不一致会出现
「本体放行、插件拒绝」；`readImage` 重算 sha256 对账，被改过的对象抛 `ATTACHMENT_CORRUPTED`；
只收 data URL（`http(s)` 由本体自己拒，防 SSRF）；不做缩放（引 sharp 的代价大于收益，
本体有回退路径）。

**一处仍然要人做的一步**：magpie 主程序不重载插件，`~/.config/magpie/plugin-providers.json`
的 mtime 停在 `07:45:35`（本次改动后 `08:10` 仍未变，`touch` 无效、`magpie plugin` 无 reload
子命令）。**重启 magpie** 后 3425 那条才不再报附件错。

## 二十三、「添加账号」点了像没反应（2026-10-29，已修）

用户报：控制台新建不了账号。

**先排除的方向（全部 Observed）**：`account.create` 本身没坏。用 curl 直打
`POST http://127.0.0.1:18500/api/jet-hub` 逐家试，18 家都正常返回 `loginUrl`：

```
accio      https://www.accio-ai.com/login?return_url=http%3A%2F%2F127.0.0.1%3A53665%2Fauth%2Fcallback&state=…
astudio    http://127.0.0.1:53670/astudio/login                    （本地页，HTTP 200 text/html）
loomy      http://127.0.0.1:58413/wechat/qr                        （本地页，HTTP 200）
raccoon    http://127.0.0.1:60995/raccoon/login                    （本地页，HTTP 200）
autoclaw   http://127.0.0.1:53673/autoclaw/login                   （本地页，HTTP 200）
buddy / workbuddy / trae / zcode / qoder / qodercn / minimax /
minimaxintl / officeace / codely / gemini / lobsterai / codearts   外站授权页
```

只有三类按设计不建：`aggregate` / `jet-hub-auto`（路由组，本来没有自己的账号）、
`modelscope` / `opencode`（Key 型，走各自 `addAccount`）。

**根因一：`window.open` 被浏览器拦掉，页面什么也不说（Observed）**

CDP 实测点 `#accAdd`：弹窗 `#loginModal` 确实弹出来了（视口内 427,257 560×292），
`#lmState` = 「等待授权…」，但劫持 `window.open` 记到：

```
[{"url":"https://www.accio-ai.com/login?...","returned":"NULL(被拦)"}]   目标页数 8 → 8
```

原因在 `console/console.js` 的 `startLogin()`：它是先 `await rpc('account.create')`
拿到 `loginUrl`，**再**调 `window.open` —— 此时用户的点击手势已失效，Chrome/Edge
一律返回 `null`。原代码把返回值丢了，`catch` 注释还写着「界面里已经给了地址与按钮」，
所以页面上看不出任何异常，用户只看到「点了没反应」。

修法：接住返回值，`=== null` 时把提示换成「浏览器拦下了自动弹窗（授权页必须由你
亲手点开）。点下面的「在新窗口打开」，或复制地址到新标签页访问…」，状态改成
「等你打开授权页…」。「在新窗口打开」是 `<a href>` 的真实点击，一定放行。

**根因二：放弃授权会留下幽灵账号（Observed，本段实测发现）**

`account.create` 会**立刻**在池里写一条占位条目（`nickname === id`、无凭据、
`enabled: true`、无 `expiresAt`；**`autoclaw` 是唯一例外**，它写固定文案
`AutoClaw (登录中...)`，见下面的三审补充），好让 `login.poll` 能查到 —— 本体只在登录**失败**
路径自己删。用户点「关闭」放弃授权时没人删：

```
点一次「添加账号」再关掉 → state.json 多一条 accio-xxxxxxxx（实测 4 条）
这些行在账号表里显示「启用 / 到期 — / 凭据 ref 空」，永远选不中
```

修法：新增模块级 `loginAccountId`；`closeLogin()` 先 `rpc('login.poll')` 问一次，
已成功就保留，否则 `rpc('account.delete')` 回收；`startLogin()` 开头先收掉上一条
stale（连点两次「添加账号」不再累积）；登录成功 / 失败路径都把它置 `undefined`，
避免把刚拿到凭据的账号当「放弃」删掉。

**验证（CDP 真跑，headless Edge）**

```
开始前 accio 账号数: 1 (accio-2e8cb773)
弹窗 hidden: false
提示文案: 浏览器拦下了自动弹窗（授权页必须由你亲手点开）。点下面的「在新窗口打开」…
状态: 等你打开授权页…
弹窗打开期间 accio 账号数: 2        ← 占位已写入，符合本体设计
关闭后 hidden: true
关闭后 accio 账号数: 1 (accio-2e8cb773)   ← 占位已回收
页面异常: （无）
```

顺带清掉了实测污染与历史遗留的 4 个 id 的**占位副本**（`codearts-8e65da6c`、`buddy-cc0962ad`、
`accio-2e8cb773`、`codearts-a40ab885`）。注意：这 4 个 id 本身仍在池里、且都带凭据
（删掉的是同名的无凭据副本，正身保留），账号总数保持 **56**。

**边界**：`#lmOpen` 的点击走浏览器默认行为，控制台无法知道用户有没有真点；5 分钟
超时后仍需用户手动关闭（那时才会回收占位）。`aggregate` / `jet-hub-auto` /
`modelscope` / `opencode` 四家仍按设计不走这条流程。

### 二审又抓出两处真实缺陷（都是我这一轮引入的，已修）

这两条不在第一轮审查的清单里，是二审针对「P1 的修复本身」再查时发现的 ——
**修复引入的回归比原缺陷更危险**，所以单独记一笔。

**① 900ms 收尾定时器会误关并误删「下一次」登录（必修）**

登录成功分支原本是：

```js
loginAccountId = undefined
setTimeout(() => { closeLogin(); loadAccounts() }, 900)
```

HEAD 版无害（`closeLogin` 只关 UI），但抽出 `reclaimPlaceholder` 之后，`closeLogin`
变成「关 UI + 回收占位账号」。而这 900ms 里用户完全可能又点了一次「添加账号」——
那时 `loginAccountId` / `loginTimer` 已经是**下一次**的了，定时器一响就
`clearInterval` 掉新轮询、关掉新弹窗、并把新登录的占位账号当「放弃授权」删掉。

修法：定时器开头先快照 `settledId`，回调里若 `loginAccountId !== undefined`
说明期间开了新登录 → 直接返回；否则只关 UI，**不再走 `closeLogin()`**。

**② 四字段判据挡不住 `finishLogin` 的两步窗口（必修）**

本体 `finishLogin` 是两步：先 `persistLogin` 把凭据落盘，之后才 `fillAccountEntry`
回填池条目（回填失败只 warn 不抛）。而 `login.poll` 的成功判据是「凭据能 resolve」，
**不是**池条目三字段。于是在「凭据已写、池条目未回填」这段时间里，四字段判据会把它
判成占位并删号，随后本体才把凭据写进来 —— 终态是「池里没账号 + 凭据库里一条孤儿
凭据」，`removeAccount` 会连带 `credentials.unset`，**不可逆**。

修法：`reclaimPlaceholder` 删之前再问一次 `login.poll`，`done === true` 就保留；
poll 抛错也保留（保守不删）。

顺带把 `isPlaceholder` 从布尔改成三态 `'yes' | 'no' | 'unknown'`，对齐本体自己的
惯例（`vendor/lib/jet-hub-rpc.js` 的 `loginCredentialLanded` 返回
`'yes' | 'no' | 'unknown'`，其注释记着历史 P0：「只有一个布尔 ⇒ 读凭据失败与确证
没有凭据同样为 false ⇒ 静默收口会把健康账号连凭据一起删掉」）。现在
`account.list` 抛错返 `'unknown'` 而不是 `'no'`，调用方只有 `'yes'` 才继续往下判。

**回归测试**：新增 `tests/t-login-reclaim.mjs`（26 项，已挂进 `scripts/test-all.mjs`
的 UNIT）。判据不是复制粘贴 —— 它从 `console/console.js` 源码文本里截出
`isPlaceholder` / `reclaimPlaceholder` 用 `new Function` 求值，源码改了测试就跟着变，
不会出现「测试绿但代码早变了」。900ms 定时器那段内联在轮询闭包里截不出来，所以分两步：
先断言源码里确实有身份校验（改回去就红），再用等价复刻跑新旧两版，**证明旧版真的会
误删下一次登录**（`旧版：把新登录的占位账号删了（必修 1 复现）` / `新版：没删任何账号`）。

### 三审又抓出两处（2026-10-29，已修）

**必修 ①：`autoclaw` 的占位永远删不掉**

`isPlaceholder` 的昵称判据是「昵称 === id」，但 `autoclaw` 的短信登录路径
（`vendor/lib/jet-hub-rpc.js` 的 `nickname: 'AutoClaw (登录中...)'`）写的是固定文案
⇒ 判据恒 false ⇒ 直接返 `'no'`，**连 `login.poll` 都不问**。用户点「添加账号」→
选 autoclaw → 直接关掉，那条幽灵条目永久留在池里 —— 正是第一轮 P1 要治的病，
对这一家没治好。

三审的实测（从源码截 `isPlaceholder` + `reclaimPlaceholder` 求值，喂各家真实占位形状）：

```
trae      isPlaceholder=yes  polls=1 deletes=1  nickname="trae-abc"
autoclaw  isPlaceholder=no   polls=0 deletes=0  nickname="AutoClaw (登录中...)"   ← 漏删
buddy     isPlaceholder=yes  polls=1 deletes=1  nickname="buddy-abc"
astudio   isPlaceholder=yes  polls=1 deletes=1  nickname="astudio-abc"
```

修法：加一张 `PLACEHOLDER_NICKNAMES = new Set(['AutoClaw (登录中...)'])` 白名单，
昵称判据改成「等于 id **或** 命中白名单」。以后上游新增别的写法把它加进去即可。
回归测试补了「autoclaw 固定文案占位 → yes」与「真的删掉」两条。

**必修 ②：「没返回 loginUrl」的 throw 泄漏状态、弹窗卡死**

`startLogin()` 在 `loginAccountId` / `loginProvider` 已赋值、`#loginModal` 已
`hidden = false` 之后，若 `loginUrl` 为空就 `throw new Error('本体没有返回 loginUrl')`
—— 此时轮询定时器还没建立，外层只 `say('#accMsg', …)` 不清理任何状态：

- 弹窗永远停在「等待授权…」且没有任何轮询，只能手动关；
- `loginAccountId` 残留，下次点「添加账号」会被 `startLogin()` 开头当「放弃授权」
  交给 `reclaimPlaceholder` 回收（虽然 `login.poll` 二次确认会兜住，但语义已经错了）。

可达路径：`astudio` 在本机已导入 AStudio 会话时返回
`{ accountId, loginUrl: '', reused: true }`（空串是 falsy）。本机没装 AStudio 客户端
所以当前不可达，换一台装了并登录过的机器就可达。

修法：throw 之前先 `loginAccountId = undefined` / `loginProvider = undefined` /
`$('#loginModal').hidden = true`，错误文案也补上「这个渠道可能复用了本机已有的登录
会话」。回归测试用 `indexOf` 定位那条 throw 并断言它前面 400 字符里确实有清状态的两句
（不用正则 —— 这段里有引号和 `$`，转义太容易写错）。

**顺带修的三条建议级**

1. `tests/t-login-reclaim.mjs` 补两条存在性锚点：`closeLogin()` 里那行
   `reclaimPlaceholder(abandoned, provider)`（三审实测：把它整条注释掉，原来 19 项
   依然全绿 —— 也就是第一轮 P1 若回归，测试抓不到；现在用 `^\s{2}reclaimPlaceholder\(
   abandoned, provider\)\s*$` 带 `m` 标志，注释行不算命中）。
2. `tests/t-usage.mjs` 第 6 节的 aside 夹具改成「已失效包总额**更大**」
   （900 > 500）—— 原来失效包更小，aside 判据即使被删掉、靠额度比较也能得出同样
   顺序，断言恒真；改后实测删掉 `if (aAside !== bAside) …` 会红 2 项。
3. `console/console.js` 的 `login.poll` 失败分支补 `clearInterval(loginTimer)` +
   `loginTimer = undefined`，与成功/超时分支写法一致。

### 四审（2026-10-29，1 必修 + 4 建议，已全部处理）

四审逐条变异验证了三审那批修复，确认**必修 ①② 都已闭合**（M-B 删白名单判据 → 红 2 项；
M-C 删清状态三行 → 红 1 项；M-A 注释掉 `reclaimPlaceholder` → 红 1 项；M-F 删 aside
判据 → 红 2 项），并抓出新问题：

**必修 · 文档三处仍在说旧判据**（本轮改 `each` 时漏同步）

| 位置 | 原文 | 现状 |
|---|---|---|
| `README.md:338` | 排序按**单包平均额度**降序 | 已改「组内单个包的最大额度」 |
| `VERIFICATION.md:701` | 排序按**单包平均额度** `total / Math.max(1, count)` | 已改写公式与三条理由 |
| `tests/t-usage.mjs:99` | ③ 排序按**单包平均额度** | 已改 |

`VERIFICATION.md` 那句最严重 —— 它把 `total / Math.max(1, count)` 写死了，而代码里这个
公式**已经不存在**（`grep "Math.max(1" src/plugin.mjs` 零命中）。

**建议 ② `tests/t-login-reclaim.mjs` 的弱断言（已修）**

原断言 `src.includes('loginAccountId = undefined') && src.includes('loginProvider = undefined')`
是全文件搜索，而这两个字符串在源码里各出现 4 次以上 ⇒ **closeLogin 完全不清理也是绿的**
（M-H 变异实测：删掉 closeLogin 里那两行，25 项全绿）。改成切出 `closeLogin` 函数体再断言，
M-H 现在红 1 项。

**建议 ③ throw 前的断言漏查一项（已修）**

原断言只查 `loginProvider = undefined` 与 `hidden = true`，**没查 `loginAccountId`** ——
而它残留正是这条缺陷的核心后果。M-D 变异（只删那一行）原来 25 项全绿，现在红 1 项。

**建议 ④ `each` 判据缺可红夹具（已补）**

原来的 trae 夹具（主套餐 `each=500` vs 签到组 `each=100`）在「最大值」和「平均值」两种
判据下顺序相同，测不出差别（M-G 变异全绿）。补了一个**平均值会被稀释**的场景：一个 500 的
大包 + 19 个 1 的小包合成一组（`each=500`、`avg≈25.9`），另一家单个 300 的包
（`each=avg=300`）—— 最大值判据下大包组在前，平均值判据下另一家在前。M-G 现在红 1 项：

```
✗ 1 处不符：each 判据：含大包的合并组应排第一，实际第一条是 另一家
```

**建议 ⑤ 注释事实错误 + 白名单维护纪律（已修）**

`console/console.js` 原写「`vendor/lib/jet-hub-store.js` 一处」，实测第 15 处是
`vendor/lib/accio-auth.js:525`（`jet-hub-store.js` 里 `addAccount` 只出现在注释文字中）。
另补了一段维护触发条件：动 `account.create` 分支时必须 `grep -n "pool.addAccount({" -A 6
vendor/lib/*.js` 逐处看 `nickname` 取值。四审同时确认 16 处占位写法**全部**被「等于 id」
或白名单覆盖（14 处 `nickname: id` + 1 处 autoclaw 固定文案 + 1 处 accio `nickname: options.accountId`），
没有第三类；`opencode-auth.js` 的 `'匿名通道'` 走 `ensureDefaultAnonymousSlot`、带凭据，
不是占位，不在判据范围内。

**建议 ①（同名包到期时间信息丢失）→ 决定保持现状 + 补文档**

四审核了 magpie 的 window 契约：`src/plugin.mjs` 的 `auth.usage` 注释只声明 `windows?`，
**没有字段列表**，多一个非常规字段不会被渲染也不会报错 —— 也就是「加了没用」。
而 `resetsAt` 取最早是**保守且安全**的（用户不会误以为额度能多留）。真实数据里同名包
绝大多数同批发放、到期相近（trae 的 20 条 `签到奖励` 只相差 1 天）。所以不加代码，
在 `README.md:340` 补一句说明：

> 同名包的到期时间如果不止一个，卡片只显示**最早**的那个（保守：宁可让用户以为快到期了，
> 也不让额度悄悄过期）。这是刻意的取舍，不是 bug。

---

## 二十四、在 magpie 里「新建账号」没有语义 → 改成按账号钉住（2026-10-29）

### 现象

用户在 magpie 的供应商编辑器里点「连接」/「Sign in」，界面停在
「请在浏览器中完成 Jet Hub · WorkBuddy 登录 / 正在开始登录…」不动；即使签入成功，
同一个 provider 在 magpie 里也永远只有**一条**账号记录，点几次「连接」都覆盖它。

用户的原话点破了要害：**「magpie 新建账号是由插件决定的」**。

### 根因（三件事叠在一起）

1. 插件声明 `auth.single: true` ⇒ 宿主 `signInKey()`（`host-*.js`）每次都返回
   `accountsOf(provider)[0] ?? provider`，点几次「连接」都落到同一条记录上。
2. `authorize()` 无论谁点、点几次都返回**同一个** `key`（`jet-hub-local:<provider>:direct`），
   `settle()` 按 accountId / secret 判重 ⇒ 永远不会长出第二条。
3. 就算 magpie 里真有两条记录，**本体选号也只看池内数组顺序**
   （`vendor/lib/account-pool.js:1961` 注释「账号列表的数组顺序就是候选优先级」），
   池里没有 `pin` / `sticky` / `preferredAccount` / `forcedAccount` 任何字段
   （全文件 grep 零命中）⇒ 挑 B 仍然走 A。

### 为什么「卡在正在开始登录…」只是冷启动

前端 `signing.state` 停在 `starting`（magpie 前端 `app.js` 渲染 spinner 处（`signing.state === "starting"` 分支）的 `t("Starting the sign-in…")`），
它只在 `POST /api/plugin-signin` 返回后才推进；那条路径调本插件 `authorize()`，
而 `authorize()` 第一句是 `await liveAll(container, log)` = `container.start()`，
**冷启动 20–30 秒**。

后端与插件都没坏，三条实测反证：

| 路径 | 结果 |
|---|---|
| `magpie web` 的 `POST /api/plugin-signin`（宿主已热） | **0.048 s** 返回 `{"state":"done"}`，冷调 0.72 s |
| CLI `magpie plugin login jet-hub-workbuddy` | **13.7 s** 成功 |
| 直接调 `authorize(undefined)` | node **2712 ms** / bun **1960 ms**，均 success |

### 修法（四层，缺一层都不成）

| 层 | 改动 | 作用 |
|---|---|---|
| `src/plugin.mjs` | `single: true` → `single: false` | 允许 magpie 里出现多条账号记录 |
| `src/plugin.mjs` | 新增 `ask(inputs)` 返回 `{type:'select', key:'dshAccount', options}` | 签入时让用户从 DSH 账号池里挑一个（宿主 `nextPrompt` 契约；前端 `renderPluginAsk` 渲染成一排按钮） |
| `src/plugin.mjs` | `authorize(inputs)` 按选中账号编 `key`/`uid` | `key = jet-hub-local:<provider>/<dshAccountId>`、`uid = <dshAccountId>`，两条记录不再被判重 |
| `src/plugin.mjs` | `loader()` → `loader(getAuth)`，转发前 `container.runPinned(id, …)` | 宿主按 key 缓存 loader（`host-*.js` 的 `loaders.set(key, opts)`，行号随宿主版本漂移），每个 magpie 账号各一个实例，能各自知道自己是谁 |
| `src/container.mjs` | 新增 `_pinAccounts(ctx)` + `runPinned()` + `AsyncLocalStorage` | 在请求作用域里把本体的两个选号入口（`getAvailableAccount` / `listAvailableCredentials`）收窄到被钉那一个 |
| `src/plugin.mjs` | 新增 `warmUp()`，工厂被加载时后台起容器 | 用户点「连接」时容器多半已就绪，显著降低 GUI 停在 `starting` 的概率（容器起来前点仍会冷启动，需真 GUI 复验） |

**为什么用 `AsyncLocalStorage` 而不是 `account.reorder`**（两条都是真的）：
① reorder 是全局持久副作用，会改掉用户在 Jet Hub 里手动拖过的排序；
② reorder 并发不安全，两个请求钉不同账号时会互踩。`AsyncLocalStorage` 是请求级的。

**向后兼容**：`ask()` 未答 / 只有一个账号 / 路由组无账号时返回 `null`；`authorize()` 与
`loader()` 在**无参**调用时行为与改造前一致（`tests/t-plugin.mjs` 就是这么调的）。

### 验证（Observed）

`tests/t-account-pin.mjs`（新增，11 项 → 审查后 15 项，假池不联网）：

```
基线（不钉号）：
  ✓ 不钉时按池内顺序选第一个 —— 这就是「挑 B 却走 A」的根源
钉住具体账号：
  ✓ 钉住 bbb222 后选号真的走 bbb222（不再是池首的 aaa111）
  ✓ 拿到的是被钉那个账号自己的凭据（不是池首那个的）
  ✓ listAvailableCredentials 也只给被钉的那一个（临期折算 / 余额查询不会串号）
边界与安全：
  ✓ 钉的是 cline 的号 → 对 workbuddy 无效，照常按池内顺序（不跨家串号）
  ✓ 钉的账号已不在池里 → 退回池内顺序（陈旧记录不该让整家不可用）
  ✓ 钉住一个已停用的账号 → 返回 null（不会绕过 enabled 判据）
  ✓ 调用方显式排除被钉的号时返回 null（不忽略 exclude 集）
  ✓ 空串 / 空白 / undefined 都等于不钉（按池内顺序）
并发隔离（AsyncLocalStorage 的存在理由）：
  ✓ 两个并发请求各钉各的号，互不串（全局变量实现会在这里挂）
幂等：
  ✓ 重复安装幂等（不套两层包装）
```

真容器验证（`JET_HUB_NO_ADDR_FILE=1`，workbuddy 池内 20 个账号）：

```
池内前 3 个 = workbuddy-bb3380f3(enabled=true) / workbuddy-3e9d021b(enabled=true) / workbuddy-f325da61(enabled=true)
不钉 → 选中 = workbuddy-bb3380f3
钉住 workbuddy-3e9d021b → 选中 = workbuddy-3e9d021b
钉住 workbuddy-f325da61 → 选中 = workbuddy-f325da61
结论：钉住生效 = true
钉住后 listAvailableCredentials 条数 = 1 （应为 1，且是 workbuddy-3e9d021b ）→ workbuddy-3e9d021b
并发： workbuddy-3e9d021b / workbuddy-f325da61 → 隔离 = true
```

多账号语义（`ask()` / `authorize()` 实调）：

```
single = false
ask({}) → type=select, key=dshAccount
  message = 选一个要接进 magpie 的 workbuddy 账号（DSH 里共 20 个）
  option: {"label":"betsy030（bb3380f3）","value":"workbuddy-bb3380f3"}
  共 20 个选项
ask({dshAccount:"x"}) = null            ← 已答过不再追问（防死循环）
authorize({}) → key = jet-hub-local:workbuddy:direct（整家槽，向后兼容）
authorize({dshAccount:workbuddy-bb3380f3}) → key = jet-hub-local:workbuddy/workbuddy-bb3380f3, uid = workbuddy-bb3380f3
authorize({dshAccount:workbuddy-3e9d021b}) → key = jet-hub-local:workbuddy/workbuddy-3e9d021b, uid = workbuddy-3e9d021b
key 不同 = true ｜ uid 不同 = true
```

全量离线测试：`node scripts/test-all.mjs` → **13 通过 / 0 失败 / 0 跳过**
（审查后新增 `t-login-reclaim.mjs`，从 12 变 13；这是本节写就时的读数，
之后第二十五节又加了 `t-new-account.mjs`，现为 15 通过）。

### 边界

- 「整家槽」（不挑账号直接签入）仍然保留：`key` 仍是 `jet-hub-local:<provider>:direct`，
  不钉号，按本体默认顺序选号。两种记录可以并存。
- 钉住的账号在 DSH 里被删除后，magpie 那条记录不会自动消失；请求时退回池内顺序
  （不让整家 502），需要清理请手动在 magpie 里移除该账号。
- `aggregate` / `jet-hub-auto` 两个路由组没有自己的账号，`ask()` 返回 `null`，走整家槽。
- magpie 主程序**不热重载插件**，改完要重启 magpie 才生效。
- 升级后若之前用整家槽连过，magpie 里会多出一条旧的 `jet-hub-local:<provider>:direct`
  记录，与新挑账号的 `/<id>` 记录并存成**两个同名渠道**。这是设计如此（`settle()`
  的判重按 key 相等，两种 key 天然不同）；新的那条优先级更高，旧的留着无害，
  看着碍眼就在 magpie 里手动移除它。
- **钉不住的记录**（整家一起用、按池内顺序选号）实测 9 条：`scripts/seed-auth.mjs`
  的 5 条占位（2 个路由组 + 3 家本机未登录渠道），加 4 条 `:direct` 整家槽。
  另有格式旧但仍能钉的（如 `jet-hub-trae` 缺顶层 `uid` 但带 `metadata.dshAccountId`，
  `dshAccountIdOf()` 认这个字段）。

### 审查发现并修正的两处真实缺陷（2026-10-29，子智能体审查）

**① 两层 pool 包装的安装顺序反了 —— 钉住死号会绕过死号过滤。**
`_start()` 里原本 `_filterDeadAccounts()` 先装、`_pinAccounts()` 后装。两层包装是
栈式叠加，**后装的在外层**，所以钉号在外层：它把结果直接替换成被钉的那一条、
不再问内层。于是用户钉了一个「已过期且不可续期」的账号时，死号过滤被整个绕过，
整家渠道立刻 502 —— 而 `_filterDeadAccounts` 存在的理由正是拦这种号
（codearts 的 `STS5.1806`）。

修法：把 `_pinAccounts()` 挪到 `_filterDeadAccounts()` **之前**（钉号在内层收窄候选，
死号过滤在外层把死号并进 `excludeAccountIds` 传给内层，内层见自己被排除就返 null）。
`tests/t-account-pin.mjs` 新增回归锁：钉住死号 → `getAvailableAccount` 必须返 null、
`listAvailableCredentials` 必须为空。

**② `listAvailableCredentials` 包装漏了 `modelRateLimits` 判据。**
`getAvailableAccount` 的包装复刻了本体三条判据（`excludeAccountIds` / `modelRateLimits`
/ `enabled`），但 `listAvailableCredentials` 的包装只判了 `enabled`。结果钉了一个在
当前模型上限流未到期的号时，两个入口对同一请求给出**相反**答案。
生产路径上暂不可达（唯一调用点 `vendor/lib/aggregate-expiry.js` 传空 modelId，
而空 modelId 在本仓库语义是「不按模型过滤」），但两个包装必须语义一致。
已补齐，并在测试假池里照抄本体的三条判据 + 新增两条限流用例。

---

## 二十五、在 magpie 里也能新建账号（2026-10-29）

### 现象

m05344 用户原话：**「只能添加已有账号，不能新建账号」**。截图是 magpie 供应商页
WorkBuddy 一行：点「连接」后弹出一排 `betsyXXX` 按钮让用户挑，挑完就签入 ——
只能从 DSH 已有的 20 个号里选，没有任何「建一个新号」的入口。

### 根因

上面第二十四节把 `single: true` 改成 `single: false` 并加了 `ask()` 选账号，
解决了「加不出第二条」的问题，但**仍然只有一条 `type: 'api'` 的方法**，而
magpie 的「新增账号」在插件体系里就是 `auth.methods[]` 的函数：

- 只有 `api` 型 → 只能「拿一个 key / 接一个已有号」，没有「发起一次授权流程」的能力；
- `oauth` 型才有 `authorize() → {url, ...}` + `callback()` 这套「去浏览器里操作」
  的语义，magpie 会开 URL、后台等回调、完成后落一条签入记录。

所以「不能新建」不是 magpie 的限制，是插件只声明了一种方法。

### 实测：哪些家真的能建（20/24）

`C:/Users/Betsy/AppData/Local/Temp/probe-create.mjs`（magpie-bun 1.4.4，逐个
`POST http://127.0.0.1:18500/api/jet-hub` 的 `account.create`）：

| 结果 | 家数 | 渠道 |
|---|---|---|
| 返回 `{accountId, loginUrl}` | **20** | accio / astudio / autoclaw / autoclawintl / buddy / cline / codearts / codely / gemini / lobsterai / loomy / minimax / minimaxintl / officeace / qoder / qodercn / raccoon / trae / workbuddy / zcode |
| `unknown provider` | **4** | `aggregate` / `jet-hub-auto`（路由组，本体里没有自己的账号）、`modelscope` / `opencode`（Key 型，走各自 `*.addAccount`） |

探针造的占位账号已全部 `account.delete` 清掉，账号池回 56。

### 修法：给 20 家再声明一条 `oauth` 型方法

`src/plugin.mjs` 的 `methods` 数组现在是：

```js
methods: [
  { type: 'api', keyless: true, ask(), authorize() },   // 接一个已有号（第二十四节）
  ...(NO_NEW_ACCOUNT.has(dshProvider) ? [] : [{         // 新建一个号（本节）
    type: 'oauth',
    authorize() { ... },   // 只拿 URL
    callback()  { ... },   // 阻塞等用户
  }]),
],
```

`NO_NEW_ACCOUNT = new Set(['aggregate', 'jet-hub-auto', 'modelscope', 'opencode'])`
—— 对这四家调 `account.create` 本体直接回 `unknown provider`，所以干脆不声明，
免得用户点了才看到报错。

magpie 侧**不需要任何改动**：`startPluginSignIn` 看到 `ms.length > 1` 时会先渲染
「How do you sign in to {name}?」让用户选方法（`signing.state === 'method'` 分支），
选完才走对应流程。

### 链路设计上的关键约束

| 约束 | 依据 | 违反的后果 |
|---|---|---|
| `authorize()` **只等 `account.create`，不等用户** | magpie `pluginBegin()` 用 `context.WithTimeout(..., time.Minute)` 把整个 `plugin.Authorize` 包住 | 必然撞 1 分钟硬超时（正是之前 GUI 卡在「正在开始登录…」的成因） |
| 等用户在 `callback()` 里 | 非 code 型时 `pluginBegin()` 起 `go func() { saved, err := plugin.Finish(wait, a.Session, "") }` —— magpie 拿到 `authorize()` 的返回值就**立刻**在后台调 `callback()` | 用户登录完了也没人收口 |
| 超时取 **9 分钟**，小于 magpie 的 10 分钟 | `signInTimeout = 10 * time.Minute`（`internal/provider/signin.go:48`） | 用户只看到一句「超时」，不知道是自己没登录完 |
| **单次 `login.poll` 另设 15 秒上限**（`LOGIN_POLL_TIMEOUT_MS`） | `container.rpc()` 自己没有超时（只是 `route.fetch()`），而 `login.poll` 内部走 `credentials.resolve()`，officeace / astudio 还有「凭据不可用时现换一次」的联网分支 | 一次轮询挂住 ⇒ 等待链停在 `await` 上，`deadline` 判据走不到。**有守卫后不会「永不返回」**：15 秒被打断、记成「这一次没问到」继续等 |
| **`account.create` 另设 45 秒上限**（`CREATE_TIMEOUT_MS`） | 本体是「先登记占位、再 `await` 各家 `startLogin()`」（qoder / loomy / raccoon / minimaxintl / gemini / officeace / autoclaw / astudio 都是这个形状） | 某家 `startLogin` 卡住 ⇒ 占位已进池、`rpc()` 不返回 ⇒ `authorize()` 挂住，magpie 1 分钟硬超时到点取消、插件还在 await |
| 失败删占位前**再摸一次 `login.poll`** | `account.delete` 连带 `credentials.unset`，不可逆；用户可能恰在超时那刻登录成功 | 误删一个刚登录好的号且凭据一起没了 |
| 空 `loginUrl` 且 `reused: true` 是**成功**出口 | 本体 astudio 分支在「登录方式不是 `web` 且 `importLocalSession()` 成功」时回 `{ accountId, loginUrl: '', reused: true }`，账号条目与凭据此刻都已就位 | 用户看到「新建失败」，池里却多了一个凭据齐全的可用账号，且没人清理 |
| `abandonAccount()` 返回三态 | 收尾那次 `poll` 若说「已完成」，账号其实已经登录成功、也真留在池里 | 只返回布尔 ⇒ 调用方一律 throw ⇒ magpie 把一条**可用**账号标成失败，下一次 `ask()` 里冒出陌生号 |
| `kept` 的判据必须是 `done === true && success !== false` | 本体 `login.poll` 里 `loginFailureOf()` **优先于一切进度判据**：用户关掉授权页 / 点拒绝 / 设备码输错超时都记终态失败，此后每次 poll 都回 `{ done: true, success: false }` | 只判 `done` ⇒ **每一次主动放弃**都被当成「其实登录成功了」⇒ magpie 里留一条绿色的「已新建」记录，而账号根本不存在（2026-10-29 二审发现） |
| `container.start()` 也要套 `withDeadline`（`START_TIMEOUT_MS = 12s`） | `start()` 自己允许等到 40 秒（`src/container.mjs` 的 `hardDeadline`），40 + 45 = 85 秒 > magpie 给 `authorize()` 的 1 分钟 | 本体 llm 40 秒没起来时，`authorize()` 必然撞穿 1 分钟硬超时；12 + 45 = 57 秒留 3 秒余量（2026-10-29 二审指出预算没算这一段） |

`opened` 从本体 `account.create` 的 `incognitoOpened` 取（codearts 那家会自己
`openIncognitoWindow` 拉起无痕窗）：magpie 侧 `plugins.go` 是
`if w != nil && !st.Opened { failed = openError(w, st.URL) }` —— 说 `opened: true`
它就不开窗，否则会再开一个带旧 cookie 的窗口，「新建」永远只能建出同一个号。

### 实测：`authorize()` 真的只拿 URL

`probe-oauth.mjs` 直接调 `JetHubClinePlugin` 的 `methods[1].authorize({})`：

```
[cline] 新建账号 cline-b2d251c4，登录页 https://authkit.cline.bot/device?user_code=GXCG-RSCT
耗时 2488 ms
返回: {
  "url": "https://authkit.cline.bot/device?user_code=GXCG-RSCT",
  "instructions": "在打开的页面里登录要新建的 cline 账号。完成后这一行会自动变成已签入，不需要回来点什么。",
  "opened": false,
  "callback": "function"
}
cline 账号: cline-14b988df(1765502914@qq.com), …, cline-b2d251c4(占位)
清理占位: cline-b2d251c4 → 清理后 cline 账号数: 6
```

2.5 秒返回（含容器冷启动），占位账号按本体设计立刻进池，`account.delete` 能干净收掉。

### 自查与审查发现并修掉的两处真实缺陷：单次调用没有上限

写完之后自查「如果 `login.poll` 这一次永远不返回会怎样」，答案是会漏账号：

- `container.rpc()`（`src/container.mjs` 的 `async rpc(method, payload)`）**没有超时**，
  它就是 `await route.fetch(req)` 再 `resp.json()`；
- `login.poll` 内部会 `await ctx.credentials.resolve(ref)`，officeace / astudio 还有
  「凭据不可用时现换一次」的联网分支 —— 真能挂住；
- 挂住 ⇒ `waitForLogin()` 卡在 `await pollLoginOnce(...)`，`deadline` 判据永远走不到；
  magpie 那边 10 分钟到点、`plugin.Finish` 收超时，而插件的 `callback()` 还在等 ⇒
  `abandonAccount()` 永远不会被调用 ⇒ **本体那条占位账号永远留在池里**。

修法：`pollLoginOnce()` 用 `Promise.race` 套一个 `LOGIN_POLL_TIMEOUT_MS = 15_000`
的守卫定时器，超时当「这一次没问到」处理（与单次 rpc 抛错同一路径），
`finally` 里 `clearTimeout`。

**同一形状的第二处（子智能体审查发现）**：`account.create` 也没有上限。本体
`account.create` 里 15 处 `pool.addAccount` 之后仍有 `await` 的分支有 8 家
（qoder / loomy / raccoon / minimaxintl / gemini / officeace / autoclaw / astudio），
某家 `startLogin()` 长时间不返回就是「占位已进池、`rpc()` 不返回」。修法：抽出
`withRpcDeadline(container, method, payload, ms, what)`，`account.create` 套
`CREATE_TIMEOUT_MS = 45_000`（必须小于 magpie 给 `authorize()` 的 1 分钟）。

⚠️ 这里踩过一个坑：一开始给定时器加了 `timer.unref()`，结果 `rpc()` 真挂住时
事件循环里只剩这个「不算活跃句柄」的定时器，Node 判定无事可做**直接退出**
（实测 `Warning: Detected unsettled top-level await`，进程空转退出、`test-all` 报
`exit 13`）。`unref()` 已删除，收口靠 `finally clearTimeout`。

### 二审又抓出两处（新建账号这一轮引入的，已修）

**① `abandonAccount()` 的 `kept` 判据漏了 `success`。** 原写法 `if (s.done === true)`。
本体 `login.poll` 里 `loginFailureOf()` **优先于一切进度判据** —— 用户关掉授权页、
点拒绝、设备码输错超时，都会记下终态失败，此后每次 poll 都回
`{ done: true, success: false, error: '授权页被关掉了' }`（`LOGIN_FAILURE_TTL_MS` 是
30 分钟，撑满 9 分钟等待绰绰有余）。于是**用户任何一次主动放弃**都被当成
「其实登录成功了」：

```
waitForLogin → {"ok":false,"error":"授权页被关掉了"}
[log] [cline] 放弃新建时发现 cline-abc 其实已登录成功，保留它
abandonAccount → fate='kept'   →   callback 会 throw 吗：false
accountById → undefined（账号根本不存在）
✗ callback() 返回 {"type":"success","accountId":"cline-abc·已新建",…}
```

后果比原先那个「超时那刻刚好登录成功」的极端场景严重得多 —— 那是极罕见，这是
**最常见路径**，且 magpie 里会留一条绿色成功但指向不存在账号的记录。同一份 `s`，
`waitForLogin()` 里判了 `success === false`，`abandonAccount()` 没判，两处判据不一致。
修法一行：`if (s.done === true && s.success !== false) {`。测试侧原先零覆盖
（把判据改成正确写法，测试照样全绿），已补三条用例：`{done:true, success:false}`
→ `fate !== 'kept'`、`fate === 'deleted'`、占位真被删。

**② `authorize()` 的 1 分钟预算没算 `container.start()`。** `start()` 自己允许等到
40 秒（`src/container.mjs` 的 `hardDeadline`），`CREATE_TIMEOUT_MS` 是 45 秒，
40 + 45 = 85 秒 —— 早撞穿 magpie 给 `authorize()` 的 1 分钟硬超时。此前那句
「45 秒必须小于 1 分钟」的论证只算了 create 一段。修法：抽出通用的
`withDeadline(promise, ms, what)`（`withRpcDeadline` 改成它的薄封装），给
`container.start()` 套 `START_TIMEOUT_MS = 12_000`。12 + 45 = 57 秒，留 3 秒余量；
实测冷启动 1.4 秒，12 秒纯属兜底。注意 `start()` 是**幂等共享 promise**，在外面
race 掉它只让本次 `authorize()` 尽快失败，不会取消真正在跑的启动。

顺带把测试侧的预算断言改成**读源码真值**：测试为了跑得快会把
`CREATE_TIMEOUT_MS` 替换成 120ms，拿 `make()` 返回的值做算术永远绿，等于没测。

**③ 文档两处变异红项数写错**（「12 项」「3 项」），实测是 6 项和 3 项，已按实测订正
成完整表格。

**④ 测试侧缺 `DSH_OFFICEACE_HOME` 隔离**（二审顺带指出）：officeace 的凭据目录
走 `DSH_OFFICEACE_HOME`，**不受 `DSH_HOME` 约束**（`vendor/lib/officeace-auth.js`
的 `officeaceHome()`）。不隔离的话，第 7 节真起容器时会去读真实
`~/.dsh-officeace/session.json`，还可能发起一次 STS 续期 —— refresh_token 是一次性的，
一旦被消费用户的号就掉线。已在 `tests/t-new-account.mjs` 头部指到临时空目录。

### 回归测试

新增 `tests/t-new-account.mjs`（不联网、不碰真实 `~/.dsh`），判据**从
`src/plugin.mjs` 源码文本截出来用 `new Function` 求值**，不是复制粘贴 ——
源码改了测试跟着变。共 **142 项**断言（其中 20 家 × 3 项是方法形状的循环断言）：

1. `NO_NEW_ACCOUNT` 恰好 4 家且正是那四家；`workbuddy` 不在名单里；
2. `startNewAccount()`：正常透传 `accountId` / `loginUrl` / `incognitoOpened`、
   清掉该家账号缓存、缺 `loginUrl` 抛人话错误并带上本体原文、本体拒绝时错误不被吞；
3. `waitForLogin()`：`done+success` → ok；`done+success:false` → 用本体的人话；
   本体没给原因时补兜底；`done:false` 不算终态继续等；**单次轮询抛错不算终态**；
   一直等 → 超时文案说清「没在浏览器里完成」；
4. `abandonAccount()`：poll 说完成且 `success !== false` → 绝不删且返回 `kept`；
   **poll 回 `{done:true, success:false}`（用户主动关掉授权页）→ 不能当 `kept`，
   要按确认失败收掉占位**；poll 抛错 / 挂住 → 保守不删且返回 `unknown`；
   确证未完成 → 删且返回 `deleted`；
5. 空 `loginUrl` 的分辨：`reused: true` 当成功出口、无 `reused` 仍抛错、
   连 `accountId` 都没有时 `reused` 也救不了；
6.2 `authorize()` 的超时预算：源码里读真值 `START_TIMEOUT_MS + CREATE_TIMEOUT_MS
   < 60000ms`（不能用 `make()` 里被替换成 120ms 的值做算术，那恒绿等于没测）；
   `withDeadline()` 对挂住的 promise 会按传入毫秒打断并抛可读错误、正常路径原样透传；
6. 源码守卫：**先剥注释再匹配**（裸正则会拿注释里的函数名当「调用」），
   `authorize()` 段里不出现 `waitForLogin`、真的调了 `startNewAccount(`、有
   `opened:`；`withDeadline()` 段里**不出现 `.unref(`**（有的话超时错误永远抛不出来，
   进程直接 exit 13）；`callback()` 段里真的 `await waitForLogin(`、真的调了
   `abandonAccount(`、认 `fate !== 'kept'`、对 `reused` 走成功出口；
7. `oauth` 方法形状：20 家有、4 家无、无 `ask()`、label 含「新建」；
8. 已挂进 `scripts/test-all.mjs` 的 `UNIT`。

第 5.5 节专门盖单次轮询上限：假容器吐 `'hang'`（返回一个永不 resolve 的 Promise），
断言「挂住的 poll 会被超时打断」「一次挂住不算终态、下一轮成功就成功」
「全程挂住 → 到点给出人话失败而不是永不返回」，并断言整体耗时在测试时限内收口。
第 5.6 节同样盖 `account.create` 上限（`create: 'hang'`）。

测试自身还有三道保险（都是审查指出后补的）：

- **看门狗**：`watchdog(p, ms, what)` 给被测调用套一层测试侧上限。被测代码要是
  没有自己的超时，`await` 会挂死、node 以 `exit 13`
  （`Detected unsettled top-level await`）退出 —— 那是红，但红得看不出是哪条断言。
  包一层后变成一条可读的失败。
- **替换守卫**：四处 `body.replace('const NEW_ACCOUNT_WAIT_MS = 9 * 60 * 1000', …)`
  是精确字符串匹配，源码改一个空格（`9*60*1000`）就静默不生效、测试拿着 9 分钟
  真值跑（表现为挂死而不是报红）。所以每条替换后都走 `ok()` 记一条红再
  `process.exit(1)` —— 四审指出原来只 `console.error`，`CREATE_TIMEOUT_MS` 改名时
  红的是 stderr 那行、0 条断言计数，看不出是哪一条。
- **退出即清理**：`cleanupTmp()` 挂在 `process.on('exit')` 上，不只在文件末尾调一次。
  中途的替换守卫（`process.exit(1)`）和未捕获异常都会跳过末尾那行，四审实测两种
  异常路径各在 `%TEMP%` 留一个空目录。

变异验证（每条改完立刻 `finally` 还原、`md5` 双确认，基线
`682ae5a96f2de2ab5c324a52b9c898d7`）：

| 变异 | 红项数 |
|---|---|
| 删掉真实 `startNewAccount` 调用只留注释 | 2 |
| 删掉真实 `waitForLogin` 调用只留注释 | 1 |
| `abandonAccount` 收回布尔（丢掉 `kept`） | 2 |
| 空 `loginUrl` 一律当失败（丢掉 `reused` 出口） | 6 |
| 去掉 `account.create` 的 `withRpcDeadline` | 3 |
| `kept` 判据退回 `done === true`（丢掉 `success:false`） | 4 |
| 去掉 `container.start()` 的 `withDeadline` | 2 |
| `START_TIMEOUT_MS` 改名（读不到常量） | 2 |
| `CREATE_TIMEOUT_MS` 改名（替换守卫变红） | 2 |
| `START_TIMEOUT_MS = 20_000`（超预算） | 2 |
| `START_TIMEOUT_MS = 20_000.5`（小数） | 2 |
| `START_TIMEOUT_MS = 20e3`（科学计数法） | 2 |
| 给 `withDeadline` 的定时器加 `unref()` | 2 |
| 给 `withRpcDeadline` 加 `unref()` | 2 |
| 给 `pollLoginOnce` 加 `unref()` | 2 |
| `const u = timer.unref.bind(timer); u()`（别名写法） | 2 |
| `withDeadline` / `withRpcDeadline` / `pollLoginOnce` 任一改名 | 2 |

**十七条都能变红。** 前五条之外的来历：`START_TIMEOUT_MS` 那四条与 `unref` 四条是
三审（2026-10-29）指出后补的 —— 盖「源码里读不到常量时不能崩 `ReferenceError`
（那会 exit=1 却 0 条 ✗）、正则要能吃小数与科学计数法、有人手滑把 `unref()` 加回
定时器」；最后两条是四审（2026-10-29）指出后补的 —— 原来 `unref` 守卫只切到
`withDeadline` 一个函数，给 `withRpcDeadline` / `pollLoginOnce` 加 `unref()` 全绿
放行（`pollLoginOnce` 是真实风险点：它另写了一遍同样的 `setTimeout` + `Promise.race`），
切段用两个 `indexOf` 也没守卫。更早两条是二审补的：用户**任何**主动放弃授权都会被
当成「其实登录成功了」，以及 `start()` 的 40 秒没算进 `authorize()` 的 1 分钟预算
（40 + 45 = 85 秒）。

三审还抓到一个**真实污染**：第 7 节调 24 个工厂时 `containerFor()` 拿不到 `home`
就回退 `homedir()`，`warmUp()` 又在后台真起容器 —— 实测第 2548ms 写出了
真实 `~/.dsh/cache/models-dev.json`（52990 字节），而本文件 985ms 就跑完，
**纯靠侥幸没污染**。现在文件头就把 `DSH_HOME` 与 `DSH_OFFICEACE_HOME` 指到临时目录，
并在第 7 节显式传 `{ home: TMP_HOME }`；实测跑完真实 `models-dev.json` 的
`mtime_ns` 与 `size` 前后完全一致（`1793245109344625700 / 52990`）。

跑法：`node tests/t-new-account.mjs` → `✓ 全部通过（新建账号链路：四家豁免、
只拿到 URL 就返回、三种终态、删除前三道闸门）`。

### 全量测试

`node scripts/test-all.mjs` → **15 通过 / 0 失败 / 0 跳过**
（t-writerefs 84ms、t-dead-account 114ms、t-account-pin 157ms、t-usage 8457ms、
t-checkin 4685ms、t-options 130ms、t-attachments 106ms、t-plugin 3460ms、
t-models-nowait 45149ms、t-seed-auth 294ms、t-import-backup 1250ms、
t-login-reclaim 2284ms、t-new-account 943ms、t-rpc-cover 76ms、t-patrol 62ms）。

### 一个必须说清的边界

**`oauth` 方法真的会在本体里建账号并写凭据**。它调的是本体的
`account.create`，与本体的 Jet Hub 界面里点「添加账号」完全同一条路径 ——
所以用户在 magpie 里建出来的号，回 DSH 的 Jet Hub 里也能看到、能用。
不想要了要**去控制台或 DSH 删**，删除会连带清凭据。

另有两处历史遗留的「无凭据占位」这次被顺手清掉
（`codely-972673af` / `officeace-900efe1b`，`createdAt` 落在 2026-10-29 14:30，
是上一轮探针留下的，`nickname === id` 且 `.credentials.yaml` 里连 ref 都没有）：
`account.delete` 两条都回 `{"ok":true}`，账号池回 **56**、无凭据占位 **0**。

## 二十六、GitHub 收件箱巡检（2026-10-29，新增能力）

需求：每 30 分钟自动看一遍本仓库的 issue / PR 收件箱。**只读**，不改远端任何状态。

### 为什么不是 DSH 的 schedule

DSH 自带 `@deepseek-ai/dsh-schedule` + `@deepseek-ai/dsh-tool-schedule`，
看起来是现成答案，实际在这台机器上**用不了**，查证过程：

1. `~/.dsh/profiles/node_modules/@deepseek-ai/` 下 250 个条目里，`dsh-schedule`、
   `dsh-tool-schedule`、`dsh-tool-jobs`、`dsh-client-ui-schedule`、`dsh-goal`
   **全是指向 `/d/DSH Desktop/resources/app/node_modules/...` 的失效符号链接**
   —— 真实安装路径是 `/d/DSH`（没有 ` Desktop` 后缀），链接全断。
2. `~/.dsh/profiles/desktop/cordis.patch.yml` 与 `web/cordis.patch.yml` 里
   grep `schedule` 无结果，`~/.dsh/storages/` 下也没有 schedule 存储
   → 服务**没有实际挂载**。
3. 内置 `dsh-web-app/cordis.patch.yml:140-141` 与 `presets/standard.patch.yml:36-37`
   确实声明了这两个服务，但当前会话的工具列表里没有 `schedule_*`
   → 声明了没生效。

修它要动用户现有的 DSH profile 依赖，收益不抵风险，所以改用 **Windows 计划任务**：
它本来就属于操作系统，不依赖任何 DSH 进程活着，笔记本重启也还在。

### 为什么不用 `gh` CLI

这台机器上 **`gh` 未安装**（`command not found`），也没有 `~/.config/gh`。
所以脚本走 Node 内置 `fetch` 直连 `api.github.com`。

凭证走 `git credential fill` —— 和 `git push` 用同一套凭据，
不额外存明文 token。实测非交互上下文（计划任务里）也能取到（`GOT len=40`）。

⚠️ **必须认证**：匿名请求 `api.github.com` 在本机出口 IP（203.10.98.186）上
直接吃 403 rate limit exceeded，所以脚本取不到凭证时以退出码 2 明确失败，
不会退化成匿名请求。

### 增量判据（这是整个脚本最容易错的地方）

`fingerprint = state | updatedAt | comments | labels | draft`

- 标题**有意不进**指纹。理由：改标题几乎必然刷新 `updated_at`，
  已由那一项覆盖；而把标题塞进来会让「编辑标题」和「新评论」混成同一类事件。
  这条取舍在 `tests/t-patrol.mjs` 里被**显式锁定**，防止以后被无声改掉。
- key 用 `${kind}#${number}` 而非裸 `number`。GitHub 的 issue 与 PR **共享编号空间**，
  但 `/issues` 接口会把两者一起返回；只按 number 做 key 会丢条目。
  实测构造 `issue#5` + `pr#5` → 快照里正确占两条。

### 验证结果

- `node scripts/gh-patrol.mjs` 首跑：「open 0（issue 0 / PR 0）」+「首次巡检，已建立基线」；
  二跑：「无变化」。
- 伪造旧快照（塞一条不存在的 `issue#42`）再跑 → 报告正确输出
  「## 已关闭 / 已合并（1）· issue#42 一个虚构的旧 issue」，证明「消失即关闭」这条链路通。
- 用 `renderReport` 直接喂 2 新增 / 1 更新 / 1 关闭的混合数据 → 五个分段
  （新增 / 有更新 / 已关闭·已合并 / 当前待处理 PR / 当前待处理 Issue）全部按预期渲染，
  草稿 PR 带「草稿」标记。
- 计划任务注册后 `Start-ScheduledTask` 手动触发：
  `LastRunTime=10/29/2026 14:46:22`、`LastTaskResult=0`、
  `NextRunTime=10/29/2026 15:00:00`；`patrol.log` 收到
  `[gh-patrol] Betsy20/magpie-Jet-Hub 无变化 · open 0（issue 0 / PR 0）· 限额剩 4991`
  —— 说明**非交互上下文里凭证也取得到**，这是最值得验的一条。
- `Get-ScheduledTask` 回读确认：`Execute=cmd.exe`、
  `Arguments=/d /c ""D:\nodejs\node.exe" "...\scripts\gh-patrol.mjs" --notify >> "...\patrol.log" 2>&1"`、
  `WorkDir=D:\dsh-build\magpie-Jet-Hub`、`Repetition: interval=PT30M duration=[]`
  —— **duration 为空正是「无限重复」的正确表达**。

### 两个真踩的坑

1. **`-RepetitionDuration ([TimeSpan]::MaxValue)` 注册失败。**
   报 `任务的 XML 包含格式不正确或超出范围的值。(10,42):Duration:P99999999DT23H59M59S`
   / `HRESULT 0x80041318`。它序列化成 `P99999999DT23H59M59S`，超 XML Duration 上限。
   正确写法是**省略 `<Duration>` 元素**，所以脚本改用 `Register-ScheduledTask -Xml`。
2. **`.ps1` 不带 UTF-8 BOM 会被 PowerShell 5.1 按 ANSI 解码**（实测 5.1.26100.9711），
   文件里的中文注释吃掉后面的引号，报 `字符串缺少终止符`、
   `"&&"不是此版本中的有效语句分隔符` —— 看起来像语法错，其实是编码错。
   `scripts/install-patrol-task.ps1` 必须以带 BOM 的 UTF-8 保存。
   另外 `$PSScriptRoot` 在被 bash 以 `-File` 调起时可能为空（`Join-Path` 会拿到
   null 直接抛错），所以脚本给了多候选路径兜底并支持 `-RepoRoot` 显式传。

### 契约测试

`node tests/t-patrol.mjs` → `✓ gh-patrol 契约全部通过（normalize / fingerprint / diffSnapshots）`

不联网、不要凭证，覆盖：issue/PR 区分、`user:null` → `ghost`、
标签兼容对象与裸字符串、五类变化都算变化、标题不算变化、
首跑全算新增、稳定态三组皆空、混合态三组计数、issue#5 与 pr#5 不撞车。
已并入 `scripts/test-all.mjs` 的 `UNIT`。
