/**
 * Phase 9: Schema additions for Task Planner & Work Management features
 * Run with: node scripts/phase9-schema.js
 */
const { sequelize } = require('../config/db');

async function runMigration() {
  const queries = [
    // Task columns for progress, archive, labels
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS progress INTEGER DEFAULT 0`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "isArchived" BOOLEAN DEFAULT false`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "labels" JSONB DEFAULT '[]'`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "customFields" JSONB DEFAULT '{}'`,

    // Board columns for custom column config and archive
    `ALTER TABLE boards ADD COLUMN IF NOT EXISTS "customColumns" JSONB DEFAULT '[]'`,
    `ALTER TABLE boards ADD COLUMN IF NOT EXISTS "isArchived" BOOLEAN DEFAULT false`,

    // User columns for hierarchy
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS "managerId" UUID DEFAULT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS "hierarchyLevel" VARCHAR(50) DEFAULT 'member'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS "title" VARCHAR(100) DEFAULT NULL`,

    // Labels table
    `CREATE TABLE IF NOT EXISTS labels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) NOT NULL,
      color VARCHAR(20) DEFAULT '#579bfc',
      "boardId" UUID REFERENCES boards(id) ON DELETE CASCADE,
      "createdBy" UUID REFERENCES users(id) ON DELETE SET NULL,
      "createdAt" TIMESTAMP DEFAULT NOW(),
      "updatedAt" TIMESTAMP DEFAULT NOW()
    )`,

    // Task-Label junction table
    `CREATE TABLE IF NOT EXISTS task_labels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "taskId" UUID REFERENCES tasks(id) ON DELETE CASCADE,
      "labelId" UUID REFERENCES labels(id) ON DELETE CASCADE,
      "createdAt" TIMESTAMP DEFAULT NOW(),
      "updatedAt" TIMESTAMP DEFAULT NOW(),
      UNIQUE("taskId", "labelId")
    )`,

    // Due date extensions table
    `CREATE TABLE IF NOT EXISTS due_date_extensions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "taskId" UUID REFERENCES tasks(id) ON DELETE CASCADE,
      "requestedBy" UUID REFERENCES users(id) ON DELETE SET NULL,
      "currentDueDate" DATE,
      "proposedDueDate" DATE NOT NULL,
      reason TEXT,
      status VARCHAR(20) DEFAULT 'pending',
      "reviewedBy" UUID REFERENCES users(id) ON DELETE SET NULL,
      "reviewedAt" TIMESTAMP,
      "reviewNote" TEXT,
      "suggestedDate" DATE,
      "createdAt" TIMESTAMP DEFAULT NOW(),
      "updatedAt" TIMESTAMP DEFAULT NOW()
    )`,

    // Help requests table
    `CREATE TABLE IF NOT EXISTS help_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "taskId" UUID REFERENCES tasks(id) ON DELETE CASCADE,
      "requestedBy" UUID REFERENCES users(id) ON DELETE SET NULL,
      "requestedTo" UUID REFERENCES users(id) ON DELETE SET NULL,
      description TEXT,
      urgency VARCHAR(20) DEFAULT 'medium',
      "preferredTime" TIMESTAMP,
      status VARCHAR(30) DEFAULT 'pending',
      "meetingLink" TEXT,
      "meetingScheduledAt" TIMESTAMP,
      "resolvedAt" TIMESTAMP,
      "createdAt" TIMESTAMP DEFAULT NOW(),
      "updatedAt" TIMESTAMP DEFAULT NOW()
    )`,

    // Promotion history table
    `CREATE TABLE IF NOT EXISTS promotion_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "userId" UUID REFERENCES users(id) ON DELETE CASCADE,
      "previousRole" VARCHAR(50),
      "newRole" VARCHAR(50),
      "previousTitle" VARCHAR(100),
      "newTitle" VARCHAR(100),
      "promotedBy" UUID REFERENCES users(id) ON DELETE SET NULL,
      notes TEXT,
      "effectiveDate" DATE DEFAULT CURRENT_DATE,
      "createdAt" TIMESTAMP DEFAULT NOW(),
      "updatedAt" TIMESTAMP DEFAULT NOW()
    )`,
  ];

  console.log('Running Phase 9 schema migration...');

  for (const query of queries) {
    try {
      await sequelize.query(query);
      const tableName = query.match(/(?:ALTER TABLE|CREATE TABLE IF NOT EXISTS)\s+(\w+)/)?.[1] || 'unknown';
      console.log(`  ✓ ${tableName}`);
    } catch (err) {
      if (err.message.includes('already exists') || err.message.includes('duplicate')) {
        console.log(`  - Skipped (already exists)`);
      } else {
        console.error(`  ✗ Error: ${err.message}`);
      }
    }
  }

  console.log('Phase 9 schema migration complete!');
  process.exit(0);
}

runMigration();
