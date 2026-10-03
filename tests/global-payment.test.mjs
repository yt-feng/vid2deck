import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const languageScript = readFileSync(new URL('../public/global-language.js', import.meta.url), 'utf8');
const pageScript = readFileSync(new URL('../public/global-page.js', import.meta.url), 'utf8');
const english = JSON.parse(readFileSync(new URL('../public/locales/en.json', import.meta.url), 'utf8'));

function harness({ lang = 'en', path = '/pricing/', query = '', browserLanguages = ['en-US'], savedLanguage = '', signedIn = false, missingTranslation = false, failConfigOnce = false } = {}) {
  const elements = new Map(), buttons = [], cards = [], requests = [], checkouts = [], initializations = [], timers = [];
  class Element {
    constructor(attrs = {}) { this.attrs = attrs; this.events = {}; this.value = attrs.value || ''; this.textContent = ''; this.disabled = 'disabled' in attrs; this.classList = { toggle() {} }; }
    addEventListener(type, callback) { (this.events[type] ||= []).push(callback); }
    fire(type) { for (const callback of this.events[type] || []) callback.call(this, { preventDefault() {} }); }
    setAttribute(name, value) { this.attrs[name] = value; }
    getAttribute(name) { return this.attrs[name] ?? null; }
    removeAttribute(name) { delete this.attrs[name]; }
    appendChild() {}
    focus() { focused = this; }
    scrollIntoView() {}
  }
  function attrs(value) { return Object.fromEntries([...value.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(match => [match[1], match[2] ?? ''])); }
  let focused = null;
  const body = new Element();
  Object.defineProperty(body, 'innerHTML', { set(html) {
    elements.clear(); buttons.length = 0; cards.length = 0;
    for (const match of html.matchAll(/<[\w-]+\b[^>]*>/g)) {
      const attributes = attrs(match[0]); const element = new Element(attributes);
      if (attributes.id) elements.set(attributes.id, element);
      if (attributes.class?.split(' ').includes('plan-button')) buttons.push(element);
      if ('data-card-plan' in attributes) cards.push(element);
    }
  } });
  const storage = new Map();
  if (savedLanguage) storage.set('vid2ppt.language', savedLanguage);
  if (signedIn) storage.set('vid2deck.auth.session', JSON.stringify({ token: 'test-token', user: { email: 'account@example.test', username: 'example', id: 'test-user' } }));
  const storageApi = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const location = new URL(`https://vid2ppt.com${path}?${lang ? 'lang=' + encodeURIComponent(lang) : ''}${query ? '&' + query : ''}`);
  const window = { location, navigator: { languages: browserLanguages }, localStorage: storageApi, matchMedia: () => ({ matches: true }), addEventListener() {},
    Paddle: { Initialize(options) { initializations.push(options); }, Environment: { set() {} }, Checkout: { open(options) { checkouts.push(options); } } }
  };
  const document = { body, documentElement: {}, title: '', head: new Element(),
    createElement: () => new Element(), getElementById: id => elements.get(id),
    querySelector: () => new Element(),
    querySelectorAll: selector => selector === '.plan-button' ? buttons : selector === '[data-card-plan]' ? cards : []
  };
  window.document = document;
  let configAttempts = 0;
  const fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.startsWith('/locales/')) {
      if (missingTranslation && url !== '/locales/en.json') return { ok: false };
      const value = JSON.parse(readFileSync(new URL('../public' + url, import.meta.url), 'utf8'));
      return { ok: true, json: async () => value };
    }
    if (url === '/api/paddle-config') {
      if (failConfigOnce && ++configAttempts === 1) throw new Error('temporary failure');
      return { ok: true, json: async () => ({ config: { PADDLE_ENV: 'production', PADDLE_CLIENT_TOKEN: 'test-public-client', PADDLE_PRICE_PRO_MONTHLY: 'pro-price', PADDLE_PRICE_LIFETIME: 'lifetime-price', PADDLE_PRICE_DAY_PASS: 'day-price' } }) };
    }
    if (url.startsWith('/api/entitlement')) return { ok: true, json: async () => ({ active: false, plan: 'free' }) };
    throw new Error('Unexpected request ' + url);
  };
  const context = vm.createContext({ window, document, location, navigator: window.navigator, localStorage: storageApi, sessionStorage: storageApi, URL, URLSearchParams, Intl, fetch, setTimeout: callback => { timers.push(callback); } });
  vm.runInContext(languageScript, context);
  vm.runInContext(pageScript, context);
  return { elements, buttons, requests, checkouts, initializations, storage, window, document, timers, get focused() { return focused; }, flush: () => new Promise(resolve => setImmediate(resolve)) };
}

test('33 complete translations have exact keys and template placeholders', async () => {
  const page = harness(); await page.flush();
  const codes = Array.from(page.window.Vid2PPTLocale.languages, item => item[0]);
  assert.equal(codes.length, 33);
  assert.equal(new Set(codes).size, 33);
  const paddleSupported = new Set(['en', 'es', 'fr', 'de', 'pt', 'pt-BR', 'it', 'ja', 'ko', 'ar', 'ru', 'tr', 'nl', 'pl', 'sv', 'da', 'no', 'zh-Hans', 'zh-TW']);
  let supportedCount = 0;
  for (const code of codes) {
    assert.equal(page.window.Vid2PPTLocale.normalize(code), code);
    const paddle = page.window.Vid2PPTLocale.paddleLocale(code);
    assert.ok(paddleSupported.has(paddle), code);
    if (paddle !== 'en' || code === 'en') supportedCount++;
  }
  assert.equal(supportedCount, 19);
  assert.deepEqual(readdirSync(new URL('../public/locales/', import.meta.url)).filter(name => name.endsWith('.json')).sort(), codes.map(code => code + '.json').sort());
  for (const code of codes) {
    const dictionary = JSON.parse(readFileSync(new URL(`../public/locales/${code}.json`, import.meta.url), 'utf8'));
    assert.deepEqual(Object.keys(dictionary).sort(), Object.keys(english).sort(), code);
    for (const key of Object.keys(english)) {
      assert.ok(typeof dictionary[key] === 'string' && dictionary[key].trim(), `${code}:${key}`);
      assert.deepEqual(dictionary[key].match(/\{\w+\}/g)?.sort() || [], english[key].match(/\{\w+\}/g)?.sort() || [], `${code}:${key}`);
    }
  }
});

test('language precedence, regional aliases and English fallback', async () => {
  const page = harness(); await page.flush(); const locale = page.window.Vid2PPTLocale;
  for (const [query, saved, browser, expected] of [
    ['fr-CA', 'de', ['es'], 'fr'], ['', 'ja', ['en'], 'ja'], ['', '', ['xx', 'pt-BR'], 'pt-BR'],
    ['', '', ['zh-Hant-HK'], 'zh-TW'], ['', '', ['zh-SG'], 'zh-CN'], ['', '', ['nb-NO'], 'no'], ['', '', ['fil-PH'], 'tl'], ['', '', ['zz'], 'en']
  ]) assert.equal(locale.resolve(query, saved, browser), expected);
  assert.equal(locale.paddleLocale('zh-CN'), 'zh-Hans'); assert.equal(locale.paddleLocale('zh-TW'), 'zh-TW');
  assert.equal(locale.paddleLocale('pt-BR'), 'pt-BR'); assert.equal(locale.paddleLocale('hi'), 'en');
  assert.equal(locale.url('/#account'), '/?lang=en#account');
});

for (const [lang, checkoutLocale] of [['en', 'en'], ['fr', 'fr'], ['ar', 'ar'], ['hi', 'en'], ['zh-CN', 'zh-Hans'], ['pt-BR', 'pt-BR']]) {
  test(`${lang} checkout uses matching Paddle locale and preserves language on return`, async () => {
    const page = harness({ lang }); await page.flush();
    assert.equal(page.document.documentElement.lang, lang);
    assert.equal(page.document.documentElement.dir, lang === 'ar' ? 'rtl' : 'ltr');
    page.buttons[0].fire('click');
    page.elements.get('globalCheckoutForm').fire('submit');
    assert.equal(page.checkouts.length, 0);
    assert.equal(page.focused, page.elements.get('globalEmail'));
    page.elements.get('globalEmail').value = 'buyer@example.test';
    page.elements.get('globalCheckoutForm').fire('submit');
    page.elements.get('globalCheckoutForm').fire('submit');
    await page.flush();
    assert.equal(page.checkouts.length, 1);
    const checkout = page.checkouts[0];
    assert.equal(checkout.items[0].priceId, 'pro-price'); assert.equal(checkout.items[0].quantity, 1);
    assert.equal(checkout.settings.locale, checkoutLocale);
    assert.equal(checkout.customData.site_locale, lang);
    const returned = new URL(checkout.settings.successUrl);
    assert.equal(returned.searchParams.get('lang'), lang); assert.equal(returned.searchParams.get('checkout'), 'success');
    assert.equal(returned.searchParams.get('plan'), 'pro');
    page.initializations[0].eventCallback({ name: 'checkout.closed' });
    assert.equal(page.elements.get('globalPay').disabled, false);
  });
}

test('one-time pass rejects invalid quantities, and sends valid counts unchanged', async () => {
  const page = harness({ lang: 'en', path: '/one-time-pass/' }); await page.flush();
  page.elements.get('globalEmail').value = 'buyer@example.test';
  for (const value of ['0', '1.5', '1000']) {
    page.elements.get('globalQuantity').value = value; page.elements.get('globalCheckoutForm').fire('submit');
    assert.equal(page.checkouts.length, 0); assert.equal(page.focused, page.elements.get('globalQuantity'));
  }
  page.elements.get('globalQuantity').value = '10'; page.elements.get('globalQuantity').fire('input');
  assert.match(page.elements.get('globalTotal').textContent, /99\.00/);
  page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
  assert.equal(page.checkouts[0].items[0].quantity, 10); assert.equal(page.checkouts[0].customData.pass_quantity, 10);
});

test('checkout configuration failure is retryable and account lookup uses authenticated email', async () => {
  const page = harness({ signedIn: true, failConfigOnce: true }); await page.flush();
  page.buttons[1].fire('click'); page.elements.get('globalEmail').value = 'other@example.test';
  page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
  assert.equal(page.checkouts.length, 0); assert.equal(page.elements.get('globalPay').disabled, false);
  page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
  assert.equal(page.checkouts.length, 1);
  page.elements.get('globalRefresh').fire('click'); await page.flush();
  const requests = page.requests.filter(request => request.url.startsWith('/api/entitlement'));
  for (const request of requests) { assert.equal(request.url, '/api/entitlement?email=account%40example.test'); assert.equal(request.options.headers.Authorization, 'Bearer test-token'); }
  assert.match(page.elements.get('globalEntitlementStatus').textContent, /Free/);
});

test('success query never fabricates paid access, and failed translation renders English checkout', async () => {
  const returned = harness({ signedIn: true, query: 'checkout=success' }); await returned.flush();
  assert.equal(returned.checkouts.length, 0);
  assert.match(returned.elements.get('globalEntitlementStatus').textContent, /Free/);
  const fallback = harness({ lang: 'fr', missingTranslation: true }); await fallback.flush();
  assert.equal(fallback.document.documentElement.lang, 'en');
  fallback.buttons[0].fire('click'); fallback.elements.get('globalEmail').value = 'buyer@example.test';
  fallback.elements.get('globalCheckoutForm').fire('submit'); await fallback.flush();
  assert.equal(fallback.checkouts[0].settings.locale, 'en');
});

test('Paddle transaction landing links initialize with page language', async () => {
  const page = harness({ lang: 'fr', query: '_ptxn=txn_0123456789abc' }); await page.flush();
  assert.equal(page.initializations.length, 1);
  assert.equal(page.initializations[0].checkout.settings.locale, 'fr');
  assert.match(page.initializations[0].checkout.settings.successUrl, /lang=fr/);
});

test('homepage localization redirects marketing anchors while preserving application deep links', () => {
  const script = readFileSync(new URL('../public/global-home.js', import.meta.url), 'utf8');
  for (const [hash, expected] of [['', '/welcome/?lang=en'], ['#product', '/welcome/?lang=en'], ['#faq', '/welcome/?lang=en'], ['#start', null], ['#workspace', null], ['#account', null]]) {
    const location = new URL('https://vid2ppt.com/?lang=en' + hash);
    let redirected = null;
    location.replace = value => { redirected = value; };
    const document = { querySelector: () => null, querySelectorAll: () => [] };
    const window = { location, document, navigator: { languages: ['en'] }, localStorage: { getItem: () => '', setItem() {} } };
    const context = vm.createContext({ window, document, location, URL, URLSearchParams });
    vm.runInContext(languageScript, context); vm.runInContext(script, context);
    assert.equal(redirected, expected, hash);
  }
});
