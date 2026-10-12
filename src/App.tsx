import { useEffect, useState } from 'react';
import type { ClientEnvResult } from './lib/env';
import { fetchHealth, type HealthResponse } from './lib/health';

type HealthState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; health: HealthResponse };

interface AppProps {
  env: ClientEnvResult;
  loadHealth?: (signal: AbortSignal) => Promise<HealthResponse>;
}

export function App({ env, loadHealth = fetchHealth }: AppProps) {
  if (!env.ok) {
    return (
      <main className="page">
        <section className="card card--error" role="alert">
          <h1>Configuration required</h1>
          <p>The dashboard is missing browser configuration. Set these in <code>.env.local</code> or Vercel:</p>
          <ul>
            {env.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </section>
      </main>
    );
  }
  return <SystemStatus loadHealth={loadHealth} />;
}

function SystemStatus({ loadHealth }: { loadHealth: (signal: AbortSignal) => Promise<HealthResponse> }) {
  const [state, setState] = useState<HealthState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    loadHealth(controller.signal)
      .then((health) => setState({ kind: 'ready', health }))
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setState({ kind: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
        }
      });
    return () => controller.abort();
  }, [loadHealth]);

  return (
    <main className="page">
      <header className="page__header">
        <h1>Hotzonex Agent</h1>
        <p className="muted">WhatsApp AI sales agent</p>
      </header>
      <section className="card" aria-labelledby="status-heading" aria-busy={state.kind === 'loading'}>
        <h2 id="status-heading">System status</h2>
        {state.kind === 'loading' && <p>Checking API…</p>}
        {state.kind === 'error' && (
          <p role="alert" className="error">
            Could not reach the API: {state.message}
          </p>
        )}
        {state.kind === 'ready' && (
          <>
            <p>
              API status: <strong>{state.health.status}</strong> ({state.health.environment})
            </p>
            <ul className="status-list">
              {Object.entries(state.health.config).map(([group, ok]) => (
                <li key={group}>
                  <span className={ok ? 'dot dot--ok' : 'dot dot--bad'} aria-hidden="true" />
                  {group}: {ok ? 'configured' : 'not configured'}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </main>
  );
}
