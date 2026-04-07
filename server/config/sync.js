const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { sequelize } = require('./db');
// Import all models so associations are registered before sync
require('../models');

const forceSync = process.argv.includes('--force');

const syncDatabase = async () => {
  try {
    await sequelize.authenticate();
    console.log('[Sync] Database connection verified.');

    if (forceSync) {
      console.log('[Sync] WARNING: Force sync enabled - all tables will be dropped and recreated.');
      await sequelize.sync({ force: true });
      console.log('[Sync] All tables dropped and recreated successfully.');
    } else {
      await sequelize.sync({ alter: true });
      console.log('[Sync] All tables synced successfully (alter mode).');
    }

    // List all tables after sync
    const [results] = await sequelize.query(
      "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public';"
    );
    console.log('[Sync] Tables in database:');
    results.forEach((row) => {
      console.log(`  - ${row.tablename}`);
    });

    process.exit(0);
  } catch (error) {
    console.error('[Sync] Failed to sync database:', error.message);
    console.error(error);
    process.exit(1);
  }
};

syncDatabase();
