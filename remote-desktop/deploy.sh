#!/usr/bin/env bash
# 一键部署 RustDesk 服务端到阿里云 ECS 47.97.41.141
# 用法: ./deploy.sh <ssh_user>   例如 ./deploy.sh root
set -euo pipefail

SERVER=47.97.41.141
SSH_USER="${1:-root}"
REMOTE_DIR=/opt/rustdesk

echo "==> 1. 上传部署文件到 ${SSH_USER}@${SERVER}:${REMOTE_DIR}"
ssh "${SSH_USER}@${SERVER}" "mkdir -p ${REMOTE_DIR}"
scp "$(dirname "$0")/docker-compose.yml" "${SSH_USER}@${SERVER}:${REMOTE_DIR}/"

echo "==> 2. 在 ECS 上安装 Docker（如未安装）并启动服务"
ssh "${SSH_USER}@${SERVER}" bash -s <<'EOF'
set -euo pipefail
cd /opt/rustdesk
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | bash
  systemctl enable --now docker
fi
# 国内 ECS 拉镜像慢/失败时，可配置镜像加速后再执行：
# mkdir -p /etc/docker && cat > /etc/docker/daemon.json <<'JSON'
# { "registry-mirrors": ["https://mirror.ccs.tencentyun.com"] }
# JSON
# systemctl restart docker
docker compose up -d
docker compose ps
EOF

echo "==> 3. 读取服务端公钥（Mac 被控端配置要用）"
ssh "${SSH_USER}@${SERVER}" "sleep 3; cat ${REMOTE_DIR}/data/server/id_ed25519.pub 2>/dev/null || cat ${REMOTE_DIR}/data/server/id_ed25519.pub 2>/dev/null || echo '公钥未生成，请检查 docker logs rustdesk-server'"

echo ""
echo "完成。下一步："
echo "  1. 阿里云控制台安全组放行: TCP 21114-21119, UDP 21116"
echo "  2. 浏览器打开 http://${SERVER}:21114 进管理后台（默认 admin，首次登录请改密码）"
echo "  3. 把上面输出的公钥填进 docker-compose.yml 的 RUSTDESK_API_RUSTDESK_KEY 后重新 docker compose up -d"
echo "  4. 在 Mac 上按 setup-mac.md 配置被控端"
