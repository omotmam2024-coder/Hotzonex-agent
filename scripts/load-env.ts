import { existsSync } from 'node:fs';

/**
 * Loads local env files for scripts, in Vite's precedence order (later files
 * do not override earlier ones or variables already set in the shell).
 */
export function loadLocalEnv(): string[] {
  const loaded: string[] = [];
  for (const file of ['.env.local', '.env']) {
    if (existsSync(file)) {
      process.loadEnvFile(file);
      loaded.push(file);
    }
  }
  return loaded;
}
