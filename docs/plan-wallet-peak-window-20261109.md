# 钱包型窗口补分母：历史水位 + 总额度行（2026-11-09）

用户请求（m01511）：「总额度也要有窗口」，附 magpie 用量卡截图：
4 个百智云账号行显示 `余额 699.96 credit | 充值积分 剩余 500 credit | 上限 90% | 每日积分 0 / 199.96 credit · 剩余 100%`。
即「充值积分」（长期积分）只有钱包语义（只写「剩余 N」、不画进度条），用户要它也带分母。

用户在选型问题里选了「总额度 + 充值积分 都加」。

## 上游事实（已在 `<部署实例>` 实测，本轮不改 vendor）

- `GET https://baizhi.cloud/api/v1/user/wallet/balance` 只回 6 个字段：
  `user_id, temporary_credit_cents, permanent_credit_cents, frozen_credit_cents,
  available_credit_cents, daily_temporary_credit_claimed`。**没有初始总额、没有累计充值**。
- ~45 个候选流水/订单端点全部 404；控制台 SPA 分包里也没有充值流水 API 字面量。
- 唯一可算的消耗数是 `app-credit-usage?period=month|year`，但它是**整月总消耗**（每日桶也含在内），
  反推期初会把其余天的每日消耗算进充值桶（vendor `baizhi-credits.js` 已写明不做反推）。
- ⇒ 分母只能**插件侧自采**：取该账号该池子「历史最高余额」（水位）。充值抬水位 = 窗口扩大，
  与用户对 MiniMax 的直觉（未过期包之和）同构，只是长期积分不过期 ⇒ 水位永不回落。

## magpie 渲染契约（0.1.3397，二进制 strings 实证）

- `quotaNoShare(w) = !!w.text || w.used == null || w.balance != null`
  ⇒ **给了 `balance` 就不画进度条**，只写「N left」。要进度条必须给 `used/amount/limit/display`。
- `quotaText`：`balance != null` → `{n} left`；否则 `display` + `剩余 N%`。
- 账号行 `accountQuotaLine`：`for (const w of ws.slice(0, 2))` ⇒ **内联最多 2 条窗口**，
  第 3 条起只进 tooltip（`line.title = ws.slice(2).map(...)`）。
- 合计行 `q.balance` 是独立 chip（`余额 <b>{q.balance}</b>`），与窗口并列、不占窗口位。

## 决定

1. **充值积分等钱包型窗口**：用「历史水位」当下限 ≥ 余额的分母，
   出 `X / Y credit` + 进度条（`used/amount/limit/display`，**不填 `balance`**）。
   - 首见时水位==余额 ⇒ `500 / 500 credit · 剩余 100%`（用户选的形状）。
   - 之后任何消耗都让分子低于分母；水位只涨不跌（充电/补发即抬）⇒ 不会再出现
     「分母跟着余额跑、永远 100%」那类假窗口。
2. **总额度**：不新增第三行窗口（会被挤进 tooltip，反而丢掉每日积分那一行），
   改为把分母写进合计行：`余额 699.96 / 749.96 credit`。
   仅当**至少一个池子的分母是自采水位**、且 ≥2 个同单位可用池子时启用，其它渠道保持原样。
3. **不改**单池子渠道的合计行；不改有上游真总额的配额；不改 MonkeyCode
   （它走「近 30 天收入当总窗口」，优先级更高，水位不参与）。

## 存储

沿用 `~/.config/magpie/jet-hub-daily-baseline.json`（env `JET_HUB_DAILY_BASELINE` 可覆盖），
条目加 `kind` 字段：

``json
{ "<provider>\u0000<acct>\u0000<池名>": { "kind": "daily", "day": "2026-11-09", "total": 199.96 },
  "p\u0000<provider>\u0000<acct>\u0000<池名>": { "kind": "peak", "day": "", "total": 500 } }
``

- 老文件（只有 `{day,total}`）一律按 `daily` 解析 ⇒ 现有 4 个百智云每日基线**不丢**。
- 落盘时：`peak` 条目永久保留；`daily` 条目只留当天。

## 验证

- `node tests/t-usage.mjs`：新增 10 条断言覆盖「白名单外的充值积分仍是钱包 / 首见 500·500 /
  消耗后 420·500 已用 16% / 充值后抬到 820·820 / 合计行 699.96·699.96 / 消耗后 520·699.96 /
  有窗口缺分母时不加 `/` / 只剩 aside 时不加 `/`」。
- 新增 `tests/t-baseline-store.mjs`：真读写临时磁盘，锁持久化契约。
- 反向验证（均已实测变红）：
  - 注释掉钱包水位分支 + 关掉合计行 ⇒ `t-usage.mjs` **8 红**；
  - 把 `saveDailyBaseline` 的保留条件改成只看 `day === today` ⇒ `t-baseline-store.mjs` **2 红**
    （落盘的水位跨天丢失、`kind` 不再是 peak）；
  - 让 `loadDailyBaseline` 丢弃无 `kind` 的老条目 ⇒ **1 红**（老文件兼容断言）。
  - ⚠️ 踩到的假绿：只读不写时水位根本不经过 `saveDailyBaseline` 的保留条件，反证不会变红。
    所以第 ② 组必须先刷一次每日桶触发落盘，才有判别力。
- `<部署实例>` 部署后核 `quotas.json` 实渲染（2026-11-09 22:13，commit `0f9bd7f`）：
  `{"name":"充值积分","used":0,"display":"500 / 500 credit","amount":500,"limit":500,"unit":"credit"}`
  （无 `balance`），合计行 `699.96 / 699.96 credit`；梨花不写诗为
  `650.39 / 650.39 credit` + 每日 `used:100`（已用光），合计行 `650.39 / 750.39 credit`。