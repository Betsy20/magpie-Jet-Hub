#!/usr/bin/env bash
# deploy-plugin-hcss8141.sh — 把 GitHub fork 上的 magpie-jet-hub 更新到 hcss8141
#
# 背景：hcss8141 本来装的是 `https://github.com/Betsy20/magpie-Jet-Hub`
# （.bun-tag = Betsy20-magpie-Jet-Hub-021edd5）。那份**不含**我们用到的修复：
#   · 4782e3a fix(monkeycode): 新建账号补 mode:'browser'
#   · 84eb848 fix(baizhi):     新建账号补 mode:'browser'
# 两处都表现为面板点「新建账号」弹「登录未完成 / unknown provider: xxx」。
# 本脚本把插件源换成用户自己的 fork `https://github.com/hnlinyh/magpie-Jet-Hub`。
#
# 与 deploy-plugin-hcss2.sh 的差异（只有这些，流程完全一致）：
#   · REMOTE_HOST   1.95.121.143 -> 111.91.17.201（hcss8141）
#   · SSH_KEY       服务器侧没有 /mnt/workspace，走本机 ~/.ssh/config 的 hcss8141
#   · REPO_DIR      脚本从任意 cwd 跑，用脚本自身所在仓库
#   · BAK_SUFFIX    加时间戳，避免与 hcss2 那份混淆
#   · 校验特征串    改成 BROWSER_MODE_PROVIDERS / fmtScaled（本次修复的特征）
#   · 探针          控制台在 3430 需要 ?k=<MAGPIE_WEB_KEY>（webGuard 用 k，不是 key）；
#                   /__meta 在插件宿主的 18500；网关 https 在 3425
#
# 用法：
#   bash scripts/deploy-plugin-hcss8141.sh              # 校验 + 远端更新 + 重启 + 探针
#   bash scripts/deploy-plugin-hcss8141.sh --check      # 只校验本地/fork 版本，不动服务器
#   bash scripts/deploy-plugin-hcss8141.sh --no-restart # 更新插件但不重启
#   bash scripts/deploy-plugin-hcss8141.sh --restart-anyway  # 有在途流也强制重启
#   DRY_RUN=1 bash scripts/deploy-plugin-hcss8141.sh    # 只打印将执行的动作
#
# ⚠️ 重启会硬切所有在途 SSE 流（magpie 无 drain/reload）。默认重启前查 :3425
#    活跃连接：有任何非本机 established 连接就等（最多 120s），仍不静默则
#    **拒绝重启**（插件已装好，可稍后重跑或 --restart-anyway）。
#
# 严禁：不要用 `magpie plugin add <tarball/URL>` 换源。2026-11-09 实测：
#   `magpie plugin add ./dist/x.tgz` 会把 tarball 路径当插件 spec 写进
#   plugins.json，重启时宿主把 tarball 当 JS 模块加载（exports no OpenCode
#   plugin function）；同时 manifest 已改本地引用、旧 spec 映射丢失
#   （no such plugin: node_modules/https:/github.com/...）⇒ jet-hub 整个不加载，
#   所有模型请求 502（占位域名 jet-hub.invalid）。
set -Eeuo pipefail

GH_URL="https://github.com/hnlinyh/magpie-Jet-Hub"
MANIFEST_KEY="magpie-jet-hub"
REMOTE_HOST="111.91.17.201"
REMOTE_USER="root"
REMOTE_NAME="hcss8141"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new)
REMOTE_PLUGINS="/opt/magpie/config/magpie/plugins"
REMOTE_STATE_DIR="/opt/magpie/config/magpie"
BAK_SUFFIX="20261111-hcss8141"
MAGPIE_BUN="/opt/magpie/cache/magpie/bun/1.4.4/magpie-bun"
MAGPIE_ENV="HOME=/opt/magpie/home XDG_CONFIG_HOME=/opt/magpie/config XDG_DATA_HOME=/opt/magpie/data XDG_STATE_HOME=/opt/magpie/state XDG_CACHE_HOME=/opt/magpie/cache"
PROBE_WEB_KEY="516946187516946187"
PROBE_MODEL="jet-hub-baizhi/deepseek-v4-flash"
# 本次修复的特征串（校验装到的是新代码，不是旧版）
FEATURE_A="BROWSER_MODE_PROVIDERS"   # src/plugin.mjs
FEATURE_B="fmtScaled"                # src/plugin.mjs

CHECK_ONLY=0
NO_RESTART=0
RESTART_ANYWAY=0
for arg in "$@"; do
  case "${arg}" in
    --check) CHECK_ONLY=1 ;;
    --no-restart) NO_RESTART=1 ;;
    --restart-anyway) RESTART_ANYWAY=1 ;;
  esac
done
LOG_MARK_LINE=1
REMOTE_MUTATED=0

log()  { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    [warn] %s\n' "$*" >&2; }
die() {
  printf '\n[FAIL] %s\n' "$*" >&2
  if [[ "${REMOTE_MUTATED}" == "1" ]]; then
    cat >&2 <<EOF

    远端已改动，回滚：
      1) ssh ${REMOTE_NAME}
         cd ${REMOTE_PLUGINS}
         cp -p package.json.bak-${BAK_SUFFIX} package.json
         cp -p bun.lock.bak-${BAK_SUFFIX} bun.lock
         cp -p ${REMOTE_STATE_DIR}/plugins.json.bak-${BAK_SUFFIX} ${REMOTE_STATE_DIR}/plugins.json
         ${MAGPIE_ENV} ${MAGPIE_BUN} install
         systemctl restart magpie
      2) 备份：${REMOTE_PLUGINS}/{package.json,bun.lock}.bak-${BAK_SUFFIX}、
         ${REMOTE_STATE_DIR}/plugins.json.bak-${BAK_SUFFIX}
EOF
  fi
  exit 1
}
trap 'die "第 ${LINENO} 行命令失败"' ERR

rsh() { ssh "${SSH_OPTS[@]}" "${REMOTE_USER}@${REMOTE_HOST}" "$@"; }

# ---------------------------------------------------------------------------
# [1/7] 本地版本校验：fork main 必须 == 本地 HEAD
# ---------------------------------------------------------------------------
log "[1/7] 校验 fork 上的 commit 与本地 HEAD 一致"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_DIR}"
LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_MAIN="$(timeout 60 git ls-remote "${GH_URL%.git}.git" refs/heads/main | awk '{print $1}')"
info "本地 HEAD：${LOCAL_HEAD:0:12}"
info "fork main：${REMOTE_MAIN:0:12}"
[[ "${LOCAL_HEAD}" == "${REMOTE_MAIN}" ]] || die "fork main 不是本地 HEAD —— 先 git push fork HEAD:main（否则服务器会装到旧版）"

if [[ "${CHECK_ONLY}" == "1" ]]; then
  log "CHECK_ONLY：只校验，不动服务器"
  exit 0
fi

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  log "DRY_RUN=1：打印远端动作"
  cat <<EOF
    ssh ${REMOTE_NAME}
    cd ${REMOTE_PLUGINS} && cp -p package.json{,.bak-${BAK_SUFFIX}} && cp -p bun.lock{,.bak-${BAK_SUFFIX}}
    cp -p ${REMOTE_STATE_DIR}/plugins.json{,.bak-${BAK_SUFFIX}}
    改 package.json 依赖：magpie-jet-hub -> ${GH_URL}
    改 plugins.json spec：删 Betsy20 / hnlinyh 旧项，插入 ${GH_URL}
    删 bun.lock 里的锁定条目 -> ${MAGPIE_ENV} ${MAGPIE_BUN} install
    systemctl restart magpie
    探针：console 200（?k=）、/__meta 200（18500）、gateway 3425 非 000、
          新日志无 "didn't load"、jet-hub 就绪行 >0、${PROBE_MODEL} 实调 choices
EOF
  exit 0
fi

# ---------------------------------------------------------------------------
# [2/7] 远端备份
# ---------------------------------------------------------------------------
log "[2/7] 备份远端 package.json / bun.lock / plugins.json（.bak-${BAK_SUFFIX}，保留既有）"
rsh "cd '${REMOTE_PLUGINS}' && for f in package.json bun.lock; do if [ -e \"\$f.bak-${BAK_SUFFIX}\" ]; then echo \"    保留 \$f.bak-${BAK_SUFFIX}\"; else cp -p \"\$f\" \"\$f.bak-${BAK_SUFFIX}\" && echo \"    已备份 \$f\"; fi; done"
rsh "if [ -e '${REMOTE_STATE_DIR}/plugins.json.bak-${BAK_SUFFIX}' ]; then echo '    保留 plugins.json.bak'; else cp -p '${REMOTE_STATE_DIR}/plugins.json' '${REMOTE_STATE_DIR}/plugins.json.bak-${BAK_SUFFIX}' && echo '    已备份 plugins.json'; fi"
REMOTE_MUTATED=1

# ---------------------------------------------------------------------------
# [3/7] 改 manifest（package.json）
# ---------------------------------------------------------------------------
log "[3/7] package.json 依赖 -> ${GH_URL}"
rsh "python3 - <<'PY'
import json, os
p = '${REMOTE_PLUGINS}/package.json'
j = json.load(open(p))
j.setdefault('dependencies', {})['magpie-jet-hub'] = '${GH_URL}'
tmp = p + '.tmp'
open(tmp, 'w').write(json.dumps(j, indent=2) + '\n')
os.replace(tmp, p)
print('    manifest ->', j['dependencies']['magpie-jet-hub'])
PY"

# ---------------------------------------------------------------------------
# [4/7] 改 plugins.json（spec 列表）
# ---------------------------------------------------------------------------
log "[4/7] plugins.json spec -> ${GH_URL}"
rsh "python3 - <<'PY'
import json, os
p = '${REMOTE_STATE_DIR}/plugins.json'
j = json.load(open(p))
def keep(x):
    s = x.get('spec', '')
    if s == 'magpie-jet-hub': return False
    if 'magpie-jet-hub-' in s: return False
    if 'github.com/Betsy20/magpie-Jet-Hub' in s: return False
    if 'github.com/hnlinyh/magpie-Jet-Hub' in s: return False
    return True
kept = [x for x in j.get('plugins', []) if keep(x)]
kept.insert(1, {'spec': '${GH_URL}'})
tmp = p + '.tmp'
open(tmp, 'w').write(json.dumps({'plugins': kept}, indent=2) + '\n')
os.replace(tmp, p)
print('    plugins.json ->', [x['spec'] for x in kept])
PY"

# ---------------------------------------------------------------------------
# [5/7] bun install（从 GitHub 拉取）
# ---------------------------------------------------------------------------
log "[5/7] bun install（从 GitHub 拉取）"
# ⚠️ **必须先删 lock 里的这条**：GitHub 依赖在 bun.lock 里锁的是**具体 commit**
# （`magpie-jet-hub@github:owner/repo#<sha>`）。manifest 写的是 URL（无 sha），
# 但 lock 已锁旧 sha 时 `bun install` 判定「已满足」直接 no changes，
# 于是**装到旧版**却全程无报错（2026-11-09 实测）。删锁 + 重装 = 按 URL 重新解析 HEAD。
# 解锁逻辑放 base64（bun.lock 是 JSONC 带尾随逗号，且 Python 含反斜杠/引号，
# 塞进 ssh 双引号里会被 bash 层层转义弄坏）。
UNLOCK_PY="$(base64 -w0 <<'UNLOCKEOF'
import json, os, sys
key, p = sys.argv[1], sys.argv[2]
raw = open(p, encoding='utf-8').read()
def strip_trailing_commas(s):
    out, in_str, esc = [], False, False
    i = 0
    while i < len(s):
        ch = s[i]
        if in_str:
            out.append(ch)
            if esc:
                esc = False
            elif ch == chr(92):
                esc = True
            elif ch == '"':
                in_str = False
            i += 1
            continue
        if ch == '"':
            in_str = True; out.append(ch); i += 1; continue
        if ch == ',':
            j = i + 1
            while j < len(s) and s[j] in ' \t\r\n':
                j += 1
            if j < len(s) and s[j] in '}]':
                i += 1
                continue
        out.append(ch); i += 1
    return ''.join(out)
try:
    lock = json.loads(strip_trailing_commas(raw))
except Exception as e:
    print('    [FAIL] bun.lock 解析失败（不应发生）：', e)
    raise SystemExit(9)
changed = []
if key in lock:
    lock.pop(key); changed.append(key)
pkgs = lock.get('packages')
if isinstance(pkgs, dict) and key in pkgs:
    pkgs.pop(key); changed.append('packages.' + key)
ws = lock.get('workspaces')
if isinstance(ws, dict):
    for wk, wv in ws.items():
        deps = (wv or {}).get('dependencies')
        if isinstance(deps, dict) and key in deps:
            deps.pop(key); changed.append('workspaces.' + str(wk))
if changed:
    tmp = p + '.tmp'
    open(tmp, 'w', encoding='utf-8').write(json.dumps(lock, indent=2) + '\n')
    os.replace(tmp, p)
print('    已从 bun.lock 移除锁定条目：', changed or '（无需移除）')
UNLOCKEOF
)"
rsh "echo '${UNLOCK_PY}' | base64 -d | python3 - '${MANIFEST_KEY}' '${REMOTE_PLUGINS}/bun.lock'"
rsh "rm -rf '${REMOTE_PLUGINS}/node_modules/magpie-jet-hub'"
rsh "cd '${REMOTE_PLUGINS}' && ${MAGPIE_ENV} '${MAGPIE_BUN}' install 2>&1 | tail -8"

log "[5b] 校验安装结果"
rsh "grep 'magpie-jet-hub' '${REMOTE_PLUGINS}/bun.lock' | head -2"
rsh "grep -q 'github:hnlinyh/magpie-Jet-Hub' '${REMOTE_PLUGINS}/bun.lock'" || die "bun.lock 里没有 github:hnlinyh/magpie-Jet-Hub"
if rsh "grep -q 'github:Betsy20' '${REMOTE_PLUGINS}/bun.lock' 2>/dev/null"; then die "bun.lock 里还有 github:Betsy20"; fi
# ⚠️ bun 在 lock 里写的是**短 sha**（7 位），本地 rev-parse HEAD 是 40 位
# ⇒ 必须用前缀比较，等长比较会假红（2026-11-09 实测踩过）。
INSTALLED_SHA="$(rsh "grep -o 'github:hnlinyh/magpie-Jet-Hub#[0-9a-f]*' '${REMOTE_PLUGINS}/bun.lock' | head -1 | sed 's/.*#//'" || true)"
info "bun.lock 锁定的 commit：${INSTALLED_SHA}（本地 HEAD ${LOCAL_HEAD:0:12}）"
[[ -n "${INSTALLED_SHA}" && "${LOCAL_HEAD}" == "${INSTALLED_SHA}"* ]] || die "装到的是 ${INSTALLED_SHA}，不是本地 HEAD ${LOCAL_HEAD:0:12}（bun 用了旧 lock？）"
HITS_A="$(rsh "grep -c '${FEATURE_A}' '${REMOTE_PLUGINS}/node_modules/magpie-jet-hub/src/plugin.mjs' 2>/dev/null || true")"
HITS_B="$(rsh "grep -c '${FEATURE_B}' '${REMOTE_PLUGINS}/node_modules/magpie-jet-hub/src/plugin.mjs' 2>/dev/null || true")"
info "node_modules plugin.mjs 含 ${FEATURE_A}：${HITS_A:-0} 处 / 含 ${FEATURE_B}：${HITS_B:-0} 处"
[[ "${HITS_A:-0}" -gt 0 ]] || die "安装后的代码不含 ${FEATURE_A}（monkeycode/baizhi 的 mode 修复没进来）"
[[ "${HITS_B:-0}" -gt 0 ]] || die "安装后的代码不含 ${FEATURE_B}（令牌量级收敛没进来）"
TAG="$(rsh "cat '${REMOTE_PLUGINS}/node_modules/magpie-jet-hub/.bun-tag' 2>/dev/null || true")"
info ".bun-tag：${TAG:-<none>}"

# ---------------------------------------------------------------------------
# [6/7] 重启（带在途流排空保护）
# ---------------------------------------------------------------------------
if [[ "${NO_RESTART}" == "1" ]]; then
  log "[6/7] --no-restart：跳过重启（插件文件已更新，下次 magpie 重启后生效）"
else
  log "[6/7] 检查在途流（:3425 established）"
  busy_snapshot() {
    rsh "ss -tn state established '( sport = :3425 )' 2>/dev/null | awk 'NR>1 && \$5 != \"127.0.0.1:3425\" && \$5 != \"${REMOTE_HOST}:3425\" {print \$5}' | sort -u" || true
  }
  ACTIVE="$(busy_snapshot)"
  if [[ -n "${ACTIVE}" ]]; then
    info "有在途连接："; printf '%s\n' "${ACTIVE}" | sed 's/^/      /'
    if [[ "${RESTART_ANYWAY}" == "1" ]]; then
      warn "--restart-anyway：强制重启（会掐断这些流）"
    else
      info "等待在途流结束（最多 120s）……"
      waited=0
      while [[ -n "${ACTIVE}" && "${waited}" -lt 120 ]]; do
        sleep 5; waited=$((waited + 5))
        ACTIVE="$(busy_snapshot)"
      done
      if [[ -n "${ACTIVE}" ]]; then
        warn "仍有在途连接（${waited}s）："
        printf '%s\n' "${ACTIVE}" | sed 's/^/      /'
        die "为避免掐断正在跑的会话，拒绝自动重启。插件已装好；稍后重跑本脚本，或加 --restart-anyway 强制。"
      fi
      info "在途流已清空（等待 ${waited}s）"
    fi
  else
    info "无在途连接，可以安全重启"
  fi
  LOG_MARK_LINE="$(rsh "wc -l < /var/log/magpie.log" | tr -d ' ')"
  rsh "systemctl restart magpie"
fi

# ---------------------------------------------------------------------------
# [7/7] 探针
# ---------------------------------------------------------------------------
log "[7/7] 探针"
sleep 5
ok=0; meta_code=""; gw_code=""; console_code=""
for _ in $(seq 1 12); do
  meta_code="$(rsh "curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:18500/__meta || true")"
  gw_code="$(rsh "curl -sk -o /dev/null -m 8 -w '%{http_code}' https://127.0.0.1:3425/ || true")"
  console_code="$(rsh "curl -s -o /dev/null -m 5 -w '%{http_code}' 'http://127.0.0.1:3430/?k=${PROBE_WEB_KEY}' || true")"
  if [[ "${meta_code}" == "200" && "${gw_code}" != "000" && -n "${gw_code}" ]]; then ok=1; break; fi
  sleep 3
done
info "plugin host /__meta (18500) -> ${meta_code:-<none>}（期望 200）"
info "gateway https     (3425)  -> ${gw_code:-<none>}（期望非 000）"
info "console           (3430)  -> ${console_code:-<none>}（期望 200/303）"
[[ "${ok}" == "1" ]] || die "探针失败：插件宿主或网关没恢复"

# ⚠️ --no-restart 必须在这里退出：没重启就没有「本次新增日志」，
# LOG_MARK_LINE 还是初值 1 ⇒ 会扫整份历史日志，把上一轮事故当这次的失败。
if [[ "${NO_RESTART}" == "1" ]]; then
  info "--no-restart：代码已更新、未重启；跳过「新代码已加载」类探针"
  info "装到的版本：${INSTALLED_SHA}（本地 HEAD ${LOCAL_HEAD:0:12}）"
  info "下次 magpie 重启后生效：ssh ${REMOTE_NAME} systemctl restart magpie"
  exit 0
fi

LOAD_ERR="$(rsh "tail -n +${LOG_MARK_LINE} /var/log/magpie.log | grep -c \"didn't load\" 2>/dev/null || true")"
info "重启后 \"didn't load\"：${LOAD_ERR:-0} 条（期望 0）"
[[ "${LOAD_ERR:-0}" == "0" ]] || die "有插件加载失败"

READY="$(rsh "tail -n +${LOG_MARK_LINE} /var/log/magpie.log | grep -c 'jet-hub-accio' 2>/dev/null || true")"
info "重启后 jet-hub 就绪行：${READY:-0} 条（期望 >0）"
[[ "${READY:-0}" -gt 0 ]] || die "jet-hub 没加载（2026-11-09 挂掉时的症状）"

PROVIDERS="$(rsh "curl -s -m 10 http://127.0.0.1:18500/__meta | python3 -c \"import sys,json; j=json.load(sys.stdin); print(len(j.get('providers',[])))\" 2>/dev/null || echo 0")"
info "插件 provider 数：${PROVIDERS:-0}（期望 >0）"
[[ "${PROVIDERS:-0}" -gt 0 ]] || die "没有 provider（插件没加载）"

CHAT="$(rsh 'python3 -' <<PY 2>/dev/null || echo "ERR:probe-failed"
import json, urllib.request
items = json.load(open('/opt/magpie/config/magpie/caller-keys.json'))
if isinstance(items, dict): items = items.get('keys', [])
key = None
for k in items:
    if not isinstance(k, dict) or k.get('off'): continue
    s = k.get('secret') or k.get('key')
    if s: key = s; break
if not key:
    print('NO_KEY'); raise SystemExit(0)
req = urllib.request.Request('http://127.0.0.1:3425/v1/chat/completions',
    data=json.dumps({'model': '${PROBE_MODEL}',
                     'messages': [{'role': 'system', 'content': 'You are a helpful assistant.'},
                                  {'role': 'user', 'content': 'say ok'}], 'max_tokens': 8}).encode(),
    headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
try:
    body = urllib.request.urlopen(req, timeout=60).read().decode()
    print('OK_CHOICES' if '"choices"' in body else 'BAD:' + body[:300])
except Exception as e:
    print('ERR:' + str(e)[:300])
PY
)"
info "${PROBE_MODEL} 实调：${CHAT:-<空>}"
case "${CHAT}" in
  OK_CHOICES*) info "实调成功" ;;
  NO_KEY*)     warn "没有可用的 caller-key，跳过实调（登录态还要在面板里补）" ;;
  *)           warn "实调没返回 choices —— 模型多半未登录，插件本身已装好；登录后复测" ;;
esac

info ""
info "部署完成：服务器插件源 = ${GH_URL}（commit ${LOCAL_HEAD:0:12}）"
info "面板地址：https://magipe.ccwu.cc:3430/?k=${PROBE_WEB_KEY}"