// 错误响应的形状契约 —— 一条错误必须同时说清 status / code / message。
//
// 为什么值得单独一组：magpie 宿主是按 **HTTP status** 决定「换号 / 换模型 / 退避」的，
// 按 **code** 决定「重试 / 提示 / 标记账号」。缺一个字段，宿主就只能瞎猜。
// 两个实测过的坑：
//   ① 端点不存在如果回 404，magpie 会「只搁置这个模型」，于是它换个同样不存在的端点继续试；
//      正确是 501。
//   ② `errorResponse()` 看着像「没传 code」，其实 code 由 `failureToOpenAiError()` 兜底成
//      `upstream_error` —— 有静态检查工具会把它误报成缺失，这里的断言就是那份证据。

import { JetHubContainer } from '../src/container.mjs'
import { errorResponse, jsonResponse } from '../src/llm-bridge.mjs'

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}${extra ? `（${extra}）` : ''}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${extra ? `（${extra}）` : ''}`)
  }
}

console.log('错误响应形状')

// ── 1. 未知路径：501 + not_implemented，绝不能是 404 ──────────────────
{
  // 只需要 start() 这一个依赖，llm 在这里用不到
  const fake = { start: async () => {} }
  const res = await JetHubContainer.prototype.forward.call(fake, '/v1/embeddings')
  const body = await res.json()
  ok(res.status === 501, '未知路径回 501（不是 404）', `实际 ${res.status}`)
  ok(
    body?.error?.code === 'not_implemented',
    '未知路径的 code 是 not_implemented',
    String(body?.error?.code),
  )
  ok(
    typeof body?.error?.message === 'string' && body.error.message.length > 0,
    '未知路径也带人话 message',
  )
  ok(
    body.error.message.includes('/v1/embeddings'),
    'message 里回显了请求的那个路径（否则用户不知道哪里写错了）',
  )
}

// ── 2. errorResponse：任何抛错都必须带 code，不能只有 message ─────────
{
  const res = errorResponse(new Error('boom'))
  const body = await res.json()
  ok(typeof body?.error?.code === 'string' && body.error.code.length > 0, '抛错也有 code', String(body?.error?.code))
  ok(body.error.code === 'upstream_error', '没分类的抛错落默认桶 upstream_error', String(body.error.code))
  ok(typeof body?.error?.type === 'string', '带 type（上游类别）', String(body?.error?.type))
  ok(body?.error?.message === 'boom', '保留原始 message，不改写成自定义文案')
}

// ── 3. status 必须来自 failure，不能一律 502 ─────────────────────────
// `LlmError` 的 status 不在顶层，只在 `e.failure.status`；只读顶层会把 404 退化成 502，
// 客户端就会对着一个不存在的模型反复重试。
{
  const err = Object.assign(new Error('模型不存在'), { failure: { status: 404 } })
  const res = errorResponse(err)
  ok(res.status === 404, 'failure.status=404 时透出 404（模型不存在只搁置该模型）', `实际 ${res.status}`)
}
{
  const err = Object.assign(new Error('上游挂了'), { failure: { status: 503 } })
  const res = errorResponse(err)
  ok(res.status === 503, 'failure.status=503 时透出 503（可重试）', `实际 ${res.status}`)
}

// ── 4. jsonResponse 的形状：合法 JSON + 正确的 content-type ────────────
{
  const res = jsonResponse(200, { ok: 1 })
  ok(res.headers.get('content-type')?.includes('application/json'), 'jsonResponse 带 application/json')
  const body = await res.json()
  ok(body.ok === 1, 'jsonResponse 原样序列化 body')
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}（${pass + fail} 项：错误形状 —— status / code / message 三者齐全）`)
process.exit(fail === 0 ? 0 : 1)
