import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/tools/workspace-plugin',
  test: {
    name: 'workspace-plugin',
    watch: false,
    globals: true,
    environment: 'jsdom',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    // These tests run the real @nx/js library generator, which takes seconds on
    // its own and longer when the whole workspace is testing in parallel. The
    // default 5s timeout made the suite flaky rather than slow.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
