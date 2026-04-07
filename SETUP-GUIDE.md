# Aniston Project Hub - Setup & Deployment Guide

## Quick Start (Local Development)

### Prerequisites
- Node.js 20+
- Docker Desktop (for PostgreSQL)
- Git

### Step 1: Start PostgreSQL
```bash
cd deploy
docker-compose -f docker-compose.dev.yml up -d
```

### Step 2: Configure Environment
```bash
cp server/.env.example server/.env
```
Edit `server/.env`:
```
PORT=5000
NODE_ENV=development
DB_HOST=localhost
DB_PORT=5432
DB_NAME=aniston_project_hub
DB_USER=postgres
DB_PASSWORD=postgres
JWT_SECRET=your-secret-key-change-this
CLIENT_URL=http://localhost:3000
```

### Step 3: Install Dependencies
```bash
npm run install:all
```

### Step 4: Initialize Database
```bash
npm run db:sync
```

### Step 5: Start Development
```bash
npm run dev
```
- Frontend: http://localhost:3000
- Backend API: http://localhost:5000

---

## AWS Deployment (EC2 + RDS)

### Prerequisites
- AWS CLI installed and configured (`aws configure`)
- An AWS account with permissions for EC2, RDS, VPC

### Option A: Automated Setup
```bash
cd deploy
chmod +x aws-setup.sh
./aws-setup.sh
```
This creates: VPC, subnets, security groups, RDS PostgreSQL, EC2 instance.

### Option B: Manual AWS Setup

#### 1. Create RDS PostgreSQL
- Go to AWS RDS Console
- Create Database > PostgreSQL 16
- Instance: db.t3.micro (Free tier eligible)
- DB name: `aniston_project_hub`
- Set master username and password
- VPC: default or create new
- Security group: Allow port 5432 from EC2 SG

#### 2. Create EC2 Instance
- Amazon Linux 2023 / Ubuntu 22.04
- Instance type: t3.medium
- Security group: Allow ports 80, 443, 22
- Storage: 20GB gp3

#### 3. SSH and Setup EC2
```bash
ssh -i your-key.pem ec2-user@YOUR_EC2_IP

# Install Docker
sudo yum update -y
sudo yum install -y docker git
sudo systemctl start docker
sudo systemctl enable docker
sudo usermod -aG docker ec2-user

# Install Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Log out and back in for docker group
exit
ssh -i your-key.pem ec2-user@YOUR_EC2_IP
```

#### 4. Deploy the App
```bash
# Clone or upload your code
git clone YOUR_REPO_URL
cd aniston-project-hub

# Configure environment
cp server/.env.example server/.env
nano server/.env
```

Set in `.env`:
```
NODE_ENV=production
DB_HOST=your-rds-endpoint.region.rds.amazonaws.com
DB_PORT=5432
DB_NAME=aniston_project_hub
DB_USER=your_db_user
DB_PASSWORD=your_db_password
JWT_SECRET=a-strong-random-secret-at-least-32-chars
CLIENT_URL=http://YOUR_EC2_IP
```

```bash
# Build and start
cd deploy
docker-compose up -d --build

# Check status
docker-compose ps
docker-compose logs -f
```

#### 5. Access the App
Open `http://YOUR_EC2_IP` in your browser.

---

## Microsoft Teams Integration

### Setting Up Incoming Webhook

1. Open Microsoft Teams
2. Go to the channel where you want notifications
3. Click `...` > **Connectors** (or **Manage Channel** > **Connectors**)
4. Search for **Incoming Webhook**
5. Click **Configure**
6. Name it: "Aniston Project Hub"
7. Upload an icon (optional)
8. Click **Create**
9. Copy the webhook URL
10. Paste it in your `server/.env`:
```
TEAMS_WEBHOOK_URL=https://outlook.office.com/webhook/...
```

### What Gets Notified
- New task created
- Task status changed to "Done"
- Task assigned/reassigned
- New comment on a task

Each notification appears as a formatted card in your Teams channel with task details and a link to the app.

---

## Project Structure

```
aniston-project-hub/
├── client/                 # React Frontend (Vite)
│   ├── src/
│   │   ├── components/     # UI Components
│   │   │   ├── layout/     # Sidebar, Header, Layout
│   │   │   ├── board/      # Board view components
│   │   │   ├── task/       # Task modal, comments, files
│   │   │   ├── auth/       # Login, Register
│   │   │   ├── common/     # Modal, Avatar, Button, etc.
│   │   │   ├── dashboard/  # Dashboard widgets
│   │   │   └── timeline/   # Gantt timeline view
│   │   ├── context/        # Auth context
│   │   ├── hooks/          # Custom hooks (useSocket)
│   │   ├── services/       # API client, Socket.io
│   │   ├── pages/          # Page components
│   │   └── utils/          # Constants, helpers
│   └── package.json
├── server/                 # Express Backend
│   ├── config/             # DB config, sync
│   ├── controllers/        # Route handlers
│   ├── middleware/          # Auth, file upload
│   ├── models/             # Sequelize models
│   ├── routes/             # API routes
│   ├── services/           # Teams webhook, Socket.io
│   ├── uploads/            # File uploads directory
│   └── server.js           # Entry point
├── deploy/                 # Deployment configs
│   ├── docker-compose.yml
│   ├── Dockerfile.server
│   ├── Dockerfile.client
│   ├── nginx.conf
│   ├── aws-setup.sh
│   └── deploy-to-ec2.sh
└── package.json            # Root scripts
```

## API Endpoints

### Auth
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `GET /api/auth/profile` - Get current user
- `PUT /api/auth/profile` - Update profile
- `GET /api/auth/users` - List all users

### Boards
- `POST /api/boards` - Create board
- `GET /api/boards` - List boards
- `GET /api/boards/:id` - Get board with tasks
- `PUT /api/boards/:id` - Update board
- `DELETE /api/boards/:id` - Delete board
- `POST /api/boards/:id/members` - Add member
- `DELETE /api/boards/:id/members/:userId` - Remove member

### Tasks
- `POST /api/tasks` - Create task
- `GET /api/tasks` - List tasks (filterable)
- `GET /api/tasks/:id` - Get task
- `PUT /api/tasks/:id` - Update task
- `DELETE /api/tasks/:id` - Delete task
- `PUT /api/tasks/:id/move` - Move task (group/position)
- `PUT /api/tasks/bulk` - Bulk update

### Comments
- `POST /api/comments` - Add comment
- `GET /api/comments?taskId=` - Get comments
- `DELETE /api/comments/:id` - Delete comment

### Files
- `POST /api/files` - Upload file
- `GET /api/files?taskId=` - List files
- `DELETE /api/files/:id` - Delete file
- `GET /api/files/:id/download` - Download file

### Notifications
- `GET /api/notifications` - List notifications
- `GET /api/notifications/unread-count` - Unread count
- `PUT /api/notifications/:id/read` - Mark read
- `PUT /api/notifications/read-all` - Mark all read

## Default Admin Account
Register the first account and it will have `member` role. To make it admin, run:
```sql
UPDATE "Users" SET role = 'admin' WHERE email = 'your@email.com';
```
