#!/bin/bash
# ============================================================
# AWS Deployment Setup Script for Aniston Project Hub
# Deploys: EC2 (backend + frontend) + RDS (PostgreSQL)
# ============================================================

set -e

# --- Configuration (modify these) ---
AWS_REGION="ap-south-1"
APP_NAME="aniston-project-hub"
EC2_INSTANCE_TYPE="t3.medium"
RDS_INSTANCE_TYPE="db.t3.micro"
KEY_PAIR_NAME="aniston-hub-key"
DB_NAME="aniston_project_hub"
DB_USER="aniston_admin"
DB_PASSWORD=""  # Will prompt if empty

echo "============================================"
echo "  Aniston Project Hub - AWS Setup"
echo "============================================"

# Prompt for DB password if not set
if [ -z "$DB_PASSWORD" ]; then
    read -sp "Enter database password: " DB_PASSWORD
    echo
fi

# Check AWS CLI
if ! command -v aws &> /dev/null; then
    echo "ERROR: AWS CLI is not installed. Install it first:"
    echo "  https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
    exit 1
fi

echo ""
echo "[1/7] Creating VPC and networking..."
# Create VPC
VPC_ID=$(aws ec2 create-vpc \
    --cidr-block 10.0.0.0/16 \
    --tag-specifications "ResourceType=vpc,Tags=[{Key=Name,Value=${APP_NAME}-vpc}]" \
    --region $AWS_REGION \
    --query 'Vpc.VpcId' --output text)
echo "  VPC: $VPC_ID"

# Enable DNS
aws ec2 modify-vpc-attribute --vpc-id $VPC_ID --enable-dns-support --region $AWS_REGION
aws ec2 modify-vpc-attribute --vpc-id $VPC_ID --enable-dns-hostnames --region $AWS_REGION

# Create subnets (2 AZs for RDS)
SUBNET1_ID=$(aws ec2 create-subnet \
    --vpc-id $VPC_ID --cidr-block 10.0.1.0/24 \
    --availability-zone ${AWS_REGION}a \
    --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=${APP_NAME}-public-1}]" \
    --region $AWS_REGION --query 'Subnet.SubnetId' --output text)

SUBNET2_ID=$(aws ec2 create-subnet \
    --vpc-id $VPC_ID --cidr-block 10.0.2.0/24 \
    --availability-zone ${AWS_REGION}b \
    --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=${APP_NAME}-public-2}]" \
    --region $AWS_REGION --query 'Subnet.SubnetId' --output text)
echo "  Subnets: $SUBNET1_ID, $SUBNET2_ID"

# Internet Gateway
IGW_ID=$(aws ec2 create-internet-gateway \
    --tag-specifications "ResourceType=internet-gateway,Tags=[{Key=Name,Value=${APP_NAME}-igw}]" \
    --region $AWS_REGION --query 'InternetGateway.InternetGatewayId' --output text)
aws ec2 attach-internet-gateway --vpc-id $VPC_ID --internet-gateway-id $IGW_ID --region $AWS_REGION

# Route table
RT_ID=$(aws ec2 describe-route-tables \
    --filters "Name=vpc-id,Values=$VPC_ID" \
    --region $AWS_REGION --query 'RouteTables[0].RouteTableId' --output text)
aws ec2 create-route --route-table-id $RT_ID --destination-cidr-block 0.0.0.0/0 \
    --gateway-id $IGW_ID --region $AWS_REGION > /dev/null
aws ec2 associate-route-table --route-table-id $RT_ID --subnet-id $SUBNET1_ID --region $AWS_REGION > /dev/null
aws ec2 associate-route-table --route-table-id $RT_ID --subnet-id $SUBNET2_ID --region $AWS_REGION > /dev/null
echo "  IGW + Routes configured"

echo ""
echo "[2/7] Creating Security Groups..."
# EC2 Security Group
EC2_SG_ID=$(aws ec2 create-security-group \
    --group-name "${APP_NAME}-ec2-sg" \
    --description "EC2 security group for ${APP_NAME}" \
    --vpc-id $VPC_ID --region $AWS_REGION \
    --query 'GroupId' --output text)

# Allow HTTP, HTTPS, SSH
aws ec2 authorize-security-group-ingress --group-id $EC2_SG_ID --protocol tcp --port 80 --cidr 0.0.0.0/0 --region $AWS_REGION > /dev/null
aws ec2 authorize-security-group-ingress --group-id $EC2_SG_ID --protocol tcp --port 443 --cidr 0.0.0.0/0 --region $AWS_REGION > /dev/null
aws ec2 authorize-security-group-ingress --group-id $EC2_SG_ID --protocol tcp --port 22 --cidr 0.0.0.0/0 --region $AWS_REGION > /dev/null
echo "  EC2 SG: $EC2_SG_ID"

# RDS Security Group
RDS_SG_ID=$(aws ec2 create-security-group \
    --group-name "${APP_NAME}-rds-sg" \
    --description "RDS security group for ${APP_NAME}" \
    --vpc-id $VPC_ID --region $AWS_REGION \
    --query 'GroupId' --output text)

aws ec2 authorize-security-group-ingress --group-id $RDS_SG_ID --protocol tcp --port 5432 \
    --source-group $EC2_SG_ID --region $AWS_REGION > /dev/null
echo "  RDS SG: $RDS_SG_ID"

echo ""
echo "[3/7] Creating RDS PostgreSQL instance..."
# RDS Subnet Group
aws rds create-db-subnet-group \
    --db-subnet-group-name "${APP_NAME}-db-subnet" \
    --db-subnet-group-description "DB subnet group for ${APP_NAME}" \
    --subnet-ids $SUBNET1_ID $SUBNET2_ID \
    --region $AWS_REGION > /dev/null

# Create RDS instance
aws rds create-db-instance \
    --db-instance-identifier "${APP_NAME}-db" \
    --db-instance-class $RDS_INSTANCE_TYPE \
    --engine postgres \
    --engine-version "16.1" \
    --allocated-storage 20 \
    --db-name $DB_NAME \
    --master-username $DB_USER \
    --master-user-password $DB_PASSWORD \
    --vpc-security-group-ids $RDS_SG_ID \
    --db-subnet-group-name "${APP_NAME}-db-subnet" \
    --backup-retention-period 7 \
    --no-publicly-accessible \
    --storage-type gp3 \
    --region $AWS_REGION > /dev/null
echo "  RDS instance creating (takes 5-10 minutes)..."

echo ""
echo "[4/7] Creating EC2 Key Pair..."
aws ec2 create-key-pair \
    --key-name $KEY_PAIR_NAME \
    --region $AWS_REGION \
    --query 'KeyMaterial' --output text > ${KEY_PAIR_NAME}.pem
chmod 400 ${KEY_PAIR_NAME}.pem
echo "  Key saved: ${KEY_PAIR_NAME}.pem"

echo ""
echo "[5/7] Launching EC2 instance..."
# Get latest Amazon Linux 2023 AMI
AMI_ID=$(aws ec2 describe-images \
    --owners amazon \
    --filters "Name=name,Values=al2023-ami-2023*-x86_64" "Name=state,Values=available" \
    --query 'sort_by(Images, &CreationDate)[-1].ImageId' \
    --region $AWS_REGION --output text)

# User data script to set up the instance
USER_DATA=$(cat << 'USERDATA'
#!/bin/bash
yum update -y
yum install -y docker git
systemctl start docker
systemctl enable docker
usermod -aG docker ec2-user

# Install Docker Compose
curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose

# Install Node.js 20
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
yum install -y nodejs

echo "Setup complete!" > /home/ec2-user/setup-done.txt
USERDATA
)

EC2_ID=$(aws ec2 run-instances \
    --image-id $AMI_ID \
    --instance-type $EC2_INSTANCE_TYPE \
    --key-name $KEY_PAIR_NAME \
    --security-group-ids $EC2_SG_ID \
    --subnet-id $SUBNET1_ID \
    --associate-public-ip-address \
    --user-data "$USER_DATA" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${APP_NAME}-server}]" \
    --region $AWS_REGION \
    --query 'Instances[0].InstanceId' --output text)
echo "  EC2 Instance: $EC2_ID"

echo ""
echo "[6/7] Waiting for resources..."
echo "  Waiting for EC2 to be running..."
aws ec2 wait instance-running --instance-ids $EC2_ID --region $AWS_REGION

EC2_PUBLIC_IP=$(aws ec2 describe-instances \
    --instance-ids $EC2_ID \
    --region $AWS_REGION \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "  EC2 Public IP: $EC2_PUBLIC_IP"

echo ""
echo "[7/7] Waiting for RDS to be available..."
aws rds wait db-instance-available --db-instance-identifier "${APP_NAME}-db" --region $AWS_REGION

RDS_ENDPOINT=$(aws rds describe-db-instances \
    --db-instance-identifier "${APP_NAME}-db" \
    --region $AWS_REGION \
    --query 'DBInstances[0].Endpoint.Address' --output text)
echo "  RDS Endpoint: $RDS_ENDPOINT"

echo ""
echo "============================================"
echo "  SETUP COMPLETE!"
echo "============================================"
echo ""
echo "  EC2 Public IP:  $EC2_PUBLIC_IP"
echo "  RDS Endpoint:   $RDS_ENDPOINT"
echo "  SSH Key:        ${KEY_PAIR_NAME}.pem"
echo ""
echo "  Next Steps:"
echo "  1. SSH into EC2:"
echo "     ssh -i ${KEY_PAIR_NAME}.pem ec2-user@${EC2_PUBLIC_IP}"
echo ""
echo "  2. Clone your repo and create .env file:"
echo "     git clone <your-repo-url>"
echo "     cd aniston-project-hub"
echo "     cp server/.env.example server/.env"
echo "     # Edit .env with these values:"
echo "     #   DB_HOST=$RDS_ENDPOINT"
echo "     #   DB_USER=$DB_USER"
echo "     #   DB_PASSWORD=<your-password>"
echo "     #   DB_NAME=$DB_NAME"
echo ""
echo "  3. Deploy with Docker Compose:"
echo "     cd deploy"
echo "     docker-compose up -d --build"
echo ""
echo "  4. Access the app at: http://${EC2_PUBLIC_IP}"
echo "============================================"

# Save config
cat > aws-config.txt << EOF
APP_NAME=$APP_NAME
AWS_REGION=$AWS_REGION
VPC_ID=$VPC_ID
EC2_ID=$EC2_ID
EC2_PUBLIC_IP=$EC2_PUBLIC_IP
EC2_SG_ID=$EC2_SG_ID
RDS_ENDPOINT=$RDS_ENDPOINT
RDS_SG_ID=$RDS_SG_ID
SUBNET1_ID=$SUBNET1_ID
SUBNET2_ID=$SUBNET2_ID
IGW_ID=$IGW_ID
KEY_PAIR_NAME=$KEY_PAIR_NAME
DB_NAME=$DB_NAME
DB_USER=$DB_USER
EOF
echo "AWS resource IDs saved to aws-config.txt"
