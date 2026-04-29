/**
 * Phase 4 DDL — extend the notifications.type Postgres enum with the
 * approval-specific event types.
 *
 * Postgres 12+ supports ALTER TYPE ... ADD VALUE IF NOT EXISTS, which is
 * idempotent and safe to re-run. Project uses PG 16 so this is fine.
 *
 * Run:
 *   node server/scripts/add-approval-notification-types.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { sequelize } = require('../config/db');

const NEW_VALUES = [
  'approval_submitted',
  'approval_approved',
  'approval_rejected',
  'approval_changes_requested',
  'approval_completed',
];

(async () => {
  try {
    await sequelize.authenticate();
    console.log('[approval-enum-ddl] Connected.');

    // Sequelize names enum types `enum_<table>_<column>` by convention.
    const enumTypeName = 'enum_notifications_type';

    for (const v of NEW_VALUES) {
      // ADD VALUE cannot run inside a transaction in older PG; we rely on
      // Sequelize's default autocommit per query.
      await sequelize.query(`ALTER TYPE "${enumTypeName}" ADD VALUE IF NOT EXISTS '${v}';`);
      console.log(`[approval-enum-ddl] Ensured value: ${v}`);
    }

    // Verify by listing enum values.
    const [rows] = await sequelize.query(
      `SELECT unnest(enum_range(NULL::${enumTypeName}))::text AS value;`
    );
    const values = rows.map((r) => r.value);
    console.log('[approval-enum-ddl] Current values:', values.join(', '));

    const missing = NEW_VALUES.filter((v) => !values.includes(v));
    if (missing.length > 0) {
      throw new Error(`Failed to add enum values: ${missing.join(', ')}`);
    }

    console.log('[approval-enum-ddl] All approval enum values present.');
    process.exit(0);
  } catch (err) {
    console.error('[approval-enum-ddl] FAILED:', err.message);
    process.exit(1);
  }
})();
