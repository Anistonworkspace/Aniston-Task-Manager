'use strict';

/**
 * Form Controller — Phase F1
 *
 * Endpoints (mounted under /api/forms — see routes/forms.js):
 *
 *   GET    /                     — list forms in a workspace
 *   POST   /                     — create a draft form
 *   GET    /:id                  — load a form + its field schema
 *   PATCH  /:id                  — update name / description / fields / etc.
 *   DELETE /:id                  — cascades submissions
 *
 *   GET    /:id/submissions      — list submissions for a form (paginated)
 *   POST   /public/:slug/submit  — UNAUTHENTICATED public submit endpoint
 *
 * RBAC mirrors workflowController: workspace membership for read; admin /
 * manager / creator for mutations. The PUBLIC submit endpoint bypasses
 * authentication when the form is `isPublic = true && isActive = true`.
 *
 * Field validation: the controller revalidates `payload` against the form's
 * `fields[]` schema on every submit so a client cannot stuff arbitrary keys.
 * Unknown field IDs in payload are dropped (not 400'd) so a form can evolve
 * without breaking already-bookmarked submit URLs.
 */

const {
  Form,
  FormSubmission,
  Workspace,
  User,
  Board,
  Task,
} = require('../models');
const safeLogger = require('../utils/safeLogger');
const { sanitizeInput } = require('../utils/sanitize');

// Tighter regex than a generic slugify — we only allow lowercase a-z, 0-9
// and a single dash separator. Length is clamped by the column (VARCHAR(80)).
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

// Generate a URL-safe slug from a name. Doesn't guarantee uniqueness —
// caller appends a short random suffix if the first attempt collides.
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'form';
}

function randSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

async function canCallerSeeWorkspace(user, workspaceId) {
  if (!workspaceId) return false;
  if (user?.isSuperAdmin) return true;
  const ws = await Workspace.findByPk(workspaceId, {
    include: [
      { model: User, as: 'workspaceMembers', attributes: ['id'], required: false },
    ],
  });
  if (!ws) return false;
  if (user?.role === 'admin' || user?.role === 'manager') return true;
  if (ws.createdBy === user.id) return true;
  const memberIds = (ws.workspaceMembers || []).map((m) => m.id);
  return memberIds.includes(user.id);
}

function canManageForm(user, form) {
  if (!user || !form) return false;
  if (user.isSuperAdmin) return true;
  if (user.role === 'admin' || user.role === 'manager') return true;
  if (form.createdBy === user.id) return true;
  return false;
}

const ALLOWED_FIELD_TYPES = new Set([
  'text', 'textarea', 'number', 'email', 'date', 'select', 'checkbox',
]);

// Normalize and validate a single field definition. Returns { ok, value, error }.
// Drops unknown keys so the JSONB blob stays narrow.
function normalizeField(raw, index) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: `Field at index ${index} must be an object.` };
  }
  const id = String(raw.id || '').trim();
  if (!id) return { ok: false, error: `Field at index ${index} is missing an id.` };
  if (id.length > 64) return { ok: false, error: `Field id at index ${index} too long.` };

  const type = String(raw.type || '');
  if (!ALLOWED_FIELD_TYPES.has(type)) {
    return { ok: false, error: `Field at index ${index} has unsupported type "${type}".` };
  }

  const out = {
    id,
    type,
    label: sanitizeInput(String(raw.label || '')).slice(0, 200),
    required: !!raw.required,
  };
  if (raw.placeholder) out.placeholder = sanitizeInput(String(raw.placeholder)).slice(0, 200);
  if (type === 'select' && Array.isArray(raw.options)) {
    out.options = raw.options
      .map((o) => sanitizeInput(String(o)).slice(0, 100))
      .filter((o) => o.length > 0)
      .slice(0, 50);
  }
  return { ok: true, value: out };
}

// Validate + normalize a targetColumnMap payload. Drops unknown task field
// names and entries pointing at field ids that don't exist on the form.
// Allowed task fields are intentionally narrow — we don't want a form
// author writing into `assignedTo` (would be a privilege escalation since
// the form submitter is often anonymous).
const ALLOWED_TASK_COLUMNS = new Set(['title', 'description', 'dueDate', 'priority', 'status']);

function normalizeColumnMap(rawMap, formFields) {
  if (!rawMap || typeof rawMap !== 'object') return {};
  const validFieldIds = new Set((formFields || []).map((f) => f.id));
  const out = {};
  for (const key of Object.keys(rawMap)) {
    if (!ALLOWED_TASK_COLUMNS.has(key)) continue;
    const fid = rawMap[key];
    if (typeof fid !== 'string' || !validFieldIds.has(fid)) continue;
    out[key] = fid;
  }
  return out;
}

// Pull the values mapped by columnMap out of a validated submission payload.
// Returns null when the map produces no usable values (most importantly: a
// missing `title`, which would create an unnamed Task we'd have to clean up).
function buildTaskAttrsFromSubmission(form, payload) {
  const map = form.targetColumnMap || {};
  if (!map.title) return null;
  const titleVal = payload[map.title];
  if (titleVal == null || String(titleVal).trim() === '') return null;

  const attrs = {
    title: String(titleVal).slice(0, 500),
    status: 'not_started',
    priority: 'medium',
    boardId: form.targetBoardId,
  };

  if (map.description) {
    const v = payload[map.description];
    if (v != null && v !== '') attrs.description = String(v).slice(0, 8000);
  }
  if (map.priority) {
    const v = payload[map.priority];
    if (typeof v === 'string' && ['low', 'medium', 'high', 'critical'].includes(v.toLowerCase())) {
      attrs.priority = v.toLowerCase();
    }
  }
  if (map.status) {
    const v = payload[map.status];
    if (typeof v === 'string' && v.trim()) {
      // Trust the form's own select options — TaskController also stores
      // arbitrary status strings since the de-enum migration.
      attrs.status = v.trim().slice(0, 50);
    }
  }
  if (map.dueDate) {
    const v = payload[map.dueDate];
    if (v && !Number.isNaN(Date.parse(v))) {
      attrs.dueDate = String(v).slice(0, 40);
    }
  }
  return attrs;
}

function normalizeFields(arr) {
  if (!Array.isArray(arr)) return { ok: false, error: 'fields must be an array.' };
  if (arr.length > 100) return { ok: false, error: 'A form cannot have more than 100 fields.' };
  const seen = new Set();
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const result = normalizeField(arr[i], i);
    if (!result.ok) return result;
    if (seen.has(result.value.id)) {
      return { ok: false, error: `Duplicate field id "${result.value.id}".` };
    }
    seen.add(result.value.id);
    out.push(result.value);
  }
  return { ok: true, value: out };
}

// Validate a submitter payload against a form's field schema. Unknown keys
// are dropped silently (so a renamed field doesn't break in-flight tabs).
// Returns { ok, value, error }.
function validatePayload(form, raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'payload must be an object.' };
  }
  const fields = Array.isArray(form.fields) ? form.fields : [];
  const out = {};
  let submitterEmail = null;
  for (const field of fields) {
    const value = raw[field.id];
    if (value === undefined || value === null || value === '') {
      if (field.required) {
        return { ok: false, error: `Field "${field.label || field.id}" is required.` };
      }
      continue;
    }
    // Per-type sanitisation. Anything we don't recognise is rejected upstream
    // by normalizeField, so we only see ALLOWED_FIELD_TYPES here.
    switch (field.type) {
      case 'text':
      case 'textarea':
      case 'select':
        out[field.id] = sanitizeInput(String(value)).slice(0, 5000);
        break;
      case 'email':
        out[field.id] = sanitizeInput(String(value)).slice(0, 320);
        if (!submitterEmail) submitterEmail = out[field.id];
        break;
      case 'number': {
        const n = Number(value);
        if (Number.isNaN(n)) {
          return { ok: false, error: `Field "${field.label || field.id}" must be a number.` };
        }
        out[field.id] = n;
        break;
      }
      case 'date':
        // Accept ISO-8601 strings; reject anything else.
        if (Number.isNaN(Date.parse(value))) {
          return { ok: false, error: `Field "${field.label || field.id}" must be a date.` };
        }
        out[field.id] = String(value).slice(0, 40);
        break;
      case 'checkbox':
        out[field.id] = !!value;
        break;
      default:
        // Should never hit — ALLOWED_FIELD_TYPES guard covers this.
        break;
    }
  }
  return { ok: true, value: out, submitterEmail };
}

// ─── Form CRUD ───────────────────────────────────────────────────────

async function listForms(req, res) {
  try {
    const workspaceId = req.query?.workspaceId;
    if (!workspaceId) {
      // Same contract as workflowController: no workspaceId = every form the
      // caller can see.
      if (req.user?.isSuperAdmin || req.user?.role === 'admin' || req.user?.role === 'manager') {
        const forms = await Form.findAll({ order: [['createdAt', 'DESC']] });
        return res.json({ success: true, data: { forms: forms.map((f) => f.toJSON()) } });
      }
      const visibleWorkspaces = await Workspace.findAll({
        attributes: ['id', 'createdBy'],
        include: [{ model: User, as: 'workspaceMembers', attributes: ['id'], required: false }],
      });
      const visibleIds = visibleWorkspaces
        .filter((ws) => ws.createdBy === req.user.id
          || (ws.workspaceMembers || []).some((m) => m.id === req.user.id))
        .map((ws) => ws.id);
      if (visibleIds.length === 0) {
        return res.json({ success: true, data: { forms: [] } });
      }
      const forms = await Form.findAll({
        where: { workspaceId: visibleIds },
        order: [['createdAt', 'DESC']],
      });
      return res.json({ success: true, data: { forms: forms.map((f) => f.toJSON()) } });
    }

    const allowed = await canCallerSeeWorkspace(req.user, workspaceId);
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'You do not have access to this workspace.' });
    }
    const forms = await Form.findAll({
      where: { workspaceId },
      order: [['createdAt', 'DESC']],
    });
    res.json({ success: true, data: { forms: forms.map((f) => f.toJSON()) } });
  } catch (err) {
    safeLogger.error('[Form] listForms error', { err });
    res.status(500).json({ success: false, message: 'Failed to list forms.' });
  }
}

async function createForm(req, res) {
  try {
    const { name, description, workspaceId, targetBoardId, fields, isPublic, targetColumnMap } = req.body || {};
    if (!workspaceId) {
      return res.status(400).json({ success: false, message: 'workspaceId is required.' });
    }
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ success: false, message: 'name is required.' });
    }
    const allowed = await canCallerSeeWorkspace(req.user, workspaceId);
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'You do not have access to this workspace.' });
    }

    let normalizedFields = [];
    if (fields !== undefined) {
      const norm = normalizeFields(fields);
      if (!norm.ok) return res.status(400).json({ success: false, message: norm.error });
      normalizedFields = norm.value;
    }

    // Slug — try the name-derived slug first; on conflict append a 6-char
    // suffix. Two retries is plenty; if it still collides something is wrong.
    const baseSlug = slugify(name);
    let slug = baseSlug;
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await Form.findOne({ where: { slug } });
      if (!existing) break;
      slug = `${baseSlug}-${randSuffix()}`;
    }

    const form = await Form.create({
      name: sanitizeInput(name.trim()).slice(0, 200),
      description: description ? sanitizeInput(String(description)).slice(0, 4000) : null,
      slug,
      workspaceId,
      targetBoardId: targetBoardId || null,
      targetColumnMap: normalizeColumnMap(targetColumnMap, normalizedFields),
      fields: normalizedFields,
      isPublic: !!isPublic,
      createdBy: req.user.id,
    });
    res.status(201).json({ success: true, data: { form: form.toJSON() } });
  } catch (err) {
    safeLogger.error('[Form] createForm error', { err });
    res.status(500).json({ success: false, message: 'Failed to create form.' });
  }
}

async function getForm(req, res) {
  try {
    const form = await Form.findByPk(req.params.id);
    if (!form) return res.status(404).json({ success: false, message: 'Form not found.' });
    const allowed = await canCallerSeeWorkspace(req.user, form.workspaceId);
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied.' });
    res.json({ success: true, data: { form: form.toJSON() } });
  } catch (err) {
    safeLogger.error('[Form] getForm error', { err });
    res.status(500).json({ success: false, message: 'Failed to load form.' });
  }
}

async function updateForm(req, res) {
  try {
    const form = await Form.findByPk(req.params.id);
    if (!form) return res.status(404).json({ success: false, message: 'Form not found.' });
    const allowed = await canCallerSeeWorkspace(req.user, form.workspaceId);
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied.' });
    if (!canManageForm(req.user, form)) {
      return res.status(403).json({ success: false, message: 'You do not have permission to edit this form.' });
    }

    const body = req.body || {};
    const updates = {};
    if (typeof body.name === 'string' && body.name.trim()) {
      updates.name = sanitizeInput(body.name.trim()).slice(0, 200);
    }
    if (body.description !== undefined) {
      updates.description = body.description
        ? sanitizeInput(String(body.description)).slice(0, 4000)
        : null;
    }
    if (body.fields !== undefined) {
      const norm = normalizeFields(body.fields);
      if (!norm.ok) return res.status(400).json({ success: false, message: norm.error });
      updates.fields = norm.value;
    }
    if (body.targetBoardId !== undefined) updates.targetBoardId = body.targetBoardId || null;
    if (body.isPublic !== undefined) updates.isPublic = !!body.isPublic;
    if (body.isActive !== undefined) updates.isActive = !!body.isActive;
    if (body.targetColumnMap !== undefined) {
      // Re-validate against the LATEST fields — either the ones being saved
      // this turn or the existing ones on disk if `fields` wasn't sent.
      const fieldsForMap = updates.fields || form.fields || [];
      updates.targetColumnMap = normalizeColumnMap(body.targetColumnMap, fieldsForMap);
    }

    await form.update(updates);
    res.json({ success: true, data: { form: form.toJSON() } });
  } catch (err) {
    safeLogger.error('[Form] updateForm error', { err });
    res.status(500).json({ success: false, message: 'Failed to update form.' });
  }
}

async function deleteForm(req, res) {
  try {
    const form = await Form.findByPk(req.params.id);
    if (!form) return res.status(404).json({ success: false, message: 'Form not found.' });
    const allowed = await canCallerSeeWorkspace(req.user, form.workspaceId);
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied.' });
    if (!canManageForm(req.user, form)) {
      return res.status(403).json({ success: false, message: 'You do not have permission to delete this form.' });
    }
    await form.destroy();
    res.json({ success: true, message: 'Form deleted.' });
  } catch (err) {
    safeLogger.error('[Form] deleteForm error', { err });
    res.status(500).json({ success: false, message: 'Failed to delete form.' });
  }
}

// ─── Submissions ──────────────────────────────────────────────────────

async function listSubmissions(req, res) {
  try {
    const form = await Form.findByPk(req.params.id);
    if (!form) return res.status(404).json({ success: false, message: 'Form not found.' });
    const allowed = await canCallerSeeWorkspace(req.user, form.workspaceId);
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied.' });

    const limit = Math.min(Number(req.query?.limit) || 100, 500);
    const offset = Math.max(Number(req.query?.offset) || 0, 0);
    const submissions = await FormSubmission.findAll({
      where: { formId: form.id },
      order: [['createdAt', 'DESC']],
      limit,
      offset,
    });
    res.json({
      success: true,
      data: { submissions: submissions.map((s) => s.toJSON()) },
    });
  } catch (err) {
    safeLogger.error('[Form] listSubmissions error', { err });
    res.status(500).json({ success: false, message: 'Failed to list submissions.' });
  }
}

// PUBLIC endpoint. No auth required — gated by form.isPublic + form.isActive.
// Anonymous submissions are allowed and tracked by IP/UA only.
async function submitPublicForm(req, res) {
  try {
    const form = await Form.findOne({ where: { slug: req.params.slug } });
    if (!form || !form.isActive) {
      return res.status(404).json({ success: false, message: 'Form not found or inactive.' });
    }
    if (!form.isPublic) {
      return res.status(403).json({ success: false, message: 'This form is not public.' });
    }

    const validated = validatePayload(form, req.body || {});
    if (!validated.ok) {
      return res.status(400).json({ success: false, message: validated.error });
    }

    const sub = await FormSubmission.create({
      formId: form.id,
      payload: validated.value,
      submitterEmail: validated.submitterEmail || null,
      // req.ip is express's best guess; behind a trusted proxy we'd
      // configure `app.set('trust proxy', ...)` to expose X-Forwarded-For.
      submitterIp: req.ip ? String(req.ip).slice(0, 64) : null,
      submitterUserAgent: req.get('user-agent') ? String(req.get('user-agent')).slice(0, 500) : null,
      // Authenticated public submitters (rare — they're still hitting the
      // /public/ path) are still attributed to their user id if present.
      submittedByUserId: req.user?.id || null,
    });

    // Phase F2 — when the form has a target board AND a column map with at
    // least `title` set, auto-create a Task on that board and link it from
    // the submission row. Errors are caught + logged but never propagate:
    // a failed Task insert must not stop the submitter from getting a 201.
    if (form.targetBoardId && form.targetColumnMap && form.targetColumnMap.title) {
      try {
        const taskAttrs = buildTaskAttrsFromSubmission(form, validated.value);
        if (taskAttrs) {
          const task = await Task.create({
            ...taskAttrs,
            createdBy: form.createdBy || null,
          });
          await sub.update({ taskId: task.id });
        }
      } catch (autoErr) {
        safeLogger.warn('[Form] auto-task-creation failed (non-fatal)', { err: autoErr, formId: form.id });
      }
    }

    // Denormalized counter — best-effort; non-fatal if it fails.
    try { await form.increment('submissionCount'); } catch { /* noop */ }

    // Fire any workflows with a 'form_submitted' trigger that match this
    // form. Fire-and-forget — never await, never propagate errors out to the
    // submitter. Matches the call-site contract of taskController's task
    // triggers (which also fan out via processWorkflows on every mutation).
    try {
      const { processWorkflows } = require('../services/workflowEngine');
      // Async + un-awaited on purpose. We don't want a slow downstream
      // action (Teams card, etc.) to delay the public 201 response.
      processWorkflows('form_submitted', {
        workspaceId: form.workspaceId,
        boardId: form.targetBoardId || null,
        form: { id: form.id, name: form.name, slug: form.slug },
        submission: { id: sub.id },
        payload: validated.value,
        userId: req.user?.id || null,
      });
    } catch (wfErr) {
      safeLogger.warn('[Form] processWorkflows enqueue failed (non-fatal)', { err: wfErr, formId: form.id });
    }

    // Return a TINY confirmation payload. We deliberately don't leak the
    // submission id or full payload back to anonymous submitters.
    res.status(201).json({ success: true, data: { submittedAt: sub.createdAt } });
  } catch (err) {
    safeLogger.error('[Form] submitPublicForm error', { err });
    res.status(500).json({ success: false, message: 'Submission failed.' });
  }
}

// PUBLIC endpoint for the form-view page: returns the field schema only,
// never the workspace/board names or creator info.
async function getPublicForm(req, res) {
  try {
    const form = await Form.findOne({ where: { slug: req.params.slug } });
    if (!form || !form.isActive || !form.isPublic) {
      return res.status(404).json({ success: false, message: 'Form not found.' });
    }
    res.json({
      success: true,
      data: {
        form: {
          slug: form.slug,
          name: form.name,
          description: form.description,
          fields: form.fields,
        },
      },
    });
  } catch (err) {
    safeLogger.error('[Form] getPublicForm error', { err });
    res.status(500).json({ success: false, message: 'Failed to load form.' });
  }
}

// POST /api/forms/:id/submissions/:submissionId/promote — manually promote
// a stored submission to a Task on the form's targetBoardId. Used when the
// form wasn't configured for auto-creation, or when a previous auto-create
// failed (in which case it acts as a retry).
async function promoteSubmission(req, res) {
  try {
    const form = await Form.findByPk(req.params.id);
    if (!form) return res.status(404).json({ success: false, message: 'Form not found.' });
    const allowed = await canCallerSeeWorkspace(req.user, form.workspaceId);
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied.' });
    if (!canManageForm(req.user, form)) {
      return res.status(403).json({ success: false, message: 'You do not have permission to promote submissions.' });
    }
    if (!form.targetBoardId) {
      return res.status(400).json({ success: false, message: 'This form has no target board. Set one on the form before promoting.' });
    }
    if (!form.targetColumnMap || !form.targetColumnMap.title) {
      return res.status(400).json({ success: false, message: 'Map at least the task Title field before promoting submissions.' });
    }

    const submission = await FormSubmission.findByPk(req.params.submissionId);
    if (!submission || submission.formId !== form.id) {
      return res.status(404).json({ success: false, message: 'Submission not found.' });
    }
    if (submission.taskId) {
      return res.status(409).json({ success: false, message: 'This submission already has a task — no-op.' });
    }

    const taskAttrs = buildTaskAttrsFromSubmission(form, submission.payload || {});
    if (!taskAttrs) {
      return res.status(400).json({ success: false, message: 'Submission has no value for the mapped Title field.' });
    }

    const task = await Task.create({
      ...taskAttrs,
      createdBy: req.user.id,
    });
    await submission.update({ taskId: task.id });
    res.json({ success: true, data: { submission: submission.toJSON(), taskId: task.id } });
  } catch (err) {
    safeLogger.error('[Form] promoteSubmission error', { err });
    res.status(500).json({ success: false, message: 'Promote failed.' });
  }
}

module.exports = {
  listForms,
  createForm,
  getForm,
  updateForm,
  deleteForm,
  listSubmissions,
  submitPublicForm,
  getPublicForm,
  promoteSubmission,
};
