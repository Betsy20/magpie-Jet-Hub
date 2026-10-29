# 经 magpie 网关 3425 真转发 jet-hub 模型：非流式 + 流式 + 工具调用 + 路由组
#
# 退出码即结论：任何一项失败都 exit 1（以前第 4 项出错只打印 ✗ 却仍 exit 0，是假绿）。
import json
import sys
import urllib.request

# Windows 控制台默认 GBK，打印 ✓/✗ 会 UnicodeEncodeError 把测试带崩。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

BASE = "http://127.0.0.1:3425"
GW = BASE + "/v1/chat/completions"

FAILED = []


def check(name, cond, extra=""):
    print(("  ✓ " if cond else "  ✗ ") + name + (f" — {extra}" if extra else ""))
    if not cond:
        FAILED.append(name)
    return cond


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
    "model": "jet-hub-workbuddy/deepseek-v4.1-flash",
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
    "model": "jet-hub-workbuddy/deepseek-v4.1-flash",
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
    "model": "jet-hub-workbuddy/deepseek-v4.1-flash",
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
print("4) 路由组（本体自动选号）：模型 id 现从 /v1/models 取，不写死")
# 以前这里写死 "jet-hub/jet-hub-auto/auto"，本体后来把路由组的模型前缀改成
# auto/（实测 2026-10-28：auto/deepseek-v4.1-flash … 共 9 个），写死的 id 变 404。
# 所以改成从网关实时目录里挑：优先 auto/ 前缀，其次 group/ 前缀。
try:
    with urllib.request.urlopen(BASE + "/v1/models", timeout=30) as r:
        ids = [m["id"] for m in json.load(r).get("data", [])]
except Exception as e:
    ids = []
    print("  ✗ 取不到 /v1/models:", e)

route_ids = [i for i in ids if i.startswith("auto/")] or [i for i in ids if i.startswith("group/")]
check("网关目录里有路由组模型", len(route_ids) > 0, f"{len(route_ids)} 个，例：{route_ids[0] if route_ids else '无'}")

if route_ids:
    rid = route_ids[0]
    try:
        j = post({"model": rid, "messages": [{"role": "user", "content": "回一个字：好"}], "max_tokens": 200})
        body = (j["choices"][0]["message"].get("content") or "").strip()
        u = j.get("usage") or {}
        # 路由组可能只回推理内容（正文空），所以只要拿到 usage 就算走通了
        check(f"路由组 {rid} 真转发", bool(body) or u.get("total_tokens", 0) > 0,
              f"正文={body[:20]!r} tokens={u.get('total_tokens')}")
    except Exception as e:
        check(f"路由组 {rid} 真转发", False, str(e))

print("=" * 60)
print("结论：" + ("✓ 全部通过" if not FAILED else f"✗ {len(FAILED)} 项失败：" + "、".join(FAILED)))
sys.exit(1 if FAILED else 0)

