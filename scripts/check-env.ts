/**
 * Validates local configuration without printing any values.
 *   npm run check:env                      # app + supabase required
 *   npm run check:env -- --require=openai,whatsapp
 */
import { CONFIG_GROUPS, findExposedSecrets, getConfigStatus, type ConfigGroup } from '../server/config/env.js';
import { loadLocalEnv } from './load-env.js';

const loaded = loadLocalEnv();
console.log(`Env files loaded: ${loaded.length ? loaded.join(', ') : '(none, using shell environment)'}`);

const requireArg = process.argv.find((a) => a.startsWith('--require='));
const required = new Set<ConfigGroup>(['app', 'supabase']);
for (const g of requireArg?.slice('--require='.length).split(',') ?? []) {
  if ((CONFIG_GROUPS as string[]).includes(g)) required.add(g as ConfigGroup);
  else {
    console.error(`Unknown config group "${g}". Valid: ${CONFIG_GROUPS.join(', ')}`);
    process.exit(2);
  }
}

let failed = false;
const status = getConfigStatus();
for (const group of CONFIG_GROUPS) {
  const { ok, issues } = status[group];
  const tag = ok ? 'OK     ' : required.has(group) ? 'MISSING' : 'skipped';
  console.log(`[${tag}] ${group}`);
  for (const issue of issues) console.log(`          - ${issue.message}`);
  if (!ok && required.has(group)) failed = true;
}

const browserIssues: string[] = [];
for (const name of ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY']) {
  if (!process.env[name]?.trim()) browserIssues.push(`${name} is required`);
}
const exposed = findExposedSecrets(process.env);
for (const name of exposed) browserIssues.push(`${name} looks like a server secret and must not use the VITE_ prefix`);
console.log(`[${browserIssues.length ? 'INVALID' : 'OK     '}] browser`);
for (const issue of browserIssues) console.log(`          - ${issue}`);
if (browserIssues.length) failed = true;

process.exit(failed ? 1 : 0);
