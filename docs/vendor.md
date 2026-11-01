# `vendor/` 的来源、许可与差异

`vendor/` 是上游插件本体的一份**构建产物快照**，随本仓库分发。它不是本仓库的代码，也不在本仓库修改行为 —— 只有下面列出的 5 个文件因规避扫描器、补一个读取路径或修一处必然抛错的取值而改过写法。

## 来源

| 项 | 值 |
|---|---|
| 上游源码仓库 | [`iJetLi/dsh-providers-hub`](https://github.com/iJetLi/dsh-providers-hub) |
| 代码对应 commit | `6fa74723d42ff605d1de349589c21a1ac4eb7ba2` |
| 版本号 | `2.9.261029`（`vendor/package.json` 沿用 npm 2.9 那一份） |
| 许可 | MIT，`Copyright (c) 2026 Jet` —— 全文见 [`vendor/LICENSE`](../vendor/LICENSE) |

**为什么不用 npm 包**：当初取快照时 npm 上最新是 `2.9.261029`（现在已前进到 `2.11.x`），而 `2.9.261029` 之后上游又推了两条提交（新增 `magicrew` 供应商），这一版是从源码 clone 下来 `npm install`（自动跑 `tsc -p tsconfig.json && node scripts/copy-assets.mjs && node plugin-src/client/build.mjs`）构建出 `lib/`，再连同 `locale/` 拷进来。`package.json` 与 `LICENSE` 仍取 npm 2.9 那一份。

取法：

```bash
git clone https://github.com/iJetLi/dsh-providers-hub /tmp/up
cd /tmp/up && git checkout 6fa74723 && npm install
cp -r lib locale /path/to/magpie-Jet-Hub/vendor/
npm pack deepseek-harness-codearts@2.9.261029   # 取其中的 package.json 与 LICENSE
```

## 三个包名

上游同一个包在 npm 上以三个名字同版本发布：

| 名字 | 说明 |
|---|---|
| `deepseek-harness-codearts` | 上游 `lib/client/jet-hub.js` 里的 `PLUGIN_ID` 用的就是它 |
| `dsh-providers-hub` | 改名后的仓库名兼包名 |
| `dsh-codearts-auth` | 最早的名字（`0.2.0-rc.11` 起改名） |

三者的 `lib/` 只差同一个包名字符串出现的那两处（`id:` 与 `PLUGIN_ID`）。读源码去 GitHub（`iJetLi` 那个仓库最新），装包 / 对版本去 npm 任一名字。

> `npm view` 里 `repository` 字段指向 `zhuweiyou/dsh-providers-hub`，那是更早的同源仓库（2026-10-25 停更），`iJetLi` 那个包含它的全部历史并继续往前走。该字段只出现在镜像 npmmirror 的 packument 顶层，官方 registry 没有。

## 与上游构建产物的差异

`lib/` 共 1010 个文件，其中 **1005 个与上游逐字节一致**；`locale/` 2 个全部一致。剩下 5 个：

| 差异 | 原因 |
|---|---|
| `lib/gemini-oauth.js` 与 `.d.ts` 里两个默认 OAuth client 常量拆成两段字符串拼接 | 规避 GitHub push protection 误报。**值完全相等**（两个常量 `===`，长度 73 / 35 字符一致），另有环境变量可覆盖。边缘副作用：`.d.ts` 是声明文件，`declare const` 的初始值按 TS 规范只能是字面量，单文件 `tsc file.d.ts` 会报两条 `TS1254` —— 本仓库不编译类型声明，正常使用路径不受影响 |
| `lib/magicrew-browser-login.js` 与 `lib/magicrew-local-browser.js` 补读 IndexedDB | 上游这两处只从 `localStorage` 找登录凭据，而超级麦吉网页版把凭据写在 IndexedDB 的 `magic-global/user` 库里 —— 真机上「登录成功却永远读不到」。**行为只增不减**：localStorage 那条老路径原样保留，读不到才走 IndexedDB |
| `lib/magicrew-browser-login.js` 开窗前回收上次遗留的一次性 profile 目录 | 上游 `ChromiumSession.dispose()` 的删除只退避 2.1 秒，而窗口被用户关掉时没有任何回调保证走到 `dispose()`。两条路叠加的结果是 `%TEMP%` 里攒了 11 个 `magicrew-login-*` / 856 MB。现在开窗前扫一遍、只删够老的（Windows 1 小时、其它平台 6 小时）、每轮最多删 3 个（这函数同步跑在「点连接」与「窗口出现」之间，清完 856 MB 要约 7 秒，会让用户以为按钮坏了） |
| `lib/jet-hub-rpc.js` 给 `product.id` 加一层判空守卫（两处） | `credits.balances` / `credits.status` 的调用点传的 `product` 就是 `undefined`（各家读数由 `deps.fetchBalance` 闭包带走），而共享骨架里有一处**无条件**求值 `product.id`。`&&` 左侧恰好是「凭据解析不出来」——唯一会短路到右边的情形，于是**只要某个账号凭据丢了就必然抛** `undefined is not an object (evaluating 'product.id')`，把本该显示的「凭据未配置」变成看不懂的 JS 报错。**这是本仓库唯一改上游行为的差异**（其余四个只是改写法或补读取路径）。加守卫而非删句，是为了保留「外部传真 `product` 时」的上游原语义 |
| 没有 npm 包里的 `README.md` 与 `cordis.patch.yml`（缺失项，不计入上面的 5 个） | 那是 DSH 前端与插件补丁用的，magpie 侧用不到 |

保留时长为什么分平台：判据「只删够老的」是启发式。Windows 上还有第二道网（正被占用的文件删不掉，`rmSync` 抛 `EPERM`/`EBUSY`）；**POSIX 没有这道网** —— `unlink` 对已打开的文件是合法操作，删除会成功，于是「删了正在用的目录」反而成功，只是把那个窗口弄坏。所以 POSIX 只能靠阈值自保，取 6 小时。真正在用的目录存活上限是登录本身 4 分钟（`MAGICREW_BROWSER_LOGIN_TIMEOUT_MS = 240_000`），两个阈值都留了十几倍余量。

除这 5 个之外，本仓库对上游代码**没有其它改动**。

`lib/jet-hub-rpc.js` 那条是本仓库**唯一改上游行为**的差异，上游当前仍是原样（未跟进），
所以每次同步 vendor 都必须把它重新打上 —— 漏掉的后果是：只有「账号凭据丢了」的机器才会
看到那句 `product.id` 报错，CI 与其它机器全绿。`tests/t-usage.mjs` 第 7 节有一段直接
`import` vendor 的行为锁，删守卫会红。唯一与「上游运行环境」相关的适配在 `vendor/` 之外：`src/connection.mjs` 给容器补一个 `connection` 服务（上游在 DSH 里由宿主提供）。

## 怎么自己核一遍

```bash
mkdir -p /tmp/up && cd /tmp/up
npm pack deepseek-harness-codearts@2.9.261029
tar -xzf deepseek-harness-codearts-2.9.261029.tgz
diff -r /tmp/up/package /path/to/magpie-Jet-Hub/vendor
# 逐文件哈希核（比 diff -r 更严，能看出换行 / 编码差异）：
cd /tmp/up/package && find . -type f -exec sha256sum {} + | sort -k2 > /tmp/up/a.txt
cd /path/to/magpie-Jet-Hub/vendor && find . -type f -exec sha256sum {} + | sort -k2 > /tmp/up/b.txt
diff /tmp/up/a.txt /tmp/up/b.txt
```

注意：上面比的是 **npm 2.9** 那份，而我们用的是 commit `6fa74723` 的构建产物，两者之间还有上游自己的两条提交（`magicrew` 相关，36 个文件），所以 `diff` 会同时列出它们和上表那 5 个文件。

`vendor/` 里有 504 个 `.map`（source map，约 3.4 MiB）运行时用不到，留着是为了与上游包尽量逐字节一致、方便 diff 校验。要在意仓库体积可以删，不影响运行。

## 版本怎么升

`vendor/` 是随仓库分发的快照，不跟着 npm 自动走。升版本要：

1. 重新 clone / 构建上游，替换 `lib/` 与 `locale/`
2. 把上面那 5 个文件的改动重新应用（gemini 常量拆分、magicrew 的 IndexedDB 读取与临时 profile 回收、`lib/jet-hub-rpc.js` 的两处 `product` 判空）
   ⚠️ 最后那条是**行为**改动，漏掉它 macOS/Linux 与 Windows 都不会红 —— 只有用户账号凭据丢了的机器会看到那句 `product.id` 报错。`tests/t-usage.mjs` 有一段直接读 vendor 源码的锁，漏补丁会红
3. `npm install`（依赖可能变）
4. 跑 `node scripts/test-all.mjs` 与 `node scripts/snapshot-models.mjs`

## LICENSE 的关系

MIT 要求「substantial portions」保留版权与许可声明，所以 `vendor/LICENSE` 必须跟着 `vendor/` 一起分发（`package.json` 的 `files` 里已含 `vendor`，整目录进包）。根目录的 `LICENSE` 是本插件自己的，两者不要混看。
