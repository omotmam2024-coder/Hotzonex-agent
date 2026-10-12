/**
 * Operator onboarding: creates a business and makes a user its owner.
 * Optionally maps a WhatsApp phone-number id to the business.
 *
 *   npm run onboard -- --email owner@example.com --business "Shop A" \
 *     [--currency UGX] [--timezone Africa/Kampala] [--phone-number-id 1234567890] [--confirm]
 *
 * Without --confirm it only prints what it would do. If the email has no
 * account yet, Supabase sends an invite email (uses your Auth email quota).
 */
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { ConfigError, loadServerConfig } from '../server/config/env.js';
import { createServiceClient } from '../server/db/supabase.js';
import { loadLocalEnv } from './load-env.js';

loadLocalEnv();

const argsSchema = z.object({
  email: z.email('--email must be a valid email address'),
  business: z.string({ error: '--business is required' }).trim().min(1, '--business is required').max(120),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, '--currency must be a 3-letter ISO code'),
  timezone: z.string().trim().min(1).max(64),
  'phone-number-id': z
    .string()
    .regex(/^\d{5,32}$/, '--phone-number-id must be the numeric WhatsApp phone number ID')
    .optional(),
  confirm: z.boolean(),
});

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    business: { type: 'string' },
    currency: { type: 'string', default: 'USD' },
    timezone: { type: 'string', default: 'UTC' },
    'phone-number-id': { type: 'string' },
    confirm: { type: 'boolean', default: false },
  },
});

const parsed = argsSchema.safeParse(values);
if (!parsed.success) {
  for (const issue of parsed.error.issues) console.error(`error: ${issue.message}`);
  process.exit(2);
}
const args = parsed.data;

let config;
try {
  config = loadServerConfig(['supabase']);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

console.log('Plan:');
console.log(`  owner:     ${args.email} (invited if no account exists)`);
console.log(`  business:  ${args.business} (${args.currency}, ${args.timezone})`);
if (args['phone-number-id']) console.log(`  whatsapp:  phone number id ${args['phone-number-id']}`);
console.log(`  database:  ${new URL(config.SUPABASE_URL).host}`);
if (!args.confirm) {
  console.log('\nDry run. Re-run with --confirm to apply.');
  process.exit(0);
}

const db = createServiceClient(config);

async function findUserId(email: string): Promise<string | null> {
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`Could not list users: ${error.message}`);
    const match = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (match) return match.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

let userId = await findUserId(args.email);
if (userId) {
  console.log(`Found existing user ${userId}`);
} else {
  const { data, error } = await db.auth.admin.inviteUserByEmail(args.email, {
    redirectTo: `${config.APP_BASE_URL.replace(/\/$/, '')}/products`,
  });
  if (error || !data.user) throw new Error(`Invite failed: ${error?.message ?? 'no user returned'}`);
  userId = data.user.id;
  console.log(`Invited ${args.email} (user ${userId})`);
}

const { data: businessId, error: rpcError } = await db.rpc('create_business_with_owner', {
  p_name: args.business,
  p_owner_user_id: userId,
  p_currency: args.currency,
  p_timezone: args.timezone,
});
if (rpcError) throw new Error(`Could not create business: ${rpcError.message}`);
console.log(`Created business ${businessId as string}`);

if (args['phone-number-id']) {
  const { error } = await db.from('business_integrations').insert({
    business_id: businessId,
    provider: 'whatsapp',
    phone_number_id: args['phone-number-id'],
  });
  if (error) {
    throw new Error(
      error.code === '23505'
        ? 'That phone number id is already mapped to another business. Nothing else was changed for WhatsApp.'
        : `Could not map phone number: ${error.message}`,
    );
  }
  console.log(`Mapped WhatsApp phone number id ${args['phone-number-id']}`);
}
console.log('Done.');
