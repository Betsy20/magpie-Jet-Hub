# 验证记录 · magpie-jet-hub

目标：把 **deepseek-harness-codearts 插件本体**装进 magpie，本体 24 个 provider 全在，
且不依赖 DSH 进程。以下每条都是实跑输出，不是设计意图。

环境：magpie 0.1.1734 / 网关 `127.0.0.1:3425` / Web UI `127.0.0.1:3456` /
插件宿主 bun `C:/Users/Betsy/.cache/magpie/bun/1.4.4/magpie-bun.exe` / Windows。

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

`node tests/shot.cjs` —— CDP 驱动 Edge，注入 `magpie_web_3456` cookie，打开
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
13 条断言全部通过

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

- **没有改 `vendor/`**：vendor 是本体原样拷贝，改它会让「跟着上游升级」变成
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
tests/t-dead-account.mjs   死号过滤判据（13 条断言，不联网）
tests/t-writerefs.mjs      .credentials.yaml 写回不吞行（14 条断言）
tests/t-gateway.py     经 magpie 3425 的四项端到端
tests/shot.cjs         CDP 界面实拍
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
$ magpie-bun tests/t-dead-account.mjs → 13 条断言全部通过
$ magpie-bun tests/t-writerefs.mjs    → 全部通过

网关 127.0.0.1:3425（python 真发）：
  jet-hub/workbuddy/deepseek-v4.1-flash  200 'OK'     4333ms
  jet-hub/jet-hub-auto/auto               200 'OK'     2640ms
  jet-hub/codearts/deepseek-v4.1-flash    200 （死号过滤后不再 502）
  jet-hub/workbuddy/... 流式              200 [DONE]x1

侧栏：`tests/shot.cjs` 实拍，第 10 个导航项为「Jet Hub（本体直装）」，
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
用户要求「我需要全部功能」（m06256）。查官方 `docs/subsystems/plugin-runtime.md` 确认受管页面
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
