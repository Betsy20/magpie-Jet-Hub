// 直连层端到端自检：真启动容器，**不经任何 HTTP 网关**跑一次 chat 与非流式/流式。
//
// 这个用例守的是本次改动的核心契约（原来由内嵌网关 :1839x 承担，现在由
// `src/llm-bridge.mjs` 在进程内直接调 `ctx.llm`）：
//   ① `/v1/models` 能出目录（走 `collectGatewayModels`，不再打 HTTP）
//   ② 非流式 chat 返回 `chat.completion`，`choices[0].message.content` 非空
//   ③ 流式 chat 返回 `text/event-stream`，且**有且只有一个** `data: [DONE]` 收尾
//
// ③ 值得单独立断言：`toOpenAiSse` 的四个出口都会自己发 `[DONE]`，如果直连层
// 「顺手补一条」，客户端会收到两个终止帧 —— 这类 bug 只有数帧数才看得出来。
//
// 侧写隔离与 `t-console.mjs` 同源（JET_HUB_NO_ADDR_FILE + 家目录改道），
// 因为这里也真起容器、也会走到写地址文件那段代码。
import { homedir, tmpdir } from 'node:os'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JetHubContainer } from '../src/container.mjs'

const entryPath = fileURLToPath(new URL('../vendor/lib/index.js', import.meta.url))
const log = (m) => console.log('  ·', m)

const realHome = homedir()
const tempHome = mkdtempSync(join(tmpdir(), 'jet-hub-t-direct-'))
const savedEnv = {
  USERPROFILE: process.env.USERPROFILE,
  HOME: process.env.HOME,
  JET_HUB_NO_ADDR_FILE: process.env.JET_HUB_NO_ADDR_FILE,
}
process.env.USERPROFILE = tempHome
process.env.HOME = tempHome
process.env.JET_HUB_NO_ADDR_FILE = '1'

let failed = 0
function ok(name, cond, extra = '') {
  if (cond) console.log(`✓ ${name}${extra ? ' — ' + extra : ''}`)
  else {
    failed += 1
    console.log(`✗ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

const container = new JetHubContainer({ home: realHome, entryPath, log })

try {
  console.log('启动容器（最久 60s）…')
  await container.start()

  ok('容器没有本地网关端口', container.port === undefined, String(container.port))
  ok('直连层拿得到本体 llm', typeof container.llm?.stream === 'function')

  // 1) 模型目录
  const modelsRes = await container.forward('/v1/models', {})
  const modelsJson = await modelsRes.json()
  ok('/v1/models 200', modelsRes.status === 200, `HTTP ${modelsRes.status}`)
  ok('/v1/models 有 data', Array.isArray(modelsJson?.data) && modelsJson.data.length > 0, `${modelsJson?.data?.length ?? 0} 条`)
  ok('/v1/models 每项有 id 与 owned_by', (modelsJson?.data ?? []).every((m) => typeof m?.id === 'string' && typeof m?.owned_by === 'string'))

  // 一个 provider 都没有 / 都没登录时无法造 chat 证据 —— 明确记为跳过，不假装通过。
  const model = container.models.find((m) => m.includes('/'))
  if (model === undefined) {
    console.log('NOT RUN 非流式 chat（本体里没有任何带 provider 前缀的模型，多半是没登录）')
    console.log('NOT RUN 流式 chat（同上）')
  } else {
    // 2) 非流式
    const chatRes = await container.forward('/v1/chat/completions', {
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '只回两个字：收到' }],
        max_tokens: 24,
        stream: false,
      }),
    })
    const chatJson = await chatRes.json()
    ok('非流式 chat 200', chatRes.status === 200, `HTTP ${chatRes.status}${chatRes.status !== 200 ? ' ' + JSON.stringify(chatJson).slice(0, 200) : ''}`)
    if (chatRes.status === 200) {
      ok('非流式有 chat.completion 形状', chatJson?.object === 'chat.completion' && Array.isArray(chatJson?.choices), chatJson?.object)
      ok('非流式 model 回显带 provider 前缀', chatJson?.model === model, `${chatJson?.model} vs ${model}`)
      const content = chatJson?.choices?.[0]?.message?.content
      ok('非流式有正文', typeof content === 'string' && content.trim() !== '', JSON.stringify(content)?.slice(0, 60))
      ok('非流式有 usage', typeof chatJson?.usage?.total_tokens === 'number', String(chatJson?.usage?.total_tokens))
    }

    // 3) 流式
    const streamRes = await container.forward('/v1/chat/completions', {
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '数到三' }],
        max_tokens: 24,
        stream: true,
      }),
    })
    ok('流式 200', streamRes.status === 200, `HTTP ${streamRes.status}`)
    ok('流式是 event-stream', String(streamRes.headers.get('content-type') ?? '').startsWith('text/event-stream'), String(streamRes.headers.get('content-type')))

    let raw = ''
    const reader = streamRes.body.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      raw += decoder.decode(value, { stream: true })
    }
    const doneCount = raw.split('data: [DONE]').length - 1
    ok('流式有且只有一个 [DONE]', doneCount === 1, `${doneCount} 个`)
    ok('流式以 [DONE] 收尾', raw.trimEnd().endsWith('data: [DONE]'), JSON.stringify(raw.slice(-40)))
    ok('流式有 chunk 帧', raw.includes('chat.completion.chunk'), `${raw.split('\n\n').length} 块`)
  }

  // 4) 错误路径：不支持的方法要回 404 而不是挂住
  const badRes = await container.forward('/v1/embeddings', { body: '{}' })
  ok('未知路径回 404', badRes.status === 404, `HTTP ${badRes.status}`)

  // 5) 错误路径：坏 JSON 要回 400，且说清是 JSON 的问题
  const badJson = await container.forward('/v1/chat/completions', { body: '{oops' })
  const badJsonBody = await badJson.json()
  ok('坏 JSON 回 400', badJson.status === 400, `HTTP ${badJson.status}`)
  ok('坏 JSON 有说明', String(badJsonBody?.error?.message ?? '').includes('JSON'), String(badJsonBody?.error?.message ?? '').slice(0, 60))

  console.log(failed === 0 ? '\n结论：✓ 直连链路正常' : `\n结论：✗ ${failed} 项失败`)
} catch (e) {
  console.error('✗ 异常：', e?.stack ?? e)
  failed += 1
} finally {
  await container.console?.close?.()
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try { rmSync(tempHome, { recursive: true, force: true }) } catch {}
  void existsSync
  process.exit(failed === 0 ? 0 : 1)
}
