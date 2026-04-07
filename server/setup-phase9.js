/**
 * Phase 9: Monday.com Parity — Database Setup
 * New tables: labels, task_labels, due_date_extensions, help_requests, promotion_history
 * New columns on tasks: progress, labels (JSONB backup)
 * New columns on users: title, level, promotedAt
 * New columns on boards: customStatuses (JSONB)
 *
 * Run: node setup-phase9.js
 */

require('dotenv').config();
const { sequelize } = require('./config/db');

async function run() {
  try {
    console.log('[Phase9] Connecting to database...');
    await sequelize.authenticate();
    console.log('[Phase9] Connected.\n');

    // ─── 1. Labels table ─────────────────────────────────────────
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS labels (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL,
        color VARCHAR(20) NOT NULL DEFAULT '#579bfc',
        "boardId" UUID REFERENCES boards(id) ON DELETE CASCADE,
        "createdBy" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('[Phase9] ✓ labels table created');

    // ─── 2. Task-Labels junction table ───────────────────────────
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS task_labels (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "taskId" UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        "labelId" UUID NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE("taskId", "labelId")
      );
    `);
    console.log('[Phase9] ✓ task_labels table created');

    // ─── 3. Due Date Extension Requests ──────────────────────────
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS due_date_extensions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "taskId" UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        "requestedBy" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "currentDueDate" DATE,
        "proposedDueDate" DATE NOT NULL,
        reason TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        "reviewedBy" UUID REFERENCES users(id) ON DELETE SET NULL,
        "reviewedAt" TIMESTAMPTZ,
        "reviewNote" TEXT,
        "suggestedDate" DATE,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('[Phase9] ✓ due_date_extensions table created');

    // ─── 4. Help Requests ────────────────────────────────────────
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS help_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "taskId" UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        "requestedBy" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "requestedTo" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        description TEXT NOT NULL,
        urgency VARCHAR(20) NOT NULL DEFAULT 'medium',
        "preferredTime" VARCHAR(100),
        status VARCHAR(30) NOT NULL DEFAULT 'pending',
        "meetingLink" TEXT,
        "meetingScheduledAt" TIMESTAMPTZ,
        "resolvedAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('[Phase9] ✓ help_requests table created');

    // ─── 5. Promotion History ────────────────────────────────────
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS promotion_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "previousRole" VARCHAR(50),
        "newRole" VARCHAR(50) NOT NULL,
        "previousTitle" VARCHAR(100),
        "newTitle" VARCHAR(100),
        "promotedBy" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        notes TEXT,
        "effectiveDate" DATE NOT NULL DEFAULT CURRENT_DATE,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('[Phase9] ✓ promotion_history table created');

    // ─── 6. Task progress column ─────────────────────────────────
    await sequelize.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS progress INTEGER DEFAULT 0;`);
    console.log('[Phase9] ✓ tasks.progress column added');

    // ─── 7. Board custom statuses ────────────────────────────────
    await sequelize.query(`ALTER TABLE boards ADD COLUMN IF NOT EXISTS "customStatuses" JSONB DEFAULT NULL;`);
    console.log('[Phase9] ✓ boards.customStatuses column added');

    // ─── 8. User title and level ─────────────────────────────────
    await sequelize.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS title VARCHAR(100) DEFAULT NULL;`);
    await sequelize.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS level INTEGER DEFAULT 0;`);
    await sequelize.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS "promotedAt" TIMESTAMPTZ DEFAULT NULL;`);
    console.log('[Phase9] ✓ users.title, level, promotedAt columns added');

    // ─── 9. Indexes ──────────────────────────────────────────────
    await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_labels_board ON labels("boardId");`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_task_labels_task ON task_labels("taskId");`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_task_labels_label ON task_labels("labelId");`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_dde_task ON due_date_extensions("taskId");`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_dde_status ON due_date_extensions(status);`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_hr_task ON help_requests("taskId");`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_hr_to ON help_requests("requestedTo");`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_hr_status ON help_requests(status);`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_promo_user ON promotion_history("userId");`);
    console.log('[Phase9] ✓ All indexes created');

    console.log('\n[Phase9] ✅ All Phase 9 database setup complete!');
    process.exit(0);
  } catch (err) {
    console.error('[Phase9] ❌ Setup failed:', err.message);
    console.error(err);
    process.exit(1);
  }
}

run();
