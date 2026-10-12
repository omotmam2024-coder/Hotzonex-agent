import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Calls a Postgres function by name with named arguments. Server flows that
 * use the secret key go through this so the same SQL runs in production
 * (PostgREST via supabase-js) and in tests (PGlite).
 */
export type Rpc = <T = unknown>(fn: string, args: Record<string, unknown>) => Promise<T>;

export class DbError extends Error {
  constructor(
    readonly fn: string,
    readonly code: string | undefined,
    message: string,
  ) {
    super(`${fn} failed${code ? ` (${code})` : ''}: ${message}`);
    this.name = 'DbError';
  }
}

export function supabaseRpc(db: SupabaseClient): Rpc {
  return async <T>(fn: string, args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(fn, args);
    if (error) throw new DbError(fn, error.code, error.message);
    return data as T;
  };
}
