/**
 * MonkeyCode 的**平台侧读数**：积分余额 / 每日额度 / 订阅档位 / 每日签到。
 *
 * ## 为什么这些读数走「平台 API + 网页会话」，而不是走推理用的 API Key
 *
 * MonkeyCode 有**两套完全不同的凭据**：
 *
 * | 用途 | 凭据 | 认证方式 |
 * |---|---|---|
 * | 推理（Anthropic Messages） | 白泽 `sk-…` / 网关 `oma_…` + `signing_secret` | `x-api-key` / HMAC 签名头 |
 * | 余额 / 额度 / 签到 | 网页登录态 `monkeycode_ai_session==…` | **Cookie** |
 *
 * 平台的 `/api/v1/users/*` 系列**不接受 API Key**（实测带 `x-api-key` / `Authorization`
 * 一律 401），只认网页 Cookie。这与 modelscope / codely 那种「同一个 Key 既能推理
 * 又能读余额」的形态不同，故 `MonkeycodeCredential` 里额外有 `session_cookie`。
 *
 * ⚠️ 因此本模块的每个入口都**必须先判 `session_cookie` 是否配置**：
 * 「没配会话」和「会话失效」是两件事，用户动作也不同（去补会话 vs 去重新登录）。
 * 把前者报成后者会让人以为自己的 Cookie 坏了。**绝不抛错**，一律降级成
 * 一句能行动的说明（`fetchBalanceDetailed` 的 `error` / `ClaimOutcome` 的 `failed`）。
 *
 * ⚠️ 「补会话」的主路径是「浏览器登录」，不是手工粘贴：该 cookie 是 **HttpOnly**，
 * `document.cookie` 读不到（四审自查修正了本段原写的「去粘贴」）。
 *
 * ## 计费口径（为什么余额要除以 1000）
 *
 * 平台下发的 `balance` 单位是**千分之一积分**（网页前端也是 `/1000` 显示），
 * 直接用会显示成「12500 积分」而实际是 12.5 —— 差三个数量级。换算只在本模块
 * 做一次，`CreditBalance.total` 一律是**积分**（`unit: 'credit'`）。
 *
 * `daily_token_balance` / `daily_token_limit` 是**计费 token**（`unit: 'token'`），
 * 与积分**不可互相折算** —— 计费 token 的折算规则见 `SPEC-monkeycode-provider.md`：
 * `(input + cache_read + 10 × output) × 1.5`，额度耗尽后按 `1 积分 = 5000 计费 token`
 * 转扣积分。⚠️ 但那是**上游的扣费规则**，本模块**不参与换算**，只如实回传两个读数
 * ——前端按单位分组并列显示（`credits-format.js` 的 `normalizeUnit`），
 * 跨量纲求和会让「12.5 积分 / 800 万 token」变成一个没有意义的数字。
 *
 * ## 每日签到：为什么要在本地解 PoW
 *
 * 签到接口要先过一道**人机验证**（captcha），但它不是图形码，而是
 * 「挑战 → 本地求解 → 兑换」的 proof-of-work：
 *
 *     POST /api/v1/public/captcha/challenge  → { token, challenge: { c, s, d } }
 *     （本地求解 c 道题，约 0.1s）
 *     POST /api/v1/public/captcha/redeem     → { token: '<8hex>:<15hex>', success }
 *     POST /api/v1/users/wallet/checkin      { captcha_token: <上一步的 token> }
 *
 * 求解算法见 {@link solveChallenge}（与平台前端逐字节同构，`fnv1a32` 派生 PRNG +
 * SHA-256 前缀碰撞）。⚠️ 这里是**纯计算**，没有任何规避行为：题目就是让你算的，
 * 网页版也是浏览器里算。
 *
 * @module src/monkeycode-credits.ts
 */
import { prng, solveChallenge, solveChallengeYielding } from './cap-pow.js';
import type { CheckinStatus, ClaimOutcome, CreditBalance } from './credits.js';
import { type MonkeycodeProduct } from './monkeycode-product.js';
import type { MonkeycodeCredential } from './monkeycode.js';
import type { RpcCreditsBalanceExtra } from './types.js';
export { prng, solveChallenge, solveChallengeYielding };
/** 订阅档位。只认这三个值，其余一律当「档位未知」（不猜）。 */
export type MonkeycodePlan = 'basic' | 'pro' | 'ultra';
/**
 * 平台请求的可注入依赖。
 *
 * ⚠️ `fetchImpl` 是给单测用的：本仓的红线是「单测不许发真网络」。
 * 生产不传 ⇒ 用全局 `fetch`（与其余 provider 的 credits 模块同形）。
 */
export interface MonkeycodeCreditsDeps {
    readonly fetchImpl?: typeof fetch;
    /** 非致命问题（如订阅档位读取失败）的提示出口。 */
    readonly warn?: (message: string) => void;
}
/**
 * 该失败是「会话还没生效」（401/403），而不是真的出错。
 *
 * ⚠️⚠️ 这个区分是**必需**的（2026-11-02 真机踩到）：网页登录窗口一打开，
 * `monkeycode_ai_session` **立刻**就存在（服务端下发的匿名会话），所以
 * 「读到了 cookie」绝不等于「用户已经登进去」。拿它去换 Key 必然 401；
 * 此时必须**继续等**用户真正登录，而不是当场判「会话已失效」。
 */
export declare function isMonkeycodeSessionExpiredError(message: string): boolean;
/**
 * 用**网页登录态**换到的一对网关凭据。
 *
 * ⚠️ `signingSecret` 与 `apiKey` 是**两个独立的东西**（exe 内文档原文：
 * 「顶层 api_key 是与模型无关的共享认证凭据，signing_secret 是独立的 Prompt
 * 签名凭据」）—— 少了后者，每个网关请求都会 403 `invalid ohmyagent request`。
 */
export interface MonkeycodeIssuedKey {
    /** 网关 API Key（`oma_…`，36 位）。 */
    readonly apiKey: string;
    /** 请求签名密钥（48 位）。 */
    readonly signingSecret: string;
    /**
     * **这把 Key 的记录 id**（诊断用）。
     *
     * ⚠️ 它**不是**平台用户 id（每次兑换都变），**不得**写入凭据的 `user_id`。
     * 稳定身份见 {@link MonkeycodeProfile.userId}。
     */
    readonly keyId?: string;
    /** 签发时间（**秒**，上游原样返回；毫秒换算由调用方按契约做）。 */
    readonly createdAt?: number;
}
/**
 * 用网页会话 cookie 换一对网关凭据（浏览器登录的**最后一跳**）。
 *
 * 上游是 `POST /api/v1/users/ohmyagent/api-keys`（body `{}`，Cookie 认证）：
 * 成功回 `{ id, api_key, signing_secret, created_at }`，GET 同路径是 404。
 *
 * ⚠️⚠️ **返回里的 `id` 是「这把 API Key 的记录 id」，不是平台用户 id**
 * （2026-11-03 真机取证：同一账号连续兑换两次得到 `2b37a3dd-…` 与 `0848857d-…`
 * 两个不同 id，而 `GET /api/v1/users/status` 的 `data.user.id` 恒为
 * `01a19fa3-…`）。把它当账号身份写入 `user_id` 会让「同一账号第二次浏览器登录
 * 必然被判成新账号」（每登一次多一张卡 + 多签发一把 Key）。
 * ⇒ 本函数只回 `keyId`（诊断用）；稳定的 `user_id` 必须走
 * {@link fetchMonkeycodeProfile}。
 *
 * ⚠️ **不抛错**：这与本模块其余入口同口径 —— 兑换失败只是「这次登录没拿到
 * 网关凭据」，调用方可以退回到「只有会话、没有 key」的状态（额度与签到照样能用），
 * 不该让整个账号创建失败。
 *
 * ⚠️ 兑换**每次都签发新的一对**（上游没有幂等键），所以只在登录流程里调一次，
 * 不要在续期/刷新里反复调 —— 那会在用户账号下堆一长串 key。
 */
export declare function exchangeMonkeycodeSessionForKey(sessionCookie: string, deps?: MonkeycodeCreditsDeps, product?: MonkeycodeProduct): Promise<{
    readonly ok: true;
    readonly key: MonkeycodeIssuedKey;
} | {
    readonly ok: false;
    readonly error: string;
}>;
/** 平台用户资料（稳定身份 + 昵称 + 邀请链接所需的用户 id）。 */
export interface MonkeycodeProfile {
    /** 平台用户 id（`data.user.id`，同一账号恒定）。 */
    readonly userId?: string;
    /** 昵称（`data.user.nickname`，作展现名用）。 */
    readonly nickname?: string;
}
/**
 * 读平台用户资料：`GET /api/v1/users/status` → `data.user.{id,nickname}`。
 *
 * ⚠️ 这是**稳定账号身份**的唯一来源（浏览器登录判重、邀请链接都靠它）：
 * 兑换接口回的 `id` 是「每签发一把 Key 就变」的记录 id（见
 * {@link exchangeMonkeycodeSessionForKey} 的实测）。
 *
 * ⚠️ 失败**不抛错**：调用方拿到 `undefined` 时按「身份未知」处理（不做判重），
 * 不能让一次辅助读数把已经成功的登录判死。
 */
export declare function fetchMonkeycodeProfile(sessionCookie: string, product?: MonkeycodeProduct, deps?: MonkeycodeCreditsDeps): Promise<MonkeycodeProfile | undefined>;
/**
 * 生成**邀请链接**（上游口径：`https://<平台主机>/?ic=<平台用户 id>`）。
 *
 * 2026-11-03 从官网 bundle 逐字取证：`const g = \`https://monkeycode-ai.com/?ic=${user.id}\``
 * —— 参数名是 `ic`，值是**平台用户 id**（不是邀请码、不是 Key id），
 * 邀请记录接口是 `GET /api/v1/users/invitations?page=1&size=20`。
 *
 * ⚠️ 用户 id 缺失时返回 `undefined`，**绝不**拼一个空 `?ic=` 的链接
 * （那会让用户把无效链接发给朋友，且看起来「生成成功」）。
 */
export declare function monkeycodeInviteLink(userId: string | undefined, product?: MonkeycodeProduct): string | undefined;
/** 钱包读数（已换算成积分 / 计费 token）。 */
export interface MonkeycodeWallet {
    /** 积分余额（已从「千分之一积分」换算）。 */
    readonly balance: number;
    /** 当日额度剩余（计费 token）；上游没给则为 `undefined`。 */
    readonly dailyTokenBalance?: number;
    /** 当日额度上限（计费 token）；上游没给则为 `undefined`。 */
    readonly dailyTokenLimit?: number;
}
/**
 * 读钱包：`GET /api/v1/users/wallet`。
 *
 * ⚠️ `balance` 缺失必须判**失败**，不得回落成 0 —— 本仓红线「绝不编造数字」，
 * 而 0 的语义是「已用光」，会让用户白白去充值。
 */
export declare function fetchMonkeycodeWallet(credential: MonkeycodeCredential, product?: MonkeycodeProduct, deps?: MonkeycodeCreditsDeps): Promise<{
    ok: true;
    wallet: MonkeycodeWallet;
} | {
    ok: false;
    error: string;
}>;
/**
 * 读订阅档位：`GET /api/v1/users/subscription`。
 *
 * ⚠️ 这是**辅助**读数：读不到只影响档位标签（`Basic` / `Pro` / `Ultra`），
 * 不影响余额展示 ⇒ 失败一律 `undefined` + 一条 `warn`，绝不把整行变成错误。
 */
export declare function fetchMonkeycodePlan(credential: MonkeycodeCredential, product?: MonkeycodeProduct, deps?: MonkeycodeCreditsDeps): Promise<MonkeycodePlan | undefined>;
/**
 * 把两个读数拼成 `CreditBalance`。
 *
 * ## 为什么分两个包（而不是加成一个 total）
 *
 * 积分（`credit`）与每日额度（`token`）**不可互相折算**，加起来的数字没有语义。
 * 前端的 `normalizeUnit` 会按单位**分组并列**显示（与 ZCode 的 token 同型），
 * 故这里如实给两个包；`total` 只汇总**积分**口径 —— 主行显示的就是用户真正
 * 关心的「我还有多少积分」。
 *
 * ⚠️ 两个包的 `expiredTime` / `cycleEndTime` 必须写**空串**：
 * 平台 wallet 报文只有标量余额，**没有任何到期时间或重置时刻字段**
 *（每日额度是隐式的「次日 0 点重置」，但上游不下发时刻，编一个就是编造）。
 *
 * ⚠️ 2026-11-03 合并审计更正：这里原写「这也是 monkeycode **不进**
 * `WIRED_EXPIRY_PROVIDERS` 的唯一理由」——**事实错误**。三家实际都**已接进**
 * 聚合折算（`aggregate-expiry.ts` 的 `WIRED_EXPIRY_PROVIDERS` 含 `monkeycode`
 * / `monkeycodeintl` / `baizhi`，折算原语是 `monkeycodeExpiry` / `baizhiExpiry`）。
 * 空的到期字段只影响**面板展示**；折算层用的是「有 `active && remaining > 0`
 * 的包 ⇒ `NEVER`，全空才 `UNUSABLE`」（`sharedPackageExpiry`），两者并不冲突。
 */
export declare function buildMonkeycodeBalance(wallet: MonkeycodeWallet, plan: MonkeycodePlan | undefined): CreditBalance;
/**
 * `ProviderCredits.fetchBalanceDetailed` 的实现。
 *
 * ⚠️ **必须走 Detailed 而不是 `fetchBalance`**：`fetchBalance` 的 `null` 会被共享
 * 骨架统一补一句写死的「余额查询失败」，于是「未配置会话」与「会话过期」这两种
 * **用户动作完全不同**的原因都到不了 UI —— 用户只会看到一句没用的话。
 */
export declare function fetchMonkeycodeBalanceDetailed(credential: MonkeycodeCredential, product?: MonkeycodeProduct, deps?: MonkeycodeCreditsDeps): Promise<{
    balance: CreditBalance | null;
    error?: string;
    extra?: RpcCreditsBalanceExtra;
}>;
/** PoW 挑战（平台下发的题面）。 */
export interface MonkeycodeChallenge {
    /** 题目数（实测 50）。 */
    readonly count: number;
    /** 每题 salt 的十六进制长度（实测 32）。 */
    readonly saltLength: number;
    /** 每题 target 的十六进制长度（实测 3 ⇒ 期望 4096 次尝试/题）。 */
    readonly targetLength: number;
}
/**
 * 读签到状态：`GET /api/v1/users/wallet/checkin` → `{ checked_in: boolean }`。
 *
 * ⚠️ 上游只给**一个布尔**，没有连续天数、没有奖励金额、没有活动期。
 * 契约要求那些字段存在，故一律如实填 0 / 空串并**在注释里说明**，
 * 绝不为了「看起来完整」编造数值。`active` 恒 `true`：拿到响应就意味着签到可用。
 */
export declare function fetchMonkeycodeCheckinStatus(credential: MonkeycodeCredential, product?: MonkeycodeProduct, deps?: MonkeycodeCreditsDeps): Promise<CheckinStatus | null>;
/**
 * 一键签到：`challenge → 本地求解 → redeem → checkin`。
 *
 * ## 幂等与预检
 *
 * 先 `GET /wallet/checkin` 判 `checked_in`：已签则直接回 `already-claimed`
 * **不发任何写请求**。这一步既是幂等判据，也省掉一次 PoW 计算
 *（50 道题约 0.2s，纯 CPU，但没必要白发）。
 * ⇒ `provider-credits.ts` 里因此可以声明 `precheckStatus: false`：
 * 预检已在本函数内部完成，外部再查一次就是**同一端点打两遍**。
 *
 * ## 奖励金额：优先读响应，其次用「签到前后余额差」
 *
 * ⚠️⚠️ 2026-11-03 真机实测（账号 `01a19fa3…`，国内站）：上游签到接口只回
 * `{ code: 0, data: { checked_in: true } }`，**不含奖励金额**；而网页文案写死
 * 「已领取 100 积分」——那 100 是前端常量，不是接口字段。
 *
 * 原实现写死 `credit: 0` + `delayedMessage`，后果是签到成功的那次批量领取在
 * 汇总行里显示成「MonkeyCode 无账号」（`formatClaimGains` 全零返回 null），
 * 用户会以为**根本没签到**。现改为：
 * 1. 响应里真有 `credit/reward/amount` ⇒ 直接用；
 * 2. 否则读一次签到后钱包，与签到前余额求差 ⇒ 用**实测增量**（真机为 +100）；
 * 3. 两次读余额有一次失败 ⇒ 才回落 `0 + delayedMessage`（并已修客户端
 *    不再把 0 渲染成「+0积分」/「无账号」）。
 *
 * ⚠️ 差值口径的边界：签到与读余额之间若有**并发的模型调用**，差值会被扣费
 * 抵消。这只影响展示数字、不影响签到本身；拿不到正数时按第 3 条降级，绝不
 * 编造一个「100」。
 *
 * ## 为什么每一步失败都单独给文案
 *
 * 用户点「一键签到」时最需要知道的是「卡在哪一步、要不要自己动手」：
 * 题解不出来 ⇒ 上游改版（等修复）；redeem 失败 ⇒ 验证过期（重试）；
 * checkin 失败 ⇒ 上游拒绝（看原文）。全部笼统成「签到失败」等于零线索。
 */
export declare function claimMonkeycodeDailyCheckin(credential: MonkeycodeCredential, product?: MonkeycodeProduct, deps?: MonkeycodeCreditsDeps): Promise<ClaimOutcome>;
//# sourceMappingURL=monkeycode-credits.d.ts.map