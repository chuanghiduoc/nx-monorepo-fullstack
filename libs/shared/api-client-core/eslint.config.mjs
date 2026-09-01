import baseConfig from '../../../eslint.config.mjs';

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
            '{projectRoot}/openapi-ts.config.ts',
          ],
        },
      ],
    },
    languageOptions: {
      parser: await import('jsonc-eslint-parser'),
    },
  },
  {
    // src/generated is written by openapi-ts on every contract change. Linting
    // it would mean either editing generated files by hand or carrying rule
    // exceptions for a vendor's code style; neither belongs in review. It is
    // still typechecked, which is the property we actually depend on.
    ignores: ['**/out-tsc', 'src/generated/**'],
  },
];
