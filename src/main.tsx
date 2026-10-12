import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App, type Services } from './App';
import { createApiClient } from './lib/api';
import { clientEnv } from './lib/env';
import { createSupabaseAuthClient } from './lib/supabase';
import './styles.css';

function createServices(): Services | null {
  if (!clientEnv.ok) return null;
  const auth = createSupabaseAuthClient(clientEnv.env);
  const api = createApiClient({
    getAccessToken: async () => (await auth.getSession())?.accessToken ?? null,
    // Expired or revoked session: sign out; RequireAuth then shows the login page.
    onUnauthorized: () => void auth.signOut(),
  });
  return { auth, api };
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root not found');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App env={clientEnv} services={createServices()} />
    </BrowserRouter>
  </StrictMode>,
);
