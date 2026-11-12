# 已知问题：MonkeyCode 请求缺 system 时恒 403 `invalid ohmyagent request`

记录于 2026-11-11。**当前决定：不修**（见文末「为什么不修」）。这份文档只为把
现象、判据和将来的修法留档，免得下次有人从零再查一遍。

## 现象

面板底部报错：

```
monkeycode-basic/deepseek-flash 通过 OpenAI 协议没有响应：200 · monkeycode: 模型
monkeycode-basic/deepseek-flash 所有账号均不可用（auth）：monkeycode: HTTP 403 —
{"error":"invalid ohmyagent request"}
```

关键点：**账号本身是好的**。同一个 Key 在请求里带上 `system` 消息时返回 200，
去掉 `system` 立刻 403。

## 机制

MonkeyCode 的网关鉴权是「正文签名」：

```
X-OhmyAgent-Signature: v1=<hex HMAC-SHA256(signing_secret, prompt)>
```

其中 `prompt` 由 `monkeycodeSigningPrompt(payload)` 提取
（`vendor/lib/monkeycode.js:144`），取值顺序固定：

1. 顶层 `system`（string，或 `[{type:'text',text}]` 取第一块 text）
2. 顶层 `instructions` 数组，多块按 `\n` join
3. `messages` 里首个 `role === 'system'` 的消息内容
4. `input` 里首个 `role === 'developer' | 'system'` 的消息内容

四处全落空时返回**空串**，于是签名变成 `HMAC(secret, "")`。网关拿它和
「按同样规则从收到的请求里算出的值」比对，服务端认为这个请求没有可签名的
prompt ⇒ 回 `403 {"error":"invalid ohmyagent request"}`。

`vendor/lib/monkeycode-messages.js:121` 的注释已经写明这条：

> payload 没有 `system`，`monkeycodeSigningPrompt()` 对空串签名，网关必回 403

所以这不是凭据问题，重登、换号、重新浏览器登录都不会好。2026-11-11 在
<部署实例> 上用 5 个账号的 `access_token` + `signing_secret` 逐一实测确认过：
带 system 的 prompt 全部 200，对空串签名全部 403。

## 哪些请求会缺 system

- 只发一条 user 消息的裸探针（`curl` / `python -c` 手写的请求）。
- 某些客户端在「纯对话、无系统提示」模式下发出的请求。
- 用 `/v1/messages`（Anthropic 协议）时只给 `messages` 而不给顶层 `system`。

正常编辑器/CLI 客户端（ZCode、Claude Code 这类）每次都会带 system 提示，
所以真机上大概率不会踩到。

## 合法的 stream 请求也这样

用 `stream: true` 时错误不会以 HTTP 状态码返回，而是塞在 SSE 里：

```json
{"error": {... "code": "AUTH", "status": 403}}
```

排查时不要只看 HTTP 200。

## 将来要修的话

思路是「请求缺 system 时补一句最小 system」——但**不能随便补**：签名用的
prompt 必须与服务端算出来的完全一致，而服务端算的就是**客户端实际发来的
payload**。如果插件在发出去之前偷偷塞一条 `system`，那个 system 会随
payload 一起发给网关，服务端也会把它算进 prompt ⇒ 签名自洽，403 消失。
换句话说：**补 system 是安全的，前提是补完之后再签名、并且发的是同一份
payload**（现成代码就是这个顺序：body 只 `JSON.stringify` 一次给所有账号共用，
见 `vendor/lib/monkeycode-adapter.js`）。

落点建议：`monkeycode-adapter.js` 的 `prepareCall()`/`stream()` 里，在
`JSON.stringify(payload)` 之前检查 `monkeycodeSigningPrompt(payload) === ''`，
为空时注入一条最短的 `system`（比如 `{"type":"text","text":"You are a helpful assistant."}`），
并 `log` 一次说明「已补最小 system」。

⚠️ 注入的最小 system 会**改变上游模型的行为**（多了一句 system 提示），
所以如果要做，最好做成显式开关（插件设置里一项「为无 system 的请求补最小
system」），默认关。这也是当前不修的理由之一。

## 为什么不修

1. 触发条件窄：正常客户端都带 system，踩到的基本是手写探针。
2. 修法会改动上游模型看到的内容，属于「为了兼容一个畸形请求而改变正常请求的
   语义」，需要产品判断，不适合在真机排查里顺手改。
3. 报错信息本身已经足够定位（`auth` + `invalid ohmyagent request` 这组合
   只对应这一个原因）。

## 相关

- 签名算法是公开的：`backend/biz/llmproxy/ohmyagent_prompt.go`（上游开源）。
- 面板侧报的那个 `auth` 分类来自 `allAccountsRateLimitedForModel`
  （`vendor/lib/account-pool.js:52`）之外的错误归类路径；注意它和「所有账号
  均不可用（quota）」是两回事，后者才是额度耗尽。
- 顺带记一个**纯展示**问题：`monkeycode-adapter.js:172` 在候选集为空时抛的是
  「还没有可用的 API Key」，而候选集为空也可能是因为所有账号都被限流 ——
  那句文案会把「额度用尽」误导成「缺凭据」。
