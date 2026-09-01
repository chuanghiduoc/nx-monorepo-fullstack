import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import type { Tree } from '@nx/devkit';

import productScopeGenerator from './product-scope.js';

describe('product-scope generator', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
  });

  it('writes a checklist for the new scope', async () => {
    await productScopeGenerator(tree, { name: 'crm' });

    expect(tree.exists('docs/scope-crm-checklist.md')).toBe(true);
  });

  it('includes the app generators and the boundary rule for that scope', async () => {
    await productScopeGenerator(tree, { name: 'hrm' });

    const checklist = tree.read('docs/scope-hrm-checklist.md', 'utf-8') ?? '';

    expect(checklist).toContain('apps/hrm/api');
    expect(checklist).toContain('apps/hrm/web');
    expect(checklist).toContain("sourceTag: 'scope:hrm'");
    expect(checklist).toContain('scope:shared');
  });
});
