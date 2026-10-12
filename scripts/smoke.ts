/**
 * Non-destructive production smoke test. Sends no WhatsApp messages,
 * creates no data and needs no credentials.
 *
 *   npm run smoke -- --url https://your-app.vercel.app
 */
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { url: { type: 'string' } } });
if (!values.url) {
  console.error('Usage: npm run smoke -- --url https://your-app.example');
  process.exit(2);
}
const base = values.url.replace(/\/$/, '');

type Check = { name: string; run: () => Promise<string | null> };
const expectStatus = (path: string, init: RequestInit, expected: number): Check['run'] => async () => {
  const res = await fetch(`${base}${path}`, { ...init, redirect: 'manual' });
  return res.status === expected ? null : `expected ${expected}, got ${res.status}`;
};

const checks: Check[] = [
  {
    name: 'health reports ok',
    run: async () => {
      const res = await fetch(`${base}/api/health`);
      const body = (await res.json().catch(() => null)) as { status?: string; config?: Record<string, boolean> } | null;
      if (res.status !== 200 || body?.status !== 'ok') return `status ${res.status}, body ${JSON.stringify(body)}`;
      const missing = Object.entries(body.config ?? {}).filter(([, ok]) => !ok).map(([g]) => g);
      return missing.length ? `config groups not ready: ${missing.join(', ')}` : null;
    },
  },
  { name: 'dashboard loads', run: expectStatus('/', {}, 200) },
  { name: 'SPA route served', run: expectStatus('/orders', {}, 200) },
  { name: 'API requires sign-in', run: expectStatus('/api/me', {}, 401) },
  {
    name: 'webhook rejects wrong verify token',
    run: expectStatus('/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=smoke-test-wrong&hub.challenge=1', {}, 403),
  },
  {
    name: 'webhook rejects unsigned events',
    run: expectStatus('/api/webhooks/whatsapp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, 401),
  },
  { name: 'retry job requires the cron secret', run: expectStatus('/api/jobs/process-events', {}, 401) },
  {
    name: 'security headers present',
    run: async () => {
      const res = await fetch(`${base}/`);
      const missing = ['x-content-type-options', 'x-frame-options', 'referrer-policy'].filter((h) => !res.headers.get(h));
      return missing.length ? `missing ${missing.join(', ')}` : null;
    },
  },
];

let failed = 0;
for (const check of checks) {
  let problem: string | null;
  try {
    problem = await check.run();
  } catch (err) {
    problem = err instanceof Error ? err.message : String(err);
  }
  console.log(`${problem ? 'FAIL' : 'ok  '}  ${check.name}${problem ? ` — ${problem}` : ''}`);
  if (problem) failed++;
}
process.exit(failed ? 1 : 0);
