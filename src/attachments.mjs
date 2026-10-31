// 附件服务：本体（deepseek-harness-codearts）的图片入站与出站都走 `ctx.attachments`。
//
// ## 为什么插件要自己装一个
//
// 直连改造之后，图片链路断在这里：客户端发的 `image_url`（base64 data URL）
// 由本体的 `openai-gateway/messages.js` 交给「图片桥」落盘成
// `{ type: 'image', attachment: <ref> }`，而插件以前给本体传的是**空桥**
// （`toGenerateOptions(..., {})`），于是本体如实报
// 「当前 profile 未装载附件服务（@deepseek-ai/dsh-attachment-local），无法接收图片。」
//
// 那个服务是 **DSH 宿主**的（`@deepseek-ai/dsh-attachment-local`，装在
// app.asar 里、依赖 native 的 sharp），插件进程里根本没有它 —— 插件跑在
// magpie 的 bun 宿主里，本体是 vendored 拷贝，`ctx` 是插件自己 new 的。
// 所以：**由插件提供一个同契约的最小实现**，图片链路才接得上。
//
// ## 契约（读本体源码得出，不是猜的）
//
// 入站 `vendor/lib/openai-gateway/images.js:129` `toImageBlock()`：
//   `bridge.saveImage({ data: Uint8Array, mediaType })`
//   → `{ attachmentId: 'sha256:<64hex>', mediaType, width, height, bytes }`
//   媒体类型是**硬校验**（声明与字节不符要被拒，不能盲信请求里的 mime），
//   且**任何失败必须抛错** —— 静默丢图会让用户以为模型看到了图。
//
// 出站 `vendor/lib/index.js:346` `makeReadImage()`：
//   `attachments.readImage(ref)` → `{ data, ref: { mediaType, … } }`（读回原字节）
//   `attachments.readImageRequest(ref, target)` 可选，**不可用一律返回
//   `undefined`**（调用方据此回退原图；缩放只是优化，不是请求的前置条件）。
//
// ## 为什么不做缩放（`readImageRequest` 返回 undefined）
//
// 本体希望的是「按目标尺寸产出确定性、可缓存的缩放版本」（alpha 走 WebP、
// 不透明走 JPEG、85/75/60 质量阶梯）—— 那需要图像编解码器（DSH 用 sharp）。
// 插件不引入 native 依赖：`readImageRequest` 返回 `undefined`，适配器按本体
// 自己写好的回退路径发原图。**保守方向是对的**：宁可发一张大图，也不能因为
// 「想缩图」把一次本来能成功的请求打死（本体源码注释里的同一取向）。
//
// ## 落盘形态
//
// 内容寻址：同一张图落两次得到同一个 id，天然去重。
//   <dir>/objects/<sha256>.json  元数据（mediaType / width / height / bytes / ext）
//   <dir>/objects/<sha256>.<ext> 原字节
// 默认 `<home>/.config/magpie/jet-hub-attachments`，可用 `JET_HUB_ATTACHMENT_DIR` 覆盖。

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 图片策略：与本体网关的 `DEFAULT_IMAGE_LIMITS`
 *（`vendor/lib/openai-gateway/images.js:46`）同值。
 *
 * 入站校验两边都会做（本体先按它自己的 `limits` 筛一遍，插件落盘前再硬校验
 * 一次），所以这里不能各写一套：`src/llm-bridge.mjs` 把这份表原样传给本体，
 * 出站读回时又用它判尺寸 —— 只有一份真源才不会出现「本体放过、插件拒绝」。
 */
export const IMAGE_LIMITS = {
  maxImageBytes: 20 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 200 * 1024 * 1024,
  maxImageDimension: 8192,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

/** 媒体类型 → 落盘扩展名（`imageHostPath` 与读回都要用它定位文件）。 */
const EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** `sha256:<64hex>` —— 与 DSH 实现同一个 id 形状（`dsh-attachment-local` 的 `ID_PATTERN`）。 */
const ID_PATTERN = /^sha256:([a-f0-9]{64})$/

/** 附件服务的失败：带稳定 `code`，便于上层区分「声明与字节不符」和「文件被清了」。 */
export class AttachmentFailure extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'AttachmentFailure'
    this.code = code
  }
}

/** 默认附件目录（跟控制台地址文件同一个数据目录）。 */
export function defaultAttachmentDir() {
  const override = process.env.JET_HUB_ATTACHMENT_DIR?.trim()
  if (override !== undefined && override !== '') return override
  return join(homedir(), '.config', 'magpie', 'jet-hub-attachments')
}

/**
 * 从字节里认出真实图片类型与尺寸。
 *
 * 为什么自己解析而不用库：只需要宽高两个整数，而 PNG/JPEG/GIF/WebP 四种头部
 * 都是几十行就能读出来的定长结构；引一个图像库（sharp 是 native）会把这个
 * 纯 JS 插件拖进平台相关的构建里。
 *
 * @param {Uint8Array} bytes 图片原字节
 * @returns {{ mediaType: string, width: number, height: number }}
 * @throws {AttachmentFailure} 字节不是这四种图片之一，或头部损坏/尺寸读不出
 */
export function sniffImage(bytes) {
  const b = toBytes(bytes)
  const png = sniffPng(b) ?? sniffJpeg(b) ?? sniffGif(b) ?? sniffWebp(b)
  if (png === undefined) {
    throw new AttachmentFailure(
      '无法识别的图片格式：只支持 PNG / JPEG / WebP / GIF（按字节判定，不看请求里声明的 mime）',
      'UNSUPPORTED_IMAGE_TYPE',
    )
  }
  return png
}

/** PNG：8 字节签名 + IHDR 里的宽高（大端 32 位）。 */
function sniffPng(b) {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (b.length < 24 || SIG.some((v, i) => b[i] !== v)) return undefined
  // 第 12 字节起必须是 IHDR：签名之后第一个 chunk 就是它，别的一律不是合法 PNG。
  if (String.fromCharCode(b[12], b[13], b[14], b[15]) !== 'IHDR') return undefined
  return {
    mediaType: 'image/png',
    width: readUInt32BE(b, 16),
    height: readUInt32BE(b, 20),
  }
}

/**
 * JPEG：扫段找 SOF（0xC0–0xCF，跳过 0xC4 DHT / 0xC8 JPG / 0xCC DAC）。
 *
 * 不能取头两个字节就完事 —— 宽高在 SOF 段里，而 SOF 前面可能隔着 EXIF、ICC、
 * 量化表等任意多个段（手机照片常带几百 KB 的 EXIF）。
 */
function sniffJpeg(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined
  let pos = 2
  while (pos + 3 < b.length) {
    if (b[pos] !== 0xff) return undefined
    let marker = b[pos + 1]
    // 填充字节：段与段之间允许有任意多个 0xFF。
    while (marker === 0xff && pos + 2 < b.length) {
      pos += 1
      marker = b[pos + 1]
    }
    // 无参数标记：SOI / TEM / RSTn。
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2
      continue
    }
    // SOS 之后是熵编码数据，里面不会再有 SOF。
    if (marker === 0xda) return undefined
    const length = readUInt16BE(b, pos + 2)
    if (length < 2) return undefined
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    // SOF 段：长度(2) 精度(1) 高(2) 宽(2) …
    if (isSof && pos + 9 < b.length) {
      return {
        mediaType: 'image/jpeg',
        width: readUInt16BE(b, pos + 7),
        height: readUInt16BE(b, pos + 5),
      }
    }
    pos += 2 + length
  }
  return undefined
}

/** GIF：`GIF87a` / `GIF89a` + 逻辑屏幕宽高（小端 16 位）。 */
function sniffGif(b) {
  if (b.length < 10) return undefined
  const head = String.fromCharCode(b[0], b[1], b[2], b[3], b[4], b[5])
  if (head !== 'GIF87a' && head !== 'GIF89a') return undefined
  return {
    mediaType: 'image/gif',
    width: readUInt16LE(b, 6),
    height: readUInt16LE(b, 8),
  }
}

/** WebP：RIFF 容器，三种子格式（有损 VP8 / 无损 VP8L / 扩展 VP8X）宽高位置各不同。 */
function sniffWebp(b) {
  if (b.length < 25) return undefined
  if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'RIFF') return undefined
  if (String.fromCharCode(b[8], b[9], b[10], b[11]) !== 'WEBP') return undefined
  const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15])
  if (fourcc === 'VP8X') {
    if (b.length < 30) return undefined
    // canvas 宽高各 3 字节小端，存的是「实际值 - 1」。
    return {
      mediaType: 'image/webp',
      width: readUInt24LE(b, 24) + 1,
      height: readUInt24LE(b, 27) + 1,
    }
  }
  if (fourcc === 'VP8L') {
    // 无损：1 字节签名 0x2F 之后是位打包的 (宽-1) 14 位 + (高-1) 14 位。
    // ⚠️ 尺寸下限比另两种小：一张 1×1 的无损 WebP 只有 25 字节，卡 30 会误拒。
    if (b[20] !== 0x2f) return undefined
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)
    return {
      mediaType: 'image/webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    }
  }
  if (fourcc === 'VP8 ') {
    if (b.length < 30) return undefined
    // 有损：帧头里有 3 字节起始码 9D 01 2A，其后 14 位宽 + 14 位高。
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return undefined
    return {
      mediaType: 'image/webp',
      width: readUInt16LE(b, 26) & 0x3fff,
      height: readUInt16LE(b, 28) & 0x3fff,
    }
  }
  return undefined
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  }
  throw new AttachmentFailure('图片字节缺失：附件服务只接受 Uint8Array / Buffer', 'INVALID_IMAGE_BYTES')
}

function readUInt16BE(b, at) {
  return (b[at] << 8) | b[at + 1]
}

function readUInt16LE(b, at) {
  return b[at] | (b[at + 1] << 8)
}

function readUInt24LE(b, at) {
  return b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)
}

function readUInt32BE(b, at) {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
}

/** `sha256:<hex>` → hex；形状不对直接拒（别拿它去拼路径）。 */
function hashOf(ref) {
  const matched = ID_PATTERN.exec(String(ref?.attachmentId ?? ''))
  if (matched === null) {
    throw new AttachmentFailure(`图片引用不合法：${String(ref?.attachmentId)}（应为 sha256:<64 位小写 hex>）`, 'INVALID_ATTACHMENT_ID')
  }
  return matched[1]
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** 先写临时文件再 rename：半个文件被读到会比读不到更难查。 */
async function writeAtomic(path, data) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, data)
  try {
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/**
 * 本体的 `ctx.attachments` 实现（内容寻址 + 原字节读回，不做缩放）。
 *
 * 用普通类而不是继承 cordis `Service`：插件这边只需要 `ctx.provide('attachments', store)`
 * 让本体 `ctx.get('attachments')` 拿得到；继承 Service 会把这层实现绑到某个
 * 具体版本的 cordis 服务生命周期上，而本体只按鸭子类型调那三四个方法。
 */
export class JetHubAttachmentStore {
  constructor(options = {}) {
    this.dir = options.dir ?? defaultAttachmentDir()
    this.objectsDir = join(this.dir, 'objects')
  }

  /** 本体入站校验用的策略表（与插件传给它的 `limits` 是同一份）。 */
  get imageLimits() {
    return IMAGE_LIMITS
  }

  /**
   * 落一张图：校验 → 内容寻址 → 原子写盘 → 返回引用。
   *
   * @param {{ data: Uint8Array, mediaType?: string }} input
   * @returns {Promise<{ attachmentId: string, mediaType: string, width: number, height: number, bytes: number }>}
   */
  async saveImage(input) {
    const { data, sniffed } = this._admit(input)
    const hash = createHash('sha256').update(data).digest('hex')
    const attachmentId = `sha256:${hash}`
    const metaPath = join(this.objectsDir, `${hash}.json`)

    // 已落过同一张图（内容寻址 ⇒ 字节必然一致）：直接复用元数据，不重写。
    const cached = await readJson(metaPath)
    if (cached?.bytes === data.byteLength) {
      return { attachmentId, mediaType: cached.mediaType, width: cached.width, height: cached.height, bytes: cached.bytes }
    }

    const ext = EXTENSIONS[sniffed.mediaType]
    await mkdir(this.objectsDir, { recursive: true })
    await writeAtomic(join(this.objectsDir, `${hash}.${ext}`), data)
    const meta = {
      attachmentId,
      mediaType: sniffed.mediaType,
      width: sniffed.width,
      height: sniffed.height,
      bytes: data.byteLength,
      ext,
      at: new Date().toISOString(),
    }
    await writeAtomic(metaPath, Buffer.from(`${JSON.stringify(meta)}\n`, 'utf8'))
    return { attachmentId, mediaType: meta.mediaType, width: meta.width, height: meta.height, bytes: meta.bytes }
  }

  /** 只校验不落盘（DSH 抽象类的 `validateImage`；本体入站不走它，留给别处调用）。 */
  async validateImage(input) {
    this._admit(input)
  }

  /** 批量落盘：**先全部校验、再逐个写**，避免写了一半才发现第三张超限。 */
  async saveImages(inputs) {
    const list = Array.isArray(inputs) ? inputs : []
    const { maxImagesPerMessage, maxMessageImageBytes } = IMAGE_LIMITS
    if (list.length > maxImagesPerMessage) {
      throw new AttachmentFailure(`一条消息最多 ${maxImagesPerMessage} 张图片，当前 ${list.length} 张`, 'TOO_MANY_IMAGES')
    }
    const total = list.reduce((sum, item) => sum + toBytes(item?.data).byteLength, 0)
    if (total > maxMessageImageBytes) {
      throw new AttachmentFailure(`一条消息的图片总大小 ${Math.round(total / 1024 / 1024)}MB 超过上限 ${maxMessageImageBytes / 1024 / 1024}MB`, 'IMAGES_TOO_LARGE')
    }
    for (const input of list) this._admit(input)
    const refs = []
    for (const input of list) refs.push(await this.saveImage(input))
    return refs
  }

  /**
   * 读回一张图的原字节（本体出站内联图片走这里）。
   *
   * 校验是**必须**的：会话日志里的引用可能指向被清理过的对象，字节与 id 不符
   * 也要报错 —— 上游收到一张坏图比收到一句明确错误更难查。
   *
   * @param {{ attachmentId: string }} ref
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ data: Uint8Array, ref: object }>}
   */
  async readImage(ref, signal) {
    const hash = hashOf(ref)
    const meta = await readJson(join(this.objectsDir, `${hash}.json`))
    const ext = meta?.ext ?? 'bin'
    let raw
    try {
      raw = await readFile(join(this.objectsDir, `${hash}.${ext}`), signal === undefined ? undefined : { signal })
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error
      throw new AttachmentFailure(`图片对象读不到：${hash}.${ext}（附件目录被清理过？）`, 'ATTACHMENT_MISSING')
    }
    const data = toBytes(raw)
    if (createHash('sha256').update(data).digest('hex') !== hash) {
      throw new AttachmentFailure(`图片对象校验失败：sha256:${hash} 的字节已变更`, 'ATTACHMENT_CORRUPTED')
    }
    const info = meta ?? sniffImage(data)
    return {
      data,
      ref: {
        attachmentId: `sha256:${hash}`,
        mediaType: info.mediaType,
        width: info.width,
        height: info.height,
        bytes: data.byteLength,
      },
    }
  }

  /**
   * 请求版本（缩放）—— 明确不做。
   *
   * 返回 `undefined` 是本体写好的回退信号：适配器改用 `readImage` 发原图
   * （`vendor/lib/index.js:374` `makeReadImageRequest()` 与 `vendor/lib/image-budget.js` 都按这条走）。
   * 插件不引 native 图像库，所以这里永远没有「更小的版本」可给。
   */
  async readImageRequest() {
    return undefined
  }

  /** 本机文件路径（本体当前不调它；契约里有，实现成「存在才给」）。 */
  imageHostPath(ref) {
    let hash
    try {
      hash = hashOf(ref)
    } catch {
      return undefined
    }
    for (const ext of Object.values(EXTENSIONS)) {
      const path = join(this.objectsDir, `${hash}.${ext}`)
      if (existsSync(path)) return path
    }
    return undefined
  }

  /** 校验 + 识别：入站落盘与 `validateImage` 共用同一条路径，不会两处判得不一样。 */
  _admit(input) {
    const data = toBytes(input?.data)
    const mediaType = String(input?.mediaType ?? '').trim().toLowerCase()
    if (data.byteLength === 0) {
      throw new AttachmentFailure('图片字节为空', 'INVALID_IMAGE_BYTES')
    }
    if (data.byteLength > IMAGE_LIMITS.maxImageBytes) {
      throw new AttachmentFailure(
        `单张图片 ${(data.byteLength / 1024 / 1024).toFixed(1)}MB 超过上限 ${IMAGE_LIMITS.maxImageBytes / 1024 / 1024}MB`,
        'IMAGE_TOO_LARGE',
      )
    }
    const sniffed = sniffImage(data)
    if (mediaType !== '' && mediaType !== sniffed.mediaType) {
      throw new AttachmentFailure(
        `图片声明为 ${mediaType}，但字节是 ${sniffed.mediaType}（按字节判定，不盲信请求里的 mime）`,
        'IMAGE_TYPE_MISMATCH',
      )
    }
    const longest = Math.max(sniffed.width, sniffed.height)
    if (longest > IMAGE_LIMITS.maxImageDimension) {
      throw new AttachmentFailure(
        `图片边长 ${longest}px 超过上限 ${IMAGE_LIMITS.maxImageDimension}px`,
        'IMAGE_TOO_LARGE',
      )
    }
    return { data, sniffed }
  }
}
