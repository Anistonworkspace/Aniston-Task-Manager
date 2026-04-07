#!/usr/bin/env node
/**
 * Version Bump Script
 * Bumps version across root, server, and client package.json files.
 *
 * Usage:
 *   node scripts/version-bump.js patch    # 1.0.0 → 1.0.1
 *   node scripts/version-bump.js minor    # 1.0.0 → 1.1.0
 *   node scripts/version-bump.js major    # 1.0.0 → 2.0.0
 *   node scripts/version-bump.js 1.2.3    # Set exact version
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FILES = [
  path.join(ROOT, 'package.json'),
  path.join(ROOT, 'server', 'package.json'),
  path.join(ROOT, 'client', 'package.json'),
];

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node scripts/version-bump.js <patch|minor|major|x.y.z>');
  process.exit(1);
}

// Read current version from root
const rootPkg = JSON.parse(fs.readFileSync(FILES[0], 'utf8'));
const current = rootPkg.version || '1.0.0';
const [major, minor, patch] = current.split('.').map(Number);

let newVersion;
if (arg === 'patch') newVersion = `${major}.${minor}.${patch + 1}`;
else if (arg === 'minor') newVersion = `${major}.${minor + 1}.0`;
else if (arg === 'major') newVersion = `${major + 1}.0.0`;
else if (/^\d+\.\d+\.\d+$/.test(arg)) newVersion = arg;
else { console.error(`Invalid version: ${arg}`); process.exit(1); }

console.log(`\nBumping version: ${current} → ${newVersion}\n`);

// Update all package.json files
for (const file of FILES) {
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.version = newVersion;
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`  Updated: ${path.relative(ROOT, file)}`);
}

// Git tag
try {
  execSync(`git add -A`, { cwd: ROOT });
  execSync(`git commit -m "chore: bump version to v${newVersion}"`, { cwd: ROOT });
  execSync(`git tag v${newVersion}`, { cwd: ROOT });
  console.log(`\n  Git commit + tag: v${newVersion}`);
  console.log(`  Push with: git push origin main --tags\n`);
} catch (e) {
  console.log(`\n  Files updated. Commit manually:\n  git add -A && git commit -m "chore: bump version to v${newVersion}" && git tag v${newVersion}\n`);
}
