const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const { sequelize } = require('./config/db');
require('./models');
const User = require('./models/User');

const seedAdmin = async () => {
  try {
    await sequelize.authenticate();
    console.log('[Seed] Database connected.');

    const existing = await User.findOne({ where: { email: 'admin@aniston.com' } });
    if (existing) {
      console.log('[Seed] Admin user already exists.');
      console.log('  Email:    admin@aniston.com');
      console.log('  Role:     admin');
      process.exit(0);
    }

    const admin = await User.create({
      name: 'Admin',
      email: 'admin@aniston.com',
      password: 'Admin@1234',
      role: 'admin',
      department: 'Management',
      isActive: true,
    });

    console.log('[Seed] Admin user created successfully!');
    console.log('  Email:    admin@aniston.com');
    console.log('  Password: Admin@1234');
    console.log('  Role:     admin');
    process.exit(0);
  } catch (err) {
    console.error('[Seed] Failed:', err.message);
    process.exit(1);
  }
};

seedAdmin();
