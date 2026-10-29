// 测试隔离：让跑测试**绝不碰**用户的真实 `~/.dsh` 与 `~/.dsh-officeace`。
//
// 为什么需要它（2026-10-30 实测出来的真缺陷，不是理论风险）：
//
//   测试里的工厂几乎都写成 `await fn({ client: … }, {})` —— 第二个参数是空
//   options，于是 `src/plugin.mjs:182` 的 `resolveHome(undefined)` 返回
//   `homedir()`，`src/container.mjs:160` 随即 `process.env.DSH_HOME =
//   <家>/.dsh`，**直接把本体指向用户的真实凭据目录**。
//
//   跑一次 `tests/t-plugin.mjs` 前后做受控 hash 对比，实测：
//
//     .credentials.yaml        `34fdd965…` → `0b99bbee…`
//     jet-hub/state.json       `c1a49f6e…` → `0be291fe…`
//
//   也就是 4 个 cline 账号的 access_token 被**真实轮换**、到期时间被推后。
//   光换 token 还算温和，真正的风险在一次性 refresh_token 上：本机
//   `officeace` 现在就在报 `STS5.1806 invalid refresh token: 'the
//   refresh token has been used'`（升级前就有的历史事故）。测试路径一旦把
//   一次性 RT 用掉而结果没落盘，用户就得重新登录 —— 这是**不可逆**的。
//
// 隔离靠四件事，缺一不可：
//
//   1. `home` **必须**显式传给工厂（`containerFor` 只认第一个 options）；
//   2. `DSH_JET_HUB_STATE_DIR` —— `vendor/lib/jet-hub-store.js:1265` 的
//      `resolveJetHubHome()` 里它**优先级最高**，压过 `profileContext.home`
//      与 `DSH_HOME`；实测只传 home 不够（本体内部还有别处读 `homedir()`）；
//   3. `DSH_OFFICEACE_HOME` —— `vendor/lib/officeace-auth.js:77`
//      `officeaceHome()` **只认这个变量**，完全不受 `DSH_HOME` 约束；
//   4. `NODE_ENV=test` —— `vendor/lib/minimax-refresh-journal.js:41-69`
//      的 `isRealUserHomeWrite()` 拒写防线只在测试环境生效。⚠️ 它**不能**
//      单独顶用：该判据是「`NODE_ENV==='test'` 且 home 落在 `homedir()/.dsh`
//      下」，而有的测试会改 `USERPROFILE`/`HOME`，`homedir()` 跟着变 ⇒ 基准
//      被改掉，防线失效。所以变量隔离（2、3）才是主手，`NODE_ENV` 只是补强。
//
//   另一个坑：**`--all` 组的两个测试用真实 home 起容器**（`tests/t-direct.mjs`
//   与 `tests/t-console.mjs` 显式 `new JetHubContainer({ home: realHome })`，
//   因为它们要验真实凭据下的真转发）。这两个文件自己会 `mkdtemp` + 改
//   `USERPROFILE`，但传进容器的仍是 `realHome` —— 隔离环境变量必须由
//   `scripts/test-all.mjs` 的子进程 env 注入，测试文件自己管不了。
//
// 用法（测试文件顶部，**必须在 import 插件模块之后**）：
//
//   import { isolate } from './_iso.mjs'
//   const iso = isolate()
//   …
//   const plugin = await fn({ client: … }, iso.options())
//
// 为什么可以写在 `import` 之后：`import` 只做 `byId` Map 构建与契约校验，
// 不起容器；这些环境变量与 `options.home` 都是在 `container._start()` /
// `containerFor()` 里**惰性读**的，此刻设置一定早于任何一次 `start()`。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 建一个一次性隔离沙箱并设置环境变量。
 *
 * @returns {{ root: string, home: string, options: (extra?: object) => object, env: object }}
 */
export function isolate() {
  const root = mkdtempSync(join(tmpdir(), 'jet-hub-test-'))
  const env = {
    // 用户地址文件：容器只在控制台端口是 18500 时才写，测试一律不写
    JET_HUB_NO_ADDR_FILE: '1',
    // 本体状态目录的最高优先级覆盖（`resolveJetHubHome()` 第一条判据）
    DSH_JET_HUB_STATE_DIR: join(root, 'jet-hub'),
    // officeace 只认这个，不受 DSH_HOME 约束
    DSH_OFFICEACE_HOME: join(root, 'officeace'),
    // 补强：minimax 续期巡检的「拒写真实用户目录」防线只在这里认
    NODE_ENV: 'test',
    // 插件自己的附件目录（`src/attachments.mjs:86 defaultAttachmentDir()`）
    JET_HUB_ATTACHMENT_DIR: join(root, 'attachments'),
    // ⚠️ 2026-10-30 补的第三层，也是最隐蔽的一层：**只改 `home` / `DSH_*` 不够**。
    // 上游有几家（cline、autoclaw）的凭据落在 `~/.config/magpie/.dsh/`
    // ——`~` 是 `os.homedir()`，与 `DSH_HOME` 无关。不改 `USERPROFILE`/`HOME`
    // 时它们照读用户真实凭据并**静默续期**：实测跑一轮 `test-all`，
    // `AUTOCLAW_ACCOUNT_D819CD06` 与 `CLINE_ACCOUNT_FEA86265` 的 access_token
    // 都被换新、`expires_at` 被推后。
    USERPROFILE: root,
    HOME: root,
  }
  // 记下原值，供 live 段落恢复（否则那几段会以为自己还在沙箱里，读不到凭据）
  const saved = {}
  for (const k of Object.keys(env)) saved[k] = process.env[k]
  Object.assign(process.env, env)
  return {
    root,
    home: root,
    env,
    /**
     * 传给工厂的 options。
     *
     * ⚠️ 必须调用它而不是写 `{}` —— `{}` 就是这次事故的成因。
     * `extra` 用来覆盖个别测试需要的字段（如 `entryPath`）。
     */
    options: (extra = {}) => ({ home: root, ...extra }),
    /**
     * 撤销隔离：只在 `JET_HUB_LIVE=1` 的真凭据段落用。
     *
     * 它把上面五个环境变量**恢复成原值**（原来是 undefined 的删掉），
     * 这样那几段才能退回真实的 `~/.dsh`。⚠️ 用完之后该进程就**不再隔离**，
     * 后续任何工厂调用都会碰真实目录 —— 所以只在文件末尾用。
     */
    restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    },
  }
}

/**
 * 真实环境测试的开关。
 *
 * 少数断言**必须**打真实账号（例如「凭据失效要报 error 不要吞成 0 积分」、
 * 「真转发能出内容」），隔离环境下没有凭据，跑必假红。这些一律改成显式
 * opt-in：默认跳过并打印一行说明，设 `JET_HUB_LIVE=1` 才跑。
 *
 * ⚠️ 开了它就意味着**会碰真实账号**：可能轮换 access_token（正常续期，
 * 不可回滚但无害），也可能消费一次性 refresh_token（**会逼用户重新登录**）。
 * 所以只在本机确实要验证时开，别写进 CI。
 */
export function live() {
  return process.env.JET_HUB_LIVE === '1'
}

/** 跳过一条真实环境断言时的统一输出（让它出现在结果里，而不是无声无息）。 */
export function skipLive(what) {
  console.log(`  … 跳过真实环境断言：${what}（要跑设 JET_HUB_LIVE=1，会碰真实账号）`)
}
