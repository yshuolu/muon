import { assetIdFromUrl } from '../../shared/asset-references';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { assetContentUrl, assetPreviewKind, isAssetImageUrl } from '../lib/asset-preview';
import { assetMarkdownUrl, AssetMarkdown, AssetReferenceList } from './asset-preview';
import { Markdown } from './common';

describe('asset previews', () => {
  it('renders reports with headings, GFM tables, code, and isolated duplicate anchors', () => {
    const rendered = renderToStaticMarkup(createElement(AssetMarkdown, { children: '# Report\n\n## Results\n\n| Check | Result |\n| --- | --- |\n| Tests | Passed |\n\n## Results\n\n```ts\nconst count = 2;\n```\n\n[Jump](#results-1)' }));
    const ids = [...rendered.matchAll(/<h[1-6] id="([^"]+)"/g)].map(match => match[1]);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(ids[2]).toBe(`${ids[1]}-1`);
    expect(rendered).toContain(`href="#${ids[2]}"`);
    expect(rendered).toContain('<table>');
    expect(rendered).toContain('<td>Passed</td>');
    expect(rendered).toContain('class="language-ts"');
  });

  it('does not execute raw HTML, load remote images, or create unsafe navigation', () => {
    const rendered = renderToStaticMarkup(createElement(AssetMarkdown, { children: '<script>alert(1)</script>\n\n<img src="https://tracker.example/raw.png">\n\n![Remote](https://tracker.example/image.png)\n\n[Bad](javascript:alert%281%29)\n\n[Relative](../../settings)\n\n[Reference](https://example.com/report)' }));
    expect(rendered).not.toContain('<script');
    expect(rendered).not.toContain('<img');
    expect(rendered).not.toContain('tracker.example');
    expect(rendered).not.toContain('javascript:');
    expect(rendered).not.toContain('../../settings');
    expect(rendered).toContain('href="https://example.com/report" target="_blank" rel="noreferrer"');
    expect(rendered).toContain('Remote · preview unavailable');
  });

  it('resolves asset links in ordinary task Markdown and document readers', () => {
    const markdown = '[Generated report](asset://asset-report-1)';
    for (const Component of [Markdown, AssetMarkdown]) {
      const rendered = renderToStaticMarkup(createElement(Component, { children: markdown }));
      expect(rendered).toContain('class="markdown-asset-link"');
      expect(rendered).toContain('Generated report</button>');
      expect(rendered).not.toContain('href="asset:');
    }
    expect(assetIdFromUrl('asset://asset-report-1')).toBe('asset-report-1');
    expect(assetMarkdownUrl('asset://asset-report-1')).toBe('asset://asset-report-1');
    for (const unsafe of ['asset://../secret', 'asset://id?redirect=external', 'asset://id/content', 'javascript:alert(1)']) {
      expect(assetIdFromUrl(unsafe)).toBeUndefined();
      expect(assetMarkdownUrl(unsafe)).toBe('');
    }
  });

  it('limits inline images to retained content endpoints', () => {
    expect(isAssetImageUrl('/api/assets/asset-1/content')).toBe(true);
    for (const value of ['//tracker.example/image.png', '/api/assets/../content', '/api/assets/id/content?redirect=https://tracker.example', '/api/assets/id/content/extra', 'data:image/svg+xml;base64,PHN2Zz4=', undefined]) {
      expect(isAssetImageUrl(value)).toBe(false);
    }
    const rendered = renderToStaticMarkup(createElement(AssetMarkdown, { children: '![Retained](/api/assets/asset-1/content)' }));
    expect(rendered).toContain('<img src="/api/assets/asset-1/content" alt="Retained" loading="lazy"');
  });

  it('exposes distinct HTML plan references without rendering the untrusted HTML', () => {
    const rendered = renderToStaticMarkup(createElement(AssetReferenceList, { text: '<script>alert(1)</script><a href="asset://report-1">Report</a><img src="asset://image-1"><a href="asset://report-1">Again</a>' }));
    expect(rendered).toContain('aria-label="Referenced files"');
    expect(rendered.match(/class="markdown-asset-link"/g)).toHaveLength(2);
    expect(rendered).not.toContain('<script');
    expect(rendered).not.toContain('<img');
    expect(renderToStaticMarkup(createElement(AssetReferenceList, { text: '<h1>No files</h1>' }))).toBe('');
  });

  it('shows active document formats as source and keeps unknown types downloadable', () => {
    expect(assetPreviewKind({ name: 'report.md', mediaType: 'text/markdown' })).toBe('markdown');
    expect(assetPreviewKind({ name: 'capture.png', mediaType: 'image/png' })).toBe('image');
    expect(assetPreviewKind({ name: 'demo.webm', mediaType: 'video/webm' })).toBe('video');
    expect(assetPreviewKind({ name: 'page.html', mediaType: 'text/html' })).toBe('text');
    expect(assetPreviewKind({ name: 'icon.svg', mediaType: 'image/svg+xml' })).toBe('text');
    expect(assetPreviewKind({ name: 'report.pdf', mediaType: 'application/pdf' })).toBe('download');
    expect(assetContentUrl('asset-1', true)).toBe('/api/assets/asset-1/content?download=1');
  });
});
