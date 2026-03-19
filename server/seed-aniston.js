/**
 * Seed script for Aniston AV Company — Real organization hierarchy
 * Run: cd server && node seed-aniston.js
 */
const bcrypt = require('bcryptjs');
const { sequelize } = require('./config/db');

const DEFAULT_PASSWORD = 'Aniston@1234';

// ─── Departments ─────────────────────────────────────────────
const DEPARTMENTS = [
  { name: 'Management', description: 'Executive leadership', color: '#e2445c' },
  { name: 'IT / Admin', description: 'System administration & IT', color: '#6366f1' },
  { name: 'Sales', description: 'Sales & business development', color: '#0073ea' },
  { name: 'Project', description: 'Project management & execution', color: '#00c875' },
  { name: 'HR', description: 'Human resources', color: '#f59e0b' },
  { name: 'Research & Tender', description: 'Research, tenders & procurement', color: '#8b5cf6' },
  { name: 'Marketing', description: 'Marketing & branding', color: '#ec4899' },
  { name: 'CAD Design', description: 'CAD & technical design', color: '#14b8a6' },
  { name: 'Development', description: 'Software development', color: '#3b82f6' },
];

// ─── Users (in dependency order — directors first, then managers, then members) ─
const USERS = [
  // DIRECTOR (top level)
  {
    name: 'Nitin Jindal', email: 'jindal.nitin@anistonav.com',
    role: 'admin', hierarchyLevel: 'director', department: 'Management',
    designation: 'Director', title: 'Director',
    managerKey: null,
  },
  // ADMIN
  {
    name: 'Jatin', email: 'jatin@anistonav.com',
    role: 'admin', hierarchyLevel: 'senior_manager', department: 'IT / Admin',
    designation: 'System Administrator', title: 'System Administrator',
    managerKey: 'jindal.nitin@anistonav.com',
  },
  // GENERAL MANAGER
  {
    name: 'Muskan Rawat', email: 'rawat.muskan@anistonav.com',
    role: 'manager', hierarchyLevel: 'manager', department: 'Management',
    designation: 'General Manager', title: 'General Manager',
    managerKey: 'jindal.nitin@anistonav.com',
  },
  // SALES MANAGER
  {
    name: 'Mayank Saxena', email: 'saxena.mayank@anistonav.com',
    role: 'manager', hierarchyLevel: 'manager', department: 'Sales',
    designation: 'Sales Manager', title: 'Sales Manager',
    managerKey: 'jindal.nitin@anistonav.com',
  },
  // SALES MEMBERS
  {
    name: 'Sanjay Kumar', email: 'kumar.sanjay@anistonav.com',
    role: 'member', hierarchyLevel: 'member', department: 'Sales',
    designation: 'Sales Executive', title: 'Sales Executive',
    managerKey: 'saxena.mayank@anistonav.com',
  },
  {
    name: 'Ashok Kumar', email: 'ashok@anistonav.com',
    role: 'member', hierarchyLevel: 'member', department: 'Sales',
    designation: 'Sales Executive', title: 'Sales Executive',
    managerKey: 'saxena.mayank@anistonav.com',
  },
  // PROJECT TEAM LEAD
  {
    name: 'Avdesh', email: 'avdhesh@anistonav.com',
    role: 'manager', hierarchyLevel: 'team_lead', department: 'Project',
    designation: 'Project Lead', title: 'Project Lead',
    managerKey: 'jindal.nitin@anistonav.com',
  },
  // PROJECT MEMBER
  {
    name: 'Lalit Rawat', email: 'rawat.lalit@anistonav.com',
    role: 'member', hierarchyLevel: 'member', department: 'Project',
    designation: 'Project Executive', title: 'Project Executive',
    managerKey: 'avdhesh@anistonav.com',
  },
  // HR
  {
    name: 'Jyoti Bhayana', email: 'bhayana.jyoti@anistonav.com',
    role: 'member', hierarchyLevel: 'team_lead', department: 'HR',
    designation: 'HR Manager', title: 'HR Manager',
    managerKey: 'jindal.nitin@anistonav.com',
  },
  // RESEARCH & TENDER LEAD
  {
    name: 'Monika Demrot', email: 'demrot.monika@anistonav.com',
    role: 'manager', hierarchyLevel: 'team_lead', department: 'Research & Tender',
    designation: 'Research & Tender Lead', title: 'Research & Tender Lead',
    managerKey: 'jindal.nitin@anistonav.com',
  },
  // RESEARCH & TENDER MEMBER
  {
    name: 'Durgesh Raghav', email: 'durgesh.raghav@anistonav.com',
    role: 'member', hierarchyLevel: 'member', department: 'Research & Tender',
    designation: 'Tender Specialist', title: 'Tender Specialist',
    managerKey: 'demrot.monika@anistonav.com',
  },
  // MARKETING
  {
    name: 'Mehak Juneja', email: 'juneja.mehak@anistonav.com',
    role: 'member', hierarchyLevel: 'member', department: 'Marketing',
    designation: 'Marketing Executive', title: 'Marketing Executive',
    managerKey: 'jindal.nitin@anistonav.com',
  },
  {
    name: 'Harsh', email: 'harsh@anistonav.com',
    role: 'member', hierarchyLevel: 'member', department: 'Marketing',
    designation: 'Graphic Designer', title: 'Graphic Designer',
    managerKey: 'jindal.nitin@anistonav.com',
  },
  // CAD DESIGN
  {
    name: 'Himanshu Sharma', email: 'sharma.himanshu@anistonav.com',
    role: 'member', hierarchyLevel: 'member', department: 'CAD Design',
    designation: 'CAD Designer', title: 'CAD Designer',
    managerKey: 'jindal.nitin@anistonav.com',
  },
  // DEVELOPMENT
  {
    name: 'Shubhanshu Saadhiyaan', email: 'shubhanshu@anistonav.com',
    role: 'member', hierarchyLevel: 'member', department: 'Development',
    designation: 'Full Stack Developer', title: 'Full Stack Developer',
    managerKey: 'jindal.nitin@anistonav.com',
  },
  {
    name: 'Khushi Chadha', email: 'khushi.chadha@anistonav.com',
    role: 'member', hierarchyLevel: 'member', department: 'Development',
    designation: 'AI/ML Engineer', title: 'AI/ML Engineer',
    managerKey: 'jindal.nitin@anistonav.com',
  },
];

async function seed() {
  try {
    await sequelize.authenticate();
    console.log('[Seed] Connected to database.\n');

    const hashedPassword = await bcrypt.hash(DEFAULT_PASSWORD, 10);

    // ─── Step 1: Create Departments ─────────────────────────
    console.log('═══ Creating Departments ═══');
    const departmentIds = {};
    for (const dept of DEPARTMENTS) {
      const [existing] = await sequelize.query(
        `SELECT id FROM departments WHERE name = $1 LIMIT 1`,
        { bind: [dept.name] }
      );
      if (existing.length > 0) {
        departmentIds[dept.name] = existing[0].id;
        console.log(`  ✓ ${dept.name} (exists)`);
      } else {
        const [created] = await sequelize.query(
          `INSERT INTO departments (id, name, description, color, "isActive", "createdAt", "updatedAt")
           VALUES (gen_random_uuid(), $1, $2, $3, true, NOW(), NOW()) RETURNING id`,
          { bind: [dept.name, dept.description, dept.color] }
        );
        departmentIds[dept.name] = created[0].id;
        console.log(`  + ${dept.name} (created)`);
      }
    }

    // ─── Step 2: Create Users ────────────────────────────────
    console.log('\n═══ Creating Users ═══');
    const userIds = {};

    for (const u of USERS) {
      // Check if exists
      const [existing] = await sequelize.query(
        `SELECT id FROM users WHERE email = $1 LIMIT 1`,
        { bind: [u.email] }
      );

      if (existing.length > 0) {
        userIds[u.email] = existing[0].id;
        // Update existing user with correct hierarchy info
        await sequelize.query(
          `UPDATE users SET
            name = $1, role = $2, "hierarchyLevel" = $3, department = $4,
            designation = $5, title = $6, "departmentId" = $7, "isActive" = true,
            "updatedAt" = NOW()
           WHERE email = $8`,
          { bind: [u.name, u.role, u.hierarchyLevel, u.department, u.designation, u.title, departmentIds[u.department] || null, u.email] }
        );
        console.log(`  ✓ ${u.name} <${u.email}> (updated)`);
      } else {
        const [created] = await sequelize.query(
          `INSERT INTO users (id, name, email, password, role, "hierarchyLevel", department, designation, title, "departmentId", "isActive", "createdAt", "updatedAt")
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, true, NOW(), NOW()) RETURNING id`,
          { bind: [u.name, u.email, hashedPassword, u.role, u.hierarchyLevel, u.department, u.designation, u.title, departmentIds[u.department] || null] }
        );
        userIds[u.email] = created[0].id;
        console.log(`  + ${u.name} <${u.email}> (created)`);
      }
    }

    // ─── Step 3: Set Manager Relationships ────────────────────
    console.log('\n═══ Setting Manager Hierarchy ═══');
    for (const u of USERS) {
      if (u.managerKey && userIds[u.managerKey]) {
        await sequelize.query(
          `UPDATE users SET "managerId" = $1, "updatedAt" = NOW() WHERE email = $2`,
          { bind: [userIds[u.managerKey], u.email] }
        );
        const managerName = USERS.find(x => x.email === u.managerKey)?.name || u.managerKey;
        console.log(`  ${u.name} → reports to → ${managerName}`);
      } else if (!u.managerKey) {
        await sequelize.query(
          `UPDATE users SET "managerId" = NULL, "updatedAt" = NOW() WHERE email = $1`,
          { bind: [u.email] }
        );
        console.log(`  ${u.name} → TOP LEVEL (no manager)`);
      }
    }

    // ─── Summary ─────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════');
    console.log('  Aniston AV Company Seed Complete!');
    console.log('═══════════════════════════════════════');
    console.log(`  Departments: ${DEPARTMENTS.length}`);
    console.log(`  Users: ${USERS.length}`);
    console.log(`  Default password: ${DEFAULT_PASSWORD}`);
    console.log('');
    console.log('  Login accounts:');
    console.log('  ─────────────────────────────────────');
    for (const u of USERS) {
      console.log(`  ${u.email} / ${DEFAULT_PASSWORD} (${u.role}/${u.hierarchyLevel})`);
    }
    console.log('');

    process.exit(0);
  } catch (err) {
    console.error('[Seed] Error:', err);
    process.exit(1);
  }
}

seed();
