# 2026-11-12 凭据与生产坐标泄露 —— 处置与根治

> 一句话：两个运维脚本把 **magpie web 面板的 18 位明文 key、两台生产服务器的公网
> IP + root 账号、服务器上私钥的绝对路径与文件名** 提交进了这个 public 仓库。
> 一个好消息：上游已经从源码里清掉了明文；一个坏消息：**fork 的 main 和历史里
> 至今仍可匿名下载，而那把 key 实测现在还能登进两个实例。**
> 代码层已经补上两道守卫；**换 key 与清史必须人工执行**（动线上配置和 force-push，
> 不适合无人值守自动做）。本文件只给可照抄的命令。

## 0. 先说结论

| 结论 | 证据 | 状态 |
|---|---|---|
| 泄露的面板 key **曾经仍然有效** | 带 key 请求 `https://<实例>:3430/?k=<key>` → **303** + 会话 cookie；不带 / 伪造 → **401** | ✅ **已轮换**（2026-11-13，两台均 401） |
| 它**不是**「未来会被利用」的风险，而是**当时可被登录** | 同一把 key 在**两个实例**上都返回 303（两机共用一把） | ✅ 已消除 |
| 会话 cookie **就是 key 本身** | cookie 值与 key 逐字符相同；故换 key 会同时作废所有旧会话 | ✅ 已利用这一点 |
| magpie **启动时把 key 明文写进日志** | `magpie.log` 启动横幅：`…/?k=<key>`，两台日志各有几十行 | ✅ 已清洗 |
| 上游 main **没有被明文 key 污染** | PR #31 合入的版本已在源码里改成环境变量注入 | — |
| fork main 头**已不可匿名下载** | `raw/…/main/scripts/deploy-plugin-*.sh` → **404** | ✅ 已删 |
| 但 fork **历史提交仍可下载** | 5 笔相关 commit 的 `.patch` 全部 **200**；`9003611` 含明文 key | ⚠️ 需清史 |
| 私钥**本体**从未进仓库 | `git log -S 'BEGIN OPENSSH PRIVATE KEY'` = 0 | — |

**处置顺序之所以是「先轮换、后清史」**：清史只让「以后下载不到」，
挡不住已经下载过的人 —— 而实测表明那把 key 当时就能登进去。

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
  8 条内容规则（IPv4 字面量 / PEM 私钥头 / `~/.ssh/<名>` 路径 / GitHub+AWS token
  前缀 / 硬编码 key / 主机别名 / 生产绝对路径 / 数据库连接串）+ 1 条结构规则
  （不许有 `scripts/deploy-*.sh`）。
  带 **18 条匹配器自检样本**：删任一条规则、或把正则改坏到永远不命中，自检立刻红。
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

## 3. 第一件事：轮换（最紧急）—— ✅ 2026-11-13 已执行

**历史清理之前、之后都不影响这一条 —— key 已公开两天多，按已泄露处理。**
这一步是唯一真正能「止损」的动作；其余都是防止复发。

> **执行结果**：两台实例已于 2026-11-13 02:00–02:02 完成轮换。
> 外网复测：旧 key `401`、新 key `303`，两台一致。旧 key 的备份残留与日志明文均已清零。
> 下面的步骤保留下来，供下次轮换照做；三个「以为换完了其实没换」的坑见本节末尾。

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

### 实测补充：三个会让人以为「换完了」其实没换的地方

**① 会话 cookie 就是 key 本身。**
登录后下发的 session cookie 值与 key **逐字符相同**。好消息：换 key 会同时让所有
旧会话失效（实测换完后旧 key 返回 401）。坏消息：任何人手上拿到的 cookie 等价于
一把 key，光看访问日志很难区分「持有 cookie」和「持有 key」。

**② magpie 启动时会把 key 明文写进日志横幅。**
每次启动都会打印 `magpie web on http://127.0.0.1:3430/?k=<key>` 与
`on the network https://<域名>:3430/?k=<key>` —— 实测两台机器的 `magpie.log` 里
各有几十行明文。**轮换后必须一并清洗**，否则旧 key 还躺在日志里：

```bash
K=$(systemctl show magpie -p Environment | tr ' ' '\n' | sed -n 's/^MAGPIE_WEB_KEY=//p')
sed -i "s|$K|***REDACTED***|g" /var/log/magpie.log
# 别忘 logrotate 出的旧档；也别留未清洗的 .presanitize 副本
grep -rlF -- "$K" /var/log/ 2>/dev/null
```

**③ 旧 key 还残留在备份文件里**（`/etc/systemd/system/magpie.service.bak-*`、
`/root/unit-backups-*/`、`/root/archive/*.md`）。它们不公开，但换 key 后应一并用
新值覆盖或删除，否则「轮换」只是前门换了锁、后门还留着备用钥匙：

```bash
for f in /etc/systemd/system/magpie.service.bak-* /root/unit-backups-*/* /root/archive/*.md; do
  [ -f "$f" ] && grep -qF -- "$OLD" "$f" && sed -i "s|$OLD|$NEW|g" "$f"
done
grep -rlF -- "$OLD" /etc/systemd /root 2>/dev/null   # 期望空
```

## 3.5 SSH 加固 —— [OK] 2026-11-13 已执行

轮换只堵了面板那一扇门。**泄露的还有两台机器的地址、`root` 账号、私钥路径**，
而两台机器的 sshd 当时都是 `PermitRootLogin yes` + `PasswordAuthentication yes`。

实测数据（切换前）：

| 机器 | 密码登录成功 | 密钥登录成功 | 密码爆破失败 |
|---|---|---|---|
| 实例 A | 0 | 2372 | 149,145 |
| 实例 B | 0 | — | 数千 |

- **密码登录从来没人用过**（0 次）⇒ 关掉不影响任何运维路径；
- **爆破量 15 万次** ⇒ 这扇门一直有人撞，只是还没撞开。

改动（两台一致）：

```
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
```

> ⚠️ 实例 A 上真正生效的是 `/etc/ssh/sshd_config.d/50-cloud-init.conf`（`Include`
> 在 sshd_config 顶部，dropin 优先）。只改主配置里的 `PasswordAuthentication`
> 会被它盖回去 —— 改完必须 `sshd -T | grep passwordauthentication` 复核。

验证（两台都做了）：
- 密钥登录：`ssh -o BatchMode=yes root@<host> echo OK` → `OK`（没把自己锁在外面）
- 密码登录：`ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no` →
  `Permission denied (publickey)`
- 业务无影响：`magpie` 服务 `active`，面板 `3430=401`，网关 `3425=200`

**还剩一条没做**：私钥文件名/路径仍是泄露的那一份。换名要同步改所有引用它的
脚本与 `~/.ssh/config`，建议下次专门做一次，别和这次混在一起。

## 4. 清史 -- [OK] 2026-11-13 已执行（**但没能让旧对象消失**）

已做：`git filter-repo` 把 5 个分支全部重写 —— 删掉 3 个运维文件、
把主机别名 / 服务器地址 / 部署路径替换成占位符，然后强推。

```
分支                   提交数   旧 key   IP 残留
main                     96       0        0
pr/merge-into-upstream   119      0        0
fix/repo-purity-guards   90       0        0
dsh-67d16554-e57c        —        0        0
feat/vendor-sync-498a76e —        0        0
```

`gitleaks git` 全历史扫描（29.7 MB）→ `no leaks found`。

### ⚠️ 但这条实测结论必须记下来：**重写分支指针 ≠ 删掉对象**

旧提交按 SHA 仍可匿名下载：

```
GET /hnlinyh/magpie-Jet-Hub/commit/9003611.patch          → 200（20 KB，含明文 key）
GET raw.githubusercontent.com/.../9003611/scripts/...sh   → 200（18 KB，含 IP/root/key）
```

原因：GitHub 对**已推送过的对象按 SHA 保留**，供 reflog / 缓存 / 网络查询使用。
分支指针没了，对象还在。**只有 GitHub 支持工单能真正删掉它**（见第 6 节）。

### 更要紧的：上游也有同一个对象

`Betsy20/magpie-Jet-Hub`（上游）上 `9003611.patch` 同样 **200**、同样含明文 key。
所以**即使把 fork 整个删掉，这个对象也不会消失** —— 处置只能靠「轮换 + 加固」，
不能指望清史。这一点决定了第 3 / 3.5 节才是真正的止损。

> 上游 `main` 的**当前内容**是干净的：那两个脚本已经被改成环境变量注入
> （`REMOTE_HOST="${REMOTE_HOST:?...}"`、`PROBE_WEB_KEY="..."`），
> 只有 `MANIFEST_KEY="magpie-jet-hub"` 还写死 —— 那是插件名，不是凭据。
> 即：**上游 tree 无秘密，上游历史有旧对象。**

```bash
# 在 fork（hnlinyh/magpie-Jet-Hub）的干净 clone 里做，不要在带未提交改动的目录做
git clone https://github.com/hnlinyh/magpie-Jet-Hub.git clean && cd clean
pip install git-filter-repo   # 或 brew install git-filter-repo

# 注意：--path 只吃字面路径，通配要写成 --path-glob。
git filter-repo --force --invert-paths \
  --path-glob 'scripts/deploy-plugin-*.sh' \
  --path-glob 'docs/plan-install-local-plugin-*.md'

# filter-repo 会主动删掉 origin 远程（防误推），推之前要加回来：
git remote add origin https://github.com/hnlinyh/magpie-Jet-Hub.git
git push --force origin main
```

清完之后验证：

```bash
# 期望：无输出。有输出就是没清干净。
git log --oneline --all -- "scripts/deploy-plugin-*.sh"
# 用本仓规则扫全历史，期望 no leaks found：
gitleaks git . --config .gitleaks.toml --redact
```

清史后**必须**做的收尾：
1. GitHub 上旧的 commit / PR / `.patch` 缓存可能仍可达 → 联系 GitHub Support
   请求清理缓存，或在仓库 Settings 里确认没有残留的公开 fork。
2. `pr/merge-into-upstream` 等分支需要 rebase 到新的 `main`，否则它们仍指向旧历史。
3. 上游 PR #31 的 diff 若引用了旧 commit，评论里说明「历史已重写」。
4. `history` job 变绿之后，把它的触发从 `schedule` 改成 `push`（那时它才是必过项）。

## 5. 清史是怎么执行的（保留步骤，供下次照做）

> ⚠️ 这是破坏性操作，会让所有克隆分叉。本次执行前确认过：
> 5 个分支都只有一个协作者，`main` 上无未合并的在途工作。

```bash
# 1 先做整份备份（含 .git），万一重写错了好回滚
cp -a magpie-Jet-Hub magpie-Jet-Hub.bak-preclean

# 2 全新 clone 上做，别在带未提交改动的目录里做
git clone https://github.com/<fork>.git clean-rewrite && cd clean-rewrite

# 3 两条一起给：--invert-paths 删文件，--replace-text 改内容
#   ⚠ --path 只吃字面路径，通配要写 --path-glob
git filter-repo --force \
  --invert-paths \
  --path 'scripts/deploy-plugin-<host>.sh' \
  --path 'docs/plan-install-local-plugin-<host>-20261109.md' \
  --replace-text /tmp/replace.txt

# 4 验证三件事，缺一不可
gitleaks git . --config .gitleaks.toml --redact   # 期望 no leaks found
git log --all -S"<旧key>" --oneline | wc -l       # 期望 0
git log --all -S"<旧 IP>" --oneline | wc -l        # 期望 0

# 5 每个分支分别强推（filter-repo 会删掉 remote，要重新 add）
for b in main pr/merge-into-upstream fix/...; do
  git push --force origin "$b:$b"
done
```

`--replace-text` 的文件格式是 `匹配串==>替换值`，一行一条，长串写前面。

**踩到的两个坑**：
1. `filter-repo` 结束会**删掉 `origin` remote**（防止误推），后续 push 前要
   `git remote add origin ...` 重新加；
2. 只重写 `main` 不够 —— 分叉的 feature 分支同样带着旧对象。本次是逐个分支
   比对 `git log -S` 才找全 5 个。

## 6. 复盘：为什么没早发现

- CI 只有「离线单测 + 打包预演」，**对凭据零检查**；
- `.gitignore` 里当时**一条凭据规则都没有**，`git add -A` 想拦也拦不住；
- 发现靠人眼审查，而不是机器 —— 那意味着「被发现」依赖有人恰好翻到那几行。

三条都已经在上面补掉。真正值得记住的是最后一条：
**「与插件无关的东西不该进这个仓库」这条规矩，之前只存在于口头。**

## 7. 唯一剩下的外部动作：让 GitHub 删除旧对象

分支重写后旧对象仍按 SHA 可达（第 4 节实测）。**仓库侧没有任何操作能删掉它** ——
这是 GitHub 的服务端行为，只能走工单。

要提交的信息（模板）：

```
Repository: hnlinyh/magpie-Jet-Hub (public fork)
Parent repo also affected: Betsy20/magpie-Jet-Hub
Exposed object: 9003611a92695ab30f3ec41fcef21674bd14e725

A private SSH deploy script was committed with:
  - a live web-console access key
  - two production server IPs with root SSH access
  - the private key path used for that access
The script has been removed and all branch refs rewritten (git filter-repo),
but the blob is still served at:
  https://github.com/hnlinyh/magpie-Jet-Hub/commit/9003611.patch
  https://raw.githubusercontent.com/hnlinyh/magpie-Jet-Hub/9003611/scripts/...

Request: please purge this unreachable object (and its caches) so the URLs 404.

Mitigations already applied: key rotated on both hosts (old key -> 401),
password SSH disabled, backup/log copies of the key overwritten.
```

工单路径：<https://support.github.com/contact> → *Repository removal* /
*Sensitive data*。GitHub 通常要求**先轮换凭据**才处理 —— 这一点已经满足。

**在工单处理完之前，不要把「已清史」当成「已止损」**：前者只是让分支上看不到，
后者只能靠第 3 / 3.5 节的轮换与加固。
