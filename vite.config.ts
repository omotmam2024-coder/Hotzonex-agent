import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { findExposedSecrets } from './server/config/env.js';

export default defineConfig(({ mode }) => {
  // Only VITE_* variables are bundled into the browser. Refuse to build if
  // any of them look like a server secret.
  const browserEnv = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...pickVite(process.env) };
  const exposed = findExposedSecrets(browserEnv);
  if (exposed.length > 0) {
    throw new Error(
      `Refusing to build: these browser variables look like server secrets: ${exposed.join(', ')}. ` +
        'Remove the VITE_ prefix and read them only in server code.',
    );
  }

  return {
    plugins: [react()],
    envPrefix: 'VITE_',
    server: {
      proxy: {
        '/api': { target: `http://localhost:${process.env.API_PORT ?? 3001}`, changeOrigin: false },
      },
    },
    build: {
      sourcemap: false,
      rolldownOptions: {
        output: {
          // Vendor code in separate, long-cacheable chunks.
          codeSplitting: {
            groups: [
              { name: 'supabase', test: /node_modules[\\/]@supabase/ },
              { name: 'react', test: /node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/ },
              { name: 'zod', test: /node_modules[\\/]zod/ },
            ],
          },
        },
      },
    },
  };
});

function pickVite(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[0].startsWith('VITE_') && e[1] !== undefined),
  );
}
