import nx from '@nx/eslint-plugin';

import baseConfig from '../../../eslint.config.mjs';
import { baseAllow, depConstraints } from '../../../eslint.boundaries.mjs';

export default [
  ...nx.configs['flat/react'],
  ...baseConfig,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      // The shadcn CLI writes component imports against this package's own name
      // (its monorepo convention, configured in components.json). Nx normally
      // requires relative imports inside a project; allowing the self-reference
      // here keeps generated components untouched. The dependency matrix itself
      // is imported, not restated, so it cannot drift from the root config.
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: [...baseAllow, '^@workspace/shared-ui/.*$'],
          depConstraints,
        },
      ],
    },
  },
  {
    files: ['**/*.json'],
    languageOptions: { parser: await import('jsonc-eslint-parser') },
    rules: {
      '@nx/dependency-checks': [
        'error',
        { ignoredFiles: ['{projectRoot}/vite.config.{js,ts,mjs,mts}'] },
      ],
    },
  },
  {
    ignores: ['**/out-tsc'],
  },
];
