import { sharedI18n } from './shared-i18n.js';

describe('sharedI18n', () => {
  it('should work', () => {
    expect(sharedI18n()).toEqual('shared-i18n');
  });
});
