import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { EmptyState, ErrorState, Loading } from '../components/States';
import { useApi } from '../lib/ApiContext';
import type { Me, Membership } from '../lib/types';
import { useResource } from '../lib/useResource';

interface BusinessState {
  me: Me;
  current: Membership;
  select: (businessId: string) => void;
}

const BusinessCtx = createContext<BusinessState | null>(null);
const STORAGE_KEY = 'hotzonex.businessId';

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Loads the user's memberships and tracks the selected business. */
export function BusinessProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [me, reload] = useResource((signal) => api.request<Me>('/api/me', { signal }), [api]);
  const [selected, setSelected] = useState<string | null>(readStored);

  const value = useMemo<BusinessState | null>(() => {
    if (me.status !== 'ready' || me.data.memberships.length === 0) return null;
    const list = me.data.memberships;
    const current = list.find((m) => m.business_id === selected) ?? list[0]!;
    return {
      me: me.data,
      current,
      select: (id) => {
        setSelected(id);
        try {
          localStorage.setItem(STORAGE_KEY, id);
        } catch {
          // storage unavailable; selection lasts for this page view
        }
      },
    };
  }, [me, selected]);

  if (me.status === 'loading') return <Loading label="Loading your account…" />;
  if (me.status === 'error') return <ErrorState message={me.error.message} onRetry={reload} />;
  if (!value) {
    return (
      <main className="page">
        <EmptyState title="No business is linked to this account yet">
          <p>Your account is signed in but has no business access. Contact your service provider to be added.</p>
        </EmptyState>
      </main>
    );
  }
  return <BusinessCtx.Provider value={value}>{children}</BusinessCtx.Provider>;
}

export function useBusiness(): BusinessState {
  const ctx = useContext(BusinessCtx);
  if (!ctx) throw new Error('useBusiness must be used inside BusinessProvider');
  return ctx;
}
