import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: __dirname,
  cacheDir:
    '../../../../../node_modules/.vite/libs/core/server/platform/storage',
  test: {
    name: 'core-server-storage',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    /**
     * How many spec files run at once.
     *
     * This one starts a MinIO container, like the database suites start
     * PostgreSQL. Four rather than one per core, for the reason written out in
     * `data-access-db`: the default is a dozen containers at once and the
     * failures it produces are the machine's, not the code's.
     */
    maxWorkers: 4,
    minWorkers: 1,
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
