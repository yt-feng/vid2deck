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

function formattedMinor(amount, currency, lang = 'en') {
  const formatter = new Intl.NumberFormat(lang, { style: 'currency', currency });
  return formatter.format(Number(amount) / 10 ** formatter.resolvedOptions().maximumFractionDigits);
}

const exchangeRates = { result: 'success', base_code: 'CNY', time_last_update_utc: 'Sat, 03 Oct 2026 00:02:32 +0000', time_last_update_unix: Math.floor(Date.now() / 1000) - 60, rates: { CNY: 1, USD: 0.14, EUR: 0.13, JPY: 21, INR: 12, BRL: 0.8, GBP: 0.11, CAD: 0.19, AUD: 0.2, TWD: 4.5, AED: 0.51, KRW: 193, IDR: 2300, TRY: 6, VND: 3500, THB: 4.7, PLN: 0.6, SEK: 1.5, DKK: 1, NOK: 1.5, CZK: 3.4, UAH: 5.8, RON: 0.65, HUF: 53, ILS: 0.5, BDT: 17, MYR: 0.6, PHP: 8, RUB: 12 } };

function harness({ lang = 'en', path = '/pricing/', query = '', browserLanguages = ['en-US'], savedLanguage = '', savedCountry = '', signedIn = false, missingTranslation = false, failConfigOnce = false, preview = pricePreview, rates = exchangeRates } = {}) {
  const elements = new Map(), buttons = [], cards = [], priceNodes = [], presets = [], requests = [], checkouts = [], initializations = [], previews = [], historyChanges = [], navigations = [];
  const timers = new Map();
  let nextTimer = 1, now = 0, focused = null, bodyHtml = '';
  class Element {
    constructor(attrs = {}) {
      this.attrs = attrs; this.events = {}; this.children = []; this.value = attrs.value || '';
      this.textContent = ''; this.disabled = 'disabled' in attrs;
      this.min = attrs.min; this.max = attrs.max;
      this.classList = { toggle() {} };
    }
    addEventListener(type, callback) { (this.events[type] ||= []).push(callback); }
    fire(type) { for (const callback of this.events[type] || []) callback.call(this, { preventDefault() {} }); }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    getAttribute(name) { return this.attrs[name] ?? null; }
    removeAttribute(name) { delete this.attrs[name]; }
    appendChild(child) { this.children.push(child); }
    remove() { this.removed = true; }
    focus() { focused = this; }
    scrollIntoView() {}
  }
  function attrs(value) { return Object.fromEntries([...value.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(match => [match[1], match[2] ?? ''])); }
  const body = new Element();
  Object.defineProperty(body, 'innerHTML', { get: () => bodyHtml, set(html) {
    bodyHtml = html;
    elements.clear(); buttons.length = 0; cards.length = 0; priceNodes.length = 0; presets.length = 0;
    for (const match of html.matchAll(/<[\w-]+\b[^>]*>/g)) {
      const attributes = attrs(match[0]); const element = new Element(attributes);
      if (attributes.id) elements.set(attributes.id, element);
      if (attributes.class?.split(' ').includes('plan-button')) buttons.push(element);
      if (attributes.class?.split(' ').includes('quantity-preset')) presets.push(element);
      if ('data-card-plan' in attributes) cards.push(element);
      if ('data-price-plan' in attributes) priceNodes.push(element);
    }
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
  const document = { body, documentElement: new Element(), title: '', head: new Element(),
    createElement: () => new Element(), getElementById: id => elements.get(id),
    querySelector: () => new Element(),
    querySelectorAll: selector => ({ '.plan-button': buttons, '[data-card-plan]': cards, '[data-price-plan]': priceNodes, '.quantity-preset': presets })[selector] || []
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
    fireWindow(type, event) { for (const callback of windowEvents[type] || []) callback(event); }
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
  const page = harness({ lang: 'en', path: '/one-time-pass/' }); await page.flush();
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
  assert.equal(page.elements.get('globalUnitPrice').textContent, '≈ $1.39');
  assert.equal(page.elements.get('globalTotal').textContent, '≈ $13.86');
  assert.equal(page.elements.get('globalTax').textContent, '≈ $0.00');
  assert.equal(page.elements.get('globalGrandTotal').textContent, '≈ $13.86');
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
  assert.equal(page.elements.get('globalUnitPrice').textContent, '≈ $0.49');
  assert.equal(page.elements.get('globalTotal').textContent, '≈ $4.55');
  assert.equal(page.elements.get('globalTax').textContent, '≈ $0.39');
  assert.equal(page.elements.get('globalGrandTotal').textContent, '≈ $4.94');
  assert.ok(page.elements.get('globalChargeSummary').textContent.includes(formattedMinor(3526, 'CNY') + ' (CNY)'));
});

test('JPY reference amounts use zero decimal places and retain the original CNY charge', async () => {
  const page = harness({ lang: 'ja', path: '/one-time-pass/', query: 'country=JP' }); await page.flush();
  assert.equal(page.elements.get('globalTotal').textContent, '≈ ' + new Intl.NumberFormat('ja', { style: 'currency', currency: 'JPY' }).format(208));
  assert.ok(page.elements.get('globalChargeSummary').textContent.includes(formattedMinor(990, 'CNY', 'ja') + ' (CNY)'));
  page.elements.get('globalEmail').value = 'buyer@example.test'; page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
  assert.equal(page.checkouts[0].customData.quoted_currency, 'CNY');
  assert.equal(page.checkouts[0].customData.display_currency, 'JPY');
});

test('an actual JPY provider quote is neither divided by 100 nor labeled as an estimate', async () => {
  const page = harness({ lang: 'ja', path: '/one-time-pass/', query: 'country=JP', preview: request => pricePreview(request, { currency: 'JPY', unitSubtotal: 210 }) }); await page.flush();
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

test('shared purchase links restore 1000 passes and buyers can change the quantity before paying', async () => {
  const page = harness({ lang: 'en', path: '/one-time-pass/', query: 'country=BR&quantity=1000' }); await page.flush();
  assert.equal(page.elements.get('globalQuantity').value, '1000');
  assert.equal(page.previews[0].items[0].quantity, 1000);
  assert.equal(page.elements.get('globalTotal').textContent, '≈ ' + new Intl.NumberFormat('en', { style: 'currency', currency: 'BRL' }).format(7920));
  const share = new URL(page.elements.get('globalShare').value);
  assert.equal(share.pathname, '/one-time-pass/');
  assert.equal(share.searchParams.get('lang'), 'en');
  assert.equal(share.searchParams.get('country'), 'BR');
  assert.equal(share.searchParams.get('quantity'), '1000');
  assert.equal(share.searchParams.get('currency'), 'BRL');
  page.elements.get('globalQuantity').value = '10'; page.elements.get('globalQuantity').fire('input'); await page.advance(250);
  assert.equal(new URL(page.elements.get('globalShare').value).searchParams.get('quantity'), '10');
  page.presets.find(button => button.getAttribute('data-quantity') === '1000').fire('click'); await page.flush();
  assert.equal(page.previews.at(-1).items[0].quantity, 1000);
  page.elements.get('globalEmail').value = 'buyer@example.test'; page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
  assert.equal(page.checkouts[0].items[0].quantity, 1000);
  assert.equal(page.checkouts[0].customData.pass_quantity, 1000);
  assert.equal(page.checkouts[0].customData.quoted_currency, 'CNY');
});

test('a failed quote clears prices and explicit reload restores payment without duplicate initialization', async () => {
  const page = harness({ path: '/one-time-pass/', preview: (request, attempt) => {
    if (attempt === 1) throw new Error('preview unavailable');
    return pricePreview(request);
  } }); await page.flush();
  assert.equal(page.elements.get('globalPay').disabled, true);
  assert.equal(page.elements.get('globalTotal').textContent, '—');
  assert.equal(page.elements.get('globalQuoteStatus').getAttribute('data-tone'), 'error');
  page.elements.get('globalRetryQuote').fire('click'); await page.flush();
  assert.equal(page.elements.get('globalPay').disabled, false);
  assert.equal(page.elements.get('globalTotal').textContent, '≈ $1.39');
  assert.equal(page.previews.length, 2);
  assert.equal(page.initializations.length, 1);
  assert.equal(page.requests.filter(request => request.url === '/api/paddle-config').length, 1);
  page.elements.get('globalEmail').value = 'buyer@example.test'; page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
  assert.equal(page.checkouts.length, 1);
});

test('a persistently failed preview cannot open checkout or retain a former quote', async () => {
  let fail = false;
  const page = harness({ path: '/one-time-pass/', preview: request => {
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
    const page = harness({ path: '/one-time-pass/', preview: (request, attempt) => attempt === 1 ? pricePreview(request) : new Promise((resolve, reject) => pending.push({ request, resolve, reject })) });
    await page.flush();
    page.elements.get('globalCountry').value = 'JP'; page.elements.get('globalCountry').fire('change'); await page.flush();
    page.elements.get('globalCountry').value = 'GB'; page.elements.get('globalCountry').fire('change'); await page.flush();
    assert.equal(pending.length, 2);
    pending[1].resolve(pricePreview(pending[1].request)); await page.flush();
    assert.equal(page.elements.get('globalTotal').textContent, '≈ £1.09');
    if (rejectOlder) pending[0].reject(new Error('old quote failed'));
    else pending[0].resolve(pricePreview(pending[0].request));
    await page.flush();
    assert.equal(page.elements.get('globalTotal').textContent, '≈ £1.09');
    assert.equal(page.elements.get('globalQuoteStatus').getAttribute('data-tone'), 'ok');
    assert.equal(page.elements.get('globalPay').disabled, false);
    page.elements.get('globalEmail').value = 'buyer@example.test'; page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
    assert.equal(page.checkouts[0].customer.address.countryCode, 'GB');
    assert.equal(page.checkouts[0].customData.display_currency, 'GBP');
  });
}

test('quantity typing is debounced and a late earlier quantity cannot restore its amount', async () => {
  let firstRequest, resolveFirst;
  const page = harness({ path: '/one-time-pass/', preview: (request, attempt) => {
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
  assert.equal(page.elements.get('globalTotal').textContent, '≈ $138.60');
  resolveFirst(pricePreview(firstRequest)); await page.flush();
  assert.equal(page.elements.get('globalTotal').textContent, '≈ $138.60');
  page.elements.get('globalEmail').value = 'buyer@example.test'; page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
  assert.equal(page.checkouts[0].items[0].quantity, 100);
});

test('provider quantity bounds constrain typed values and quick quantities before checkout', async () => {
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
  page.presets.find(button => button.getAttribute('data-quantity') === '1000').fire('click'); await page.flush();
  assert.equal(page.previews.length, 1);
  assert.equal(page.elements.get('globalPay').disabled, true);
  page.presets.find(button => button.getAttribute('data-quantity') === '10').fire('click'); await page.flush();
  assert.equal(page.previews.at(-1).items[0].quantity, 10);
  page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
  assert.equal(page.checkouts[0].items[0].quantity, 10);
});

test('all paid plans use the exact configured and previewed price IDs at checkout', async () => {
  const page = harness(); await page.flush();
  const previewed = new Set(Array.from(page.previews[0].items, item => item.priceId));
  assert.deepEqual([...previewed].sort(), ['day-price', 'lifetime-price', 'pro-price']);
  page.elements.get('globalEmail').value = 'buyer@example.test';
  for (const [plan, expected] of [['pro', 'pro-price'], ['lifetime', 'lifetime-price'], ['day_pass', 'day-price']]) {
    page.buttons.find(button => button.getAttribute('data-plan') === plan).fire('click');
    page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
    const checkout = page.checkouts.at(-1);
    assert.equal(checkout.items[0].priceId, expected);
    assert.ok(previewed.has(checkout.items[0].priceId));
    assert.equal(checkout.customData.quoted_currency, 'CNY');
    page.initializations[0].eventCallback({ name: 'checkout.closed' });
  }
  assert.equal(page.checkouts.length, 3);
});

test('a provider quote for the wrong price ID cannot authorize checkout', async () => {
  const page = harness({ path: '/one-time-pass/', preview: request => {
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
    const expected = new Intl.NumberFormat(lang, { style: 'currency', currency }).format(9.9 * exchangeRates.rates[currency]);
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
  assert.equal(restored.elements.get('globalGrandTotal').textContent, '≈ $1,386.00');
  assert.ok(restored.elements.get('globalChargeSummary').textContent.includes(formattedMinor(990000, 'CNY') + ' (CNY)'));
});

test('a Russian purchase link preserves RUB references when its default billing country is US', async () => {
  const page = harness({ lang: 'ru', path: '/one-time-pass/' }); await page.flush();
  assert.equal(page.elements.get('globalQuoteStatus').textContent, 'RUB');
  const share = new URL(page.elements.get('globalShare').value);
  assert.equal(share.searchParams.get('country'), 'US');
  assert.equal(share.searchParams.get('currency'), 'RUB');
  share.searchParams.delete('lang');
  const restored = harness({ lang: 'ru', path: share.pathname, query: share.searchParams.toString() }); await restored.flush();
  assert.equal(restored.elements.get('globalTotal').textContent, page.elements.get('globalTotal').textContent);
  assert.equal(restored.elements.get('globalQuoteStatus').textContent, 'RUB');
});

test('exchange-rate endpoint failure does not substitute a guessed local amount or allow payment', async () => {
  const page = harness({ path: '/one-time-pass/', rates: new Error('exchange rate service unavailable') }); await page.flush();
  assert.equal(page.elements.get('globalTotal').textContent, '—');
  assert.equal(page.elements.get('globalChargeSummary').textContent, '');
  assert.equal(page.elements.get('globalPay').disabled, true);
  page.elements.get('globalEmail').value = 'buyer@example.test'; page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
  assert.equal(page.checkouts.length, 0);
  assert.equal(page.elements.get('globalPay').disabled, true);
  assert.equal(page.previews.length, 0);
});

test('exchange-rate loading can retry after failure using the official feed', async () => {
  const page = harness({ path: '/one-time-pass/', rates: attempt => attempt === 1 ? new Error('temporary FX failure') : exchangeRates }); await page.flush();
  assert.equal(page.elements.get('globalPay').disabled, true);
  page.elements.get('globalRetryQuote').fire('click'); await page.flush();
  assert.equal(page.elements.get('globalTotal').textContent, '≈ $1.39');
  assert.equal(page.elements.get('globalPay').disabled, false);
  assert.equal(page.requests.filter(request => request.url === 'https://open.er-api.com/v6/latest/CNY').length, 2);
  assert.ok(page.storage.get('vid2ppt.exchangeRates'));
});

test('a changed live Paddle price replaces the old 9.9 reference instead of using a static fallback', async () => {
  const page = harness({ path: '/one-time-pass/', query: 'quantity=10&country=US', preview: request => pricePreview(request, { unitSubtotal: 2350 }) }); await page.flush();
  assert.equal(page.elements.get('globalUnitPrice').textContent, '≈ $3.29');
  assert.equal(page.elements.get('globalGrandTotal').textContent, '≈ $32.90');
  assert.ok(page.elements.get('globalChargeSummary').textContent.includes(formattedMinor(23500, 'CNY') + ' (CNY)'));
  page.elements.get('globalEmail').value = 'buyer@example.test'; page.elements.get('globalCheckoutForm').fire('submit'); await page.flush();
  assert.equal(page.checkouts[0].items[0].priceId, 'day-price');
  assert.equal(page.checkouts[0].items[0].quantity, 10);
  assert.equal(page.checkouts[0].customData.quoted_currency, 'CNY');
});
