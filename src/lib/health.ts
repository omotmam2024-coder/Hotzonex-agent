export interface HealthResponse {
  status: 'ok' | 'degraded';
  environment: string;
  config: Record<string, boolean>;
  time: string;
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const res = await fetch('/api/health', { signal, headers: { Accept: 'application/json' } });
  // 503 still carries a valid readiness report.
  if (!res.ok && res.status !== 503) throw new Error(`Health check failed (HTTP ${res.status})`);
  return (await res.json()) as HealthResponse;
}
