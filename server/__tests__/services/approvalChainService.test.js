'use strict';

/**
 * Tests for server/services/approvalChainService.js — Phase 2.6 of the QA
 * remediation plan (docs/qa-audit-2026-05-17.md → §22 P0 item #6).
 * Previously 0% coverage.
 *
 * This service is the source of truth for who approves what. Mistakes here
 * route work-product to the wrong person or auto-approve dangerous tasks,
 * so test coverage of every branch is the point.
 *
 * Test scope:
 *   - rankOf (pure function)
 *   - findPrimaryManagerId — both data sources + their failure modes
 *   - walkManagerChain — sequential walk, cycle, depth cap, inactive-skip,
 *     final-stage role stop
 *   - findFallbackTopApprover — super-admin preference, excludeIds, minRank
 *   - deriveApprovalChain — submitter validation, sequential build, final
 *     stage construction, auto-approve, fallback, ordering
 *   - previewNextApprover — sequential / parallel / auto-approve shapes
 *
 * No DB; User + ManagerRelation are mocked. Verbose chain-derivation logs
 * are silenced via APPROVAL_CHAIN_DEBUG=0 so the test output stays clean.
 */

// Quiet the [ApprovalChain] dlog noise before requiring the module.
process.env.APPROVAL_CHAIN_DEBUG = '0';

jest.mock('../../models', () => ({
  User: {
    findByPk: jest.fn(),
    findAll: jest.fn(),
  },
  ManagerRelation: {
    findOne: jest.fn(),
  },
}));

const { User, ManagerRelation } = require('../../models');
const {
  deriveApprovalChain,
  previewNextApprover,
  walkManagerChain,
  findFallbackTopApprover,
  findPrimaryManagerId,
  rankOf,
  MAX_CHAIN_DEPTH,
} = require('../../services/approvalChainService');

// ─── tiny user factories ───────────────────────────────────────

const member = (id, name = id, overrides = {}) => ({
  id, name, role: 'member', isActive: true, isSuperAdmin: false, ...overrides,
});
const asstMgr = (id, name = id, overrides = {}) => ({
  id, name, role: 'assistant_manager', isActive: true, isSuperAdmin: false, ...overrides,
});
const manager = (id, name = id, overrides = {}) => ({
  id, name, role: 'manager', isActive: true, isSuperAdmin: false, ...overrides,
});
const admin = (id, name = id, overrides = {}) => ({
  id, name, role: 'admin', isActive: true, isSuperAdmin: false, ...overrides,
});
const superAdmin = (id, name = id, overrides = {}) => ({
  id, name, role: 'admin', isActive: true, isSuperAdmin: true, ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  // Sensible defaults that always say "no manager / no extra admins exist"
  // so each test only configures the slice it cares about.
  User.findByPk.mockResolvedValue(null);
  User.findAll.mockResolvedValue([]);
  ManagerRelation.findOne.mockResolvedValue(null);
});

// ─── rankOf ────────────────────────────────────────────────────

describe('rankOf', () => {
  it('ranks super admin highest (5)', () => {
    expect(rankOf(superAdmin('sa'))).toBe(5);
  });
  it('ranks admin = 4', () => {
    expect(rankOf(admin('a'))).toBe(4);
  });
  it('ranks manager = 3', () => {
    expect(rankOf(manager('m'))).toBe(3);
  });
  it('ranks assistant_manager = 2', () => {
    expect(rankOf(asstMgr('am'))).toBe(2);
  });
  it('ranks member = 1 (and any unknown role)', () => {
    expect(rankOf(member('m'))).toBe(1);
    expect(rankOf({ role: 'intern' })).toBe(1);
    expect(rankOf({})).toBe(1);
  });
});

describe('MAX_CHAIN_DEPTH', () => {
  it('is high enough to span any realistic org (10)', () => {
    // The comment in the source explains "Member -> AsstMgr -> ... -> SuperAdmin = 7"
    expect(MAX_CHAIN_DEPTH).toBeGreaterThanOrEqual(7);
  });
});

// ─── findPrimaryManagerId ──────────────────────────────────────

describe('findPrimaryManagerId', () => {
  it('returns User.managerId when set (source 1 wins)', async () => {
    User.findByPk.mockResolvedValueOnce({ id: 'u1', managerId: 'mgr-99' });
    await expect(findPrimaryManagerId('u1')).resolves.toBe('mgr-99');
    expect(ManagerRelation.findOne).not.toHaveBeenCalled(); // source 2 skipped
  });

  it('falls back to manager_relations.isPrimary when User.managerId is null', async () => {
    User.findByPk.mockResolvedValueOnce({ id: 'u1', managerId: null });
    ManagerRelation.findOne
      .mockResolvedValueOnce({ managerId: 'mgr-primary' });

    await expect(findPrimaryManagerId('u1')).resolves.toBe('mgr-primary');
    expect(ManagerRelation.findOne).toHaveBeenCalledWith(expect.objectContaining({
      where: { employeeId: 'u1', isPrimary: true },
    }));
  });

  it('falls back to the oldest non-primary relation when no primary exists', async () => {
    User.findByPk.mockResolvedValueOnce({ id: 'u1', managerId: null });
    ManagerRelation.findOne
      .mockResolvedValueOnce(null)                         // no primary
      .mockResolvedValueOnce({ managerId: 'mgr-old' });    // any (ordered asc)

    await expect(findPrimaryManagerId('u1')).resolves.toBe('mgr-old');
  });

  it('returns null when no manager exists in either source', async () => {
    User.findByPk.mockResolvedValueOnce({ id: 'u1', managerId: null });
    ManagerRelation.findOne.mockResolvedValue(null);
    await expect(findPrimaryManagerId('u1')).resolves.toBeNull();
  });

  it('returns null when manager_relations table is missing (lookup throws)', async () => {
    User.findByPk.mockResolvedValueOnce({ id: 'u1', managerId: null });
    ManagerRelation.findOne.mockRejectedValue(new Error('relation does not exist'));
    await expect(findPrimaryManagerId('u1')).resolves.toBeNull();
  });

  it('returns null when User row missing', async () => {
    User.findByPk.mockResolvedValueOnce(null);
    ManagerRelation.findOne.mockResolvedValue(null);
    await expect(findPrimaryManagerId('ghost')).resolves.toBeNull();
  });
});

// ─── walkManagerChain ──────────────────────────────────────────

describe('walkManagerChain', () => {
  it('returns warnings when the submitter row is missing', async () => {
    User.findByPk.mockResolvedValueOnce(null);
    const out = await walkManagerChain('ghost');
    expect(out.sequentialApprovers).toEqual([]);
    expect(out.finalAnchor).toBeNull();
    expect(out.warnings).toContain('Submitter user not found.');
  });

  it('ends cleanly when no manager exists above the start user', async () => {
    // First call: submitter meta. Second call: findPrimaryManagerId's user lookup.
    User.findByPk
      .mockResolvedValueOnce(member('u1'))   // submitter meta
      .mockResolvedValueOnce({ id: 'u1', managerId: null }); // findPrimaryManagerId
    ManagerRelation.findOne.mockResolvedValue(null);

    const out = await walkManagerChain('u1');
    expect(out.sequentialApprovers).toEqual([]);
    expect(out.finalAnchor).toBeNull();
    expect(out.warnings).toEqual([]);
  });

  it('collects assistant_managers sequentially and stops at the first manager (final anchor)', async () => {
    User.findByPk
      .mockResolvedValueOnce(member('u1'))                            // submitter meta
      .mockResolvedValueOnce({ id: 'u1', managerId: 'am1' })          // findPrimaryManagerId(u1)
      .mockResolvedValueOnce(asstMgr('am1'))                          // walk: load am1
      .mockResolvedValueOnce({ id: 'am1', managerId: 'mgr1' })        // findPrimaryManagerId(am1)
      .mockResolvedValueOnce(manager('mgr1', 'Manager One'));         // walk: load mgr1 (final anchor)

    const out = await walkManagerChain('u1');

    expect(out.sequentialApprovers).toHaveLength(1);
    expect(out.sequentialApprovers[0]).toMatchObject({ userId: 'am1', role: 'assistant_manager' });
    expect(out.finalAnchor).toMatchObject({ userId: 'mgr1', userName: 'Manager One', role: 'manager' });
  });

  it('treats a super admin in the chain as the final anchor (regardless of role string)', async () => {
    User.findByPk
      .mockResolvedValueOnce(member('u1'))
      .mockResolvedValueOnce({ id: 'u1', managerId: 'sa1' })
      .mockResolvedValueOnce(superAdmin('sa1', 'Super'));

    const out = await walkManagerChain('u1');
    expect(out.sequentialApprovers).toEqual([]);
    expect(out.finalAnchor).toMatchObject({ userId: 'sa1', isSuperAdmin: true });
  });

  it('skips inactive users and keeps walking through their managerId', async () => {
    // submitter -> inactive asst_mgr -> active manager (final anchor)
    User.findByPk
      .mockResolvedValueOnce(member('u1'))
      .mockResolvedValueOnce({ id: 'u1', managerId: 'am-dead' })           // findPrimaryManagerId(u1)
      .mockResolvedValueOnce(asstMgr('am-dead', 'dead', { isActive: false })) // walk: inactive
      .mockResolvedValueOnce({ id: 'am-dead', managerId: 'mgr1' })          // findPrimaryManagerId(am-dead)
      .mockResolvedValueOnce(manager('mgr1', 'Manager'));                   // walk: active manager

    const out = await walkManagerChain('u1');
    expect(out.sequentialApprovers).toEqual([]); // inactive asst mgr skipped
    expect(out.finalAnchor).toMatchObject({ userId: 'mgr1' });
    expect(out.warnings.some((w) => w.includes('inactive'))).toBe(true);
  });

  it('detects manager-chain cycles and stops with a warning', async () => {
    // u1 -> u2 -> u1 (cycle)
    User.findByPk
      .mockResolvedValueOnce(member('u1'))
      .mockResolvedValueOnce({ id: 'u1', managerId: 'u2' })   // findPrimaryManagerId(u1)
      .mockResolvedValueOnce(asstMgr('u2'))                   // load u2
      .mockResolvedValueOnce({ id: 'u2', managerId: 'u1' });  // findPrimaryManagerId(u2) — cycle

    const out = await walkManagerChain('u1');
    expect(out.warnings.some((w) => w.includes('cycle'))).toBe(true);
  });

  it('emits a "manager not found" warning when the next user row is missing', async () => {
    User.findByPk
      .mockResolvedValueOnce(member('u1'))
      .mockResolvedValueOnce({ id: 'u1', managerId: 'ghost' })
      .mockResolvedValueOnce(null); // walk: user not found

    const out = await walkManagerChain('u1');
    expect(out.warnings.some((w) => w.includes('not found in users table'))).toBe(true);
  });
});

// ─── findFallbackTopApprover ───────────────────────────────────

describe('findFallbackTopApprover', () => {
  it('returns the first active super admin when one exists', async () => {
    User.findAll
      .mockResolvedValueOnce([superAdmin('sa1'), superAdmin('sa2')])  // super admins
      // admins query never reached
      ;
    await expect(findFallbackTopApprover()).resolves.toMatchObject({ id: 'sa1' });
  });

  it('skips excluded super admins and returns the next one', async () => {
    User.findAll.mockResolvedValueOnce([superAdmin('sa1'), superAdmin('sa2')]);
    const out = await findFallbackTopApprover(new Set(['sa1']));
    expect(out.id).toBe('sa2');
  });

  it('falls back to an admin when all super admins are excluded', async () => {
    User.findAll
      .mockResolvedValueOnce([superAdmin('sa1')])  // super admins (will be excluded)
      .mockResolvedValueOnce([admin('a1')]);       // admins
    const out = await findFallbackTopApprover(new Set(['sa1']));
    expect(out.id).toBe('a1');
  });

  it('returns null when no super admin and no admin qualifies', async () => {
    User.findAll.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect(findFallbackTopApprover()).resolves.toBeNull();
  });

  it('honors the minRank filter — admins (rank 4) are rejected when minRank=5', async () => {
    User.findAll
      .mockResolvedValueOnce([])                  // no super admins
      .mockResolvedValueOnce([admin('a1')]);      // one admin (rank 4)
    await expect(findFallbackTopApprover(new Set(), 5)).resolves.toBeNull();
  });
});

// ─── deriveApprovalChain ───────────────────────────────────────

describe('deriveApprovalChain', () => {
  it('throws when the submitter is missing', async () => {
    User.findByPk.mockResolvedValueOnce(null);
    await expect(deriveApprovalChain('ghost')).rejects.toThrow(/not found/);
  });

  it('throws when the submitter is inactive', async () => {
    User.findByPk.mockResolvedValueOnce(member('u1', 'U1', { isActive: false }));
    await expect(deriveApprovalChain('u1')).rejects.toThrow(/inactive/);
  });

  it('auto-approves when no manager, no admins, no super admins exist anywhere', async () => {
    // submitter (1st) — main meta lookup at deriveApprovalChain top
    User.findByPk
      .mockResolvedValueOnce(member('u1'))                          // submitter
      .mockResolvedValueOnce(member('u1'))                          // walkManagerChain submitter meta
      .mockResolvedValueOnce({ id: 'u1', managerId: null });        // findPrimaryManagerId
    ManagerRelation.findOne.mockResolvedValue(null);
    // collectFinalStageMembers — managers / admins / supers all empty
    User.findAll.mockResolvedValue([]);

    const out = await deriveApprovalChain('u1');
    expect(out.autoApprove).toBe(true);
    expect(out.chain).toHaveLength(1); // just the submitter
    expect(out.chain[0]).toMatchObject({ level: 0, isSubmitter: true });
    expect(out.warnings.some((w) => w.includes('auto-approved'))).toBe(true);
  });

  it('builds a chain: submitter (L0) → assistant_manager (L1) → final stage', async () => {
    User.findByPk
      // 1. submitter at deriveApprovalChain
      .mockResolvedValueOnce(member('u1', 'Submitter'))
      // 2. walkManagerChain — submitter meta
      .mockResolvedValueOnce(member('u1', 'Submitter'))
      // 3. findPrimaryManagerId(u1)
      .mockResolvedValueOnce({ id: 'u1', managerId: 'am1' })
      // 4. walk: load am1
      .mockResolvedValueOnce(asstMgr('am1', 'AsstMgr'))
      // 5. findPrimaryManagerId(am1)
      .mockResolvedValueOnce({ id: 'am1', managerId: 'mgr1' })
      // 6. walk: load mgr1 (final anchor)
      .mockResolvedValueOnce(manager('mgr1', 'Manager'));
    // collectFinalStageMembers — find all managers/admins/supers
    User.findAll
      .mockResolvedValueOnce([manager('mgr1', 'Manager')])           // managers
      .mockResolvedValueOnce([])                                     // admins
      .mockResolvedValueOnce([]);                                    // super admins

    const out = await deriveApprovalChain('u1');
    expect(out.autoApprove).toBe(false);

    expect(out.chain[0]).toMatchObject({ level: 0, userId: 'u1', isSubmitter: true });
    expect(out.chain[1]).toMatchObject({ level: 1, stage: 1, userId: 'am1', isParallel: false });
    expect(out.chain[2]).toMatchObject({ level: 2, stage: 2, userId: 'mgr1', isParallel: true });

    expect(out.finalStage).toMatchObject({ stage: 2 });
    expect(out.finalStage.members.map((m) => m.userId)).toEqual(['mgr1']);
  });

  it('final stage orders managers → admins → super admins, deduping the anchor', async () => {
    User.findByPk
      .mockResolvedValueOnce(member('u1'))                                      // submitter (derive)
      .mockResolvedValueOnce(member('u1'))                                      // submitter (walk)
      .mockResolvedValueOnce({ id: 'u1', managerId: 'sa1' })                    // findPrimaryManagerId
      .mockResolvedValueOnce(superAdmin('sa1', 'Super'));                       // walk: hits super admin → anchor

    User.findAll
      .mockResolvedValueOnce([manager('m1', 'Manager1')])                       // managers
      .mockResolvedValueOnce([admin('a1', 'Admin1')])                           // admins
      .mockResolvedValueOnce([superAdmin('sa1', 'Super'), superAdmin('sa2', 'Super2')]); // super admins

    const out = await deriveApprovalChain('u1');
    const ids = out.finalStage.members.map((m) => m.userId);
    // Order: managers first, then admins, then super admins. sa1 (anchor) merged into super bucket.
    expect(ids).toEqual(['m1', 'a1', 'sa1', 'sa2']);
  });

  it('falls back to findFallbackTopApprover when no anchor + no admins in collectFinalStageMembers', async () => {
    // Pathological config: submitter is a member, has no manager chain, AND
    // collectFinalStageMembers returns []. This forces the fallback path.
    // We then have findFallbackTopApprover surface a super admin.
    User.findByPk
      .mockResolvedValueOnce(member('u1'))                                  // derive
      .mockResolvedValueOnce(member('u1'))                                  // walk submitter
      .mockResolvedValueOnce({ id: 'u1', managerId: null });                // no manager
    User.findAll
      .mockResolvedValueOnce([])                                            // managers (collectFinalStage)
      .mockResolvedValueOnce([])                                            // admins (collectFinalStage)
      .mockResolvedValueOnce([])                                            // super admins (collectFinalStage)
      .mockResolvedValueOnce([superAdmin('sa-rescue', 'Rescue Super')])     // findFallbackTopApprover: super admins
      // admins query in fallback not reached because super is found
      ;

    const out = await deriveApprovalChain('u1');
    expect(out.autoApprove).toBe(false);
    expect(out.finalStage.members).toHaveLength(1);
    // Note: chain rows don't carry isSuperAdmin (only previewNextApprover's
    // output shape does). userId + role + isParallel are the row contract.
    expect(out.finalStage.members[0]).toMatchObject({
      userId: 'sa-rescue', userName: 'Rescue Super', isParallel: true,
    });
    expect(out.warnings.some((w) => w.includes('falling back'))).toBe(true);
  });

  it('excludes the submitter from the final stage', async () => {
    // Edge case: a manager submits their own task. They must not appear as
    // their own approver.
    User.findByPk
      .mockResolvedValueOnce(manager('m1'))                                     // submitter is a manager
      .mockResolvedValueOnce(manager('m1'))                                     // submitter meta in walk
      .mockResolvedValueOnce({ id: 'm1', managerId: null });                    // no manager above
    User.findAll
      .mockResolvedValueOnce([manager('m1'), manager('m2')])                    // managers
      .mockResolvedValueOnce([])                                                // admins
      .mockResolvedValueOnce([]);                                               // super admins

    const out = await deriveApprovalChain('m1');
    const ids = out.finalStage.members.map((m) => m.userId);
    expect(ids).not.toContain('m1');
    expect(ids).toContain('m2');
  });
});

// ─── previewNextApprover ───────────────────────────────────────

describe('previewNextApprover', () => {
  it('returns null when the chain auto-approves', async () => {
    User.findByPk
      .mockResolvedValueOnce(member('u1'))            // derive submitter
      .mockResolvedValueOnce(member('u1'))            // walk submitter meta
      .mockResolvedValueOnce({ id: 'u1', managerId: null });
    User.findAll.mockResolvedValue([]); // no admins/supers anywhere

    await expect(previewNextApprover('u1')).resolves.toBeNull();
  });

  it('returns a single-approver shape when first approver is sequential (assistant manager)', async () => {
    User.findByPk
      .mockResolvedValueOnce(member('u1'))                                      // derive
      .mockResolvedValueOnce(member('u1'))                                      // walk
      .mockResolvedValueOnce({ id: 'u1', managerId: 'am1' })
      .mockResolvedValueOnce(asstMgr('am1', 'AsstMgr'))
      .mockResolvedValueOnce({ id: 'am1', managerId: 'mgr1' })
      .mockResolvedValueOnce(manager('mgr1', 'Manager'));
    User.findAll
      .mockResolvedValueOnce([manager('mgr1', 'Manager')])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const out = await previewNextApprover('u1');
    expect(out).toMatchObject({
      isParallel: false,
      approvers: [{ userId: 'am1', role: 'assistant_manager' }],
    });
    expect(out.approvers).toHaveLength(1);
  });

  it('returns the full parallel stage when first approver is in the final stage', async () => {
    // A manager submits — they have no assistant_manager above, so the first
    // approver row is the parallel final stage.
    User.findByPk
      .mockResolvedValueOnce(manager('m1'))                                     // derive submitter
      .mockResolvedValueOnce(manager('m1'))                                     // walk submitter
      .mockResolvedValueOnce({ id: 'm1', managerId: null });                    // no manager above

    User.findAll
      .mockResolvedValueOnce([])                                                // managers (m1 excluded)
      .mockResolvedValueOnce([admin('a1', 'Admin1')])                           // admins
      .mockResolvedValueOnce([superAdmin('sa1', 'Super')]);                     // super admins

    const out = await previewNextApprover('m1');
    expect(out.isParallel).toBe(true);
    expect(out.approvers.map((a) => a.userId).sort()).toEqual(['a1', 'sa1']);
  });
});
