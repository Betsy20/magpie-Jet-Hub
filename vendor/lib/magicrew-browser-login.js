/**
 * 超级麦吉（magicrew）**网页版登录**：开一个**独立 profile** 的浏览器窗口、让用户在里面
 * 完成登录，再从那个 profile 的 localStorage 里把凭据读回来。
 *
 * ## 三条登录路径里的第 ② 条
 *
 * | # | 路径 | 门槛 | 实现 |
 * |---|---|---|---|
 * | ① | 从本机浏览器已登录态导入（免开窗） | 零（用户日常浏览器里已登过） | `magicrew-local-browser.ts` |
 * | ② | **网页版登录（本文件）** | 低（开一个干净窗口，用户扫码/输密码） | `startMagicrewBrowserLogin` |
 * | ③ | 手机号 + 密码（宿主侧直接调上游） | 中（要密码，且上游有风控） | `loginMagicrew` |
 *
 * ②存在的原因：①在「用户从没在本机浏览器登过这个站」「用户用的是另一个 profile」
 * 两种情形下**读不到**（且那两种情况与「没登录」在结果上同形）；③要用户把密码交给插件。
 * ②是唯一「用户自己看着官方页面登录、凭据自然落盘」的路径。
 *
 * ## ⚠️⚠️ 为什么必须有**独立 profile**（不是复用用户真实浏览器）
 *
 * 两个理由，各自都踩过：
 *
 * 1. **不能碰用户的 profile**：真实 profile 里有用户的全部 cookie / 会话 / 书签，
 *    且**已被用户自己的浏览器进程独占**（`SingletonLock`）—— 拿它起第二个实例，
 *    Chromium 会把 URL 转交给已存在的实例、自己退出（CDP 端口永远不就绪）。
 * 2. **独立 profile 让「读到的凭据只可能是本次登录写进去的」**：一次性目录从空开始，
 *    于是「读到凭据」这件事本身就能当登录完成的判据。⚠️ 参考实现
 *    （`magpie-magicrew-auth/src/browser-login.mjs` 的 `newProfileDir` 注释）记录过
 *    复用目录的后果：第二个账号登录时一秒内读到**上一个账号**的 jwt ⇒ 建不出新账号
 *    （同一个 accountId/uid 被按契约判成「替换旧账号」）。
 *
 * ## ⚠️⚠️ 打开的是**网页域** `product.webOrigin`，不是 API 子域 `product.host`
 *
 * magicrew 的网页在 `https://www.letsmagic.cn`、API 在
 * `https://i-magic-service.letsmagic.cn`（`product.host`）。localStorage 的 key 是
 * `_https://<origin>\x00\x01<name>`，而**用户只会、也只能在网页域上登录** ——
 * 打开 API 子域会得到一个没有页面的域名（用户当场就懵），按它去扫 localStorage
 * 则**恒读不到**且完全静默。这两格都真实发生过（上一个任务踩过第一个）。
 *
 * ## 读凭据：复用 `magicrew-local-browser.ts`，**不要**重写一份配对逻辑
 *
 * 凭据的配对判据（`"key":"authorization"` × `"key":"organizationCode"`、按 origin
 * 截断窗口、每把 jwt 配**它自己后面**最近的组织码）是**上游错配 ⇒ HTTP 200 +
 * `code:403`** 换来的，只允许有一份实现。⇒ 本文件只做三件事：把
 * `readMagicrewLocalCreds` 的 `roots` 指到**本次的临时 profile 目录**、通过 CDP 读
 * **实时** localStorage、以及轮询。
 *
 * ## ⚠️⚠️ 必须「CDP 实时优先、磁盘兜底」——**只读磁盘是本模块曾经的真缺陷**
 *
 * 真机报障（2026-10-29）：用户在这个窗口里**登录成功**了，插件仍显示「尚未配置账号」，
 * 「网页版登录」白转 4 分钟。根因不是路径错、不是匹配逻辑错：
 *
 * - Chromium 把 localStorage **缓在内存**，只有关窗（或批量提交）才刷到
 *   `<profileDir>/Default/Local Storage/leveldb` ⇒ 「登录完那一刻」磁盘里**还没有**
 *   ⇒ 每 500ms 读一次永远是 `undefined` ⇒ 4 分钟超时。实测可复现：我们起的 profile
 *   目录路径是对的（`Default/Local Storage/leveldb` 存在）、用户真实浏览器里的
 *   leveldb 里两个 key 确实相邻（匹配逻辑没问题），但**那一刻**我们这份 leveldb
 *   是空的。
 * - CDP 通路实测可用：`Target.getTargets` → `Target.attachToTarget { flatten: true }`
 *   → `Runtime.evaluate`（带 `sessionId`）能读到页面里的实时 `localStorage`。
 *
 * ⇒ 读凭据的**主路径**是 {@link readCredentialViaCdp}（实时），
 * {@link createProfileCredentialReader}（磁盘）降级为**兜底**（老 Chromium /
 * `--remote-allow-origins` 限制下 CDP 可能不可用）。⚠️ **两腿都要留**：删掉磁盘那条腿
 * 会让「CDP 不可用」的机器变成必然失败；删掉 CDP 那条腿就退回本次报障。
 *
 * ## 浏览器基础设施：全部来自 `chromium-session.ts`
 *
 * 起 chromium / 挑空闲调试端口 / 校验应答端口 / 监听 `'error'` / `taskkill /T` /
 * profile 目录退避重试删除 —— 每一条都是真实缺陷换来的（见该模块头那张表）。
 * 这里**不重写**任何一条，只组合 {@link ChromiumSession}。
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { BrowserDeploymentError, ChromiumSession, browserCandidates, browserNotFoundMessage, findBrowserExecutable, sleep as defaultSleep, } from './chromium-session.js';
import { readMagicrewLocalCreds, } from './magicrew-local-browser.js';
import { MAGICREW } from './magicrew-product.js';
/**
 * 默认等待用户完成登录的上限（**4 分钟**）。
 *
 * ## ⚠️ 为什么是 4 分钟而不是 5 分钟
 *
 * 客户端的登录轮询上限是 **5 分钟**（`plugin-src/client/jet-hub.js` 的
 * `deadline = Date.now() + 300000`，是客户端自己的表、不是服务端超时）。
 * 两边的上限若相同，宿主给出的终态（「等超时了」）会与客户端收表**几乎同时**发生，
 * 用户大概率只看到「登录超时」那句泛化文案、看不到真正的终态原因。
 * ⇒ 宿主必须**早于**客户端收口，留一分钟余量把原因送到眼前。
 *
 * ⚠️ 同时它也是「用户实际需要多久」的实测区间上限（扫码/输密码 2–5 分钟）。
 */
export const MAGICREW_BROWSER_LOGIN_TIMEOUT_MS = 240_000;
/** 轮询间隔（毫秒）。 */
export const MAGICREW_BROWSER_LOGIN_POLL_MS = 500;
/** 把任意外部传入的超时收成「一个合法的非负毫秒数」。 */
function normalizeTimeoutMs(value) {
    if (value === undefined || !Number.isFinite(value) || value <= 0) {
        return MAGICREW_BROWSER_LOGIN_TIMEOUT_MS;
    }
    return Math.floor(value);
}
/** 轮询间隔：非法值回落缺省（`0` / 负数会让下面的循环空转）。 */
function normalizePollMs(value) {
    if (value === undefined || !Number.isFinite(value) || value <= 0) {
        return MAGICREW_BROWSER_LOGIN_POLL_MS;
    }
    return Math.max(1, Math.floor(value));
}
/**
 * 一次性 profile 目录的前缀 —— **唯一真源**。
 *
 * 它同时决定两件事：`ChromiumSession` 用它建目录、`collectStaleLoginProfiles`
 * 用它认领自己上次留下的目录。写成两个字面量的话，只改一处就会变成
 * 「建了不回收」或更糟的「回收时去删别人的目录」，所以这里只留一份。
 */
const LOGIN_PROFILE_PREFIX = 'magicrew-login-';
/**
 * 回收**上一次**遗留的一次性 profile 目录。
 *
 * ## ⚠️ 为什么需要它（实测 2026-10-31）
 *
 * `ChromiumSession.dispose()` 的删除只退避 `[0,100,500,1500]` 毫秒（总 2.1 秒），
 * 而 Windows 上 `taskkill /T` 之后，Edge 的 crashpad / renderer 子进程还要一小会儿
 * 才释放文件句柄 —— 一次删不掉就永久留下一个目录。本机实测攒到 **11 个 / 856 MB**。
 *
 * 更要紧的是：窗口由**用户**关掉时，没有任何回调保证走到 `dispose()`
 * （`startMagicrewBrowserLogin` 的 finally 只在轮询自己收口时执行），
 * 那条路径一个字节都不会删。
 *
 * ⇒ 一次性目录「这次保证删掉」不现实；**下次开窗前扫一遍**才是可靠兜底。
 *
 * ## ⚠️ 只删够老的（`minAgeMs`，缺省 1 小时）
 *
 * 一次网页登录最长 4 分钟（`MAGICREW_BROWSER_LOGIN_TIMEOUT_MS`），宿主侧等 9 分钟
 * （`NEW_ACCOUNT_WAIT_MS`），所以 1 小时前的目录一定不是**正在用**的。
 *
 * 判据用**目录自身**的 mtime。它可能停在创建时刻（Edge 主要在 `Default/` 子目录里
 * 写文件，父目录的 mtime 只在直接子项增删时更新）—— 这没关系：正被占用的目录
 * 在 Windows 上 `rmSync` 会抛 EPERM/EBUSY，这里吞掉，下一次再试。
 *
 * ## ⚠️ 成本
 *
 * 本机 `%TEMP%` 有 **19.8 万个条目**，`readdirSync(withFileTypes)` 实测 **93ms**。
 * 登录是低频操作、且只在开窗前做一次，可以接受；但它确实不是零成本。
 *
 * 返回删掉的个数（0 表示没什么可回收，调用方不需要打日志）。
 */
function collectStaleLoginProfiles(minAgeMs = 60 * 60 * 1000) {
    const root = tmpdir();
    if (root.length === 0)
        return 0;
    let entries;
    try {
        entries = readdirSync(root, { withFileTypes: true });
    }
    catch {
        return 0; // 临时目录读不了不是登录该关心的事
    }
    const cutoff = Date.now() - minAgeMs;
    let removed = 0;
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        if (!entry.name.startsWith(LOGIN_PROFILE_PREFIX))
            continue;
        const dir = join(root, entry.name);
        try {
            if (statSync(dir).mtimeMs > cutoff)
                continue; // 还年轻，可能正在用
        }
        catch {
            continue; // 刚被别的进程删掉
        }
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
            removed += 1;
        }
        catch {
            // 被占用 —— 下一次再说
        }
    }
    return removed;
}
/** 从 URL 取 hostname；非法 URL ⇒ 空串（**不猜**）。 */
function hostnameOf(url) {
    try {
        return new URL(url).hostname.toLowerCase();
    }
    catch {
        return '';
    }
}
// ════════════════════════════════════════════════════════════════════════
// CDP 实时读凭据（**主路径**，见文件头「必须 CDP 实时优先」）
// ════════════════════════════════════════════════════════════════════════
/**
 * 页面里的取值表达式。
 *
 * ⚠️ 四个值一次取完（**不是**四次 `Runtime.evaluate`）：来回四次会让「读到 jwt 之后、
 * 读组织码之前用户换了账号」这种情况出现窗口，而错配的 jwt × org 在上游是
 * HTTP 200 + `code:403`（见 `magicrew-local-browser.ts` 头部的配对纪律）。
 *
 * `n` 是 `localStorage.length`：**空 = 还没登完**（见下面的判据）。
 *
 * ## ⚠️⚠️ 为什么还要读 IndexedDB（2026-10-30 真机报障换来的）
 *
 * 原先只读 `localStorage`。真机上用户「网页已经登录成功」，插件却白等满 4 分钟、
 * 最后报「请在浏览器中完成超级麦吉 登录」——因为 magicrew 网页版**根本不往
 * `localStorage` 写凭据**：它把登录态存在 IndexedDB 的 `magic-global` 库里，
 * `user` 这个 object store 下的两个 key：
 *
 *     authorization   → 354 字符的 JWT
 *     organizations   → 组织码（`magic_organization_code` / `teamshare_organization_code`）
 *
 * 前端自己的读法是 `e.user.authorization` / `e.user.organizationCode`
 * （`AiLLMService-*.js`），而 `e.user` 就是从这个 store 水合的。实测本机 Edge：
 * `Local Storage/leveldb` 里 `authorization` 出现 **0 次**，同一个站点的
 * `IndexedDB/https_www.letsmagic.cn_0.indexeddb.leveldb` 里 **7 次**。
 *
 * 所以两条腿都要读、`localStorage` 先读（老版本 / 未来回退），IndexedDB 兜住现状。
 * `ii` 是「IndexedDB 那条腿有没有跑成」（0 = 没跑成），`ie` / `id` 是它的失败原因；
 * 两者只在**放弃等待**那行诊断里用得上（见 {@link createMagicrewCredentialWaiter}）。
 *
 * ⚠️ 用 `indexedDB.databases()` **先列后开**，绝不直接 `indexedDB.open('magic-global')`：
 * 库不存在时 `open()` 会**当场新建一个空库**（还留下版本变更记录），而我们只是来读的 ——
 * 在用户 profile 里凭空造一个 `magic-global` 库是副作用。`databases()` 在个别旧内核上
 * 不可用 ⇒ 退化成 `open()` 但只读不写（无 store 时立即 `close()`，不触发任何写事务）。
 */
const CDP_CREDENTIAL_EXPRESSION = `(async () => {
  const out = {
    a: localStorage.getItem('authorization'),
    o: localStorage.getItem('organizationCode'),
    t: localStorage.getItem('teamshareOrganizationCode'),
    n: localStorage.length,
    ia: null,
    io: null,
    ii: 0,
  };
  try {
    // 先列后开：库不存在就别 open()（open 会凭空新建一个空库，是副作用）。
    let exists = true;
    try {
      if (typeof indexedDB.databases === 'function') {
        const all = await indexedDB.databases();
        exists = Array.isArray(all) && all.some((entry) => entry && entry.name === 'magic-global');
      } else {
        // 旧内核没有 databases()：只能直接 open()（下面会 close，不写任何东西），
        // 但要留一句，免得放弃等待时看不出「这次没做先列后开」。
        out.id = 'databases() 不可用（内核太旧），已退回只读 open()';
      }
    } catch (error) {
      // databases() 抛错 ⇒ 不据此下结论，退回 open()（只读、不写）。
      out.id = 'databases() 不可用：' + String(error);
    }
    if (!exists) {
      out.ie = '没有 magic-global 这个库（用户还没在这个站点登录过）';
      return JSON.stringify(out);
    }
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('magic-global');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (db.objectStoreNames.contains('user')) {
      const store = db.transaction('user', 'readonly').objectStore('user');
      const grab = (key) => new Promise((resolve) => {
        const req = store.get(key);
        req.onsuccess = () => {
          const record = req.result;
          // in-line key store: get() returns the {key, value} wrapper, not the bare value.
          // Measured 2026-10-30 on Edge: {key: 'authorization', value: 'eyJ...'}.
          // Skipping this unwrap makes every read look like "not signed in".
          if (record === null || typeof record !== 'object')
            return resolve(null);
          resolve(record.value === undefined ? null : record.value);
        };
        req.onerror = () => resolve(null);
      });
      out.ia = await grab('authorization');
      out.io = await grab('organizations');
      out.ii = 1;
    }
    db.close();
  } catch (error) {
    out.ie = String(error);
  }
  return JSON.stringify(out);
})()`;
/**
 * 单条 CDP 命令的上限。
 *
 * ⚠️ **不能**用 `CdpConnection.send` 的 30 秒缺省：外层轮询是 500ms 一拍，
 * 一条卡死的命令会把整轮等待预算（4 分钟）吃掉一小半，且期间磁盘兜底也不会被读到。
 */
const CDP_CREDENTIAL_TIMEOUT_MS = 3_000;
/** `eyJ…` 三段（JWT 形状）。⚠️ 形状对 ≠ 有效，但形状不对**一定**不是 jwt。 */
function isJwtShaped(value) {
    if (!value.startsWith('eyJ'))
        return false;
    const parts = value.split('.');
    return parts.length === 3 && parts.every((part) => /^[A-Za-z0-9_\-+/=]+$/.test(part));
}
/** 两个 host 是否同一个站点（`www.letsmagic.cn` 与 `letsmagic.cn` 视作同一个）。 */
function sameSite(left, right) {
    const bare = (host) => host.toLowerCase().replace(/^www\./, '');
    return left.length > 0 && right.length > 0 && bare(left) === bare(right);
}
/**
 * 一个 host 的全部写法（`www.letsmagic.cn` / `letsmagic.cn`，去重、保持顺序）。
 *
 * ⚠️ 与 `magicrew-local-browser.ts` 的同名内部辅助**刻意为同一口径**：磁盘那条腿
 * 用的是它，两条腿对「同一个站点」的判断必须一致，否则会出现「磁盘读到了、CDP 说
 * 没有这个页面」这种自相矛盾的诊断。
 */
function siteHostnames(hostname) {
    const host = String(hostname ?? '').trim().toLowerCase();
    if (host.length === 0)
        return [];
    const bare = host.replace(/^www\./, '');
    const hosts = [host, bare, `www.${bare}`];
    return hosts.filter((value, index) => value.length > 0 && hosts.indexOf(value) === index);
}
/** 在 `Target.getTargets` 的结果里找**命中站点**的那个 page target。 */
function pickPageTarget(targets, hostnames) {
    const infos = targets?.targetInfos;
    if (!Array.isArray(infos))
        return undefined;
    for (const raw of infos) {
        const info = raw;
        if (info.type !== 'page')
            continue;
        if (typeof info.url !== 'string' || typeof info.targetId !== 'string')
            continue;
        const host = hostnameOf(info.url);
        if (!hostnames.some((candidate) => sameSite(host, candidate)))
            continue;
        return { targetId: info.targetId, url: info.url };
    }
    return undefined;
}
/** 解析 `Runtime.evaluate` 的返回值（`{ result: { value } }`）⇒ 读到的凭据。 */
function parseEvaluatedCredential(value) {
    if (typeof value !== 'string' || value.length === 0)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(value);
    }
    catch {
        return undefined;
    }
    /**
     * ⚠️⚠️ **`localStorage` 为空要当「还没登完」返回 `undefined`，不要抛**：
     * 用户刚点开窗口那一刻必然是空的，而这条路径每 500ms 走一次。
     *
     * ⚠️ 但**不能**只看 `n`：magicrew 网页版的凭据在 IndexedDB 里，
     * `localStorage` 里只有页面自己的缓存（键名随版本变），凭据那条键根本不在这里；
     * 而 `n === 0` 也不代表没登录。所以下面两条腿分别取值、谁先取到用谁。
     * （实测 2026-10-30：`fontScale` / `i18n` / `theme` 这三条界面配置也在 IndexedDB
     *  的 `user` store 里，不在 `localStorage` —— 别拿它们当「localStorage 有值」的证据。）
     */
    const fromStorage = pickCredential(parsed.a, parsed.o, parsed.t);
    if (fromStorage !== undefined)
        return fromStorage;
    return pickCredential(parsed.ia, organizationFromIndexedDb(parsed.io), undefined);
}

/**
 * 从 `Runtime.evaluate` 的返回值里取「IndexedDB 那条腿为什么没读到」。
 *
 * ⚠️ 存在的理由与 `failure` 通道完全一样：凭据没读到时，`credential` 上
 * 「用户还没登完」与「我们读 IndexedDB 的方式坏了」是同形的（都 `undefined`），
 * 只有这句话能分开。它最终会进「放弃等待」那行诊断。
 *
 * @returns 一句人话；读通了或没有任何记录 ⇒ 空串。
 */
function indexedDbNoteOf(value) {
    if (typeof value !== 'string' || value.length === 0)
        return '';
    let parsed;
    try {
        parsed = JSON.parse(value);
    }
    catch {
        return '';
    }
    const note = typeof parsed?.ie === 'string' ? parsed.ie : '';
    const unavailable = typeof parsed?.id === 'string' ? parsed.id : '';
    return [note, unavailable].filter((text) => text.length > 0).join('；');
}

/**
 * 从 IndexedDB `magic-global/user` 的 `organizations` 记录里取组织码。
 *
 * ⚠️ 三个字段**都要认**（实测本机 Edge 三条同时存在且值相同，但历史上不同
 * 平台来源只写其中一条）：`magic_organization_code` 是 magicrew 自己的；
 * `teamshare_organization_code` / `third_platform_organization_code` 是
 * teamshare 体系的。取第一个非空的。
 *
 * @param value `user` store 里 `organizations` 的值（对象，或它的 JSON 串）。
 * @returns 组织码；取不到 ⇒ 空串（**不猜**）。
 */
function organizationFromIndexedDb(value) {
    if (value === null || value === undefined)
        return '';
    let record = value;
    if (typeof record === 'string') {
        try {
            record = JSON.parse(record);
        }
        catch {
            return '';
        }
    }
    if (typeof record !== 'object')
        return '';
    for (const key of ['magic_organization_code', 'teamshare_organization_code', 'third_platform_organization_code']) {
        const field = record[key];
        if (typeof field === 'string' && field.length > 0)
            return field;
    }
    return '';
}

/**
 * 把一对「jwt × 组织码」候选值校验成凭据。
 *
 * @returns 形状不合法或缺组织码 ⇒ `undefined`（**不造假**）。
 */
function pickCredential(jwt, organization, fallbackOrganization) {
    const authorization = typeof jwt === 'string' ? jwt : '';
    if (!isJwtShaped(authorization))
        return undefined;
    const org = typeof organization === 'string' && organization.length > 0
        ? organization
        : typeof fallbackOrganization === 'string' && fallbackOrganization.length > 0 ? fallbackOrganization : '';
    // ⚠️ 缺组织码 ⇒ `undefined`（**不造假**）：空 org 配 jwt 在上游是 HTTP 200 + code:403。
    if (org.length === 0)
        return undefined;
    return { jwt: authorization, organizationCode: org };
}
/**
 * 尝试**一次**通过 CDP 读实时凭据（并把失败原因带出来）。
 *
 * ## ⚠️ 调用序列是实测跑通的，不要改顺序
 *
 * `Target.getTargets` → `Target.attachToTarget { flatten: true }` →
 * `Runtime.evaluate`（**带 `sessionId`**）。少一步 `flatten` 或漏传 `sessionId`，
 * 页面级命令会落在浏览器端点上并回一句含糊的 `-32601 'Runtime.evaluate' wasn't found`
 * —— 看起来像「API 不存在」，实际是「你没说要发给哪个页面」（该实测记录见
 * `chromium-session.ts` 的 `CdpConnection.send` 注释）。
 *
 * ## ⚠️ 每轮都重新 attach（**不要缓存 sessionId**）
 *
 * 页面在登录过程中会导航（`/login` → `/global/super/workspace/…`），导航会让
 * 旧 `sessionId` 失效。缓存它 ⇒ 用户「登录成功那一秒恰好导航」之后整条等待**永不恢复**。
 *
 * ## ⚠️ 任何一步失败都**返回**（不抛），下一轮自然重试
 *
 * 失败原因只用于**超时那一行诊断**（见 {@link createMagicrewCredentialWaiter}）：
 * 下次报障时它直接区分「用户没登」与「我们读的方式坏了」。
 */
async function attemptCredentialViaCdp(session, hostnames) {
    const cdp = session?.cdp;
    if (cdp === undefined)
        return { failure: 'CDP 通道未就绪（浏览器未启动或已收窗）' };
    const hosts = hostnames.map((host) => host.trim()).filter((host) => host.length > 0);
    if (hosts.length === 0)
        return { failure: '没有可匹配的 hostname' };
    let sessionId;
    try {
        const targets = await cdp.send('Target.getTargets', {}, CDP_CREDENTIAL_TIMEOUT_MS);
        const target = pickPageTarget(targets, hosts);
        if (target === undefined) {
            return { failure: `${hosts.join(' / ')} 的页面还没出现（用户可能还在加载登录页）` };
        }
        const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, CDP_CREDENTIAL_TIMEOUT_MS);
        const attachedId = typeof attached?.sessionId === 'string' ? attached.sessionId : '';
        if (attachedId.length === 0)
            return { failure: 'Target.attachToTarget 没给出 sessionId' };
        sessionId = attachedId;
        /**
         * @param awaitPromise 必须为 `true`：表达式现在是一个 **async IIFE**
         *   （要读 IndexedDB，必须 await）。不传它就拿到一个未 settle 的
         *   Promise 包装（`returnByValue` 下是 `{}`）—— 与「用户还没登完」完全同形，
         *   诊断上看不出来（实测 2026-10-30：表达式单跑能读到、这里返回 `{}`）。
         */
        const evaluated = await cdp.send('Runtime.evaluate', { expression: CDP_CREDENTIAL_EXPRESSION, awaitPromise: true, returnByValue: true }, CDP_CREDENTIAL_TIMEOUT_MS, attachedId);
        if (evaluated?.exceptionDetails !== undefined) {
            return { failure: 'Runtime.evaluate 在页面里抛错（页面可能正在导航）' };
        }
        const credential = parseEvaluatedCredential(evaluated?.result?.value);
        // ⚠️ 没读到 = 「用户还没登完」这种**正常**未完成态 ⇒ 不记 failure。
        if (credential !== undefined)
            return { credential };
        // 但 IndexedDB 那条腿自己报的错（库不存在 / databases() 不可用 / open 抛错）
        // 不是「用户没登」—— 挂到 note 上，放弃等待时能一眼区分。
        const note = indexedDbNoteOf(evaluated?.result?.value);
        return note.length === 0 ? {} : { note };
    }
    catch (error) {
        return { failure: `CDP 调用失败：${String(error)}` };
    }
    finally {
        /**
         * ⚠️ attach 会留下 session ⇒ **尽力** detach。
         *
         * 与 `Storage.getCookies` 那条既有口径一致（`chromium-session.ts`）：能 detach 就
         * detach，**不可用或失败都不因此失败** —— 有的 Chromium 版本/调试后端没有
         * `Target.detachFromTarget`，为它抛错会让「已经读到凭据」变成读不到。
         */
        if (sessionId !== undefined) {
            try {
                await cdp.send('Target.detachFromTarget', { sessionId }, CDP_CREDENTIAL_TIMEOUT_MS);
            }
            catch {
                // 尽力而为：收窗时整条通道一起关掉，残留 session 随之消失。
            }
        }
    }
}
/**
 * 通过 CDP 读**实时** localStorage。
 *
 * ⚠️ **必须走它而不是读磁盘**：Chromium 把 localStorage 缓在内存，不关浏览器不落盘
 * （真机报障 2026-10-29 —— 磁盘读取的 4 分钟等待里永远是 undefined）。
 *
 * @param session 带 `cdp` 通道的会话（`ChromiumSession` 即可）。
 * @param hostnames 站点 host（**网页域**，例如 `www.letsmagic.cn`；`www.` 前后互认）。
 * @returns 读到 ⇒ 凭据；未登完 / CDP 不可用 ⇒ `undefined`（**绝不抛**，下一轮重试）。
 */
export async function readCredentialViaCdp(session, hostnames) {
    return (await attemptCredentialViaCdp(session, hostnames)).credential;
}
/**
 * 同 {@link readCredentialViaCdp}，但把**失败原因**一并带出来。
 *
 * ⚠️ 存在的理由只有一个：那条「放弃等待」的诊断（见
 * {@link createMagicrewCredentialWaiter} 的 `log`）要能说清「CDP 为什么没读到」。
 * 生产接线用的就是它（把 `failure` 交给等待循环），单测也用它断言「`n === 0`
 * 是正常未完成态、**不是**读失败」—— 这两件事在 `credential` 上同形（都
 * `undefined`），只有 `failure` 能分开。
 */
export async function readCredentialViaCdpDetailed(session, hostnames) {
    return await attemptCredentialViaCdp(session, hostnames);
}
/**
 * 造一个「从**本次临时 profile**里读 magicrew 凭据」的读函数。
 *
 * ## ⚠️⚠️ 这就是本模块与「本机浏览器导入」的**唯一**实质差异
 *
 * `readMagicrewLocalCreds` 缺省会扫**用户真实浏览器**的 User Data 根目录
 * （`magicrewBrowserRoots()`）。而网页版登录用的是 `mkdtempSync` 出来的临时目录，
 * 真实目录里**永远是空的**（用户在日常浏览器里登过也不在临时 profile 里）
 * ⇒ 不把 `roots` 指过去，`waitForCredential` 会**恒等到超时**，且完全静默。
 *
 * ⚠️ 注入 `roots: [profileDir]` 也让本函数在单测里可断言：给一个临时目录、
 * 里面写一段 leveldb 文本，就能验证「读得到」与「读的是哪个 origin」。
 *
 * @param profileDir 本次会话的 `--user-data-dir`（`ChromiumSession.userDataDir`）。
 * @param hostname   站点 host（**网页域**，见文件头）。
 */
export function createProfileCredentialReader(profileDir, hostname, deps = {}) {
    const readCreds = deps.readCreds ?? readMagicrewLocalCreds;
    return () => {
        if (profileDir.length === 0 || hostname.length === 0)
            return undefined;
        let found;
        try {
            found = readCreds(hostname, { roots: [profileDir] });
        }
        catch {
            // ⚠️ 读盘失败（文件被浏览器独占 / 权限）**不是**「用户没登录」——
            //    但也不能抛错（那是正常路径，见接口头）：下一轮再试即可。
            return undefined;
        }
        if (found === undefined)
            return undefined;
        // ⚠️ 只搬两个字段：`expiresAt` 不在 `MagicrewCredential` 里（三层凭证的到期
        //    时刻由 `apiKeyExpiresAt` 表达，网页 jwt 自己带 30 天）。
        return { jwt: found.jwt, organizationCode: found.organizationCode };
    };
}
/**
 * 轮询等待凭据 —— **本模块唯一的等待逻辑**（会话类与单测共用它，不写第二份）。
 *
 * 语义（每条都有用例钉住）：
 * 1. **先读一次再判停止/超时**：`timeoutMs = 0` 时也要给一次机会（否则「刚登完就
 *    超时」这种边界会被判成没登录）；同理，用户登完顺手关窗那一刻凭据已在磁盘上，
 *    停止判据必须**后于**读取（详见循环里的注释）。
 * 2. **每轮先实时（CDP）、再磁盘（兜底）**：顺序是语义，不是风格 —— 见文件头
 *    「必须 CDP 实时优先」。⚠️ 磁盘那条腿**不许删**（CDP 不可用的机器上它是唯一出路）。
 * 3. 到点返回 `undefined`，**不抛错**（见 {@link MagicrewBrowserLogin} 接口头）。
 * 4. 已收窗 / 浏览器已退出 ⇒ 立刻 `undefined`（不必耗满预算）。
 * 5. 每轮最多睡到**剩余预算**为止（不越过 deadline 多睡一格）。
 */
export function createMagicrewCredentialWaiter(deps) {
    const now = deps.now ?? (() => Date.now());
    const sleep = deps.sleep ?? defaultSleep;
    const interval = normalizePollMs(deps.pollIntervalMs);
    const isStopped = deps.isStopped ?? (() => false);
    const readRealtime = deps.readRealtime;
    /** 实时读尝试了几次 / 最后一次的失败原因（只用于放弃时那一行诊断）。 */
    let realtimeAttempts = 0;
    let lastRealtimeFailure;
    /** IndexedDB 那条腿最后一次自己报的错（库不存在 / databases() 不可用 / open 抛错）。 */
    let lastIndexedDbNote;
    /** 读一拍：**实时优先、磁盘兜底**。 */
    const readOnce = async () => {
        if (readRealtime !== undefined) {
            realtimeAttempts += 1;
            let realtime;
            try {
                realtime = await readRealtime();
            }
            catch (error) {
                // ⚠️ 实时读**绝不许**把等待变成失败：它自己要抛也只是「这拍没读到」。
                realtime = { failure: String(error) };
            }
            if (realtime.credential !== undefined)
                return realtime.credential;
            // 只有**失败**才覆盖原因：`{}` = 「读通了但用户还没登完」，那是正常路径，
            // 拿它盖掉真故障会让放弃时那一行说不出任何有用的话。
            if (realtime.failure !== undefined)
                lastRealtimeFailure = realtime.failure;
            // IndexedDB 那条腿的报错同理：它不是「用户没登」，但也不是致命故障
            // （localStorage 腿可能还能用），所以单独记、不盖 failure。
            if (typeof realtime.note === 'string' && realtime.note.length > 0)
                lastIndexedDbNote = realtime.note;
        }
        try {
            return await deps.read();
        }
        catch {
            // ⚠️ 读盘失败（文件被浏览器独占 / 权限）**不是**「用户没登录」——
            //    但也不能抛错（那是正常路径）：下一轮再试即可。
            return undefined;
        }
    };
    return async (timeoutMs) => {
        const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 0;
        const deadline = now() + budget;
        for (;;) {
            /**
             * ① **先读、再判「已收窗」**（顺序是语义，不是风格）：用户登完那一刻可能顺手
             * 关掉了窗口，此时 `isStopped()` 为真而凭据**已经**在（实时或磁盘上）—— 先把
             * 停止判据放在读取之前，就会把一次**已成功的登录**误报成 `undefined`。
             */
            const found = await readOnce();
            if (found !== undefined)
                return found;
            if (isStopped())
                return undefined;
            const remaining = deadline - now();
            if (remaining <= 0)
                break;
            await sleep(Math.max(1, Math.min(interval, remaining)));
        }
        /**
         * ⚠️ 放弃等待时**必须**留一行诊断（真机报障 2026-10-29 的直接教训）：
         * 「用户没登」与「我们读的方式坏了」在用户那里同形，只有这一行能分开。
         */
        if (deps.log !== undefined) {
            const note = lastIndexedDbNote === undefined ? '' : ` / IndexedDB 那条腿：${lastIndexedDbNote}`;
            deps.log(`[magicrew] CDP 与磁盘都没读到凭据（CDP 尝试 ${realtimeAttempts} 次 / `
                + `最后一次 CDP 失败原因：${lastRealtimeFailure ?? '（无；说明页面在，只是 localStorage 与 IndexedDB 里都还没有凭据 —— 用户没登完）'}${note}）`);
        }
        return undefined;
    };
}
/** 一个已起好浏览器的网页登录会话（实现 {@link MagicrewBrowserLogin}）。 */
class ChromiumProfileLogin {
    session;
    closed = false;
    wait;
    defaultTimeoutMs;
    constructor(session, deps, defaultTimeoutMs) {
        this.session = session;
        this.defaultTimeoutMs = defaultTimeoutMs;
        // ⚠️ `isStopped` 由**本类**提供（而不是让调用方再传一次）：收窗后必须立刻放弃
        //    等待，否则 `close()` 之后 `waitForCredential` 还会空转到超时。
        this.wait = createMagicrewCredentialWaiter({
            ...deps,
            isStopped: () => this.closed || session.exited,
        });
    }
    /**
     * 收掉浏览器（**幂等**）。
     *
     * ⚠️ 走 `ChromiumSession.dispose()`：它内部是 `kill()`（`taskkill /T /F`，同步等它
     * 退干净）+ 临时 profile 的**退避重试删除**。不要在别处自己 `rmSync` ——
     * 那些「每条都是真实缺陷换来的」纪律就在那里（见 `chromium-session.ts` 模块头）。
     * ⚠️ 收尾失败**不抛**：调用点在 `finally`，抛错会盖掉真正的登录结果。
     */
    close() {
        if (this.closed)
            return;
        this.closed = true;
        try {
            this.session.dispose();
        }
        catch {
            // 尽力而为：窗口/进程/目录各自都有兜底（系统会回收临时目录）。
        }
    }
    async waitForCredential(timeoutMs = this.defaultTimeoutMs) {
        return await this.wait(timeoutMs);
    }
}
/**
 * 起浏览器并打开 magicrew 网页登录页（**独立 profile、可见窗口**）。
 *
 * 找不到浏览器 ⇒ 抛 {@link BrowserDeploymentError}（`deployKind: 'browser-not-found'`），
 * 文案里带 {@link browserNotFoundMessage} 的分平台提示与本次**真的尝试过**的候选清单。
 *
 * ⚠️ 这是**唯一**会 `spawn` 浏览器的函数；单测只允许以
 * `resolveBrowser: () => undefined`（测找不到那条路）或干脆不调它。
 */
export async function createChromiumMagicrewLogin(url, deps = {}) {
    const hostname = hostnameOf(url);
    if (hostname.length === 0) {
        // ⚠️ 非法 origin 必须**立刻**报错，不能起一个浏览器然后永远等不到凭据
        //   （那两件事在用户眼里同形，而原因完全不同）。
        throw new Error(`超级麦吉: 网页登录地址非法（${JSON.stringify(url)}）—— 无法定位 localStorage`);
    }
    /** 两种站点写法（`www.` 前后），CDP 与磁盘两条腿共用同一口径。 */
    const hostnames = siteHostnames(hostname);
    const executable = deps.executablePath ?? (deps.resolveBrowser ?? findBrowserExecutable)();
    if (executable === undefined || executable.length === 0) {
        /**
         * ⚠️⚠️ 文案**必须**由 {@link browserNotFoundMessage} 生成（不自己编）：
         * 它按平台说人话（macOS 上没有 scoop、`chrome.exe` 也不是那个文件名），
         * 并回显「本进程看到的候选清单」——那是用户唯一能自查的东西。
         *
         * ⚠️ `tried` 只列**真的会被尝试**的候选（绝对路径 + 非空）：`findBrowserExecutable`
         * 会跳过相对路径（空环境变量会拼出 `Google\Chrome\Application\chrome.exe`），
         * 而 `browserCandidates()` 原样返回它们 ⇒ 不过滤就会宣称「已尝试 N 条」
         * 而其中有几条根本没试过（该纪律的取证见 `chromium-session.ts` 同名注释）。
         *
         * ⚠️ 环境变量名用宿主共享的那个（`ZCODE_CHROME_PATH`）：`browserCandidates`
         * **只读它**，换一个名字写文案等于骗用户去设一个不会被读的变量。
         */
        throw new BrowserDeploymentError('超级麦吉: 找不到可用的浏览器（网页版登录需要本机有一个 Chromium 内核浏览器）。'
            + browserNotFoundMessage(deps.platform ?? process.platform, 'ZCODE_CHROME_PATH', {
                tried: browserCandidates({ platform: deps.platform })
                    .filter((candidate) => candidate.length > 0 && isAbsolute(candidate)),
                overrideValue: process.env.ZCODE_CHROME_PATH,
            }), 'browser-not-found');
    }
    // 开窗前先把上次没删掉的一次性 profile 收掉（理由见该函数注释）。
    const staleRemoved = collectStaleLoginProfiles();
    if (staleRemoved > 0) {
        deps.log?.(`[jet-hub] 超级麦吉 回收了 ${staleRemoved} 个上次遗留的临时浏览器 profile（%TEMP%/${LOGIN_PROFILE_PREFIX}*）`);
    }
    const session = new ChromiumSession({
        executablePath: executable,
        /**
         * ⚠️⚠️ **窗口必须可见**（`hideWindow: false`）：用户要在这个窗口里自己登录。
         * 缺省是 `true`（把窗口移出屏幕 / 进不了任务栏）—— 那是给 captcha 用的，
         * 用在这里等于「点了没反应」。
         */
        hideWindow: false,
        windowSize: '1024,800',
        // 每次登录一个**一次性** profile（理由见文件头）。
        profilePrefix: LOGIN_PROFILE_PREFIX,
        initialUrl: url,
        ...deps.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: deps.readyTimeoutMs },
        label: '超级麦吉',
        notFoundHint: '（网页版登录需要本机有一个 Chromium 内核浏览器）',
        ...deps.log === undefined ? {} : { log: deps.log },
    });
    try {
        await session.start();
    }
    catch (error) {
        /**
         * ⚠️ 起不来时**必须** dispose：`launch()` 失败路径只 `kill()` 进程树，
         * 临时 profile 目录由 `dispose()` 才删（它内部有退避重试）。
         * 不调就会在 `%TEMP%` 里留下一个 `magicrew-login-*` 目录（每次失败一个）。
         */
        session.dispose();
        throw error;
    }
    const profileDir = session.userDataDir ?? '';
    const read = createProfileCredentialReader(profileDir, hostname, {
        ...deps.readCreds === undefined ? {} : { readCreds: deps.readCreds },
    });
    /**
     * ⚠️⚠️ **实时（CDP）是主路径，磁盘是兜底**（见文件头「必须 CDP 实时优先」）：
     * 只读磁盘会出现「用户明明登录成功、插件白转 4 分钟」——Chromium 不关窗不落盘。
     *
     * `hostnames` 给两种写法（`www.letsmagic.cn` / `letsmagic.cn`），命中判据是
     * **同站点**而不是全串等值：登录成功后 URL 会变成
     * `/global/super/workspace/…`（用户截图里的真实形态）。
     */
    const readRealtime = deps.readRealtime
        ?? ((target) => readCredentialViaCdpDetailed(target, hostnames));
    return new ChromiumProfileLogin(session, {
        read,
        readRealtime: () => readRealtime(session),
        ...deps.now === undefined ? {} : { now: deps.now },
        ...deps.sleep === undefined ? {} : { sleep: deps.sleep },
        ...deps.pollIntervalMs === undefined ? {} : { pollIntervalMs: deps.pollIntervalMs },
        ...deps.log === undefined ? {} : { log: deps.log },
    }, normalizeTimeoutMs(deps.timeoutMs));
}
/**
 * 起浏览器打开 magicrew 登录页（独立 profile），返回一个「等用户登完」的会话。
 *
 * ## ⚠️ 打开的 URL 是 `product.webOrigin`，**不是** `product.host`
 *
 * 理由见文件头第二段（API 子域上用户根本没法登录）。这一条有单测钉住
 * （断言注入的 `sessionFactory` 收到的就是 `webOrigin`），因为写错了**不会报错**、
 * 只会永远等不到凭据。
 *
 * @example
 * ```ts
 * const login = await startMagicrewBrowserLogin({ product: MAGICREW })
 * try {
 *   const credential = await login.waitForCredential(120_000)
 * } finally {
 *   login.close()   // ⚠️ 必须：否则窗口与进程残留
 * }
 * ```
 */
export async function startMagicrewBrowserLogin(options = {}) {
    const product = options.product ?? MAGICREW;
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    /**
     * ⚠️⚠️ **网页域 + `/login` 路径**（见文件头）。两个都要对：
     * - `product.host` 是 API 子域 `i-magic-service.letsmagic.cn` —— 用户不会在那上面
     *   登录，localStorage 也不会在那个 origin 下有条目；
     * - **光有裸域是首页、不是登录页**（2026-10-29 用户实测报障：弹出
     *   `https://www.letsmagic.cn/` 而参考实现弹的是 `/login?...`，用户在那页上
     *   找不到登录框）。
     * ⚠️ **不带邀请码**（用户 2026-10-29 明确要求）：`?invitation=` 会把新注册的号
     * 挂在某个邀请码下。本插件不代用户决定属于谁 —— 要带就由他自己在网页里填。
     */
    const url = `${product.webOrigin}/login`;
    const factory = options.sessionFactory
        ?? ((target) => createChromiumMagicrewLogin(target, {
            product,
            timeoutMs,
            ...options.log === undefined ? {} : { log: options.log },
        }));
    return await factory(url);
}
//# sourceMappingURL=magicrew-browser-login.js.map