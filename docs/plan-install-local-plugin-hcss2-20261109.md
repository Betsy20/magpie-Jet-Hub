# 计划书：hcss2 改装本地插件（弃上游 GitHub 源）

日期：2026-11-09 · 触发：用户「把我的服务器安装我们本地的插件，不安装上游的了」

## 0. 现状（队长已核实）

- hcss2（1.95.121.143）`/opt/magpie/config/magpie/plugins/package.json`：
  `"magpie-jet-hub": "https://github.com/Betsy20/magpie-Jet-Hub"`；
  bun.lock 锁在 `github:Betsy20/magpie-Jet-Hub#9bf913d`（上游 commit，**不含**本仓未推送的修复）。
- 同目录 `dist/` 已有本地 tgz 先例：`@magpie-community/opencode-*-auth` 三家走
  `./dist/<name>-<ver>.tgz` —— 这就是「本地包」的既有安装形态，照搬。
- magpie 二进制有 `installed %d missing plugins again` 自愈逻辑 ⇒ **只覆盖
  node_modules 不改 package.json 会被装回上游**；必须改 manifest 指向本地 tgz。
- `magpie plugin add <path>` 支持本地路径；`magpie plugin update` 会装「最新版」
  ⇒ 改源后 update 也只会指向本地 tgz，不再碰 GitHub。
- 本地工作树（NAS `/mnt/workspace/Project/magpie-Jet-Hub`，含未 commit 的
  baizhi 拆分修复）打包体积约 23M（vendor 20M），tgz 压缩后预计 ~6M，可 scp。
- 根 package.json **无 postinstall/prepare**（vendor/package.json 的 prepare 只在
  上游源码构建跑，npm 装 tgz 不执行依赖的 prepare）⇒ tgz 安装无构建副作用。
- 服务：systemd `magpie.service`（Restart=always）；插件 host 是独立进程，
  装完需重启 magpie 让新包生效（网关 3425 会断几秒，用户日常在用，**低峰执行、快重启**）。

## 1. 方案（照 dist/ 先例）

1. **本地打包**（dev2 脚本化，落 NAS 可重复）：
   `npm pack --ignore-scripts` 于工作树 → `magpie-jet-hub-1.0.0.tgz`。
   pack 按 package.json `files` 白名单（index.mjs/src/vendor/page/console/docs/README/CHANGELOG/LICENSE）。
   ⚠️ 工作树有未 commit 改动 —— pack 取**工作树现状**（正是我们要的：含拆分修复）。
   tgz 落 NAS `/mnt/workspace/Project/magpie-Jet-Hub-dist/`（持久母本）。
2. **远端安装**（dev1 执行）：
   a. 备份远端 `plugins/package.json` + `bun.lock`（`.bak-20261109-local`）。
   b. scp tgz → `plugins/dist/magpie-jet-hub-1.0.0-local.tgz`。
   c. 改 manifest：`"magpie-jet-hub": "./dist/magpie-jet-hub-1.0.0-local.tgz"`（原子写）。
   d. 远端 `magpie plugin add ./dist/magpie-jet-hub-1.0.0-local.tgz`（或直接
      `bun install` 于 plugins 目录，二选一以 magpie CLI 为先；CLI 会维护 lock）。
      ⚠️ 远端 node 22.9 缺 zstd：magpie CLI 自带 bun（/opt/magpie/cache/magpie/bun/1.4.4/magpie-bun），
      用 CLI 不裸跑系统 node 装包。
   e. `systemctl restart magpie`（断流窗口 ≤10s）。
3. **核验**（队长）：
   - `plugins/package.json` 与 bun.lock 不再含 github.com/Betsy20；
   - `node_modules/magpie-jet-hub/console/console.js` 含 `formatBaizhiPoolSplit`（本地修复在）；
   - 网关 3425 TLS 200 + `/v1/models` 带 caller key 200；控制台 18500 `/__meta` 200；
   - `credits.balances baizhi` 读数仍 916.68/99.64/817.04 同形；
   - 真发一条 chat（caller key，小模型）200；
   - `magpie plugin update` **不跑**（避免节外生枝）；但确认 manifest 指向本地后
     自愈逻辑只会重装本地 tgz。
4. **回滚**：备份的 package.json/bun.lock + `magpie plugin add
   https://github.com/Betsy20/magpie-Jet-Hub` 可一键回上游（用户未要求则不做）。

## 2. 派单与文件所有权

- **dev1**（后台）：独占远端 hcss2 的 plugins 目录操作与重启；不写本地仓库文件。
- **dev2**（后台）：独占本地/NAS —— 写 `scripts/deploy-plugin-hcss2.sh`（幂等：
  pack→scp→备份→改 manifest→CLI add→restart→核验探针），打包母本落 NAS；
  不 ssh 执行安装（只备脚本），不写远端。
- 队长：核验 + 更新 AGENTS.md §12（插件源改本地）+ 记忆。

## 3. 验收底线

- 服务器插件 = 本地工作树打包（含 baizhi 拆分修复），manifest/lock 无 GitHub 源；
- 重启后网关/控制台/签到/模型调用全正常；
- 部署脚本幂等可重复（以后本地改完一条命令再部署）；
- AGENTS.md §12 与记忆同步「插件源=本地 tgz，勿再装上游」。

## 4. 最终结果（2026-11-09 晚，用户改口定稿）

用户决定**不用本地 tgz，改走 GitHub fork**：

- 本地提交 `35e6b70`（百智云拆分修复）已推到 `hnlinyh/magpie-Jet-Hub` 的
  `feat/vendor-sync-498a76e` 与 `main`（两者同 commit）；
- hcss2 插件源改为 `https://github.com/hnlinyh/magpie-Jet-Hub`（package.json 与
  plugins.json 同 URL），`bun install` 锁到 `github:hnlinyh/magpie-Jet-Hub#35e6b70`；
- 本文 §1-§2 的本地 tgz 方案作废，`scripts/deploy-plugin-hcss2.sh` 已重写为
  GitHub 流程（校验 fork main==HEAD → 改 manifest/spec → bun install → restart → 探针）；
- **事故教训**（已写进脚本头注释）：绝不能 `magpie plugin add <tarball>` 换源——
  会把 tarball 当插件 spec，重启时整个 jet-hub 加载失败、全模型 502。
