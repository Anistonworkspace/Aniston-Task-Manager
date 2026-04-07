const { sequelize } = require('./config/db');

const DEFAULT_LEVELS = [
  { name: 'intern', label: 'Intern', order: 0, color: '#94a3b8', icon: 'GraduationCap' },
  { name: 'member', label: 'Team Member', order: 1, color: '#00c875', icon: 'User' },
  { name: 'team_lead', label: 'Team Lead', order: 2, color: '#0ea5e9', icon: 'UserCheck' },
  { name: 'manager', label: 'Manager', order: 3, color: '#0073ea', icon: 'Shield' },
  { name: 'senior_manager', label: 'Senior Manager', order: 4, color: '#8b5cf6', icon: 'ShieldCheck' },
  { name: 'director', label: 'Director', order: 5, color: '#f59e0b', icon: 'Star' },
  { name: 'vp', label: 'Vice President', order: 6, color: '#ef4444', icon: 'Award' },
  { name: 'ceo', label: 'CEO', order: 7, color: '#e2445c', icon: 'Crown' },
];

async function seed() {
  try {
    await sequelize.authenticate();
    console.log('[Seed] Connected to database.');

    // Create table
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS hierarchy_levels (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL UNIQUE,
        label VARCHAR(100) NOT NULL,
        "order" INTEGER NOT NULL DEFAULT 0,
        color VARCHAR(20) DEFAULT '#6366f1',
        icon VARCHAR(50) DEFAULT 'User',
        description TEXT,
        "isActive" BOOLEAN DEFAULT true,
        "createdAt" TIMESTAMP DEFAULT NOW(),
        "updatedAt" TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('[Seed] hierarchy_levels table ensured.');

    // Insert defaults (skip if already exist)
    for (const level of DEFAULT_LEVELS) {
      const [existing] = await sequelize.query(
        `SELECT id FROM hierarchy_levels WHERE name = '${level.name}' LIMIT 1`
      );
      if (existing.length === 0) {
        await sequelize.query(`
          INSERT INTO hierarchy_levels (id, name, label, "order", color, icon, "isActive", "createdAt", "updatedAt")
          VALUES (gen_random_uuid(), '${level.name}', '${level.label}', ${level.order}, '${level.color}', '${level.icon}', true, NOW(), NOW())
        `);
        console.log(`[Seed] Created level: ${level.label}`);
      } else {
        console.log(`[Seed] Level already exists: ${level.label}`);
      }
    }

    // Update seed users' hierarchyLevel if they don't have one set
    await sequelize.query(`UPDATE users SET "hierarchyLevel" = 'ceo' WHERE role = 'admin' AND ("hierarchyLevel" IS NULL OR "hierarchyLevel" = 'member')`);
    await sequelize.query(`UPDATE users SET "hierarchyLevel" = 'manager' WHERE role = 'manager' AND ("hierarchyLevel" IS NULL OR "hierarchyLevel" = 'member')`);
    console.log('[Seed] Updated user hierarchy levels.');

    console.log('[Seed] Done!');
    process.exit(0);
  } catch (err) {
    console.error('[Seed] Error:', err.message);
    process.exit(1);
  }
}

seed();
