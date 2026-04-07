/**
 * Production Migration Script
 * Run this ONCE on EC2 before deploying new SSO/Teams integration code.
 *
 * Usage: cd server && node migrate-production.js
 *
 * Safe to run multiple times — all operations use IF NOT EXISTS / IF EXISTS.
 */
require('dotenv').config();
const { sequelize } = require('./models');

async function migrate() {
  try {
    await sequelize.authenticate();
    console.log('✓ Database connected');

    // 1. Add authProvider column to users
    await sequelize.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS "authProvider" VARCHAR(20) DEFAULT 'local';
    `);
    console.log('✓ users.authProvider column ready');

    // 2. Add accountStatus column to users (if missing)
    await sequelize.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS "accountStatus" VARCHAR(20) DEFAULT 'approved';
    `);
    console.log('✓ users.accountStatus column ready');

    // 3. Add teamsUserId column to users (if missing)
    await sequelize.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS "teamsUserId" VARCHAR(255);
    `);
    console.log('✓ users.teamsUserId column ready');

    // 4. Add teamsAccessToken, teamsRefreshToken, teamsTokenExpiry (if missing)
    await sequelize.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS "teamsAccessToken" TEXT;
    `);
    await sequelize.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS "teamsRefreshToken" TEXT;
    `);
    await sequelize.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS "teamsTokenExpiry" TIMESTAMP WITH TIME ZONE;
    `);
    console.log('✓ users Teams token columns ready');

    // 5. Create integration_configs table (if missing)
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS integration_configs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider VARCHAR(50) NOT NULL UNIQUE,
        "clientId" TEXT,
        "clientSecret" TEXT,
        "tenantId" VARCHAR(255),
        "redirectUri" TEXT,
        "ssoRedirectUri" TEXT,
        "ssoEnabled" BOOLEAN DEFAULT false,
        "isActive" BOOLEAN DEFAULT true,
        "configuredBy" UUID,
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    console.log('✓ integration_configs table ready');

    // 6. Add customColumns to boards (if missing)
    await sequelize.query(`
      ALTER TABLE boards ADD COLUMN IF NOT EXISTS "customColumns" JSONB DEFAULT '[]';
    `);
    console.log('✓ boards.customColumns column ready');

    // 7. Set existing users without authProvider to 'local'
    await sequelize.query(`
      UPDATE users SET "authProvider" = 'local' WHERE "authProvider" IS NULL;
    `);
    console.log('✓ Existing users set to authProvider=local');

    console.log('\n✅ Migration complete! Safe to deploy.');
    process.exit(0);
  } catch (err) {
    console.error('✗ Migration failed:', err.message);
    process.exit(1);
  }
}

migrate();
