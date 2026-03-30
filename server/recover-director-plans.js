/**
 * Director Plan Data Recovery Script
 *
 * Run on EC2 server:
 *   docker exec aph-backend node recover-director-plans.js
 *
 * OR via SSH:
 *   docker exec aph-backend node recover-director-plans.js --dry-run   (preview only)
 *   docker exec aph-backend node recover-director-plans.js --fix       (actually fix data)
 */

const { Sequelize, Op } = require('sequelize');

const DB_HOST = process.env.DB_HOST || 'postgres';
const DB_PORT = process.env.DB_PORT || 5432;
const DB_NAME = process.env.DB_NAME || 'aniston_project_hub';
const DB_USER = process.env.DB_USER || 'postgres';
const DB_PASSWORD = process.env.DB_PASSWORD || 'changeme';

const sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASSWORD, {
  host: DB_HOST, port: DB_PORT, dialect: 'postgres', logging: false,
});

const dryRun = !process.argv.includes('--fix');

async function main() {
  try {
    await sequelize.authenticate();
    console.log('Connected to database.\n');

    if (dryRun) {
      console.log('=== DRY RUN MODE (use --fix to apply changes) ===\n');
    } else {
      console.log('=== FIX MODE — will update database ===\n');
    }

    // 1. Find all director plans
    const [plans] = await sequelize.query(`
      SELECT id, date, "directorId", categories, "createdAt", "updatedAt"
      FROM director_plans
      ORDER BY "directorId", date DESC
    `);

    console.log(`Found ${plans.length} director plans total.\n`);

    // Group by directorId
    const byDirector = {};
    for (const p of plans) {
      if (!byDirector[p.directorId]) byDirector[p.directorId] = [];
      byDirector[p.directorId].push(p);
    }

    // Get director names
    const [directors] = await sequelize.query(`
      SELECT id, name, email FROM users WHERE id IN (${Object.keys(byDirector).map(id => `'${id}'`).join(',') || "'none'"})
    `);
    const dirMap = {};
    directors.forEach(d => { dirMap[d.id] = d; });

    for (const [dirId, dirPlans] of Object.entries(byDirector)) {
      const dir = dirMap[dirId] || { name: 'Unknown', email: '' };
      console.log(`\n══════════════════════════════════════`);
      console.log(`Director: ${dir.name} (${dir.email})`);
      console.log(`Plans: ${dirPlans.length}`);

      // Analyze each plan
      let bestPlanWithTasks = null;
      const emptyPlans = [];

      for (const p of dirPlans) {
        const cats = Array.isArray(p.categories) ? p.categories : [];
        const totalTasks = cats.reduce((sum, c) => sum + (c.tasks?.length || 0), 0);
        const taskTexts = cats.flatMap(c => (c.tasks || []).map(t => t.text || t.title || '(no text)'));

        if (totalTasks > 0) {
          console.log(`  ✅ ${p.date}: ${cats.length} categories, ${totalTasks} tasks`);
          taskTexts.forEach(t => console.log(`      - ${t}`));
          if (!bestPlanWithTasks) bestPlanWithTasks = p;
        } else {
          console.log(`  ❌ ${p.date}: ${cats.length} categories, 0 tasks (EMPTY)`);
          emptyPlans.push(p);
        }
      }

      // Recovery: if we have a plan with tasks, restore empty ones
      if (bestPlanWithTasks && emptyPlans.length > 0) {
        console.log(`\n  📋 Best plan with tasks: ${bestPlanWithTasks.date}`);
        console.log(`  🔧 Empty plans to recover: ${emptyPlans.length}`);

        if (!dryRun) {
          const sourceCategories = JSON.parse(JSON.stringify(bestPlanWithTasks.categories));
          // Reset done status
          sourceCategories.forEach(cat => {
            if (cat.tasks) cat.tasks.forEach(t => {
              t.done = false;
              if (t.subtasks) t.subtasks.forEach(s => { s.done = false; });
            });
          });

          for (const ep of emptyPlans) {
            await sequelize.query(
              `UPDATE director_plans SET categories = $1, "updatedAt" = NOW() WHERE id = $2`,
              { bind: [JSON.stringify(sourceCategories), ep.id] }
            );
            console.log(`  ✅ Recovered: ${ep.date}`);
          }
        } else {
          console.log(`  ⚠️  Would recover ${emptyPlans.length} plans from ${bestPlanWithTasks.date} (use --fix)`);
        }
      } else if (!bestPlanWithTasks) {
        console.log(`\n  ⚠️  No plan with tasks found for this director. Data may be lost.`);
      } else {
        console.log(`\n  ✅ All plans have tasks — no recovery needed.`);
      }
    }

    console.log('\n══════════════════════════════════════');
    console.log('Done.');
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await sequelize.close();
  }
}

main();
