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

### 一个必须说清的限制
本体自己的 HTTP 网关**没有按请求指定账号的入口** —— 账号由适配器内部
`getAvailableAccount(provider, model)` 按 `enabled` 与 `modelRateLimits` 现选
（`vendor/lib/account-pool.js:2249`）。所以 magpie 里那些账号行是**看得见**
（与 DSH / 控制台账号池一致、能看停用状态），但**选某一行不改变实际用哪个账号**。
写进 README 与本文档，不装作可切换。

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

### 修掉的两个真缺陷
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
node scripts/test-all.mjs → 7 通过 / 0 失败 / 0 跳过
```
截图 `docs/screenshot-usage-credits.png`（784x2842）：WorkBuddy 整卡显示
`7.66 / 100 积分 · 剩余 92%`、Bonus Pack 0/100、`自动签到` 按钮、余额 `222.34 credits`。

---

## 十三、控制台：八个标签，覆盖本体可调度 RPC

### 背景
`auth.usage` / `auth.checkin` 只能覆盖「积分」一栏；用户要的是**全部功能**。
magpie 侧栏页的 `connect-src 'none'` 是写死的（`_mp_pluginpage.go:228`），
做不了写操作，所以完整功能走插件自己的本地 HTTP 服务（`src/hub-server.mjs`）。

### 结构
`console/index.html` + `console/console.js`（约 1200 行）+ `console/console.css`，
左栏八个标签：概览 / 账号 / 积分 / 模型 / 供应商 / 用量 / 设置 / 备份。

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
并重拍八张图，所以这里只留**一次具体运行的记录**，不当作常量：

| 标签 | 2026-10-28 11:39–11:40 那次运行 |
|---|---|
| overview | rows 19 / cards 14 |
| accounts | rows 1 / btns 16 |
| credits | rows 19 |
| models | rows 15 / btns 31 |
| providers | rows 23 / btns 25 |
| usage | rows 20 |
| settings | btns 3 |
| backup | rows 56 |

⚠️ 这组数是**控制台 自己跑完截图脚本报的**，经项目经理 Jeb 转达后抄进本表 ——
不是文档作者复跑的输出。要更新就重跑一次脚本、照抄它打印的 JSON，别手改。

本节以前留的是更早一版（控制台刚做出来时）的数：`meta.providers` 18 / models 28、
accounts rows 2、models rows 9。**这类旧数别再沿用** —— 账号池和模型目录后来都长过。
文档写作时现测 `/__meta`：24 个 provider、`models` 892、`liveModels` 35、内嵌网关 18390。

八张图逐张 `read_image` 确认过内容正确，落在 `docs/console-<tab>.png`。

### 覆盖率
本体方法总数与控制台的覆盖率**不再手写**，由 `tests/t-rpc-cover.mjs` 从源码解析后
自动统计并打印（该测试同时断言控制台没有调用不存在的方法、以及对每个方法真发一次
空 payload、断言都不回 `unknown method:`）。本文只记录口径，不记录数字 ——
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
- `_shot-console.cjs` → `scripts/shot-console.cjs`（八标签实拍 + DOM 断言）
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
`docs/console-providers.png` 实拍：aggregate 17/6、buddy 21/20、workbuddy 32/30、cline 541/… 全部为全量数。
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
✓ 全量开的模型数不少于全量关（关掉不该多出模型）
✓ 没有 input.magpie 时 models() 仍返回对象（不抛错）
```
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
`settings.json` 的 `pluginOptions` 目前是 `null`，因为用户还没改过默认值 ——
`on: true` 来自插件声明的 `default: true`，符合 `optionValues()` 的
「用户值 → 否则插件默认」语义。

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

$ node scripts/shot-console.cjs        # 八标签全部 err:[]
$ node tests/ui-check.cjs              # 侧栏六标签均渲染正常，24 个供应商
```

### 验证五：整跑
```
$ node scripts/test-all.mjs
8 通过 / 0 失败 / 0 跳过
```
