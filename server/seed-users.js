const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const { sequelize } = require('./config/db');
require('./models');
const User = require('./models/User');

// ─── Production safety ─────────────────────────────────────────────────────
//
// This script creates the bootstrap Tier-1 (super admin) account. It must
// NEVER run with hardcoded credentials in a non-development environment, and
// must NEVER ship a hardcoded production password — both are P0 security
// risks (audit P1-12, May 2026).
//
// Allowed environments: NODE_ENV === 'development' OR 'test', OR a one-off
// production bootstrap when `ALLOW_SEED_IN_PRODUCTION=true` AND
// `SEED_SUPERADMIN_PASSWORD` is supplied. Any other invocation aborts.
//
// Required environment variables when bootstrapping production:
//   SEED_SUPERADMIN_EMAIL     — the email for the bootstrap super admin
//   SEED_SUPERADMIN_PASSWORD  — strong (8+, mixed case, digit, special)
//   ALLOW_SEED_IN_PRODUCTION  — must be the literal string 'true'
//
// In dev/test the password defaults to a clearly insecure value the
// onboarding flow must rotate immediately.

const NODE_ENV = (process.env.NODE_ENV || 'development').toLowerCase();
const IS_PROD = NODE_ENV === 'production';

const DEFAULT_DEV_EMAIL = 'superadmin@anistonav.local';
const DEFAULT_DEV_PASSWORD = 'ChangeMe@1234';

function validateStrongPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(pw)) return 'Password must include an uppercase letter.';
  if (!/[a-z]/.test(pw)) return 'Password must include a lowercase letter.';
  if (!/\d/.test(pw))    return 'Password must include a number.';
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(pw)) {
    return 'Password must include a special character.';
  }
  return null;
}

function buildSeedSpec() {
  const envEmail = process.env.SEED_SUPERADMIN_EMAIL;
  const envPassword = process.env.SEED_SUPERADMIN_PASSWORD;

  if (IS_PROD) {
    if (process.env.ALLOW_SEED_IN_PRODUCTION !== 'true') {
      throw new Error(
        '[Seed] Refusing to run in production. Set ALLOW_SEED_IN_PRODUCTION=true ' +
        'AND SEED_SUPERADMIN_EMAIL/SEED_SUPERADMIN_PASSWORD only for a one-off bootstrap.'
      );
    }
    if (!envEmail || !envPassword) {
      throw new Error(
        '[Seed] SEED_SUPERADMIN_EMAIL and SEED_SUPERADMIN_PASSWORD are required ' +
        'when ALLOW_SEED_IN_PRODUCTION=true.'
      );
    }
    const pwError = validateStrongPassword(envPassword);
    if (pwError) throw new Error(`[Seed] ${pwError}`);
    return {
      name: 'Super Admin',
      email: String(envEmail).toLowerCase(),
      password: envPassword,
      role: 'admin',
      department: 'Management',
      isSuperAdmin: true,
      hierarchyLevel: 'ceo',
      designation: 'Super Administrator',
    };
  }

  // Dev / test path. Env-supplied values still take precedence so the same
  // command can target a custom dev DB; otherwise fall back to the
  // documented dev defaults. Whichever password we end up using is
  // re-validated for strength so dev-onboarders can't accidentally weaken it.
  const password = envPassword || DEFAULT_DEV_PASSWORD;
  const pwError = validateStrongPassword(password);
  if (pwError) throw new Error(`[Seed] ${pwError}`);
  return {
    name: 'Super Admin',
    email: String(envEmail || DEFAULT_DEV_EMAIL).toLowerCase(),
    password,
    role: 'admin',
    department: 'Management',
    isSuperAdmin: true,
    hierarchyLevel: 'ceo',
    designation: 'Super Administrator',
  };
}

const seedUsers = async () => {
  try {
    const spec = buildSeedSpec();

    await sequelize.authenticate();
    console.log(`[Seed] Database connected. (env=${NODE_ENV})\n`);

    const existing = await User.findOne({ where: { email: spec.email } });
    if (existing) {
      console.log(`[Seed] Tier 1 already exists: ${spec.email}`);
      console.log('[Seed] No changes made — refusing to silently overwrite credentials.');
      process.exit(0);
    }

    await User.create({ ...spec, isActive: true, accountStatus: 'approved' });
    console.log('[Seed] Created TIER 1 (super admin):');
    console.log(`  Email: ${spec.email}`);
    if (!IS_PROD) {
      console.log(`  Password: ${spec.password}  ← rotate immediately on first login`);
    } else {
      console.log('  Password: (from SEED_SUPERADMIN_PASSWORD env var)');
    }
    console.log('\n[Seed] Done. Other employees should be synced from Microsoft Teams.');
    process.exit(0);
  } catch (err) {
    console.error('[Seed] Failed:', err.message);
    process.exit(1);
  }
};

seedUsers();
