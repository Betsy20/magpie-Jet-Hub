/**
 * Cap 验证码的 **proof-of-work 求解器**（MonkeyCode / 百智云共用）。
 *
 * 两家的签到接口都要求先过同一套「挑战 → 本地求解 → 兑换」的人机验证：
 *
 *     POST /api/v1/public/captcha/challenge  → { token, challenge: { c, s, d } }
 *     （本地求解 c 道题）
 *     POST /api/v1/public/captcha/redeem     → { token: '<8hex>:<15hex>', success }
 *
 * 求解算法见 {@link solveChallenge}（与平台前端逐字节同构，`fnv1a32` 派生 PRNG +
 * SHA-256 前缀碰撞）。⚠️ 这里是**纯计算**，没有任何规避行为：题目就是让你算的，
 * 网页版也是浏览器里算。
 *
 * ## 为什么抽成独立模块（2026-11-03）
 *
 * 该算法先在 `monkeycode-credits.ts` 里落地并经真机验证（redeem 200）。百智云的
 * 签到接的是**同一套 Cap 协议**（同一家平台的两个站），若复制一份实现，任何
 * 一处（`i+1` 的 1-based 题号、hex 前缀比较、xorshift 的 `>>> 0`）漂移都会
 * 让另一家**必然签到失败**，而失败文案只会说「验证失败」。与
 * `session-cookie.ts` 的抽取同因：同一份协议只留一份实现。
 *
 * @module src/cap-pow.ts
 */
/** 平台下发的 PoW 挑战。 */
export interface CapChallenge {
    /** 题目数（实测 50）。 */
    readonly count: number;
    /** 每题 salt 的十六进制长度（实测 32）。 */
    readonly saltLength: number;
    /** 每题 target 的十六进制长度（实测 3 ⇒ 期望 4096 次尝试/题）。 */
    readonly targetLength: number;
}
/**
 * 由 seed 派生 `length` 位十六进制串（平台的 xorshift32 变体）。
 *
 * 每轮产出 8 位十六进制（`state` 的补零形式），拼够长度后**截断** ——
 * 与平台前端的 `out.push(f"{state:08x}")` + `"".join(out)[:length]` 同义。
 */
export declare function prng(seed: string, length: number): string;
/**
 * 解整个挑战：返回 `count` 个解（数组顺序与题号一致，**不能排序或去重**）。
 *
 * 第 `i` 题（从 0 开始）的两个派生种子是：
 * - `target = prng(token + (i+1) + 'd', targetLength)`
 * - `salt   = prng(token + (i+1),        saltLength)`
 *
 * ⚠️ `i+1` 是**题号从 1 开始**，与前端一致；写成 `i` 会让 redeem 必然失败
 *（服务端按 1-based 校验），而失败文案只会说「验证失败」，极难反推。
 *
 * ⚠️ 本函数是**同步**的（纯计算，便于单测与固定向量）。生产路径请用
 * {@link solveChallengeYielding}：它每解完一题让出一次事件循环，且共用
 * {@link MAX_POW_ATTEMPTS_TOTAL} 预算。
 */
export declare function solveChallenge(token: string, challenge: CapChallenge, budget?: {
    remaining: number;
}): number[];
/**
 * 与 {@link solveChallenge} 同算法，但**每解完一题 `await` 一次**。
 *
 * ⚠️ 目的是**不让宿主的单条事件循环被 PoW 独占**：现网 50 题约 0.2s，一次同步
 * 跑完通常无感；但「上游调高难度 / 报文被篡改」时同步版本会冻结数秒到数小时
 * （见 {@link MAX_POW_ATTEMPTS_TOTAL} 的推导）。分片后即使命中总预算上限，
 * 期间其余 provider 的调度与面板心跳仍能推进。
 */
export declare function solveChallengeYielding(token: string, challenge: CapChallenge, budget?: {
    remaining: number;
}): Promise<number[]>;
/**
 * 读挑战报文（`{ token, challenge: { c, s, d } }`，**已解包**后的业务对象）。
 *
 * ⚠️ 调用方必须先剥掉 `{ code, data }` 信封 —— 直接把原始报文传进来会被判成
 * 「没有 token」，签到永远失败且文案指向「上游改版」。
 */
export declare function readCapChallenge(data: unknown): {
    token: string;
    challenge: CapChallenge;
} | {
    error: string;
};
/** 从 redeem 响应里取验证 token（形如 `<8hex>:<15hex>`，**已解包**后的业务对象）。 */
export declare function readCapToken(data: unknown): string | undefined;
//# sourceMappingURL=cap-pow.d.ts.map