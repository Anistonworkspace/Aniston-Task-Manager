/**
 * Recurring Template Controller — REST surface for the Daily Work / Recurring
 * Work workflow.
 *
 * NB: Distinct from the legacy `recurringTaskController.js`, which manages the
 * legacy `Task.recurrence` JSONB field (Phase 8 #53). That controller is left
 * untouched per spec; this file drives the new
 * RecurringTaskTemplate + generated-instance design.
 *
 * Authorization rules (enforced server-side, NEVER trusted from the client):
 *
 *   - Members may create a template only when assigneeId === createdBy === self.
 *     They cannot edit a template they didn't create, change the assignee on
 *     edit, or pause/archive someone else's template.
 *   - Managers / assistant managers may target any user inside their org
 *     subtree (via hierarchyService.canAssignTo). Edits keep the same check;
 *     reassigning out of subtree is rejected.
 *   - Admins / super admins may target anyone.
 */

const { Op } = require('sequelize');
const { validationResult } = require('express-validator');
const {
  RecurringTaskTemplate,
  Task,
  Board,
  User,
} = require('../models');
const recurringTaskService = require('../services/recurringTaskService');
const { canAssignTo } = require('../services/hierarchyService');
const { logActivity } = require('../services/activityService');
const { sanitizeInput } = require('../utils/sanitize');
const logger = require('../utils/logger');

// ─── Constants ──────────────────────────────────────────────────────────────

const VALID_FREQUENCIES = ['daily', 'weekdays', 'weekly', 'monthly', 'custom'];
const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical'];
const VALID_ESCALATION_TARGETS = ['assignee', 'manager', 'admin'];
const TEMPLATE_FIELDS_PUBLIC = [
  'id', 'title', 'description', 'boardId', 'groupId', 'assigneeId', 'createdBy',
  'priority', 'frequency', 'weekdays', 'dayOfMonth', 'daysOfMonth',
  'startDate', 'endDate',
  'dueTime', 'timezone', 'escalateIfMissed', 'escalationTargets', 'isActive',
  'lastGeneratedDate', 'nextRunAt', 'archivedAt', 'createdAt', 'updatedAt',
];

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Whether `actor` may set `assigneeId` on a recurring template.
 *
 * Mirrors task-creation rules:
 *   - Self-assign (assigneeId === actor.id): allowed for any role.
 *   - Members assigning to anyone else: denied.
 *   - Managers / assistant managers: subtree check via hierarchyService.
 *   - Admins / super admins: any active user.
 */
async function canTargetAssignee(actor, assigneeId) {
  if (!assigneeId) return { allowed: false, reason: 'assigneeId is required.' };
  if (String(assigneeId) === String(actor.id)) return { allowed: true };
  if (actor.role === 'member') {
    return {
      allowed: false,
      reason: 'Members can only create recurring work for themselves.',
    };
  }
  if (actor.role === 'admin' || actor.isSuperAdmin) return { allowed: true };

  // Manager / assistant_manager — defer to hierarchyService.
  const ok = await canAssignTo(actor, assigneeId);
  if (!ok) {
    return {
      allowed: false,
      reason: 'You can only assign recurring work to users in your reporting subtree.',
    };
  }
  return { allowed: true };
}

/**
 * Whether `actor` may read/edit/pause/archive an existing template.
 *
 *   - Admin / super admin / manager: full access.
 *   - Assistant manager: must be the creator OR the assignee must be in their
 *     subtree.
 *   - Member: must be the creator AND the assignee must still be themselves.
 *     This blocks the "I created it for me, then someone reassigned it"
 *     escalation path.
 */
async function canManageTemplate(actor, template, mode = 'view') {
  if (!template) return { allowed: false, reason: 'Template not found.', status: 404 };
  if (actor.isSuperAdmin || actor.role === 'admin' || actor.role === 'manager') {
    return { allowed: true };
  }
  if (actor.role === 'assistant_manager') {
    if (String(template.createdBy) === String(actor.id)) return { allowed: true };
    const ok = await canAssignTo(actor, template.assigneeId);
    if (!ok) return { allowed: false, reason: 'Out of your subtree.', status: 403 };
    return { allowed: true };
  }
  // Member.
  if (String(template.createdBy) !== String(actor.id) || String(template.assigneeId) !== String(actor.id)) {
    return {
      allowed: false,
      reason: mode === 'view'
        ? 'You do not have access to this recurring template.'
        : 'Members can only manage recurring work they created for themselves.',
      status: 403,
    };
  }
  return { allowed: true };
}

/**
 * Reconcile the multi-day `daysOfMonth` array vs the legacy `dayOfMonth`
 * integer from a validated input bag. Whichever side the caller populated
 * wins, then the other column is mirrored so both stay consistent. Returns
 * `{ daysOfMonth: int[], dayOfMonth: int|null }`.
 *
 * Used at create-time and patch-time. For partial PATCHes where neither field
 * was sent, both keys are `undefined` so the caller can spread the result and
 * leave the existing values untouched.
 */
function resolveMonthlyFields(v) {
  const haveArray = Array.isArray(v.daysOfMonth) && v.daysOfMonth.length > 0;
  const haveLegacy = Number.isInteger(v.dayOfMonth);

  if (haveArray) {
    const sorted = [...new Set(v.daysOfMonth)].sort((a, b) => a - b);
    return { daysOfMonth: sorted, dayOfMonth: sorted[0] };
  }
  if (haveLegacy) {
    return { daysOfMonth: [v.dayOfMonth], dayOfMonth: v.dayOfMonth };
  }
  // Neither sent — preserve null/empty for fresh creates.
  return { daysOfMonth: [], dayOfMonth: null };
}

function publicTemplate(template) {
  if (!template) return null;
  const json = template.toJSON ? template.toJSON() : template;
  const out = {};
  for (const f of TEMPLATE_FIELDS_PUBLIC) out[f] = json[f] !== undefined ? json[f] : null;
  // Expose populated includes verbatim if present (board/assignee/creator).
  if (json.board) out.board = json.board;
  if (json.assignee) out.assignee = json.assignee;
  if (json.creator) out.creator = json.creator;
  return out;
}

/**
 * Validate the body of POST/PATCH. Returns { ok, error?, value? }.
 * Doesn't trust client; normalises types defensively.
 */
function validateTemplateBody(body, { partial = false } = {}) {
  const v = {};
  const must = (cond, msg) => { if (!cond) throw new Error(msg); };

  try {
    if (!partial || body.title !== undefined) {
      must(typeof body.title === 'string' && body.title.trim().length > 0 && body.title.length <= 300,
        'title must be a non-empty string up to 300 characters.');
      v.title = sanitizeInput(body.title.trim());
    }
    if (body.description !== undefined) {
      must(typeof body.description === 'string' && body.description.length <= 5000,
        'description must be a string up to 5000 characters.');
      v.description = sanitizeInput(body.description);
    }
    if (!partial || body.boardId !== undefined) {
      must(typeof body.boardId === 'string' && body.boardId.length === 36,
        'boardId must be a UUID.');
      v.boardId = body.boardId;
    }
    if (body.groupId !== undefined) {
      must(typeof body.groupId === 'string' && body.groupId.length <= 100,
        'groupId must be a string up to 100 characters.');
      v.groupId = body.groupId;
    }
    if (!partial || body.assigneeId !== undefined) {
      must(typeof body.assigneeId === 'string' && body.assigneeId.length === 36,
        'assigneeId must be a UUID.');
      v.assigneeId = body.assigneeId;
    }
    if (body.priority !== undefined) {
      must(VALID_PRIORITIES.includes(body.priority),
        `priority must be one of: ${VALID_PRIORITIES.join(', ')}.`);
      v.priority = body.priority;
    }
    if (!partial || body.frequency !== undefined) {
      must(VALID_FREQUENCIES.includes(body.frequency),
        `frequency must be one of: ${VALID_FREQUENCIES.join(', ')}.`);
      v.frequency = body.frequency;
    }
    if (body.weekdays !== undefined) {
      must(Array.isArray(body.weekdays) && body.weekdays.every(d => Number.isInteger(d) && d >= 0 && d <= 6),
        'weekdays must be an array of integers 0–6.');
      v.weekdays = [...new Set(body.weekdays)].sort((a, b) => a - b);
    }
    if (body.dayOfMonth !== undefined && body.dayOfMonth !== null) {
      const dom = parseInt(body.dayOfMonth, 10);
      must(Number.isInteger(dom) && dom >= 1 && dom <= 31,
        'dayOfMonth must be an integer 1–31.');
      v.dayOfMonth = dom;
    }
    // New multi-day monthly support. Accepts an array of 1–31 ints; dedupes
    // and sorts ascending. The legacy `dayOfMonth` integer remains accepted
    // (above) for backward compatibility — when both are present the array
    // wins. When only `daysOfMonth` is sent, we mirror the first day onto
    // `dayOfMonth` so any pre-migration read path keeps returning a value.
    if (body.daysOfMonth !== undefined && body.daysOfMonth !== null) {
      must(Array.isArray(body.daysOfMonth),
        'daysOfMonth must be an array of integers 1–31.');
      const cleaned = body.daysOfMonth.map((d) => parseInt(d, 10));
      must(cleaned.every((d) => Number.isInteger(d) && d >= 1 && d <= 31),
        'daysOfMonth values must be integers between 1 and 31.');
      v.daysOfMonth = [...new Set(cleaned)].sort((a, b) => a - b);
    }
    if (!partial || body.startDate !== undefined) {
      must(typeof body.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.startDate),
        'startDate must be YYYY-MM-DD.');
      v.startDate = body.startDate;
    }
    if (body.endDate !== undefined && body.endDate !== null && body.endDate !== '') {
      must(typeof body.endDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.endDate),
        'endDate must be YYYY-MM-DD or null.');
      v.endDate = body.endDate;
    } else if (body.endDate === null || body.endDate === '') {
      v.endDate = null;
    }
    if (body.dueTime !== undefined) {
      must(typeof body.dueTime === 'string' && /^\d{1,2}:\d{2}(:\d{2})?$/.test(body.dueTime),
        'dueTime must be HH:mm[:ss].');
      const parts = body.dueTime.split(':');
      v.dueTime = `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}:${(parts[2] || '00').padStart(2, '0')}`;
    }
    if (body.timezone !== undefined) {
      must(typeof body.timezone === 'string' && body.timezone.length > 0 && body.timezone.length <= 64,
        'timezone must be an IANA timezone string up to 64 characters.');
      try { new Intl.DateTimeFormat('en-US', { timeZone: body.timezone }); }
      catch (e) { throw new Error(`Unknown timezone: ${body.timezone}`); }
      v.timezone = body.timezone;
    }
    if (body.escalateIfMissed !== undefined) {
      must(typeof body.escalateIfMissed === 'boolean', 'escalateIfMissed must be boolean.');
      v.escalateIfMissed = body.escalateIfMissed;
    }
    if (body.escalationTargets !== undefined) {
      must(Array.isArray(body.escalationTargets)
        && body.escalationTargets.every(t => VALID_ESCALATION_TARGETS.includes(t)),
        `escalationTargets must be a subset of: ${VALID_ESCALATION_TARGETS.join(', ')}.`);
      v.escalationTargets = [...new Set(body.escalationTargets)];
    }
    if (body.isActive !== undefined) {
      must(typeof body.isActive === 'boolean', 'isActive must be boolean.');
      v.isActive = body.isActive;
    }

    // Cross-field invariants.
    if (v.startDate && v.endDate && v.endDate < v.startDate) {
      throw new Error('endDate must be on or after startDate.');
    }
    if (v.frequency === 'monthly' && partial !== true) {
      const haveArray = Array.isArray(v.daysOfMonth) && v.daysOfMonth.length > 0;
      const haveLegacy = Number.isInteger(v.dayOfMonth);
      if (!haveArray && !haveLegacy) {
        throw new Error('Monthly frequency requires at least one day-of-month (1–31).');
      }
    }
    if ((v.frequency === 'weekly' || v.frequency === 'custom')
        && partial !== true
        && (!v.weekdays || v.weekdays.length === 0)) {
      throw new Error('weekdays must include at least one weekday for weekly/custom frequency.');
    }

    return { ok: true, value: v };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Endpoint: POST /api/recurring-tasks ────────────────────────────────────

/**
 * Create a new recurring task template.
 */
const createTemplate = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const validation = validateTemplateBody(req.body, { partial: false });
    if (!validation.ok) {
      return res.status(400).json({ success: false, message: validation.error });
    }
    const v = validation.value;

    const board = await Board.findByPk(v.boardId);
    if (!board) return res.status(404).json({ success: false, message: 'Board not found.' });
    if (board.isArchived) {
      return res.status(400).json({ success: false, message: 'Cannot create recurring work on an archived board.' });
    }

    const assignee = await User.findOne({ where: { id: v.assigneeId, isActive: true } });
    if (!assignee) return res.status(404).json({ success: false, message: 'Assignee not found or inactive.' });

    const targetCheck = await canTargetAssignee(req.user, v.assigneeId);
    if (!targetCheck.allowed) {
      return res.status(403).json({ success: false, message: targetCheck.reason });
    }

    // Reconcile multi-day vs legacy single-day monthly fields. Whichever the
    // caller supplied wins; we mirror it onto the other field so both column
    // shapes stay consistent and pre-migration code that still reads
    // `dayOfMonth` continues to see a valid value.
    const monthlyFields = resolveMonthlyFields(v);

    const template = await RecurringTaskTemplate.create({
      title: v.title,
      description: v.description || '',
      boardId: v.boardId,
      groupId: v.groupId || 'new',
      assigneeId: v.assigneeId,
      createdBy: req.user.id,
      priority: v.priority || 'medium',
      frequency: v.frequency,
      weekdays: v.weekdays || [],
      dayOfMonth: monthlyFields.dayOfMonth,
      daysOfMonth: monthlyFields.daysOfMonth,
      startDate: v.startDate,
      endDate: v.endDate || null,
      dueTime: v.dueTime || '18:00:00',
      timezone: v.timezone || 'UTC',
      escalateIfMissed: v.escalateIfMissed === true,
      escalationTargets: v.escalationTargets || ['assignee', 'manager'],
      isActive: v.isActive !== false,
    });

    await recurringTaskService.recomputeNextRunAt(template);
    await template.reload();

    // Immediate first-occurrence generation. UX requirement: assignee should
    // see today's task right away, not 5–10 minutes later when the cron next
    // fires. We reuse runTemplateOnce so the eligibility, idempotency, and
    // nextRunAt-advancement logic stays in one place — the cron and this path
    // hit identical code. The DB partial unique index on
    // (recurringTemplateId, occurrenceDate) is the duplicate guard if cron
    // happens to race us.
    //
    // runTemplateOnce never throws; failures land in result.error. We log them
    // but do NOT fail the create — the template itself is saved and the cron
    // can still pick it up later. The returned `immediateGeneration` payload
    // lets the frontend show a different toast when today's task was created.
    let immediateGeneration = { generated: false, alreadyExisted: false, occurrenceDate: null };
    try {
      const runResult = await recurringTaskService.runTemplateOnce(template, {
        source: 'recurringTemplateController.create',
      });
      // Reload so the response carries fresh nextRunAt / lastGeneratedDate.
      await template.reload();
      if (runResult && !runResult.error) {
        immediateGeneration = {
          generated: !!runResult.generated,
          alreadyExisted: !!runResult.alreadyExisted,
          occurrenceDate: runResult.occurrenceDate || null,
          // expose nextRunAt so the client can show "next at …" without a refetch
          nextRunAt: runResult.nextRunAt ? new Date(runResult.nextRunAt).toISOString() : null,
        };
      } else if (runResult?.error) {
        logger.warn('[recurringTemplateController.create] immediate generation reported error', {
          templateId: template.id, msg: runResult.error,
        });
      }
    } catch (err) {
      // Defense-in-depth — the service's own catch should keep us from getting
      // here, but if it does, the template still got saved. Surface as warning.
      logger.warn('[recurringTemplateController.create] immediate generation crashed', {
        templateId: template.id, msg: err.message,
      });
    }

    logActivity({
      action: 'recurring_template_created',
      description: `Created recurring template "${template.title}" (${template.frequency})`
        + (immediateGeneration.generated ? ` and generated today's instance for ${immediateGeneration.occurrenceDate}` : ''),
      entityType: 'recurring_template',
      entityId: template.id,
      taskId: null,
      boardId: template.boardId,
      userId: req.user.id,
      meta: {
        assigneeId: template.assigneeId,
        frequency: template.frequency,
        immediatelyGenerated: immediateGeneration.generated,
      },
    });

    return res.status(201).json({
      success: true,
      data: {
        template: publicTemplate(template),
        immediateGeneration,
      },
    });
  } catch (err) {
    logger.error('[recurringTemplateController.create]', err);
    return res.status(500).json({ success: false, message: 'Failed to create recurring template.' });
  }
};

// ─── Endpoint: GET /api/recurring-tasks ─────────────────────────────────────

/**
 * List templates the actor is allowed to see.
 *   - Members → only templates where createdBy === self AND assigneeId === self.
 *   - Assistant managers → templates they created OR templates whose assignee
 *     is in their subtree.
 *   - Manager / admin / super admin → all templates.
 */
const listTemplates = async (req, res) => {
  try {
    const where = {};
    const { boardId, includeArchived, isActive } = req.query;

    if (boardId) where.boardId = boardId;
    if (includeArchived !== 'true') where.archivedAt = null;
    if (isActive === 'true') where.isActive = true;
    if (isActive === 'false') where.isActive = false;

    if (req.user.role === 'member') {
      where.createdBy = req.user.id;
      where.assigneeId = req.user.id;
    } else if (req.user.role === 'assistant_manager' && !req.user.isSuperAdmin) {
      const { getDescendantIds } = require('../services/hierarchyService');
      const descendantIds = await getDescendantIds(req.user.id);
      const allowedAssignees = new Set([req.user.id, ...descendantIds]);
      where[Op.or] = [
        { assigneeId: { [Op.in]: [...allowedAssignees] } },
        { createdBy: req.user.id },
      ];
    }

    const templates = await RecurringTaskTemplate.findAll({
      where,
      include: [
        { model: Board, as: 'board', attributes: ['id', 'name', 'color'] },
        { model: User, as: 'assignee', attributes: ['id', 'name', 'email', 'avatar', 'role'] },
        { model: User, as: 'creator', attributes: ['id', 'name', 'email', 'avatar', 'role'] },
      ],
      order: [['createdAt', 'DESC']],
    });

    return res.json({
      success: true,
      data: { templates: templates.map(publicTemplate) },
    });
  } catch (err) {
    logger.error('[recurringTemplateController.list]', err);
    return res.status(500).json({ success: false, message: 'Failed to list recurring templates.' });
  }
};

// ─── Endpoint: GET /api/recurring-tasks/:id ─────────────────────────────────

/**
 * Get a single template + its recent generated instances (last 30) for the
 * history pane in the UI.
 */
const getTemplate = async (req, res) => {
  try {
    const template = await RecurringTaskTemplate.findByPk(req.params.id, {
      include: [
        { model: Board, as: 'board', attributes: ['id', 'name', 'color'] },
        { model: User, as: 'assignee', attributes: ['id', 'name', 'email', 'avatar', 'role'] },
        { model: User, as: 'creator', attributes: ['id', 'name', 'email', 'avatar', 'role'] },
      ],
    });
    const auth = await canManageTemplate(req.user, template, 'view');
    if (!auth.allowed) {
      return res.status(auth.status || 403).json({ success: false, message: auth.reason });
    }

    const instances = await Task.findAll({
      where: { recurringTemplateId: template.id, isRecurringInstance: true },
      attributes: [
        'id', 'title', 'status', 'priority', 'progress', 'dueDate', 'occurrenceDate',
        'completedAt', 'missedEscalationSent', 'missedEscalationSentAt',
        'isArchived', 'createdAt', 'updatedAt',
      ],
      order: [['occurrenceDate', 'DESC']],
      limit: 30,
    });

    return res.json({
      success: true,
      data: {
        template: publicTemplate(template),
        instances,
      },
    });
  } catch (err) {
    logger.error('[recurringTemplateController.get]', err);
    return res.status(500).json({ success: false, message: 'Failed to load recurring template.' });
  }
};

// ─── Endpoint: PATCH /api/recurring-tasks/:id ───────────────────────────────

/**
 * Update template. Only future generated instances are affected; historical
 * instances are NEVER touched (per spec).
 */
const updateTemplate = async (req, res) => {
  try {
    const template = await RecurringTaskTemplate.findByPk(req.params.id);
    const auth = await canManageTemplate(req.user, template, 'edit');
    if (!auth.allowed) {
      return res.status(auth.status || 403).json({ success: false, message: auth.reason });
    }

    const validation = validateTemplateBody(req.body, { partial: true });
    if (!validation.ok) {
      return res.status(400).json({ success: false, message: validation.error });
    }
    const v = validation.value;

    if (v.assigneeId && String(v.assigneeId) !== String(template.assigneeId)) {
      const targetCheck = await canTargetAssignee(req.user, v.assigneeId);
      if (!targetCheck.allowed) {
        return res.status(403).json({ success: false, message: targetCheck.reason });
      }
      // Defense-in-depth: even if the check returned true, members cannot
      // reassign templates (canTargetAssignee already blocks this; redundant
      // guard kept so future refactors don't regress the rule silently).
      if (req.user.role === 'member' && String(v.assigneeId) !== String(req.user.id)) {
        return res.status(403).json({
          success: false,
          message: 'Members cannot reassign recurring work.',
        });
      }
    }

    if (v.boardId && String(v.boardId) !== String(template.boardId)) {
      if (req.user.role === 'member') {
        return res.status(403).json({
          success: false,
          message: 'Members cannot move recurring work between boards.',
        });
      }
      const board = await Board.findByPk(v.boardId);
      if (!board || board.isArchived) {
        return res.status(404).json({ success: false, message: 'Target board not found or archived.' });
      }
    }

    // Keep the legacy single-day and modern multi-day monthly fields in sync.
    // Only run the reconciliation when the patch actually touches one of them
    // — otherwise existing values are left alone.
    if (v.daysOfMonth !== undefined || v.dayOfMonth !== undefined) {
      const resolved = resolveMonthlyFields(v);
      v.daysOfMonth = resolved.daysOfMonth;
      v.dayOfMonth = resolved.dayOfMonth;
    }

    await template.update(v);

    const scheduleChanged =
      v.frequency !== undefined ||
      v.weekdays !== undefined ||
      v.dayOfMonth !== undefined ||
      v.daysOfMonth !== undefined ||
      v.startDate !== undefined ||
      v.endDate !== undefined ||
      v.dueTime !== undefined ||
      v.timezone !== undefined ||
      v.isActive !== undefined;
    if (scheduleChanged) {
      await recurringTaskService.recomputeNextRunAt(template);
      await template.reload();
    }

    logActivity({
      action: 'recurring_template_updated',
      description: `Updated recurring template "${template.title}"`,
      entityType: 'recurring_template',
      entityId: template.id,
      taskId: null,
      boardId: template.boardId,
      userId: req.user.id,
      meta: { fields: Object.keys(v) },
    });

    return res.json({ success: true, data: { template: publicTemplate(template) } });
  } catch (err) {
    logger.error('[recurringTemplateController.update]', err);
    return res.status(500).json({ success: false, message: 'Failed to update recurring template.' });
  }
};

// ─── Endpoint: POST /api/recurring-tasks/:id/pause | resume ────────────────

const pauseTemplate = (req, res) => togglePause(req, res, false);
const resumeTemplate = (req, res) => togglePause(req, res, true);

async function togglePause(req, res, makeActive) {
  try {
    const template = await RecurringTaskTemplate.findByPk(req.params.id);
    const auth = await canManageTemplate(req.user, template, 'edit');
    if (!auth.allowed) {
      return res.status(auth.status || 403).json({ success: false, message: auth.reason });
    }
    if (template.archivedAt) {
      return res.status(400).json({ success: false, message: 'Cannot pause/resume an archived template.' });
    }
    if (template.isActive === makeActive) {
      return res.json({ success: true, data: { template: publicTemplate(template) }, unchanged: true });
    }

    await template.update({ isActive: makeActive });
    await recurringTaskService.recomputeNextRunAt(template);
    await template.reload();

    logActivity({
      action: makeActive ? 'recurring_template_resumed' : 'recurring_template_paused',
      description: `${makeActive ? 'Resumed' : 'Paused'} recurring template "${template.title}"`,
      entityType: 'recurring_template',
      entityId: template.id,
      taskId: null,
      boardId: template.boardId,
      userId: req.user.id,
    });

    return res.json({ success: true, data: { template: publicTemplate(template) } });
  } catch (err) {
    logger.error('[recurringTemplateController.togglePause]', err);
    return res.status(500).json({ success: false, message: 'Failed to update template.' });
  }
}

// ─── Endpoint: POST /api/recurring-tasks/:id/archive ────────────────────────

/**
 * Soft-archive a template. Stops future generation; historical instances
 * remain in the tasks table untouched.
 */
const archiveTemplate = async (req, res) => {
  try {
    const template = await RecurringTaskTemplate.findByPk(req.params.id);
    const auth = await canManageTemplate(req.user, template, 'edit');
    if (!auth.allowed) {
      return res.status(auth.status || 403).json({ success: false, message: auth.reason });
    }
    if (template.archivedAt) {
      return res.json({ success: true, data: { template: publicTemplate(template) }, unchanged: true });
    }

    await template.update({
      archivedAt: new Date(),
      isActive: false,
      nextRunAt: null,
    });
    await template.reload();

    logActivity({
      action: 'recurring_template_archived',
      description: `Archived recurring template "${template.title}"`,
      entityType: 'recurring_template',
      entityId: template.id,
      taskId: null,
      boardId: template.boardId,
      userId: req.user.id,
    });

    return res.json({ success: true, data: { template: publicTemplate(template) } });
  } catch (err) {
    logger.error('[recurringTemplateController.archive]', err);
    return res.status(500).json({ success: false, message: 'Failed to archive template.' });
  }
};

// ─── Endpoint: POST /api/recurring-tasks/:id/generate-now (admin only) ─────

/**
 * Force-generate today's instance regardless of nextRunAt. Useful for testing
 * and recovering from cron downtime.
 */
const generateNow = async (req, res) => {
  try {
    if (!(req.user.isSuperAdmin || req.user.role === 'admin')) {
      return res.status(403).json({ success: false, message: 'Admin only.' });
    }
    const template = await RecurringTaskTemplate.findByPk(req.params.id);
    if (!template) return res.status(404).json({ success: false, message: 'Template not found.' });
    if (template.archivedAt) {
      return res.status(400).json({ success: false, message: 'Cannot generate from an archived template.' });
    }
    if (!template.isActive) {
      return res.status(400).json({ success: false, message: 'Cannot generate from a paused template.' });
    }
    const result = await recurringTaskService.runTemplateOnce(template, {
      source: 'recurringTemplateController.generateNow',
    });
    return res.json({ success: true, data: { result } });
  } catch (err) {
    logger.error('[recurringTemplateController.generateNow]', err);
    return res.status(500).json({ success: false, message: 'Failed to generate instance.' });
  }
};

module.exports = {
  createTemplate,
  listTemplates,
  getTemplate,
  updateTemplate,
  pauseTemplate,
  resumeTemplate,
  archiveTemplate,
  generateNow,
  // Exported for tests / route-level reuse.
  _internal: {
    canTargetAssignee,
    canManageTemplate,
    validateTemplateBody,
  },
};
