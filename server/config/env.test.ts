import { describe, expect, it } from 'vitest';
import { ConfigError, findExposedSecrets, getConfigStatus, isServiceRoleJwt, loadServerConfig } from './env.js';

const valid = {
  APP_ENV: 'development',
  APP_BASE_URL: 'http://localhost:5173',
  SUPABASE_URL: 'https://abcd.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_0123456789abcdefghij',
  OPENAI_API_KEY: 'test-openai-key-0123456789',
  OPENAI_MODEL: 'test-model',
  WHATSAPP_ACCESS_TOKEN: 'test-whatsapp-token-0123456789',
  WHATSAPP_PHONE_NUMBER_ID: '123456789012345',
  WHATSAPP_VERIFY_TOKEN: 'verify-token-0123456789',
  WHATSAPP_APP_SECRET: 'app-secret-0123456789abcdef',
  WHATSAPP_API_VERSION: 'v23.0',
};

function fakeJwt(payload: object): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.signature`;
}

describe('loadServerConfig', () => {
  it('returns typed config for the requested groups', () => {
    const cfg = loadServerConfig(['supabase', 'whatsapp'], valid);
    expect(cfg.APP_ENV).toBe('development');
    expect(cfg.SUPABASE_URL).toBe('https://abcd.supabase.co');
    expect(cfg.WHATSAPP_API_VERSION).toBe('v23.0');
  });

  it('only validates the groups that were requested', () => {
    const { OPENAI_API_KEY: _k, OPENAI_MODEL: _m, ...withoutOpenAI } = valid;
    expect(() => loadServerConfig(['supabase'], withoutOpenAI)).not.toThrow();
    expect(() => loadServerConfig(['openai'], withoutOpenAI)).toThrow(ConfigError);
  });

  it('always requires the app group', () => {
    const { APP_ENV: _e, ...rest } = valid;
    expect(() => loadServerConfig([], rest)).toThrow(/APP_ENV/);
  });

  it('reports every missing variable by name', () => {
    try {
      loadServerConfig(['whatsapp'], { APP_ENV: 'test', APP_BASE_URL: 'http://localhost' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const vars = (err as ConfigError).issues.map((i) => i.variable).sort();
      expect(vars).toEqual([
        'WHATSAPP_ACCESS_TOKEN',
        'WHATSAPP_API_VERSION',
        'WHATSAPP_APP_SECRET',
        'WHATSAPP_PHONE_NUMBER_ID',
        'WHATSAPP_VERIFY_TOKEN',
      ]);
    }
  });

  it('never includes secret values in error messages', () => {
    const secretValue = 'sb_publishable_super-secret-looking-value';
    try {
      loadServerConfig(['supabase'], { ...valid, SUPABASE_SECRET_KEY: secretValue, WHATSAPP_APP_SECRET: 'short' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain(secretValue);
      expect((err as Error).message).toMatch(/publishable key/);
    }
  });

  it.each([
    ['APP_ENV', 'staging', /APP_ENV must be one of/],
    ['APP_BASE_URL', 'not a url', /APP_BASE_URL must be an http\(s\) URL/],
    ['SUPABASE_URL', 'ftp://example.com', /SUPABASE_URL must be an http\(s\) URL/],
    ['SUPABASE_SECRET_KEY', 'changeme', /placeholder/],
    ['WHATSAPP_PHONE_NUMBER_ID', '+1 555 0100', /numeric phone number ID/],
    ['WHATSAPP_API_VERSION', '23', /v23\.0/],
    ['WHATSAPP_VERIFY_TOKEN', 'short', /at least 16/],
    ['OPENAI_MODEL', '   ', /OPENAI_MODEL is required/],
  ])('rejects invalid %s', (name, value, pattern) => {
    expect(() =>
      loadServerConfig(['supabase', 'openai', 'whatsapp'], { ...valid, [name]: value }),
    ).toThrow(pattern);
  });

  it('requires https APP_BASE_URL in production', () => {
    expect(() => loadServerConfig([], { ...valid, APP_ENV: 'production' })).toThrow(/https in production/);
    expect(() =>
      loadServerConfig([], { ...valid, APP_ENV: 'production', APP_BASE_URL: 'https://agent.example.com' }),
    ).not.toThrow();
  });
});

describe('getConfigStatus', () => {
  it('reports per-group readiness without throwing', () => {
    const status = getConfigStatus({ APP_ENV: 'test', APP_BASE_URL: 'http://localhost' });
    expect(status.app.ok).toBe(true);
    expect(status.supabase.ok).toBe(false);
    expect(status.openai.ok).toBe(false);
    expect(status.whatsapp.ok).toBe(false);
  });
});

describe('findExposedSecrets', () => {
  it('flags VITE_ variables with secret names or secret-shaped values', () => {
    const exposed = findExposedSecrets({
      VITE_SUPABASE_URL: 'https://abcd.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abc',
      VITE_OPENAI_API_KEY: 'x',
      VITE_WHATSAPP_ACCESS_TOKEN: 'x',
      VITE_SOMETHING: 'sb_secret_abc',
      VITE_KEY: fakeJwt({ role: 'service_role' }),
      SUPABASE_SECRET_KEY: 'sb_secret_abc',
    });
    expect(exposed.sort()).toEqual(['VITE_KEY', 'VITE_OPENAI_API_KEY', 'VITE_SOMETHING', 'VITE_WHATSAPP_ACCESS_TOKEN']);
  });
});

describe('isServiceRoleJwt', () => {
  it('distinguishes service_role from anon JWTs', () => {
    expect(isServiceRoleJwt(fakeJwt({ role: 'service_role' }))).toBe(true);
    expect(isServiceRoleJwt(fakeJwt({ role: 'anon' }))).toBe(false);
    expect(isServiceRoleJwt('sb_publishable_abc')).toBe(false);
  });
});
