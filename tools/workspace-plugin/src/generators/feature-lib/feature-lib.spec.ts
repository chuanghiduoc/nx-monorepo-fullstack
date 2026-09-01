import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { readProjectConfiguration, type Tree } from '@nx/devkit';

import featureLibGenerator from './feature-lib';
import type { FeatureLibGeneratorSchema } from './schema';

describe('feature-lib generator', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
  });

  it('places a node feature under the scope server directory', async () => {
    const options: FeatureLibGeneratorSchema = {
      name: 'users',
      scope: 'core',
      platform: 'node',
    };

    await featureLibGenerator(tree, options);

    const project = readProjectConfiguration(tree, 'core-server-feature-users');
    expect(project.root).toBe('libs/core/server/feature-users');
  });

  it('places a web feature under the scope web directory', async () => {
    await featureLibGenerator(tree, {
      name: 'dashboard',
      scope: 'core',
      platform: 'web',
    });

    const project = readProjectConfiguration(tree, 'core-web-feature-dashboard');
    expect(project.root).toBe('libs/core/web/feature-dashboard');
  });

  it('tags every generated library on all three boundary axes', async () => {
    await featureLibGenerator(tree, {
      name: 'billing',
      scope: 'crm',
      platform: 'node',
    });

    const project = readProjectConfiguration(tree, 'crm-server-feature-billing');
    expect(project.tags).toEqual(
      expect.arrayContaining(['scope:crm', 'platform:node', 'type:feature']),
    );
  });
});
