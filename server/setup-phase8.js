/**
 * Phase 8: Database Setup Script
 * Creates new tables and adds columns for Workspace, Permissions, Access Requests,
 * Task Watchers, Announcements, Recurring Tasks, and Approval Workflow.
 *
 * Run: node setup-phase8.js
 */

require('dotenv').config();
const { sequelize } = require('./config/db');

async function run() {
  try {
    console.log('[Phase8] Connecting to database...');
    await sequelize.authenticate();
    console.log('[Phase8] Connected.\n');

    // ─── 1. Workspaces table ───────────────────────────────────
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(150) NOT NULL,
        description TEXT DEFAULT '',
        color VARCHAR(20) NOT NULL DEFAULT '#0073ea',
        icon VARCHAR(50) DEFAULT 'Briefcase',
        "isDefault" BOOLEAN DEFAULT false,
        "isActive" BOOLEAN DEFAULT true,
        "createdBy" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('[Phase8] ✓ workspaces table created');

    // ─── 2. Permission Grants table ────────────────────────────
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS permission_grants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "resourceType" VARCHAR(50) NOT NULL,
        "resourceId" UUID,
        "permissionLevel" VARCHAR(30) NOT NULL DEFAULT 'view',
        "grantedBy" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "expiresAt" TIMESTAMPTZ,
        "isActive" BOOLEAN DEFAULT true,
        notes TEXT,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('[Phase8] ✓ permission_grants table created');

    // Indexes for permission_grants
    await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_pg_user ON permission_grants("userId");`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_pg_resource ON permission_grants("resourceType", "resourceId");`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_pg_user_resource ON permission_grants("userId", "resourceType", "resourceId");`);
    console.log('[Phase8] ✓ permission_grants indexes created');

    // ─── 3. Access Requests table ──────────────────────────────
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS access_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "resourceType" VARCHAR(50) NOT NULL,
        "resourceId" UUID,
        "requestType" VARCHAR(30) NOT NULL DEFAULT 'view',
        reason TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        "reviewedBy" UUID REFERENCES users(id) ON DELETE SET NULL,
        "reviewedAt" TIMESTAMPTZ,
        "reviewNote" TEXT,
        "expiresAt" TIMESTAMPTZ,
        "isTemporary" BOOLEAN DEFAULT false,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('[Phase8] ✓ access_requests table created');

    await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_ar_user ON access_requests("userId");`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_ar_status ON access_requests(status);`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_ar_resource ON access_requests("resourceType", "resourceId");`);
    console.log('[Phase8] ✓ access_requests indexes created');

    // ─── 4. Task Watchers table ────────────────────────────────
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS task_watchers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "taskId" UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE("userId", "taskId")
      );
    `);
    console.log('[Phase8] ✓ task_watchers table created');

    await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_tw_user ON task_watchers("userId");`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_tw_task ON task_watchers("taskId");`);
    console.log('[Phase8] ✓ task_watchers indexes created');

    // ─── 5. Announcements table ────────────────────────────────
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS announcements (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(300) NOT NULL,
        content TEXT,
        type VARCHAR(30) NOT NULL DEFAULT 'info',
        "isPinned" BOOLEAN DEFAULT false,
        "isActive" BOOLEAN DEFAULT true,
        "workspaceId" UUID REFERENCES workspaces(id) ON DELETE SET NULL,
        "createdBy" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('[Phase8] ✓ announcements table created');

    // ─── 6. Add workspaceId to boards ──────────────────────────
    await sequelize.query(`
      ALTER TABLE boards ADD COLUMN IF NOT EXISTS "workspaceId" UUID REFERENCES workspaces(id) ON DELETE SET NULL;
    `);
    console.log('[Phase8] ✓ boards.workspaceId column added');

    // ─── 7. Add approval + recurrence columns to tasks ─────────
    await sequelize.query(`
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "approvalStatus" VARCHAR(30) DEFAULT NULL;
    `);
    await sequelize.query(`
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "approvalChain" JSONB DEFAULT '[]';
    `);
    await sequelize.query(`
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence JSONB DEFAULT NULL;
    `);
    await sequelize.query(`
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "lastRecurrenceAt" TIMESTAMPTZ DEFAULT NULL;
    `);
    await sequelize.query(`
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "escalationLevel" VARCHAR(20) DEFAULT NULL;
    `);
    console.log('[Phase8] ✓ tasks approval/recurrence/escalation columns added');

    // ─── 8. Add workspaceId to users (team mapping) ────────────
    await sequelize.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS "workspaceId" UUID REFERENCES workspaces(id) ON DELETE SET NULL;
    `);
    console.log('[Phase8] ✓ users.workspaceId column added');

    // ─── 9. Add managerId to users (manager-team mapping) ──────
    await sequelize.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS "managerId" UUID REFERENCES users(id) ON DELETE SET NULL;
    `);
    console.log('[Phase8] ✓ users.managerId column added');

    console.log('\n[Phase8] ✅ All Phase 8 database setup complete!');
    process.exit(0);
  } catch (err) {
    console.error('[Phase8] ❌ Setup failed:', err.message);
    console.error(err);
    process.exit(1);
  }
}

run();
