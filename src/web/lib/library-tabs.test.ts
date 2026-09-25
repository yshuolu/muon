import { describe, expect, it } from 'vitest';
import { closeTab, openTab, replaceTab } from './library-tabs';

describe('library tabs', () => {
  it('opens each document once and caps the strip at twelve tabs', () => {
    expect(openTab([], 'a')).toEqual(['a']);
    expect(openTab(['a', 'b'], 'a')).toEqual(['a', 'b']);
    const many = Array.from({ length: 12 }, (_, index) => `d${index}`);
    expect(openTab(many, 'new')).toEqual([...many.slice(1), 'new']);
  });

  it('closing the active tab shows its right neighbor, then the left, then nothing', () => {
    expect(closeTab(['a', 'b', 'c'], 'b', 'b')).toEqual({ tabs: ['a', 'c'], active: 'c' });
    expect(closeTab(['a', 'b', 'c'], 'c', 'c')).toEqual({ tabs: ['a', 'b'], active: 'b' });
    expect(closeTab(['a'], 'a', 'a')).toEqual({ tabs: [], active: null });
    expect(closeTab(['a', 'b'], 'a', 'b')).toEqual({ tabs: ['b'], active: 'b' });
    expect(closeTab(['a'], 'missing', 'a')).toEqual({ tabs: ['a'], active: 'a' });
  });

  it('replaces a superseded document with its newest version in place', () => {
    expect(replaceTab(['a', 'b', 'c'], 'b', 'b2')).toEqual(['a', 'b2', 'c']);
    expect(replaceTab(['a', 'b', 'b2'], 'b', 'b2')).toEqual(['a', 'b2']);
    expect(replaceTab(['a'], 'missing', 'x')).toEqual(['a']);
    expect(replaceTab(['a'], 'a', 'a')).toEqual(['a']);
  });
});
