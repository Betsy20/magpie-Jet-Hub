# 经 magpie 网关 3425 真转发 jet-hub 模型：非流式 + 流式 + 工具调用
import json
import urllib.request

GW = "http://127.0.0.1:3425/v1/chat/completions"


def post(payload, stream=False):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(GW, data=data, headers={"Content-Type": "application/json"})
    r = urllib.request.urlopen(req, timeout=180)
    if stream:
        return r
    return json.loads(r.read().decode("utf-8"))


print("=" * 60)
print("1) 非流式普通对话")
j = post({
    "model": "jet-hub/workbuddy/deepseek-v4.1-flash",
    "messages": [{"role": "user", "content": "只回答两个字：收到"}],
    "max_tokens": 300,
})
ch = j["choices"][0]
print("  正文:", repr(ch["message"].get("content")))
print("  思考:", repr((ch["message"].get("reasoning_content") or "")[:60]))
print("  finish:", ch["finish_reason"], "| usage:", j["usage"]["total_tokens"])

print("=" * 60)
print("2) 流式：帧类型统计 + [DONE] 次数")
r = post({
    "model": "jet-hub/workbuddy/deepseek-v4.1-flash",
    "messages": [{"role": "user", "content": "数到三"}],
    "max_tokens": 300,
    "stream": True,
}, stream=True)
raw = r.read().decode("utf-8")
frames = [l[6:] for l in raw.split("\n") if l.startswith("data: ")]
done = sum(1 for f in frames if f.strip() == "[DONE]")
content, reasoning, finishes = [], [], []
for f in frames:
    if f.strip() == "[DONE]":
        continue
    o = json.loads(f)
    for c in o.get("choices", []):
        d = c.get("delta") or {}
        if d.get("content"):
            content.append(d["content"])
        if d.get("reasoning_content"):
            reasoning.append(d["reasoning_content"])
        if c.get("finish_reason"):
            finishes.append(c["finish_reason"])
print("  帧数:", len(frames), "| [DONE]:", done)
print("  finish 序列:", finishes)
print("  正文:", repr("".join(content)))
print("  思考前 60:", repr("".join(reasoning)[:60]))

print("=" * 60)
print("3) 工具调用（OpenAI 原生 tools）")
j = post({
    "model": "jet-hub/workbuddy/deepseek-v4.1-flash",
    "messages": [{"role": "user", "content": "上海天气怎么样？用工具查。"}],
    "max_tokens": 500,
    "tools": [{
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "查询某个城市的天气",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string", "description": "城市名"}},
                "required": ["city"],
            },
        },
    }],
})
ch = j["choices"][0]
print("  正文:", repr((ch["message"].get("content") or "")[:80]))
print("  工具:", json.dumps(ch["message"].get("tool_calls"), ensure_ascii=False))
print("  finish:", ch["finish_reason"])

print("=" * 60)
print("4) 路由组 jet-hub-auto/auto（本体自动选号）")
try:
    j = post({
        "model": "jet-hub/jet-hub-auto/auto",
        "messages": [{"role": "user", "content": "回一个字：好"}],
        "max_tokens": 200,
    })
    print("  HTTP 200 | 正文:", repr((j["choices"][0]["message"].get("content") or "")[:60]))
except Exception as e:
    print("  ✗", e)
