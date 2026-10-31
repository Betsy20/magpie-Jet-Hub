/**
 * 从**本机浏览器的 localStorage** 里读 magicrew 登录态 —— 不开窗口、不让用户粘任何东西。
 *
 * 这是超级麦吉三种登录方式里**最简单、无门槛**的一条：用户只要在 Edge / Chrome 里
 * 登录过 `www.letsmagic.cn`，凭据就已经躺在磁盘上了。
 *
 * ## ═══ 为什么需要这条路 ═══════════════════════════════════════════════
 *
 * magicrew 没有 OAuth 回调通道，所以「用户在网页上登录成功」这件事，插件原本只能靠
 * 「自己起的那个浏览器」知道。于是有一个反复被报的现象：**用户在自己浏览器里登好了，
 * 插件里却没有多出账号** —— 因为那是另一个浏览器。
 *
 * 但凭据其实就躺在本地：Chromium 系（Edge / Chrome / Brave / 国产 Chromium 系）把
 * localStorage 明文写在
 *
 *     <User Data>/<Default|Profile N>/Local Storage/leveldb/*.log|*.ldb
 *
 * 里，key 是 `_<origin>\x00\x01<name>`，值是 JSON。
 *
 * ## ═══ 读法（与参考实现逐条对齐）═══════════════════════════════════════
 *
 * 把 leveldb 目录按 **latin1** 拼成文本 → 以站点 host 出现的位置开一个 **2000 字节
 * 窗口** → 在窗口里找 `"key":"authorization"` 与 `"key":"organizationCode"`。
 *
 * ⚠️ LevelDB **按 key 排序**，同一 origin 的记录（theme / i18n / userInfo /
 * authorization / organizationCode …）挨在一起，所以窗口内配对是可靠的
 * （实测本机 Edge：`www.letsmagic.cn` 命中、`www.magicrew.ai` 不命中，不会串）。
 * ⚠️ 窗口必须按 **origin** 截断：两个站点的记录可能相邻（用户两个都登录过），
 * 2000 字节的窗口会把国际站的 org 配到国内站的 jwt 上。
 *
 * 成本：本机 Edge 27 MB / 34 ms；全扫通常 < 300 ms。
 *
 * ## ⚠️ 只读
 *
 * 不写文件、不改浏览器数据、不碰 cookie。本模块唯一的副作用是 `readdirSync` /
 * `readFileSync`。
 *
 * ## ⚠️ 不读 magpie 自己的目录
 *
 * 参考实现（`magpie-magicrew-auth/src/local-browser.mjs`）与它同目录，但**刻意不读**
 * `~/.config/magpie` —— 那是 magpie 的落点，本插件不该依赖另一个产品的私有目录。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
/**
 * 窗口宽度。
 *
 * 同一个 origin 的若干条记录挤在一起，2000 字节足够覆盖到 `organizationCode`；
 * 太小会漏、太大可能跨到另一个站点。
 */
export const MAGICREW_LOCAL_WINDOW = 2000;
/**
 * 各平台的浏览器 User Data 根目录；不存在就跳过。
 *
 * ⚠️ Windows 为主（本插件用户面），macOS / Linux 照参考实现给全 —— 少一行
 * 只意味着「那个浏览器上的已登录态读不到」，不会报错，极难发现。
 */
export function magicrewBrowserRoots() {
    const home = homedir();
    if (process.platform === 'win32') {
        const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
        const roaming = process.env.APPDATA || join(home, 'AppData', 'Roaming');
        return [
            // ── 国际主流 ──
            { browser: 'Edge', root: join(local, 'Microsoft', 'Edge', 'User Data') },
            { browser: 'Chrome', root: join(local, 'Google', 'Chrome', 'User Data') },
            { browser: 'Brave', root: join(local, 'BraveSoftware', 'Brave-Browser', 'User Data') },
            { browser: 'Chromium', root: join(local, 'Chromium', 'User Data') },
            { browser: 'Vivaldi', root: join(local, 'Vivaldi', 'User Data') },
            // ── 国产 Chromium 系 ──
            // ⚠️ 参考实现 2026-10-28 实测：用户日常用的是 360 极速浏览器 X（360ChromeX），
            //   它的 localStorage 里确实有 www.letsmagic.cn 的记录。不加这一行，
            //   「本机浏览器已登录就直接认」这条首选路径对它永远不生效 ——
            //   用户明明在网页上登着，插件却还要他再登一次。
            { browser: '360极速浏览器X', root: join(local, '360ChromeX', 'Chrome', 'User Data') },
            { browser: '360浏览器', root: join(local, '360Chrome', 'Chrome', 'User Data') },
            { browser: '360安全浏览器', root: join(roaming, 'secoresdk', '360se6', 'User Data') },
            { browser: 'QQ浏览器', root: join(local, 'Tencent', 'QQBrowser', 'User Data') },
            { browser: '搜狗浏览器', root: join(local, 'SogouExplorer', 'User Data') },
            { browser: '2345浏览器', root: join(local, '2345Explorer', 'User Data') },
            { browser: '猎豹浏览器', root: join(local, 'liebao', 'User Data') },
            { browser: 'UC浏览器', root: join(local, 'UCBrowser', 'User Data') },
            { browser: '夸克浏览器', root: join(local, 'Quark', 'User Data') },
        ];
    }
    if (process.platform === 'darwin') {
        return [
            { browser: 'Chrome', root: join(home, 'Library/Application Support/Google/Chrome') },
            { browser: 'Edge', root: join(home, 'Library/Application Support/Microsoft Edge') },
            { browser: 'Brave', root: join(home, 'Library/Application Support/BraveSoftware/Brave-Browser') },
            { browser: 'Chromium', root: join(home, 'Library/Application Support/Chromium') },
            { browser: 'Vivaldi', root: join(home, 'Library/Application Support/Vivaldi') },
        ];
    }
    return [
        { browser: 'Chrome', root: join(home, '.config/google-chrome') },
        { browser: 'Chromium', root: join(home, '.config/chromium') },
        { browser: 'Edge', root: join(home, '.config/microsoft-edge') },
        { browser: 'Brave', root: join(home, '.config/BraveSoftware/Brave-Browser') },
        { browser: 'Vivaldi', root: join(home, '.config/vivaldi') },
    ];
}
/** 一个 User Data 根目录下的 profile 目录名（`Default` / `Profile 1` …）。 */
export function magicrewProfilesOf(root) {
    try {
        return readdirSync(root).filter((name) => name === 'Default' || /^Profile \d+$/.test(name));
    }
    catch {
        return [];
    }
}
/**
 * 一个 profile 的 leveldb 文本（按 **latin1** 拼）。
 *
 * ⚠️ latin1 而不是 utf8：leveldb 文件是二进制，utf8 解码会把非法字节换成 U+FFFD、
 * 长度也会变 —— 而窗口是按字节位置算的。latin1 是**逐字节**映射，位置不变。
 */
function leveldbTextForProfile(root, profile, hostname) {
    return leveldbTextOfDir(join(root, profile, 'Local Storage', 'leveldb'))
        + '\n'
        + indexedDbTextFor(join(root, profile, 'IndexedDB'), hostname);
}

/**
 * 一个 leveldb 目录（或它的上级目录）的文本。
 *
 * ⚠️ 传上级目录时递归一层：每个站点一个 `https_<host>_0.indexeddb.leveldb` 子目录。
 */
function leveldbTextOfDir(dir) {
    let files;
    try {
        files = readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return '';
    }
    let text = '';
    for (const entry of files) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            text += leveldbTextOfDir(full);
            continue;
        }
        try {
            text += readFileSync(full).toString('latin1');
        }
        catch {
            // 单个文件读不到（被浏览器独占 / 权限）⇒ 跳过，不影响其余文件。
        }
    }
    return text;
}

/**
 * 只读**目标站点**的 IndexedDB 目录（`https_<host>_0.indexeddb.leveldb`）。
 *
 * ⚠️⚠️ **不能把整个 `IndexedDB` 目录全扫**：实测本机 Edge 有 **150+ 个站点目录、1.7 GB**
 * （这个数随你上过的网站增长，别当常数），全扫会直接 `RangeError: Invalid string length`
 * （字符串上限 ~512 MB）—— 那是一个每次都会发生的硬崩。按站点定位后单目录通常只有几十 KB。
 *
 * 目录名形式：`https_www.letsmagic.cn_0.indexeddb.leveldb`（非默认端口时带 `_<port>`）。
 */
function indexedDbTextFor(dir, hostname) {
    const host = String(hostname ?? '').trim().toLowerCase();
    if (host.length === 0)
        return '';
    const bare = host.replace(/^www\./, '');
    const wanted = [host, bare, `www.${bare}`].filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return '';
    }
    let text = '';
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        // ⚠️ 必须完整匹配站点名：`https_account.microsoft.com_0` 不能被 `microsoft.com` 命中。
        const match = /^(https?)_(.+?)(?:_(\d+))?\.indexeddb\.(?:leveldb|blob)$/.exec(entry.name);
        if (match === null)
            continue;
        const site = match[2].toLowerCase();
        if (!wanted.includes(site))
            continue;
        text += leveldbTextOfDir(join(dir, entry.name));
    }
    return text;
}
/**
 * 一个 User Data 根目录下**全部 profile** 的 leveldb 文本。
 *
 * ⚠️ 多 profile 之间用 `\n` 隔开：不隔开时前一个 profile 的尾部与后一个的头部
 * 会拼成一条**不存在的**记录（可能凭空造出一对 jwt × org）。
 */
export function leveldbTextFor(root, hostname = '') {
    const texts = magicrewProfilesOf(root)
        .map((profile) => leveldbTextForProfile(root, profile, hostname))
        .filter((text) => text.length > 0);
    return texts.join('\n');
}
/** jwt 里的 `iat` / `exp`；解不出来返回 0（**不猜**）。 */
export function jwtTimes(jwt) {
    try {
        const payload = String(jwt ?? '').split('.')[1] ?? '';
        const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return {
            iat: typeof body.iat === 'number' && Number.isFinite(body.iat) ? body.iat : 0,
            exp: typeof body.exp === 'number' && Number.isFinite(body.exp) ? body.exp : 0,
        };
    }
    catch {
        return { iat: 0, exp: 0 };
    }
}
/** LevelDB 里一条记录的前缀：`_https://<origin>\x00\x01<name>`。 */
const ORIGIN_RE = /_https?:\/\/([^\x00\x01"\\]{4,80})\x00\x01/g;
/**
 * magicrew 的 localStorage 记录形态（与参考实现逐字一致）：
 *
 * ```
 * {"key":"authorization","value":"eyJ…"}
 * {"key":"organizationCode","value":"…"}
 * ```
 *
 * ⚠️ 两套形态：直接写在 leveldb 里的是**裸 JSON**；若整条记录被当成字符串再
 * 序列化一次（某些浏览器/写入路径会这样），引号会变成 `\"`。两套都认，
 * 且各自留了 `\s*` 容错（chromium 自己写的是紧凑格式，但不值得赌死）。
 */
const AUTHORIZATION_PATTERNS = [
    /"key"\s*:\s*"authorization"\s*,\s*"value"\s*:\s*"(eyJ[^"]+)"/g,
    /\\"key\\"\s*:\s*\\"authorization\\"\s*,\s*\\"value\\"\s*:\s*\\"(eyJ[^"\\]+)/g,
];
const ORGANIZATION_PATTERNS = [
    /"key"\s*:\s*"organizationCode"\s*,\s*"value"\s*:\s*"([^"]*)"/g,
    /\\"key\\"\s*:\s*\\"organizationCode\\"\s*,\s*\\"value\\"\s*:\s*\\"([^"\\]*)/g,
];
function* matchesWithIndex(patterns, chunk) {
    for (const pattern of patterns) {
        // ⚠️ `matchAll` 会克隆正则内部状态，模块级 `/g` 正则因此可安全复用。
        for (const match of chunk.matchAll(pattern)) {
            if (match.index === undefined)
                continue;
            yield { index: match.index, value: match[1] ?? '' };
        }
    }
}
/**
 * IndexedDB 里的登录态：**编码形态与 localStorage 完全不同**。
 *
 * 这是 2026-10-30 真机报障的根因（用户「网页已登录成功、插件还提示请完成登录」）：
 * magicrew 网页把凭据写在 `IndexedDB/https_<host>_0.indexeddb.leveldb` 的
 * `magic-global` 库里，而不是 localStorage。实测字节形态：
 *
 * - **JWT 值是 UTF-16LE**：`e\0y\0J\0…`（每个 ASCII 字符后面跟一个 NUL），
 *   而且候选段前面还粘着记录头部的控制字节（实测是 `\x02`）；
 * - **组织码记录是单字节 latin1**，不带 JSON 包装：
 *   `magic_organization_code"<长度字节><值>"`（例：`..._code"\x0cevro2209i6j0"`）。
 *
 * 于是上面那套 `"key":"authorization","value":"eyJ…"` 的裸 JSON 正则在这里一条都匹配不上
 * —— 这就是「文本里明明有 `authorization` 和 `eyJ`、`credsNear()` 却返回 0 条」的原因。
 *
 * ⚠️ 全部用 `indexOf` 手写扫描，不写正则：这套字节里 `\s`、`\u0000` 这类转义经过
 * 模板字符串和层层 shell 后极易被吃掉一层，实测踩过两次（`[\s\S]` 变成 `[sS]`）。
 */
const IDB_ORGANIZATION_KEYS = [
    'magic_organization_code',
    'teamshare_organization_code',
    'third_platform_organization_code',
];
/** 三段式 JWT 的固定开头。与 `magicrew-browser-login.js` 的 `isJwtShaped()` 同判据。 */
const IDB_JWT_HEAD = 'e\u0000y\u0000J\u0000';
const IDB_JWT_MIN = 80;

/** 把 UTF-16LE 的 ASCII 段解回普通字符串；不是这种段就返回空串。 */
function utf16AsciiAt(text, at) {
    let out = '';
    for (let cursor = at; cursor + 1 < text.length; cursor += 2) {
        const code = text.charCodeAt(cursor);
        if (text.charCodeAt(cursor + 1) !== 0)
            break;
        if (code < 0x20 || code > 0x7e)
            break;
        out += text[cursor];
    }
    return out;
}

/** 扫出文本里所有「像 JWT」的 UTF-16LE 段（去重、保持出现顺序）。 */
function idbJwtsIn(text) {
    const out = [];
    const seen = new Set();
    let at = -1;
    while ((at = text.indexOf(IDB_JWT_HEAD, at + 1)) !== -1) {
        const jwt = utf16AsciiAt(text, at);
        if (jwt.length < IDB_JWT_MIN || jwt.split('.').length !== 3)
            continue;
        if (seen.has(jwt))
            continue;
        seen.add(jwt);
        out.push({ index: at, jwt });
    }
    return out;
}

/** 扫出文本里所有 `<键>"<长度字节><值>` 形态的组织码记录。 */
function idbOrganizationsIn(text) {
    const out = [];
    for (const key of IDB_ORGANIZATION_KEYS) {
        const needle = `${key}"`;
        let at = -1;
        while ((at = text.indexOf(needle, at + 1)) !== -1) {
            const start = at + needle.length;
            const length = text.charCodeAt(start);
            // 长度字节必须像个长度：0 或 >128 一律当误命中（真实值是 12 上下）。
            if (!(length > 0 && length <= 128))
                continue;
            const value = text.slice(start + 1, start + 1 + length);
            if (!/^[\x20-\x7e]+$/.test(value))
                continue;
            out.push({ index: at, value });
        }
    }
    out.sort((left, right) => left.index - right.index);
    return out;
}

/**
 * 从 IndexedDB 的 leveldb 文本里取 `jwt × organizationCode`。
 *
 * ⚠️ 这里的 host 归属由**调用方**保证（`indexedDbTextFor()` 只读目标站点那一个目录），
 * 所以不再做窗口截断 —— IndexedDB 的记录里站点名只出现在库名旁边，按窗口配对会漏。
 */
export function idbCredentialsIn(text) {
    if (typeof text !== 'string' || text.length === 0)
        return [];
    const jwts = idbJwtsIn(text);
    if (jwts.length === 0)
        return [];
    const orgs = idbOrganizationsIn(text);
    if (orgs.length === 0)
        return [];
    const out = [];
    for (const found of jwts) {
        // ⚠️ 组织码取「这条 jwt **之后**最近的那个」；实在没有才退回第一个。
        // 与 `credsNear()` 同一条理由：同一站点可能存过多套凭据，配错会得到
        // HTTP 200 + `code:403`，极难归因。
        const org = orgs.find((candidate) => candidate.index > found.index) ?? orgs[0];
        out.push({ jwt: found.jwt, organizationCode: org.value });
    }
    return out;
}
/** host 的全部写法：`www.letsmagic.cn` / `letsmagic.cn`（去重、保持顺序）。 */
function hostsFor(hostname) {
    const host = String(hostname ?? '').trim();
    if (host.length === 0)
        return [];
    const bare = host.replace(/^www\./, '');
    const hosts = [host, bare, `www.${bare}`];
    return hosts.filter((value, index) => value.length > 0 && hosts.indexOf(value) === index);
}
/**
 * 在 host 每一次出现的位置开窗，取窗口内同一 origin 的 `jwt × organizationCode`。
 *
 * 截断点 = 「下一个**不同站点**的 origin」，同站点的多条记录不截断。
 *
 * ⚠️ 每把 jwt 配**它自己后面**最近的那个组织码：LevelDB 按 key 排序
 * （`authorization` < `organizationCode`），同一批写入的挨在一起；取「窗口内第一个
 * org」会在同一站点存过多套凭据时配错（症状：HTTP 200 + `code:403` 且极难归因）。
 */
export function credsNear(text, hostname, window = MAGICREW_LOCAL_WINDOW) {
    const host = String(hostname ?? '').trim();
    if (text.length === 0 || host.length === 0)
        return [];
    const bare = host.replace(/^www\./, '');
    const origins = [];
    for (const match of text.matchAll(ORIGIN_RE)) {
        origins.push({ host: match[1] ?? '', at: match.index ?? 0 });
    }
    const out = [];
    const seen = new Set();
    let at = -1;
    while ((at = text.indexOf(host, at + 1)) !== -1) {
        let stop = Math.min(text.length, at + window);
        for (const origin of origins) {
            if (origin.at > at && !origin.host.includes(bare)) {
                stop = origin.at;
                break;
            }
        }
        const slice = text.slice(at, stop);
        const jwts = [...matchesWithIndex(AUTHORIZATION_PATTERNS, slice)]
            .sort((left, right) => left.index - right.index);
        const orgs = [...matchesWithIndex(ORGANIZATION_PATTERNS, slice)]
            .sort((left, right) => left.index - right.index);
        for (const jwt of jwts) {
            const org = orgs.find((candidate) => candidate.index > jwt.index);
            // ⚠️ 没有 org 就**不产出**：宁可读不到（调用方降级去开窗口登录），
            // 也绝不编造空串 —— 空 organizationCode 与 jwt 配对在上游是
            // HTTP 200 + `code:403`，比「没读到」难查得多。
            if (org === undefined || org.value.length === 0)
                continue;
            const key = `${jwt.value}\u0000${org.value}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            out.push({ jwt: jwt.value, organizationCode: org.value });
        }
    }
    // IndexedDB 那一路单独走：它的编码形态与 localStorage 完全不同，且站点归属
    // 已由目录筛选保证，套不进上面的 host 开窗逻辑。
    for (const found of idbCredentialsIn(text)) {
        const key = `${found.jwt}\u0000${found.organizationCode}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(found);
    }
    return out;
}
/**
 * 读本机浏览器里属于这个站点的登录态。
 *
 * @param hostname 站点 host，例如 `www.letsmagic.cn`（与 localStorage key 里的
 *                 origin 同源，**不是** API 子域）
 * @returns 取 iat 最新的那份凭据；读不到返回 `undefined`（调用方降级到窗口登录）。
 *
 * ⚠️⚠️ **过期与否不在这里拦**：同一份 leveldb 里可能同时留着一旧一新两套记录
 * （用户重登过），此时优先给**未过期**的那份；但如果**只有**过期的那份，照样返回
 * —— 「凭据过期」由调用方（以及上游）判定，在这里拦掉会让「刚过期但 refresh_token
 * 还能用」的账号**白丢一条自救路径**。
 */
export function readMagicrewLocalCreds(hostname, options = {}) {
    const host = String(hostname ?? '').trim();
    if (host.length === 0)
        return undefined;
    const now = options.now ?? Date.now();
    const roots = options.roots ?? magicrewBrowserRoots().map((entry) => entry.root);
    const hosts = hostsFor(host);
    let best;
    for (const root of roots) {
        const text = leveldbTextFor(root, host);
        if (text.length === 0)
            continue;
        for (const candidateHost of hosts) {
            for (const found of credsNear(text, candidateHost)) {
                const { iat, exp } = jwtTimes(found.jwt);
                const expiresAt = exp > 0 ? exp * 1000 : undefined;
                const candidate = {
                    jwt: found.jwt,
                    organizationCode: found.organizationCode,
                    iat,
                    expiresAt,
                    expired: expiresAt !== undefined && expiresAt <= now,
                };
                if (best === undefined) {
                    best = candidate;
                    continue;
                }
                // 未过期的优先；同一档里取 iat 最新的。两者都缺（解不出 iat）时保留先找到的
                // —— 顺序取决于目录遍历，故不在无据可依时反复改选。
                if (best.expired !== candidate.expired) {
                    if (!candidate.expired)
                        best = candidate;
                    continue;
                }
                if (candidate.iat > best.iat)
                    best = candidate;
            }
        }
    }
    if (best === undefined)
        return undefined;
    return {
        jwt: best.jwt,
        organizationCode: best.organizationCode,
        ...best.expiresAt === undefined ? {} : { expiresAt: best.expiresAt },
    };
}
//# sourceMappingURL=magicrew-local-browser.js.map