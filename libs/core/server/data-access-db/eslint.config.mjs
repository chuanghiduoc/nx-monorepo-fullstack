import baseConfig from '../../../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/*.json'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          ignoredFiles: [
            '{projectRoot}/eslint.config.{js,cjs,mjs,ts,cts,mts}',
            '{projectRoot}/vitest.config.{js,ts,mjs,mts}',
            // Read by the Prisma CLI, never bundled: its imports (prisma,
            // dotenv) are development tooling, not runtime dependencies.
            // It is a build input so a config change invalidates the cache.
            '{projectRoot}/prisma7.config.ts',
            '{projectRoot}/tools/**/*.ts',
          ],
          // Runtime requirements that no source file names directly: the
          // generated Prisma client loads @prisma/client internals, and pg is
          // the driver @prisma/adapter-pg opens connections with. Dropping
          // either would break at runtime, not at compile time.
          ignoredDependencies: ['@prisma/client', 'pg'],
        },
      ],
    },
    languageOptions: {
      parser: await import('jsonc-eslint-parser'),
    },
  },
  {
    ignores: ['**/out-tsc'],
  },
];
