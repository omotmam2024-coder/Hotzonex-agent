import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../App';
import type { AuthClient, AuthSession } from '../auth/AuthContext';
import { ApiError, type ApiClient } from '../lib/api';

export class FakeAuth implements AuthClient {
  session: AuthSession | null;
  listeners = new Set<(s: AuthSession | null) => void>();
  password = 'correct-password';

  constructor(session: AuthSession | null = null) {
    this.session = session;
  }
  async getSession() {
    return this.session;
  }
  onChange(cb: (s: AuthSession | null) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private emit() {
    for (const l of this.listeners) l(this.session);
  }
  async signInWithPassword(email: string, password: string) {
    if (password !== this.password) return { error: 'Email or password is incorrect.' };
    this.session = { accessToken: 'token', email };
    this.emit();
    return { error: null };
  }
  async sendMagicLink() {
    return { error: null };
  }
  async signOut() {
    this.session = null;
    this.emit();
  }
}

type RouteHandler = (body: unknown) => unknown;

/** ApiClient that answers from a "METHOD /path?query" route table and records calls. */
export class FakeApi implements ApiClient {
  calls: { method: string; path: string; body: unknown }[] = [];
  constructor(public routes: Record<string, RouteHandler>) {}

  async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const method = init.method ?? 'GET';
    this.calls.push({ method, path, body: init.body });
    const route = this.routes[`${method} ${path}`] ?? this.routes[`${method} ${path.split('?')[0]}`];
    if (!route) throw new ApiError(404, 'not_found', `No fake route for ${method} ${path}`);
    return route(init.body) as T;
  }
}

export const okEnv = {
  ok: true as const,
  env: { VITE_SUPABASE_URL: 'https://abcd.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abc' },
};

export function renderApp(path: string, auth: AuthClient, api: ApiClient) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App env={okEnv} services={{ auth, api }} />
    </MemoryRouter>,
  );
}
