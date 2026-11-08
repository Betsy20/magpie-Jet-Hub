/**
 * 极简 **LevelDB SSTable（`.ldb`）读取器 + Snappy 解压** —— 只做一件事：
 * 把 Chromium 系浏览器 `Local Storage/leveldb/*.ldb` 里的记录解出来。
 *
 * ## ═══ 为什么必须有它（真机报障 2026-11-04）═══════════════════════════════
 *
 * 旧实现（`magicrew-local-browser.ts` 的 `leveldbTextForProfile`）把 `.ldb` 直接
 * `readFileSync(...).toString('latin1')` 拼成文本，然后在文本里正则找
 * `"key":"authorization"` —— **永远找不到**，因为：
 *
 * 1. 记录被 LevelDB **按 key 前缀压进 data block**（每条记录只存「与上一条的公共前缀
 *    之后的差异部分」）；
 * 2. 这些 block **整块被 Snappy 压缩**（实测本机 Edge `071584.ldb`：index block 指向
 *    的 60 个 data block，压缩类型**全部**是 `1`）。
 *
 * ⇒ 原始字节里 `"key":"authorization"` 出现 **0 次**（本机实测 `indexOf` 返回 -1）。
 *   更隐蔽的是：**光做前缀还原还不够** —— Snappy 会把 JWT 这种长 base64 串按重复片段
 *   回引（copy tag），所以解压后必须**真正重建**那段字节，单纯的「跳过压缩头再读」也读不全。
 *
 * ## ═══ 只实现「读」需要的那部分 ═══════════════════════════════════════════
 *
 * | 环节 | 本模块 | 说明 |
 * |---|---|---|
 * | Footer / 索引块 | ✅ | 固定 48 字节，末尾 8 字节是 magic |
 * | Data block 解压 | ✅ | 压缩类型 `0`（不压）/ `1`（Snappy） |
 * | 前缀压缩 entry 还原 | ✅ | restart 数组用不上（我们只要**全部**记录，不做点查） |
 * | Bloom filter / Snappy 压缩 | ❌ | 只读一侧，不需要 |
 *
 * ⚠️ **不做安全兜底之外的任何猜测**：magic 不对 / 越界 / 压缩类型未知一律**抛错**，
 * 由调用方决定退化成「这个文件读不了」（见 `magicrew-local-browser.ts` 的
 * `sstableTextFor`）——**绝不**返回半截数据，那会让「读到了但配错」比「读不到」难查得多。
 *
 * ⚠️ **只读**：本模块不写任何文件。
 */
/**
 * 一条 LevelDB 记录（key / value 都是原始字节）。
 *
 * ## ⚠️⚠️ `sequence` / `deleted` 是 2026-11-05 返工新增的（P2-2 / P2-3）
 *
 * LevelDB 的 internal key = `user_key || (seq<<8 | type)`。同一 user key 的**多次
 * 写入**会同时留在磁盘上（旧值在 `.ldb`、新值/tombstone 在 `.log` WAL），必须按
 * **sequence 取最新**、并把 `type === 0`（删除标记）当成「该 key 不存在」。
 * 不这样做就会：
 * - 复活已登出的组织（旧 org 比 tombstone 还早）；
 * - 先登出再登录时漏读（`.log` 是写入序，旧在前，配到空值就放弃）。
 *
 * ⚠️ 人造记录（单测直接构造 / 非 LevelDB 来源）可以**缺省**这两个字段，
 * 此时 {@link leveldbVisibleRecords} 原样保留、不做去重。
 */
export interface LeveldbRecord {
    /** 原始 key（**不含** internal key 尾部 8 字节；`latin1` 才能无损取回）。 */
    readonly key: Buffer;
    /** 原始 value。 */
    readonly value: Buffer;
    /** LevelDB sequence（越大越新）；人造记录可缺省。 */
    readonly sequence?: number;
    /** 是否为删除标记（internal key type `0` = tombstone）。 */
    readonly deleted?: boolean;
}
/**
 * 读一个 varint（32/64 位共用；LevelDB 的 varint32 与 varint64 编码同形）。
 *
 * @param buf 缓冲
 * @param pos 起始位置
 * @returns 值与下一个字节位置
 * @throws 越过末尾 / 超过 64 位（说明这个文件不是我们要的格式）
 */
export declare function readVarint(buf: Buffer, pos: number): {
    value: number;
    next: number;
};
/**
 * 解压一段 **Snappy 原始格式**（`snappy::Compress` 的输出，**不带** framed 的
 * `sNaPpY` 流头）。
 *
 * 格式：`varint32 解压后长度` + 若干个 tag：
 *
 * | tag 低 2 位 | 含义 | 长度 | 偏移 |
 * |---|---|---|---|
 * | `00` | literal | `(tag>>2)+1`；`tag>>2 >= 60` 时再读 `tag>>2-59` 字节小端 = 长度-1 | — |
 * | `01` | copy，1 字节偏移 | `4 + ((tag>>2)&7)` | `(tag>>5)<<8 \| 下一字节` |
 * | `10` | copy，2 字节偏移 | `(tag>>2)+1` | 2 字节小端 |
 * | `11` | copy，4 字节偏移 | `(tag>>2)+1` | 4 字节小端 |
 *
 * ⚠️ **copy 必须逐字节前向复制**（`out[written] = out[written - offset]`，**不能**用
 * `Buffer.copy`）：Snappy 允许 `offset < length`，此时源区间会**边写边长**
 * （典型的 RLE 用法）。用 `copy` 一次拷一段会读到还没写出来的字节 ⇒ 输出错位，
 * 而错位后的数据仍然「看起来像文本」，极难发现。
 *
 * @throws 任何越界 / 非法偏移（不产出半截结果）
 */
export declare function snappyDecompress(input: Buffer): Buffer;
/**
 * 还原一个 block 里的**全部** entry（前缀压缩还原）。
 *
 * entry 布局：`varint shared` + `varint nonShared` + `varint valueLen` +
 * `keyDelta[nonShared]` + `value[valueLen]`，其中真正的 key = 上一条 key 的前
 * `shared` 字节 + `keyDelta`。
 *
 * ⚠️ restart 数组**只用来跳过**（`block.length - 4 - numRestarts*4` 就是 entry 区末尾）：
 * 我们不做点查，逐条顺序还原比按 restart 分段更简单，且不会漏掉任何一条。
 */
export declare function parseBlockEntries(block: Buffer): LeveldbRecord[];
/**
 * 读出一个 `.ldb` 文件里的**全部**记录（按 key 升序，与 LevelDB 一致）。
 *
 * ## ⚠️ 只走索引块，**不扫** metaindex
 *
 * metaindex 里放的是 filter block 之类的元数据，与记录无关 —— 扫它只会多解一份无用数据。
 *
 * @throws 文件不是 SSTable（magic 不符）/ 结构损坏 —— 由调用方决定降级还是当作没读到
 */
export declare function readSstableRecords(file: Buffer): LeveldbRecord[];
/**
 * 按 user key 取**最新**那条记录，并丢掉 tombstone（= 该 key 已删除）。
 *
 * ## ⚠️⚠️ 为什么必须在**跨文件**层面做（2026-11-05 返工 P2-2 / P2-3）
 *
 * LevelDB 的 `.ldb`（压实后的 SSTable）与 `.log`（WAL 尾写）共用**同一个 sequence
 * 空间**，同一条 localStorage key 的多次写入可以横跨两者：
 *
 * | 形态 | 正确结果 | 不去重的后果 |
 * |---|---|---|
 * | 旧值在 `.ldb`、新值在 `.log` | 用新值 | 先登出再登录 ⇒ 配到空值/旧值 ⇒ **漏读** |
 * | 旧值在 `.ldb`、tombstone 在 `.log` | 该 key 不存在 | 复活已登出组织（200 + code:403） |
 * | 同一 `.ldb` 内新旧两版 | 用 seq 大的 | 取决于块内顺序 |
 *
 * ⇒ 收集**全部文件**的记录后统一去重；没有 `sequence` 的人造记录原样保留
 * （单测直接构造文本的路径不受影响）。
 *
 * ⚠️ 顺序：按**首次出现**的顺序输出（`Map` 保持插入序），保证同一份数据渲染稳定
 * —— 否则 `credsNear` 的「jwt 配它后面最近的 org」会随 Map 哈希顺序抖动。
 */
export declare function leveldbVisibleRecords(records: readonly LeveldbRecord[]): LeveldbRecord[];
/**
 * 解析 leveldb **WAL**（`.log`）里的 WriteBatch 记录。
 *
 * 格式（`leveldb/db/write_batch.cc` + `log_writer.cc`）：
 *
 * ```
 * WAL record: crc32(4) | length(2 LE) | type(1) | payload[length]
 * payload   : seq(8 LE) | count(4 LE) | count × entry
 * entry     : kind(1) | varint keyLen | key | [varint valueLen | value]   // kind 1 = put
 * entry     : kind(1) | varint keyLen | key                              // kind 0 = delete
 * ```
 *
 * @returns 记录数组；**不是**合法 WAL 时返回 `undefined`（调用方退回「原文扫描」）。
 *
 * ⚠️ 任何一步越界/未知 kind/分片记录（`FIRST`/`MIDDLE`/`LAST`）都返回
 * `undefined` —— 宁可退回原文扫描（本文件其它 `.log` 的既有行为），也不要
 * 产出半截记录（那会静默改变配对结果）。
 */
export declare function readWalRecords(input: Buffer): LeveldbRecord[] | undefined;
/**
 * 把记录渲染成**可供 `credsNear` 检索的文本**。
 *
 * 形态与「未压缩 leveldb 的原始字节」对齐：`<带 origin 前缀的 key>\n<value>`。
 * 之所以仍然产出文本、而不是直接产出结构化的 `{jwt, organizationCode}`：
 * `credsNear` 的「按 origin 截断 + jwt 配它自己后面最近的 org」那套配对纪律
 * （见 `magicrew-local-browser.ts`）已经在 888 行单测里钉死，换数据源不该重写它。
 *
 * ⚠️ key 用 **latin1** 取回：`_https://…\x00\x01<name>\x01<8 字节序号>` 里既有
 * `\x00`/`\x01` 也有二进制序号，utf8 解码会把非法字节换成 `U+FFFD`（→ `\uFFFD`），
 * 而 `ORIGIN_RE` 依赖 `\x00\x01` 这两个**原字节**做边界。
 */
export declare function leveldbRecordsText(records: readonly LeveldbRecord[]): string;
//# sourceMappingURL=leveldb-sstable.d.ts.map