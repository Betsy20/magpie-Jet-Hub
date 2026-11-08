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
import { registeredBrowserUserDataRoots } from './chromium-session.js';
import { leveldbRecordsText, leveldbVisibleRecords, readSstableRecords, readWalRecords, } from './leveldb-sstable.js';
/**
 * 窗口宽度。
 *
 * 同一个 origin 的若干条记录挤在一起，2000 字节足够覆盖到 `organizationCode`；
 * 太小会漏、太大可能跨到另一个站点。
 */
export const MAGICREW_LOCAL_WINDOW = 2000;
/**
 * 已经 warn 过的 leveldb 文件路径（防 500ms 轮询刷屏）。
 *
 * ⚠️ **按日志出口（`log` 函数身份）分别去重**，不是全局一张表：
 * `magicrew` 与 `magicrewintl` 是两个 `MagicrewAuth` 实例、扫**同一批**浏览器
 * 路径（`magicrewBrowserRoots()` 与 product 无关）。若用模块级 Set 按路径去重，
 * 先跑的那个 provider 会把路径「吃掉」⇒ **另一个 provider 的 logger 永远收不到**
 * （2026-11-05 审计 P2-①）。用 `WeakMap<log, Set<path>>` 让每个实例各报一次；
 * 未注入 `log` 时回落到模块级 `console.warn` 去重表。
 */
const warnedLeveldbFilesByLog = new WeakMap();
const warnedLeveldbFilesDefault = new Set();
/**
 * 每个文件只 warn 一次（跨 500ms 轮询），但**按日志出口分别计数**。
 */
function warnLeveldbParseFailure(log, path, reason) {
    const sink = log ?? console.warn;
    let warned = warnedLeveldbFilesByLog.get(sink);
    if (warned === undefined) {
        warned = new Set();
        warnedLeveldbFilesByLog.set(sink, warned);
    }
    const seen = log === undefined ? warnedLeveldbFilesDefault : warned;
    if (seen.has(path))
        return;
    seen.add(path);
    sink(`[magicrew] leveldb 文件解析失败，已跳过：${path}（${reason}）`);
}
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
            // Windows App Paths 会登记便携版 Chrome；其 `<install>/Data` 不在上面的固定目录里。
            ...registeredBrowserUserDataRoots().map((root) => ({ browser: '已登记浏览器（含便携版）', root })),
            ...process.env.MAGICREW_CHROME_USER_DATA?.trim()
                ? [{ browser: 'Chrome 便携版', root: process.env.MAGICREW_CHROME_USER_DATA.trim() }]
                : [],
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
 * 一个 leveldb 文件的**结构化**内容。
 *
 * ## ⚠️⚠️ 为什么不再直接返回文本（2026-11-05 返工 P2-2 / P2-3）
 *
 * 同一条 localStorage key 的多次写入会横跨 `.ldb`（旧值）与 `.log`（WAL 新值 /
 * tombstone），必须**先收集记录、再按 sequence 取最新**（{@link leveldbVisibleRecords}），
 * 否则「先登出再登录」会配到空值而漏读、「登出」会复活旧 org。
 * ⇒ 本函数只负责**单个文件**的解析与失败隔离，去重与渲染交给 profile 层。
 *
 * `.log` 若是合法 WAL（WriteBatch）就解成记录；**不是**（`LOG`、`MANIFEST-*`、
 * 测试里直接写的明文）则退回 latin1 原文 —— 与旧行为一致，不会因为「不是 WAL」
 * 就丢掉里面的凭据。
 */
function leveldbContentForFile(path, name, log) {
    let buffer;
    try {
        buffer = readFileSync(path);
    }
    catch {
        // 被浏览器独占 / 权限 / 刚被删（Edge 会滚动删文件）⇒ 跳过。
        return undefined;
    }
    // ⚠️ `.sst` 是 LevelDB 的另一种表文件后缀（老版本 / 某些分支这样落盘），
    //    与 `.ldb` 同格式；此前只认 `.ldb` ⇒ `.sst` 会退回「原文扫描」那条坏路。
    // ⚠️ 大小写不敏感：Windows 上 `000003.LDB` / `.SST` 是合法变体，漏了就会退回
    //    「原文扫描」那条坏路（从原始字节里编造凭据，2026-11-05 对抗审计 P3-3）。
    const lowerName = name.toLowerCase();
    if (lowerName.endsWith('.ldb') || lowerName.endsWith('.sst')) {
        try {
            return { records: readSstableRecords(buffer), rawText: '' };
        }
        catch (error) {
            // 不是合法 SSTable（半截写入 / 未知格式）⇒ 当作这个文件没有可用记录。
            // ⚠️ 只 warn 一次：这条路径每 500ms 走一次，逐次 warn 会刷屏。
            warnLeveldbParseFailure(log, path, error instanceof Error ? error.message : String(error));
            return undefined;
        }
    }
    if (lowerName.endsWith('.log')) {
        const records = readWalRecords(buffer);
        if (records !== undefined)
            return { records, rawText: '' };
    }
    return { records: [], rawText: buffer.toString('latin1') };
}
/**
 * 一个 profile 的 leveldb 文本。
 *
 * ⚠️ 文件之间用 `\n` 隔开：不隔开时前一个文件的尾部与后一个的头部会拼成一条
 * **不存在的**记录（可能凭空造出一对 jwt × org）。
 */
function leveldbTextForProfile(root, profile, log, hostname = '') {
    // ⚠️ 本仓改动（2026-10-30）：**两处**都要读。
    //
    // magicrew 网页版把凭据写在 **IndexedDB** 的 `magic-global/user` 库里，
    // `Local Storage` 里只有页面自己的缓存（`fontScale` / `i18n` / `theme` 三条
    // 界面配置也在 IndexedDB，别拿它们当「已经读到凭据」的证据）。
    // 只读 `Local Storage` ⇒ 磁盘那条腿恒读不到 ⇒ 只能靠 CDP 腿硬撑。
    //
    // 两段之间用 `\n` 隔开，理由同上游注释：不隔开时前一个目录的尾部与后一个的
    // 头部会拼成一条**不存在的**记录（可能凭空造出一对 jwt × org）。
    return [leveldbTextOfDir(join(root, profile, 'Local Storage', 'leveldb'), log),
        indexedDbTextFor(join(root, profile, 'IndexedDB'), hostname, log)]
        .filter((text) => text.length > 0)
        .join('\n');
}
/**
 * 一个 leveldb 目录（或它的上级目录）的文本。
 *
 * ⚠️ 传上级目录时递归一层：每个站点一个 `https_<host>_0.indexeddb.leveldb` 子目录。
 *
 * ## ⚠️⚠️ 为什么要抽成独立函数（2026-11-05 返工）
 *
 * `Local Storage/leveldb` 与 `IndexedDB/<site>.indexeddb.leveldb` 是**同一套**
 * LevelDB 格式（`.ldb` / `.sst` 是 SSTable、`.log` 是 WAL），必须走同一条
 * 「先解记录、再按 sequence 取最新」的路径 —— 见 {@link leveldbContentForFile}
 * 与 {@link leveldbVisibleRecords} 的注释。
 *
 * ⚠️ **不要**退回 `readFileSync(...).toString('latin1')` 那条老路：从原始字节里
 * 扫描会编造凭据（2026-11-05 对抗审计 P3-3）。
 */
function leveldbTextOfDir(dir, log) {
    let files;
    try {
        // ⚠️ `withFileTypes` 而不是 `readdirSync(dir)` + `statSync`：后者是 N 次系统
        // 调用，`%TEMP%` 有 19.8 万个条目时实测差一个数量级（同一个坑见
        // `collectStaleLoginProfiles` 的注释）。
        files = readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return '';
    }
    const records = [];
    const rawTexts = [];
    for (const entry of files) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            const nested = leveldbTextOfDir(full, log);
            if (nested.length > 0)
                rawTexts.push(nested);
            continue;
        }
        const content = leveldbContentForFile(full, entry.name, log);
        if (content === undefined)
            continue;
        // ⚠️ 不要用 `records.push(...content.records)`：记录多时 V8 会抛 RangeError。
        for (const record of content.records)
            records.push(record);
        if (content.rawText.length > 0)
            rawTexts.push(content.rawText);
    }
    const visible = leveldbVisibleRecords(records);
    const rendered = visible.length > 0 ? leveldbRecordsText(visible) : '';
    return [rendered, ...rawTexts].filter((text) => text.length > 0).join('\n');
}
/**
 * 只读**目标站点**的 IndexedDB 目录（`https_<host>_0.indexeddb.leveldb`）。
 *
 * ## ⚠️⚠️ 不能把整个 `IndexedDB` 目录全扫
 *
 * 实测本机 Edge 有 **150+ 个站点目录、1.7 GB**（这个数随你上过的网站增长，别当
 * 常数），全扫会直接 `RangeError: Invalid string length`（字符串上限 ~512 MB）
 * —— 那是一个每次都会发生的硬崩。按站点定位后单目录通常只有几十 KB。
 *
 * 目录名形式：`https_www.letsmagic.cn_0.indexeddb.leveldb`（非默认端口时带
 * `_<port>`；另有 `.indexeddb.blob` 兄弟目录，也一并认）。
 */
function indexedDbTextFor(dir, hostname, log) {
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
    const texts = [];
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        // ⚠️ 必须完整匹配站点名：`https_account.microsoft.com_0` 不能被
        // `microsoft.com` 命中。
        const match = /^(https?)_(.+?)(?:_(\d+))?\.indexeddb\.(?:leveldb|blob)$/.exec(entry.name);
        if (match === null)
            continue;
        const site = match[2].toLowerCase();
        if (!wanted.includes(site))
            continue;
        const text = indexedDbRawTextOfDir(join(dir, entry.name), log);
        if (text.length > 0)
            texts.push(text);
    }
    return texts.join('\n');
}
/**
 * 一个 IndexedDB leveldb 目录里**记录原始字节**的 latin1 文本（本仓改动，2026-11-05 返工）。
 *
 * ## ⚠️⚠️ 为什么不能复用 {@link leveldbTextOfDir}
 *
 * 两者只差一步「值怎么解」，但那是**语义**差别：
 *
 * - `Local Storage` 的值是 `\x00` / `\x01` 编码头 + 正文（见 `decodeValue`），
 *   解码后就是 `{"key":"authorization","value":"eyJ…"}` 这种裸 JSON，
 *   `credsNear()` 的正则直接能配。
 * - **IndexedDB 的值是 V8 序列化格式**（`"<字段名>"<长度字节><值>`），
 *   走 `decodeValue` 只会把长度字节当正文，`idbCredentialsIn()` 的
 *   `magic_organization_code"<长度字节><值>"` 判据一条都匹配不上 ——
 *   症状与「用户没登录」完全同形（2026-10-30 真机报障就是这么来的）。
 *
 * ⇒ 这里**刻意**保留原始字节（`record.value.toString('latin1')`），
 * 交给 {@link idbCredentialsIn} 按 IndexedDB 自己的编码形态去解。
 *
 * ⚠️ 但**必须**仍然走 `leveldbContentForFile`（SSTable / WAL 解析 + Snappy 解压）：
 * 退回 `readFileSync().toString('latin1')` 那条老路会把压缩块当成乱码扫，
 * 从原始字节里**编造**凭据（2026-11-05 对抗审计 P3-3）。
 *
 * ⚠️ 文件之间用 `\n` 隔开，理由同 {@link leveldbTextForProfile}。
 */
function indexedDbRawTextOfDir(dir, log) {
    let files;
    try {
        files = readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return '';
    }
    const parts = [];
    for (const entry of files) {
        if (entry.isDirectory())
            continue;
        const content = leveldbContentForFile(join(dir, entry.name), entry.name, log);
        if (content === undefined)
            continue;
        for (const record of content.records) {
            // ⚠️ 不 `decodeValue`：见本函数头「为什么不能复用 leveldbTextOfDir」。
            parts.push(record.key.toString('latin1'), record.value.toString('latin1'));
        }
        // `rawText` 只对「`.log` 但不是合法 WAL」以及 `LOG` / `MANIFEST-*` / `CURRENT`
        // 这些非记录文件非空（`.ldb` / `.sst` 解析失败是 `return undefined` 直接跳过，
        // 不会走到这里）。此时 `rawText` 是整份 latin1 原文 —— 与旧行为一致：宁可多扫
        // 一遍，也不因为「格式没认出来」就丢掉里面的凭据。
        if (content.rawText.length > 0)
            parts.push(content.rawText);
    }
    return parts.join('\n');
}
/**
 * 一个 User Data 根目录下**全部 profile** 的 leveldb 文本。
 *
 * ⚠️ 多 profile 之间用 `\n` 隔开：不隔开时前一个 profile 的尾部与后一个的头部
 * 会拼成一条**不存在的**记录（可能凭空造出一对 jwt × org）。
 */
export function leveldbTextFor(root, log, hostname = '') {
    const texts = magicrewProfilesOf(root)
        .map((profile) => leveldbTextForProfile(root, profile, log, hostname))
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
 * IndexedDB 里的登录态：**编码形态与 localStorage 完全不同**（本仓改动，2026-10-30）。
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
 * 于是 `credsNear()` 那套 `"key":"authorization","value":"eyJ…"` 的裸 JSON 正则在这里
 * 一条都匹配不上 —— 这就是「文本里明明有 `authorization` 和 `eyJ`、
 * `credsNear()` 却返回 0 条」的原因。
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
function idbUtf16AsciiAt(text, at) {
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
        const jwt = idbUtf16AsciiAt(text, at);
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
            // ⚠️ 值必须**整段**落在文本内。WAL 尾部可能半写（长度字节声明 12、实际只剩
            // 5 个字符），而 `slice` 越界是静默截短 —— 截出来的短串只要全可打印就会被
            // 当成组织码，那是**编造**凭据（同 2026-11-05 对抗审计 P3-3 的纪律）。
            if (start + 1 + length > text.length)
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
 * 从 IndexedDB 的 leveldb 文本里取 `jwt × organizationCode`（本仓改动，2026-10-30）。
 *
 * ⚠️ 这里的 host 归属由**调用方**保证（{@link indexedDbTextFor} 只读目标站点那一个
 * 目录），所以不再做窗口截断 —— IndexedDB 的记录里站点名只出现在库名旁边，
 * 按窗口配对会漏。
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
            /**
             * ⚠️⚠️ 只取「jwt 之后**第一个** org」，**不要**跳过空值去够更远的那个
             * （2026-11-05 审计复核：P2-6 的「空值遮蔽」是**误判**）。
             *
             * LevelDB 的 internal key 排序是「user key 升序、同 key 内 **sequence 降序**」
             * ⇒ 同一个 `organizationCode` 的**最新一次写入排在最前**。于是：
             *
             * | 形态 | 含义 | 正确行为 |
             * |---|---|---|
             * | 空值在前、有效值在后（同一 `.ldb`） | 空值 = **较新的 tombstone**（登出/切组织） | 有效值已失效 ⇒ **跳过**（旧行为对） |
             * | 有效值在前、空值在后 | 有效值较新 | 正常配对 |
             * | 跨 `.log` / 跨文件（写入序，旧在前） | 空值较旧 | 严格说该配对更远那个 |
             *
             * 只有**前两种**能靠文本判断，而第三种需要 8 字节 trailer 里的 sequence
             * （`leveldbRecordsText` 刻意丢弃了它）。在「读不到」与「复活一个已删除的
             * 组织」之间，后者更糟：`jwt_stale × org_new` 在上游是 HTTP 200 + `code:403`，
             * 且会把一个**已登出**的账号加回池里。
             *
             * ⇒ 保守取第一个（含空值），空值就放弃这把 jwt。
             * 后续若要做对：按 user key 取**最大 sequence**、值为空即视为 tombstone 丢弃
             * （见 `docs/agent-notes/providers-magicrew.md` 的「已知边界」）。
             */
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
    // 本仓改动（2026-10-30）：IndexedDB 那一路单独走 —— 它的编码形态与 localStorage
    // 完全不同（UTF-16LE JWT + 长度前缀组织码），且站点归属已由目录筛选保证
    // （见 `indexedDbTextFor`），套不进上面的 host 开窗逻辑。
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
        const text = leveldbTextFor(root, options.log, host);
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