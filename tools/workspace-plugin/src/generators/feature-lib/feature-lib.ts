import { formatFiles, updateJson, type Tree } from '@nx/devkit';
import { libraryGenerator } from '@nx/js';

import type { FeatureLibGeneratorSchema } from './schema.js';

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
  // Server libraries sit in two layers: infrastructure under platform/, which
  // any feature may depend on, and features under feature/, which may not
  // depend on each other. Web libraries have no such split yet.
  const directory =
    side === 'server'
      ? `libs/${options.scope}/server/feature/${options.name}`
      : `libs/${options.scope}/web/feature-${options.name}`;

  await libraryGenerator(tree, {
    directory,
    name: `${options.scope}-${side}-feature-${options.name}`,
    tags: `scope:${options.scope},platform:${options.platform},type:feature`,
    unitTestRunner: 'vitest',
    linter: 'eslint',
    useProjectJson: true,
  });

  pointDependenciesAtCatalog(tree, `${directory}/package.json`);

  await formatFiles(tree);
}

/**
 * `@nx/js:library` writes literal version ranges (tslib today) into the new
 * package.json. The workspace keeps every shared runtime range in the pnpm
 * catalog, so a generated library would silently break that rule on day one.
 */
function pointDependenciesAtCatalog(tree: Tree, packageJsonPath: string): void {
  if (!tree.exists(packageJsonPath)) return;

  const catalogued = new Set(Object.keys(readCatalog(tree)));

  updateJson(tree, packageJsonPath, (packageJson) => {
    for (const section of ['dependencies', 'devDependencies'] as const) {
      const deps = packageJson[section];
      if (!deps) continue;

      for (const name of Object.keys(deps)) {
        if (catalogued.has(name)) {
          deps[name] = 'catalog:';
        }
      }
    }
    return packageJson;
  });
}

function readCatalog(tree: Tree): Record<string, string> {
  const workspaceYaml = tree.read('pnpm-workspace.yaml', 'utf-8') ?? '';
  const catalogSection = workspaceYaml.split(/^catalog:\s*$/m)[1];
  if (!catalogSection) return {};

  const entries: Record<string, string> = {};
  for (const line of catalogSection.split(/\r?\n/)) {
    if (line.trim() === '') continue;

    const match = line.match(/^\s{2}'?([^':]+)'?:\s*'?([^']+)'?\s*$/);
    // The catalog block ends at the first line that is not an indented entry.
    if (!match) break;

    entries[match[1]] = match[2];
  }
  return entries;
}

export default featureLibGenerator;
