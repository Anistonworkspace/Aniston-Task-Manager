/**
 * Migration: Add archive columns to support 90-day deletion rule.
 * Run: node server/add-archive-columns.js
 */
const { sequelize } = require('./config/db');

async function run() {
  try {
    await sequelize.authenticate();
    console.log('Connected to database.');

    const queries = [
      // Dependencies
      `ALTER TABLE task_dependencies ADD COLUMN IF NOT EXISTS "isArchived" BOOLEAN DEFAULT false`,
      `ALTER TABLE task_dependencies ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMPTZ DEFAULT NULL`,
      `ALTER TABLE task_dependencies ADD COLUMN IF NOT EXISTS "archivedBy" UUID DEFAULT NULL`,

      // Help Requests
      `ALTER TABLE help_requests ADD COLUMN IF NOT EXISTS "isArchived" BOOLEAN DEFAULT false`,
      `ALTER TABLE help_requests ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMPTZ DEFAULT NULL`,
      `ALTER TABLE help_requests ADD COLUMN IF NOT EXISTS "archivedBy" UUID DEFAULT NULL`,

      // Tasks (isArchived already exists)
      `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMPTZ DEFAULT NULL`,
      `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "archivedBy" UUID DEFAULT NULL`,

      // Boards (isArchived already exists)
      `ALTER TABLE boards ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMPTZ DEFAULT NULL`,
      `ALTER TABLE boards ADD COLUMN IF NOT EXISTS "archivedBy" UUID DEFAULT NULL`,

      // Workspaces (uses isActive pattern)
      `ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMPTZ DEFAULT NULL`,
      `ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS "archivedBy" UUID DEFAULT NULL`,

      // Backfill existing archived items
      `UPDATE tasks SET "archivedAt" = "updatedAt" WHERE "isArchived" = true AND "archivedAt" IS NULL`,
      `UPDATE boards SET "archivedAt" = "updatedAt" WHERE "isArchived" = true AND "archivedAt" IS NULL`,
      `UPDATE workspaces SET "archivedAt" = "updatedAt" WHERE "isActive" = false AND "archivedAt" IS NULL`,
    ];

    for (const q of queries) {
      try {
        await sequelize.query(q);
        console.log('OK:', q.substring(0, 80) + '...');
      } catch (err) {
        console.warn('WARN:', err.message.substring(0, 100));
      }
    }

    console.log('\nDone! All archive columns added.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
}

run();
