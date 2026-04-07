#!/bin/bash
# ============================================================
# Deploy script - pushes code to EC2 and runs Docker Compose
# Usage: ./deploy-to-ec2.sh <EC2_IP> <KEY_FILE>
# ============================================================

set -e

EC2_IP=$1
KEY_FILE=$2

if [ -z "$EC2_IP" ] || [ -z "$KEY_FILE" ]; then
    echo "Usage: ./deploy-to-ec2.sh <EC2_PUBLIC_IP> <KEY_PEM_FILE>"
    echo "Example: ./deploy-to-ec2.sh 13.234.56.78 aniston-hub-key.pem"
    exit 1
fi

APP_DIR="/home/ec2-user/aniston-project-hub"
SSH_CMD="ssh -i $KEY_FILE -o StrictHostKeyChecking=no ec2-user@$EC2_IP"

echo "============================================"
echo "  Deploying to EC2: $EC2_IP"
echo "============================================"

echo ""
echo "[1/4] Syncing project files..."
rsync -avz --exclude 'node_modules' --exclude '.git' --exclude 'uploads/*' \
    -e "ssh -i $KEY_FILE -o StrictHostKeyChecking=no" \
    ../ ec2-user@$EC2_IP:$APP_DIR/

echo ""
echo "[2/4] Setting up environment..."
$SSH_CMD << 'REMOTE'
cd /home/ec2-user/aniston-project-hub
if [ ! -f server/.env ]; then
    cp server/.env.example server/.env
    echo ""
    echo "WARNING: server/.env was created from template."
    echo "You MUST edit it with your actual database credentials!"
    echo "Run: nano server/.env"
fi
REMOTE

echo ""
echo "[3/4] Building and starting containers..."
$SSH_CMD << 'REMOTE'
cd /home/ec2-user/aniston-project-hub/deploy
docker-compose down 2>/dev/null || true
docker-compose up -d --build
REMOTE

echo ""
echo "[4/4] Checking deployment status..."
sleep 5
$SSH_CMD << 'REMOTE'
cd /home/ec2-user/aniston-project-hub/deploy
docker-compose ps
echo ""
echo "Backend health check:"
curl -s http://localhost:5000/api/health || echo "Backend starting up..."
REMOTE

echo ""
echo "============================================"
echo "  Deployment Complete!"
echo "  App URL: http://$EC2_IP"
echo "============================================"
