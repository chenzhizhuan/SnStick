#!/usr/bin/env bash
# =============================================================
# SnStick (TSP · A股智能量化工作台) 目标机部署/升级脚本
# 适用: x86_64 / amd64, 已装 docker (含 compose 插件), root 执行
# 镜像: 221.237.179.2:13400/snstick/app:v0.3.0-amd64 (私有 HTTP registry)
#
# 三件套 (与本脚本同目录): manage.sh + docker-compose.yml + .env (含密钥)
#
# 凭证: 本脚本不保存任何密码。首次运行流程 (注意顺序):
#   1) bash manage.sh        → 自动配置 insecure-registries (HTTP registry 必需)
#   2) 按提示执行: docker login 221.237.179.2:13400 -u admin  (密码交互输入)
#   3) 重跑 bash manage.sh   → 完成部署
#   说明: docker login 由 daemon 代为连库验证, 未配 insecure-registries 时
#   会报 "server gave HTTP response to HTTPS client" — 所以必须先跑脚本、
#   后 login, 顺序不能反。
#
# 幂等 / 升级:
#   - 重跑安全: $APP_DIR 已有的 compose 与 .env 一律不覆盖 (现场修改优先)
#   - 日常升级: 编辑 $APP_DIR/docker-compose.yml 的 image tag 后重跑本脚本
#     (自动: 校验 tag → pull → 按新镜像刷新 tiers.yaml → up -d)
#
# 其他:
#   - 账号互通: 直连本机 AGTI postgres (host.docker.internal:27095, 库 agti)
#   - data 全新起步, 首启自动拉历史行情 (预热几分钟属正常)
#   - Web 只绑 127.0.0.1:3018, 由反代 (tick.agti.ai) 转发
# 用法: bash manage.sh    (换目录: APP_DIR=/xxx bash manage.sh)
# =============================================================
set -euo pipefail

REG=221.237.179.2:13400
TAG=v0.3.0-amd64
IMAGE=$REG/snstick/app:$TAG
APP_DIR=${APP_DIR:-/www/wwwroot/SnStick}
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

say()  { echo -e "\n===== $* ====="; }
info() { echo "[ok]   $*"; }
warn() { echo "[warn] $*"; }
die()  { echo "[fail] $*" >&2; exit 1; }

# 重启 docker 后等 daemon 恢复 (最多 ~30s), 避免误判 "未生效"
wait_docker() {
  local i
  for i in $(seq 1 15); do
    docker info >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# ---- 0. 环境检查 ----
say "0/8 环境检查"
[ "$(id -u)" -eq 0 ] || die "请用 root 运行"
[ "$(uname -m)" = "x86_64" ] || die "本脚本面向 x86_64, 当前架构: $(uname -m)"
docker compose version >/dev/null 2>&1 || die "缺少 docker compose 插件, 请先安装"
command -v python3 >/dev/null || die "缺少 python3 (daemon.json 合并与 DSN 解析要用)"
command -v curl >/dev/null || die "缺少 curl (registry 探测与 Web 验证要用)"

# ---- 1. registry 连通性 ----
say "1/8 registry 连通性 ($REG)"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 http://$REG/v2/ || echo 000)
if [ "$code" = "401" ]; then
  info "可达 (401=需鉴权, 正常)"
else
  die "不可达 (HTTP $code) — 检查源机 221.237.179.2 的 13400 端口是否对目标机 IP 放行"
fi

# ---- 2. insecure-registries (HTTP registry 必需; login/pull 都经 daemon) ----
say "2/8 配置 insecure-registries"
python3 - "$REG" <<'PYEOF'
import json, os, sys
reg = sys.argv[1]
p = '/etc/docker/daemon.json'
cfg = {}
if os.path.exists(p):
    raw = open(p).read().strip()
    if raw:
        try:
            cfg = json.loads(raw)
        except Exception as e:
            print('daemon.json 已存在但不是合法 JSON (%s), 请人工合并 insecure-registries 后重跑' % e)
            sys.exit(1)
regs = cfg.get('insecure-registries', [])
if reg in regs:
    print('已包含 %s, 跳过' % reg)
else:
    regs.append(reg)
    cfg['insecure-registries'] = regs
    json.dump(cfg, open(p, 'w'), indent=2)
    print('已写入 %s: insecure-registries += %s' % (p, reg))
PYEOF
systemctl reload docker 2>/dev/null || true
sleep 2
if docker info 2>/dev/null | grep -q "$REG"; then
  info "已生效 (reload 即可, 未动容器)"
else
  echo "reload 未生效, 需重启 docker daemon。"
  if docker info 2>/dev/null | grep -qi 'Live Restore Enabled: true'; then
    read -p "live-restore 已开启(运行中容器不中断)。现在重启 docker? [y/N] " yn
    if [ "${yn:-n}" = "y" ]; then
      systemctl restart docker
      wait_docker || die "docker 重启后未恢复, 请人工检查: systemctl status docker"
    else
      die "请稍后手动重启并重跑本脚本"
    fi
  else
    echo "!! 注意: live-restore 未开启时, 重启 docker 会重启本机所有容器 (含 AGTI 生产) !!"
    read -p "仍要重启 docker? [y/N] " yn
    if [ "${yn:-n}" = "y" ]; then
      systemctl restart docker
      wait_docker || die "docker 重启后未恢复, 请人工检查: systemctl status docker"
    else
      die "请人工处理后重跑本脚本"
    fi
  fi
  docker info 2>/dev/null | grep -q "$REG" || die "重启后仍未生效, 请检查 daemon.json"
fi

# ---- 3. 私有仓库登录状态 ----
say "3/8 私有仓库登录状态"
if ! python3 - "$REG" <<'PYEOF'
import json, os, sys
reg = sys.argv[1]
p = os.path.expanduser('~/.docker/config.json')
try:
    cfg = json.load(open(p))
except Exception:
    sys.exit(1)
sys.exit(0 if reg in cfg.get('auths', {}) else 1)
PYEOF
then
  die "尚未登录私有仓库 (insecure-registries 已配好, 现在可以登录了):
     docker login $REG -u admin
   (密码交互输入, 不进命令行历史/脚本) 登录后重跑本脚本。"
fi
info "已登录 (复用 ~/.docker/config.json 凭证)"

# ---- 4. 部署文件 ----
say "4/8 部署文件 -> $APP_DIR"
mkdir -p "$APP_DIR/data"

# docker-compose.yml: 只在缺失时落位; 已存在则现场优先, 与 deploy 版不一致仅提醒
if [ ! -f "$APP_DIR/docker-compose.yml" ]; then
  if [ -f "$SCRIPT_DIR/docker-compose.yml" ]; then
    cp "$SCRIPT_DIR/docker-compose.yml" "$APP_DIR/docker-compose.yml"
    info "compose 已就位 (来源: $SCRIPT_DIR/docker-compose.yml)"
  else
    cat > "$APP_DIR/docker-compose.yml" <<'COMPOSE_EOF'
services:
  app:
    # Phase 0 单 service:FastAPI 启动后既跑 API 又托管前端 dist。
    image: 221.237.179.2:13400/snstick/app:v0.3.0-amd64
    container_name: snstick-app
    ports:
      - "${HOST:-127.0.0.1}:${PORT:-3018}:3018"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    env_file:
      - .env
    environment:
      # 强制固定为容器内绝对路径, 防止 .env 的 DATA_DIR=./data (开发模式用)
      # 被 env_file 原样传入容器后按相对路径解析, 写到未挂载目录导致丢数据。
      - DATA_DIR=/app/data
      - CODEX_DOCKER_HOST=host.docker.internal
    volumes:
      - ./data:/app/data
      - ./tiers.yaml:/app/tiers.yaml:ro
      - ./.env:/app/.env:ro
      # Codex 登录态 (不存在则 docker 自动建空目录, 不影响启动)
      - ${CODEX_HOME_HOST:-${HOME}/.codex}:/root/.codex:ro
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "3"
    restart: unless-stopped
COMPOSE_EOF
    info "compose 由内置兜底版生成 (建议改用独立 docker-compose.yml 文件)"
  fi
elif [ -f "$SCRIPT_DIR/docker-compose.yml" ] \
     && ! diff -q "$SCRIPT_DIR/docker-compose.yml" "$APP_DIR/docker-compose.yml" >/dev/null 2>&1; then
  warn "现场 compose 与 deploy 版不一致 (现场优先, 不覆盖)"
  echo "   如需采用 deploy 版: rm $APP_DIR/docker-compose.yml 后重跑本脚本"
fi

# .env: 只在缺失时从模板落位; 已存在则现场优先
if [ ! -f "$APP_DIR/.env" ]; then
  env_src=""
  for tmpl in "$SCRIPT_DIR/.env" "$SCRIPT_DIR/snstick.env"; do
    if [ -f "$tmpl" ]; then env_src="$tmpl"; break; fi
  done
  [ -n "$env_src" ] || die "缺少 .env: 请将目标机配置放到 $SCRIPT_DIR/.env (或 $APP_DIR/.env) 后重跑"
  cp "$env_src" "$APP_DIR/.env"
  info "已生成 $APP_DIR/.env (来源: $env_src)"
fi
chmod 600 "$APP_DIR/.env"

# ---- 5. 镜像就绪 + tiers.yaml ----
say "5/8 镜像就绪与 tiers.yaml"
# 以 APP_DIR compose 实际引用的镜像为准 (升级改 tag 后重跑也能对上版本)
CUR_IMAGE=$(grep -m1 -E '^[[:space:]]*image:' "$APP_DIR/docker-compose.yml" 2>/dev/null | awk '{print $2}')
CUR_IMAGE=${CUR_IMAGE:-$IMAGE}
info "目标镜像: $CUR_IMAGE"
docker manifest inspect --insecure "$CUR_IMAGE" >/dev/null 2>&1 || \
  die "registry 中查不到 $CUR_IMAGE
     核对可用 tag: curl -u admin:<密码> http://$REG/v2/snstick/app/tags/list
     本机架构 $(uname -m) 需要 -amd64 后缀的镜像。"
docker pull "$CUR_IMAGE"
docker image inspect "$CUR_IMAGE" --format '镜像架构: {{.Architecture}}/{{.Os}}  大小: {{.Size}}'

# tiers.yaml 从「将实际运行的镜像」提取, 与镜像版本严格一致; 原子替换, 失败即终止
# (容器强依赖该文件: 缺失/为空/版本不匹配都可能起不来或行为异常)
tmp_tiers="$APP_DIR/.tiers.yaml.tmp"
if docker run --rm "$CUR_IMAGE" cat /app/tiers.yaml > "$tmp_tiers" 2>/dev/null && [ -s "$tmp_tiers" ]; then
  mv -f "$tmp_tiers" "$APP_DIR/tiers.yaml"
  info "tiers.yaml 已按镜像刷新 ($(wc -c < "$APP_DIR/tiers.yaml") 字节)"
else
  rm -f "$tmp_tiers"
  die "tiers.yaml 提取失败 — 终止以免起一个坏容器"
fi

# ---- 6. AGTI 数据库预检 (从 .env 的 AGTI_DSN 解析, 不硬编码) ----
say "6/8 AGTI postgres 连通性"
read -r AGTI_HOST AGTI_PORT < <(python3 - "$APP_DIR/.env" <<'PYEOF'
import sys, urllib.parse
dsn = ''
for line in open(sys.argv[1], encoding='utf-8'):
    if line.startswith('AGTI_DSN='):
        dsn = line.strip().split('=', 1)[1].strip().strip("'\"")
        break
try:
    u = urllib.parse.urlparse(dsn)
    print(u.hostname or 'host.docker.internal', u.port or 27095)
except Exception:
    print('host.docker.internal', 27095)
PYEOF
) || true
AGTI_HOST=${AGTI_HOST:-host.docker.internal}
AGTI_PORT=${AGTI_PORT:-27095}
HOSTCHECK=$AGTI_HOST
if [ "$HOSTCHECK" = "host.docker.internal" ]; then HOSTCHECK=127.0.0.1; fi
info "DSN 解析: 容器视角 $AGTI_HOST:$AGTI_PORT / 宿主视角 $HOSTCHECK:$AGTI_PORT"
if timeout 3 bash -c "</dev/tcp/$HOSTCHECK/$AGTI_PORT" 2>/dev/null; then
  info "宿主机 $HOSTCHECK:$AGTI_PORT 可达"
else
  warn "宿主机 $HOSTCHECK:$AGTI_PORT 不可达"
  echo "   若 AGTI postgres 映射端口不同, 请编辑 $APP_DIR/.env 的 AGTI_DSN 后重跑"
fi

# ---- 7. 启动 ----
say "7/8 启动容器"
WEBPORT=$(grep -oP '^PORT=\K\d+' "$APP_DIR/.env" 2>/dev/null || echo 3018)
if docker ps --filter name=snstick-app --format '{{.Names}}' | grep -q .; then
  info "snstick-app 已在运行 (幂等重跑), 跳过端口占用检查"
else
  if ss -tln 2>/dev/null | grep -q ":$WEBPORT "; then
    die "端口 $WEBPORT 已被其他进程占用。编辑 $APP_DIR/.env 的 PORT= 换端口后重跑"
  fi
fi
cd "$APP_DIR"
docker compose config >/dev/null 2>&1 || die "docker-compose.yml 解析失败, 请检查语法"
docker compose up -d

# ---- 8. 验证 ----
say "8/8 验证"
sleep 8
docker ps --filter name=snstick-app --format '{{.Names}}  {{.Status}}  {{.Ports}}'
# Web 探测: 首启要拉全市场历史行情, 预热可能几分钟; 最多等 ~2 分钟, 超时仅警告
web_ok=0
for i in $(seq 1 12); do
  code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$WEBPORT/" || echo 000)
  if [ "$code" = "200" ]; then web_ok=1; info "Web 本机探测: HTTP 200"; break; fi
  echo "  等待服务就绪... ($i/12, HTTP $code)"
  sleep 10
done
[ "$web_ok" = "1" ] || warn "Web 暂未就绪 — 首启拉取历史行情预热中属正常, 几分钟后直接访问; 日志: docker logs -f snstick-app"
echo "--- identity 连通 (AGTI 账号互通) ---"
docker exec snstick-app python -c "import socket; s=socket.socket(); s.settimeout(3); s.connect(('$AGTI_HOST', $AGTI_PORT)); print('容器内 -> $AGTI_HOST:$AGTI_PORT 可达')" 2>/dev/null \
  || warn "容器内 -> $AGTI_HOST:$AGTI_PORT 不可达 (检查端口/防火墙; 若 ufw 拦了 docker 网段: ufw allow from 172.17.0.0/16 to any port $AGTI_PORT)"
docker logs snstick-app 2>&1 | grep -E 'identity pool ready|ERROR' | tail -5 || true

# 清理悬空旧镜像 (升级后旧版无 tag 残留; 与 SnSclaw manage.sh 同款行为)
docker image prune -f >/dev/null 2>&1 || true

say "部署/升级完成"
cat <<'TIP'
后续:
  1) 反向代理 tick.agti.ai -> http://127.0.0.1:3018
     (SSE 流式进度必须: proxy_buffering off; proxy_read_timeout 3600s)
  2) 首启自动拉全市场历史行情, 预热几分钟属正常
  3) 日常升级: 编辑 $APP_DIR/docker-compose.yml 的 image tag 后重跑本脚本
     (自动: 校验 tag → pull → 按新镜像刷新 tiers.yaml → up -d; 现有 compose/.env 不覆盖)
TIP
