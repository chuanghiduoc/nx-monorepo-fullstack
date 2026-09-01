import { formatFiles, type Tree } from '@nx/devkit';
import { libraryGenerator } from '@nx/js';

import type { FeatureLibGeneratorSchema } from './schema';

/**
 * Scaffolds a feature library that already obeys the workspace conventions:
 * scope-based location, the three boundary tag axes, and Vitest.
 *
 * Encoding the conventions in a generator is what keeps them true — a checklist
 * in a document only holds until someone forgets a tag.
 */
async function featureLibGenerator(
  tree: Tree,
  options: FeatureLibGeneratorSchema,
) {
  const side = options.platform === 'node' ? 'server' : 'web';
  const directory = `libs/${options.scope}/${side}/feature-${options.name}`;

  await libraryGenerator(tree, {
    directory,
    name: `${options.scope}-${side}-feature-${options.name}`,
    tags: `scope:${options.scope},platform:${options.platform},type:feature`,
    unitTestRunner: 'vitest',
    linter: 'eslint',
    useProjectJson: true,
  });

  await formatFiles(tree);
}

export default featureLibGenerator;
