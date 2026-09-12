import { describe, expect, it } from 'vitest';
import { assetIdFromUrl, assetIdsInText, assetReference } from './asset-references';

describe('asset text references', () => {
  it('recognizes reusable references independently of their text field or input/output role', () => {
    expect(assetIdsInText('[Report](asset://report-1) and ![Chart](asset://chart-2)\nasset://report-1')).toEqual(['report-1', 'chart-2']);
  });
  it('rejects paths, query strings, fragments, credentials and alternative schemes', () => {
    for (const url of ['asset://../private', 'asset://id/file', 'asset://id?token=x', 'asset://id#x', 'asset://user@id', 'javascript:alert(1)', 'https://example.com/asset://id']) {
      expect(assetIdFromUrl(url)).toBeUndefined();
    }
    expect(assetIdsInText('[bad](asset://id/path) [bad](asset://id?x=1)')).toEqual([]);
    expect(assetIdsInText('[web](https://example.com/asset://id) prefixasset://id')).toEqual([]);
  });
  it('escapes filenames without letting them add another link', () => {
    expect(assetReference({ id: 'id-1', name: 'a[b]\\c.md' })).toBe('[a\\[b\\]\\\\c.md](asset://id-1)');
  });
});
