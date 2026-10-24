#!/usr/bin/env bash
# MONETA FX 云端服务端一键部署脚本。
#
# 用法（服务器上执行）：
#   curl -fsSL https://raw.githubusercontent.com/baixiangyuan/moneta-fx-server/main/scripts/deploy.sh | sudo bash
#
# 幂等：可重复执行，用于更新到最新版本。数据保存在 Docker 卷
# moneta-data 里，重新部署不会丢失账户与持仓。

set -euo pipefail

REPO_URL="https://github.com/baixiangyuan/moneta-fx-server.git"
INSTALL_DIR="/opt/moneta-fx"
COMPOSE_FILE="docker-compose.yml"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. 依赖检查 ────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  log "未检测到 Docker，开始安装"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

if ! docker compose version >/dev/null 2>&1; then
  die "docker compose 不可用，请升级 Docker 到 20.10+ 或安装 compose 插件"
fi

# ── 2. 拉取代码 ────────────────────────────────────────────────────────
if [[ -d "$INSTALL_DIR/.git" ]]; then
  log "更新已有部署：$INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --quiet origin main
  git -C "$INSTALL_DIR" reset --hard --quiet origin/main
else
  log "克隆仓库到 $INSTALL_DIR"
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 --branch main "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# ── 3. 环境变量 ────────────────────────────────────────────────────────
# .env 只在首次创建，重复部署不会覆盖你改过的密钥。
if [[ ! -f .env ]]; then
  log "生成 .env（首次部署）"
  DEV_KEY="moneta-$(openssl rand -hex 16)"
  ADMIN_PW="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
  cat > .env <<EOF
# MONETA FX 服务端配置 —— 由 deploy.sh 生成，可自行修改后重启生效
MONETA_HOST=0.0.0.0
MONETA_PORT=4173
MONETA_DATA_DIR=/data

# 开发者密钥：插件/网页行情控制台登录用，改这里
MONETA_DEVELOPER_KEY=$DEV_KEY
# 管理员口令：账户管理与资金调度面板登录用，改这里
MONETA_ADMIN_PASSWORD=$ADMIN_PW

MONETA_INITIAL_BALANCE=100000
MONETA_TICK_MS=250
MONETA_PERSIST_MS=5000
# 有对外域名时取消下一行注释并填写
# MONETA_PUBLIC_DOMAIN=fx.example.com
EOF
  chmod 600 .env
  warn "已生成随机密钥，保存好这两项："
  grep -E '^MONETA_(DEVELOPER_KEY|ADMIN_PASSWORD)=' .env | sed 's/^/    /'
else
  log "沿用已有 .env"
fi

# ── 4. 防火墙放行端口 ──────────────────────────────────────────────────
PORT="$(grep -E '^MONETA_PORT=' .env | cut -d= -f2 | tr -d '"\r' || true)"
PORT="${PORT:-4173}"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  log "放行 ufw 端口 $PORT/tcp"
  ufw allow "$PORT/tcp" >/dev/null || true
fi

# ── 5. 构建并启动 ──────────────────────────────────────────────────────
log "构建镜像并启动容器"
docker compose --env-file .env -f "$COMPOSE_FILE" up -d --build

# ── 6. 健康检查 ────────────────────────────────────────────────────────
log "等待服务就绪"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/config" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if curl -fsS "http://127.0.0.1:${PORT}/api/config" >/dev/null 2>&1; then
  IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
  log "部署完成"
  printf '\n'
  printf '    交易室入口 : http://%s:%s/\n' "$IP" "$PORT"
  printf '    本地探活   : curl http://127.0.0.1:%s/api/config\n' "$PORT"
  printf '    查看日志   : docker compose -f %s/%s logs -f\n' "$INSTALL_DIR" "$COMPOSE_FILE"
  printf '    重启服务   : docker compose -f %s/%s restart\n' "$INSTALL_DIR" "$COMPOSE_FILE"
  printf '\n'
else
  die "服务未就绪，查看日志：docker compose -f $INSTALL_DIR/$COMPOSE_FILE logs --tail=50"
fi
