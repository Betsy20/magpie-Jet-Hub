# 变更记录

本仓库还没有打 tag、也没有发布到 npm，所以下面按**日期**分段，而不是按版本号。
每次合并进 `main` 的改动都应在这里补一条：读者据此判断「要不要升级」，
而不是去翻提交记录猜哪条影响自己。

格式：`类型(范围): 一句话说清「改了什么」与「为什么」`。
类型用 `feat` / `fix` / `refactor` / `docs` / `test` / `chore`。

---

## 1.0.0（未发布）

- `docs` / `test`: 全仓仍写「23 家」的**现状描述**统一改成实际家数 **25** —— README 四处
  （架构段、容器必须共享的理由、目录结构两行）、`index.mjs` 与 `scripts/import-backup.mjs`
  的注释，以及 `tests/` 里 `t-model-prices` / `t-plugin` / `t-snapshot-segment` /
  `t-new-account` 的注释；其中 `tests/t-new-account.mjs` 的两条 `>= 23` 阈值一并收紧成
  `=== 25`（两处 `NAMES` 表实测都是 25 键；原来写 `>=` 挡不住表里多出过期键）。
  `tests/t-plugin.mjs` 的具名导出护栏另补一个**绝对家数锚点** `EXPECTED_PROVIDER_COUNT = 25`：
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
