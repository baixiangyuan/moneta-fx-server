#!/usr/bin/env bash
# MONETA FX 轻量部署 —— 不用 Docker，直接 venv + systemd。
# 适合 2h2g 小机器：内存约 120MB，启动约 3 秒。
#
# 用法（服务器上执行）：
#   curl -fsSL https://cdn.jsdelivr.net/gh/baixiangyuan/moneta-fx-server@main/scripts/deploy-light.sh | sudo bash
# 或先下载再跑：
#   wget https://.../deploy-light.sh && sudo bash deploy-light.sh

set -euo pipefail

REPO_URL="https://github.com/baixiangyuan/moneta-fx-server.git"
INSTALL_DIR="/opt/moneta-fx-server"
PORT="${MONETA_PORT:-4173}"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash deploy-light.sh"

# ── 1. 系统依赖 ────────────────────────────────────────────────────────
log "安装系统依赖"
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq python3 python3-venv python3-pip git curl ca-certificates >/dev/null
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y -q python3 python3-pip git curl >/dev/null
elif command -v yum >/dev/null 2>&1; then
  yum install -y -q python3 python3-pip git curl >/dev/null
else
  die "未识别的包管理器，请手动安装 python3 (>=3.10) 和 git"
fi

PYTHON="$(command -v python3)"
$PYTHON --version

# ── 2. 拉取代码 ────────────────────────────────────────────────────────
if [[ -d "$INSTALL_DIR/.git" ]]; then
  log "更新已有部署"
  git -C "$INSTALL_DIR" fetch --quiet origin main
  git -C "$INSTALL_DIR" reset --hard --quiet origin/main
else
  log "克隆仓库到 $INSTALL_DIR"
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 --branch main "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# ── 3. Python 环境 ─────────────────────────────────────────────────────
log "创建虚拟环境并安装依赖"
if [ ! -d .venv ]; then
  $PYTHON -m venv .venv
fi
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q fastapi "uvicorn[standard]" pydantic

# ── 4. 环境变量 ────────────────────────────────────────────────────────
if [[ ! -f .env ]]; then
  log "生成 .env（首次部署）"
  cat > .env <<EOF
MONETA_HOST=0.0.0.0
MONETA_PORT=$PORT
MONETA_DATA_DIR=$INSTALL_DIR/data
MONETA_DEVELOPER_KEY=moneta-$(openssl rand -hex 16)
MONETA_ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)
MONETA_INITIAL_BALANCE=100000
MONETA_TICK_MS=250
MONETA_PERSIST_MS=5000
EOF
  chmod 600 .env
  warn "已生成随机密钥，请保存："
  grep -E '^MONETA_(DEVELOPER_KEY|ADMIN_PASSWORD)=' .env | sed 's/^/    /'
else
  log "沿用已有 .env"
fi

set -a; . ./.env; set +a
mkdir -p "$MONETA_DATA_DIR"

# ── 5. systemd 服务 ────────────────────────────────────────────────────
log "注册 systemd 服务 moneta-fx"
cat > /etc/systemd/system/moneta-fx.service <<EOF
[Unit]
Description=MONETA FX cloud server
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$INSTALL_DIR/.env
ExecStart=$INSTALL_DIR/.venv/bin/python $INSTALL_DIR/server/app.py
Restart=always
RestartSec=3
StandardOutput=append:$INSTALL_DIR/data/server.log
StandardError=append:$INSTALL_DIR/data/server.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now moneta-fx

# ── 6. 防火墙 ──────────────────────────────────────────────────────────
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  log "放行 ufw 端口 $MONETA_PORT/tcp"
  ufw allow "$MONETA_PORT/tcp" >/dev/null || true
fi

# ── 7. 健康检查 ────────────────────────────────────────────────────────
log "等待服务就绪"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${MONETA_PORT}/api/config" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if curl -fsS "http://127.0.0.1:${MONETA_PORT}/api/config" >/dev/null 2>&1; then
  IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
  log "部署完成"
  printf '\n'
  printf '    交易室入口 : http://%s:%s/\n' "$IP" "$MONETA_PORT"
  printf '    内存占用   : %s\n' "$(free -m | awk '/Mem:/ {print $3" MB / "$2" MB"}')"
  printf '    查看日志   : journalctl -u moneta-fx -f\n'
  printf '    重启服务   : systemctl restart moneta-fx\n'
  printf '    停止服务   : systemctl stop moneta-fx\n'
  printf '\n'
  printf '    升级到最新 : cd %s && sudo git pull && sudo systemctl restart moneta-fx\n' "$INSTALL_DIR"
  printf '\n'
else
  die "服务未就绪，查看日志：journalctl -u moneta-fx -n 50"
fi
