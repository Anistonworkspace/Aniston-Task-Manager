const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const { sequelize } = require('./config/db');
require('./models');
const User = require('./models/User');

const users = [
  {
    name: 'Super Admin',
    email: 'superadmin@anistonav.com',
    password: 'Anistonav@1234',
    role: 'admin',
    department: 'Management',
    isSuperAdmin: true,
    hierarchyLevel: 'ceo',
    designation: 'Super Administrator',
  },
];

const seedUsers = async () => {
  try {
    await sequelize.authenticate();
    console.log('[Seed] Database connected.\n');

    for (const u of users) {
      const existing = await User.findOne({ where: { email: u.email } });
      if (existing) {
        console.log(`[Seed] ${u.role.toUpperCase()} already exists: ${u.email}`);
        continue;
      }
      await User.create({ ...u, isActive: true, accountStatus: 'approved' });
      console.log(`[Seed] Created SUPER ADMIN:`);
      console.log(`  Email:    ${u.email}`);
      console.log(`  Password: ${u.password}`);
      console.log(`  Role:     ${u.role} (Super Admin)\n`);
    }

    console.log('[Seed] Done! Other employees should be synced from Microsoft Teams.');
    process.exit(0);
  } catch (err) {
    console.error('[Seed] Failed:', err.message);
    process.exit(1);
  }
};

seedUsers();
