import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const articleSlugs = [
  'video-to-notes-guide',
  'video-notes-vs-ppt-pdf',
  'course-video-notes',
  'training-video-to-handout',
  'where-to-get-videos',
  'youtube-bilibili-local-video'
];
const publicPath = relative => join(root, 'public', relative);

function read(relative) {
  return readFileSync(publicPath(relative), 'utf8');
}

test('blog hub exposes every published article in structured data and navigation', () => {
  const hub = read('blog/index.html');
  assert.match(hub, /CollectionPage/);
  assert.match(hub, /ItemList/);
  for (const slug of articleSlugs) {
    assert.match(hub, new RegExp(`/blog/${slug}/`));
    assert.match(read(`blog/${slug}/index.html`), new RegExp(`https://vid2ppt\\.com/blog/${slug}/`));
  }
});

test('each article has answer-friendly metadata, breadcrumbs, FAQ and a product path', () => {
  for (const slug of articleSlugs) {
    const html = read(`blog/${slug}/index.html`);
    assert.match(html, /<title>[^<]+<\/title>/);
    assert.match(html, /<h1>[^<]+<\/h1>/);
    assert.match(html, /"@type":"BlogPosting"/);
    assert.match(html, /"@type":"BreadcrumbList"/);
    assert.match(html, /"@type":"FAQPage"/);
    assert.match(html, /timeRequired/);
    assert.match(html, /href="\/#start"/);
    for (const forbidden of ['不', '先', '再', '而是', '并非']) assert.equal(html.includes(forbidden), false, `${slug} contains ${forbidden}`);
  }
});

test('blog support assets and sitemap point to real pages', () => {
  const sitemap = read('sitemap.xml');
  const llms = read('llms.txt');
  for (const path of ['/blog/', '/editorial-policy/', ...articleSlugs.map(slug => `/blog/${slug}/`)]) {
    assert.equal(existsSync(publicPath(`${path.slice(1)}index.html`)), true, `missing ${path}`);
    assert.match(sitemap, new RegExp(`https://vid2ppt\\.com${path.replaceAll('/', '\\/')}`));
    assert.match(llms, new RegExp(`https://vid2ppt\\.com${path.replaceAll('/', '\\/')}`));
  }
});
