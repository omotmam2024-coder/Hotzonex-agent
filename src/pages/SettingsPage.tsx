import { useEffect, useState, type FormEvent } from 'react';
import { useBusiness } from '../business/BusinessContext';
import { Field } from '../components/Field';
import { ErrorState, Loading } from '../components/States';
import { ApiError } from '../lib/api';
import { useApi } from '../lib/ApiContext';
import { fetchHealth, type HealthResponse } from '../lib/health';
import { canManage, type Business } from '../lib/types';
import { useResource } from '../lib/useResource';

type Form = Pick<Business, 'name' | 'description' | 'ai_knowledge' | 'ai_enabled' | 'handover_message' | 'timezone'>;

export function SettingsPage({ loadHealth = fetchHealth }: { loadHealth?: (s: AbortSignal) => Promise<HealthResponse> }) {
  const api = useApi();
  const { current } = useBusiness();
  const bid = encodeURIComponent(current.business_id);
  const manage = canManage(current.role);
  const [data, reload] = useResource(
    (signal) => api.request<{ business: Business }>(`/api/business?business_id=${bid}`, { signal }),
    [api, bid],
  );
  const [health] = useResource((signal) => loadHealth(signal), [loadHealth]);

  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data.status === 'ready') {
      const b = data.data.business;
      setForm({
        name: b.name,
        description: b.description,
        ai_knowledge: b.ai_knowledge,
        ai_enabled: b.ai_enabled,
        handover_message: b.handover_message,
        timezone: b.timezone,
      });
    }
  }, [data]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSaved(false);
    const next: Record<string, string> = {};
    if (!form.name.trim()) next.name = 'Name is required.';
    if (!form.handover_message.trim()) next.handover_message = 'Handover message is required.';
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      await api.request(`/api/business?business_id=${bid}`, { method: 'PATCH', body: form });
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiError && err.details) {
        setErrors(Object.fromEntries(err.details.map((d) => [d.path || 'form', d.message])));
      } else {
        setErrors({ form: err instanceof Error ? err.message : 'Could not save settings.' });
      }
    } finally {
      setBusy(false);
    }
  }

  if (data.status === 'loading' || (data.status === 'ready' && !form)) return <Loading label="Loading settings…" />;
  if (data.status === 'error') return <ErrorState message={data.error.message} onRetry={reload} />;
  const business = data.data.business;
  const f = form!;
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm({ ...f, [key]: value });

  return (
    <section aria-labelledby="settings-heading">
      <h1 id="settings-heading">Business settings</h1>
      <form className="card form" onSubmit={submit} noValidate>
        <fieldset disabled={!manage || busy}>
          <Field label="Business name" error={errors.name}>
            <input value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={120} />
          </Field>
          <Field label="Description" error={errors.description}>
            <textarea rows={3} value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={2000} />
          </Field>
          <Field
            label="Approved information for the AI"
            hint="Opening hours, delivery areas, policies. The AI only answers from this text and your product list."
            error={errors.ai_knowledge}
          >
            <textarea rows={6} value={f.ai_knowledge} onChange={(e) => set('ai_knowledge', e.target.value)} maxLength={8000} />
          </Field>
          <Field label="Message sent when handing over to a person" error={errors.handover_message}>
            <input value={f.handover_message} onChange={(e) => set('handover_message', e.target.value)} maxLength={1000} />
          </Field>
          <Field label="Time zone" hint="IANA name, e.g. Africa/Kampala" error={errors.timezone}>
            <input value={f.timezone} onChange={(e) => set('timezone', e.target.value)} maxLength={64} />
          </Field>
          <label className="checkbox">
            <input type="checkbox" checked={f.ai_enabled} onChange={(e) => set('ai_enabled', e.target.checked)} />
            AI replies enabled
          </label>
        </fieldset>
        {errors.form && (
          <p className="error" role="alert">
            {errors.form}
          </p>
        )}
        {saved && <p role="status">Settings saved.</p>}
        {manage ? (
          <div className="form__actions">
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        ) : (
          <p className="muted">Only owners and admins can change settings.</p>
        )}
      </form>

      <div className="card">
        <h2>Plan and limits</h2>
        <dl className="facts">
          <dt>Currency</dt>
          <dd>{business.currency}</dd>
          <dt>AI requests per month</dt>
          <dd>{business.monthly_ai_request_limit}</dd>
          <dt>Outbound messages per month</dt>
          <dd>{business.monthly_outbound_message_limit}</dd>
          <dt>Account status</dt>
          <dd>{business.status}</dd>
        </dl>
        <p className="muted small">Contact your service provider to change these.</p>
      </div>

      <div className="card">
        <h2>System status</h2>
        {health.status === 'loading' && <Loading label="Checking API…" />}
        {health.status === 'error' && <p className="error">Could not reach the API: {health.error.message}</p>}
        {health.status === 'ready' && (
          <ul className="status-list">
            {Object.entries(health.data.config).map(([group, ok]) => (
              <li key={group}>
                <span className={ok ? 'dot dot--ok' : 'dot dot--bad'} aria-hidden="true" />
                {group}: {ok ? 'configured' : 'not configured'}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
