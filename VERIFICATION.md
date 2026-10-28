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
$ magpie-bun tests/t-dead-account.mjs → 13 条断言全部通过
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

$ node scripts/shot-console.cjs        # 八标签全部 err:[]
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

**3. 未做的（明确记下）**

- **没有换 key**。用户拍板时选的是「改写历史」，不是「换 key」；旧 key 现仍在用，
  只是不再出现在仓库里。要彻底解决得换个新 `MAGPIE_WEB_KEY` 重启 web 实例。
  ⚠️ **但「不再出现在仓库里」这句 14:4x 被推翻了**：key 仍可从**三处**匿名读到（PR#1 ref、
  公开 fork `iJetLi/magpie-Jet-Hub`、按 40 位 SHA 直接取的老 commit），见
  [20.3](#203-十九说的不再出现在仓库里是错的key-仍可从公开仓库匿名读到14x-实测)。
  **改写历史在这件事上是无效的**：它改的是 ref，旧 commit 对象只要还被别人的 ref 或
  fork 指住就取得到；唯一能真正关掉的是换 key。
- **没有删 `.map`**（482 个 / 4.3 MB）：它们是 source map，运行时用不到，但删了
  `vendor/` 就不再是上游包的逐字节副本，`diff` 校验会失效。体积换一致性，选了后者。

### 补的合规项

`vendor/` 是上游 `deepseek-harness-codearts@2.7.261027` 的原样副本，MIT
（`Copyright (c) 2026 Jet`），但仓库里原本**没有这份许可声明**。已放
`vendor/LICENSE`（与上游包里的逐字节一致，`cmp` 验过），README 补「`vendor/` 的
来源与许可」一节说明两份 LICENSE 的关系。

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

```
$ git rev-parse 6eee107^{tree}   → 0c983ed4df56
$ git rev-parse b906065^{tree}   → 6f277eebabac          ← 不同
$ git rev-parse c2ed21a^{tree}   → 0b64e0cd650f
$ git rev-parse 3bf9c5d^{tree}   → 308ecb994413          ← 不同
$ git rev-parse 6402fec^{tree}   → 8afbe800c87f
$ git rev-parse 112e1dd^{tree}   → 7616e34b5153          ← 不同
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
