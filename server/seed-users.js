const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const { sequelize } = require('./config/db');
require('./models');
const User = require('./models/User');

const users = [
  {
    name: 'Super Admin',
    email: 'superadmin@aniston.com',
    password: 'SuperAdmin@1234',
    role: 'admin',
    department: 'Management',
    isSuperAdmin: true,
    hierarchyLevel: 'ceo',
  },
  {
    name: 'Admin',
    email: 'admin@aniston.com',
    password: 'Admin@1234',
    role: 'admin',
    department: 'Management',
    hierarchyLevel: 'director',
  },
  {
    name: 'Assistant Manager',
    email: 'pa@aniston.com',
    password: 'PA@1234',
    role: 'assistant_manager',
    department: 'Operations',
    hierarchyLevel: 'manager',
    designation: 'Personal Assistant',
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
      await User.create({ ...u, isActive: true });
      console.log(`[Seed] Created ${u.isSuperAdmin ? 'SUPER ADMIN' : u.role.toUpperCase()}:`);
      console.log(`  Email:    ${u.email}`);
      console.log(`  Password: ${u.password}`);
      console.log(`  Role:     ${u.role}${u.isSuperAdmin ? ' (Super Admin)' : ''}\n`);
    }

    console.log('[Seed] All users seeded successfully!');
    process.exit(0);
  } catch (err) {
    console.error('[Seed] Failed:', err.message);
    process.exit(1);
  }
};

seedUsers();
