const { User, ManagerRelation } = require('../models');

// Hard cap on chain depth — defensive guard against managerId cycles or pathological
// org configurations. 10 is well above any realistic hierarchy (Member -> AsstMgr ->
// Mgr -> Director -> VP -> Admin -> SuperAdmin = 7).
const MAX_CHAIN_DEPTH = 10;

// Toggle verbose chain-derivation logging via env. Defaults on in dev so the user
// can audit hierarchy decisions; disable in prod by setting APPROVAL_CHAIN_DEBUG=0.
const DEBUG = process.env.APPROVAL_CHAIN_DEBUG !== '0';
function dlog(...args) {
  if (DEBUG) console.log('[ApprovalChain]', ...args);
}

/**
 * Find the next manager upward for a given user id, consulting BOTH sources
 * the org chart uses:
 *
 *   1. `User.managerId` (legacy column on users table). Authoritative when set.
 *   2. `manager_relations` row where employeeId = userId AND isPrimary = true.
 *      This is what the Org Chart UI renders from when the legacy column is null.
 *
 * Returns the next manager's userId, or null when the user has no manager in
 * either source. Never throws; absent/disabled tables are tolerated.
 */
async function findPrimaryManagerId(userId) {
  // Source 1 — User.managerId column.
  const u = await User.findByPk(userId, { attributes: ['id', 'managerId'] });
  if (u?.managerId) {
    dlog(`  source: User.managerId on ${userId} -> ${u.managerId}`);
    return u.managerId;
  }
  // Source 2 — manager_relations primary row.
  try {
    const rel = await ManagerRelation.findOne({
      where: { employeeId: userId, isPrimary: true },
      attributes: ['managerId'],
    });
    if (rel?.managerId) {
      dlog(`  source: manager_relations.primary on ${userId} -> ${rel.managerId}`);
      return rel.managerId;
    }
    // Last-resort: any non-primary relation ordered by createdAt. Only used when
    // no primary exists — better than nothing for incomplete org configs.
    const anyRel = await ManagerRelation.findOne({
      where: { employeeId: userId },
      attributes: ['managerId'],
      order: [['createdAt', 'ASC']],
    });
    if (anyRel?.managerId) {
      dlog(`  source: manager_relations.any (no primary) on ${userId} -> ${anyRel.managerId}`);
      return anyRel.managerId;
    }
  } catch (e) {
    // manager_relations table may not exist in some envs — silently ignore.
    dlog(`  manager_relations lookup failed (table may not exist): ${e.message}`);
  }
  return null;
}

/**
 * Walk up the management chain starting at `startUserId`, collecting sequential
 * approvers. Stops at the FIRST encountered user with role 'manager', 'admin',
 * or isSuperAdmin — that user is returned as the `finalAnchor` so the caller
 * can include them in the final parallel stage instead of as a sequential level.
 *
 * Walking rules:
 *   - Use findPrimaryManagerId (User.managerId OR manager_relations.isPrimary).
 *   - Skip inactive users (continue through them via their managerId).
 *   - Stop on cycle, depth cap, missing manager, or hitting a final-stage role.
 *
 * Returns: {
 *   sequentialApprovers: Array<{ userId, userName, role, isSuperAdmin }>,
 *   finalAnchor: { userId, userName, role, isSuperAdmin } | null,
 *   warnings: string[]
 * }
 *
 * The submitter (level 0) is owned by deriveApprovalChain — this helper only
 * returns approver shapes.
 */
async function walkManagerChain(startUserId) {
  const sequentialApprovers = [];
  const warnings = [];
  const seen = new Set([startUserId]);

  const submitterMeta = await User.findByPk(startUserId, {
    attributes: ['id', 'name', 'role', 'isActive'],
  });
  if (!submitterMeta) {
    return { sequentialApprovers, finalAnchor: null, warnings: ['Submitter user not found.'] };
  }
  dlog(`walk start: ${submitterMeta.name} (${submitterMeta.role}, id=${startUserId})`);

  let cursorId = startUserId;
  let finalAnchor = null;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
    const nextId = await findPrimaryManagerId(cursorId);
    if (!nextId) {
      dlog(`  walk end: no manager found above ${cursorId}`);
      break;
    }
    if (seen.has(nextId)) {
      warnings.push(`Manager chain cycle detected at user ${cursorId} -> ${nextId}; truncated.`);
      break;
    }
    seen.add(nextId);

    const next = await User.findByPk(nextId, {
      attributes: ['id', 'name', 'role', 'isActive', 'isSuperAdmin'],
    });
    if (!next) {
      warnings.push(`Manager ${nextId} not found in users table; chain ends.`);
      break;
    }

    if (!next.isActive) {
      warnings.push(`Manager ${next.name || next.id} is inactive; skipped in chain.`);
      cursorId = next.id;
      continue;
    }

    // Stop the sequential walk on first final-stage role. That user becomes
    // the anchor of the parallel final stage; the rest (other admins +
    // super admins) are filled in by deriveApprovalChain.
    const isFinalRole = next.role === 'manager' || next.role === 'admin' || !!next.isSuperAdmin;
    if (isFinalRole) {
      dlog(`  walk end: hit final-stage role ${next.role}${next.isSuperAdmin ? ' (super)' : ''} at ${next.name}; using as final anchor.`);
      finalAnchor = {
        userId: next.id,
        userName: next.name,
        role: next.role,
        isSuperAdmin: !!next.isSuperAdmin,
      };
      break;
    }

    dlog(`  +sequential L${sequentialApprovers.length + 1}: ${next.name} (${next.role})`);
    sequentialApprovers.push({
      userId: next.id,
      userName: next.name,
      role: next.role,
      isSuperAdmin: !!next.isSuperAdmin,
    });
    cursorId = next.id;
  }

  if (sequentialApprovers.length === MAX_CHAIN_DEPTH) {
    warnings.push(`Sequential chain depth cap (${MAX_CHAIN_DEPTH}) reached; chain truncated.`);
  }

  return { sequentialApprovers, finalAnchor, warnings };
}

// Seniority ranking. Higher = more senior. Super admin = admin role + isSuperAdmin.
// Used by the fallback path to refuse routing a senior submitter's approval to a junior.
function rankOf(user) {
  if (user.isSuperAdmin) return 5;
  if (user.role === 'admin') return 4;
  if (user.role === 'manager') return 3;
  if (user.role === 'assistant_manager') return 2;
  return 1; // member
}

/**
 * Find a fallback top-of-org approver. Prefers an active super admin; falls back
 * to any active admin. Returns null if nobody qualifies.
 *
 * `minRank` enforces the seniority guard — fallback will not return a user whose
 * rank is below this. Pass `rankOf(submitter) + 1` to require a strictly more
 * senior approver, or `rankOf(submitter)` to allow same-rank peer review.
 */
async function findFallbackTopApprover(excludeIds = new Set(), minRank = 0) {
  const supers = await User.findAll({
    where: { isSuperAdmin: true, isActive: true },
    attributes: ['id', 'name', 'role', 'isSuperAdmin'],
    order: [['createdAt', 'ASC']],
  });
  for (const u of supers) {
    if (excludeIds.has(u.id)) continue;
    if (rankOf(u) < minRank) continue;
    return u;
  }

  const admins = await User.findAll({
    where: { role: 'admin', isActive: true },
    attributes: ['id', 'name', 'role', 'isSuperAdmin'],
    order: [['createdAt', 'ASC']],
  });
  for (const u of admins) {
    if (excludeIds.has(u.id)) continue;
    if (rankOf(u) < minRank) continue;
    return u;
  }

  return null;
}

/**
 * Find the senior-most active admin (admin role, NOT super admin). Returns null
 * when none exists or all are excluded. Stable order: oldest createdAt first.
 */
async function findFirstActiveAdmin(excludeIds = new Set()) {
  const admins = await User.findAll({
    where: { role: 'admin', isActive: true, isSuperAdmin: false },
    attributes: ['id', 'name', 'role', 'isSuperAdmin'],
    order: [['createdAt', 'ASC']],
  });
  for (const u of admins) {
    if (!excludeIds.has(u.id)) return u;
  }
  return null;
}

/**
 * Find the senior-most active super admin. Returns null when none exists or all
 * are excluded. Stable order: oldest createdAt first.
 */
async function findFirstActiveSuperAdmin(excludeIds = new Set()) {
  const supers = await User.findAll({
    where: { isSuperAdmin: true, isActive: true },
    attributes: ['id', 'name', 'role', 'isSuperAdmin'],
    order: [['createdAt', 'ASC']],
  });
  for (const u of supers) {
    if (!excludeIds.has(u.id)) return u;
  }
  return null;
}

/**
 * Collect every user who belongs to the parallel final stage. Members:
 *   - the `anchor` (the first manager / admin / super admin we hit walking
 *     upward from the submitter), if any
 *   - all active managers
 *   - all active admins
 *   - all active super admins
 *
 * Final result is ordered Manager → Admin → Super Admin so the UI renders the
 * roles in escalating seniority (Super Admin ALWAYS appears last — the user-
 * facing convention is "highest authority is the final entry"). Within a role
 * tier ordering is by createdAt ASC for stable, name-independent ordering.
 *
 * Excludes the submitter and any user who appears in `excludeIds` (used to
 * keep someone already placed in the sequential chain from showing up twice).
 * Returns: Array<{ userId, userName, role, isSuperAdmin }> (deduped).
 */
async function collectFinalStageMembers({ submitterId, anchor, excludeIds = new Set() }) {
  const exclude = new Set([submitterId, ...excludeIds]);

  // Three buckets keyed in seniority order. Anchor is dropped into the bucket
  // matching its role so the final ordering is stable regardless of where the
  // anchor came from.
  const managers = new Map();   // userId -> shape
  const admins = new Map();     // userId -> shape (excludes super admins)
  const superAdmins = new Map();// userId -> shape

  function bucketFor(u) {
    if (u.isSuperAdmin) return superAdmins;
    if (u.role === 'admin') return admins;
    if (u.role === 'manager') return managers;
    return null;
  }
  function add(u) {
    if (exclude.has(u.userId || u.id)) return;
    const b = bucketFor(u);
    if (!b) return;
    const id = u.userId || u.id;
    if (b.has(id)) return;
    b.set(id, {
      userId: id,
      userName: u.userName || u.name,
      role: u.role,
      isSuperAdmin: !!u.isSuperAdmin,
    });
  }

  if (anchor) add(anchor);

  const managerRows = await User.findAll({
    where: { role: 'manager', isActive: true },
    attributes: ['id', 'name', 'role', 'isSuperAdmin'],
    order: [['createdAt', 'ASC']],
  });
  for (const u of managerRows) add(u);

  const adminRows = await User.findAll({
    where: { role: 'admin', isActive: true },
    attributes: ['id', 'name', 'role', 'isSuperAdmin'],
    order: [['createdAt', 'ASC']],
  });
  for (const u of adminRows) add(u);

  const superRows = await User.findAll({
    where: { isSuperAdmin: true, isActive: true },
    attributes: ['id', 'name', 'role', 'isSuperAdmin'],
    order: [['createdAt', 'ASC']],
  });
  for (const u of superRows) add(u);

  return [
    ...managers.values(),
    ...admins.values(),
    ...superAdmins.values(),
  ];
}

/**
 * Derive the full approval chain for a submission.
 *
 * Strategy (parallel-final-stage):
 *   1. Submitter row at level 0, stage 0 (status will be 'submitted' when persisted).
 *   2. Walk the org chart upward via managerId, collecting ASSISTANT MANAGERS as
 *      sequential approvers. Stop on the first user with role manager / admin /
 *      isSuperAdmin — that user becomes the "anchor" of the final stage.
 *   3. Final stage = [anchor] ∪ [active admins] ∪ [active super admins], deduped,
 *      excluding the submitter and anyone already placed sequentially. ALL
 *      members of this stage share one `stage` value but each get a distinct
 *      `level` (the row identifier). Any one of them can approve to complete
 *      the chain.
 *   4. If submitter has neither an org-chart anchor nor any admin/super admin
 *      to fall back to, the chain has only the submitter row → auto-approved.
 *
 * Returns:
 *   {
 *     chain: Array<{ level, stage, userId, userName, role, isSubmitter, isParallel }>,
 *     warnings: string[],
 *     autoApprove: boolean,    // true when the final stage is empty
 *     finalStage: { stage, members: Array<...> } | null
 *   }
 */
async function deriveApprovalChain(submitterUserId) {
  const submitter = await User.findByPk(submitterUserId, {
    attributes: ['id', 'name', 'role', 'isActive', 'isSuperAdmin'],
  });
  if (!submitter) {
    throw new Error(`Submitter user ${submitterUserId} not found.`);
  }
  if (!submitter.isActive) {
    throw new Error(`Submitter user ${submitter.name} is inactive and cannot submit for approval.`);
  }

  dlog(`derive chain for ${submitter.name} (${submitter.role}, id=${submitter.id})`);

  const chain = [
    {
      level: 0,
      stage: 0,
      userId: submitter.id,
      userName: submitter.name,
      role: submitter.role,
      isSubmitter: true,
      isParallel: false,
    },
  ];

  const { sequentialApprovers, finalAnchor, warnings } = await walkManagerChain(submitterUserId);

  // Add sequential approvers (assistant_managers walked from the org chart).
  // Each gets its own stage; stage = level for sequential rows.
  let level = 1;
  for (const a of sequentialApprovers) {
    chain.push({
      level,
      stage: level,
      userId: a.userId,
      userName: a.userName,
      role: a.role,
      isSubmitter: false,
      isParallel: false,
    });
    level += 1;
  }

  // Build the parallel final stage. Excludes anyone already in the sequential
  // chain so the same user can't appear at two levels.
  const seqIds = new Set(sequentialApprovers.map((a) => a.userId));
  const finalStageMembers = await collectFinalStageMembers({
    submitterId: submitterUserId,
    anchor: finalAnchor,
    excludeIds: seqIds,
  });

  if (finalStageMembers.length === 0) {
    // No anchor AND no admins/super admins anywhere — the submitter is
    // effectively the top of the org. Last-resort: try a fallback (rare).
    const submitterRank = rankOf(submitter);
    const fallback = await findFallbackTopApprover(new Set([submitterUserId]), submitterRank + 1);
    if (fallback) {
      const w = `No org-chart manager and no admin/super admin found for ${submitter.name}; falling back to ${fallback.isSuperAdmin ? 'super admin' : 'admin'} ${fallback.name}.`;
      warnings.push(w);
      finalStageMembers.push({
        userId: fallback.id,
        userName: fallback.name,
        role: fallback.role,
        isSuperAdmin: !!fallback.isSuperAdmin,
      });
    } else if (sequentialApprovers.length === 0) {
      warnings.push('No approvers reachable; submission will be auto-approved.');
      dlog('  AUTO-APPROVE');
      return { chain, warnings, autoApprove: true, finalStage: null };
    }
    // Else: sequential approvers exist but no final stage (rare config) — we
    // proceed without a final stage; the last sequential approver becomes the
    // de-facto final approver.
  }

  let finalStageBlock = null;
  if (finalStageMembers.length > 0) {
    const finalStageValue = level; // next slot after sequential approvers
    finalStageBlock = { stage: finalStageValue, members: [] };
    for (const m of finalStageMembers) {
      const row = {
        level,
        stage: finalStageValue,
        userId: m.userId,
        userName: m.userName,
        role: m.role,
        isSubmitter: false,
        isParallel: true,
      };
      chain.push(row);
      finalStageBlock.members.push(row);
      level += 1;
    }
  }

  dlog(`final chain: ${chain.map((r) => `S${r.stage}L${r.level}=${r.userName}${r.isParallel ? '*' : ''}`).join(' -> ')}`);
  return { chain, warnings, autoApprove: false, finalStage: finalStageBlock };
}

/**
 * Quick "what would happen on submit" preview for the bottom-sheet modal.
 * Returns the next stage shape (sequential single approver OR the parallel
 * final stage), or null when the chain is auto-approve.
 *
 * Shape:
 *   {
 *     autoApprove: boolean,
 *     nextStage: {
 *       stage: number,
 *       isParallel: boolean,
 *       approvers: [{ userId, userName, role, isSuperAdmin }, ...]
 *     } | null
 *   }
 */
async function previewNextApprover(submitterUserId) {
  const { chain, autoApprove, finalStage } = await deriveApprovalChain(submitterUserId);
  if (autoApprove) return null;
  // Find the lowest-level non-submitter row.
  const firstApprover = chain.find((row) => row.level >= 1);
  if (!firstApprover) return null;
  // If the first approver belongs to the parallel final stage, return the
  // whole stage. Otherwise return a single-approver stage (sequential).
  if (firstApprover.isParallel && finalStage) {
    return {
      stage: finalStage.stage,
      isParallel: true,
      approvers: finalStage.members.map((m) => ({
        userId: m.userId,
        userName: m.userName,
        role: m.role,
        isSuperAdmin: !!m.isSuperAdmin,
      })),
    };
  }
  return {
    stage: firstApprover.stage,
    isParallel: false,
    approvers: [{
      userId: firstApprover.userId,
      userName: firstApprover.userName,
      role: firstApprover.role,
      isSuperAdmin: !!firstApprover.isSuperAdmin,
    }],
  };
}

module.exports = {
  deriveApprovalChain,
  previewNextApprover,
  walkManagerChain,
  findFallbackTopApprover,
  findPrimaryManagerId,
  rankOf,
  MAX_CHAIN_DEPTH,
};
