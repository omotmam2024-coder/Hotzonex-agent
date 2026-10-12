import { Navigate, Route, Routes } from 'react-router';
import { AuthProvider, RequireAuth, type AuthClient } from './auth/AuthContext';
import { BusinessProvider } from './business/BusinessContext';
import { ApiProvider } from './lib/ApiContext';
import type { ApiClient } from './lib/api';
import type { ClientEnvResult } from './lib/env';
import { AppLayout } from './layout/AppLayout';
import { LoginPage } from './pages/LoginPage';
import { ProductsPage } from './pages/ProductsPage';
import { SettingsPage } from './pages/SettingsPage';

export interface Services {
  auth: AuthClient;
  api: ApiClient;
}

export function ConfigErrorPage({ errors }: { errors: string[] }) {
  return (
    <main className="page">
      <section className="card card--error" role="alert">
        <h1>Configuration required</h1>
        <p>
          The dashboard is missing browser configuration. Set these in <code>.env.local</code> or Vercel:
        </p>
        <ul>
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}

/** Routes; must be rendered inside a Router. */
export function App({ env, services }: { env: ClientEnvResult; services: Services | null }) {
  if (!env.ok || !services) return <ConfigErrorPage errors={env.ok ? ['Services unavailable'] : env.errors} />;
  return (
    <AuthProvider client={services.auth}>
      <ApiProvider client={services.api}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={
              <RequireAuth>
                <BusinessProvider>
                  <AppLayout />
                </BusinessProvider>
              </RequireAuth>
            }
          >
            <Route path="/products" element={<ProductsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
          <Route path="/" element={<Navigate to="/products" replace />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </ApiProvider>
    </AuthProvider>
  );
}

function NotFoundPage() {
  return (
    <main className="page">
      <h1>Page not found</h1>
      <a href="/products">Go to products</a>
    </main>
  );
}
