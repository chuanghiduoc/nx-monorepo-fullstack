import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../../../node_modules/.vite/libs/core/server/data-access-db',
  test: {
    name: 'core-server-data-access-db',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    /**
     * How many spec files run at once.
     *
     * Each of these starts its own PostgreSQL — and some of them a Redis, or a
     * whole worker process — so the default of one worker per core is twelve
     * databases at once on this machine, beside whatever the other projects
     * are doing. Measured across several full `pnpm verify` runs: a container
     * that could not be reached (`P1001`), a transaction that could not be
     * started (`P2028`), and a worker that exited without printing anything —
     * three different failures, all of them the machine rather than the code,
     * and all of them red.
     *
     * Four keeps the wall-clock close and the failures honest. It is a
     * property of this rig, not of the code under test.
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
