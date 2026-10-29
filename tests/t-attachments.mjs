// 附件服务（`ctx.attachments`）契约测试：入站落盘 + 出站读回 + 与本体真实对接。
//
// 为什么要有这个测试：本体的图片收发全走 `ctx.attachments`，而**插件以前压根
// 没提供这个服务**（给本体传空桥），表现是纯文本一切正常、一发图就报
// 「当前 profile 未装载附件服务（@deepseek-ai/dsh-attachment-local），无法接收图片。」
// 这个用例守三件事：
//   ① 落盘引用的形状与 DSH 一致（`sha256:<64hex>` 内容寻址、宽高真值）；
//   ② 出站读回**原字节**，且字节与 id 不符要报错（不能把坏图发给上游）；
//   ③ 本体 `toGenerateOptions` 在**有桥**时产出 `{type:'image', attachment}`，
//      在**无桥**时抛那句错 —— 后一条是回归守卫：它一旦不再抛，说明本体换了
//      契约，前一条的断言就该跟着改。
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttachmentFailure, IMAGE_LIMITS, JetHubAttachmentStore, sniffImage } from '../src/attachments.mjs'
import { toGenerateOptions } from '../vendor/lib/openai-gateway/messages.js'

const problems = []
const ok = (cond, msg) => { if (!cond) problems.push(msg) }

// ── 测试用图片：手搓头部（不引图像库，与实现同一条判据） ────────────────────

const pngChunk = (type, data) => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  // CRC 留 0：本实现的判据是「头部能认出类型与尺寸」，不校验 CRC。
  return Buffer.concat([head, data, Buffer.alloc(4)])
}

function png(width, height) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // 位深
  ihdr[9] = 6   // 颜色类型 RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function jpeg(width, height) {
  const sof = Buffer.alloc(17)
  sof.writeUInt16BE(0xffc0, 0)
  sof.writeUInt16BE(15, 2)      // 段长 = 2 + 后续 13 字节
  sof[4] = 8                    // 精度
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  sof[9] = 3                    // 分量数
  for (let i = 0; i < 3; i += 1) {
    sof[10 + i * 3] = i + 1
    sof[11 + i * 3] = 0x11
    sof[12 + i * 3] = 0
  }
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),  // SOI
    Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0', 'binary'), Buffer.alloc(9), // APP0
    sof,
    Buffer.from([0xff, 0xd9]),  // EOI
  ])
}

function gif(width, height) {
  const head = Buffer.alloc(13)
  head.write('GIF89a', 0, 'ascii')
  head.writeUInt16LE(width, 6)
  head.writeUInt16LE(height, 8)
  return Buffer.concat([head, Buffer.from([0x3b])])
}

function webpVp8x(width, height) {
  const b = Buffer.alloc(30)
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE(b.length - 8, 4)
  b.write('WEBP', 8, 'ascii')
  b.write('VP8X', 12, 'ascii')
  b.writeUInt32LE(10, 16)
  b.writeUIntLE(width - 1, 24, 3)
  b.writeUIntLE(height - 1, 27, 3)
  return b
}

function webpVp8l(width, height) {
  const b = Buffer.alloc(26)
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE(b.length - 8, 4)
  b.write('WEBP', 8, 'ascii')
  b.write('VP8L', 12, 'ascii')
  b.writeUInt32LE(5, 16)
  b[20] = 0x2f
  b.writeUInt32LE((width - 1) | ((height - 1) << 14), 21)
  return b
}

function webpVp8(width, height) {
  const b = Buffer.alloc(30)
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE(b.length - 8, 4)
  b.write('WEBP', 8, 'ascii')
  b.write('VP8 ', 12, 'ascii')
  b.writeUInt32LE(10, 16)
  b[23] = 0x9d
  b[24] = 0x01
  b[25] = 0x2a
  b.writeUInt16LE(width, 26)
  b.writeUInt16LE(height, 28)
  return b
}

const dir = mkdtempSync(join(tmpdir(), 'jet-hub-t-attachments-'))
const store = new JetHubAttachmentStore({ dir })
const fails = async (fn, code, label) => {
  try {
    await fn()
    ok(false, `${label}：本该抛错却成功了`)
  } catch (error) {
    ok(error instanceof AttachmentFailure, `${label}：抛的不是 AttachmentFailure（${error?.name}）`)
    ok(error?.code === code, `${label}：code 应为 ${code}，实际 ${error?.code}（${error?.message}）`)
  }
}

try {
  // ── 1) 四种格式的尺寸解析（宽高必须来自头部真值，不能猜） ──────────────────
  const cases = [
    ['PNG', png(3, 2), 'image/png', 3, 2],
    ['JPEG', jpeg(640, 480), 'image/jpeg', 640, 480],
    ['GIF', gif(12, 7), 'image/gif', 12, 7],
    ['WebP/VP8X', webpVp8x(100, 50), 'image/webp', 100, 50],
    ['WebP/VP8L', webpVp8l(5, 9), 'image/webp', 5, 9],
    ['WebP/VP8', webpVp8(320, 240), 'image/webp', 320, 240],
  ]
  for (const [label, bytes, mediaType, width, height] of cases) {
    let got
    try {
      got = sniffImage(bytes)
    } catch (error) {
      got = `${error?.code}: ${error?.message}`
    }
    ok(
      got.mediaType === mediaType && got.width === width && got.height === height,
      `${label} 解析错误：${typeof got === 'string' ? got : JSON.stringify(got)}，期望 ${mediaType} ${width}x${height}`,
    )
  }

  // ── 2) 落盘引用形状（本体据此造 ImageBlock） ──────────────────────────────
  const ref = await store.saveImage({ data: png(3, 2), mediaType: 'image/png' })
  console.log('ref =', JSON.stringify(ref))
  ok(/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId), `attachmentId 形状不对：${ref.attachmentId}`)
  ok(ref.mediaType === 'image/png' && ref.width === 3 && ref.height === 2, `引用元数据不对：${JSON.stringify(ref)}`)
  ok(ref.bytes === png(3, 2).length, `bytes 应为原字节数，实际 ${ref.bytes}`)

  // 内容寻址 ⇒ 同一张图落两次同一个 id，且不重复写文件
  const again = await store.saveImage({ data: png(3, 2), mediaType: 'image/png' })
  ok(again.attachmentId === ref.attachmentId, '同一张图两次落盘应得到同一个 id（内容寻址去重）')
  const objects = readdirSync(join(dir, 'objects'))
  ok(objects.length === 2, `去重后 objects/ 应只有 2 个文件（json + png），实际 ${objects.length}：${objects.join(', ')}`)

  // ── 3) 出站读回原字节 ───────────────────────────────────────────────────
  const stored = await store.readImage(ref)
  ok(Buffer.from(stored.data).equals(png(3, 2)), 'readImage 读回的不是原字节')
  ok(stored.ref?.mediaType === 'image/png' && stored.ref?.width === 3, `readImage 的 ref 不对：${JSON.stringify(stored.ref)}`)
  ok(typeof store.imageHostPath(ref) === 'string' && store.imageHostPath(ref).includes('.png'), 'imageHostPath 应给出真实落盘路径')
  ok((await store.readImageRequest(ref, { maxBytes: 1024 })) === undefined, 'readImageRequest 应返回 undefined（本实现不做缩放，由本体回退原图）')

  // 字节被人改过必须报错（坏图发上游比报错更难查）
  const objectPath = store.imageHostPath(ref)
  writeFileSync(objectPath, png(9, 9))
  await fails(() => store.readImage(ref), 'ATTACHMENT_CORRUPTED', '对象字节与 id 不符')

  // ── 4) 各种拒绝路径 ─────────────────────────────────────────────────────
  await fails(() => store.saveImage({ data: png(3, 2), mediaType: 'image/jpeg' }), 'IMAGE_TYPE_MISMATCH', '声明与字节不符')
  await fails(() => store.saveImage({ data: Buffer.from('这不是图片，只是一段文本而已'), mediaType: 'image/png' }), 'UNSUPPORTED_IMAGE_TYPE', '非图片字节')
  await fails(() => store.saveImage({ data: png(9000, 10), mediaType: 'image/png' }), 'IMAGE_TOO_LARGE', '边长超限')
  await fails(() => store.saveImage({ data: Buffer.alloc(IMAGE_LIMITS.maxImageBytes + 1), mediaType: 'image/png' }), 'IMAGE_TOO_LARGE', '字节超限')
  await fails(() => store.saveImage({ data: new Uint8Array(0), mediaType: 'image/png' }), 'INVALID_IMAGE_BYTES', '空字节')
  await fails(() => store.saveImage({ data: 'not-bytes', mediaType: 'image/png' }), 'INVALID_IMAGE_BYTES', '字节类型不对')
  await fails(() => store.readImage({ attachmentId: 'md5:abc' }), 'INVALID_ATTACHMENT_ID', '引用形状不合法')
  await fails(() => store.readImage({ attachmentId: `sha256:${'a'.repeat(64)}` }), 'ATTACHMENT_MISSING', '对象不存在')
  await fails(
    () => store.saveImages(Array.from({ length: IMAGE_LIMITS.maxImagesPerMessage + 1 }, () => ({ data: png(1, 1), mediaType: 'image/png' }))),
    'TOO_MANY_IMAGES',
    '一条消息图片数超限',
  )

  // 批量落盘保持输入顺序
  const batch = await store.saveImages([
    { data: png(4, 1), mediaType: 'image/png' },
    { data: png(5, 1), mediaType: 'image/png' },
  ])
  ok(batch.length === 2 && batch[0].width === 4 && batch[1].width === 5, `批量落盘顺序不对：${JSON.stringify(batch.map((r) => r.width))}`)

  // ── 5) 与本体真实对接：有桥产出 image 块、无桥复现那句报错 ────────────────
  const body = {
    model: 'trae/deepseek-v4.1-flash',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这是什么颜色？' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${png(3, 2).toString('base64')}` } },
      ],
    }],
  }
  const generate = await toGenerateOptions(body, undefined, undefined, undefined, {
    bridge: { saveImage: (input) => store.saveImage(input) },
    limits: IMAGE_LIMITS,
  })
  const parts = generate?.messages?.[0]?.content ?? []
  const imagePart = parts.find((part) => part?.type === 'image')
  console.log('本体重排后的图片块 =', JSON.stringify(imagePart))
  ok(imagePart !== undefined, '本体没有把 image_url 转成 ImageBlock（附件桥没接上）')
  ok(/^sha256:[a-f0-9]{64}$/.test(String(imagePart?.attachment?.attachmentId)), `ImageBlock 的引用形状不对：${JSON.stringify(imagePart?.attachment)}`)
  ok(imagePart?.attachment?.mediaType === 'image/png', 'ImageBlock 的 mediaType 丢了')

  let bridgeError
  try {
    await toGenerateOptions(body, undefined, undefined, undefined, {})
  } catch (error) {
    bridgeError = error
  }
  ok(bridgeError !== undefined, '无桥时本体本该报「未装载附件服务」，却成功了（契约变了，上面的断言要跟着改）')
  if (bridgeError !== undefined) {
    console.log('无桥报错 =', bridgeError.message)
    ok(/未装载附件服务/.test(String(bridgeError.message)), `无桥报错不是预期那句：${bridgeError.message}`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (problems.length) {
  console.log('✗ ' + problems.length + ' 处不符：')
  for (const p of problems) console.log('  ' + p)
  process.exit(1)
}
console.log('✓ 附件服务契约与本体对接均正确')
process.exit(0)
