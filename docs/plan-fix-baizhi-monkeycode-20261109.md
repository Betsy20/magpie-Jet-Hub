# 施工计划书：修复 `<部署实例>` 网关百智云 / MonkeyCode 不可用（2026-11-09）

## 诊断结论（队长已核实，证据在案）

### 百智云（baizhi）——凭据文件损坏，纯数据问题
- `<实例根目录>/home/.dsh/.credentials.yaml` 第 56 行 `BAIZHI_ACCOUNT_6E40BB58:` 的值是**未闭合单引号标量**（行尾字符 `;`，无闭合 `'`）。
- 插件的 `parseRefs`（src/credentials.mjs）按 YAML 多行标量规则继续吞行，把后续 **12 条 ref** 并进 baizhi 的值（2450 字符坏 JSON）⇒ baizhi 槽序列为空 ⇒ 502「还没有可用的 API Key」。
- 被吞的 12 条：WORKBUDDY_ACCOUNT_F2E7795D, BUDDY_ACCOUNT_A57A96AD, TRAE_ACCOUNT_7787D188, BUDDY_ACCOUNT_94D719F4, ZCODE_ACCOUNT_650E9520, LOBSTERAI_ACCOUNT_91211F38, OPENCODE_ANON_C837C2B7, ASTUDIO_ACCOUNT_E645845A, MINIMAXINTL_ACCOUNT_4066BF2E, QODER_ACCOUNT_4A5E602D, QODER_ACCOUNT_F67EDF91, CODEARTS_ACCOUNT_5544E3DC（这些渠道同样受害，修一处全好）。
- 完好值在备份里：`/root/magpie-pool-backup-20261107-1212/.credentials.yaml` 与 `/root/dsh-before-plugin-import-20261106/.credentials.yaml` 的 baizhi 值均为合法 JSON（access_token 67 字符 sk- 开头，含 session_cookie/nickname/user_id）。
- 损坏源头：20261106 导入前的文件里该行就已坏（同样 168 字符、尾 `;`）——是导入/备份恢复链路带进来的，不是运行中写坏。**不要顺手改 parseRefs 代码**，本次只修数据。

### MonkeyCode——signing_secret 失效，会话全部存活
- 4 个账号（MONKEYCODE_ACCOUNT_1E5835D0 / 56DF1AFB / B87DCAD0 / 6BFC73BB）凭据 JSON 完好。
- 差分探测（直打上游 proxy.monkeycode-ai.com，绕过网关）：假 key→401；真 key+正确签名→403 `invalid ohmyagent request`；真 key+错签名→同样 403 ⇒ 网关认 key 但拒绝请求签名，**secret 与平台侧记录不一致（key 被轮换/吊销）**。
- 4 个 session_cookie 打平台 `GET /api/v1/users/status` 全部 200 code=0 ⇒ **会话活着，可重新兑换 key**。
- 修复原语：`exchangeMonkeycodeSessionForKey(cookie, deps, product)`（vendor/lib/monkeycode-credits.js），POST `/api/v1/users/ohmyagent/api-keys`，**每次签发全新一对**（上游无幂等键），每账号只调一次。

## 接入方式
- SSH：`ssh -i <私钥路径> -o IdentitiesOnly=yes -o BatchMode=yes root@<服务器地址>`（钥匙在本容器 NAS，已验证可用）。
- 脚本传输：本地写好 → `scp` 到远端 `/tmp/` → 远端执行。**运行时用 `<实例根目录>/cache/magpie/bun/1.4.4/magpie-bun`**（远端 node 22.9 的 zlib 缺 zstd，加载 undici 8 即崩；插件 import 一律写绝对路径 `<实例根目录>/config/magpie/plugins/node_modules/magpie-jet-hub/...`）。
- 网关：systemd `magpie.service`，API 127.0.0.1:3425，日志 /var/log/magpie.log。凭据服务按 mtime+size 失效缓存，**改凭据文件不需要重启**。

## 铁律
1. 动手前先备份：`cp -a `<实例根目录>/home/.dsh/.credentials.yaml `<实例根目录>/home/.dsh/.credentials.yaml.bak-20261109-fix`（远端）。
2. 任何输出/日志/报告**不得出现凭据原文**（key/token/secret/cookie）；诊断只打印结构特征（长度、键名、HTTP 状态）。
3. 写凭据文件必须**原子写**（写 `.tmp-<pid>` → `rename`），只改目标行，其余字节原样保留；单引号标量转义规则：值内 `'` → `''`，整体包 `'...'`。
4. 不重启 magpie、不改代码、不动其他渠道的凭据值。
5. 兑换失败（ok:false）的账号**保留旧值不动**，记录错误继续下一个。

## dev1 施工单：修凭据文件 + 恢复百智云
1. 远端备份（铁律 1）。
2. 写脚本（bun 运行）：从备份 `/root/magpie-pool-backup-20261107-1212/.credentials.yaml` 用插件 `parseRefs` 取出 `BAIZHI_ACCOUNT_6E40BB58` 的完好值 → JSON.parse 验证 access_token 为 sk- 开头 → 替换现文件第 56 行（按 ref 名定位，不硬编码行号）为规范单引号标量 → 原子写回。
3. 验证（全部通过才算完成）：
   - `parseRefs` 读出 66 条 ref（修复前 54）；12 条被吞 ref 全部回归且各自 JSON 可解析（no access_token 的渠道按原样，不强求）。
   - baizhi 值 JSON 合法、access_token 67 字符。
   - 经网关实测：`POST http://127.0.0.1:3425/v1/chat/completions`，model=`jet-hub-baizhi/deepseek-v4-flash`，max_tokens=16，caller key 从 `<实例根目录>/config/magpie/caller-keys.json` 第 0 条读（不打印）。期望 HTTP 200 有内容；若上游回额度/限流类错误，如实记录（那属账号层，不算施工失败）。
4. 报告：改动行数、验证结果、备份路径。

## dev2 施工单：MonkeyCode 重兑凭据
1. 等 dev1 完成文件修复后再写文件（避免并发写同一文件；读探测可先做）。远端再备份一份 `.bak-20261109-monkey`。
2. 写脚本（bun 运行）：对 4 个 MONKEYCODE_ACCOUNT_* 逐个：
   - `parseRefs` 读现值 → `exchangeMonkeycodeSessionForKey(cred.session_cookie, {}, MONKEYCODE)`（import 自 vendor/lib/monkeycode-credits.js 与 monkeycode-product.js）。
   - ok:true ⇒ 新值 = `{ access_token: key.apiKey, signing_secret: key.signingSecret, session_cookie: 原值, user_id: 原值 }`（保留其余原有字段），按铁律 3 原子替换该 ref 行。**每账号只兑换一次**。
   - ok:false ⇒ 跳过，记录 error。
3. 验证：
   - 直打上游差分探测：新凭据 + `monkeycodeHeaders` 签名 + `buildMonkeycodeMessagesPayload({model:'deepseek-flash', messages:[{role:'user',content:'hi'}], maxTokens:32})` ⇒ 期望不再是 403（200 流式开头即可；402=积分耗尽属账号层，如实记录）。
   - 经网关实测：model=`jet-hub-monkeycode/monkeycode-basic/deepseek-flash` 与 `jet-hub-monkeycode/deepseek-flash` 各一次，期望 200。
4. 报告：每账号兑换结果（ok/error）、探测与网关实测状态码。

## 队长核验（完成后我做）
- 复核远端文件：66 refs、baizhi/monkeycode 值结构、备份存在。
- 亲自经网关重放两家调用。
- 更新 AGENTS.md 对应章节 + 记忆；清理远端 /tmp 探测脚本。

---

## 修订记录（2026-11-09 15:4x，施工中实测纠正）

**原归因错误**：计划书把 12 条被吞 ref 全部归因于 baizhi 一行。dev2 逐行核对证伪：
baizhi 修复只恢复 `CODEARTS_ACCOUNT_5544E3DC` 1 条（parseRefs 54→55）。文件里另有
约 11 条**既有未闭合单引号坏行**（15:08 备份里同样坏，属 20261106 导入带入的第二吞行链），
opener 包括 WORKBUDDY_3BE9F2C0/62D60D12、BUDDY_4607E828/F3E01D00、GEMINI_91872F2E、
MODELSCOPE_F23FC979、WORKBUDDY_C850690E 等；被吞 ref 包括 BUDDY_A57A96AD、
WORKBUDDY_F2E7795D、TRAE_7787D188、BUDDY_94D719F4、ZCODE_650E9520、LOBSTERAI_91211F38、
OPENCODE_ANON_C837C2B7、ASTUDIO_E645845A、MINIMAXINTL_4066BF2E、QODER_F67EDF91。
scanRefKeys=66 印证文件确有 66 个 key。

**修订后分工（串行写同一文件，避免并发覆盖）**：
1. dev2 先写：重兑 4 个在池 MONKEYCODE 账号（备份 `.bak-20261109-monkey`）。
   孤儿 `MONKEYCODE_ACCOUNT_8D30DD51`（不在 state.json 池）**不兑换**（避免上游多签发 key）。
2. dev1 第二轮 gate 在「`.bak-20261109-monkey` 存在 + mtime 稳定≥2min + 无 dev2 写进程」后动手：
   用干净备份 `/root/magpie-pool-backup-20261107-1212/.credentials.yaml`（parseRefs=52、无坏行）
   按 ref 名逐个替换「缺失/bad-json」的行；备份没有的查 20261106 那份；都没有则标记遗留不编造。
   健康 ref 不动（防 revert 已轮换 token）；不碰 dev2 刚写的 4 行；孤儿行若坏只补引号不换 key。
   备份 `.bak-20261109-fix2`。
3. 验收升级为：**parseRefs==scanRefKeys==66 且 swallowed==0**（原「66 条」验收口径不变，
   但明确逐行闭合才是根因修复）。
---

## 终局记录（2026-11-09 16:1x，队长核验后定稿）

### 验收结果（队长亲测）
- 文件：parseRefs=66 / scanRefKeys=66 / swallowed=0；55 条在池凭据 JSON 全合法。
- baizhi：网关 `jet-hub-baizhi/deepseek-v4-flash` 带 system 200（返回 "Hello"）。**已解决**。
- monkeycode：带 system 两个 model 均 200；**不带 system 仍 400**（上游 403）。
- 两代理已冻结 stand down；远端无残留进程；脚本归档 `/tmp/jet-hub-fix-archive-20261109/`；
  兑换账本持久化 `<实例根目录>/home/.dsh/jet-hub/monkeycode-exchange-ledger-20261109.json`。

### ⚠️ 原诊断错误纠正（monkeycode）
计划书「signing_secret 被吊销」**不成立**。dev2 差分 7 组实证：上游拒的是**空 prompt 签名**——
带 system（prompt=system 文本）→200；无 system / system="" / 签名空白 →403；
签名文本与 system 不一致 →403。新旧 key 表现完全一致 ⇒ key 从未失效。
队长原差分缺「带 system」对照组，把「空 prompt 被拒」误判成「secret 失效」。
**重兑 4 把 key 属多余操作**（每账号名下现 2 把，旧 key 仍有效；平台删除端点 cookie 直连 401，
暂无清理路径）。孤儿 8D30DD51 未兑换。

### 真实遗留（待用户拍板）
`vendor/lib/monkeycode.js` 的 `monkeycodeSigningPrompt`：无 system/instructions 时返回空串仍签名
⇒ 客户端不发 system 消息时该渠道必 403。修复方向：无 system 时从首条 user 消息取文本签名
（或兜底 prompt），需代码改动 + 上游验证 + 走本仓补丁流程。本次铁律禁改代码，未动。

### 分工事故复盘
dev1/dev2 并行写同一 `.credentials.yaml`，mtime 门禁未能消除互相干扰（用户投诉「打架」）。
实际终态未互相覆盖（dev1 第二轮原样保留 dev2 的 4 行），但过程混乱。
**教训：同一文件的写操作不拆给两个并行 agent；单 agent 串行或队长独占写。**
