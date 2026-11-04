/**
 * 百智云（BaiZhiCloud）**控制台**积分读取与网页登录态换 Key。
 *
 * ## 为什么这个模块存在（2026-11-02 用户报障后重做）
 *
 * 第一版 baizhi provider 的结论是「百智云按量计费、没有积分」，理由是
 * **模型网关** `https://ai-models.app.baizhi.cloud` 上除了
 * `/api/anthropic/v1/models` 与 `/api/anthropic/v1/messages` 之外全部 404
 * （`{"type":"error","error":{"type":"invalid_request_error","message":"Gateway 路由不存在"}}`）。
 * 那个实测是**真的**，但结论错了 —— 积分不在网关，在**主站控制台**
 * `https://baizhi.cloud`，而且只认网页登录态 cookie。
 *
 * 用户截图（控制台 → 钱包）证明存在一套完整积分体系：
 * 可用积分 235.05、每日积分 98.21（零点过期）、充值积分 136.84（长期有效）、
 * 今日/本月消耗 364.95、调用次数 31、「模型商店」占比 100%。
 *
 * 实测对齐（2026-11-02，真实账号）：
 * - `GET /api/v1/user/wallet/balance` →
 *   `{"code":0,"message":"success","data":{"user_id":187965886890053,
 *     "temporary_credit_cents":9821,"permanent_credit_cents":13684,
 *     "frozen_credit_cents":0,"available_credit_cents":23505,
 *     "daily_temporary_credit_claimed":true}}`
 *   ⇒ 单位是 **1/100 积分**（9821 → 98.21、23505 → 235.05），与截图逐位吻合。
 * - `GET /api/v1/user/wallet/app-credit-usage?period=month` →
 *   `{"items":[{"period":"2026-11-02","app_id":22,"call_count":31,
 *     "credit":364.95,"credit_ratio":1}]}`
 *   ⇒ 调用次数 31、消耗 364.95 与截图完全一致。`period` 只认
 *   `week` / `month` / `year`（`today`/`all`/`day` 全 400「参数错误」）。
 * - `GET /api/v1/user/api-keys` → `{"items":[{"id":…,"name":"demo-user",
 *   "key":"sk-…","created_at":…}]}` ⇒ **网页登录后可以自动取到 sk- Key**，
 *   不需要用户手抄。
 * - `POST /api/v1/user/wallet/daily-temporary-credit` → 每日临时积分领取。
 *   2026-11-02 首次实测时直接 POST 得 400 `captcha binding mismatch`；2026-11-03
 *   补全 Cap 验证码流程（`challenge → 本地 PoW → redeem`）后实测 HTTP 200：
 *   `{"code":0,"message":"success","data":{"claimed":false,"amount_credit_cents":10000,
 *   "expires_at":"2026-11-04T00:00:00+08:00"}}`（`claimed:false` = 当日已领过；
 *   首次领取应为 `true`）。签到入口就是控制台顶栏「每日领积分 +100」按钮。
 *
 * ## 两套凭据（关键）
 *
 * | 用途 | 凭据 | 认证头 |
 * |---|---|---|
 * | 发消息（`ai-models.app.baizhi.cloud`） | `sk-…` | `x-api-key` |
 * | 积分 / 用量 / Key 列表（`baizhi.cloud`） | 网页登录态 | `cookie` |
 *
 * `x-api-key` 打控制台接口一律 401；cookie 打模型网关同样不行。所以
 * 「只有 sk- 的账号能发消息但看不到积分」不是 bug，是两套凭据的分工 ——
 * 本模块的作用就是让浏览器登录顺手把 cookie 也存下来。
 *
 * @module src/baizhi-credits.ts
 */
import type { ClaimOutcome, CreditBalance } from './credits.js';
import type { BaizhiCredential } from './baizhi.js';
import { type BaizhiProduct } from './baizhi-product.js';
/** 控制台会话 cookie 名（`baizhi.cloud` 上实测有两枚，两枚都要带）。 */
export declare const BAIZHI_SESSION_COOKIE_NAME = "baizhi_session";
/** 控制台签到/登录态里那枚 `sl-session`（与 `baizhi_session` 同时下发）。 */
export declare const BAIZHI_SL_SESSION_COOKIE_NAME = "sl-session";
/**
 * 控制台请求的可注入依赖。
 *
 * ⚠️ `fetchImpl` 只给单测用：本仓红线是「单测不许发真网络」。
 */
export interface BaizhiCreditsDeps {
    readonly fetchImpl?: typeof fetch;
    /** 非致命问题的提示出口。 */
    readonly warn?: (message: string) => void;
}
/** 积分余额（已从「分」换算成积分）。 */
export interface BaizhiWallet {
    /** 控制台用户 id（数字）。 */
    readonly userId?: number;
    /** 当前可用积分（temporary + permanent - frozen）。 */
    readonly available: number;
    /** 每日积分（**零点过期**）。 */
    readonly temporary: number;
    /** 充值积分（**长期有效**）。 */
    readonly permanent: number;
    /** 冻结积分。 */
    readonly frozen: number;
    /** 今天是否已领取每日积分。 */
    readonly dailyClaimed: boolean;
}
/** 用量明细里的一天 / 一个周期。 */
export interface BaizhiUsageItem {
    /** `2026-11-02`（按天）或 `2026-11`（按年查询时按月聚合）。 */
    readonly period: string;
    /** 服务 id（`22` = 模型商店）。 */
    readonly appId: number;
    /** 调用次数。 */
    readonly callCount: number;
    /** 消耗积分。 */
    readonly credit: number;
    /** 该服务占比（0~1）。 */
    readonly creditRatio: number;
}
/** 用量汇总。 */
export interface BaizhiUsage {
    readonly items: readonly BaizhiUsageItem[];
    /** 今天的消耗积分之和。 */
    readonly todayCredit: number;
    /** 今天的调用次数之和。 */
    readonly todayCalls: number;
    /** 本月（`period=month`）的消耗积分之和。 */
    readonly monthCredit: number;
    /** 本月的调用次数之和。 */
    readonly monthCalls: number;
}
/**
 * 把凭据里的 `session_cookie` 归一成可直接放进 `Cookie` 头的字符串。
 *
 * ⚠️ 2026-11-02 三审 F🟢-6：逻辑已抽到 `src/session-cookie.ts`（与 MonkeyCode 共用）。
 * 本处只保留两个**本平台差异**：认两个 cookie 名（`baizhi_session` / `sl-session`），
 * 裸值时补前者。
 */
export declare function normalizeBaizhiCookie(raw: string | undefined): string | undefined;
/** 读积分余额。 */
export declare function fetchBaizhiWallet(credential: BaizhiCredential, product?: BaizhiProduct, deps?: BaizhiCreditsDeps): Promise<{
    readonly ok: true;
    readonly wallet: BaizhiWallet;
} | {
    readonly ok: false;
    readonly error: string;
}>;
/** 用量周期。上游只认这三个（其余 400）。 */
export type BaizhiUsagePeriod = 'week' | 'month' | 'year';
/** 读用量明细。 */
export declare function fetchBaizhiUsage(credential: BaizhiCredential, period?: BaizhiUsagePeriod, product?: BaizhiProduct, deps?: BaizhiCreditsDeps): Promise<{
    readonly ok: true;
    readonly usage: BaizhiUsage;
} | {
    readonly ok: false;
    readonly error: string;
}>;
/**
 * 把钱包 + 用量拼成面板要的 `CreditBalance`。
 *
 * 三个包分别对应控制台钱包页的三行数字：
 * - 「可用积分」= available（主行口径）；
 * - 「每日积分」= temporary（`cycleEndTime` 留空：上游只给「零点过期」这种
 *   说法，不给时刻，编一个时间会让面板显示假倒计时）；
 * - 「充值积分」= permanent（长期有效 ⇒ 无到期字段）。
 */
export declare function buildBaizhiBalance(wallet: BaizhiWallet, usage: BaizhiUsage | undefined): CreditBalance;
/**
 * `ProviderCredits.fetchBalanceDetailed` 的实现。
 *
 * 用量是**附加信息**：读失败不影响余额展示（只 warn），否则一次 500 就会让
 * 用户彻底看不到积分。
 */
export declare function fetchBaizhiBalanceDetailed(credential: BaizhiCredential, product?: BaizhiProduct, deps?: BaizhiCreditsDeps): Promise<{
    readonly balance: CreditBalance | null;
    readonly error?: string;
}>;
/** 网页登录态换出来的 API Key。 */
export interface BaizhiIssuedKey {
    readonly apiKey: string;
    readonly keyName?: string;
    readonly userId?: string;
}
/**
 * 用控制台网页登录态换 `sk-` API Key（**浏览器登录的最后一环**）。
 *
 * ⚠️ 打的是**大模型商店**的 console 接口：
 * `GET https://ai-models.app.baizhi.cloud/api/console/api-keys`（cookie 认证），
 * 响应 `{"items":[{"id":…,"name":"demo-account","api_key":"sk-…","status":"active"}]}`。
 *
 * ⚠️ 2026-11-03 合并审计更正：本节原写「`GET /api/v1/user/api-keys` 返回
 * `items[].key`」——那是**控制台**（`baizhi.cloud`）的接口，只发 `bzy_` 前缀的
 * Key（15 位），拿它打模型网关恒 401「API Key 无效」。真正的推理 Key 是
 * console 接口下发的 `sk-…`，字段名是 **`api_key`**（下划线）而不是 `key`。
 *
 * ⇒ 用户只要在浏览器里登进控制台，插件就能自动建号，不需要手抄 Key。
 *
 * 一个账号可以有多把 Key：取**第一把 `status === 'active'` 的**（列表按创建
 * 时间倒序，第一把就是用户最近用的那把；停用/删除的跳过）。没有可用 Key 时
 * 返回可行动的提示 —— 用户需要先去控制台「API Keys」页点一次「新建」。
 */
export declare function exchangeBaizhiSessionForKey(sessionCookie: string, product?: BaizhiProduct, deps?: BaizhiCreditsDeps): Promise<{
    readonly ok: true;
    readonly key: BaizhiIssuedKey;
} | {
    readonly ok: false;
    readonly error: string;
}>;
/** 控制台用户资料（登录后用于显示昵称）。 */
export declare function fetchBaizhiProfile(sessionCookie: string, product?: BaizhiProduct, deps?: BaizhiCreditsDeps): Promise<{
    readonly ok: true;
    readonly userId?: string;
    readonly name?: string;
} | {
    readonly ok: false;
    readonly error: string;
}>;
/**
 * 一键领取每日临时积分：`challenge → 本地求解 → redeem → daily-temporary-credit`。
 *
 * ## 来源（2026-11-03 真机取证）
 *
 * 签到入口是控制台顶栏的「每日领积分 +100」按钮（`daily_temporary_credit_claimed
 * === false` 时才渲染），不是独立签到页。点一次走四步：
 *
 * 1. `GET /api/v1/user/wallet/balance`（本函数用作**幂等预检**）；
 * 2. `POST /api/v1/public/captcha/challenge` → `{token, challenge:{c,s,d}}`；
 * 3. 本地解 Cap PoW（与 MonkeyCode 同协议，见 `src/cap-pow.ts`）；
 * 4. `POST /api/v1/public/captcha/redeem` → `{token:'<8hex>:<15hex>'}`；
 * 5. `POST /api/v1/user/wallet/daily-temporary-credit` `{captcha_token}` →
 *    `{claimed:true, amount_credit_cents:10000, expires_at:'…+08:00'}`（100 积分）。
 *
 * ## 幂等
 *
 * 先读钱包的 `daily_temporary_credit_claimed`：已领 ⇒ 直接 `already-claimed`，
 * **不发 PoW、不发写请求**。即便预检与领取之间被别人抢先，领取响应里的
 * `claimed:false` 也会被翻译成 `already-claimed`（不是失败）。
 *
 * ⚠️ `precheckStatus: false`：预检已在本函数内部完成，外部再查一次就是
 * 同一端点打两遍（与 MonkeyCode 同型）。
 */
export declare function claimBaizhiDailyCheckin(credential: BaizhiCredential, product?: BaizhiProduct, deps?: BaizhiCreditsDeps): Promise<ClaimOutcome>;
//# sourceMappingURL=baizhi-credits.d.ts.map