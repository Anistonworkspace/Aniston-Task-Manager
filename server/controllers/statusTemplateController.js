const { StatusTemplate, Board } = require('../models');
const { sequelize } = require('../config/db');
const { validationResult } = require('express-validator');
const boardVisibility = require('../services/boardVisibilityService');
const { sanitizeInput } = require('../utils/sanitize');
const logger = require('../utils/logger');

// Hex color allowlist — mirrors the labelController guard. Status colors
// render straight into a CSS style attribute downstream, so we never accept
// anything that isn't a 3- or 6-digit hex code. Anything else falls back
// to a Monday-style neutral.
const COLOR_HEX = /^#(?:[0-9a-f]{3}){1,2}$/i;
function normalizeColor(input, fallback = '#9aadbd') {
  if (typeof input !== 'string') return fallback;
  const v = input.trim();
  return COLOR_HEX.test(v) ? v : fallback;
}

// Phase 2 — Status Tile Group management gate.
//
// Strict: ONLY Tier 1 (super admin) + Tier 2 (admin / manager) can manage
// templates. The board-creator carve-out was intentionally removed per
// product decision — a Tier 3/Tier 4 actor who personally created a board
// still cannot curate its template library. This makes the rule predictable
// for admins reviewing audit logs ("only T1/T2 ever wrote to this table")
// and lets the permissionMatrix grantability table stay simple (T1_T2 across
// the board, no per-resource carve-outs).
//
// `board` is accepted as a parameter (rather than just `boardId`) so callers
// don't pay an extra round-trip to load it — every call site already has the
// board in hand for its own 404 check.
function canManageBoard(user, /* board */ _board) {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  if (user.role === 'admin' || user.role === 'manager') return true;
  return false;
}

// Validate the shape of the `statuses` JSONB array passed in by the client.
// Rules:
//   - must be a non-empty array (templates with no statuses are useless)
//   - each entry must have a non-empty string `key` and `label`
//   - colors are normalized through the hex allowlist
//   - keys must be unique within the template (we'd otherwise have collisions
//     when the task uses one as its current status)
//   - position is optional; we re-derive a sequential 0..n-1 ordering so
//     clients never have to manage it
// Returns either { ok: true, normalized: [...] } or { ok: false, message }.
function normalizeStatuses(input) {
  if (!Array.isArray(input)) return { ok: false, message: 'statuses must be an array.' };
  if (input.length === 0) return { ok: false, message: 'A template needs at least one status.' };
  if (input.length > 50)  return { ok: false, message: 'A template can hold at most 50 statuses.' };
  const seenKeys = new Set();
  const normalized = [];
  for (let i = 0; i < input.length; i += 1) {
    const s = input[i] || {};
    const key = typeof s.key === 'string' ? s.key.trim() : '';
    const label = typeof s.label === 'string' ? s.label.trim() : '';
    if (!key) return { ok: false, message: `Status #${i + 1}: key is required.` };
    if (key.length > 50) return { ok: false, message: `Status #${i + 1}: key must be ≤ 50 chars.` };
    if (!label) return { ok: false, message: `Status #${i + 1}: label is required.` };
    if (label.length > 80) return { ok: false, message: `Status #${i + 1}: label must be ≤ 80 chars.` };
    if (seenKeys.has(key)) return { ok: false, message: `Duplicate status key "${key}".` };
    seenKeys.add(key);
    normalized.push({
      key,
      label: sanitizeInput(label),
      color: normalizeColor(s.color),
      position: i,
    });
  }
  return { ok: true, normalized };
}

// Small helper used by every write path — make sure the supplied default
// key actually points at a status inside the template's statuses array.
// Returns the resolved key or `null` if invalid.
function resolveDefaultKey(defaultStatusKey, statuses) {
  if (typeof defaultStatusKey !== 'string' || defaultStatusKey.trim() === '') return null;
  const key = defaultStatusKey.trim();
  return statuses.some((s) => s.key === key) ? key : null;
}

function envelope500(message, err) {
  const body = { success: false, message };
  if (process.env.NODE_ENV !== 'production' && err && err.message) {
    body.detail = err.message;
    if (err.name) body.errorName = err.name;
  }
  return body;
}

// GET /api/status-templates?boardId=...
// Board-scoped only in Phase 2 — boardId is required. Caller must be able
// to see the board (boardVisibilityService is the single source of truth);
// once they pass that gate they get the full list. Templates render in the
// task-create modal and the manage-templates UI; non-managers consume the
// list read-only and the controller enforces write gates separately.
exports.list = async (req, res) => {
  try {
    const { boardId } = req.query;
    if (!boardId) {
      return res.status(400).json({ success: false, message: 'boardId is required.' });
    }
    if (!(await boardVisibility.canUserSeeBoard(req.user, boardId))) {
      return res.status(403).json({ success: false, message: 'Forbidden.' });
    }
    const templates = await StatusTemplate.findAll({
      where: { boardId },
      order: [['isDefault', 'DESC'], ['name', 'ASC']],
    });
    res.json({ success: true, data: { templates } });
  } catch (err) {
    logger.error('[statusTemplates.list] error', { error: err.message, name: err.name });
    res.status(500).json(envelope500('Failed to fetch status templates.', err));
  }
};

// POST /api/status-templates
// Tier 1 / Tier 2 (or board creator). Validates the statuses array shape
// AND that defaultStatusKey points to a key inside the array before write.
// `isDefault: true` is honored if requested — the database's partial unique
// index will reject simultaneous defaults; we additionally clear the prior
// default inside the same transaction so the response reflects the new
// state cleanly.
exports.create = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const arr = errors.array();
      const firstMsg = (arr[0] && (arr[0].msg || arr[0].message)) || 'Invalid template data.';
      return res.status(400).json({ success: false, message: firstMsg, errors: arr, code: 'validation_failed' });
    }

    const { boardId, name, statuses, defaultStatusKey, isDefault } = req.body;
    const board = await Board.findByPk(boardId);
    if (!board) return res.status(404).json({ success: false, message: 'Board not found.' });
    if (!canManageBoard(req.user, board)) {
      return res.status(403).json({ success: false, message: 'You do not have permission to manage status templates on this board.' });
    }

    const normalizedStatuses = normalizeStatuses(statuses);
    if (!normalizedStatuses.ok) {
      return res.status(400).json({ success: false, message: normalizedStatuses.message, code: 'invalid_statuses' });
    }

    const resolvedDefault = resolveDefaultKey(defaultStatusKey, normalizedStatuses.normalized);
    if (!resolvedDefault) {
      return res.status(400).json({
        success: false,
        message: 'defaultStatusKey must match one of the statuses in the template.',
        code: 'invalid_default_status_key',
      });
    }

    const template = await sequelize.transaction(async (t) => {
      if (isDefault === true) {
        // Clear any existing default on this board before flipping ours on.
        // The partial unique index would otherwise reject the insert.
        await StatusTemplate.update(
          { isDefault: false },
          { where: { boardId, isDefault: true }, transaction: t },
        );
      }
      return StatusTemplate.create({
        boardId,
        name: sanitizeInput(typeof name === 'string' ? name.trim() : ''),
        statuses: normalizedStatuses.normalized,
        defaultStatusKey: resolvedDefault,
        isDefault: isDefault === true,
        createdBy: req.user.id,
      }, { transaction: t });
    });

    res.status(201).json({ success: true, data: { template } });
  } catch (err) {
    logger.error('[statusTemplates.create] error', { error: err.message, name: err.name });
    res.status(500).json(envelope500('Failed to create status template.', err));
  }
};

// PUT /api/status-templates/:id
// Full replacement update — clients send back the full intended state.
// Field-level diffing is overkill for a small JSONB payload and would
// make partial-update edge cases hard to reason about. Behaves identically
// to create wrt board management gate, statuses validation, default-key
// resolution, and default flag handling.
exports.update = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const arr = errors.array();
      const firstMsg = (arr[0] && (arr[0].msg || arr[0].message)) || 'Invalid template data.';
      return res.status(400).json({ success: false, message: firstMsg, errors: arr, code: 'validation_failed' });
    }

    const template = await StatusTemplate.findByPk(req.params.id);
    if (!template) return res.status(404).json({ success: false, message: 'Status template not found.' });

    const board = await Board.findByPk(template.boardId);
    if (!board) return res.status(404).json({ success: false, message: 'Board not found.' });
    if (!canManageBoard(req.user, board)) {
      return res.status(403).json({ success: false, message: 'You do not have permission to manage status templates on this board.' });
    }

    const { name, statuses, defaultStatusKey, isDefault } = req.body;

    // Replicate the create-time validation. statuses + defaultStatusKey are
    // required on every PUT so we can never end up with a template whose
    // default key points outside its statuses array (an invariant the task
    // creation path relies on).
    const normalized = normalizeStatuses(statuses);
    if (!normalized.ok) {
      return res.status(400).json({ success: false, message: normalized.message, code: 'invalid_statuses' });
    }
    const resolvedDefault = resolveDefaultKey(defaultStatusKey, normalized.normalized);
    if (!resolvedDefault) {
      return res.status(400).json({
        success: false,
        message: 'defaultStatusKey must match one of the statuses in the template.',
        code: 'invalid_default_status_key',
      });
    }

    await sequelize.transaction(async (t) => {
      if (isDefault === true && !template.isDefault) {
        await StatusTemplate.update(
          { isDefault: false },
          { where: { boardId: template.boardId, isDefault: true }, transaction: t },
        );
      }
      await template.update({
        ...(name !== undefined && { name: sanitizeInput(typeof name === 'string' ? name.trim() : '') }),
        statuses: normalized.normalized,
        defaultStatusKey: resolvedDefault,
        ...(isDefault !== undefined && { isDefault: isDefault === true }),
      }, { transaction: t });
    });

    res.json({ success: true, data: { template } });
  } catch (err) {
    logger.error('[statusTemplates.update] error', { error: err.message, name: err.name });
    res.status(500).json(envelope500('Failed to update status template.', err));
  }
};

// DELETE /api/status-templates/:id
// Existing tasks that were created with this template are NOT affected:
// the controller copies the template's `statuses` into the task's
// `statusConfig` JSONB column at create time, so historical tasks stay
// fully self-contained. Deleting a template simply removes future
// availability.
exports.remove = async (req, res) => {
  try {
    const template = await StatusTemplate.findByPk(req.params.id);
    if (!template) return res.status(404).json({ success: false, message: 'Status template not found.' });

    const board = await Board.findByPk(template.boardId);
    if (!board) return res.status(404).json({ success: false, message: 'Board not found.' });
    if (!canManageBoard(req.user, board)) {
      return res.status(403).json({ success: false, message: 'You do not have permission to delete status templates on this board.' });
    }

    await template.destroy();
    res.json({ success: true, message: 'Status template deleted.' });
  } catch (err) {
    logger.error('[statusTemplates.delete] error', { error: err.message, name: err.name });
    res.status(500).json(envelope500('Failed to delete status template.', err));
  }
};

// POST /api/status-templates/:id/set-default
// Convenience endpoint for "make this template the board default". Avoids
// requiring the client to issue a full PUT just to flip the boolean. Runs
// in a transaction so the prior-default-clear and the new-default-set
// commit atomically (the partial unique index would otherwise race).
exports.setDefault = async (req, res) => {
  try {
    const template = await StatusTemplate.findByPk(req.params.id);
    if (!template) return res.status(404).json({ success: false, message: 'Status template not found.' });

    const board = await Board.findByPk(template.boardId);
    if (!board) return res.status(404).json({ success: false, message: 'Board not found.' });
    if (!canManageBoard(req.user, board)) {
      return res.status(403).json({ success: false, message: 'You do not have permission to manage status templates on this board.' });
    }

    if (template.isDefault) {
      return res.json({ success: true, data: { template } });
    }

    await sequelize.transaction(async (t) => {
      await StatusTemplate.update(
        { isDefault: false },
        { where: { boardId: template.boardId, isDefault: true }, transaction: t },
      );
      await template.update({ isDefault: true }, { transaction: t });
    });

    res.json({ success: true, data: { template } });
  } catch (err) {
    logger.error('[statusTemplates.setDefault] error', { error: err.message, name: err.name });
    res.status(500).json(envelope500('Failed to set default status template.', err));
  }
};

// Expose the management gate so taskController can ask "could this user
// have edited this template?" without duplicating the predicate. Kept
// internal to the controller for now (no route handler exports it).
exports._canManageBoard = canManageBoard;
exports._normalizeStatuses = normalizeStatuses;
