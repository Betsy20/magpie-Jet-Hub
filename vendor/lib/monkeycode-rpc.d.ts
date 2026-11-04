/**
 * @module src/monkeycode-rpc.ts
 */
import type { Context } from '@deepseek-ai/cordis';
import { type MonkeycodeProduct } from './monkeycode-product.js';
/**
 * 账号池的最小接口（只声明本文件用到的成员）。
 *
 * ⚠️ 不用 `AccountPool` 的具体类型：Jet Hub 的 RPC 层把池参数透传成 `never`
 * （见 `jet-hub-rpc.ts` 的 `pool as never`），用具体类型会逼调用方做无意义的
 * 类型断言。结构化声明也让单测可以传一个纯 stub。
 */
export interface MonkeycodePoolLike {
    listAccountsByProvider(provider: string): Array<{
        id: string;
        enabled: boolean;
        credentialRef: string;
        nickname?: string;
    }>;
    addAccount(entry: {
        id: string;
        provider: string;
        nickname?: string;
        enabled: boolean;
        credentialRef: string;
        refreshable: boolean;
        createdAt: number;
    }): Promise<void>;
    removeAccount(accountId: string): Promise<void>;
}
/**
 * 由 API Key 派生**账号 id** 与**凭据 ref 名**。
 *
 * ⚠️ ref 名必须是合法 C 标识符（`credentialRef()` 只认
 * `/^[A-Za-z_][A-Za-z0-9_]*$/`，否则抛 TypeError）。而 Key 的尾巴常含
 * `-` / `.`，故先取大写、再把非法字符剔掉；剔完若可能碰撞（不同 Key 剥出
 * 同一个名字），追加 Key 的 sha256 前 8 位。
 *
 * ⚠️ 用**尾巴**而不是开头：`oma_` 开头的那几位对所有 Key 都一样，
 * 用它派生会让所有账号撞到同一个 id。
 *
 * ⚠️ ⚠️ **ref 前缀必须带上产品 id**（`MONKEYCODE_ACCOUNT_*` /
 * `MONKEYCODEINTL_ACCOUNT_*`）：两站是**独立账号池**，同一把 Key 在两个站
 * 没有任何关系，共用前缀会让 `jet-hub-store.ts` 的 `ACCOUNT_REF_RE` 在
 * `state.json` 缺失时把国际站账号认成国内站（静默串号）。
 * 同理**账号 id 前缀也要带产品 id**，否则两个池里的同名尾巴会互相顶掉。
 */
export declare function monkeycodeSlotNamesOf(apiKey: string, product?: MonkeycodeProduct): {
    id: string;
    refName: string;
};
/**
 * 处理一个 MonkeyCode 站点的 RPC（`monkeycode.*` / `monkeycodeintl.*`）。
 *
 * @param product 目标站点（缺省国内站）。
 * @returns `undefined` 表示「不是我认识的方法」——**必须**返回 `undefined`
 *   而不是抛错或返回失败对象，否则 `jet-hub-rpc.ts` 的主 switch 会被短路，
 *   其余方法全部变成 `unknown method`。
 */
export declare function handleMonkeycodeRpc(ctx: Context, pool: MonkeycodePoolLike, method: string, payload: unknown, product?: MonkeycodeProduct): Promise<unknown>;
//# sourceMappingURL=monkeycode-rpc.d.ts.map