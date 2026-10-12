import { z } from 'zod';

/**
 * Server configuration, validated per feature group so a function only
 * requires the credentials it actually uses. Errors name variables and
 * describe the problem; they never include values.
 */

const PLACEHOLDER =
  /^(changeme|change[-_ ]me|replace[-_ ]?me|todo|placeholder|xxx+|your[-_ ].*|<.*>|\.\.\.)$/i;

const required = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .trim()
    .min(1, `${name} is required`)
    .refine((v) => !PLACEHOLDER.test(v), `${name} still contains a placeholder value`);

const secret = (name: string, minLength: number) =>
  required(name).refine((v) => v.length >= minLength, `${name} must be at least ${minLength} characters`);

const httpUrl = (name: string) =>
  required(name).refine((v) => {
    try {
      const url = new URL(v);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }, `${name} must be an http(s) URL`);

export const APP_ENVS = ['development', 'test', 'preview', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

const appSchema = z
  .object({
    APP_ENV: z.enum(APP_ENVS, { error: `APP_ENV must be one of ${APP_ENVS.join(', ')}` }),
    APP_BASE_URL: httpUrl('APP_BASE_URL'),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.APP_ENV === 'production' && !cfg.APP_BASE_URL.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['APP_BASE_URL'], message: 'APP_BASE_URL must use https in production' });
    }
  });

const supabaseSchema = z.object({
  SUPABASE_URL: httpUrl('SUPABASE_URL'),
  // Public key, also used server-side to run dashboard queries as the
  // signed-in user so RLS applies.
  VITE_SUPABASE_PUBLISHABLE_KEY: required('VITE_SUPABASE_PUBLISHABLE_KEY').refine(
    (v) => !v.startsWith('sb_secret_') && !isServiceRoleJwt(v),
    'VITE_SUPABASE_PUBLISHABLE_KEY must be the publishable key, not a secret key',
  ),
  SUPABASE_SECRET_KEY: secret('SUPABASE_SECRET_KEY', 20).refine(
    (v) => !v.startsWith('sb_publishable_'),
    'SUPABASE_SECRET_KEY is a publishable key; use the secret key (sb_secret_...)',
  ),
});

const openaiSchema = z.object({
  OPENAI_API_KEY: secret('OPENAI_API_KEY', 20),
  OPENAI_MODEL: required('OPENAI_MODEL'),
});

const whatsappSchema = z.object({
  WHATSAPP_ACCESS_TOKEN: secret('WHATSAPP_ACCESS_TOKEN', 20),
  WHATSAPP_PHONE_NUMBER_ID: required('WHATSAPP_PHONE_NUMBER_ID').refine(
    (v) => /^\d{5,32}$/.test(v),
    'WHATSAPP_PHONE_NUMBER_ID must be the numeric phone number ID (not the phone number)',
  ),
  WHATSAPP_VERIFY_TOKEN: secret('WHATSAPP_VERIFY_TOKEN', 16),
  WHATSAPP_APP_SECRET: secret('WHATSAPP_APP_SECRET', 16),
  WHATSAPP_API_VERSION: required('WHATSAPP_API_VERSION').refine(
    (v) => /^v\d{1,3}\.\d{1,2}$/.test(v),
    'WHATSAPP_API_VERSION must look like v23.0',
  ),
});

const jobsSchema = z.object({
  // Vercel Cron sends this as a bearer token to job endpoints.
  CRON_SECRET: secret('CRON_SECRET', 32),
});

const groupSchemas = {
  app: appSchema,
  supabase: supabaseSchema,
  openai: openaiSchema,
  whatsapp: whatsappSchema,
  jobs: jobsSchema,
} as const;

export type ConfigGroup = keyof typeof groupSchemas;
export const CONFIG_GROUPS = Object.keys(groupSchemas) as ConfigGroup[];

export type AppConfig = z.infer<typeof appSchema>;
export type SupabaseConfig = z.infer<typeof supabaseSchema>;
export type OpenAIConfig = z.infer<typeof openaiSchema>;
export type WhatsAppConfig = z.infer<typeof whatsappSchema>;
export type JobsConfig = z.infer<typeof jobsSchema>;

type GroupConfig = {
  app: AppConfig;
  supabase: SupabaseConfig;
  openai: OpenAIConfig;
  whatsapp: WhatsAppConfig;
  jobs: JobsConfig;
};

/** Config for the requested groups, merged into one object. */
export type ServerConfig<G extends ConfigGroup> = UnionToIntersection<GroupConfig[G]>;
type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

export interface ConfigIssue {
  group: ConfigGroup;
  variable: string;
  message: string;
}

export class ConfigError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super(`Invalid server configuration:\n${issues.map((i) => `  - ${i.message}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

type EnvSource = Record<string, string | undefined>;

function validateGroup(group: ConfigGroup, source: EnvSource) {
  const result = groupSchemas[group].safeParse(source);
  if (result.success) return { data: result.data, issues: [] as ConfigIssue[] };
  const issues = result.error.issues.map((issue) => ({
    group,
    variable: String(issue.path[0] ?? group),
    message: issue.message,
  }));
  return { data: undefined, issues };
}

/**
 * Validates and returns config for the given groups. Throws ConfigError if
 * any variable is missing or invalid. `app` is always included.
 */
export function loadServerConfig<G extends ConfigGroup>(
  groups: readonly G[],
  source: EnvSource = process.env,
): ServerConfig<G | 'app'> {
  const wanted = new Set<ConfigGroup>(['app', ...groups]);
  const issues: ConfigIssue[] = [];
  const config: Record<string, unknown> = {};
  for (const group of wanted) {
    const { data, issues: groupIssues } = validateGroup(group, source);
    issues.push(...groupIssues);
    if (data) Object.assign(config, data);
  }
  if (issues.length > 0) throw new ConfigError(issues);
  return config as ServerConfig<G | 'app'>;
}

export type ConfigStatus = Record<ConfigGroup, { ok: boolean; issues: ConfigIssue[] }>;

/** Reports which groups are configured, without throwing. */
export function getConfigStatus(source: EnvSource = process.env): ConfigStatus {
  const status = {} as ConfigStatus;
  for (const group of CONFIG_GROUPS) {
    const { issues } = validateGroup(group, source);
    status[group] = { ok: issues.length === 0, issues };
  }
  return status;
}

const SECRET_NAME = /(SECRET|SERVICE_ROLE|PRIVATE|PASSWORD|TOKEN|OPENAI|APP_SECRET|CRON)/i;
const SECRET_VALUE = /^(sb_secret_|sk-|sk_live_|EAA)/;

/**
 * Finds browser-exposed variables (VITE_*) that look like server secrets,
 * either by name or by value shape. Returns variable names only.
 */
export function findExposedSecrets(source: EnvSource): string[] {
  const exposed: string[] = [];
  for (const [name, value] of Object.entries(source)) {
    if (!name.startsWith('VITE_')) continue;
    if (SECRET_NAME.test(name) || (value && (SECRET_VALUE.test(value) || isServiceRoleJwt(value)))) {
      exposed.push(name);
    }
  }
  return exposed;
}

/** Detects legacy Supabase service_role JWTs. */
export function isServiceRoleJwt(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 3 || !parts[1]) return false;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload === 'object' && payload !== null && (payload as { role?: unknown }).role === 'service_role';
  } catch {
    return false;
  }
}
