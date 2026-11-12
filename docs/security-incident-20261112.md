# 2026-11-12 凭据与生产坐标泄露 —— 处置与根治

> 一句话：两个运维脚本把 **magpie web 面板的 18 位明文 key、两台生产服务器的公网
> IP + root 账号、服务器上私钥的绝对路径与文件名** 提交进了这个 public 仓库。
> 一个好消息：上游已经从源码里清掉了明文；一个坏消息：**fork 的 main 和历史里
> 至今仍可匿名下载，而那把 key 实测现在还能登进两个实例。**
> 代码层已经补上两道守卫；**换 key 与清史必须人工执行**（动线上配置和 force-push，
> 不适合无人值守自动做）。本文件只给可照抄的命令。

## 0. 先说结论（2026-11-12 实测）

| 结论 | 证据 |
|---|---|
| 泄露的**面板 key 现在仍然有效** | 带 key 请求 `https://<实例>:3430/?k=<key>` → **303** + 下发会话 cookie；不带 / 伪造 → **401** |
| 但它**不是**「未来会被利用」的风险，而是**现在可被登录** | 同一个 key 在**两个实例**上都返回 303（两机共用一把 key） |
| 上游 main **没有被明文 key 污染** | PR #31 合入的版本已经在源码里改成环境变量注入；上游只有 1 笔相关提交 |
| 但 fork 的**历史提交对象**至今明文暴露 | ⚠ **不是「main 的内容」**（`origin/main` = `febe312` 的树里两个脚本已经是 `${VAR:?}` 环境变量版）—— 是**历史里的 `9003611` / `4fb5459` 那两棵旧树**：`raw.githubusercontent.com/<owner>/<repo>/<旧sha>/scripts/deploy-plugin-*.sh` 匿名可下载，`.patch` 同理。**改源码撤不掉已经发出去的副本。** |
| 私钥**本体**从未进仓库 | `git log -S 'BEGIN OPENSSH PRIVATE KEY'` = 0 |

**所以最紧急的不是清史，是换 key。** 清史只让「以后下载不到」，
挡不住已经下载的人 —— 而实测表明这把 key 现在就能登进去。

## 1. 泄露了什么、泄露到哪

| 内容 | 位置 | 性质 |
|---|---|---|
| magpie web 面板 key（18 位纯数字明文） | `scripts/deploy-plugin-*.sh`（两个文件） | **可直接登录面板**的凭据 |
| 两台服务器的公网 IP | 同上 | 攻击面坐标 |
| 远程登录账号被设成 root | 同上 | 告诉对方用哪个账号登 |
| 服务器上私钥的绝对路径与文件名 | 同上 | 定位「钥在哪」，配合上两条即完整的入侵路线 |
| 主机别名（两台机器各一个）+ 实例绝对路径 | `docs/plan-*.md` 若干处 | 拓扑信息 |

**私钥本体没有进仓库。** 进的是「钥放在哪、用谁登、目标在哪」——这不足以直接入侵，
但足以让有心人省掉全部踩点。

泄露从 commit 那一刻开始：仓库是 public，`.patch` 可被匿名下载。
**改源码不能撤销已公开的历史**，这一点是下面两节存在的原因。

## 2. 已经在代码里做完的（本 PR）

这一层解决的是「以后不再发生」，可随 PR 合入，不需要任何线上操作。

- **`tests/t-repo-purity.mjs`（新增，已挂进 `test-all.mjs` 与 CI）**
   8 条内容规则（IPv4 字面量 / PEM 私钥头 / `~/.ssh/<名>` 路径 / GitHub token /
   AWS access key / 硬编码 key / 主机别名 / 生产绝对路径）+ 1 条结构规则
  （不许有 `scripts/deploy-*.sh`）。
   带 **33 条匹配器自检样本**：删任一条规则、或把正则改坏到永远不命中，自检立刻红。
  （初版只有 19 条、且 4 条规则零负例 —— 三审实测「把 `github_pat_` 分支整个删掉
  自检照样全过」。现按「每条规则的每个分支都配正例 + 负例」补齐，顺带修掉一个
  真缺陷：名字段 `[A-Za-z_][\w.-]*` 强制前缀，导致 `PASSWORD=…` 这类「关键词在开头」
  的写法全部漏报。）
  这条是为了防「扫了 0 处却报绿」——那种绿灯比没有检查更危险。
- **`.gitleaks.toml` + `.github/workflows/secret-scan.yml`**
  第二道防线，扫 git 历史。**必须自定义规则**：实测把本次两个脚本丢给 gitleaks
  默认规则是 **0 命中**（18 位纯数字 key / IP / root / 私钥路径都不是「云厂商 key
  形状」）。workflow 拆成两个 job：`tree`（必过，拦新泄露）与 `history`
  （定时跑，是历史欠账的进度条）。
- **`.gitignore`** 按形状挡凭据（`*.pem` / `*.key` / `.env*` / `id_rsa*` / …）。
- 三个 `deploy-*.sh` / `plan-install-*.md` 文件从工作区删除；
  三篇有价值的 `plan-*.md` **保留**，只把里面的主机别名与实例绝对路径换成占位符
  （它们是插件行为的上游实测记录，删掉等于逼下一个人重踩坑）。

## 3. 必须人工做的第一件事：轮换（最紧急）

**历史清理之前、之后都不影响这一条 —— key 已经公开两天多了，按已泄露处理。**
这是唯一真正能「止损」的动作；其余都是防止复发。

这个 key 是 `MAGPIE_WEB_KEY` 环境变量固定的（`magpie web --help`：给了它就
「keeps one, signed in for 400 days」；不给则每次启动随机）。它写在 systemd unit 的
`Environment=` 行里，**两个实例用的是同一把** ⇒ 必须两边都换。

```bash
# ① 生成新 key（18 位数字，与 internal/gui.NewWebKey 同形态；别用会进 shell 历史的方式）
NEW=$(python3 -c 'import secrets; print("".join(secrets.choice("0123456789") for _ in range(18)))')

# ② 改 unit（两台上都要做）。只改 Environment 行，其余一个字别动。
#    ⚠️ 先 cp 一份单位文件；轮换出问题要能立刻回滚。
cp -p /etc/systemd/system/magpie.service /etc/systemd/system/magpie.service.bak-rotate-$(date +%Y%m%d)
sed -i "s|^Environment=MAGPIE_WEB_KEY=.*|Environment=MAGPIE_WEB_KEY=${NEW}|" /etc/systemd/system/magpie.service
systemctl daemon-reload

# ③ 重启（会掐断在途 SSE 流，先确认没有正在跑的会话；见 deploy-plugin.sh.example 的说明）
systemctl restart magpie

# ④ 验证：旧 key 必须 401，新 key 必须 303
curl -sk -o /dev/null -w 'old=%{http_code} (期望 401)\n' "https://<实例>:3430/?k=<旧key>"
curl -sk -o /dev/null -w 'new=%{http_code} (期望 303)\n' "https://<实例>:3430/?k=${NEW}"
```

⚠️ 旧 key 还残留在**本机若干备份文件**里（`/etc/systemd/system/magpie.service.bak-*`、
`/root/unit-backups-*/`、`/root/archive/*.md`）—— 它们不公开，但换 key 后应一并用
新值覆盖或删除，否则「轮换」只是前门换了锁、后门还留着备用钥匙。

同时建议：
- 两台机器上确认 `root` 直登是否必要。若必须留，改为密钥登录 + `PermitRootLogin
  prohibit-password`；**私钥文件换名换路径**（泄露的正是路径与文件名）。
- 检查面板访问日志里是否已有来自陌生 IP 的、带 `?k=` 的请求。有就是已被利用，
  按入侵处置，不只是换 key。

## 4. 必须人工做的第二件事：清史

> ⚠️ 破坏性操作，**不可逆**，且会让所有副本的 `main` 分叉。执行前：
> 确认没有别人正在基于旧 `main` 开发；执行后通知所有协作者重新 clone。

```bash
# ⚠ 先把 owner/repo 换成**你自己的那个**，别照抄 —— 本仓 origin 是
#   `Betsy20/magpie-Jet-Hub`，而 PR 分支来自 fork `hnlinyh/magpie-Jet-Hub`。
#   清错仓库的后果是：本仓一点没变，你却在另一个 fork 上重写了所有人的历史。
OWNER_REPO="<owner>/<repo>"     # 例：Betsy20/magpie-Jet-Hub

# 在干净 clone 里做，不要在带未提交改动的目录做
git clone "https://github.com/${OWNER_REPO}.git" clean && cd clean
pip install git-filter-repo   # 或 brew install git-filter-repo
# ⚠ PEP 668 的系统（Debian 12+/Ubuntu 23+）要加 --break-system-packages

# 注意：--path 只吃字面路径，通配要写成 --path-glob。
# 除了两个部署脚本，两个 plan 文档的**旧版本**里也有生产绝对路径（15 + 2 处），
# 只删脚本的话清史后 `history` job 仍然红。
git filter-repo --force --invert-paths \
  --path-glob 'scripts/deploy-plugin-*.sh' \
  --path-glob 'docs/plan-install-local-plugin-*.md' \
  --path-glob 'docs/plan-fix-baizhi-monkeycode-*.md' \
  --path-glob 'docs/plan-baizhi-wallet-split-*.md'

# filter-repo 会主动删掉 origin 远程（防误推），推之前要加回来：
git remote add origin "https://github.com/${OWNER_REPO}.git"
git push --force origin main
```

清完之后验证 —— ⚠ **`git log --all` 在这里是自证题**：`filter-repo` 已经重写了**本地
全部 ref**，它必然无输出，与远端是否干净无关。真正的验证只有「匿名取旧 sha」：

```bash
# 真正的判据：旧的固定 sha 应该 404（把 <旧sha> 换成 9003611a… 那一串）
curl -sI "https://raw.githubusercontent.com/${OWNER_REPO}/<旧sha>/scripts/deploy-plugin-hcss8141.sh" \
  | head -1     # 期望 404；若是 200 / 302，说明对象还在

# 本仓规则扫全历史（这条仍然要跑，但只证明「本地对象图干净」）：
gitleaks git . --config .gitleaks.toml --redact
```

清史后**必须**做的收尾：

1. **🔴 `refs/pull/*` 清不掉 —— 必须联系 GitHub Support，这是必做项不是可选项。**
   GitHub 不允许用户删除 PR ref：`git push --force origin main` 之后，
   `refs/pull/31/head` 仍指向旧 commit，`raw.githubusercontent.com/<owner>/<repo>/<旧sha>/…`
   依然匿名 200。**不清就白清。** 工单模板：

   > Subject: Request to purge cached git objects after history rewrite
   >
   > Repository: `<owner>/<repo>`
   > We rewrote history to remove accidentally committed credentials
   > (old commits `9003611a…` / `4fb5459f…`). Those objects are still reachable via
   > `refs/pull/31/head` and `raw.githubusercontent.com` even after the force-push.
   > Please garbage-collect the unreachable objects and, if possible, remove the
   > cached raw blobs for those SHAs. The exposed credential has already been rotated.

2. **GitHub 上的 `.patch` / commit 缓存**：`Settings → 确认没有残留的公开 fork`
   （fork 是独立对象图，force-push 上游不会同步过去）。
3. `pr/merge-into-upstream` 等分支需要 rebase 到新的 `main`，否则它们仍指向旧历史。
4. 上游 PR #31 的 diff 若引用了旧 commit，评论里说明「历史已重写」。
5. `history` job 变绿之后，把它的触发从 `schedule` 改成 `push`（那时它才是必过项）。

## 4.1 换 key 之前必须知道的副作用

`MAGPIE_WEB_KEY` 是**会话 cookie 的签名密钥**（从 `magpie.exe` 提取的原文：

> `This browser's sign-in cookie holds a key that isn't this magpie web's: the key
> changed after it signed in (MAGPIE_WEB_KEY changed, or a start without it made a new one).`

）。⇒ 换 key 会**把所有已登录的浏览器会话一次性踢下线**，不只是「新登录用新 key」。

- **挑维护窗口做**：两个实例共用一把 key，实例 A 重启到实例 B 重启之间，
  「登录落到 A、刷新落到 B」会立刻看到上面那条 `the key changed` 错误。
- **两台上都要换**，且换完用 `systemctl cat magpie | grep MAGPIE_WEB_KEY` 核对**生效值**
  —— 下面的 `sed` 只匹配 `^Environment=MAGPIE_WEB_KEY=`，unit 若写成
  `Environment="MAGPIE_WEB_KEY=…"`（带引号）会**静默不生效**。
- ⚠ **key 的格式**：magpie 自己的提示是
  `MAGPIE_WEB_KEY takes letters, digits and - . _ ~ only (openssl rand -hex 16 makes one)`
  —— 即 **32 位 hex 也合法**。而本仓两条守卫写死了 `\d{18}`（这次事故的样本形态）。
  ⇒ **若按 magpie 建议生成 hex key，gitleaks 规则 ① 从此抓不到它的泄露。**
  改规则时按 magpie 的**校验口径**写（`[A-Za-z0-9._~-]{16,}`），不要只按这一次的样本写。

## 5. 为什么没有自动执行清史

`git push --force` 到 `main` 会重写所有协作者的历史，且无法回滚。
本 PR 是在无人值守的情况下完成的 —— 这种不可逆操作不该自动做。
按第 4 节命令执行，全程约 5 分钟。

## 6. 复盘：为什么没早发现

- CI 只有「离线单测 + 打包预演」，**对凭据零检查**；
- `.gitignore` 里当时**一条凭据规则都没有**，`git add -A` 想拦也拦不住；
- 发现靠人眼审查，而不是机器 —— 那意味着「被发现」依赖有人恰好翻到那几行。

三条都已经在上面补掉。真正值得记住的是最后一条：
**「与插件无关的东西不该进这个仓库」这条规矩，之前只存在于口头。**
