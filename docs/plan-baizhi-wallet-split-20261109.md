# 计划书：百智云窗口积分拆分显示（每日 / 长期）

日期：2026-11-09 · 分支：`feat/vendor-sync-498a76e` · 触发：用户截图报障

## 0. 报障与截图口径

用户截图（百智云官方控制台 → 钱包）：

```
当前可用积分 916.68
每日积分     99.64  | 零点过期
充值积分    817.04  | 长期有效
```

用户原话：「百智云窗口显示的不对分为每日和长期」——我们的窗口（Jet Hub 控制台
账号卡「积分」行）只显示合计 916.68，没有像官方钱包那样拆成「每日（零点过期）」
与「长期」两档。

## 1. 核实结论（队长已亲查，施工前事实）

1. **数据层已拆分，缺口纯在显示层。**
   - `vendor/lib/baizhi-credits.js:249 buildBaizhiBalance` 已产出两个资源包：
     `每日积分`（remaining=wallet.temporary，expiryNote「每日 00:00（UTC+8）过期」）
     与 `充值积分`（remaining=wallet.permanent，「长期有效」）；冻结额另走非 active 包。
   - 接线：`vendor/lib/provider-credits.js:987` → `fetchBaizhiBalanceDetailed`；
     `credits.balances` handler（`vendor/lib/jet-hub-rpc.js` collectCreditBalances）
     把 `balance` **原样透传**（含 `packages`）。⇒ RPC 回包里拆分数据一直在。
2. **console 显示层把拆分丢了。**
   - `console/console.js loadBalances`（:283）只摊 `total / expiringTotal / expiredTotal`；
     baizhi 不下发 `expiringTotal` ⇒ 卡片（:409 creditDd）只剩合计一个数。
   - 积分面板 `creditsBalances`（:1362）走 `renderGeneric` ⇒ packages 被 JSON.stringify
     成一坨原始 JSON，不可读。
   - 当年「不复刻上游分桶」的注释（:266-281）针对的是**通用三档（永久/长期/临期）**，
     怕的是给余数贴「长期」误导；本次是用户点名要 baizhi 的每日/长期拆分，且上游
     客户端对**同一份 packages** 本就有现成渲染口径（见下），照搬最小语义即可，
     不违背该注释的初衷（通用渠道行为保持不变）。
3. **上游现成口径**（`vendor/lib/client/jet-hub.js:4795-4817`）：
   - `DAILY_POOL_NAMES = ['每日赠送','每日积分']`，**精确相等**匹配每日桶；
   - `formatPoolSplitLine`：`长期 ${restSum} · 每日 ${daily.remaining}`，
     restSum = 其余 **active** 包的正 remaining 之和（冻结包 active=false 自然排除）。
4. **vendor 不动。** vendor 是上游快照（docs/vendor.md：1128 逐字节一致 + 10 补丁），
   本次纯本仓 console 层改动，不新增 vendor 差异。
5. **部署即生效，无需重启 magpie。** 控制台静态文件每请求读盘、`cache-control: no-store`
   （`src/hub-server.mjs:208-211`）。hcss2 插件目录覆盖 console 两文件后浏览器硬刷新即可。
6. **实机核验路径**：hcss2（<服务器地址>）plugin-host 控制台 `127.0.0.1:18500`
   （`/__meta` 验活）；SSH 母本见 /mnt/workspace/AGENTS.md §12；远端跑 node 用
   `/opt/magpie/cache/magpie/bun/1.4.4/magpie-bun`（远端 node 22.9 缺 zstd）。

## 2. 改动设计（dev1 独占写）

### 2.1 `console/console.js`

新增**顶层纯函数** `formatBaizhiPoolSplit(packages)`（放在 loadBalances 上方，
注释注明口径来源 `vendor/lib/client/jet-hub.js:4795` DAILY_POOL_NAMES /
formatPoolSplitLine，以及「只复刻每日桶这一最小语义，通用三档仍不碰」）：

```js
const BAIZHI_DAILY_POOL_NAMES = ['每日赠送', '每日积分']  // 与上游逐字一致
function formatBaizhiPoolSplit(packages) {
  // 非数组 / 找不到每日桶 ⇒ null（调用方回退旧渲染，绝不编造）
  // daily = packages.find(p => BAIZHI_DAILY_POOL_NAMES.includes(p.name))
  // rest  = 其余 active===true 包的正有限 remaining 之和
  // 返回 { daily, rest, note }：note = daily.expiryNote（如「每日 00:00（UTC+8）过期」/
  //       「今日尚未领取（每日 +100）」），缺失时 ''
  // 数值不在这里格式化（调用方用 formatCreditAmount，与客户端 formatCredits 同形）
}
```

- `loadBalances`：签名加第 4 参 `known`（`loadBalances(provider, prefetched, force, splitPools)`，
  仅 `provider === 'baizhi'` 时消费）。成功行（b 为对象）调
  `formatBaizhiPoolSplit(b.packages)`，结果存 `split`（null 或对象）。
  失败行 / 无 packages / 无每日桶 ⇒ `split: null`。**现有字段与语义一律不变**
  （total/temp/expired/long/error/stale 的既有断言必须全绿）。
- 三个调用点传 provider 即可（函数内部自判 baizhi，调用点可不传第 4 参——
  二选一，dev1 定，但要保持「切渠道守卫」现状不变）。
- `renderAccounts` creditDd：`bal.split` 存在时，在合计后渲染
  `<span class="creditPoolPart">长期 ${formatCreditAmount(rest)} · 每日 <span class="creditExpire" title="${esc(note)}">${formatCreditAmount(daily)}</span></span>`；
  note 非默认过期口径（未领取/超额/未知）时直接缀在每日数后（小字），不藏 title。
  `split` 为 null 时**逐字回退**现有渲染（其余/临期/已失效/旧 标记都不动）。
- 注释密度与现有风格一致（坑位注释、上游行号引用）。

### 2.2 `console/console.css`

优先复用 `.creditPoolPart` / `.creditExpire`；如需新类（例如 `.creditSplitNote`）
只加最小规则，配色沿用现有变量（--orange-ink / --fg2 / --fg3）。

### 2.3 不做

- 不动 vendor/、src/、page/；不动通用渠道渲染；不做钱包深色卡片大改版
  （用户要的是拆分读数，不是换肤）；不编造分母/到期时刻（vendor 已审计过的边界
  原样消费：totalKnown=false 不显示分母、dailyPending 文案直显）。

## 3. 测试设计（dev2 独占写 `tests/t-console-baizhi-split.mjs` + `scripts/test-all.mjs` UNIT 列表 + `docs/testing.md` 表格行）

风格照 `tests/t-console-credits.mjs`：**从真源码抽函数求值**（sliceFn + new Function
harness，不复制粘贴实现），断言条数自数。

1. **口径真值源对账**：从 `vendor/lib/client/jet-hub.js` 抽 `DAILY_POOL_NAMES` 字面量，
   与 console 侧常量逐字相等（防两侧分叉）。
2. **真 builder 喂真形状**：直接 import `vendor/lib/baizhi-credits.js buildBaizhiBalance`，
   用截图同形钱包 `{available:916.68, temporary:99.64, permanent:817.04, frozen:0,
   dailyClaimed:true}` 产 packages ⇒ 抽出的 `formatBaizhiPoolSplit` 得
   `{daily:99.64, rest:817.04}`。
3. 边界（builder 已审计语义必须穿透）：
   - 未领取 `{dailyClaimed:false, temporary:0}` ⇒ daily=0 且 note 含「今日尚未领取」；
   - 超额 temporary=150 ⇒ note 含「总额不可知」，不显示假分母；
   - 标记缺失 `{temporary:0}`（dailyClaimed undefined）⇒ note 含「未知」；
   - frozen>0 ⇒ 冻结包 active=false，**rest 不含冻结**；
   - postpaid（billingMode='postpaid'）⇒ 无每日桶 ⇒ null（回退旧渲染）；
   - packages 缺失 / 非数组 / 空数组 ⇒ null。
4. **loadBalances 穿透**：harness 喂 `{accounts:[{accountId, balance: buildBaizhiBalance(...)}]}`
   ⇒ BAL 行 `split.daily===99.64 && split.rest===817.04`；同 harness 喂无 packages 的
   通用渠道形状 ⇒ split=null 且旧字段断言（total/temp/long/expired/stale）不变。
5. **渲染串**：抽 creditDd 相关片段或整 renderAccounts 太重 ⇒ 退而断言
   `formatBaizhiPoolSplit` + `formatCreditAmount` 组合串等于 `长期 817.04 · 每日 99.64`
   （formatCreditAmount 也从源码抽）；并源码级断言 renderAccounts 消费了 `bal.split`
   且 null 分支保留旧串（indexOf 定位，防静默丢渲染）。
6. 注册进 `scripts/test-all.mjs` UNIT；`docs/testing.md` 表格补一行。

## 4. 派单与文件所有权（防打架，记忆教训）

- **dev1**（后台）：独占 `console/console.js`、`console/console.css`。
- **dev2**（后台）：独占 `tests/t-console-baizhi-split.mjs`、`scripts/test-all.mjs`、
  `docs/testing.md`。测试按 §2 契约写，**不等 dev1**；若跑红（dev1 未落地）记录即可。
- 两人互不写对方文件；计划书只读。

## 5. 队长核验（两 dev 完成后）

1. 读 diff：契约符合 §2；vendor 零改动（`git status` 核对）。
2. `node scripts/test-all.mjs` 全绿（含新用例；t-console-credits 旧断言不红）。
3. **实机**：SSH hcss2，备份远端 `console/console.js|css`（`.bak-20261109-split`）后
   覆盖两文件（no-store，无需重启）；远端 CDP（magpie-bun + 系统 chromium/headless，
   若无浏览器则退化为 RPC 形状核验 + 本地 DOM 桩截图）打开 18500 控制台 → baizhi
   账号卡，断言 DOM 出现「长期 817.04 · 每日 99.64」同形拆分（数以实机钱包为准，
   与用户截图逐位对照）；截图存 docs/ 或 /tmp 归档供用户复核。
4. 不 commit / 不 push（用户未发话）；不建 PR。

## 6. 验收底线

- 卡片积分行：合计 + 「长期 X · 每日 Y」，每日带零点过期口径；未领取等边界文案直显。
- 通用渠道（无每日桶）渲染逐字不变；stale/查不到 语义不变。
- 新测试进全量套件且全绿；vendor 差异清单不增项。