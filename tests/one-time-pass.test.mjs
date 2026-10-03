import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const publicRoot = new URL('../public/', import.meta.url);
const html = readFileSync(new URL('one-time-pass/index.html', publicRoot), 'utf8');

test('one-time pass remains a quiet noindex entry at its canonical purchase URL', () => {
  assert.match(html, /<html\s+lang="en"/);
  assert.match(html, /<meta\s+name="robots"\s+content="noindex,nofollow"\s*\/>/);
  assert.match(html, /<link\s+rel="canonical"\s+href="https:\/\/vid2ppt\.com\/one-time-pass\/"\s*\/>/);
  assert.match(html, /<title>Vid2PPT \| 24-hour pass<\/title>/);
  assert.match(html, /<meta\s+name="description"\s+content="[^"]*Paddle[^"]*"/);
});

test('one-time pass loads shared localization before the deferred payment runtime', () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 2, 'the entry must use the shared runtime without a duplicate inline checkout');
  assert.match(scripts[0][1], /\bsrc="\/global-language\.js"/);
  assert.doesNotMatch(scripts[0][1], /\b(?:async|defer)\b/);
  assert.match(scripts[1][1], /\bsrc="\/global-page\.js"/);
  assert.match(scripts[1][1], /\bdefer\b/);
  for (const script of scripts) assert.equal(script[2].trim(), '');
  assert.match(html, /<link\s+rel="stylesheet"\s+href="\/global-pages\.css"/);
  for (const file of ['global-language.js', 'global-page.js', 'global-pages.css']) {
    assert.ok(readFileSync(new URL(file, publicRoot), 'utf8').trim(), `${file} must exist at the entry's root-relative asset URL`);
  }
  const runtime = readFileSync(new URL('global-page.js', publicRoot), 'utf8');
  assert.match(runtime, /location\.pathname[^;]*['"]\/one-time-pass['"]/);
  assert.match(runtime, /source:\s*page\s*===\s*['"]pass['"]\s*\?\s*['"]one_time_pass_page['"]/);
});

test('the loading fallback has English support guidance without stale prices or checkout controls', () => {
  assert.match(html, /<main\s+class="global-error">/);
  const fallback = html.match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1];
  assert.ok(fallback);
  assert.match(fallback, /Enable JavaScript/);
  assert.match(fallback, /href="mailto:info@vid2ppt\.com"/);
  assert.doesNotMatch(html, /CNY|人民币|¥|￥|9\.90|MAX_QUANTITY|UNIT_PRICE|max="999"/);
  assert.doesNotMatch(html, /<form\b|<input\b|Paddle\.Checkout/);
});
