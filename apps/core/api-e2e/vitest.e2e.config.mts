import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../../node_modules/.vite/apps/core/api-e2e',
  test: {
    name: 'core-api-e2e',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.e2e-spec.ts'],
    // Starts the built core-api bundle once for the whole suite.
    globalSetup: ['./src/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 90_000,
    reporters: ['default'],
  },
}));
