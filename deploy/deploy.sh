#!/usr/bin/env bash
# 酒水项目一键部署: 本机构建镜像 -> docker save/scpload -> 服务器compose起栈
# 用法: ./deploy/deploy.sh [logs|restart|down|ps]
set -euo pipefail

REMOTE="${REMOTE:-liquor-sg}"                 # ~/.ssh/config 里的主机别名
REMOTE_DIR="${REMOTE_DIR:-~/liquor}"
TAG="${TAG:-latest}"

cd "$(dirname "$0")/.."

cmd="${1:-deploy}"
case "$cmd" in
  logs)    exec ssh "$REMOTE" "cd $REMOTE_DIR && sudo docker compose logs -f --tail=100" ;;
  restart) exec ssh "$REMOTE" "cd $REMOTE_DIR && sudo docker compose restart" ;;
  ps)      exec ssh "$REMOTE" "cd $REMOTE_DIR && sudo docker compose ps" ;;
  down)    exec ssh "$REMOTE" "cd $REMOTE_DIR && sudo docker compose down" ;;
  deploy) ;;
  *) echo "用法: $0 [deploy|logs|restart|ps|down]"; exit 1 ;;
esac

echo "==> [1/5] 本机构建镜像 (需要本机docker; 没有则先装)"
docker build -t liquor/api:$TAG  -f apps/api/Dockerfile    .
docker build -t liquor/web:$TAG  -f deploy/web.Dockerfile  .

echo "==> [2/5] 导出镜像"
docker save liquor/api:$TAG liquor/web:$TAG | gzip > /tmp/liquor-images.tgz

echo "==> [3/5] 上传 (2C小机直载镜像, 不走registry)"
ssh "$REMOTE" "mkdir -p $REMOTE_DIR"
scp /tmp/liquor-images.tgz "$REMOTE:/tmp/"
scp deploy/docker-compose.yml "$REMOTE:$REMOTE_DIR/docker-compose.yml"

echo "==> [4/5] 服务器: 导入镜像 + 准备.env(首次自动生成密钥)"
ssh "$REMOTE" "
  set -e
  umask 077
  gunzip -c /tmp/liquor-images.tgz | sudo docker load
  rm /tmp/liquor-images.tgz
  cd $REMOTE_DIR
  if [ ! -f .env ]; then
    cat > .env <<EOF
POSTGRES_PASSWORD=\$(openssl rand -hex 16)
JWT_SECRET=\$(openssl rand -hex 32)
LIQUOR_APP_PASSWORD=\$(openssl rand -hex 24)
TAG=$TAG
EOF
    echo '  已生成 .env (首次)'
  elif ! grep -q '^LIQUOR_APP_PASSWORD=' .env; then
    echo LIQUOR_APP_PASSWORD=\$(openssl rand -hex 24) >> .env
    echo '  已补 LIQUOR_APP_PASSWORD (不覆盖已有口令)'
  fi
  chmod 600 .env
"

echo "==> [5/5] 起栈"
ssh "$REMOTE" "cd $REMOTE_DIR && sudo docker compose up -d && sudo docker compose ps"
rm -f /tmp/liquor-images.tgz
echo
echo "完成。访问: http://43.134.86.167  | 日志: ./deploy/deploy.sh logs"
