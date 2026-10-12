import { createContext, useContext, type ReactNode } from 'react';
import type { ApiClient } from './api';

const ApiCtx = createContext<ApiClient | null>(null);

export function ApiProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  return <ApiCtx.Provider value={client}>{children}</ApiCtx.Provider>;
}

export function useApi(): ApiClient {
  const ctx = useContext(ApiCtx);
  if (!ctx) throw new Error('useApi must be used inside ApiProvider');
  return ctx;
}
