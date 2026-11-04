/**
 * baizhi（百智云）专用 RPC 的**方法处理函数**（不是自注册端点）。
 *
 * ## 为什么要有自己的方法（而不是复用 account.create）
 *
 * 百智云的凭据是一把**长期静态 API Key**（`sk-…`，67 位）。
 *
 * ⚠️ 2026-11-02 三审 F🟡-9：本处原写「用户**手工粘贴**的 API Key」——那只是备用路径。
 * 主路径是浏览器登录（`account.create { mode:'browser' }` → `baizhi.startSession`）
 * 与「大模型商店」：登录了 `baizhi.cloud` 后去
 * `https://ai-models.app.baizhi.cloud/console/api-keys` 生成 `sk-`。
 * 两条路最后都落到**同一份凭据结构** ⇒ 本文件只负责写入与判重。
 *
 * 本仓库已有先例（opencode → modelscope → qiniu → monkeycode），本文件
 * 照 `src/qiniu-rpc.ts` 同款形态实现：只导出 {@link handleBaizhiRpc}，
 * 由 `jet-hub-rpc.ts` 的 `handleMethod` 在 `default` **之前**调用
 * （对不认识的方法返回 `undefined`，让主 switch 继续匹配）。
 *
 * ## 与 qiniu 的差异（都来自协议事实，不是风格）
 *
 * | | qiniu | baizhi |
 * |---|---|---|
 * | 凭据字段 | `access_token` | `access_token`（同，AccountPool 身份反查要求） |
 * | Key 形状 | 无固定前缀 | 实测 `sk-` + 64 位，但**闸门仍不绑死前缀**（理由同 qiniu） |
 * | 账号去重 | 按尾 8 位派生 id | 同左 |
 * | 额度/签到 | 有（七牛有积分接口） | **没有** —— 按量计费，无每日额度/签到 |
 *
 * @module src/baizhi-rpc.ts
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ProviderAccountEntry } from './types.js';
import { parseBaizhiCredential } from './baizhi-auth.js';
/** `baizhi.addAccount` 的入参。 */
export interface RpcBaizhiAddAccountRequest {
    apiKey: string;
    nickname?: string;
}
/** `baizhi.addAccount` 的出参。 */
export interface RpcBaizhiAddAccountResponse {
    accountId: string;
    /** true = 该 Key 之前已添加过，本次只是复用。 */
    existed: boolean;
}
/** `baizhi.setApiKey` 的入参。 */
export interface RpcBaizhiSetApiKeyRequest {
    accountId: string;
    apiKey: string;
}
/** `baizhi.setApiKey` 的出参。 */
export interface RpcBaizhiSetApiKeyResponse {
    accountId: string;
    /** 打码后的新 Key（`前4…尾4`）—— **刻意不回传明文**，理由见方法实现。 */
    masked: string;
    /**
     * true = Key 变了 ⇒ 账号 id 也随尾段变了，账号被**重建**在新的 id 下。
     * ⚠️ 客户端据此必须**关闭并重开**面板（旧的 id 已不存在）。
     */
    renamed: boolean;
}
/** 账号池的最小依赖面（结构化类型，避免绑定具体类）。 */
export interface BaizhiPoolLike {
    listAccountsByProvider(provider: string): Array<{
        id: string;
        enabled: boolean;
        credentialRef: string;
        nickname?: string;
    }>;
    addAccount(entry: ProviderAccountEntry): Promise<void>;
    /** 改 Key 时要移除**旧**账号（id 随尾段变）—— 见 {@link RpcBaizhiSetApiKeyResponse.renamed}。 */
    removeAccount(accountId: string): Promise<void>;
}
/**
 * 账号 id / credentialRef 由 Key 尾段派生，使重复 Key 落到同一账号。
 *
 * ⚠️⚠️ **ref 名必须是合法标识符**：宿主的 `credentialRef()` 只认
 * `/^[A-Za-z_][A-Za-z0-9_]*$/`（见 `node_modules/@deepseek-ai/dsh-credentials`
 * 的 `REF_PATTERN`），而本家的 Key 形状闸放行 `[A-Za-z0-9_.-]`（**刻意不绑死
 * 前缀**，见 `KEY_PATTERN`）⇒ 末 8 位含 `.`/`-` 的 Key 会拼出非法 ref 并
 * **抛 TypeError**，用户只会看到一句英文正则。
 *
 * 修法照抄 `src/qiniu-rpc.ts:107-131`：
 * - **尾段本来就合法** ⇒ 逐字节不变（保护存量凭据引用）；
 * - **尾段不合法** ⇒ 剥掉非标识符字符 + 追加 key 的 sha256 前 8 位，
 *   使 `…bb-ccdd` 与 `…bb_ccdd` 不会撞成同一个 ref。
 */
export declare function baizhiSlotNamesOf(apiKey: string): {
    id: string;
    refName: string;
};
/**
 * 处理一个 baizhi RPC 方法。
 *
 * @returns `{ok:true, value}` / `{ok:false, error}`；**方法不认识时返回
 *          `undefined`**，让主 switch 继续往下走（它自己的 `default`
 *          分支仍能给出 `unknown method`，语义归属清晰）。
 *
 * ⚠️ 不认识时**必须**返回 `undefined` 而不是 `{ok:false}`：主 switch 会在
 * `default` 之前调用本函数，若本函数对未知方法也回信封，别的 provider 的
 * 方法名就会被误判成「格式错误」而不是「没这个方法」。
 */
export declare function handleBaizhiRpc(ctx: Context, pool: BaizhiPoolLike, method: string, payload: unknown): Promise<unknown>;
export { parseBaizhiCredential };
//# sourceMappingURL=baizhi-rpc.d.ts.map