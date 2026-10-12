import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          environment: 'node',
          include: ['server/**/*.test.ts', 'api/**/*.test.ts', 'scripts/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'app',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          setupFiles: ['src/test/setup.ts'],
        },
      },
    ],
  },
});
