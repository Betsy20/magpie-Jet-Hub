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
