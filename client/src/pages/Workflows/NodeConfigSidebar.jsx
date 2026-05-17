import React, { useEffect, useMemo, useState } from 'react';
import { X, Zap, PlayCircle, AlertCircle, Trash2 } from 'lucide-react';
import { findCatalogEntry } from './workflowCatalog';
import { listForms } from '../../services/formsService';
import safeLog from '../../utils/safeLog';

/**
 * NodeConfigSidebar — right-side panel that renders a config form for the
 * currently selected workflow node.
 *
 * Form-rendering strategy: each catalog entry declares a small
 * `configFields[]` schema with `{ key, label, type, placeholder?, options? }`.
 * We render one input per field, accumulate edits into a local draft, and
 * commit via `onChange(draft)` on save. The commit handler is the canvas's
 * `updateNode(...)` wrapper, which PATCHes the server.
 *
 * Field types supported in v1:
 *   - text       single-line input
 *   - textarea   multi-line input
 *   - number     numeric input (stored as number)
 *   - select     <select> with `options[]`
 *   - user       in v1 this is a plain text input ("Pick a user or
 *                'assignee'") — the proper user-picker UI is scheduled
 *                for the same slice that wires the assignment-resolution
 *                logic server-side. Kept as text so configs round-trip.
 */

export default function NodeConfigSidebar({ node, onClose, onChange, onDelete, isSaving = false }) {
  const entry = useMemo(
    () => (node ? findCatalogEntry(node.type, node.kind) : null),
    [node]
  );
  const fields = entry?.configFields || [];

  // Local draft mirrors node.config — re-syncs whenever a different node is
  // selected so the form repopulates with that node's stored config.
  const [draft, setDraft] = useState(() => ({ ...(node?.config || {}) }));
  useEffect(() => {
    setDraft({ ...(node?.config || {}) });
  }, [node?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!node) return null;

  function setField(key, value) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function handleSave() {
    if (!onChange) return;
    onChange({ config: draft });
  }

  const accent = node.type === 'trigger'
    ? { bg: 'rgba(245, 158, 11, 0.12)', fg: '#d97706' }
    : { bg: 'rgba(59, 130, 246, 0.12)', fg: '#2563eb' };

  return (
    <aside
      className="w-80 flex-shrink-0 flex flex-col bg-surface border-l border-border"
      data-testid="node-config-sidebar"
    >
      <header className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
        <span
          className="w-7 h-7 rounded-md inline-flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: accent.bg, color: accent.fg }}
        >
          {node.type === 'trigger' ? <Zap size={13} /> : <PlayCircle size={13} />}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-text-tertiary font-bold">
            {node.type === 'trigger' ? 'Trigger' : 'Action'}
          </div>
          <div className="text-sm font-semibold text-text-primary truncate">
            {entry?.label || node.kind}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="p-1 rounded text-text-tertiary hover:bg-surface-100 hover:text-text-secondary"
        >
          <X size={14} />
        </button>
      </header>

      <div className="flex-1 overflow-auto p-3 space-y-3">
        {entry?.comingSoon && (
          <div className="flex items-start gap-2 p-2.5 rounded-md bg-amber-50 border border-amber-200 text-amber-800 text-xs">
            <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold mb-0.5">Coming soon</div>
              This action is a placeholder. The form below is wired but the
              server handler ships in a future slice.
            </div>
          </div>
        )}

        {entry?.description && (
          <p className="text-xs text-text-secondary">{entry.description}</p>
        )}

        {fields.length === 0 ? (
          <div className="text-xs text-text-tertiary italic">
            No configuration needed for this {node.type}.
          </div>
        ) : (
          <div className="space-y-3">
            {fields.map((field) => (
              <FieldRow
                key={field.key}
                field={field}
                value={draft[field.key]}
                onChange={(v) => setField(field.key, v)}
              />
            ))}
          </div>
        )}
      </div>

      <footer className="flex items-center gap-2 px-3 py-2.5 border-t border-border">
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"
            title="Delete this node"
          >
            <Trash2 size={12} /> Delete
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-2.5 py-1.5 rounded-md text-xs font-medium text-text-secondary hover:bg-surface-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className="px-3 py-1.5 rounded-md text-xs font-semibold bg-primary text-white hover:bg-primary-600 disabled:opacity-60 disabled:cursor-wait"
          >
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </footer>
    </aside>
  );
}

function FieldRow({ field, value, onChange }) {
  const id = `wf-cfg-${field.key}`;
  const commonProps = {
    id,
    value: value ?? '',
    onChange: (e) => {
      const v = field.type === 'number'
        ? (e.target.value === '' ? '' : Number(e.target.value))
        : e.target.value;
      onChange(v);
    },
    placeholder: field.placeholder || '',
    className: 'w-full px-2 py-1.5 text-sm border border-border rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary',
  };

  return (
    <div>
      <label htmlFor={id} className="block text-xs font-semibold text-text-secondary mb-1">
        {field.label}
      </label>
      {field.type === 'textarea' ? (
        <textarea rows={3} {...commonProps} />
      ) : field.type === 'select' ? (
        <select {...commonProps}>
          <option value="">Select…</option>
          {(field.options || []).map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      ) : field.type === 'number' ? (
        <input type="number" {...commonProps} />
      ) : field.type === 'form-picker' ? (
        <FormPicker id={id} value={value} onChange={onChange} placeholder={field.placeholder} />
      ) : (
        // 'text' and 'user' both render as a single-line input in v1.
        // A real user-picker will replace `type: 'user'` here in a later slice.
        <input type="text" {...commonProps} />
      )}
      {field.type === 'user' && (
        <p className="mt-1 text-[10px] text-text-tertiary">
          Tip: use the user's ID, or the literal <code className="px-1 rounded bg-surface-100">assignee</code> to
          resolve at run-time.
        </p>
      )}
    </div>
  );
}

// Phase F2 — Form picker for the `form_submitted` trigger. Loads the list of
// forms the caller can see and renders a <select>. The empty option is
// labelled "Any form" because that's the meaningful matcher behaviour on the
// server side. Loads once per mount; the workflow author can hit Save to
// re-commit any time without re-fetching.
function FormPicker({ id, value, onChange, placeholder }) {
  const [forms, setForms] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listForms()
      .then(({ forms: list }) => {
        if (cancelled) return;
        setForms(Array.isArray(list) ? list : []);
      })
      .catch((err) => safeLog.warn('[NodeConfigSidebar] form list load failed', err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <select
      id={id}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      disabled={loading}
      className="w-full px-2 py-1.5 text-sm border border-border rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary disabled:opacity-60"
    >
      <option value="">{loading ? 'Loading forms…' : (placeholder || 'Any form in the workspace')}</option>
      {forms.map((f) => (
        <option key={f.id} value={f.id}>
          {f.name}{f.isPublic ? ' · public' : ''}
        </option>
      ))}
    </select>
  );
}
