/**
 * Migration — add permission_grants.effect column.
 *
 * Adds the `effect` column (grant | deny) to permission_grants so admins can
 * deny a permission for a specific user, overriding role defaults and grants.
 *
 * Existing rows are backfilled to 'grant' to preserve current behavior.
 *
 * Idempotent: safe to re-run.
 *
 * Run:
 *   node server/scripts/add-permission-effect.js
 *
 * Rollback:
 *   psql -U postgres -d aniston_project_hub -c "ALTER TABLE permission_grants DROP COLUMN IF EXISTS effect;"
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { sequelize } = require('../config/db');

(async () => {
  try {
    await sequelize.authenticate();
    console.log('[permission-effect-ddl] Connected.');

    // 1. Add column with default 'grant' so existing rows are valid.
    await sequelize.query(`
      ALTER TABLE "permission_grants"
      ADD COLUMN IF NOT EXISTS "effect" VARCHAR(10) NOT NULL DEFAULT 'grant';
    `);
    console.log('[permission-effect-ddl] Ensured effect column.');

    // 2. Add CHECK constraint to enforce allowlist (idempotent).
    const [constraintCheck] = await sequelize.query(`
      SELECT 1 FROM pg_constraint
      WHERE conname = 'permission_grants_effect_check';
    `);
    if (constraintCheck.length === 0) {
      await sequelize.query(`
        ALTER TABLE "permission_grants"
        ADD CONSTRAINT "permission_grants_effect_check"
        CHECK ("effect" IN ('grant', 'deny'));
      `);
      console.log('[permission-effect-ddl] Added CHECK constraint.');
    } else {
      console.log('[permission-effect-ddl] CHECK constraint already present.');
    }

    // 3. Backfill any NULLs (shouldn't exist but defensive).
    const [backfillResult] = await sequelize.query(`
      UPDATE "permission_grants" SET "effect" = 'grant' WHERE "effect" IS NULL;
    `);
    console.log('[permission-effect-ddl] Backfilled rows:', backfillResult?.rowCount ?? 0);

    // 4. Add indexes for fast deny lookups.
    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS "permission_grants_effect_idx"
      ON "permission_grants" ("effect");
    `);
    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS "permission_grants_user_resource_action_effect_idx"
      ON "permission_grants" ("userId", "resourceType", "action", "effect");
    `);
    console.log('[permission-effect-ddl] Ensured indexes.');

    // 5. Verify.
    const [verifyRows] = await sequelize.query(`
      SELECT effect, COUNT(*)::int AS count
      FROM "permission_grants"
      GROUP BY effect
      ORDER BY effect;
    `);
    console.log('[permission-effect-ddl] Row distribution by effect:', verifyRows);

    console.log('[permission-effect-ddl] Done.');
    process.exit(0);
  } catch (err) {
    console.error('[permission-effect-ddl] FAILED:', err.message);
    process.exit(1);
  }
})();
