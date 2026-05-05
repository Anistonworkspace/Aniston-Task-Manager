const {
  sequelize,
  Task,
  User,
  TaskApprovalFlow,
  DueDateExtension,
  HelpRequest,
  Board,
  Activity,
} = require('../models');
const { Op } = require('sequelize');
const xss = require('xss');
const { logActivity } = require('../services/activityService');
const realtime = require('../services/realtimeService');
const { deriveApprovalChain, previewNextApprover } = require('../services/approvalChainService');
const approvalNotif = require('../services/approvalNotificationService');
const { computeApprovalCapabilities } = require('../services/approvalCapabilityService');
const {
  applyApprovalSubmittedState,
  applyApprovalApprovedState,
  applyApprovalRejectedState,
  applyApprovalChangesRequestedState,
} = require('../services/approvalLifecycleService');

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Push a row onto the JSONB mirror (deprecated, kept for one release so the
// existing UI timeline keeps rendering). Format intentionally matches the
// previous controller's shape so legacy renderers don't break.
//
// Returns a NEW array reference rather than mutating in place. Sequelize JSONB
// dirty-tracking compares by reference and silently drops in-place mutations
// to JSONB columns.
function appendChainAudit(task, entry) {
  const prev = Array.isArray(task.approvalChain) ? task.approvalChain : [];
  return [
    ...prev,
    {
      userId: entry.userId,
      userName: entry.userName,
      action: entry.action,
      comment: entry.comment || '',
      timestamp: new Date().toISOString(),
    },
  ];
}

// NOTE: prior versions defined `isSelfAssignedTask` here and short-circuited the
// approval flow for tasks where the actor was both creator and sole assignee.
// That carved out a privilege bypass — a member could self-assign a task and
// mark it Done without any review. Per the new product rule, hierarchical
// approval applies to ALL non-super-admin completions, including self-assigned
// tasks. Super Admins remain exempt (they have no senior reviewer in the org)
// and the approvalChainService handles the no-reviewer case via autoApprove
// for genuinely top-of-hierarchy actors. The helper has been removed.

// Detect schema-mismatch errors from Postgres (undefined column 42703, undefined
// table 42P01). When a deploy ships backend code that references a column the
// production DB doesn't have, the bare "Failed to ..." toast hides the cause.
// This helper returns a 503-style payload with an admin-actionable hint and
// keeps the underlying error string only in dev so prod responses don't leak schema.
function buildErrorResponse(err, defaultMessage) {
  const pgCode = err?.parent?.code || err?.original?.code;
  const isSchemaMismatch = pgCode === '42703' || pgCode === '42P01';
  if (isSchemaMismatch) {
    return {
      status: 503,
      body: {
        success: false,
        message: 'Server database schema is out of date. Please ask an administrator to run the latest migrations (server/scripts/migrate-task-approval-flow-stage.js).',
        code: 'schema_mismatch',
        ...(process.env.NODE_ENV !== 'production' ? { detail: err.message } : {}),
      },
    };
  }
  return {
    status: 500,
    body: {
      success: false,
      message: defaultMessage,
      ...(process.env.NODE_ENV !== 'production' ? { detail: err?.message } : {}),
    },
  };
}

// Effective stage for a row. Backward-compat shim: rows created before the
// `stage` column existed have stage=NULL; treat those as stage = level so the
// legacy sequential semantics still hold for old chains.
function stageOf(row) {
  return row.stage != null ? row.stage : row.level;
}

// Returns ALL rows in the lowest pending stage for a task, locking them for
// update. Empty array means no pending stage (chain complete or in error state).
//
// "Lowest pending stage" = the smallest stage value (or fallback level for
// legacy rows) that contains at least one row whose status='pending'. All
// rows in that stage are returned because parallel approvers act as a single
// any-of step — we need to lock and inspect them together.
async function findCurrentStageRows(taskId, transaction) {
  // First, locate which stage is current. A two-step query keeps the lock
  // narrow: we lock only the rows in the chosen stage, not the whole task's
  // chain history.
  const lowest = await TaskApprovalFlow.findOne({
    where: { taskId, status: 'pending' },
    order: [
      // COALESCE(stage, level) keeps legacy NULL-stage rows in the right slot.
      [sequelize.literal('COALESCE(stage, level)'), 'ASC'],
      ['level', 'ASC'],
    ],
    transaction,
  });
  if (!lowest) return [];
  const lowestStage = stageOf(lowest);

  // Lock the entire stage so concurrent peers serialize.
  const rows = await TaskApprovalFlow.findAll({
    where: {
      taskId,
      [Op.and]: [
        sequelize.where(sequelize.literal('COALESCE(stage, level)'), lowestStage),
      ],
    },
    order: [['level', 'ASC']],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  return rows;
}

// Back-compat alias for any external caller that imports findCurrentPending.
// Returns the first row in the current stage (preserves the old "single
// current approver" semantics for sequential-only chains).
async function findCurrentPending(taskId, transaction) {
  const stageRows = await findCurrentStageRows(taskId, transaction);
  return stageRows.find((r) => r.status === 'pending') || null;
}

// Serialize the chain rows for client consumption — orders by stage then level
// and includes denormalized userName/role so the UI renders even for deleted users.
async function loadChainForResponse(taskId, transaction) {
  const rows = await TaskApprovalFlow.findAll({
    where: { taskId },
    order: [
      [sequelize.literal('COALESCE(stage, level)'), 'ASC'],
      ['level', 'ASC'],
    ],
    include: [{ model: User, as: 'user', attributes: ['id', 'name', 'avatar', 'role', 'isSuperAdmin'] }],
    transaction,
  });
  return rows.map((r) => ({
    id: r.id,
    level: r.level,
    stage: stageOf(r),
    userId: r.userId,
    userName: r.user?.name || r.userName || '(deleted user)',
    userAvatar: r.user?.avatar || null,
    role: r.role,
    isSuperAdmin: !!r.user?.isSuperAdmin,
    status: r.status,
    comment: r.comment,
    attachmentUrl: r.attachmentUrl,
    actionAt: r.actionAt,
    createdAt: r.createdAt,
  }));
}

// ─── POST /api/task-extras/:id/submit-approval ───────────────────────────────
//
// Called when an assignee marks a task done with the bottom-sheet modal.
// Rebuilds the chain from scratch (handles re-submissions after reject /
// changes_requested). Whole flow is wrapped in a transaction with a row lock
// on the task to prevent two assignees from racing on first submission.
exports.submitForApproval = async (req, res) => {
  const { comment, attachmentUrl } = req.body || {};
  const sanitizedComment = comment ? xss(String(comment).slice(0, 2000)) : '';

  const t = await sequelize.transaction();
  try {
    // Lock the task row so concurrent submitters serialize.
    const task = await Task.findByPk(req.params.id, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!task) {
      await t.rollback();
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    // Idempotency guard: if already pending and not in changes_requested/rejected
    // state, refuse rather than silently rebuilding.
    if (task.approvalStatus === 'pending_approval') {
      await t.rollback();
      return res.status(409).json({
        success: false,
        message: 'Task is already pending approval.',
      });
    }

    // Super Admin bypass — Super Admins are the top of the org hierarchy and
    // have no senior reviewer to route to. Per product spec they NEVER go
    // through approval: completing a task is the final authority. Frontend
    // hides the Submit button for them, but anyone calling this endpoint
    // directly (script, curl, replay) gets a 403. The hint tells the caller
    // what to do instead.
    if (req.user.isSuperAdmin) {
      await t.rollback();
      return res.status(403).json({
        success: false,
        message: 'Super Admin tasks do not require approval. Mark the task as Done directly.',
        code: 'super_admin_no_approval',
      });
    }

    // Derive chain from the org tree.
    const { chain, warnings, autoApprove } = await deriveApprovalChain(req.user.id);

    // Wipe any prior chain rows for this task. Each submission cycle owns a
    // fresh set of rows; historical detail lives in approvalChain JSONB +
    // Activity log. The unique (taskId, level) constraint requires this.
    await TaskApprovalFlow.destroy({ where: { taskId: task.id }, transaction: t });

    const now = new Date();

    // Persist level 0 (submitter row) and approver rows. `stage` is the
    // grouping key — sequential rows have stage = level; the parallel final
    // stage rows all share one stage value (set by deriveApprovalChain).
    const rowsToCreate = chain.map((row) => ({
      taskId: task.id,
      userId: row.userId,
      userName: row.userName,
      role: row.role,
      level: row.level,
      stage: row.stage != null ? row.stage : row.level,
      status: row.isSubmitter ? 'submitted' : 'pending',
      comment: row.isSubmitter ? sanitizedComment : null,
      attachmentUrl: row.isSubmitter && attachmentUrl ? String(attachmentUrl).slice(0, 1000) : null,
      actionAt: row.isSubmitter ? now : null,
    }));
    const createdRows = await TaskApprovalFlow.bulkCreate(rowsToCreate, { transaction: t });

    // Load board for status-label resolution + group movement. Cheap one-shot
    // read inside the transaction; the lifecycle helpers are pure.
    const board = task.boardId
      ? await Board.findByPk(task.boardId, { attributes: ['id', 'columns', 'groups'], transaction: t })
      : null;

    // Auto-approve short-circuit: submitter has no senior reviewer in the org.
    if (autoApprove) {
      // Mark every level approved (only level 0 exists, which is fine — semantically
      // the chain has nothing to approve so we treat it as completed).
      await TaskApprovalFlow.update(
        { status: 'approved', actionAt: now, comment: 'Auto-approved (no senior reviewer in chain)' },
        { where: { taskId: task.id, level: { [Op.gt]: 0 } }, transaction: t }
      );
      const auditChain = appendChainAudit(task, {
        userId: req.user.id,
        userName: req.user.name,
        action: 'submitted',
        comment: sanitizedComment,
      });
      auditChain.push({
        userId: req.user.id,
        userName: req.user.name,
        action: 'auto_approved',
        comment: 'No senior reviewer in chain.',
        timestamp: now.toISOString(),
      });
      // Auto-approve goes straight to the "approved" lifecycle state — Done,
      // 100%, group→Done — without ever passing through the Waiting-for-Review
      // intermediate, since the chain has nothing to wait for.
      const approvedPatch = applyApprovalApprovedState(task, board);
      await task.update(
        {
          ...approvedPatch,
          approvalStatus: 'approved',
          approvalChain: auditChain,
        },
        { transaction: t }
      );
    } else {
      const auditChain = appendChainAudit(task, {
        userId: req.user.id,
        userName: req.user.name,
        action: 'submitted',
        comment: sanitizedComment,
      });
      // Lifecycle: snapshot current status/progress, set status to Waiting for
      // Review, progress to 100. Board row reflects the new state immediately
      // — no manual flip required by the user.
      const submittedPatch = applyApprovalSubmittedState(task, board);
      await task.update(
        {
          ...submittedPatch,
          approvalStatus: 'pending_approval',
          approvalChain: auditChain,
        },
        { transaction: t }
      );
    }

    await t.commit();

    // Reload chain rows for response (post-commit so includes are clean).
    const flows = await loadChainForResponse(task.id);

    // Activity + socket are post-commit, fire-and-forget.
    logActivity({
      action: autoApprove ? 'task_auto_approved' : 'task_submitted_approval',
      description: autoApprove
        ? `${req.user.name} submitted "${task.title}" — auto-approved (no reviewer)`
        : `${req.user.name} submitted "${task.title}" for approval`,
      entityType: 'task',
      entityId: task.id,
      taskId: task.id,
      boardId: task.boardId,
      userId: req.user.id,
      meta: { warnings },
    });

    realtime.emitApprovalChanged(task, flows, { actorId: req.user.id });

    // Phase 4 will replace this stub with proper notification dispatch. For now
    // we keep behavior parity with the old controller: notify watchers + the
    // current pending approver.
    notifyApprovalChange({
      task,
      actorId: req.user.id,
      actorName: req.user.name,
      flows,
      changeType: autoApprove ? 'auto_approved' : 'submitted',
      comment: sanitizedComment,
    }).catch((e) => console.error('[Approval] notify error:', e.message));

    res.json({ success: true, data: { task, approvalFlows: flows, warnings } });
  } catch (err) {
    if (!t.finished) await t.rollback();
    console.error('[Approval] submitForApproval error:', err);
    const { status, body } = buildErrorResponse(err, 'Failed to submit for approval.');
    res.status(status).json(body);
  }
};

// ─── POST /api/task-extras/:id/approve ──────────────────────────────────────
//
// Approves the current pending level. If more levels remain, advances the chain
// (the next pending row was already in 'pending' state — no DB change needed,
// just notify). If this was the final level, marks task approvalStatus=approved
// and main status='done'.
exports.approveTask = async (req, res) => {
  return processApprovalAction(req, res, {
    action: 'approve',
    actorRequiresComment: false,
    auditAction: 'approved',
  });
};

// ─── POST /api/task-extras/:id/reject ───────────────────────────────────────
//
// Rejects the current level. Per spec: "send back to previous level". If the
// rejecter is at level 1, "previous" is the submitter — task.approvalStatus
// becomes 'rejected' and the submitter must re-submit. If rejecter is level
// >=2, the previous-level approver is reset to 'pending' for re-review.
exports.rejectTask = async (req, res) => {
  return processApprovalAction(req, res, {
    action: 'reject',
    actorRequiresComment: true,
    auditAction: 'rejected',
  });
};

// ─── POST /api/task-extras/:id/request-changes ──────────────────────────────
//
// Stops the approval cycle and bounces back to the submitter with required
// commentary. Submitter must re-submit (which rebuilds the chain from scratch).
exports.requestChanges = async (req, res) => {
  return processApprovalAction(req, res, {
    action: 'request_changes',
    actorRequiresComment: true,
    auditAction: 'changes_requested',
  });
};

// Shared transactional handler for approve/reject/request_changes. Locks the
// task row, verifies the actor is the current approver, mutates the relevant
// flow rows, updates task.approvalStatus, and emits a single response.
async function processApprovalAction(req, res, opts) {
  const { comment } = req.body || {};
  if (opts.actorRequiresComment && (!comment || !String(comment).trim())) {
    return res.status(400).json({ success: false, message: 'A comment is required.' });
  }
  const sanitizedComment = comment ? xss(String(comment).slice(0, 2000)) : '';

  const t = await sequelize.transaction();
  try {
    const task = await Task.findByPk(req.params.id, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!task) {
      await t.rollback();
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }
    if (task.approvalStatus !== 'pending_approval') {
      await t.rollback();
      return res.status(409).json({
        success: false,
        message: 'Task is not currently pending approval.',
      });
    }

    // Find every pending row in the LOWEST pending stage (parallel-aware).
    // A stage may have multiple approvers (e.g. final stage = Manager + Admin
    // + Super Admin). Locks all rows in the stage so concurrent peers serialize.
    const stageRows = await findCurrentStageRows(task.id, t);
    const pendingStageRows = stageRows.filter((r) => r.status === 'pending');
    if (pendingStageRows.length === 0) {
      await t.rollback();
      return res.status(409).json({
        success: false,
        message: 'No pending approval step found. Chain may be in an inconsistent state.',
      });
    }
    const currentStage = stageOf(pendingStageRows[0]);

    // Self-approval guard. The submitter is recorded at level 0 of the
    // approval chain; they must never be able to act on their own submission.
    // Today this is implicitly prevented because approvalChainService excludes
    // the submitter from approver positions, but a regression there would
    // silently turn into a self-approval bug — so we enforce it explicitly.
    const submitterRow = await TaskApprovalFlow.findOne({
      where: { taskId: task.id, level: 0 },
      attributes: ['userId'],
      transaction: t,
    });
    if (submitterRow && String(submitterRow.userId) === String(req.user.id)) {
      await t.rollback();
      return res.status(403).json({
        success: false,
        message: 'You cannot act on a task you submitted for approval.',
      });
    }

    // Authorization. Single source of truth: approvalCapabilityService computes
    // {canApprove,canReject,canRequestChanges,isOverrideApprover,canApproveEarly}
    // from the loaded chain. We then resolve `actorRow` for whichever path the
    // service authorized — including synthesizing a row for Super Admin override
    // when the SA doesn't yet have a place in the chain.
    //
    //   path 1 — current-stage approver        : full action set
    //   path 2 — higher-stage pending approver  : full action set, early action
    //                                              (reject / request_changes are
    //                                              treated as terminal — see
    //                                              the corresponding branches)
    //   path 3 — Super Admin override            : full action set; we insert a
    //                                              synthetic flow row at the
    //                                              current stage so the audit
    //                                              trail records the decision
    //
    // Snapshot ALL chain rows once for the capability calc. We already hold the
    // task row lock; loading rows here is safe and gives us a stable view.
    const allChainRowsForCapability = await TaskApprovalFlow.findAll({
      where: { taskId: task.id },
      order: [
        [sequelize.literal('COALESCE(stage, level)'), 'ASC'],
        ['level', 'ASC'],
      ],
      transaction: t,
    });
    const capabilities = computeApprovalCapabilities({
      task,
      flows: allChainRowsForCapability.map((r) => ({
        id: r.id,
        level: r.level,
        stage: stageOf(r),
        userId: r.userId,
        userName: r.userName,
        status: r.status,
      })),
      user: req.user,
    });
    const capabilityKey = {
      approve: 'canApprove',
      reject: 'canReject',
      request_changes: 'canRequestChanges',
    }[opts.action];
    if (!capabilities[capabilityKey]) {
      await t.rollback();
      return res.status(403).json({
        success: false,
        message:
          capabilities.reasonIfCannotAct ||
          (opts.action === 'approve'
            ? 'You are not in this approval chain.'
            : 'You are not a current approver for this task.'),
      });
    }

    // Resolve actorRow. Order matters:
    //   1. pending row in the current stage  → straightforward current approver
    //   2. pending row in a HIGHER stage     → early action (isEarlyCompletion)
    //   3. SA with no row at all             → synthesize at current stage
    let actorRow = pendingStageRows.find((r) => r.userId === req.user.id) || null;
    let isEarlyCompletion = false;
    let isOverride = false;
    if (!actorRow) {
      actorRow = await TaskApprovalFlow.findOne({
        where: { taskId: task.id, status: 'pending', userId: req.user.id },
        order: [
          [sequelize.literal('COALESCE(stage, level)'), 'ASC'],
          ['level', 'ASC'],
        ],
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (actorRow) isEarlyCompletion = true;
    }
    if (!actorRow && capabilities.isOverrideApprover) {
      // Super Admin override path. SA isn't in the chain at all — typically only
      // happens when the SA was added or promoted after the chain was built.
      // We persist a fresh row at the current stage so audit, notifications, and
      // peer-skipping logic all see a real actor row to operate on.
      const maxLevelRow = await TaskApprovalFlow.findOne({
        where: { taskId: task.id },
        order: [['level', 'DESC']],
        attributes: ['level'],
        transaction: t,
      });
      const newLevel = (maxLevelRow ? maxLevelRow.level : 0) + 1;
      actorRow = await TaskApprovalFlow.create(
        {
          taskId: task.id,
          userId: req.user.id,
          userName: req.user.name,
          // Synthetic role marker — distinguishes override rows from genuine
          // chain membership in the audit trail.
          role: 'super_admin_override',
          level: newLevel,
          stage: currentStage,
          status: 'pending',
        },
        { transaction: t }
      );
      isOverride = true;
    }
    if (!actorRow) {
      // Defensive: capabilities said yes but we couldn't resolve a row. Log so
      // we can investigate; never reach here in practice.
      await t.rollback();
      console.error('[Approval] capability/actor mismatch', {
        taskId: task.id,
        userId: req.user.id,
        action: opts.action,
        capabilities,
      });
      return res.status(500).json({
        success: false,
        message: 'Internal error resolving approval actor.',
      });
    }

    const now = new Date();
    let resultingTaskStatus = null;       // updates to task.status (e.g., 'done')
    let resultingApprovalStatus = task.approvalStatus;

    if (opts.action === 'approve') {
      // Early-completion path: a higher-stage approver signs off, which
      // auto-approves every still-pending row in lower stages. The full chain
      // remains visible in the timeline; only the completion is short-circuited.
      if (isEarlyCompletion) {
        await TaskApprovalFlow.update(
          {
            status: 'approved',
            actionAt: now,
            comment: `Auto-approved due to early completion by ${req.user.name}`,
          },
          {
            where: {
              taskId: task.id,
              status: 'pending',
              [Op.and]: [
                sequelize.where(sequelize.literal('COALESCE(stage, level)'), { [Op.lt]: stageOf(actorRow) }),
              ],
            },
            transaction: t,
          }
        );
      }
      // The actor's own row gets THEIR comment, not the auto note.
      await actorRow.update(
        { status: 'approved', comment: sanitizedComment, actionAt: now },
        { transaction: t }
      );

      // Parallel any-of: skip every peer in the actor's stage. They're not
      // pending forever — they reach a clean terminal state with an audit note.
      const myStage = stageOf(actorRow);
      const peerIdsInMyStage = pendingStageRows
        .filter((r) => r.id !== actorRow.id && stageOf(r) === myStage)
        .map((r) => r.id);
      // For early completion the actor's stage may not be the current stage; in
      // that case load and skip peers in actor's actual stage too.
      const additionalPeerIds = isEarlyCompletion
        ? (
            await TaskApprovalFlow.findAll({
              where: {
                taskId: task.id,
                status: 'pending',
                userId: { [Op.ne]: req.user.id },
                [Op.and]: [
                  sequelize.where(sequelize.literal('COALESCE(stage, level)'), myStage),
                ],
              },
              attributes: ['id'],
              transaction: t,
            })
          ).map((r) => r.id)
        : [];
      const allPeerIds = [...new Set([...peerIdsInMyStage, ...additionalPeerIds])];
      if (allPeerIds.length > 0) {
        await TaskApprovalFlow.update(
          {
            status: 'skipped_parallel',
            actionAt: now,
            comment: `Auto-skipped: stage approved by ${req.user.name}.`,
          },
          { where: { id: { [Op.in]: allPeerIds } }, transaction: t }
        );
      }

      // Super Admin override approve: SA was not in the chain so we synthesized
      // a row at the current stage. Their authority is full — every still-pending
      // row in HIGHER stages is auto-skipped so the chain completes here, not
      // advances to a stage SA was never in.
      if (isOverride) {
        await TaskApprovalFlow.update(
          {
            status: 'skipped_parallel',
            actionAt: now,
            comment: `Auto-skipped: Super Admin override approval by ${req.user.name}.`,
          },
          {
            where: {
              taskId: task.id,
              status: 'pending',
              id: { [Op.ne]: actorRow.id },
            },
            transaction: t,
          }
        );
      }

      // Final approval check: any pending rows left in the entire chain?
      const remaining = await TaskApprovalFlow.count({
        where: { taskId: task.id, status: 'pending' },
        transaction: t,
      });
      if (remaining === 0) {
        // Chain fully approved — task goes done + approvalStatus=approved.
        resultingApprovalStatus = 'approved';
        resultingTaskStatus = 'done';
      }
      // else: a later stage's pending row remains — chain continues.
    } else if (opts.action === 'reject') {
      const peerIdsInMyStage = pendingStageRows.filter((r) => r.id !== actorRow.id).map((r) => r.id);

      // Terminal rejection paths:
      //   - currentStage <= 1: rejecting at stage 1 ends the cycle (existing rule)
      //   - isEarlyCompletion (higher-stage actor): an authority above the current
      //     stage said no — bouncing to the previous stage is meaningless because
      //     they bypassed it.
      //   - isOverride (Super Admin override): always terminal.
      //   - req.user.isSuperAdmin: SA reject is always terminal authority,
      //     regardless of where they sit in the chain.
      const isTerminalReject =
        isEarlyCompletion || isOverride || req.user.isSuperAdmin || currentStage <= 1;

      if (isTerminalReject) {
        // Cancel every still-pending row in the chain (across all stages) so
        // the chain's terminal state is consistent. Submitter will rebuild via
        // re-submit if they choose to retry; until then nothing in the chain
        // sits in a stale 'pending' state.
        const allOtherPending = (
          await TaskApprovalFlow.findAll({
            where: {
              taskId: task.id,
              status: 'pending',
              id: { [Op.ne]: actorRow.id },
            },
            attributes: ['id'],
            transaction: t,
          })
        ).map((r) => r.id);
        if (allOtherPending.length > 0) {
          await TaskApprovalFlow.update(
            {
              status: 'cancelled_peer',
              actionAt: now,
              comment: `Stage cancelled: ${req.user.name} rejected.`,
            },
            { where: { id: { [Op.in]: allOtherPending } }, transaction: t }
          );
        }
        await actorRow.update(
          { status: 'rejected', comment: sanitizedComment, actionAt: now },
          { transaction: t }
        );
        resultingApprovalStatus = 'rejected';
      } else {
        // Bounce back one stage. The rejection itself is captured in
        // approvalChain JSONB + Activity log; the row data is reset so the
        // stage is fresh when the previous stage re-approves.
        //
        // Implementation: reset BOTH the current stage rows AND the previous
        // stage rows to 'pending'. Keeping the rejected row as 'rejected'
        // would leave the parallel stage with one rejected + others cancelled,
        // and after S-1 re-approves the count of pending rows would be 0 —
        // auto-completing the task incorrectly. Resetting the whole stage
        // keeps the cycle navigable.
        void peerIdsInMyStage;
        await TaskApprovalFlow.update(
          { status: 'pending', actionAt: null, comment: null },
          {
            where: {
              taskId: task.id,
              [Op.and]: [
                sequelize.where(
                  sequelize.literal('COALESCE(stage, level)'),
                  { [Op.in]: [currentStage - 1, currentStage] }
                ),
              ],
            },
            transaction: t,
          }
        );
        // Approval status stays 'pending_approval' — the chain is still active.
      }
    } else if (opts.action === 'request_changes') {
      // Request-changes is terminal disposition: the chain stops, the submitter
      // must re-submit. So cancel every other pending row across the whole
      // chain (not just same-stage peers). For a current-stage actor this is
      // identical to the previous behavior (no rows pending in lower or higher
      // stages); for higher-stage / SA override it correctly tears down lower
      // stages too.
      const allOtherPending = (
        await TaskApprovalFlow.findAll({
          where: {
            taskId: task.id,
            status: 'pending',
            id: { [Op.ne]: actorRow.id },
          },
          attributes: ['id'],
          transaction: t,
        })
      ).map((r) => r.id);
      if (allOtherPending.length > 0) {
        await TaskApprovalFlow.update(
          {
            status: 'cancelled_peer',
            actionAt: now,
            comment: `Stage cancelled: ${req.user.name} requested changes.`,
          },
          { where: { id: { [Op.in]: allOtherPending } }, transaction: t }
        );
      }
      await actorRow.update(
        { status: 'changes_requested', comment: sanitizedComment, actionAt: now },
        { transaction: t }
      );
      resultingApprovalStatus = 'changes_requested';
    }

    const auditChain = appendChainAudit(task, {
      userId: req.user.id,
      userName: req.user.name,
      action: opts.auditAction,
      comment: sanitizedComment,
    });

    // Lifecycle transitions for the visible task fields (status / progress /
    // groupId). Loaded once here so each action branch only declares the
    // patch it needs. Board attributes are minimal — `columns` for label
    // resolution, `groups` for group movement.
    const board = task.boardId
      ? await Board.findByPk(task.boardId, { attributes: ['id', 'columns', 'groups'], transaction: t })
      : null;

    let lifecyclePatch = {};
    if (resultingApprovalStatus === 'approved') {
      // Final approval: status='done', progress=100, group→Done, snapshot cleared.
      lifecyclePatch = applyApprovalApprovedState(task, board);
    } else if (resultingApprovalStatus === 'rejected') {
      // Terminal reject: restore snapshot (or fall back to Not Started / 0).
      lifecyclePatch = applyApprovalRejectedState(task, board);
    } else if (resultingApprovalStatus === 'changes_requested') {
      // Bounced back to submitter: restore snapshot (or fall back to Not Started / 0).
      lifecyclePatch = applyApprovalChangesRequestedState(task, board);
    }
    // else: chain still active (mid-stage approve), no field changes needed.

    const taskUpdates = {
      ...lifecyclePatch,
      approvalStatus: resultingApprovalStatus,
      approvalChain: auditChain,
    };
    // resultingTaskStatus is the legacy single-key signal. The lifecycle
    // patch above already supplies status when relevant; keep this as a
    // safety net for any path that sets resultingTaskStatus without going
    // through the lifecycle (none currently, but defensive).
    if (resultingTaskStatus && !taskUpdates.status) taskUpdates.status = resultingTaskStatus;
    await task.update(taskUpdates, { transaction: t });

    await t.commit();

    const flows = await loadChainForResponse(task.id);

    logActivity({
      action: `task_${opts.auditAction}`,
      description: isEarlyCompletion
        ? `${req.user.name} approved "${task.title}" (early completion at L${actorRow.level}, skipped lower pending stages)`
        : `${req.user.name} ${opts.auditAction.replace('_', ' ')} "${task.title}"`,
      entityType: 'task',
      entityId: task.id,
      taskId: task.id,
      boardId: task.boardId,
      userId: req.user.id,
      meta: {
        fromLevel: actorRow.level,
        fromStage: stageOf(actorRow),
        currentStage,
        parallel: pendingStageRows.length > 1,
        earlyCompletion: isEarlyCompletion,
      },
    });

    realtime.emitApprovalChanged(task, flows, { actorId: req.user.id });

    notifyApprovalChange({
      task,
      actorId: req.user.id,
      actorName: req.user.name,
      flows,
      changeType: opts.auditAction,
      comment: sanitizedComment,
      fromLevel: actorRow.level,
      fromStage: stageOf(actorRow),
    }).catch((e) => console.error('[Approval] notify error:', e.message));

    res.json({ success: true, data: { task, approvalFlows: flows } });
  } catch (err) {
    if (!t.finished) await t.rollback();
    console.error(`[Approval] ${opts.action} error:`, err);
    const { status, body } = buildErrorResponse(err, `Failed to ${opts.action.replace('_', ' ')}.`);
    res.status(status).json(body);
  }
}

// Dispatcher: maps a controller event into the right approvalNotificationService
// calls. Pure orchestration — channel logic lives in the service. Always
// fire-and-forget from the caller's perspective; we await internally so
// failures get logged but never bubble up to the response.
//
// Parallel-stage aware: when a stage activates, ALL members of that stage are
// notified (not just one). When a stage closes (any-of approval), the actor +
// remaining downstream approvers are the relevant recipients.
async function notifyApprovalChange({ task, actorId, actorName, flows, changeType, comment, fromLevel, fromStage }) {
  const submitterRow = flows.find((r) => r.level === 0);
  // Lowest pending stage = the next active step (single user or parallel set).
  const pendingRows = flows.filter((r) => r.status === 'pending');
  const nextStageValue = pendingRows.length > 0
    ? Math.min(...pendingRows.map((r) => (r.stage != null ? r.stage : r.level)))
    : null;
  const nextStageRows = nextStageValue != null
    ? pendingRows.filter((r) => (r.stage != null ? r.stage : r.level) === nextStageValue)
    : [];
  // Single-row alias for the existing approvalNotif API which still accepts
  // one approver per call. We loop and call once per parallel member so each
  // approver gets their own DM/email.
  const nextApproverPrimary = nextStageRows[0] || null;

  try {
    if (changeType === 'submitted') {
      for (const row of nextStageRows) {
        await approvalNotif.notifySubmitted({
          task,
          submitterName: actorName,
          nextApprover: row,
          comment,
        });
      }
      // Edge case: empty stage (autoApprove path won't arrive here, but defensive).
      if (nextStageRows.length === 0 && nextApproverPrimary) {
        await approvalNotif.notifySubmitted({
          task, submitterName: actorName, nextApprover: nextApproverPrimary, comment,
        });
      }
    } else if (changeType === 'approved') {
      // Either chain advanced (a later stage is now pending) OR final approval.
      if (nextStageRows.length > 0) {
        for (const row of nextStageRows) {
          await approvalNotif.notifyAdvanced({
            task,
            fromApproverName: actorName,
            nextApprover: row,
          });
        }
      } else {
        await approvalNotif.notifyCompleted({
          task,
          finalApproverName: actorName,
          submitter: submitterRow,
          creatorId: task.createdBy && task.createdBy !== submitterRow?.userId ? task.createdBy : null,
        });
      }
    } else if (changeType === 'rejected') {
      // Recipient is the previous stage's approvers (or the submitter if rejecting at stage 1).
      const toStage = (fromStage || 1) - 1;
      const recipients = toStage <= 0
        ? (submitterRow ? [submitterRow] : [])
        : flows.filter((r) => (r.stage != null ? r.stage : r.level) === toStage);
      for (const recipient of recipients) {
        await approvalNotif.notifyRejected({
          task,
          rejecterName: actorName,
          recipient,
          comment,
          toLevel: recipient.level,
        });
      }
    } else if (changeType === 'changes_requested') {
      await approvalNotif.notifyChangesRequested({
        task,
        requesterName: actorName,
        submitter: submitterRow,
        comment,
      });
    } else if (changeType === 'auto_approved') {
      await approvalNotif.notifyAutoApproved({ task, submitter: submitterRow });
    }
  } catch (e) {
    console.error('[Approval] event dispatch failed:', e.message);
  }

  // Watchers always get a passive ping (in-app only — service handles dedup).
  approvalNotif.notifyWatchers({ task, actorId, eventType: changeType, actorName }).catch((e) =>
    console.warn('[Approval] watchers notify failed:', e.message)
  );
}

// ─── GET /api/task-extras/approval-preview ──────────────────────────────────
//
// Returns who would review the calling user's submission if they marked a task
// done right now. Used by the bottom-sheet modal to show "Next: Sarah Manager"
// before the user clicks Submit. Pure derivation, no DB writes.
exports.getApprovalPreview = async (req, res) => {
  try {
    // Super Admin sees no approval flow at all — short-circuit so the bottom
    // sheet doesn't render an approver list and so the modal can render the
    // "no approval needed" hint instead.
    if (req.user.isSuperAdmin) {
      return res.json({
        success: true,
        data: { autoApprove: true, nextApprover: null, nextStage: null, reason: 'super_admin' },
      });
    }
    const next = await previewNextApprover(req.user.id);
    if (!next) {
      // No senior reviewer in chain — submission would auto-approve.
      return res.json({
        success: true,
        data: { autoApprove: true, nextApprover: null, nextStage: null },
      });
    }
    // `next` is the new stage shape: { stage, isParallel, approvers: [...] }.
    // Keep `nextApprover` (single user) for back-compat with any old client;
    // also expose the full stage so the bottom-sheet can render parallel sets.
    const primary = next.approvers[0] || null;
    res.json({
      success: true,
      data: {
        autoApprove: false,
        nextApprover: primary
          ? { userId: primary.userId, userName: primary.userName, role: primary.role }
          : null,
        nextStage: {
          stage: next.stage,
          isParallel: !!next.isParallel,
          approvers: next.approvers.map((a) => ({
            userId: a.userId,
            userName: a.userName,
            role: a.role,
            isSuperAdmin: !!a.isSuperAdmin,
          })),
        },
      },
    });
  } catch (err) {
    console.error('[Approval] getApprovalPreview error:', err);
    res.status(500).json({ success: false, message: 'Failed to load approval preview.' });
  }
};

// ─── GET /api/task-extras/:id/approval-chain ────────────────────────────────
//
// Returns the full ordered chain for a task. Used by the Approvals tab in the
// task modal (Phase 7) and the multi-step indicator on the task row (Phase 6).
//
// Includes `myCapabilities` so the modal renders Approve/Reject/Request Changes
// buttons strictly from server-supplied flags. Frontend never re-derives auth
// — eliminates the "buttons visible but click 403s" class of bug.
exports.getApprovalChain = async (req, res) => {
  try {
    const task = await Task.findByPk(req.params.id, { attributes: ['id', 'boardId', 'approvalStatus'] });
    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
    const flows = await loadChainForResponse(task.id);
    const myCapabilities = computeApprovalCapabilities({ task, flows, user: req.user });
    res.json({
      success: true,
      data: {
        taskId: task.id,
        approvalStatus: task.approvalStatus,
        flows,
        myCapabilities,
      },
    });
  } catch (err) {
    console.error('[Approval] getApprovalChain error:', err);
    res.status(500).json({ success: false, message: 'Failed to load approval chain.' });
  }
};

// ─── GET /api/task-extras/pending-approvals ─────────────────────────────────
//
// Returns tasks where the CURRENT approver is the calling user (not just
// "tasks somewhere in approval"). Used by the manager's home dashboard.
exports.getPendingApprovals = async (req, res) => {
  try {
    // 1. Find every task where caller has a 'pending' row.
    const myPending = await TaskApprovalFlow.findAll({
      where: { userId: req.user.id, status: 'pending' },
      attributes: ['taskId', 'level', 'stage'],
      raw: true,
    });

    // 2. Keep only tasks where the caller's row is in the LOWEST pending stage
    //    (i.e., it's actually their turn — including any-of parallel stages
    //    where multiple users share the same stage value).
    const taskIds = [];
    for (const row of myPending) {
      const myStage = row.stage != null ? row.stage : row.level;
      const lower = await TaskApprovalFlow.count({
        where: {
          taskId: row.taskId,
          status: 'pending',
          [Op.and]: [
            sequelize.where(sequelize.literal('COALESCE(stage, level)'), { [Op.lt]: myStage }),
          ],
        },
      });
      if (lower === 0) taskIds.push(row.taskId);
    }

    if (taskIds.length === 0) {
      return res.json({ success: true, data: { tasks: [] } });
    }

    const tasks = await Task.findAll({
      where: { id: { [Op.in]: taskIds }, isArchived: false },
      include: [
        { model: User, as: 'assignee', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: User, as: 'creator', attributes: ['id', 'name'] },
        { model: TaskApprovalFlow, as: 'approvalFlows', separate: true, order: [['level', 'ASC']] },
      ],
      order: [['updatedAt', 'DESC']],
    });
    res.json({ success: true, data: { tasks } });
  } catch (err) {
    console.error('[Approval] getPendingApprovals error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch pending approvals.' });
  }
};

// ─── GET /api/task-extras/my-feedback ───────────────────────────────────────
//
// Returns approval submissions made by the calling user (and, for non-members,
// optionally their direct reports' submissions). Powers the "My Feedback" tab
// on Tasks & Workflows so submitters can see what they sent up the chain and
// what's been done with it — visibility the approvals tab never gave them.
//
// Source of truth: TaskApprovalFlow rows where level=0 (the submitter row).
// The controller hydrates each with the rest of the chain so the UI can render
// the timeline, current approver, and stage label without N+1 calls.
//
// Query params:
//   ?status=pending|approved|rejected|changes_requested|all   (default: all)
//   ?scope=mine|team|all                                       (default: mine
//          for member; mine+team for assistant_manager+; all gated to managers)
//
// Auth: any authenticated user. Role gating is on the data filter, not the route.
exports.getMyFeedback = async (req, res) => {
  try {
    const user = req.user;
    const requestedStatus = (req.query.status || 'all').toLowerCase();
    const requestedScope = (req.query.scope || '').toLowerCase();

    // Resolve which submitter user-ids to include based on role.
    const submitterIds = new Set([user.id]);

    const isPrivileged = user.role === 'admin' || user.role === 'manager' || user.isSuperAdmin;
    const isAssistantManager = user.role === 'assistant_manager';
    const scopeAllowsTeam =
      requestedScope === 'team' ||
      requestedScope === 'all' ||
      (requestedScope === '' && (isPrivileged || isAssistantManager));

    if (scopeAllowsTeam) {
      // Direct reports via User.managerId.
      const reports = await User.findAll({
        where: { managerId: user.id },
        attributes: ['id'],
        raw: true,
      });
      reports.forEach((r) => submitterIds.add(r.id));

      // Direct reports via manager_relations (the multi-manager junction).
      // Wrapped in try/catch — older envs may not have this table populated.
      try {
        const { ManagerRelation } = require('../models');
        const relRows = await ManagerRelation.findAll({
          where: { managerId: user.id },
          attributes: ['employeeId'],
          raw: true,
        });
        relRows.forEach((r) => submitterIds.add(r.employeeId));
      } catch (e) {
        // ignore — optional source
      }
    }

    // scope=all is only honored for admin/manager/superAdmin. Anyone else asking
    // for 'all' silently degrades to mine+team (their submitterIds set above).
    if (requestedScope === 'all' && isPrivileged) {
      submitterIds.clear(); // Empty set => no userId filter => org-wide.
    }

    // Build the level-0 row filter. This is the "feedback record" — one row per
    // submission cycle per task. (Re-submissions wipe and rebuild flow rows, so
    // a task always has at most one current level-0 row.)
    const submitterWhere = { level: 0 };
    if (submitterIds.size > 0) submitterWhere.userId = { [Op.in]: Array.from(submitterIds) };

    const submitterRows = await TaskApprovalFlow.findAll({
      where: submitterWhere,
      include: [
        {
          model: User,
          as: 'user',
          attributes: ['id', 'name', 'avatar', 'role'],
          required: false,
        },
        {
          model: Task,
          as: 'task',
          required: false, // tolerate task deletion (FK is CASCADE so usually rows are gone, but guard anyway)
          attributes: ['id', 'title', 'boardId', 'approvalStatus', 'isArchived', 'status'],
          include: [{ model: Board, as: 'board', attributes: ['id', 'name', 'color'] }],
        },
      ],
      order: [['updatedAt', 'DESC']],
      limit: 200,
    });

    if (submitterRows.length === 0) {
      return res.json({ success: true, data: { feedback: [] } });
    }

    // One round-trip to fetch all sibling chain rows for these tasks. Cheaper
    // than per-task includes; the (taskId, status) index covers it.
    const taskIds = submitterRows.map((r) => r.taskId);
    const allFlows = await TaskApprovalFlow.findAll({
      where: { taskId: { [Op.in]: taskIds } },
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'avatar', 'role'], required: false }],
      order: [['taskId', 'ASC'], ['level', 'ASC']],
    });

    // Group sibling rows by taskId for O(1) lookup while shaping responses.
    const flowsByTask = new Map();
    for (const row of allFlows) {
      if (!flowsByTask.has(row.taskId)) flowsByTask.set(row.taskId, []);
      flowsByTask.get(row.taskId).push(row);
    }

    const items = submitterRows.map((submitterRow) => {
      const chain = flowsByTask.get(submitterRow.taskId) || [];
      const approverRows = chain.filter((r) => r.level > 0);
      const stageOfRow = (r) => (r.stage != null ? r.stage : r.level);

      // All pending approver rows in the lowest pending stage. >1 means a
      // parallel any-of stage (e.g. final stage = Manager + Admin + Super Admin).
      const pendingApproverRows = approverRows.filter((r) => r.status === 'pending');
      const lowestPendingStage = pendingApproverRows.length > 0
        ? Math.min(...pendingApproverRows.map(stageOfRow))
        : null;
      const currentStageRows = lowestPendingStage != null
        ? pendingApproverRows.filter((r) => stageOfRow(r) === lowestPendingStage)
        : [];
      const currentPending = currentStageRows[0] || null;

      // Decisive action rows (approved/rejected/changes_requested) ordered by
      // actionAt desc. Used for actionTakenAt + finalDecision derivation.
      const decided = approverRows
        .filter((r) => ['approved', 'rejected', 'changes_requested'].includes(r.status) && r.actionAt)
        .sort((a, b) => new Date(b.actionAt) - new Date(a.actionAt));

      const taskApprovalStatus = submitterRow.task?.approvalStatus || null;

      // Status mapping: prefer the task's overall approvalStatus when terminal,
      // otherwise reflect the chain state. 'pending_approval' is normalized to
      // 'pending' for the UI's filter pills.
      let statusLabel;
      if (taskApprovalStatus === 'approved') statusLabel = 'approved';
      else if (taskApprovalStatus === 'rejected') statusLabel = 'rejected';
      else if (taskApprovalStatus === 'changes_requested') statusLabel = 'changes_requested';
      else if (currentPending) statusLabel = 'pending';
      else if (taskApprovalStatus === 'pending_approval') statusLabel = 'pending';
      else statusLabel = taskApprovalStatus || 'pending';

      // Approved-stage count: a stage is "approved" if any row in it is
      // status='approved' (parallel any-of) or if all sequential rows are.
      const distinctStageValues = [...new Set(approverRows.map(stageOfRow))].sort((a, b) => a - b);
      const approvedStages = distinctStageValues.filter((s) =>
        approverRows.some((r) => stageOfRow(r) === s && r.status === 'approved')
      ).length;
      const totalStages = distinctStageValues.length;

      // Human-readable stage label for the UI's "where is it now" column.
      let stageLabel;
      if (statusLabel === 'approved') {
        stageLabel = 'Fully approved';
      } else if (statusLabel === 'rejected') {
        const lastReject = decided.find((r) => r.status === 'rejected');
        stageLabel = lastReject
          ? `Rejected by ${lastReject.user?.name || lastReject.userName || 'reviewer'}`
          : 'Rejected';
      } else if (statusLabel === 'changes_requested') {
        const lastReq = decided.find((r) => r.status === 'changes_requested');
        stageLabel = lastReq
          ? `Changes requested by ${lastReq.user?.name || lastReq.userName || 'reviewer'}`
          : 'Changes requested';
      } else if (currentStageRows.length > 1) {
        // Parallel any-of stage in progress.
        const names = currentStageRows
          .map((r) => r.user?.name || r.userName || 'reviewer')
          .slice(0, 3);
        const more = currentStageRows.length - names.length;
        const list = more > 0 ? `${names.join(', ')} +${more}` : names.join(', ');
        stageLabel = approvedStages > 0
          ? `Approved by ${approvedStages} of ${totalStages} stages, final stage: any of ${list}`
          : `Final stage: any of ${list}`;
      } else if (currentPending) {
        const approverLabel = currentPending.user?.name || currentPending.userName || 'reviewer';
        stageLabel = approvedStages > 0
          ? `Approved by ${approvedStages} of ${totalStages} stages, waiting for ${approverLabel}`
          : `Waiting for ${approverLabel}`;
      } else {
        stageLabel = 'No pending stage';
      }

      const finalDecision =
        statusLabel === 'approved' || statusLabel === 'rejected' || statusLabel === 'changes_requested'
          ? statusLabel
          : null;

      const actionTakenAt = decided[0]?.actionAt || null;

      return {
        id: submitterRow.id,
        taskId: submitterRow.taskId,
        boardId: submitterRow.task?.boardId || null,
        submittedBy: {
          id: submitterRow.userId,
          name: submitterRow.user?.name || submitterRow.userName || '(deleted user)',
          avatar: submitterRow.user?.avatar || null,
          role: submitterRow.user?.role || submitterRow.role || null,
        },
        comment: submitterRow.comment || '',
        attachmentUrl: submitterRow.attachmentUrl || null,
        submittedAt: submitterRow.actionAt || submitterRow.createdAt,
        status: statusLabel,
        stageLabel,
        currentApprover: currentPending
          ? {
              userId: currentPending.userId,
              name: currentPending.user?.name || currentPending.userName || '(deleted user)',
              avatar: currentPending.user?.avatar || null,
              role: currentPending.user?.role || currentPending.role || null,
              level: currentPending.level,
            }
          : null,
        // Parallel-stage-aware: when the current step is an any-of stage,
        // expose every member so the UI can show the whole set.
        currentStage: currentStageRows.length > 0
          ? {
              stage: lowestPendingStage,
              isParallel: currentStageRows.length > 1,
              approvers: currentStageRows.map((r) => ({
                userId: r.userId,
                name: r.user?.name || r.userName || '(deleted user)',
                avatar: r.user?.avatar || null,
                role: r.user?.role || r.role || null,
                level: r.level,
              })),
            }
          : null,
        finalDecision,
        actionTakenAt,
        task: submitterRow.task
          ? {
              id: submitterRow.task.id,
              title: submitterRow.task.title,
              boardId: submitterRow.task.boardId,
              isArchived: !!submitterRow.task.isArchived,
              status: submitterRow.task.status,
              approvalStatus: submitterRow.task.approvalStatus,
              board: submitterRow.task.board
                ? {
                    id: submitterRow.task.board.id,
                    name: submitterRow.task.board.name,
                    color: submitterRow.task.board.color,
                  }
                : null,
            }
          : null,
        timeline: chain.map((r) => ({
          level: r.level,
          stage: stageOfRow(r),
          userId: r.userId,
          userName: r.user?.name || r.userName || '(deleted user)',
          userAvatar: r.user?.avatar || null,
          role: r.user?.role || r.role || null,
          status: r.status,
          comment: r.comment || '',
          actionAt: r.actionAt,
        })),
      };
    });

    const filtered =
      requestedStatus === 'all'
        ? items
        : items.filter((i) => i.status === requestedStatus);

    res.json({ success: true, data: { feedback: filtered } });
  } catch (err) {
    console.error('[Approval] getMyFeedback error:', err);
    res.status(500).json({ success: false, message: 'Failed to load feedback.' });
  }
};

// ─── GET /api/task-extras/workflow-items ────────────────────────────────────
//
// Aggregates approvals/extensions/delegations/help requests into one feed.
// Behavior preserved from the previous controller — augmented to include the
// new approvalFlows rows so the UI can render the new timeline if it wants.
exports.getWorkflowItems = async (req, res) => {
  try {
    const user = req.user;
    const isMember = user.role === 'member';

    const approvalWhere = { approvalStatus: { [Op.ne]: null }, isArchived: false };
    if (isMember) approvalWhere.assignedTo = user.id;
    const approvals = await Task.findAll({
      where: approvalWhere,
      include: [
        { model: User, as: 'assignee', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: User, as: 'creator', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: Board, as: 'board', attributes: ['id', 'name', 'color'] },
        { model: TaskApprovalFlow, as: 'approvalFlows', separate: true, order: [['level', 'ASC']] },
      ],
      order: [['updatedAt', 'DESC']],
      limit: 100,
    });
    // Per-task capability flags. Computed against the included approvalFlows so
    // the frontend renders Approve / Reject / Request Changes strictly from
    // server-supplied authorization. Without this, TasksPage renders buttons
    // from a coarse role check (canManage), which produces the classic
    // "Admin sees Request Changes button → click → 403" UX bug.
    const approvalsWithCapabilities = approvals.map((task) => {
      const taskJSON = task.toJSON();
      taskJSON.myCapabilities = computeApprovalCapabilities({
        task,
        flows: taskJSON.approvalFlows || [],
        user,
      });
      return taskJSON;
    });

    const extWhere = {};
    if (isMember) extWhere.requestedBy = user.id;
    const extensions = await DueDateExtension.findAll({
      where: extWhere,
      include: [
        { model: User, as: 'requester', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: User, as: 'reviewer', attributes: ['id', 'name'], required: false },
        { model: Task, as: 'task', attributes: ['id', 'title', 'boardId'], include: [{ model: Board, as: 'board', attributes: ['id', 'name', 'color'] }] },
      ],
      order: [['createdAt', 'DESC']],
      limit: 100,
    });

    const delegationWhere = { action: 'task_delegated' };
    if (isMember) delegationWhere.userId = user.id;
    const delegations = await Activity.findAll({
      where: delegationWhere,
      include: [
        { model: User, as: 'actor', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: Task, as: 'task', attributes: ['id', 'title', 'status', 'assignedTo'], required: false },
      ],
      order: [['createdAt', 'DESC']],
      limit: 50,
    });

    const helpWhere = {};
    if (isMember) helpWhere[Op.or] = [{ requestedBy: user.id }, { requestedTo: user.id }];
    const helpRequests = await HelpRequest.findAll({
      where: helpWhere,
      include: [
        { model: User, as: 'requester', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: User, as: 'helper', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: Task, as: 'task', attributes: ['id', 'title', 'boardId'], include: [{ model: Board, as: 'board', attributes: ['id', 'name', 'color'] }] },
      ],
      order: [['createdAt', 'DESC']],
      limit: 100,
    });

    res.json({
      success: true,
      data: { approvals: approvalsWithCapabilities, extensions, delegations, helpRequests },
    });
  } catch (err) {
    console.error('[WorkflowItems] Error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch workflow items.' });
  }
};
