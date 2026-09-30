// Cloud LLM provider stack editor — fallback chain and role routing.
//
// Extracted from Agents.tsx, which held 40+ useState hooks in one component.
// This modal owns its own configuration state, loads the stored stack on open,
// and saves it: the page no longer threads five pieces of LLM state through
// its render just to hand them to a dialog.
//
// The page still owns the toast/confirm providers and passes them down, since
// those are shell-level concerns.
import { useCallback, useEffect, useState } from 'react';
import { api, LLMConfig, LLMProviderEntry } from '../api/client';
import { Modal } from './Modal';
import { IconBot } from './Icons';
import { useToast } from './ToastProvider';

interface Props {
  onClose: () => void;
}

type Entry = {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  role: string | null;
};

/** Provider defaults applied when the picker changes, so the form is never blank. */
const PROVIDER_DEFAULTS: Record<string, { model: string; baseUrl?: string }> = {
  '9router': { model: 'claude-3-5-sonnet-20241022', baseUrl: 'https://api.9router.com/v1' },
  anthropic: { model: 'claude-3-5-sonnet-20241022' },
  openai: { model: 'gpt-4o-mini' },
  deepseek: { model: 'deepseek-chat' },
  openrouter: { model: 'anthropic/claude-3.5-sonnet' },
  custom: { model: 'claude-3-5-sonnet-20241022', baseUrl: 'https://api.openai.com/v1' },
};

const NEW_ENTRY: Entry = { provider: 'openai', apiKey: '', model: 'gpt-4o-mini', baseUrl: '', role: null };

/** Map the stored config to form rows, tolerating the single-entry legacy shape. */
function entriesFromConfig(cfg: LLMConfig | null): Entry[] {
  if (cfg?.entries?.length) {
    return cfg.entries.map((e) => ({
      provider: e.provider,
      apiKey: '', // never echo a key back into the form; blank means "leave stored"
      model: e.model,
      baseUrl: e.baseUrl ?? '',
      role: e.role,
    }));
  }
  if (cfg) {
    return [{
      provider: cfg.provider ?? '9router',
      apiKey: '',
      model: cfg.model ?? 'claude-3-5-sonnet-20241022',
      baseUrl: cfg.baseUrl ?? 'https://api.9router.com/v1',
      role: null,
    }];
  }
  return [{
    provider: '9router', apiKey: '', model: 'claude-3-5-sonnet-20241022',
    baseUrl: 'https://api.9router.com/v1', role: null,
  }];
}

export function LlmConfigModal({ onClose }: Props) {
  const toast = useToast();
  const [cfg, setCfg] = useState<LLMConfig | null>(null);
  const [entries, setEntries] = useState<Entry[]>(() => entriesFromConfig(null));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  // Per-row: fetched model list (datalist) + last connection-test result.
  const [models, setModels] = useState<Record<number, string[]>>({});
  const [busy, setBusy] = useState<Record<number, 'models' | 'test' | undefined>>({});
  const [testResult, setTestResult] = useState<Record<number, { ok: boolean; text: string } | undefined>>({});

  // Load the stored stack once, so the form opens on the user's real config
  // rather than the placeholder default.
  useEffect(() => {
    let cancelled = false;
    api.getLLMConfig()
      .then((c) => { if (!cancelled) { setCfg(c); setEntries(entriesFromConfig(c)); } })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const patch = useCallback((idx: number, change: Partial<Entry>) => {
    setEntries((prev) => prev.map((x, i) => (i === idx ? { ...x, ...change } : x)));
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErr('');
    try {
      // Send the full stack; a row without a typed key keeps the stored key
      // (the backend treats a missing apiKey as "leave existing").
      const payload: LLMProviderEntry[] = entries.map((entry) => ({
        provider: entry.provider as LLMProviderEntry['provider'],
        ...(entry.apiKey.trim() ? { apiKey: entry.apiKey } : {}),
        model: entry.model,
        baseUrl: entry.provider === '9router' || entry.provider === 'custom' ? entry.baseUrl : undefined,
        role: (entry.role as LLMProviderEntry['role']) ?? null,
      }));
      await api.setLLMConfig(payload);
      toast.showToast('Konfigurasi LLM tersimpan', 'success');
      onClose();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Gagal menyimpan konfigurasi LLM';
      setErr(message.slice(0, 200));
      toast.showToast(message.slice(0, 120), 'error');
    } finally {
      setSaving(false);
    }
  };

  /** Fetch /v1/models for one row (the 9router-style combo). */
  const handleLoadModels = async (idx: number) => {
    const entry = entries[idx];
    if (!entry) return;
    setBusy((b) => ({ ...b, [idx]: 'models' }));
    setTestResult((r) => ({ ...r, [idx]: undefined }));
    try {
      const { models: list } = await api.llmModels(
        entry.apiKey.trim() ? { provider: entry.provider, baseUrl: entry.baseUrl, apiKey: entry.apiKey } : undefined,
      );
      setModels((m) => ({ ...m, [idx]: list }));
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Gagal memuat model';
      setModels((m) => ({ ...m, [idx]: [] }));
      setTestResult((r) => ({ ...r, [idx]: { ok: false, text: `❌ Muat model: ${message.slice(0, 180)}` } }));
    } finally {
      setBusy((b) => ({ ...b, [idx]: undefined }));
    }
  };

  /** Probe the connection (models first, chat ping fallback) — show the message verbatim. */
  const handleTest = async (idx: number) => {
    const entry = entries[idx];
    if (!entry) return;
    setBusy((b) => ({ ...b, [idx]: 'test' }));
    try {
      const r = await api.llmTest(
        entry.apiKey.trim()
          ? { provider: entry.provider, model: entry.model, baseUrl: entry.baseUrl, apiKey: entry.apiKey }
          : {},
      );
      if (r.ok) {
        const detail = r.via === 'models'
          ? `${r.modelCount} model · ${r.latencyMs}ms`
          : r.sample ? `sample: ${r.sample} · ${r.latencyMs}ms` : `${r.latencyMs}ms`;
        setTestResult((prev) => ({ ...prev, [idx]: { ok: true, text: `✅ OK · ${detail}` } }));
        if (r.models?.length) setModels((m) => ({ ...m, [idx]: r.models! }));
      } else {
        setTestResult((prev) => ({ ...prev, [idx]: { ok: false, text: `❌ ${r.error || r.modelsError || 'Gagal koneksi'} · ${r.latencyMs}ms` } }));
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Gagal tes koneksi';
      setTestResult((prev) => ({ ...prev, [idx]: { ok: false, text: `❌ ${message.slice(0, 180)}` } }));
    } finally {
      setBusy((b) => ({ ...b, [idx]: undefined }));
    }
  };

  return (
    <Modal title={<><IconBot size={16} /> Konfigurasi Model AI (Cloud LLM)</>} onClose={onClose} maxWidth={480}>
      <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 18, lineHeight: 1.5 }}>
        Multi-LLM: susun beberapa provider sebagai fallback chain (primary → fallback) dan/atau role routing
        (Bull / Bear / Lead bisa pakai model berbeda). Kosongkan api key pada baris fallback yang tidak dipakai.
      </p>

      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      <form onSubmit={handleSave}>
        {entries.map((entry, idx) => (
          <div key={idx} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <strong style={{ fontSize: 12, color: 'var(--muted)' }}>
                {idx === 0 ? 'PRIMARY' : `FALLBACK ${idx}`}
              </strong>
              {idx > 0 && (
                <button
                  type="button"
                  className="btn icon"
                  style={{ minHeight: 26, minWidth: 26, padding: 2, fontSize: 11 }}
                  onClick={() => setEntries((prev) => prev.filter((_, i) => i !== idx))}
                  aria-label={`Hapus provider ${idx}`}
                >
                  ✕
                </button>
              )}
            </div>

            <div className="grid-2" style={{ marginBottom: 8 }}>
              <select
                className="input"
                style={{ width: '100%' }}
                value={entry.provider}
                aria-label="Provider"
                onChange={(e) => {
                  const p = e.target.value;
                  patch(idx, { provider: p, ...(PROVIDER_DEFAULTS[p] ?? {}) });
                }}
              >
                <option value="9router">9router (Gateway)</option>
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="openai">OpenAI (GPT)</option>
                <option value="deepseek">DeepSeek</option>
                <option value="openrouter">OpenRouter</option>
                <option value="custom">Custom Endpoint</option>
              </select>
              <select
                className="input"
                style={{ width: '100%' }}
                value={entry.role ?? ''}
                aria-label="Role routing"
                onChange={(e) => patch(idx, { role: e.target.value || null })}
              >
                <option value="">Role: Semua (fallback)</option>
                <option value="bull">Role: Bull only</option>
                <option value="bear">Role: Bear only</option>
                <option value="lead">Role: Lead only</option>
              </select>
            </div>

            {(entry.provider === '9router' || entry.provider === 'custom') && (
              <input
                type="text"
                className="input"
                style={{ width: '100%', marginBottom: 8 }}
                value={entry.baseUrl}
                onChange={(e) => patch(idx, { baseUrl: e.target.value })}
                placeholder="http://localhost:20128/v1 (9router lokal) atau https://api.9router.com/v1"
                aria-label="Base URL"
              />
            )}

            {/* Model combo — datalist from /v1/models (9router-style) + free input. */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              <input
                type="text"
                className="input"
                style={{ flex: 1, minWidth: 0 }}
                value={entry.model}
                onChange={(e) => patch(idx, { model: e.target.value })}
                placeholder="nama model (kc/nvidia/…:free / gpt-4o / deepseek-chat)"
                list={`llm-models-${idx}`}
                required
                aria-label="Model"
              />
              <datalist id={`llm-models-${idx}`}>
                {(models[idx] ?? []).map((m) => <option key={m} value={m} />)}
              </datalist>
              <button
                type="button"
                className="btn"
                style={{ minHeight: 44, fontSize: 12, whiteSpace: 'nowrap' }}
                disabled={busy[idx] === 'models'}
                onClick={() => handleLoadModels(idx)}
                title="Ambil daftar model dari endpoint /v1/models"
              >
                {busy[idx] === 'models' ? '…' : `Muat Model${models[idx]?.length ? ` (${models[idx].length})` : ''}`}
              </button>
            </div>

            <input
              type="password"
              className="input"
              style={{ width: '100%' }}
              value={entry.apiKey}
              onChange={(e) => patch(idx, { apiKey: e.target.value })}
              placeholder={cfg?.entries?.[idx]?.hasKey ? `Tersimpan: ${cfg.entries[idx].maskedKey} — isi untuk ganti` : 'API key (kosongkan jika tidak dipakai)'}
              aria-label="API key"
            />

            {/* Connection test — verifies key/baseUrl/model without running the autopilot. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn"
                style={{ minHeight: 32, padding: '4px 12px', fontSize: 12 }}
                disabled={busy[idx] === 'test'}
                onClick={() => handleTest(idx)}
              >
                {busy[idx] === 'test' ? 'Menguji…' : 'Tes Koneksi'}
              </button>
              {testResult[idx] && (
                <span style={{ fontSize: 12, color: testResult[idx]!.ok ? 'var(--up)' : 'var(--down)', wordBreak: 'break-word', flex: 1, minWidth: 0 }}>
                  {testResult[idx]!.text}
                </span>
              )}
            </div>
          </div>
        ))}

        <button
          type="button"
          className="btn"
          style={{ width: '100%', marginBottom: 14, fontSize: 12, minHeight: 36 }}
          onClick={() => setEntries((prev) => [...prev, { ...NEW_ENTRY }])}
        >
          + Tambah Provider (Fallback / Role)
        </button>

        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" className="btn" style={{ flex: 1 }} onClick={onClose}>Batal</button>
          <button type="submit" className="btn primary" style={{ flex: 1 }} disabled={saving}>
            {saving ? 'Menyimpan…' : 'Simpan & Terapkan'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
