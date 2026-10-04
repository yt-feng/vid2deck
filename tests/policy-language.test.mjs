import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const script = readFileSync(new URL('../public/policy-language.js', import.meta.url), 'utf8');
const languageScript = readFileSync(new URL('../public/global-language.js', import.meta.url), 'utf8');
const english = JSON.parse(readFileSync(new URL('../public/policies/en.json', import.meta.url), 'utf8'));
const routes = ['privacy', 'terms-and-conditions', 'refund'];
const sources = Object.fromEntries(routes.map(route => [route, readFileSync(new URL(`../public/${route}/index.html`, import.meta.url), 'utf8')]));

function decode(value) {
  return value.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[entity]);
}
function matches(node, selector) {
  const pieces = selector.trim().split(/\s+/);
  let part = pieces.pop();
  const notClass = part.match(/:not\(\.([\w-]+)\)/)?.[1];
  part = part.replace(/:not\([^)]*\)/g, '');
  if (notClass && node.className.split(/\s+/).includes(notClass)) return false;
  const tag = part.match(/^[a-z][\w-]*/i)?.[0];
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  const id = part.match(/#([\w-]+)/)?.[1];
  if (id && node.id !== id) return false;
  for (const match of part.matchAll(/\.([\w-]+)/g)) if (!node.className.split(/\s+/).includes(match[1])) return false;
  for (const match of part.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
    if (node.getAttribute(match[1]) === null) return false;
    if (match[2] !== undefined && node.getAttribute(match[1]) !== match[2]) return false;
  }
  if (!pieces.length) return true;
  for (let parent = node.parentElement; parent; parent = parent.parentElement) if (matches(parent, pieces.join(' '))) return true;
  return false;
}
class Element {
  constructor(tag, attrs = {}) { this.tagName = tag.toUpperCase(); this.attrs = attrs; this.children = []; this.parentElement = null; this.text = ''; }
  get id() { return this.attrs.id || ''; }
  set id(value) { this.attrs.id = value; }
  get className() { return this.attrs.class || ''; }
  set className(value) { this.attrs.class = value; }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.text = value; this.children = []; }
  set innerHTML(value) { this.children = []; this.text = ''; parse(this, value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  removeAttribute(name) { delete this.attrs[name]; }
  appendChild(node) { node.parentElement = this; this.children.push(node); }
  insertBefore(node, reference) { node.parentElement = this; const index = this.children.indexOf(reference); this.children.splice(index < 0 ? this.children.length : index, 0, node); }
  remove() { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); }
  querySelectorAll(selector) {
    const selectors = selector.split(',');
    const result = [];
    for (const child of this.children) {
      if (selectors.some(part => matches(child, part))) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  scrollIntoView() { this.scrolled = true; }
}
function parse(parent, html) {
  const stack = [parent];
  const voidTags = new Set(['META', 'LINK', 'IMG', 'BR', 'INPUT', 'HR']);
  for (const token of html.match(/<!--[\s\S]*?-->|<\/?[^>]+>|[^<]+/g) || []) {
    if (token.startsWith('<!')) continue;
    if (token.startsWith('</')) {
      const tag = token.match(/^<\/([\w-]+)/)?.[1].toUpperCase();
      while (stack.length > 1) if (stack.pop().tagName === tag) break;
    } else if (token.startsWith('<')) {
      const match = token.match(/^<([\w-]+)\b([^>]*)>/);
      if (!match) continue;
      const attrs = Object.fromEntries([...match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(item => [item[1], decode(item[2] || '')]));
      const node = new Element(match[1], attrs);
      stack.at(-1).appendChild(node);
      if (!voidTags.has(node.tagName) && !token.endsWith('/>')) stack.push(node);
    } else stack.at(-1).text += decode(token);
  }
}

async function harness({ route = 'privacy', query = '?lang=en', hash = '', saved = '', browser = ['en-US'], fail = false, payload = english } = {}) {
  const tree = new Element('document');
  parse(tree, sources[route]);
  const document = {
    documentElement: tree.querySelector('html'),
    querySelector: selector => tree.querySelector(selector),
    querySelectorAll: selector => tree.querySelectorAll(selector),
    getElementById: id => tree.querySelector(`#${id}`),
    createElement: tag => new Element(tag),
    title: tree.querySelector('title').textContent
  };
  const storage = new Map(saved ? [['vid2ppt.language', saved]] : []);
  const requests = [];
  const window = {
    document,
    location: new URL(`https://vid2ppt.com/${route}/${query}${hash}`),
    navigator: { languages: browser },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (fail) throw new Error('Unavailable');
      return { ok: true, json: async () => payload };
    }
  };
  const context = vm.createContext({ window, URL, URLSearchParams });
  vm.runInContext(languageScript, context);
  vm.runInContext(script, context);
  const result = await window.Vid2PPTPolicyReady;
  return { document, tree, requests, result, main: document.querySelector('main.doc') };
}

for (const route of routes) {
  test(`${route}: complete English policy retains every legal anchor and section`, async () => {
    const h = await harness({ route });
    assert.equal(h.result.language, 'en');
    assert.equal(h.document.documentElement.getAttribute('lang'), 'en');
    assert.equal(h.document.documentElement.getAttribute('dir'), 'ltr');
    assert.equal(h.document.title, english.policies[route].title);
    assert.equal(h.document.querySelector('meta[name="description"]').getAttribute('content'), english.policies[route].description);
    assert.equal(h.main.getAttribute('id'), 'mainContent');
    assert.equal(h.main.getAttribute('tabindex'), '-1');
    assert.equal(h.main.getAttribute('aria-busy'), null);
    assert.doesNotMatch(h.main.textContent, /[\u3400-\u9fff]/);
    const cnMain = sources[route].match(/<main\b[^>]*>([\s\S]*?)<\/main>/)[1];
    assert.deepEqual([...english.policies[route].main.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]).sort(), [...cnMain.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]).sort());
    assert.equal(h.main.querySelectorAll('h2').length, (cnMain.match(/<h2\b/g) || []).length);
    assert.equal(h.main.querySelectorAll('li').length, (cnMain.match(/<li\b/g) || []).length);
    assert.equal(h.main.querySelectorAll('tr').length, (cnMain.match(/<tr\b/g) || []).length);
    assert.equal(h.main.querySelectorAll('p').length, (cnMain.match(/<p\b/g) || []).length);
    assert.equal(h.document.querySelector('.skip-link').textContent, 'Skip to content');
    assert.equal(h.document.querySelector('.site-nav').getAttribute('aria-label'), 'Main navigation');
    assert.equal(h.document.querySelector('.brand').getAttribute('aria-label'), 'Vid2PPT home');
    assert.doesNotMatch(h.document.querySelector('header').textContent, /[\u3400-\u9fff]/);
    assert.doesNotMatch(h.document.querySelector('footer').textContent, /[\u3400-\u9fff]/);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, '/policies/en.json');
  });
}

test('non-Chinese languages explicitly identify English legal text while retaining the chosen site language', async () => {
  for (const lang of ['fr', 'ar', 'ja', 'pt-BR', 'he', 'uk']) {
    const h = await harness({ query: `?lang=${lang}` });
    assert.equal(h.result.language, 'en');
    assert.equal(h.result.selected, lang);
    assert.match(h.document.getElementById('policyLanguageNote').textContent, /Policy language: English/);
    assert.match(h.document.getElementById('policyLanguageNote').textContent, /English and Simplified Chinese/);
    const pricing = h.document.querySelector('header').querySelectorAll('a[href]').find(link => link.getAttribute('href').startsWith('/pricing/'));
    assert.equal(new URL(pricing.getAttribute('href'), 'https://vid2ppt.com').searchParams.get('lang'), lang);
  }
});

test('Chinese queries preserve current Chinese content without fetching English', async () => {
  for (const lang of ['zh-CN', 'zh-TW']) {
    const h = await harness({ query: `?lang=${lang}` });
    assert.equal(h.result.language, 'zh-CN');
    assert.equal(h.requests.length, 0);
    assert.match(h.main.textContent, /我们如何保护和处理你的内容/);
    assert.equal(h.document.documentElement.getAttribute('lang'), 'zh-CN');
    assert.equal(!!h.document.getElementById('policyLanguageNote'), lang === 'zh-TW');
    assert.match(h.document.querySelector('.brand').getAttribute('href'), new RegExp(`lang=${lang}`));
  }
});

test('language resolution follows saved selection or browser language when no query was supplied', async () => {
  const saved = await harness({ query: '', saved: 'ja', browser: ['zh-CN'] });
  assert.equal(saved.result.selected, 'ja');
  assert.equal(saved.result.language, 'en');
  assert.match(saved.document.getElementById('policyLanguageNote').textContent, /日本語/);
  const browser = await harness({ query: '', browser: ['zh-TW'] });
  assert.equal(browser.result.language, 'zh-CN');
  assert.equal(browser.requests.length, 0);
});

test('workspace/account anchors, policy deep links and existing contact query survive localization', async () => {
  const h = await harness({ route: 'terms-and-conditions', query: '?lang=fr', hash: '#content-license' });
  const hrefs = h.document.querySelectorAll('a[href]').map(link => link.getAttribute('href'));
  assert.ok(hrefs.includes('/?lang=fr#workspace'));
  assert.ok(hrefs.includes('/?lang=fr#account'));
  assert.ok(hrefs.includes('/privacy/?lang=fr#content-processing'));
  assert.ok(hrefs.includes('/welcome/?lang=fr'));
  assert.ok(hrefs.includes('#section-2'));
  assert.ok(hrefs.includes('mailto:info@vid2ppt.com'));
  assert.equal(h.document.getElementById('content-license').scrolled, true);
  const refund = await harness({ route: 'refund', query: '?lang=en' });
  const billing = refund.document.querySelectorAll('a[href]').find(link => { const url = new URL(link.getAttribute('href'), 'https://vid2ppt.com'); return url.pathname === '/contact/' && url.searchParams.get('subject') === 'Vid2PPT billing question'; });
  assert.equal(new URL(billing.getAttribute('href'), 'https://vid2ppt.com').searchParams.get('subject'), 'Vid2PPT billing question');
  assert.equal(new URL(billing.getAttribute('href'), 'https://vid2ppt.com').searchParams.get('lang'), 'en');
});

test('unavailable English asset keeps complete Chinese policy and makes the language fallback explicit', async () => {
  const h = await harness({ fail: true });
  assert.equal(h.result.unavailable, true);
  assert.equal(h.document.documentElement.getAttribute('lang'), 'zh-CN');
  assert.match(h.document.getElementById('policyLanguageNote').textContent, /English policy text could not be loaded/);
  assert.match(h.main.textContent, /各功能如何处理数据/);
  assert.equal(h.main.querySelectorAll('h2').length, 8);
  assert.equal(h.main.getAttribute('aria-busy'), null);
});

test('invalid English asset does not replace the original legal text', async () => {
  const h = await harness({ payload: { language: 'fr', policies: {} } });
  assert.equal(h.result.unavailable, true);
  assert.match(h.main.textContent, /我们如何保护和处理你的内容/);
});

test('English processing and content license match bounded Chinese authorization and preserve future-change notice', () => {
  const privacy = english.policies.privacy.main;
  const terms = english.policies['terms-and-conditions'].main;
  assert.match(privacy, /New or changed upload processing will explain its purpose, transmitted content and storage arrangements before the feature is enabled/);
  assert.match(privacy, /authorization obtained when required/);
  assert.match(terms, /within the necessary scope and duration/);
  assert.match(terms, /does not transfer ownership of your content or permit its sale or use for unrelated purposes/);
  assert.match(terms, /Additional authorization will be obtained separately when required/);
  assert.doesNotMatch(privacy + terms, /GDPR compliant|never upload|never share|unlimited rights/i);
  assert.match(privacy, /October 4, 2026/);
  assert.match(terms, /datetime="2026-10-04"/);
});

test('all three policies load shared language scripts in order and retain Chinese source text', () => {
  for (const route of routes) {
    const html = sources[route];
    assert.equal((html.match(/src="\/global-language\.js"/g) || []).length, 1);
    assert.equal((html.match(/src="\/policy-language\.js"/g) || []).length, 1);
    assert.ok(html.indexOf('/global-language.js') < html.indexOf('/policy-language.js'));
    assert.match(html, /<html lang="zh-CN">/);
    assert.match(html, /<main class="doc" id="mainContent" tabindex="-1">/);
  }
});
