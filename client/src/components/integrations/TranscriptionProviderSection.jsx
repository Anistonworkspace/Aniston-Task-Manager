import React, { useState, useEffect, useCallback } from 'react';
import {
  Headphones, CheckCircle2, AlertCircle, Plus, Key, TestTube2, Edit3,
  Trash2, Save, Power, Sparkles, Eye, EyeOff, Users, X,
} from 'lucide-react';
import api from '../../services/api';

const PROVIDER_TYPES = [
  { value: 'deepgram', label: 'Deepgram', color: '#13EF93', icon: 'D', defaultModel: 'nova-3' },
  { value: 'custom', label: 'Custom', color: '#6B7280', icon: 'C', defaultModel: '' },
];

const MODEL_OPTIONS = {
  deepgram: ['nova-3', 'nova-2', 'nova', 'enhanced'],
  custom: [],
};

const LANGUAGES = [
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'multi', label: 'Multilingual (code-switching)' },
  { value: 'hi', label: 'Hindi' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ja', label: 'Japanese' },
];

const EMPTY_FORM = {
  name: '',
  providerType: 'deepgram',
  apiKey: '',
  model: 'nova-3',
  language: 'en-US',
  baseUrl: '',
  diarizationEnabled: true,
};

export default function TranscriptionProviderSection({ onError, onSuccess }) {
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState(null);
  const [showKey, setShowKey] = useState({});
  const [form, setForm] = useState(EMPTY_FORM);

  const loadProviders = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/transcription/providers');
      setProviders(res.data?.data || []);
    } catch {
      setProviders([]);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadProviders(); }, [loadProviders]);

  const handleAdd = async () => {
    if (!form.name.trim()) return onError('Provider name is required.');
    if (!form.apiKey) return onError('API key is required.');
    setSaving(true);
    try {
      await api.post('/transcription/providers', form);
      onSuccess(`${form.name} provider added successfully.`);
      setShowAdd(false);
      setForm(EMPTY_FORM);
      loadProviders();
    } catch (err) {
      onError(err.response?.data?.message || 'Failed to add transcription provider.');
    } finally { setSaving(false); }
  };

  const handleUpdate = async (id) => {
    setSaving(true);
    try {
      const payload = { ...form };
      if (!payload.apiKey) delete payload.apiKey; // keep existing key
      await api.put(`/transcription/providers/${id}`, payload);
      onSuccess('Transcription provider updated successfully.');
      setEditingId(null);
      setForm(EMPTY_FORM);
      loadProviders();
    } catch (err) {
      onError(err.response?.data?.message || 'Failed to update transcription provider.');
    } finally { setSaving(false); }
  };

  const handleDelete = async (id, name) => {
    if (!confirm(`Remove ${name} provider? This cannot be undone.`)) return;
    try {
      await api.delete(`/transcription/providers/${id}`);
      onSuccess(`${name} provider removed.`);
      loadProviders();
    } catch (err) {
      onError(err.response?.data?.message || 'Failed to remove transcription provider.');
    }
  };

  const handleTest = async (id) => {
    setTestingId(id);
    try {
      const res = await api.post(`/transcription/providers/${id}/test`);
      if (res.data?.success) {
        onSuccess(res.data?.message || 'Connection successful!');
        loadProviders();
      } else {
        const diag = res.data?.data?.diagnostics;
        const diagLine = diag ? `\n[Diagnostics] Type: ${diag.providerType || '?'} | Model: ${diag.model || '?'} | Key: ${diag.keySuffix || '?'} | HTTP: ${diag.httpStatus || 'N/A'}` : '';
        onError((res.data?.message || 'Connection test failed.') + diagLine);
      }
    } catch (err) {
      onError(err.response?.data?.message || 'Connection test failed.');
    } finally { setTestingId(null); }
  };

  const handleTestNew = async () => {
    if (!form.apiKey) return onError('API key is required to test.');
    setTestingId('new');
    try {
      const res = await api.post('/transcription/test', {
        providerType: form.providerType,
        apiKey: form.apiKey,
        baseUrl: form.baseUrl,
      });
      if (res.data?.success) onSuccess(res.data?.message || 'Connection successful!');
      else {
        const diag = res.data?.data?.diagnostics;
        const diagLine = diag ? `\n[Diagnostics] Type: ${diag.providerType || '?'} | Key: ${diag.keySuffix || '?'} | HTTP: ${diag.httpStatus || 'N/A'}` : '';
        onError((res.data?.message || 'Connection test failed.') + diagLine);
      }
    } catch (err) {
      onError(err.response?.data?.message || 'Connection test failed.');
    } finally { setTestingId(null); }
  };

  const handleSetDefault = async (id) => {
    try {
      await api.post(`/transcription/providers/${id}/set-default`);
      onSuccess('Default transcription provider updated.');
      loadProviders();
    } catch (err) {
      onError(err.response?.data?.message || 'Failed to set default.');
    }
  };

  const handleToggle = async (id) => {
    try {
      await api.post(`/transcription/providers/${id}/toggle`);
      loadProviders();
    } catch (err) {
      onError(err.response?.data?.message || 'Failed to toggle provider.');
    }
  };

  const startEdit = (p) => {
    setEditingId(p.id);
    setShowAdd(false);
    setForm({
      name: p.name,
      providerType: p.providerType,
      apiKey: '',
      model: p.model || 'nova-3',
      language: p.language || 'en-US',
      baseUrl: p.baseUrl || '',
      diarizationEnabled: !!p.diarizationEnabled,
    });
  };

  const activeCount = providers.filter(p => p.isActive).length;

  return (
    <div className="mb-6">
      {/* Section Header */}
      <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden mb-4">
        <div className="flex items-center gap-4 p-5">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-600 to-cyan-600 flex items-center justify-center shadow-lg">
            <Headphones size={24} className="text-white" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold text-text-primary">Transcription Provider</h2>
            <p className="text-xs text-text-tertiary">Configure speech-to-text providers for meeting transcription with speaker diarization</p>
          </div>
          <div className="flex items-center gap-2">
            {activeCount > 0 ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full bg-success/10 text-success border border-success/20">
                <CheckCircle2 size={12} /> {activeCount} Active
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full bg-gray-100 text-gray-500 border border-gray-200">
                Not Configured
              </span>
            )}
            <button onClick={() => { setShowAdd(true); setEditingId(null); setForm(EMPTY_FORM); }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors shadow-sm">
              <Plus size={13} /> Add Provider
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-6 w-6 border-2 border-emerald-500/20 border-t-emerald-500" />
        </div>
      ) : (
        <>
          <div className="space-y-4">
            {providers.map(p => {
              const meta = PROVIDER_TYPES.find(t => t.value === p.providerType) || PROVIDER_TYPES[PROVIDER_TYPES.length - 1];
              const isEditing = editingId === p.id;
              const isTesting = testingId === p.id;
              return (
                <div key={p.id} className={`bg-white rounded-xl border shadow-sm overflow-hidden transition-all ${p.isDefault ? 'border-emerald-300 ring-1 ring-emerald-200' : 'border-border'}`}>
                  {isEditing ? (
                    <ProviderForm
                      title={`Edit ${meta.label} Provider`}
                      form={form}
                      setForm={setForm}
                      saving={saving}
                      testing={testingId === p.id}
                      showKey={showKey[p.id]}
                      setShowKey={(v) => setShowKey(prev => ({ ...prev, [p.id]: v }))}
                      onSave={() => handleUpdate(p.id)}
                      onCancel={() => { setEditingId(null); setForm(EMPTY_FORM); }}
                      onTest={() => handleTest(p.id)}
                      currentKey={p.apiKey}
                    />
                  ) : (
                    <div className="p-5">
                      <div className="flex items-center gap-4 flex-wrap">
                        <div className="w-11 h-11 rounded-xl flex items-center justify-center text-white font-bold text-base shadow-md"
                          style={{ backgroundColor: meta.color }}>
                          {meta.icon}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="text-sm font-semibold text-text-primary">{p.name}</h3>
                            <span className="text-[10px] uppercase tracking-wider text-text-tertiary">{meta.label}</span>
                            {p.isDefault && (
                              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200">
                                Default
                              </span>
                            )}
                            {p.isActive ? (
                              <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-success/10 text-success border border-success/20">
                                <CheckCircle2 size={10} /> Active
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 border border-gray-200">
                                Inactive
                              </span>
                            )}
                            {p.diarizationEnabled && (
                              <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-violet-100 text-violet-700 border border-violet-200">
                                <Users size={10} /> Diarization
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-text-tertiary mt-0.5">
                            Model: <span className="font-mono">{p.model || '(default)'}</span>
                            {p.language && <> &middot; Lang: <span className="font-mono">{p.language}</span></>}
                            {p.baseUrl && <> &middot; URL: <span className="font-mono">{p.baseUrl}</span></>}
                          </p>
                        </div>
                        <div className="hidden md:flex items-center gap-4">
                          <div className="text-right">
                            <p className="text-[10px] text-text-tertiary">API Key</p>
                            <p className="text-xs font-mono text-text-primary">{p.apiKey}</p>
                          </div>
                          {p.lastTestedAt && (
                            <div className="text-right">
                              <p className="text-[10px] text-text-tertiary">Last Tested</p>
                              <p className="text-[10px] text-text-primary">{new Date(p.lastTestedAt).toLocaleString()}</p>
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          <button onClick={() => handleTest(p.id)} disabled={isTesting} title="Test Connection"
                            className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-emerald-600 hover:bg-emerald-50 rounded-lg border border-emerald-200 transition-colors">
                            {isTesting ? <div className="w-3 h-3 border-2 border-emerald-400/20 border-t-emerald-400 rounded-full animate-spin" /> : <TestTube2 size={13} />}
                            Test
                          </button>
                          {!p.isDefault && p.isActive && (
                            <button onClick={() => handleSetDefault(p.id)} title="Set as default"
                              className="p-1.5 rounded-lg text-emerald-500 hover:bg-emerald-50 transition-colors border border-transparent hover:border-emerald-200">
                              <Sparkles size={14} />
                            </button>
                          )}
                          <button onClick={() => handleToggle(p.id)} title={p.isActive ? 'Deactivate' : 'Activate'}
                            className={`p-1.5 rounded-lg transition-colors ${p.isActive ? 'text-success hover:bg-success/10' : 'text-gray-400 hover:bg-gray-100'}`}>
                            <Power size={14} />
                          </button>
                          <button onClick={() => startEdit(p)} title="Edit"
                            className="p-1.5 rounded-lg text-text-tertiary hover:bg-surface hover:text-text-secondary transition-colors">
                            <Edit3 size={14} />
                          </button>
                          <button onClick={() => handleDelete(p.id, p.name)} title="Delete"
                            className="p-1.5 rounded-lg text-danger hover:bg-danger/10 transition-colors">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {providers.length === 0 && !showAdd && (
              <div className="bg-white rounded-xl border border-border shadow-sm p-8 text-center">
                <Headphones size={32} className="mx-auto mb-3 text-emerald-300" />
                <p className="text-sm font-medium text-text-primary mb-1">No transcription providers configured</p>
                <p className="text-xs text-text-tertiary mb-4">Add Deepgram to enable High Accuracy Meeting Mode with speaker diarization.</p>
                <button onClick={() => { setShowAdd(true); setForm(EMPTY_FORM); }}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors shadow-sm">
                  <Plus size={14} /> Add Your First Provider
                </button>
              </div>
            )}
          </div>

          {showAdd && (
            <div className="bg-white rounded-xl border border-emerald-200 shadow-sm overflow-hidden mt-4 animate-fade-in">
              <ProviderForm
                title="Add New Transcription Provider"
                form={form}
                setForm={setForm}
                saving={saving}
                testing={testingId === 'new'}
                showKey={showKey.new}
                setShowKey={(v) => setShowKey(prev => ({ ...prev, new: v }))}
                onSave={handleAdd}
                onCancel={() => { setShowAdd(false); setForm(EMPTY_FORM); }}
                onTest={handleTestNew}
                isNew
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ProviderForm({
  title, form, setForm, saving, testing, showKey, setShowKey,
  onSave, onCancel, onTest, isNew = false, currentKey = '',
}) {
  const providerMeta = PROVIDER_TYPES.find(t => t.value === form.providerType) || PROVIDER_TYPES[0];
  const modelOptions = MODEL_OPTIONS[form.providerType] || [];

  return (
    <div className="p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
          {isNew ? <Plus size={15} /> : <Edit3 size={14} />} {title}
        </h3>
        <button onClick={onCancel} className="text-text-tertiary hover:text-text-secondary">
          <X size={16} />
        </button>
      </div>

      {isNew && (
        <div className="mb-4">
          <label className="block text-xs font-medium text-text-secondary mb-2">Provider Type</label>
          <div className="flex flex-wrap gap-2">
            {PROVIDER_TYPES.map(t => (
              <button key={t.value}
                onClick={() => setForm(prev => ({
                  ...prev,
                  providerType: t.value,
                  model: t.defaultModel || prev.model,
                }))}
                className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-xl border-2 transition-all ${
                  form.providerType === t.value
                    ? 'border-emerald-500 bg-emerald-50 text-emerald-700 shadow-sm'
                    : 'border-border bg-white text-text-secondary hover:border-emerald-200 hover:bg-emerald-50/50'
                }`}>
                <span className="w-6 h-6 rounded-lg flex items-center justify-center text-white text-xs font-bold"
                  style={{ backgroundColor: t.color }}>{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">Display Name</label>
          <input type="text" value={form.name}
            onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
            placeholder={`e.g. ${providerMeta.label} Production`}
            className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all" />
        </div>

        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">
            <span className="flex items-center gap-1"><Key size={12} /> API Key</span>
          </label>
          <div className="relative">
            <input type={showKey ? 'text' : 'password'} value={form.apiKey}
              onChange={e => setForm(p => ({ ...p, apiKey: e.target.value }))}
              placeholder={isNew ? 'Enter your API key' : 'Leave blank to keep current'}
              autoComplete="new-password" data-lpignore="true" data-1p-ignore
              className="w-full px-3 py-2 pr-10 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all" />
            <button type="button" onClick={() => setShowKey(!showKey)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary transition-colors">
              {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          {!isNew && currentKey && <p className="text-[10px] text-text-tertiary mt-1">Current: {currentKey}</p>}
        </div>

        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">Model</label>
          {modelOptions.length > 0 ? (
            <select value={form.model}
              onChange={e => setForm(p => ({ ...p, model: e.target.value }))}
              className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all bg-white">
              {modelOptions.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <input type="text" value={form.model}
              onChange={e => setForm(p => ({ ...p, model: e.target.value }))}
              placeholder="Model identifier"
              className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all" />
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">Language</label>
          <select value={form.language}
            onChange={e => setForm(p => ({ ...p, language: e.target.value }))}
            className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all bg-white">
            {LANGUAGES.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
        </div>

        {form.providerType === 'custom' && (
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Base URL (WebSocket)</label>
            <input type="text" value={form.baseUrl}
              onChange={e => setForm(p => ({ ...p, baseUrl: e.target.value }))}
              placeholder="wss://your-stt-endpoint.com/v1/listen"
              className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all" />
            <p className="text-[10px] text-text-tertiary mt-1">Must speak the Deepgram Live streaming protocol.</p>
          </div>
        )}

        <div className="flex items-center gap-3 md:col-span-2">
          <button type="button" onClick={() => setForm(p => ({ ...p, diarizationEnabled: !p.diarizationEnabled }))}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${form.diarizationEnabled ? 'bg-emerald-600' : 'bg-gray-300'}`}>
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm ${form.diarizationEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
          <div>
            <p className="text-sm text-text-primary font-medium">Enable speaker diarization</p>
            <p className="text-[10px] text-text-tertiary">Automatically label who said what in multi-speaker meetings.</p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 mt-5 flex-wrap">
        <button onClick={onSave} disabled={saving}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors shadow-sm disabled:opacity-60">
          {saving ? <div className="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin" /> : <Save size={14} />}
          {isNew ? 'Save Configuration' : 'Save Changes'}
        </button>
        <button onClick={onTest} disabled={testing}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-emerald-600 hover:bg-emerald-50 rounded-lg border border-emerald-200 transition-colors disabled:opacity-60">
          {testing ? <div className="w-3.5 h-3.5 border-2 border-emerald-400/20 border-t-emerald-400 rounded-full animate-spin" /> : <TestTube2 size={14} />}
          Test Connection
        </button>
        <button onClick={onCancel}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface rounded-lg border border-border transition-colors">
          Cancel
        </button>
      </div>

      {isNew && form.providerType === 'deepgram' && (
        <div className="mt-3 p-3 rounded-lg bg-emerald-50 border border-emerald-200">
          <p className="text-xs text-emerald-700 font-medium mb-1">Deepgram Setup Guide</p>
          <ol className="text-[11px] text-emerald-600 space-y-1 list-decimal list-inside">
            <li>Create an account at <span className="font-mono">console.deepgram.com</span></li>
            <li>Create a new API key with "Member" role in the Projects page</li>
            <li>Paste the key above and choose <span className="font-mono">nova-3</span> for best accuracy</li>
            <li>Click "Test Connection" to verify, then save</li>
          </ol>
        </div>
      )}
    </div>
  );
}
