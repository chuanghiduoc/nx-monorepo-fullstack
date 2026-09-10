import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { workspaceRoot } from '@nx/devkit';
import { join } from 'node:path';

// For CI, you may want to set BASE_URL to the deployed application.
// core-web serves on 4200 (project.json); 3000 belongs to core-api.
const WEB_URL = 'http://localhost:4200';
const API_URL = 'http://localhost:3000';
const baseURL = process.env['BASE_URL'] || WEB_URL;

const clearRateLimits = join(
  workspaceRoot,
  'tools',
  'scripts',
  'clear-rate-limits.mjs',
);

/**
 * What a running service would read from its own environment.
 *
 * The suite signs people in, so it needs the real API, not a stub: the session
 * cookie, the tenant a request acts in and the policies underneath it are the
 * things being tested. The database user is `app_user` rather than the owner,
 * because a test that runs with more rights than production proves nothing
 * about production.
 */
const apiEnvironment = {
  PORT: '3000',
  HOST: '127.0.0.1',
  DATABASE_URL:
    process.env['DATABASE_URL'] ??
    'postgresql://app_user:app_user@localhost:5432/app',
  REDIS_CRITICAL_URL:
    process.env['REDIS_CRITICAL_URL'] ?? 'redis://localhost:6379',
  REDIS_CACHE_URL: process.env['REDIS_CACHE_URL'] ?? 'redis://localhost:6380',
  BETTER_AUTH_SECRET:
    process.env['BETTER_AUTH_SECRET'] ??
    'e2e-secret-that-is-at-least-32-characters-long',
  BETTER_AUTH_URL: process.env['BETTER_AUTH_URL'] ?? API_URL,
  CORS_ORIGINS: WEB_URL,
  // Every browser project, every worker and every test shares one client
  // address, so a production-shaped ceiling is reached by parallelism alone —
  // and the resulting 429s read as authorisation bugs.
  //
  // Pinned rather than inherited: the task runner loads the developer's `.env`
  // into every task, so `?? '2000'` would quietly become whatever that file
  // says.
  THROTTLE_LIMIT: '2000',
  THROTTLE_TTL_MS: '30000',
  // One account per test, all from one address — which is exactly what a
  // credential limit exists to refuse.
  AUTH_CREDENTIAL_MAX_ATTEMPTS: '1000',
  AUTH_RATE_LIMIT_MAX: '20000',
  // Warnings and errors only. The output is piped so a failure to start says
  // why, and one line per request would bury that under thousands.
  LOG_LEVEL: 'warn',
};

/**
 * See https://playwright.dev/docs/test-configuration.
 *
 * Generated as a .mts file so Node forces ESM regardless of workspace
 * `type`. Playwright routes `.mts` through its ESM loader (dynamic import,
 * bypassing the pirates CJS-compile path), and Nx's native TS strip loads
 * `.mts` directly. Playwright's configLoader auto-discovers
 * `playwright.config.mts` via its extension list
 * (.ts/.js/.mts/.mjs/.cts/.cjs).
 */
export default defineConfig({
  ...nxE2EPreset(import.meta.dirname, { testDir: './src' }),
  /* The web server compiles a route the first time it is asked for, so the
     test that opens a page first pays for the build. The default 30 seconds is
     not enough for that on a cold start. */
  timeout: 90_000,
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    baseURL,
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },
  /* Playwright owns both servers for this suite. Neither is declared as a task
     dependency, so each is started exactly once, here. Locally an
     already-running `pnpm dev` is reused; CI always starts fresh ones so a
     stale process cannot mask a failure.

     Setting BASE_URL means "run against something already serving" — a
     production-shaped stack behind its edge, say — so nothing is started at
     all. Starting a second pair on the usual ports would test those instead,
     quietly, while appearing to test the deployment.

     Both run what ships: these tests are the last gate before it does.

     The API's output is piped because the readiness probe reports only that a
     URL never answered; the reason goes to the service's own stdout, which
     Playwright discards unless asked. Its log level is turned down to match,
     so what survives is the failure and not a line per request. */
  webServer: process.env['BASE_URL']
    ? []
    : [
        {
          // The counters are cleared here rather than in a framework hook: those
          // run after the servers are up, by which time a leftover block has
          // already made the readiness probe fail.
          command: `node ${clearRateLimits} && pnpm exec node dist/main.js`,
          url: `${API_URL}/api`,
          reuseExistingServer: !process.env['CI'],
          timeout: 120_000,
          cwd: join(workspaceRoot, 'apps', 'core', 'api'),
          env: apiEnvironment,
          stdout: 'pipe',
        },
        {
          command: 'pnpm exec nx run core-web:start',
          url: WEB_URL,
          reuseExistingServer: !process.env['CI'],
          timeout: 120_000,
          cwd: workspaceRoot,
          env: { NEXT_PUBLIC_API_ORIGIN: API_URL },
        },
      ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },

    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },

    // Uncomment for mobile browsers support
    /* {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 12'] },
    }, */

    // Uncomment for branded browsers
    /* {
      name: 'Microsoft Edge',
      use: { ...devices['Desktop Edge'], channel: 'msedge' },
    },
    {
      name: 'Google Chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    } */
  ],
});
