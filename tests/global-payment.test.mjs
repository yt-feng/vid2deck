import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const languageScript = readFileSync(new URL('../public/global-language.js', import.meta.url), 'utf8');
const pageScript = readFileSync(new URL('../public/global-page.js', import.meta.url), 'utf8');
const english = JSON.parse(readFileSync(new URL('../public/locales/en.json', import.meta.url), 'utf8'));

function pricePreview(request, { minimum = 1, maximum = 999999, currency = 'CNY', unitSubtotal, taxRate = 0 } = {}) {
  const currencyCode = currency;
  const prices = { 'pro-price': 3900, 'lifetime-price': 49800, 'day-price': 990 };
  const lineItems = Array.from(request.items, item => {
    const subtotal = unitSubtotal ?? prices[item.priceId];
    const tax = Math.round(subtotal * taxRate);
    const lineSubtotal = subtotal * item.quantity;
    const lineTax = Math.round(lineSubtotal * taxRate);
    return {
      price: { id: item.priceId, quantity: { minimum, maximum } },
      quantity: item.quantity,
      unitTotals: { subtotal: String(subtotal), tax: String(tax), total: String(subtotal + tax) },
      totals: { subtotal: String(lineSubtotal), tax: String(lineTax), total: String(lineSubtotal + lineTax) }
    };
  });
  return { data: { currencyCode, details: { lineItems } } };
}

function formattedAmount(amount, currency, lang = 'en') {
  return new Intl.NumberFormat(lang, { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(amount);
}

function formattedMinor(amount, currency, lang = 'en') {
  const minorDigits = new Intl.NumberFormat(lang, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  return formattedAmount(Number(amount) / 10 ** minorDigits, currency, lang);
}

const exchangeRates = { result: 'success', base_code: 'CNY', time_last_update_utc: 'Sat, 03 Oct 2026 00:02:32 +0000', time_last_update_unix: Math.floor(Date.now() / 1000) - 60, rates: { CNY: 1, USD: 0.14, EUR: 0.13, JPY: 21, INR: 12, BRL: 0.8, GBP: 0.11, CAD: 0.19, AUD: 0.2, TWD: 4.5, AED: 0.51, KRW: 193, IDR: 2300, TRY: 6, VND: 3500, THB: 4.7, PLN: 0.6, SEK: 1.5, DKK: 1, NOK: 1.5, CZK: 3.4, UAH: 5.8, RON: 0.65, HUF: 53, ILS: 0.5, BDT: 17, MYR: 0.6, PHP: 8, RUB: 12 } };

function harness({ lang = 'en', path = '/pricing/', query = '', browserLanguages = ['en-US'], savedLanguage = '', savedCountry = '', signedIn = false, missingTranslation = false, failConfigOnce = false, preview = pricePreview, rates = exchangeRates } = {}) {
  const elements = new Map(), buttons = [], cards = [], priceNodes = [], presets = [], requests = [], checkouts = [], initializations = [], previews = [], historyChanges = [], navigations = [];
  const timers = new Map();
  let nextTimer = 1, now = 0, focused = null, bodyHtml = '';
  function decodeText(value) {
    return value.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[entity]);
  }
  function matches(element, selector) {
    const parts = selector.trim().split(/\s+/);
    const simple = parts.pop();
    const tag = simple.match(/^[a-z][\w-]*/i)?.[0];
    if (tag && element.tagName !== tag.toUpperCase()) return false;
    const id = simple.match(/#([\w-]+)/)?.[1];
    if (id && element.id !== id) return false;
    for (const match of simple.matchAll(/\.([\w-]+)/g)) if (!element.classList.contains(match[1])) return false;
    for (const match of simple.matchAll(/\[([\w-]+)(?:([~^$*]?=)["']?([^\]"']*)["']?)?\]/g)) {
      const value = element.getAttribute(match[1]);
      if (value === null) return false;
      if (match[2] === '=' && value !== match[3]) return false;
      if (match[2] === '^=' && !value.startsWith(match[3])) return false;
    }
    if (!parts.length) return true;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) if (matches(parent, parts.join(' '))) return true;
    return false;
  }
  class Element {
    constructor(attrs = {}, tag = 'div') {
      this.attrs = attrs; this.tagName = tag.toUpperCase(); this.events = {}; this.children = []; this.parentElement = null;
      this.value = attrs.value || ''; this._text = ''; this.disabled = 'disabled' in attrs; this.hidden = 'hidden' in attrs;
      this.min = attrs.min; this.max = attrs.max;
      const classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
      const syncClass = () => { this.attrs.class = [...classes].join(' '); };
      this.classList = {
        contains: name => classes.has(name),
        add: (...names) => { names.forEach(name => classes.add(name)); syncClass(); },
        remove: (...names) => { names.forEach(name => classes.delete(name)); syncClass(); },
        toggle: (name, force) => { const enabled = force ?? !classes.has(name); if (enabled) classes.add(name); else classes.delete(name); syncClass(); return enabled; }
      };
    }
    get id() { return this.attrs.id || ''; }
    set id(value) { this.attrs.id = value; elements.set(value, this); }
    get href() { return this.attrs.href ? new URL(this.attrs.href, 'https://vid2ppt.com').href : ''; }
    set href(value) { this.attrs.href = String(value); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    set innerHTML(html) { parseHtml(this, html); }
    addEventListener(type, callback) { (this.events[type] ||= []).push(callback); }
    fire(type, properties = {}) { for (const callback of this.events[type] || []) callback.call(this, { preventDefault() {}, target: this, ...properties }); }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    getAttribute(name) { return this.attrs[name] ?? null; }
    removeAttribute(name) { delete this.attrs[name]; }
    appendChild(child) { child.parentElement = this; this.children.push(child); }
    querySelectorAll(selector) {
      const found = [];
      for (const child of this.children) { if (matches(child, selector)) found.push(child); found.push(...child.querySelectorAll(selector)); }
      return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { for (let element = this; element; element = element.parentElement) if (matches(element, selector)) return element; return null; }
    contains(element) { return element === this || this.children.some(child => child.contains(element)); }
    select() { this.wasSelected = true; this.selectionStart = 0; this.selectionEnd = String(this.value).length; }
    remove() { this.removed = true; if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
    focus() { focused = this; this.fire('focus'); }
    scrollIntoView() {}
  }
  function attrs(value) { return Object.fromEntries([...value.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(match => [match[1], decodeText(match[2] ?? '')])); }
  function parseHtml(root, html) {
    root.children = []; root._text = '';
    const stack = [root];
    const voidTags = new Set(['AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR']);
    for (const token of html.match(/<!--[\s\S]*?-->|<\/?[^>]+>|[^<]+/g) || []) {
      if (token.startsWith('<!--') || token.startsWith('<!')) continue;
      if (token.startsWith('</')) {
        const closing = token.match(/^<\/([\w-]+)/)?.[1].toUpperCase();
        while (stack.length > 1) if (stack.pop().tagName === closing) break;
      } else if (token.startsWith('<')) {
        const match = token.match(/^<([\w-]+)\b([^>]*)>/); if (!match) continue;
        const element = new Element(attrs(match[2]), match[1]);
        stack.at(-1).appendChild(element);
        if (element.id) elements.set(element.id, element);
        if (!voidTags.has(element.tagName) && !token.endsWith('/>')) stack.push(element);
      } else stack.at(-1)._text += decodeText(token);
    }
  }
  const body = new Element({}, 'body');
  Object.defineProperty(body, 'innerHTML', { get: () => bodyHtml, set(html) {
    bodyHtml = html; elements.clear(); parseHtml(body, html);
    buttons.splice(0, buttons.length, ...body.querySelectorAll('.plan-button'));
    cards.splice(0, cards.length, ...body.querySelectorAll('[data-card-plan]'));
    priceNodes.splice(0, priceNodes.length, ...body.querySelectorAll('[data-price-plan]'));
    presets.splice(0, presets.length, ...body.querySelectorAll('.quantity-preset'));
  } });
  const storage = new Map();
  if (savedLanguage) storage.set('vid2ppt.language', savedLanguage);
  if (savedCountry) storage.set('vid2ppt.billingCountry', savedCountry);
  if (signedIn) storage.set('vid2deck.auth.session', JSON.stringify({ token: 'test-token', user: { email: 'account@example.test', username: 'example', id: 'test-user' } }));
  const storageApi = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const location = new URL(`https://vid2ppt.com${path}?${lang ? 'lang=' + encodeURIComponent(lang) : ''}${query ? '&' + query : ''}`);
  location.assign = value => { navigations.push(value); location.href = value; };
  const windowEvents = {};
  const window = { location, navigator: { languages: browserLanguages }, localStorage: storageApi, matchMedia: () => ({ matches: true }),
    addEventListener(type, callback) { (windowEvents[type] ||= []).push(callback); },
    history: { replaceState(_state, _title, value) { historyChanges.push(value); location.href = new URL(value, location.href).href; } },
    Paddle: {
      Initialize(options) { initializations.push(options); }, Environment: { set() {} },
      PricePreview(options) {
        previews.push(options);
        try { return Promise.resolve(preview(options, previews.length)); }
        catch (error) { return Promise.reject(error); }
      },
      Checkout: { open(options) { checkouts.push(options); } }
    }
  };
  const documentEvents = {};
  const document = { body, documentElement: new Element(), title: '', head: new Element(),
    addEventListener(type, callback) { (documentEvents[type] ||= []).push(callback); },
    createElement: tag => new Element({}, tag), getElementById: id => elements.get(id),
    querySelector: selector => selector === 'meta[name="description"]' ? new Element() : body.querySelector(selector),
    querySelectorAll: selector => body.querySelectorAll(selector)
  };
  window.document = document;
  let configAttempts = 0, rateAttempts = 0;
  const fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.startsWith('/locales/')) {
      if (missingTranslation && url !== '/locales/en.json') return { ok: false };
      const value = JSON.parse(readFileSync(new URL('../public' + url, import.meta.url), 'utf8'));
      return { ok: true, json: async () => value };
    }
    if (url === 'https://open.er-api.com/v6/latest/CNY') {
      const response = typeof rates === 'function' ? rates(++rateAttempts) : rates;
      if (response instanceof Error) throw response;
      return { ok: true, json: async () => response };
    }
    if (url === '/api/paddle-config') {
      if (failConfigOnce && ++configAttempts === 1) throw new Error('temporary failure');
      return { ok: true, json: async () => ({ config: { PADDLE_ENV: 'production', PADDLE_CLIENT_TOKEN: 'test-public-client', PADDLE_PRICE_PRO_MONTHLY: 'pro-price', PADDLE_PRICE_LIFETIME: 'lifetime-price', PADDLE_PRICE_DAY_PASS: 'day-price' } }) };
    }
    if (url.startsWith('/api/entitlement')) return { ok: true, json: async () => ({ active: false, plan: 'free' }) };
    throw new Error('Unexpected request ' + url);
  };
  const setTimeout = (callback, delay = 0) => {
    const id = nextTimer++; timers.set(id, { callback, due: now + delay }); return id;
  };
  const clearTimeout = id => timers.delete(id);
  const context = vm.createContext({ window, document, location, navigator: window.navigator, localStorage: storageApi, sessionStorage: storageApi, URL, URLSearchParams, Intl, fetch, setTimeout, clearTimeout });
  vm.runInContext(languageScript, context);
  vm.runInContext(pageScript, context);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { elements, buttons, cards, priceNodes, presets, requests, checkouts, initializations, previews, historyChanges, navigations, storage, window, document, timers,
    get focused() { return focused; }, flush,
    async advance(ms = 250) {
      now += ms;
      for (const [id, timer] of Array.from(timers)) {
        if (timer.due <= now && timers.delete(id)) timer.callback();
      }
      await flush();
    },
    fireWindow(type, event) { for (const callback of windowEvents[type] || []) callback(event); },
    fireDocument(type, event) { for (const callback of documentEvents[type] || []) callback(event); }
  };
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
  const page = harness({ lang: 'en', path: '/one-time-pass/', query: 'quantity=1' }); await page.flush();
  page.elements.get('globalEmail').value = 'buyer@example.test';
  for (const value of ['0', '1.5', '1000000']) {
    page.elements.get('globalQuantity').value = value; page.elements.get('globalCheckoutForm').fire('submit');
    assert.equal(page.checkouts.length, 0); assert.equal(page.focused, page.elements.get('globalQuantity'));
  }
  page.elements.get('globalQuantity').value = '10'; page.elements.get('globalQuantity').fire('input');
  assert.equal(page.elements.get('globalTotal').textContent, '—');
  await page.advance(250);
  assert.equal(page.previews.at(-1).items[0].quantity, 10);
  page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
  assert.equal(page.checkouts[0].items[0].quantity, 10); assert.equal(page.checkouts[0].customData.pass_quantity, 10);
});

test('checkout configuration failure is retryable and account lookup uses authenticated email', async () => {
  const page = harness({ signedIn: true, failConfigOnce: true }); await page.flush();
  assert.equal(page.elements.get('globalPay').disabled, true);
  assert.equal(page.elements.get('globalQuoteStatus').getAttribute('data-tone'), 'error');
  page.buttons[1].fire('click'); page.elements.get('globalEmail').value = 'other@example.test';
  page.elements.get('globalRetryQuote').fire('click'); await page.flush();
  assert.equal(page.requests.filter(request => request.url === '/api/paddle-config').length, 2);
  assert.equal(page.elements.get('globalPay').disabled, false);
  page.elements.get('globalCheckoutForm').fire('submit');
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

test('10 passes show a USD exchange-rate estimate while Paddle keeps its CNY charge', async () => {
  const page = harness({ path: '/one-time-pass/', query: 'country=US&quantity=10' }); await page.flush();
  assert.equal(page.previews[0].address.countryCode, 'US');
  assert.equal(page.previews[0].items[0].quantity, 10);
  assert.equal(page.elements.get('globalUnitPrice').textContent, '≈ $1');
  assert.equal(page.elements.get('globalTotal').textContent, '≈ $14');
  assert.equal(page.elements.get('globalTax').textContent, '≈ $0');
  assert.equal(page.elements.get('globalGrandTotal').textContent, '≈ $14');
  assert.ok(page.elements.get('globalChargeSummary').textContent.includes(formattedMinor(9900, 'CNY') + ' (CNY)'));
  assert.ok(page.elements.get('globalRateDate').textContent.startsWith('Exchange rate updated:'));
  assert.equal(page.requests.filter(request => request.url === 'https://open.er-api.com/v6/latest/CNY').length, 1);
  page.elements.get('globalEmail').value = 'buyer@example.test';
  page.elements.get('globalCheckoutForm').fire('submit'); page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
  assert.equal(page.checkouts.length, 1);
  const checkout = page.checkouts[0];
  assert.equal(checkout.items[0].priceId, page.previews[0].items[0].priceId);
  assert.equal(checkout.items[0].quantity, 10);
  assert.equal(checkout.customer.address.countryCode, 'US');
  assert.equal(checkout.customData.quoted_currency, 'CNY');
  assert.equal(checkout.customData.display_currency, 'USD');
  const returned = new URL(checkout.settings.successUrl);
  assert.equal(returned.searchParams.get('country'), 'US');
  assert.equal(returned.searchParams.get('quantity'), '10');
  assert.equal(returned.searchParams.get('currency'), 'USD');
});

test('provider subtotal, tax and total are converted separately without multiplying a rounded unit total', async () => {
  const page = harness({ path: '/one-time-pass/', query: 'country=US&quantity=10', preview: request => pricePreview(request, { unitSubtotal: 325, taxRate: 0.085 }) }); await page.flush();
  assert.equal(page.elements.get('globalUnitPrice').textContent, '≈ $0');
  assert.equal(page.elements.get('globalTotal').textContent, '≈ $5');
  assert.equal(page.elements.get('globalTax').textContent, '≈ $0');
  assert.equal(page.elements.get('globalGrandTotal').textContent, '≈ $5');
  assert.ok(page.elements.get('globalChargeSummary').textContent.includes(formattedMinor(3526, 'CNY') + ' (CNY)'));
});

test('JPY reference amounts use zero decimal places and retain the original CNY charge', async () => {
  const page = harness({ lang: 'ja', path: '/one-time-pass/', query: 'country=JP&quantity=1' }); await page.flush();
  assert.equal(page.elements.get('globalTotal').textContent, '≈ ' + new Intl.NumberFormat('ja', { style: 'currency', currency: 'JPY' }).format(208));
  assert.ok(page.elements.get('globalChargeSummary').textContent.includes(formattedMinor(990, 'CNY', 'ja') + ' (CNY)'));
  page.elements.get('globalEmail').value = 'buyer@example.test'; page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
  assert.equal(page.checkouts[0].customData.quoted_currency, 'CNY');
  assert.equal(page.checkouts[0].customData.display_currency, 'JPY');
});

test('an actual JPY provider quote is neither divided by 100 nor labeled as an estimate', async () => {
  const page = harness({ lang: 'ja', path: '/one-time-pass/', query: 'country=JP&quantity=1', preview: request => pricePreview(request, { currency: 'JPY', unitSubtotal: 210 }) }); await page.flush();
  assert.equal(page.elements.get('globalTotal').textContent, new Intl.NumberFormat('ja', { style: 'currency', currency: 'JPY' }).format(210));
  assert.ok(page.elements.get('globalChargeSummary').textContent.includes(formattedMinor(210, 'JPY', 'ja') + ' (JPY)'));
});

test('billing country affects preview and checkout while language changes preserve country and quantity', async () => {
  const page = harness({ lang: 'fr', path: '/one-time-pass/', query: 'country=US&quantity=10' }); await page.flush();
  page.elements.get('globalCountry').value = 'JP'; page.elements.get('globalCountry').fire('change'); await page.flush();
  assert.equal(page.previews.at(-1).address.countryCode, 'JP');
  assert.equal(page.elements.get('globalTotal').textContent, '≈ ' + new Intl.NumberFormat('fr', { style: 'currency', currency: 'JPY' }).format(2079));
  assert.equal(page.storage.get('vid2ppt.billingCountry'), 'JP');
  assert.equal(page.window.location.searchParams.get('country'), 'JP');
  assert.equal(page.window.location.searchParams.get('quantity'), '10');
  page.elements.get('globalEmail').value = 'buyer@example.test'; page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
  const checkout = page.checkouts[0];
  assert.equal(checkout.customer.address.countryCode, 'JP');
  assert.equal(checkout.settings.locale, 'fr');
  assert.equal(checkout.customData.quoted_currency, 'CNY');
  assert.equal(checkout.customData.display_currency, 'JPY');
  const select = page.elements.get('languageControl').children[0];
  select.value = 'en'; select.fire('change');
  const changed = new URL(page.navigations.at(-1));
  assert.equal(changed.searchParams.get('lang'), 'en');
  assert.equal(changed.searchParams.get('country'), 'JP');
  assert.equal(changed.searchParams.get('quantity'), '10');
  assert.equal(changed.searchParams.get('currency'), 'USD');
});

test('purchase URLs restore 1000 passes and buyers can edit the quantity without a share form', async () => {
  const page = harness({ lang: 'en', path: '/one-time-pass/', query: 'country=BR&quantity=1000' }); await page.flush();
  assert.equal(page.elements.get('globalQuantity').value, '1000');
  assert.equal(page.previews[0].items[0].quantity, 1000);
  assert.equal(page.elements.get('globalTotal').textContent, '≈ ' + formattedAmount(7920, 'BRL'));
  assert.equal(page.elements.has('globalShare'), false);
  const share = new URL(page.window.location.href);
  assert.equal(share.pathname, '/one-time-pass/');
  assert.equal(share.searchParams.get('lang'), 'en');
  assert.equal(share.searchParams.get('country'), 'BR');
  assert.equal(share.searchParams.get('quantity'), '1000');
  assert.equal(share.searchParams.get('currency'), 'BRL');
  page.elements.get('globalQuantity').value = '10'; page.elements.get('globalQuantity').fire('input'); await page.advance(250);
  assert.equal(page.window.location.searchParams.get('quantity'), '10');
  page.elements.get('globalQuantity').value = '1000'; page.elements.get('globalQuantity').fire('input'); await page.advance(250);
  assert.equal(page.previews.at(-1).items[0].quantity, 1000);
  page.elements.get('globalEmail').value = 'buyer@example.test'; page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
  assert.equal(page.checkouts[0].items[0].quantity, 1000);
  assert.equal(page.checkouts[0].customData.pass_quantity, 1000);
  assert.equal(page.checkouts[0].customData.quoted_currency, 'CNY');
});

test('a failed quote clears prices and explicit reload restores payment without duplicate initialization', async () => {
  const page = harness({ path: '/one-time-pass/', query: 'quantity=1', preview: (request, attempt) => {
    if (attempt === 1) throw new Error('preview unavailable');
    return pricePreview(request);
  } }); await page.flush();
  assert.equal(page.elements.get('globalPay').disabled, true);
  assert.equal(page.elements.get('globalTotal').textContent, '—');
  assert.equal(page.elements.get('globalQuoteStatus').getAttribute('data-tone'), 'error');
  page.elements.get('globalRetryQuote').fire('click'); await page.flush();
  assert.equal(page.elements.get('globalPay').disabled, false);
  assert.equal(page.elements.get('globalTotal').textContent, '≈ $1');
  assert.equal(page.previews.length, 2);
  assert.equal(page.initializations.length, 1);
  assert.equal(page.requests.filter(request => request.url === '/api/paddle-config').length, 1);
  page.elements.get('globalEmail').value = 'buyer@example.test'; page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
  assert.equal(page.checkouts.length, 1);
});

test('a persistently failed preview cannot open checkout or retain a former quote', async () => {
  let fail = false;
  const page = harness({ path: '/one-time-pass/', query: 'quantity=1', preview: request => {
    if (fail) throw new Error('preview unavailable');
    return pricePreview(request);
  } }); await page.flush();
  assert.equal(page.elements.get('globalPay').disabled, false);
  fail = true; page.elements.get('globalCountry').value = 'GB'; page.elements.get('globalCountry').fire('change'); await page.flush();
  assert.equal(page.elements.get('globalPay').disabled, true);
  assert.equal(page.elements.get('globalTotal').textContent, '—');
  assert.equal(page.elements.get('globalChargeSummary').textContent, '');
  page.elements.get('globalEmail').value = 'buyer@example.test'; page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
  assert.equal(page.checkouts.length, 0);
  assert.equal(page.elements.get('globalPay').disabled, true);
});

for (const rejectOlder of [false, true]) {
  test(`a delayed ${rejectOlder ? 'failed' : 'successful'} older country quote cannot replace the current country`, async () => {
    const pending = [];
    const page = harness({ path: '/one-time-pass/', query: 'quantity=1', preview: (request, attempt) => attempt === 1 ? pricePreview(request) : new Promise((resolve, reject) => pending.push({ request, resolve, reject })) });
    await page.flush();
    page.elements.get('globalCountry').value = 'JP'; page.elements.get('globalCountry').fire('change'); await page.flush();
    page.elements.get('globalCountry').value = 'GB'; page.elements.get('globalCountry').fire('change'); await page.flush();
    assert.equal(pending.length, 2);
    pending[1].resolve(pricePreview(pending[1].request)); await page.flush();
    assert.equal(page.elements.get('globalTotal').textContent, '≈ £1');
    if (rejectOlder) pending[0].reject(new Error('old quote failed'));
    else pending[0].resolve(pricePreview(pending[0].request));
    await page.flush();
    assert.equal(page.elements.get('globalTotal').textContent, '≈ £1');
    assert.equal(page.elements.get('globalQuoteStatus').getAttribute('data-tone'), 'ok');
    assert.equal(page.elements.get('globalPay').disabled, false);
    page.elements.get('globalEmail').value = 'buyer@example.test'; page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
    assert.equal(page.checkouts[0].customer.address.countryCode, 'GB');
    assert.equal(page.checkouts[0].customData.display_currency, 'GBP');
  });
}

test('quantity typing is debounced and a late earlier quantity cannot restore its amount', async () => {
  let firstRequest, resolveFirst;
  const page = harness({ path: '/one-time-pass/', query: 'quantity=1', preview: (request, attempt) => {
    if (attempt !== 1) return pricePreview(request);
    firstRequest = request; return new Promise(resolve => { resolveFirst = resolve; });
  } }); await page.flush();
  page.elements.get('globalQuantity').value = '10'; page.elements.get('globalQuantity').fire('input');
  page.elements.get('globalQuantity').value = '100'; page.elements.get('globalQuantity').fire('input');
  assert.equal(page.timers.size, 1);
  assert.equal(page.elements.get('globalPay').disabled, true);
  await page.advance(249); assert.equal(page.previews.length, 1);
  await page.advance(1); assert.equal(page.previews.length, 2);
  assert.equal(page.previews[1].items[0].quantity, 100);
  assert.equal(page.elements.get('globalTotal').textContent, '≈ $139');
  resolveFirst(pricePreview(firstRequest)); await page.flush();
  assert.equal(page.elements.get('globalTotal').textContent, '≈ $139');
  page.elements.get('globalEmail').value = 'buyer@example.test'; page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
  assert.equal(page.checkouts[0].items[0].quantity, 100);
});

test('provider quantity bounds constrain typed values and budget quantities before checkout', async () => {
  const page = harness({ path: '/one-time-pass/', query: 'quantity=10', preview: request => pricePreview(request, { minimum: 2, maximum: 50 }) }); await page.flush();
  assert.equal(page.elements.get('globalQuantity').min, '2');
  assert.equal(page.elements.get('globalQuantity').max, '50');
  assert.match(page.elements.get('globalQuantityHelp').textContent, /2.*50/);
  page.elements.get('globalEmail').value = 'buyer@example.test';
  for (const value of ['1', '51']) {
    page.elements.get('globalQuantity').value = value; page.elements.get('globalQuantity').fire('input'); await page.advance(250);
    page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
    assert.equal(page.checkouts.length, 0);
    assert.equal(page.focused, page.elements.get('globalQuantity'));
    assert.equal(page.previews.length, 1);
  }
  page.elements.get('globalQuantity').value = '7'; page.elements.get('globalQuantity').fire('input'); await page.advance(250);
  const excessive = page.presets.find(button => button.getAttribute('data-budget') === '999');
  assert.equal(excessive.disabled, true);
  excessive.fire('click'); await page.flush();
  assert.equal(page.previews.length, 2);
  assert.equal(page.elements.get('globalQuantity').value, '7');
  const allowed = page.presets.find(button => button.getAttribute('data-budget') === '66');
  assert.equal(allowed.disabled, false);
  allowed.fire('click'); await page.flush();
  assert.equal(page.previews.at(-1).items[0].quantity, 7);
  page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
  assert.equal(page.checkouts[0].items[0].quantity, 7);
});

test('all paid plans use the exact configured and previewed price IDs at checkout', async () => {
  const page = harness(); await page.flush();
  const previewed = new Set(Array.from(page.previews[0].items, item => item.priceId));
  assert.deepEqual([...previewed].sort(), ['day-price', 'lifetime-price', 'pro-price']);
  page.elements.get('globalEmail').value = 'buyer@example.test';
  for (const [plan, expected] of [['pro', 'pro-price'], ['lifetime', 'lifetime-price']]) {
    page.buttons.find(button => button.getAttribute('data-plan') === plan).fire('click');
    page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
    const checkout = page.checkouts.at(-1);
    assert.equal(checkout.items[0].priceId, expected);
    assert.ok(previewed.has(checkout.items[0].priceId));
    assert.equal(checkout.customData.quoted_currency, 'CNY');
    page.initializations[0].eventCallback({ name: 'checkout.closed' });
  }
  assert.equal(page.checkouts.length, 2);
  const pass = harness({ path: '/one-time-pass/', query: 'quantity=1' }); await pass.flush();
  pass.elements.get('globalEmail').value = 'buyer@example.test'; pass.elements.get('globalCheckoutForm').fire('submit'); await pass.flush();
  assert.equal(pass.checkouts[0].items[0].priceId, 'day-price');
  assert.equal(pass.checkouts[0].items[0].priceId, pass.previews[0].items[0].priceId);
});

test('a provider quote for the wrong price ID cannot authorize checkout', async () => {
  const page = harness({ path: '/one-time-pass/', query: 'quantity=1', preview: request => {
    const response = pricePreview(request); response.data.details.lineItems[0].price.id = 'different-price'; return response;
  } }); await page.flush();
  assert.equal(page.elements.get('globalPay').disabled, true);
  assert.equal(page.elements.get('globalTotal').textContent, '—');
  page.elements.get('globalEmail').value = 'buyer@example.test'; page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
  assert.equal(page.checkouts.length, 0);
});

test('all 33 languages display their local reference currency without changing the CNY product quote', async () => {
  const currencies = { en:'USD', 'zh-CN':'CNY', 'zh-TW':'TWD', es:'EUR', fr:'EUR', de:'EUR', pt:'EUR', 'pt-BR':'BRL', it:'EUR', ja:'JPY', ko:'KRW', ar:'AED', ru:'RUB', hi:'INR', id:'IDR', tr:'TRY', vi:'VND', th:'THB', nl:'EUR', pl:'PLN', sv:'SEK', da:'DKK', no:'NOK', fi:'EUR', cs:'CZK', uk:'UAH', ro:'RON', hu:'HUF', el:'EUR', he:'ILS', bn:'BDT', ms:'MYR', tl:'PHP' };
  assert.equal(Object.keys(currencies).length, 33);
  for (const [lang, currency] of Object.entries(currencies)) {
    const page = harness({ lang, browserLanguages: [lang] }); await page.flush();
    assert.equal(page.document.documentElement.lang, lang);
    assert.equal(page.window.Vid2PPTLocale.currencyForLanguage(lang), currency);
    assert.equal(page.elements.get('globalQuoteStatus').textContent, currency, lang);
    const expected = formattedAmount(9.9 * exchangeRates.rates[currency], currency, lang);
    assert.equal(page.priceNodes.find(node => node.getAttribute('data-price-plan') === 'day_pass').textContent, (currency === 'CNY' ? '' : '≈ ') + expected, lang);
    assert.equal(page.previews[0].items.find(item => item.priceId === 'day-price').quantity, 1);
  }
});

test('switching a Chinese payment page to English changes reference currency while preserving the buyer country and quantity', async () => {
  const page = harness({ lang: 'zh-CN', path: '/one-time-pass/', query: 'country=CN&quantity=1000' }); await page.flush();
  assert.equal(page.elements.get('globalQuoteStatus').textContent, 'CNY');
  const select = page.elements.get('languageControl').children[0]; select.value = 'en'; select.fire('change');
  const target = new URL(page.navigations.at(-1));
  assert.equal(target.searchParams.get('lang'), 'en');
  assert.equal(target.searchParams.get('currency'), 'USD');
  assert.equal(target.searchParams.get('country'), 'CN');
  assert.equal(target.searchParams.get('quantity'), '1000');
  target.searchParams.delete('lang');
  const restored = harness({ lang: 'en', path: '/one-time-pass/', query: target.searchParams.toString() }); await restored.flush();
  assert.equal(restored.elements.get('globalGrandTotal').textContent, '≈ $1,386');
  assert.ok(restored.elements.get('globalChargeSummary').textContent.includes(formattedMinor(990000, 'CNY') + ' (CNY)'));
});

test('a Russian purchase link preserves RUB references when its default billing country is US', async () => {
  const page = harness({ lang: 'ru', path: '/one-time-pass/' }); await page.flush();
  assert.equal(page.elements.get('globalQuoteStatus').textContent, 'RUB');
  const share = new URL(page.window.location.href);
  assert.equal(share.searchParams.get('country'), 'US');
  assert.equal(share.searchParams.get('currency'), 'RUB');
  share.searchParams.delete('lang');
  const restored = harness({ lang: 'ru', path: share.pathname, query: share.searchParams.toString() }); await restored.flush();
  assert.equal(restored.elements.get('globalTotal').textContent, page.elements.get('globalTotal').textContent);
  assert.equal(restored.elements.get('globalQuoteStatus').textContent, 'RUB');
});

test('exchange-rate endpoint failure does not substitute a guessed local amount or allow payment', async () => {
  const page = harness({ path: '/one-time-pass/', query: 'quantity=1', rates: new Error('exchange rate service unavailable') }); await page.flush();
  assert.equal(page.elements.get('globalTotal').textContent, '—');
  assert.equal(page.elements.get('globalChargeSummary').textContent, '');
  assert.equal(page.elements.get('globalPay').disabled, true);
  page.elements.get('globalEmail').value = 'buyer@example.test'; page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
  assert.equal(page.checkouts.length, 0);
  assert.equal(page.elements.get('globalPay').disabled, true);
  assert.equal(page.previews.length, 2);
  assert.ok(page.previews.every(request => request.items[0].priceId === 'day-price'));
});

test('exchange-rate loading can retry after failure using the official feed', async () => {
  const page = harness({ path: '/one-time-pass/', query: 'quantity=1', rates: attempt => attempt === 1 ? new Error('temporary FX failure') : exchangeRates }); await page.flush();
  assert.equal(page.elements.get('globalPay').disabled, true);
  page.elements.get('globalRetryQuote').fire('click'); await page.flush();
  assert.equal(page.elements.get('globalTotal').textContent, '≈ $1');
  assert.equal(page.elements.get('globalPay').disabled, false);
  assert.equal(page.requests.filter(request => request.url === 'https://open.er-api.com/v6/latest/CNY').length, 2);
  assert.ok(page.storage.get('vid2ppt.exchangeRates'));
});

test('a changed live Paddle price replaces the old 9.9 reference instead of using a static fallback', async () => {
  const page = harness({ path: '/one-time-pass/', query: 'quantity=10&country=US', preview: request => pricePreview(request, { unitSubtotal: 2350 }) }); await page.flush();
  assert.equal(page.elements.get('globalUnitPrice').textContent, '≈ $3');
  assert.equal(page.elements.get('globalGrandTotal').textContent, '≈ $33');
  assert.ok(page.elements.get('globalChargeSummary').textContent.includes(formattedMinor(23500, 'CNY') + ' (CNY)'));
  page.elements.get('globalEmail').value = 'buyer@example.test'; page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
  assert.equal(page.checkouts[0].items[0].priceId, 'day-price');
  assert.equal(page.checkouts[0].items[0].quantity, 10);
  assert.equal(page.checkouts[0].customData.quoted_currency, 'CNY');
});

test('the welcome page offers one flag region menu with country and language choices without starting payment', async () => {
  const page = harness({ path: '/welcome/' }); await page.flush();
  const menu = page.elements.get('globalRegionMenu'), summary = page.elements.get('globalRegionSummary');
  const language = page.elements.get('siteLanguage'), country = page.elements.get('globalCountry');
  assert.ok(menu && summary && language && country);
  assert.equal(menu.tagName, 'DETAILS');
  assert.equal(summary.tagName, 'SUMMARY');
  assert.equal(page.elements.get('globalRegionFlag').textContent, '🇺🇸');
  assert.equal(language.children.length, 33);
  assert.equal(language.children.find(option => option.value === 'ja').textContent, '🇯🇵 日本語');
  assert.ok(country.children.find(option => option.getAttribute('value') === 'JP').textContent.includes('🇯🇵'));
  menu.open = true; country.value = 'JP'; country.fire('change');
  assert.equal(menu.open, false);
  assert.equal(page.elements.get('globalRegionFlag').textContent, '🇯🇵');
  assert.equal(page.elements.get('globalRegionLabel').textContent, 'English · JPY');
  assert.equal(page.window.location.searchParams.get('country'), 'JP');
  language.value = 'fr'; language.fire('change');
  const target = new URL(page.navigations.at(-1));
  assert.equal(target.pathname, '/welcome/');
  assert.equal(target.searchParams.get('lang'), 'fr');
  assert.equal(target.searchParams.get('country'), 'JP');
  assert.equal(page.previews.length, 0);
  assert.ok(page.requests.every(request => request.url.startsWith('/locales/')));
});

test('the region menu closes on Escape and outside click while retaining clicks inside', async () => {
  const page = harness({ path: '/welcome/' }); await page.flush();
  const menu = page.elements.get('globalRegionMenu'), summary = page.elements.get('globalRegionSummary');
  menu.open = true; page.fireDocument('click', { target: page.elements.get('globalCountry') });
  assert.equal(menu.open, true);
  menu.fire('keydown', { key: 'Escape' });
  assert.equal(menu.open, false);
  assert.equal(page.focused, summary);
  menu.open = true; page.fireDocument('click', { target: page.document.body });
  assert.equal(menu.open, false);
});

test('plus and minus change whole pass quantities with debounced quotes and select typed values on focus', async () => {
  const page = harness({ path: '/one-time-pass/', query: 'quantity=1' }); await page.flush();
  const input = page.elements.get('globalQuantity'), decrease = page.elements.get('globalQuantityDecrease'), increase = page.elements.get('globalQuantityIncrease');
  assert.equal(decrease.disabled, true);
  assert.equal(increase.disabled, false);
  input.focus(); assert.equal(input.wasSelected, true);
  assert.equal(input.selectionEnd, 1);
  increase.fire('click');
  assert.equal(input.value, '2');
  assert.equal(page.window.location.searchParams.get('quantity'), '2');
  assert.equal(page.elements.get('globalPay').disabled, true);
  assert.ok(page.presets.every(button => button.disabled));
  await page.advance(249); assert.equal(page.previews.length, 1);
  await page.advance(1); assert.equal(page.previews.at(-1).items[0].quantity, 2);
  assert.equal(page.elements.get('globalTotal').textContent, '≈ $3');
  decrease.fire('click'); await page.advance(250);
  assert.equal(input.value, '1');
  assert.equal(decrease.disabled, true);
  assert.equal(page.previews.at(-1).items[0].quantity, 1);
  input.value = '12'; input.fire('input'); await page.advance(250);
  increase.fire('click'); await page.advance(250);
  assert.equal(input.value, '13');
  assert.equal(page.previews.at(-1).items[0].quantity, 13);
});

test('the four RMB budget presets show actual payable amounts and select their quoted pass counts', async () => {
  const page = harness({ lang: 'zh-CN', path: '/one-time-pass/', query: 'country=CN' }); await page.flush();
  assert.equal(page.presets.length, 4);
  assert.deepEqual(page.presets.map(button => button.querySelector('.preset-code').textContent), ['A', 'B', 'C', 'D']);
  assert.deepEqual(page.presets.map(button => button.getAttribute('data-budget')), ['66', '178', '666', '999']);
  assert.equal(page.elements.has('globalShare'), false);
  assert.doesNotMatch(page.document.body.textContent, /Purchase link/);
  for (const [budget, count, total] of [[66, 7, 6930], [178, 18, 17820], [666, 68, 67320], [999, 101, 99990]]) {
    const button = page.presets.find(item => item.getAttribute('data-budget') === String(budget));
    assert.equal(button.getAttribute('data-quantity'), String(count));
    assert.ok(button.querySelector('.preset-budget').textContent.includes(String(budget)));
    assert.ok(button.querySelector('.preset-count').textContent.includes(String(count)));
    assert.equal(button.querySelector('.preset-total').textContent, formattedMinor(total, 'CNY', 'zh-CN'));
    assert.equal(button.disabled, false);
    button.fire('click');
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    assert.ok(page.presets.every(item => item === button || item.getAttribute('aria-pressed') === 'false'));
    assert.ok(page.presets.every(item => item.disabled));
    assert.equal(page.elements.get('globalQuantity').value, String(count));
    await page.flush();
    assert.equal(page.previews.at(-1).items[0].quantity, count);
    assert.equal(page.elements.get('globalGrandTotal').textContent, formattedMinor(total, 'CNY', 'zh-CN'));
    assert.equal(button.getAttribute('aria-pressed'), 'true');
  }
  page.elements.get('globalEmail').value = 'buyer@example.test'; page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
  assert.equal(page.checkouts[0].items[0].quantity, 101);
  assert.equal(page.checkouts[0].customData.quoted_currency, 'CNY');
});

test('an unparameterized pass page defaults to C and checks out its quoted 68 passes', async () => {
  const page = harness({ lang: 'zh-CN', path: '/one-time-pass/', query: 'country=CN' }); await page.flush();
  const selected = page.presets.find(button => button.getAttribute('aria-pressed') === 'true');
  assert.equal(selected.querySelector('.preset-code').textContent, 'C');
  assert.equal(selected.getAttribute('data-budget'), '666');
  assert.equal(page.elements.get('globalQuantity').value, '68');
  assert.equal(page.previews.at(-1).items[0].quantity, 68);
  assert.equal(page.elements.get('globalGrandTotal').textContent, '¥673');
  assert.ok(page.elements.get('globalChargeSummary').textContent.includes('¥673 (CNY)'));
  assert.equal(page.window.location.searchParams.get('quantity'), '68');
  page.elements.get('globalEmail').value = 'buyer@example.test'; page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
  assert.equal(page.checkouts[0].items[0].quantity, 68);
  assert.equal(page.checkouts[0].customData.pass_quantity, 68);
});

test('the default C count follows the first live unit price before it can authorize checkout', async () => {
  let initialRequest, resolveInitial;
  const page = harness({ lang: 'zh-CN', path: '/one-time-pass/', query: 'country=CN', preview: (request, attempt) => {
    if (attempt === 1) { initialRequest = request; return new Promise(resolve => { resolveInitial = resolve; }); }
    return pricePreview(request, { unitSubtotal: 2350 });
  } }); await page.flush();
  assert.equal(initialRequest.items[0].quantity, 68);
  assert.equal(page.elements.get('globalQuantity').value, '68');
  assert.equal(page.presets[2].getAttribute('aria-pressed'), 'true');
  assert.equal(page.elements.get('globalPay').disabled, true);
  resolveInitial(pricePreview(initialRequest, { unitSubtotal: 2350 })); await page.flush();
  assert.equal(page.elements.get('globalQuantity').value, '29');
  assert.equal(page.previews.at(-1).items[0].quantity, 29);
  assert.equal(page.presets[2].getAttribute('data-quantity'), '29');
  assert.equal(page.presets[2].getAttribute('aria-pressed'), 'true');
  assert.equal(page.elements.get('globalGrandTotal').textContent, '¥682');
  assert.equal(page.elements.get('globalPay').disabled, false);
  assert.equal(page.window.location.searchParams.get('quantity'), '29');
  page.elements.get('globalEmail').value = 'buyer@example.test'; page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
  assert.equal(page.checkouts[0].items[0].quantity, 29);
});

test('a buyer quantity entered during the initial quote prevents default C from replacing it', async () => {
  let initialRequest, resolveInitial;
  const page = harness({ lang: 'zh-CN', path: '/one-time-pass/', query: 'country=CN', preview: (request, attempt) => {
    if (attempt === 1) { initialRequest = request; return new Promise(resolve => { resolveInitial = resolve; }); }
    return pricePreview(request, { unitSubtotal: 2350 });
  } }); await page.flush();
  const input = page.elements.get('globalQuantity'); input.value = '10'; input.fire('input'); await page.advance(250);
  assert.equal(page.previews.at(-1).items[0].quantity, 10);
  assert.equal(input.value, '10');
  assert.equal(page.elements.get('globalGrandTotal').textContent, '¥235');
  resolveInitial(pricePreview(initialRequest)); await page.flush();
  assert.equal(input.value, '10');
  assert.equal(page.elements.get('globalGrandTotal').textContent, '¥235');
  assert.ok(page.presets.every(button => button.getAttribute('aria-pressed') === 'false'));
});

test('explicit purchase quantities remain authoritative when the live price changes', async () => {
  for (const count of [1, 7, 68]) {
    const page = harness({ lang: 'zh-CN', path: '/one-time-pass/', query: `country=CN&quantity=${count}`, preview: request => pricePreview(request, { unitSubtotal: 2350 }) }); await page.flush();
    assert.equal(page.elements.get('globalQuantity').value, String(count));
    assert.equal(page.previews.at(-1).items[0].quantity, count);
    assert.equal(page.previews.length, 1);
    assert.equal(page.presets[2].getAttribute('data-quantity'), '29');
    assert.equal(page.presets[2].getAttribute('aria-pressed'), 'false');
    assert.equal(page.window.location.searchParams.get('quantity'), String(count));
  }
  for (const value of ['', '0', '1.5']) {
    const page = harness({ path: '/one-time-pass/', query: `quantity=${value}` }); await page.flush();
    assert.equal(page.elements.get('globalQuantity').value, value);
    assert.equal(page.elements.get('globalPay').disabled, true);
    assert.equal(page.previews.length, 0);
  }
});

test('integer prices preserve zero, two and three currency minor-unit precisions', async () => {
  const rates = { ...exchangeRates, rates: { ...exchangeRates.rates, BHD: 0.05 } };
  for (const [currency, country, unitSubtotal, unitMajor, totalMajor, referenceUnit, referenceTotal] of [
    ['JPY', 'JP', 210, 210, 2100, 1, 14],
    ['CNY', 'CN', 325, 3, 33, 0, 5],
    ['BHD', 'BH', 1634, 2, 16, 5, 46]
  ]) {
    const preview = request => pricePreview(request, { currency, unitSubtotal });
    const actual = harness({ path: '/one-time-pass/', query: `country=${country}&currency=${currency}&quantity=10`, preview, rates }); await actual.flush();
    assert.equal(actual.elements.get('globalUnitPrice').textContent, formattedAmount(unitMajor, currency), `${currency} unit`);
    assert.equal(actual.elements.get('globalGrandTotal').textContent, formattedAmount(totalMajor, currency), `${currency} total`);
    assert.ok(actual.elements.get('globalChargeSummary').textContent.includes(formattedAmount(totalMajor, currency) + ` (${currency})`), `${currency} actual charge`);
    const reference = harness({ path: '/one-time-pass/', query: `country=${country}&currency=USD&quantity=10`, preview, rates }); await reference.flush();
    assert.equal(reference.elements.get('globalUnitPrice').textContent, '≈ ' + formattedAmount(referenceUnit, 'USD'), `${currency} converted unit`);
    assert.equal(reference.elements.get('globalGrandTotal').textContent, '≈ ' + formattedAmount(referenceTotal, 'USD'), `${currency} converted total`);
    assert.ok(reference.elements.get('globalChargeSummary').textContent.includes(formattedAmount(totalMajor, currency) + ` (${currency})`), `${currency} retained actual charge`);
    reference.elements.get('globalEmail').value = 'buyer@example.test'; reference.elements.get('globalCheckoutForm').fire('submit'); await reference.flush();
    assert.equal(reference.checkouts[0].items[0].quantity, 10, `${currency} unchanged count`);
    assert.equal(reference.checkouts[0].customData.quoted_currency, currency, `${currency} unchanged quote currency`);
  }
});

test('budget counts recalculate from the live Paddle price and honor the new actual amounts', async () => {
  const page = harness({ lang: 'zh-CN', path: '/one-time-pass/', query: 'country=CN', preview: request => pricePreview(request, { unitSubtotal: 2350 }) }); await page.flush();
  for (const [budget, count, total] of [[66, 3, 7050], [178, 8, 18800], [666, 29, 68150], [999, 43, 101050]]) {
    const button = page.presets.find(item => item.getAttribute('data-budget') === String(budget));
    assert.equal(button.getAttribute('data-quantity'), String(count));
    assert.equal(button.querySelector('.preset-total').textContent, formattedMinor(total, 'CNY', 'zh-CN'));
  }
  page.presets[0].fire('click'); await page.flush();
  assert.equal(page.previews.at(-1).items[0].quantity, 3);
  assert.equal(page.elements.get('globalTotal').textContent, formattedMinor(7050, 'CNY', 'zh-CN'));
});

test('budget quantities convert a foreign provider unit price back to RMB before rounding up', async () => {
  const page = harness({ lang: 'en', path: '/one-time-pass/', query: 'country=US', preview: request => pricePreview(request, { currency: 'USD', unitSubtotal: 140 }) }); await page.flush();
  for (const [budget, count, total] of [[66, 7, 980], [178, 18, 2520], [666, 67, 9380], [999, 100, 14000]]) {
    const button = page.presets.find(item => item.getAttribute('data-budget') === String(budget));
    assert.equal(button.getAttribute('data-quantity'), String(count));
    assert.equal(button.querySelector('.preset-total').textContent, formattedMinor(total, 'USD'));
  }
});

test('typed quantities update preset pressed states immediately and payment locks all quantity and region controls', async () => {
  const page = harness({ path: '/one-time-pass/', query: 'quantity=1' }); await page.flush();
  const input = page.elements.get('globalQuantity');
  input.value = '18'; input.fire('input');
  assert.equal(page.presets.find(button => button.getAttribute('data-budget') === '178').getAttribute('aria-pressed'), 'true');
  assert.ok(page.presets.every(button => button.disabled));
  await page.advance(250);
  input.value = '19'; input.fire('input');
  assert.ok(page.presets.every(button => button.getAttribute('aria-pressed') === 'false'));
  await page.advance(250);
  page.elements.get('globalEmail').value = 'buyer@example.test'; page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
  assert.equal(page.checkouts[0].items[0].quantity, 19);
  for (const id of ['globalQuantityDecrease', 'globalQuantityIncrease', 'globalQuantity', 'globalCountry', 'siteLanguage']) assert.equal(page.elements.get(id).disabled, true, id);
  assert.ok(page.presets.every(button => button.disabled));
  page.presets[0].fire('click'); page.elements.get('globalQuantityIncrease').fire('click'); await page.advance(250);
  assert.equal(input.value, '19');
  page.initializations[0].eventCallback({ name: 'checkout.closed' });
  for (const id of ['globalQuantityDecrease', 'globalQuantityIncrease', 'globalQuantity', 'globalCountry', 'siteLanguage']) assert.equal(page.elements.get(id).disabled, false, id);
});

test('budget presets remain disabled until the first live price response arrives', async () => {
  let request, resolveQuote;
  const page = harness({ path: '/one-time-pass/', query: 'quantity=1', preview: options => { request = options; return new Promise(resolve => { resolveQuote = resolve; }); } }); await page.flush();
  assert.ok(page.presets.every(button => button.disabled));
  assert.ok(page.presets.every(button => button.querySelector('.preset-total').textContent === '—'));
  page.presets[0].fire('click');
  assert.equal(page.elements.get('globalQuantity').value, '1');
  resolveQuote(pricePreview(request)); await page.flush();
  assert.ok(page.presets.every(button => !button.disabled));
  assert.equal(page.presets[0].getAttribute('data-quantity'), '7');
  assert.equal(page.presets[0].querySelector('.preset-total').textContent, '≈ $10');
});

test('quantity steps recover an out-of-range or empty input without sending invalid counts', async () => {
  const page = harness({ path: '/one-time-pass/', query: 'quantity=1' }); await page.flush();
  const input = page.elements.get('globalQuantity'), decrease = page.elements.get('globalQuantityDecrease'), increase = page.elements.get('globalQuantityIncrease');
  input.value = '1000000'; input.fire('input');
  assert.equal(decrease.disabled, false);
  assert.equal(increase.disabled, true);
  decrease.fire('click');
  assert.equal(input.value, '999999');
  await page.advance(250);
  assert.equal(page.previews.at(-1).items[0].quantity, 999999);
  assert.equal(page.elements.get('globalPay').disabled, false);
  input.value = ''; input.fire('input');
  assert.equal(decrease.disabled, true);
  assert.equal(increase.disabled, false);
  increase.fire('click'); await page.advance(250);
  assert.equal(input.value, '1');
  assert.equal(page.previews.at(-1).items[0].quantity, 1);
  assert.ok(page.previews.every(request => request.items[0].quantity >= 1 && request.items[0].quantity <= 999999));
});

test('an authoritative CNY Paddle quote remains payable when exchange-rate loading fails', async () => {
  const page = harness({ lang: 'zh-CN', path: '/one-time-pass/', query: 'country=CN&quantity=7', rates: new Error('exchange rate service unavailable') }); await page.flush();
  assert.equal(page.elements.get('globalGrandTotal').textContent, formattedMinor(6930, 'CNY', 'zh-CN'));
  assert.equal(page.elements.get('globalQuoteStatus').textContent, 'CNY');
  assert.equal(page.elements.get('globalRateDate').textContent, '');
  assert.equal(page.elements.get('globalPay').disabled, false);
  assert.equal(page.presets[0].getAttribute('data-quantity'), '7');
  assert.equal(page.presets[0].disabled, false);
  page.elements.get('globalEmail').value = 'buyer@example.test'; page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
  assert.equal(page.checkouts.length, 1);
  assert.equal(page.checkouts[0].items[0].quantity, 7);
  assert.equal(page.checkouts[0].customData.quoted_currency, 'CNY');
});

test('marketing links retain the selected country and currency through welcome, pricing and the pass entry', async () => {
  const welcome = harness({ path: '/welcome/', query: 'country=BR&currency=BRL' }); await welcome.flush();
  const pricingLinks = welcome.document.querySelectorAll('a').filter(link => new URL(link.href).pathname === '/pricing/');
  assert.ok(pricingLinks.length >= 2);
  for (const link of pricingLinks) {
    const target = new URL(link.href);
    assert.equal(target.searchParams.get('lang'), 'en');
    assert.equal(target.searchParams.get('country'), 'BR');
    assert.equal(target.searchParams.get('currency'), 'BRL');
  }
  const target = new URL(pricingLinks[0].href); target.searchParams.delete('lang');
  const pricing = harness({ path: target.pathname, query: target.searchParams.toString() }); await pricing.flush();
  const passLink = pricing.document.querySelectorAll('a').find(link => new URL(link.href).pathname === '/one-time-pass/');
  assert.ok(passLink);
  const passTarget = new URL(passLink.href);
  assert.equal(passTarget.searchParams.get('country'), 'BR');
  assert.equal(passTarget.searchParams.get('currency'), 'BRL');
  passTarget.searchParams.delete('lang');
  const pass = harness({ path: passTarget.pathname, query: passTarget.searchParams.toString() }); await pass.flush();
  assert.equal(pass.elements.get('globalCountry').value, 'BR');
  assert.equal(pass.elements.get('globalQuoteStatus').textContent, 'BRL');
});

test('changing country rewrites existing marketing links before navigation to pricing and the pass entry', async () => {
  const welcome = harness({ path: '/welcome/' }); await welcome.flush();
  const pricingLinks = welcome.document.querySelectorAll('a[href]').filter(link => new URL(link.href).pathname === '/pricing/');
  const originalLink = new URL(pricingLinks[0].href);
  originalLink.searchParams.set('campaign', 'region-check'); originalLink.hash = '#plans';
  pricingLinks[0].href = originalLink.toString();
  const country = welcome.elements.get('globalCountry'); country.value = 'BR'; country.fire('change');
  for (const link of pricingLinks) {
    const target = new URL(link.href);
    assert.equal(target.searchParams.get('country'), 'BR');
    assert.equal(target.searchParams.get('currency'), 'BRL');
    assert.equal(target.searchParams.get('lang'), 'en');
  }
  const target = new URL(pricingLinks[0].href);
  assert.equal(target.searchParams.get('campaign'), 'region-check');
  assert.equal(target.hash, '#plans');
  const startLink = welcome.document.querySelectorAll('a[href]').find(link => new URL(link.href).hash === '#start');
  assert.equal(new URL(startLink.href).searchParams.get('country'), 'BR');
  assert.equal(new URL(startLink.href).hash, '#start');
  target.searchParams.delete('lang');
  const pricing = harness({ path: target.pathname, query: target.searchParams.toString() }); await pricing.flush();
  const passLink = pricing.document.querySelectorAll('a[href]').find(link => new URL(link.href).pathname === '/one-time-pass/');
  assert.equal(new URL(passLink.href).searchParams.get('country'), 'BR');
  const pricingCountry = pricing.elements.get('globalCountry'); pricingCountry.value = 'JP'; pricingCountry.fire('change'); await pricing.flush();
  const passTarget = new URL(passLink.href);
  assert.equal(passTarget.searchParams.get('country'), 'JP');
  assert.equal(passTarget.searchParams.get('currency'), 'JPY');
  assert.equal(passTarget.searchParams.get('lang'), 'en');
  passTarget.searchParams.delete('lang');
  const pass = harness({ path: passTarget.pathname, query: passTarget.searchParams.toString() }); await pass.flush();
  assert.equal(pass.elements.get('globalCountry').value, 'JP');
  assert.equal(pass.elements.get('globalQuoteStatus').textContent, 'JPY');
  assert.equal(pass.previews[0].address.countryCode, 'JP');
});

test('a zero provider unit price disables budget presets without rendering infinite quantities', async () => {
  const page = harness({ path: '/one-time-pass/', query: 'quantity=1', preview: request => pricePreview(request, { unitSubtotal: 0 }) }); await page.flush();
  assert.equal(page.elements.get('globalGrandTotal').textContent, '≈ $0');
  assert.ok(page.presets.every(button => button.disabled && button.getAttribute('data-quantity') === '0'));
  assert.doesNotMatch(page.document.body.textContent, /Infinity|∞|NaN/);
  page.presets[0].fire('click'); await page.flush();
  assert.equal(page.elements.get('globalQuantity').value, '1');
  assert.equal(page.previews.length, 1);
});

test('English and Chinese pages keep payment implementation out of visible copy while retaining actual charges and checkout data', async () => {
  for (const lang of ['en', 'zh-CN']) {
    for (const path of ['/welcome/', '/pricing/', '/one-time-pass/']) {
      const pass = path === '/one-time-pass/';
      const page = harness({ lang, path, query: pass ? 'quantity=10' : '' }); await page.flush();
      assert.doesNotMatch(page.document.body.textContent, /Paddle|webhook|付款回调|支付回调/i, `${lang} ${path}`);
      assert.equal(page.document.querySelector('.payment-trust'), null);
      if (path === '/welcome/') continue;
      if (pass) {
        assert.deepEqual(page.presets.map(button => button.querySelector('.preset-code').textContent), ['A', 'B', 'C', 'D']);
        assert.deepEqual(page.presets.map(button => button.getAttribute('data-budget')), ['66', '178', '666', '999']);
      }
      if (!pass) page.buttons.find(button => button.getAttribute('data-plan') === 'pro').fire('click');
      const expected = formattedMinor(pass ? 9900 : 3900, 'CNY', lang) + ' (CNY)';
      assert.ok(page.elements.get('globalChargeSummary').textContent.includes(expected), `${lang} ${path} actual charge`);
      assert.equal(page.elements.get('globalQuoteStatus').textContent, lang === 'en' ? 'USD' : 'CNY');
      page.elements.get('globalEmail').value = 'buyer@example.test'; page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
      assert.equal(page.initializations.length, 1);
      assert.equal(page.checkouts.length, 1);
      assert.equal(page.checkouts[0].items[0].priceId, pass ? 'day-price' : 'pro-price');
      assert.equal(page.checkouts[0].customData.quoted_currency, 'CNY');
      assert.equal(page.checkouts[0].customData.site_locale, lang);
      page.initializations[0].eventCallback({ name: 'checkout.completed' }); await page.flush();
      assert.ok(page.elements.get('globalPaymentStatus').textContent);
      assert.doesNotMatch(page.document.body.textContent, /Paddle|webhook|付款回调|支付回调/i, `${lang} ${path} completed`);
    }
  }
});
