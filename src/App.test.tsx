import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import type { HealthResponse } from './lib/health';

const okEnv = {
  ok: true as const,
  env: { VITE_SUPABASE_URL: 'https://abcd.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abc' },
};

const health: HealthResponse = {
  status: 'ok',
  environment: 'test',
  config: { app: true, supabase: true, openai: false, whatsapp: false },
  time: '2026-01-01T00:00:00.000Z',
};

describe('App', () => {
  it('shows a configuration error state when browser env is invalid', () => {
    render(<App env={{ ok: false, errors: ['VITE_SUPABASE_URL is required'] }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Configuration required');
    expect(screen.getByText('VITE_SUPABASE_URL is required')).toBeInTheDocument();
  });

  it('shows loading then the API status', async () => {
    let resolve!: (h: HealthResponse) => void;
    const loadHealth = () => new Promise<HealthResponse>((r) => (resolve = r));
    render(<App env={okEnv} loadHealth={loadHealth} />);
    expect(screen.getByText('Checking API…')).toBeInTheDocument();
    resolve(health);
    expect(await screen.findByText('ok')).toBeInTheDocument();
    expect(screen.getByText('openai: not configured')).toBeInTheDocument();
    expect(screen.getByText('supabase: configured')).toBeInTheDocument();
  });

  it('shows an error state when the API is unreachable', async () => {
    const loadHealth = () => Promise.reject(new Error('Health check failed (HTTP 500)'));
    render(<App env={okEnv} loadHealth={loadHealth} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 500');
  });
});
