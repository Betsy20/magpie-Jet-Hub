#!/usr/bin/env bash
# deploy-plugin-hcss2.sh — 把 GitHub fork 上的 magpie-jet-hub 更新到 hcss2 网关
#
# 背景（2026-11-09 定稿）：hcss2 的插件源固定为**用户自己的 GitHub fork**
# `https://github.com/hnlinyh/magpie-Jet-Hub`（默认分支 main）。本地改完 →
# 推到 fork → 跑本脚本让服务器重新安装并重启。
#
# 用法：
#   bash scripts/deploy-plugin-hcss2.sh            # 校验 + 远端更新 + 重启 + 探针
#   bash scripts/deploy-plugin-hcss2.sh --check    # 只做本地/远端版本校验，不动服务器
#   bash scripts/deploy-plugin-hcss2.sh --no-restart  # 更新插件但不重启（下个自然重启生效）
#   bash scripts/deploy-plugin-hcss2.sh --restart-anyway  # 有在途流也强制重启
#   DRY_RUN=1 bash scripts/deploy-plugin-hcss2.sh  # 只打印将要执行的动作
#
# ⚠️ 重启会**硬切所有在途 SSE 流**（magpie 无 drain/reload；用户 2026-11-09 报
#    `upstream stream ended before a completion event` 就是它）。所以默认重启前
#    会查 :3425 的活跃连接：有任何非本机 established 连接就等（最多 120s），
#    仍不静默则**拒绝重启**（插件已装好，可稍后重跑或 --restart-anyway）。
#
# 前置：本地分支已推到 fork 且 main 已快进（脚本会校验 fork main==本地 HEAD，
#       不一致直接失败，避免「服务器装到旧版」的静默错误）。
#
# 严禁：不要用 `magpie plugin add <tarball/URL>` 来换源。2026-11-09 实测：
#   `magpie plugin add ./dist/x.tgz` 会把 tarball 路径当插件 spec 写进
#   plugins.json，重启时宿主把 tarball 当 JS 模块加载（exports no OpenCode
#   plugin function）；同时 manifest 已改本地引用、旧 spec 映射丢失
#   （no such plugin: node_modules/https:/github.com/...）⇒ jet-hub 整个不加载，
#   所有模型请求 502（占位域名 jet-hub.invalid）。正确做法就是本脚本：
#   plugins/package.json 与 plugins.json 的 spec 都写同一个 GitHub URL，
#   然后 bun install + restart。
set -Eeuo pipefail

REPO_DIR="/root/project/magpie-Jet-Hub"
GH_URL="https://github.com/hnlinyh/magpie-Jet-Hub"
REMOTE_HOST="1.95.121.143"
REMOTE_USER="root"
SSH_KEY="/mnt/workspace/.ssh/hcss_dc2f"
SSH_OPTS=(-i "${SSH_KEY}" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new)
REMOTE_PLUGINS="/opt/magpie/config/magpie/plugins"
REMOTE_STATE_DIR="/opt/magpie/config/magpie"
BAK_SUFFIX="20261109-github"
MAGPIE_BUN="/opt/magpie/cache/magpie/bun/1.4.4/magpie-bun"
MAGPIE_ENV="HOME=/opt/magpie/home XDG_CONFIG_HOME=/opt/magpie/config XDG_CACHE_HOME=/opt/magpie/cache MAGPIE_NPM_REGISTRY=https://registry.npmmirror.com MAGPIE_GITHUB_MIRROR=https://gh-proxy.com"

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
      1) ssh ${REMOTE_USER}@${REMOTE_HOST}
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
    ssh ${REMOTE_USER}@${REMOTE_HOST}
    cd ${REMOTE_PLUGINS} && cp -p package.json{,.bak-${BAK_SUFFIX}} && cp -p bun.lock{,.bak-${BAK_SUFFIX}}
    cp -p ${REMOTE_STATE_DIR}/plugins.json{,.bak-${BAK_SUFFIX}}
    改 package.json 依赖：magpie-jet-hub -> ${GH_URL}
    改 plugins.json spec：删本地 tgz / 旧 GitHub 项，插入 ${GH_URL}
    cd ${REMOTE_PLUGINS} && ${MAGPIE_ENV} ${MAGPIE_BUN} install
    systemctl restart magpie
    探针：console 200、gateway 200、新日志无 "didn't load"、jet-hub 就绪行 >0、baizhi 实调 choices
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
j['dependencies']['magpie-jet-hub'] = '${GH_URL}'
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
kept = [x for x in j.get('plugins', [])
        if x.get('spec') != 'magpie-jet-hub'
        and 'magpie-jet-hub-' not in x.get('spec', '')
        and 'github.com/Betsy20/magpie-Jet-Hub' not in x.get('spec', '')
        and 'github.com/hnlinyh/magpie-Jet-Hub' not in x.get('spec', '')]
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
rsh "cd '${REMOTE_PLUGINS}' && ${MAGPIE_ENV} '${MAGPIE_BUN}' install 2>&1 | tail -8"

log "[5b] 校验安装结果"
rsh "grep 'magpie-jet-hub' '${REMOTE_PLUGINS}/bun.lock' | head -2"
rsh "grep -q 'github:hnlinyh/magpie-Jet-Hub' '${REMOTE_PLUGINS}/bun.lock'" || die "bun.lock 里没有 github:hnlinyh/magpie-Jet-Hub"
if rsh "grep -q 'github:Betsy20' '${REMOTE_PLUGINS}/bun.lock' 2>/dev/null"; then die "bun.lock 里还有 github:Betsy20"; fi
HITS="$(rsh "grep -c 'formatBaizhiPoolSplit' '${REMOTE_PLUGINS}/node_modules/magpie-jet-hub/console/console.js' 2>/dev/null || true")"
info "node_modules console.js 含 formatBaizhiPoolSplit：${HITS:-0} 处"
[[ "${HITS:-0}" -gt 0 ]] || die "安装后的代码不含本地修复（装到旧版了？）"

# ---------------------------------------------------------------------------
# [6/7] 重启（带在途流排空保护）
# ---------------------------------------------------------------------------
if [[ "${NO_RESTART}" == "1" ]]; then
  log "[6/7] --no-restart：跳过重启（插件文件已更新，下次 magpie 重启后生效）"
else
  log "[6/7] 检查在途流（:3425 established）"
  busy_snapshot() {
    rsh "ss -tn state established '( sport = :3425 )' 2>/dev/null | awk 'NR>1 && \$5 != \"127.0.0.1:3425\" && \$5 != \"1.95.121.143:3425\" {print \$5}' | sort -u" || true
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
ok=0; meta_code=""; tls_code=""
for _ in $(seq 1 12); do
  meta_code="$(rsh "curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:18500/__meta || true")"
  tls_code="$(rsh "curl -sk -o /dev/null -m 8 -w '%{http_code}' https://127.0.0.1:3425/ || true")"
  if [[ "${meta_code}" == "200" && "${tls_code}" != "000" && -n "${tls_code}" ]]; then ok=1; break; fi
  sleep 3
done
info "console /__meta -> ${meta_code:-<none>}（期望 200）"
info "gateway https  -> ${tls_code:-<none>}（期望非 000）"
[[ "${ok}" == "1" ]] || die "探针失败：控制台或网关没恢复"

LOAD_ERR="$(rsh "tail -n +${LOG_MARK_LINE} /var/log/magpie.log | grep -c \"didn't load\" 2>/dev/null || true")"
info "重启后 \"didn't load\"：${LOAD_ERR:-0} 条（期望 0）"
[[ "${LOAD_ERR:-0}" == "0" ]] || die "有插件加载失败"

if [[ "${NO_RESTART}" == "1" ]]; then
  info "--no-restart：跳过「新代码已加载」探针（当前跑的还是旧进程）"
  info "部署完成（未重启）。下次重启后生效：systemctl restart magpie"
  exit 0
fi

READY="$(rsh "tail -n +${LOG_MARK_LINE} /var/log/magpie.log | grep -c 'jet-hub-accio' 2>/dev/null || true")"
info "重启后 jet-hub 就绪行：${READY:-0} 条（期望 >0）"
[[ "${READY:-0}" -gt 0 ]] || die "jet-hub 没加载（2026-11-09 挂掉时的症状）"

PROVIDERS="$(rsh "curl -s -m 10 http://127.0.0.1:18500/__meta | python3 -c \"import sys,json; j=json.load(sys.stdin); print(len(j.get('providers',[])))\" 2>/dev/null || echo 0")"
info "控制台 provider 数：${PROVIDERS:-0}（期望 >0）"
[[ "${PROVIDERS:-0}" -gt 0 ]] || die "控制台没有 provider"

CHAT="$(rsh 'python3 -' <<'PY' 2>/dev/null || echo "ERR:probe-failed"
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
    data=json.dumps({'model': 'jet-hub-baizhi/deepseek-v4-flash',
                     'messages': [{'role': 'user', 'content': 'say ok'}], 'max_tokens': 8}).encode(),
    headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
try:
    body = urllib.request.urlopen(req, timeout=40).read().decode()
    print('OK_CHOICES' if '"choices"' in body else 'BAD:' + body[:200])
except Exception as e:
    print('ERR:' + str(e)[:200])
PY
)"
info "baizhi 实调：${CHAT:-<空>}"
case "${CHAT}" in
  OK_CHOICES*) info "实调成功" ;;
  *) die "实调没返回 choices" ;;
esac

info ""
info "部署完成：服务器插件源 = ${GH_URL}（commit ${LOCAL_HEAD:0:12}）"
