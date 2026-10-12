import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { AuthProvider, RequireAuth, type AuthClient } from './auth/AuthContext';
import { BusinessProvider } from './business/BusinessContext';
import { ApiProvider } from './lib/ApiContext';
import type { ApiClient } from './lib/api';
import type { ClientEnvResult } from './lib/env';
import { AppLayout } from './layout/AppLayout';
import { Loading } from './components/States';
import { LoginPage } from './pages/LoginPage';

// Pages load on demand to keep the initial bundle small.
const OverviewPage = lazy(() => import('./pages/OverviewPage').then((m) => ({ default: m.OverviewPage })));
const ConversationsPage = lazy(() => import('./pages/ConversationsPage').then((m) => ({ default: m.ConversationsPage })));
const ConversationDetailPage = lazy(() =>
  import('./pages/ConversationsPage').then((m) => ({ default: m.ConversationDetailPage })),
);
const CustomersPage = lazy(() => import('./pages/CustomersPage').then((m) => ({ default: m.CustomersPage })));
const OrdersPage = lazy(() => import('./pages/OrdersPage').then((m) => ({ default: m.OrdersPage })));
const ProductsPage = lazy(() => import('./pages/ProductsPage').then((m) => ({ default: m.ProductsPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));

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
            <Route path="/overview" element={<Page><OverviewPage /></Page>} />
            <Route path="/conversations" element={<Page><ConversationsPage /></Page>} />
            <Route path="/conversations/:id" element={<Page><ConversationDetailPage /></Page>} />
            <Route path="/customers" element={<Page><CustomersPage /></Page>} />
            <Route path="/orders" element={<Page><OrdersPage /></Page>} />
            <Route path="/products" element={<Page><ProductsPage /></Page>} />
            <Route path="/settings" element={<Page><SettingsPage /></Page>} />
          </Route>
          <Route path="/" element={<Navigate to="/overview" replace />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </ApiProvider>
    </AuthProvider>
  );
}

function Page({ children }: { children: ReactNode }) {
  return <Suspense fallback={<Loading />}>{children}</Suspense>;
}

function NotFoundPage() {
  return (
    <main className="page">
      <h1>Page not found</h1>
      <a href="/overview">Go to the dashboard</a>
    </main>
  );
}
