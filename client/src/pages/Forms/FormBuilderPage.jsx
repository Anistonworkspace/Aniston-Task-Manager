import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, FileSpreadsheet, Loader2, AlertCircle, Plus, Trash2,
  Globe2, Lock, ExternalLink, Copy, Check, GripVertical,
  LayoutGrid, ArrowRight, Zap,
} from 'lucide-react';
import api from '../../services/api';
import {
  getForm,
  updateForm as updateFormApi,
  listSubmissions,
  promoteSubmission,
} from '../../services/formsService';
import safeLog from '../../utils/safeLog';
import { getErrorMessage } from '../../utils/errorMap';
import { useToast } from '../../components/common/Toast';
import EmptyState from '../../components/common/EmptyState';

/**
 * FormBuilderPage — edit a form's metadata + field schema + see submissions.
 *
 * Layout:
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │ ← Back  [Form title (rename)]    [Public toggle] [Share link]  │
 *   ├──────────────────────────┬─────────────────────────────────────┤
 *   │ Fields builder           │  Submissions tab (recent rows)      │
 *   │  (add / remove / config) │                                     │
 *   └──────────────────────────┴─────────────────────────────────────┘
 *
 * Server contract:
 *   GET   /api/forms/:id                → { form }
 *   PATCH /api/forms/:id                → { form }
 *   GET   /api/forms/:id/submissions    → { submissions }
 */

const FIELD_TYPES = [
  { type: 'text',     label: 'Short text' },
  { type: 'textarea', label: 'Long text' },
  { type: 'email',    label: 'Email' },
  { type: 'number',   label: 'Number' },
  { type: 'date',     label: 'Date' },
  { type: 'select',   label: 'Dropdown' },
  { type: 'checkbox', label: 'Checkbox' },
];

function newFieldId() {
  return 'f_' + Math.random().toString(36).slice(2, 10);
}

export default function FormBuilderPage() {
  const { id: formId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);
  const [savingFields, setSavingFields] = useState(false);
  const [submissions, setSubmissions] = useState([]);
  const [subsLoading, setSubsLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // Local drafts — flushed to server on Save.
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [fields, setFields] = useState([]);
  const [isPublic, setIsPublic] = useState(false);

  // Phase F2 — Task automation drafts. `targetBoardId` is the destination
  // board; `columnMap` maps task field name → form field id.
  const [targetBoardId, setTargetBoardId] = useState('');
  const [columnMap, setColumnMap] = useState({});
  const [boards, setBoards] = useState([]);
  const [savingAutomation, setSavingAutomation] = useState(false);
  const [promotingId, setPromotingId] = useState(null);

  // Hydrate drafts from the loaded form.
  useEffect(() => {
    if (!form) return;
    setName(form.name || '');
    setDescription(form.description || '');
    setFields(Array.isArray(form.fields) ? form.fields : []);
    setIsPublic(!!form.isPublic);
    setTargetBoardId(form.targetBoardId || '');
    setColumnMap(form.targetColumnMap && typeof form.targetColumnMap === 'object' ? form.targetColumnMap : {});
  }, [form?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load the workspace's boards as soon as we know the form's workspaceId,
  // so the "Auto-create task" picker has something to render.
  useEffect(() => {
    if (!form?.workspaceId) return;
    let cancelled = false;
    api.get('/boards').then((res) => {
      if (cancelled) return;
      const list = res.data?.data?.boards || res.data?.boards || res.data?.data || res.data || [];
      const filtered = Array.isArray(list)
        ? list.filter((b) => b.workspaceId === form.workspaceId)
        : [];
      setBoards(filtered);
    }).catch((err) => safeLog.warn('[FormBuilderPage] boards load failed', err));
    return () => { cancelled = true; };
  }, [form?.workspaceId]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const { form: data } = await getForm(formId);
      setForm(data);
    } catch (err) {
      safeLog.error('[FormBuilderPage] load error', err);
      setLoadError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [formId]);

  const loadSubmissions = useCallback(async () => {
    if (!formId) return;
    setSubsLoading(true);
    try {
      const { submissions: rows } = await listSubmissions(formId, { limit: 50 });
      setSubmissions(Array.isArray(rows) ? rows : []);
    } catch (err) {
      safeLog.warn('[FormBuilderPage] submissions load error', err);
    } finally {
      setSubsLoading(false);
    }
  }, [formId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadSubmissions(); }, [loadSubmissions]);

  // ─── field operations (local drafts only — Save flushes to server) ──
  function addField(type) {
    setFields((arr) => [...arr, {
      id: newFieldId(),
      type,
      label: FIELD_TYPES.find((f) => f.type === type)?.label || 'Field',
      required: false,
      ...(type === 'select' ? { options: ['Option 1', 'Option 2'] } : {}),
    }]);
  }
  function removeField(idx) {
    setFields((arr) => arr.filter((_, i) => i !== idx));
  }
  function updateFieldAt(idx, patch) {
    setFields((arr) => arr.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
  }
  function moveField(idx, dir) {
    setFields((arr) => {
      const out = [...arr];
      const swap = idx + dir;
      if (swap < 0 || swap >= out.length) return out;
      [out[idx], out[swap]] = [out[swap], out[idx]];
      return out;
    });
  }

  // ─── save handlers ──────────────────────────────────────────────────
  async function handleSaveMeta() {
    if (!name.trim()) {
      toast.error('Name is required.');
      return;
    }
    setSavingMeta(true);
    try {
      const { form: updated } = await updateFormApi(formId, {
        name: name.trim(),
        description: description.trim() || null,
        isPublic,
      });
      setForm(updated);
      toast.success('Saved');
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSavingMeta(false);
    }
  }

  async function handleSaveFields() {
    setSavingFields(true);
    try {
      const { form: updated } = await updateFormApi(formId, { fields });
      setForm(updated);
      toast.success('Fields saved');
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSavingFields(false);
    }
  }

  async function handleSaveAutomation() {
    setSavingAutomation(true);
    try {
      // Send a sanitized columnMap — only entries pointing at a real
      // current-draft field id. The server re-validates anyway, but
      // pruning here means the form state matches what gets persisted.
      const fieldIds = new Set(fields.map((f) => f.id));
      const pruned = {};
      for (const [k, v] of Object.entries(columnMap)) {
        if (v && fieldIds.has(v)) pruned[k] = v;
      }
      const { form: updated } = await updateFormApi(formId, {
        targetBoardId: targetBoardId || null,
        targetColumnMap: pruned,
      });
      setForm(updated);
      toast.success('Task automation saved');
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSavingAutomation(false);
    }
  }

  async function handlePromote(submission) {
    setPromotingId(submission.id);
    try {
      await promoteSubmission(formId, submission.id);
      toast.success('Submission promoted to task');
      loadSubmissions();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setPromotingId(null);
    }
  }

  function handleCopyPublicUrl() {
    const url = `${window.location.origin}/f/${form?.slug}`;
    navigator.clipboard?.writeText(url).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
      () => toast.info('Copy failed — link: ' + url)
    );
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="h-12 w-64 bg-surface-100 rounded-md animate-pulse mb-3" />
        <div className="h-5 w-96 bg-surface-100 rounded-md animate-pulse mb-6" />
      </div>
    );
  }

  if (loadError || !form) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<AlertCircle size={48} className="text-text-tertiary" />}
          title="Couldn't load this form"
          description={loadError || 'The form may have been deleted or you may not have access.'}
          primaryAction={{ label: 'Back to forms', onClick: () => navigate('/forms') }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <header
        className="flex items-center gap-2 px-4 py-2.5 bg-surface flex-shrink-0"
        style={{ borderBottom: '1px solid var(--layout-border-color, #e2e2e2)' }}
      >
        <button
          type="button"
          onClick={() => navigate('/forms')}
          aria-label="Back to forms"
          className="p-1.5 rounded-md text-text-tertiary hover:bg-surface-100 hover:text-text-secondary"
        >
          <ArrowLeft size={16} />
        </button>
        <span
          className="w-7 h-7 rounded-md inline-flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: 'rgba(14, 165, 233, 0.15)', color: '#0ea5e9' }}
        >
          <FileSpreadsheet size={13} />
        </span>
        <h1 className="text-base font-bold text-text-primary truncate flex-1">
          {form.name || 'Untitled form'}
        </h1>
        <span
          className={`inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border ${
            form.isPublic
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
              : 'bg-gray-100 text-gray-600 border-gray-200'
          }`}
        >
          {form.isPublic ? <><Globe2 size={10} /> Public</> : <><Lock size={10} /> Internal</>}
        </span>
        {form.isPublic && (
          <button
            type="button"
            onClick={handleCopyPublicUrl}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border border-border bg-surface text-text-secondary hover:bg-surface-100"
            title={`Copy public link: /f/${form.slug}`}
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
            {copied ? 'Copied' : 'Copy link'}
          </button>
        )}
      </header>

      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-[1100px] mx-auto grid grid-cols-1 lg:grid-cols-[1fr,360px] gap-6">
          {/* ─── Fields builder ──────────────────────────────────── */}
          <section className="space-y-3">
            <div className="bg-surface rounded-md border border-border-light p-4 space-y-3">
              <div>
                <label className="block text-xs font-semibold text-text-secondary mb-1" htmlFor="form-name">Form name</label>
                <input
                  id="form-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={200}
                  className="w-full px-2.5 py-1.5 text-sm border border-border rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-text-secondary mb-1" htmlFor="form-desc">Description</label>
                <textarea
                  id="form-desc"
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-sm border border-border rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary"
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={isPublic}
                  onChange={(e) => setIsPublic(e.target.checked)}
                />
                Public — anyone with the link can submit (no login required)
              </label>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleSaveMeta}
                  disabled={savingMeta}
                  className="px-3 py-1.5 rounded-md text-xs font-semibold bg-primary text-white hover:bg-primary-600 disabled:opacity-60"
                >
                  {savingMeta && <Loader2 size={11} className="inline-block mr-1 animate-spin" />}
                  Save details
                </button>
              </div>
            </div>

            <div className="bg-surface rounded-md border border-border-light p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-text-primary">Fields</h2>
                <button
                  type="button"
                  onClick={handleSaveFields}
                  disabled={savingFields}
                  className="px-2.5 py-1 rounded-md text-xs font-semibold bg-primary text-white hover:bg-primary-600 disabled:opacity-60"
                >
                  {savingFields && <Loader2 size={11} className="inline-block mr-1 animate-spin" />}
                  Save fields
                </button>
              </div>

              {fields.length === 0 ? (
                <p className="text-xs text-text-tertiary italic">
                  No fields yet. Add one from the panel on the right.
                </p>
              ) : (
                <div className="space-y-2">
                  {fields.map((field, idx) => (
                    <FieldRow
                      key={field.id}
                      field={field}
                      onChange={(patch) => updateFieldAt(idx, patch)}
                      onRemove={() => removeField(idx)}
                      onMoveUp={idx > 0 ? () => moveField(idx, -1) : undefined}
                      onMoveDown={idx < fields.length - 1 ? () => moveField(idx, +1) : undefined}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Task automation (Phase F2) — pick a target board + map form
                fields → task columns. Every submission auto-creates a task
                while this is configured; submissions can be manually
                promoted otherwise. */}
            <div className="bg-surface rounded-md border border-border-light p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-text-primary inline-flex items-center gap-1.5">
                  <Zap size={13} className="text-amber-500" /> Task automation
                </h2>
                <button
                  type="button"
                  onClick={handleSaveAutomation}
                  disabled={savingAutomation}
                  className="px-2.5 py-1 rounded-md text-xs font-semibold bg-primary text-white hover:bg-primary-600 disabled:opacity-60"
                >
                  {savingAutomation && <Loader2 size={11} className="inline-block mr-1 animate-spin" />}
                  Save automation
                </button>
              </div>

              <label className="block text-xs font-semibold text-text-secondary mb-1">Target board</label>
              <select
                value={targetBoardId}
                onChange={(e) => setTargetBoardId(e.target.value)}
                className="w-full px-2.5 py-1.5 text-sm border border-border rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary"
              >
                <option value="">— No automation —</option>
                {boards.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>

              {targetBoardId && (
                <>
                  <p className="mt-3 text-[11px] text-text-tertiary">
                    Map task fields to questions on this form. When at least
                    <code className="px-1 rounded bg-surface-100 mx-0.5">Title</code>
                    is mapped, every submission auto-creates a task.
                  </p>
                  <div className="mt-2 space-y-2">
                    {[
                      { key: 'title', label: 'Title' },
                      { key: 'description', label: 'Description' },
                      { key: 'dueDate', label: 'Due date' },
                      { key: 'priority', label: 'Priority' },
                      { key: 'status', label: 'Status' },
                    ].map((col) => (
                      <ColumnMapRow
                        key={col.key}
                        col={col}
                        fields={fields}
                        value={columnMap[col.key] || ''}
                        onChange={(fid) => setColumnMap((m) => {
                          const out = { ...m };
                          if (fid) out[col.key] = fid;
                          else delete out[col.key];
                          return out;
                        })}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Submissions */}
            <div className="bg-surface rounded-md border border-border-light p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-text-primary">
                  Submissions
                  <span className="text-text-tertiary font-normal ml-1.5">({submissions.length})</span>
                </h2>
                {form.isPublic && (
                  <a
                    href={`/f/${form.slug}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                  >
                    <ExternalLink size={11} /> Open public form
                  </a>
                )}
              </div>
              {subsLoading ? (
                <p className="text-xs text-text-tertiary">Loading…</p>
              ) : submissions.length === 0 ? (
                <p className="text-xs text-text-tertiary italic">
                  No submissions yet.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {submissions.map((s) => (
                    <SubmissionRow
                      key={s.id}
                      submission={s}
                      fields={form.fields}
                      form={form}
                      onPromote={() => handlePromote(s)}
                      promoting={promotingId === s.id}
                    />
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* ─── Right palette ────────────────────────────────────── */}
          <aside className="space-y-3">
            <div className="bg-surface rounded-md border border-border-light p-4">
              <h2 className="text-sm font-semibold text-text-primary mb-2">Add a field</h2>
              <div className="grid grid-cols-2 gap-1.5">
                {FIELD_TYPES.map((ft) => (
                  <button
                    key={ft.type}
                    type="button"
                    onClick={() => addField(ft.type)}
                    className="inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[12px] font-medium text-text-secondary border border-border-light bg-surface hover:border-primary hover:text-primary hover:bg-surface-50 transition-colors"
                  >
                    <Plus size={11} /> {ft.label}
                  </button>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function FieldRow({ field, onChange, onRemove, onMoveUp, onMoveDown }) {
  return (
    <div className="rounded-md border border-border-light bg-surface p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-text-tertiary cursor-grab" title="Drag is not wired yet — use the arrows">
          <GripVertical size={13} />
        </span>
        <span className="text-[10px] uppercase tracking-wide font-bold text-text-tertiary flex-shrink-0">
          {field.type}
        </span>
        <input
          type="text"
          value={field.label || ''}
          onChange={(e) => onChange({ label: e.target.value })}
          maxLength={200}
          placeholder="Question label"
          className="flex-1 px-2 py-1 text-sm border border-border rounded bg-surface focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary"
        />
        <label className="flex items-center gap-1 text-[11px] text-text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={!!field.required}
            onChange={(e) => onChange({ required: e.target.checked })}
          />
          Required
        </label>
        <div className="flex items-center gap-0.5">
          {onMoveUp && (
            <button type="button" onClick={onMoveUp} className="p-1 rounded text-text-tertiary hover:bg-surface-100" title="Move up">▲</button>
          )}
          {onMoveDown && (
            <button type="button" onClick={onMoveDown} className="p-1 rounded text-text-tertiary hover:bg-surface-100" title="Move down">▼</button>
          )}
          <button
            type="button"
            onClick={onRemove}
            className="p-1 rounded text-text-tertiary hover:text-red-600 hover:bg-red-50"
            title="Remove field"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {/* Per-type extras */}
      {field.type === 'select' && (
        <div className="pl-5">
          <label className="block text-[10px] uppercase tracking-wide font-bold text-text-tertiary mb-1">Options (one per line)</label>
          <textarea
            rows={3}
            value={(field.options || []).join('\n')}
            onChange={(e) => onChange({
              options: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
            })}
            className="w-full px-2 py-1 text-xs border border-border rounded bg-surface focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary"
          />
        </div>
      )}
      {(field.type === 'text' || field.type === 'textarea' || field.type === 'email' || field.type === 'number' || field.type === 'date') && (
        <div className="pl-5">
          <input
            type="text"
            value={field.placeholder || ''}
            onChange={(e) => onChange({ placeholder: e.target.value })}
            maxLength={200}
            placeholder="Placeholder (optional)"
            className="w-full px-2 py-1 text-xs border border-border rounded bg-surface focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary"
          />
        </div>
      )}
    </div>
  );
}

function SubmissionRow({ submission, fields, form, onPromote, promoting }) {
  const fieldMap = useMemo(() => {
    const m = new Map();
    (fields || []).forEach((f) => m.set(f.id, f));
    return m;
  }, [fields]);
  const entries = Object.entries(submission.payload || {});
  const linkedTaskId = submission.taskId;
  // Promote button only renders when the form is configured for it AND the
  // submission isn't already linked to a task. Server re-validates these.
  const canPromote = !linkedTaskId
    && form?.targetBoardId
    && form?.targetColumnMap?.title;
  return (
    <details className="rounded-md border border-border-light bg-surface-50 px-2.5 py-1.5 text-xs">
      <summary className="cursor-pointer flex items-center gap-2 text-text-secondary">
        <span className="text-text-tertiary">
          {submission.createdAt ? new Date(submission.createdAt).toLocaleString() : ''}
        </span>
        {submission.submitterEmail && (
          <span className="font-medium text-text-primary truncate">
            {submission.submitterEmail}
          </span>
        )}
        {linkedTaskId && form?.targetBoardId && (
          <a
            href={`/boards/${form.targetBoardId}`}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 hover:underline"
            title={`Linked to task ${linkedTaskId.slice(0, 8)}…`}
          >
            <LayoutGrid size={9} /> Task
          </a>
        )}
        <span className="ml-auto text-text-tertiary">{entries.length} field{entries.length === 1 ? '' : 's'}</span>
        {canPromote && onPromote && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); e.preventDefault(); onPromote(); }}
            disabled={promoting}
            className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-primary text-white hover:bg-primary-600 disabled:opacity-60"
            title="Create a task on the target board from this submission"
          >
            {promoting ? <Loader2 size={9} className="animate-spin" /> : <ArrowRight size={9} />}
            Create task
          </button>
        )}
      </summary>
      <dl className="mt-2 grid grid-cols-[140px,1fr] gap-x-3 gap-y-1">
        {entries.map(([fid, value]) => (
          <React.Fragment key={fid}>
            <dt className="text-text-tertiary truncate">{fieldMap.get(fid)?.label || fid}</dt>
            <dd className="text-text-primary break-words">{String(value)}</dd>
          </React.Fragment>
        ))}
      </dl>
    </details>
  );
}

// Single row of the column-map editor — one task field name + a <select>
// listing the form's user-facing fields.
function ColumnMapRow({ col, fields, value, onChange }) {
  return (
    <div className="grid grid-cols-[110px,1fr] items-center gap-2">
      <label className="text-xs font-semibold text-text-secondary">
        {col.label}
        {col.key === 'title' && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2 py-1 text-xs border border-border rounded bg-surface focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary"
      >
        <option value="">— Not mapped —</option>
        {fields.map((f) => (
          <option key={f.id} value={f.id}>{f.label || f.id} ({f.type})</option>
        ))}
      </select>
    </div>
  );
}
