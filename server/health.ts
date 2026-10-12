import { getConfigStatus, type ConfigGroup } from './config/env.js';
import { json, methodNotAllowed } from './http/response.js';

type EnvSource = Record<string, string | undefined>;

/**
 * Liveness and configuration readiness. Reports only booleans per config
 * group; variable names and values stay in server logs.
 */
export function handleHealth(request: Request, source: EnvSource = process.env): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return methodNotAllowed(['GET', 'HEAD']);
  }

  const status = getConfigStatus(source);
  const config = Object.fromEntries(
    Object.entries(status).map(([group, s]) => [group, s.ok]),
  ) as Record<ConfigGroup, boolean>;

  const missing = Object.values(status).flatMap((s) => s.issues.map((i) => i.variable));
  if (missing.length > 0) {
    console.warn('[health] configuration incomplete:', [...new Set(missing)].join(', '));
  }

  // The app and database groups are needed for anything to work.
  const ready = config.app && config.supabase;
  const body = {
    status: ready ? 'ok' : 'degraded',
    environment: status.app.ok ? source.APP_ENV : 'unknown',
    config,
    time: new Date().toISOString(),
  };

  const httpStatus = ready ? 200 : 503;
  if (request.method === 'HEAD') {
    return new Response(null, { status: httpStatus, headers: { 'Cache-Control': 'no-store' } });
  }
  return json(body, { status: httpStatus });
}
