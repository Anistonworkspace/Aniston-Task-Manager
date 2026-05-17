import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { FileSpreadsheet, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { getPublicForm, submitPublicForm } from '../../services/formsService';
import safeLog from '../../utils/safeLog';
import { getErrorMessage } from '../../utils/errorMap';

/**
 * FormViewPage — public submit page mounted at /f/:slug.
 *
 * Renders zero workspace metadata — only the slim public payload from
 * GET /api/forms/public/:slug. Submissions hit the matching POST endpoint
 * which the server also keeps anonymous-friendly.
 *
 * The page is route-mounted OUTSIDE the authenticated Layout so an
 * unauthenticated visitor never bounces through /login.
 */

export default function FormViewPage() {
  const { slug } = useParams();
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [values, setValues] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const { form: data } = await getPublicForm(slug);
      setForm(data);
      // Seed empty values so checkbox / inputs render in a stable state.
      const seed = {};
      (data?.fields || []).forEach((f) => {
        seed[f.id] = f.type === 'checkbox' ? false : '';
      });
      setValues(seed);
    } catch (err) {
      safeLog.warn('[FormViewPage] load error', err);
      setLoadError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => { load(); }, [load]);

  function setField(id, value) {
    setValues((v) => ({ ...v, [id]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError('');
    try {
      await submitPublicForm(slug, values);
      setSubmitted(true);
    } catch (err) {
      setSubmitError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <PageShell>
        <div className="h-7 w-48 bg-surface-100 rounded animate-pulse mb-3" />
        <div className="h-4 w-80 bg-surface-100 rounded animate-pulse" />
      </PageShell>
    );
  }

  if (loadError || !form) {
    return (
      <PageShell>
        <div className="flex items-start gap-3 text-danger">
          <AlertCircle size={20} className="flex-shrink-0 mt-0.5" />
          <div>
            <h1 className="text-lg font-semibold">Form unavailable</h1>
            <p className="text-sm text-text-secondary mt-1">
              {loadError || 'This form may have been deactivated or moved.'}
            </p>
          </div>
        </div>
      </PageShell>
    );
  }

  if (submitted) {
    return (
      <PageShell>
        <div className="text-center py-6">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-emerald-100 text-emerald-600 mb-3">
            <CheckCircle2 size={22} />
          </div>
          <h1 className="text-lg font-semibold text-text-primary">Thanks — your response was recorded.</h1>
          {form.description && (
            <p className="text-sm text-text-secondary mt-2 max-w-md mx-auto">{form.description}</p>
          )}
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <header className="mb-5">
        <div className="flex items-center gap-2 text-text-tertiary text-xs mb-1">
          <FileSpreadsheet size={13} />
          <span>Public form</span>
        </div>
        <h1 className="text-xl font-bold text-text-primary">{form.name}</h1>
        {form.description && (
          <p className="text-sm text-text-secondary mt-1.5">{form.description}</p>
        )}
      </header>

      <form onSubmit={handleSubmit} className="space-y-4">
        {(form.fields || []).map((field) => (
          <FieldInput
            key={field.id}
            field={field}
            value={values[field.id]}
            onChange={(v) => setField(field.id, v)}
          />
        ))}

        {submitError && (
          <div className="flex items-start gap-2 p-2.5 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
            <AlertCircle size={13} className="flex-shrink-0 mt-0.5" />
            {submitError}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-semibold bg-primary text-white hover:bg-primary-600 disabled:opacity-60"
        >
          {submitting && <Loader2 size={13} className="animate-spin" />}
          Submit
        </button>
      </form>
    </PageShell>
  );
}

function PageShell({ children }) {
  return (
    <div className="min-h-screen bg-surface-50 flex items-start justify-center px-4 py-12">
      <div className="w-full max-w-xl rounded-lg bg-surface shadow-sm border border-border-light p-6">
        {children}
      </div>
    </div>
  );
}

function FieldInput({ field, value, onChange }) {
  const id = `f-${field.id}`;
  const inputProps = {
    id,
    placeholder: field.placeholder || '',
    required: !!field.required,
    className: 'w-full px-2.5 py-1.5 text-sm border border-border rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary',
  };

  return (
    <div>
      <label htmlFor={id} className="block text-xs font-semibold text-text-secondary mb-1">
        {field.label}
        {field.required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {field.type === 'textarea' ? (
        <textarea
          rows={3}
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          {...inputProps}
        />
      ) : field.type === 'select' ? (
        <select
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          {...inputProps}
        >
          <option value="">Select…</option>
          {(field.options || []).map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      ) : field.type === 'checkbox' ? (
        <label className="inline-flex items-center gap-2 text-sm text-text-primary cursor-pointer">
          <input
            id={id}
            type="checkbox"
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
          />
          {field.placeholder || 'Yes'}
        </label>
      ) : (
        <input
          type={field.type === 'email' ? 'email' : field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          {...inputProps}
        />
      )}
    </div>
  );
}
