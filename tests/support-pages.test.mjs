import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';

// Run the real public-page scripts with isolated browser and payment boundaries.
// No credentials, remote requests, checkout windows, or payments are created.
function pageHarness(page, { signedIn = false, failConfigOnce = false, storageUnavailable = false } = {}) {
  const html = readFileSync(new URL(`../public/${page}/index.html`, import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  let focused = null;
  class Element {
    constructor(attributes = {}) {
      this.attributes = attributes;
      this.events = {};
      this.value = '';
      this.textContent = '';
      this.disabled = 'disabled' in attributes;
      this.hidden = 'hidden' in attributes;
      this.classList = { toggle() {} };
    }
    addEventListener(type, callback) { (this.events[type] ||= []).push(callback); }
    fire(type) { for (const callback of this.events[type] || []) callback({ preventDefault() {} }); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    focus() { focused = this; }
    scrollIntoView() {}
    querySelector() { return null; }
    closest(selector) { return selector === '.service-card' ? null : new Element(); }
  }
  function attrs(tag) {
    return Object.fromEntries([...tag.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(match => [match[1], match[2] ?? '']));
  }
  for (const match of html.matchAll(/<[\w-]+\b[^>]*\bid="[^"]+"[^>]*>/g)) {
    const attributes = attrs(match[0]);
    elements.set(attributes.id, new Element(attributes));
  }
  const buttonClass = page === 'pricing' ? 'checkout-btn' : 'buy-btn';
  const buttons = [...html.matchAll(/<button\b([^>]+)>/g)]
    .filter(match => attrs(match[1]).class?.split(' ').includes(buttonClass))
    .map(match => new Element(attrs(match[1])));
  const saved = new Map();
  if (signedIn) saved.set('vid2deck.auth.session', JSON.stringify({ token: 'test-token', user: { username: 'test-user', email: 'account@example.test' } }));
  const storage = {
    getItem(key) { if (storageUnavailable) throw new Error('storage disabled'); return saved.get(key) ?? null; },
    setItem(key, value) { if (storageUnavailable) throw new Error('storage disabled'); saved.set(key, value); }
  };
  const requests = [];
  const checkouts = [];
  let callback;
  let configAttempts = 0;
  const config = { PADDLE_CLIENT_TOKEN: 'test-client', PADDLE_PRICE_PRO_MONTHLY: 'pro-price', PADDLE_PRICE_LIFETIME: 'lifetime-price', PADDLE_PRICE_DAY_PASS: 'day-price', PADDLE_PRICE_AUTHOR_TIP_CNY_CENT: 'tip-price' };
  const location = { search: '', pathname: `/${page}/`, origin: 'http://localhost', href: `http://localhost/${page}/` };
  const window = {
    location,
    matchMedia: () => ({ matches: true }),
    addEventListener() {},
    Paddle: {
      Initialize(options) { callback = options.eventCallback; },
      Checkout: { open(options) { checkouts.push(options); } }
    }
  };
  const fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === '/api/paddle-config') {
      if (failConfigOnce && ++configAttempts === 1) throw new Error('test temporary failure');
      return { ok: true, json: async () => ({ config }) };
    }
    if (url.startsWith('/api/entitlement')) return { ok: true, json: async () => ({ active: true, plan: 'pro', limits: {} }) };
    if (url.includes('sponsor_code')) return { ok: true, json: async () => ({ code: 'TEST-CODE' }) };
    return { ok: true, json: async () => ({}) };
  };
  const context = vm.createContext({
    window, location, fetch, localStorage: storage, sessionStorage: storage,
    crypto: webcrypto, URLSearchParams, atob, navigator: {},
    setTimeout: () => 1, clearTimeout() {},
    document: {
      referrer: '', hidden: false, addEventListener() {},
      getElementById: id => elements.get(id),
      querySelectorAll: selector => selector === `.${buttonClass}` ? buttons : [],
      querySelector: () => null
    }
  });
  vm.runInContext(script, context, { filename: `${page}/index.html` });
  return {
    elements, buttons, requests, checkouts,
    get focused() { return focused; },
    paymentEvent(name) { callback({ name }); },
    flush: () => new Promise(resolve => setImmediate(resolve))
  };
}

test('pricing requires an explicit plan selection and validates email before opening checkout', async () => {
  const page = pageHarness('pricing');
  const get = id => page.elements.get(id);
  assert.equal(get('continueCheckoutBtn').disabled, true);
  page.buttons[0].fire('click');
  assert.match(get('selectedPlanLabel').textContent, /专业版.*39/);
  assert.equal(page.buttons[0].getAttribute('aria-pressed'), 'true');
  assert.equal(page.checkouts.length, 0);
  get('checkoutForm').fire('submit');
  assert.equal(get('checkoutEmail').getAttribute('aria-invalid'), 'true');
  assert.equal(page.focused, get('checkoutEmail'));
  assert.equal(page.requests.length, 0);
  get('checkoutEmail').value = 'buyer@example.test';
  get('checkoutForm').fire('submit');
  get('checkoutForm').fire('submit');
  await page.flush();
  assert.equal(page.checkouts.length, 1);
  assert.equal(page.checkouts[0].items[0].priceId, 'pro-price');
  assert.equal(page.checkouts[0].customer.email, 'buyer@example.test');
  assert.equal(get('continueCheckoutBtn').disabled, true);
  page.paymentEvent('checkout.closed');
  assert.equal(get('continueCheckoutBtn').disabled, false);
  assert.match(get('checkoutStatus').textContent, /关闭/);
});

test('account entitlement lookup ignores the purchase-email field and uses only authenticated identity', async () => {
  const page = pageHarness('pricing', { signedIn: true });
  await page.flush();
  const get = id => page.elements.get(id);
  get('checkoutEmail').value = '';
  get('checkEntitlementBtn').fire('click');
  await page.flush();
  assert.equal(page.requests.length, 2);
  for (const request of page.requests) {
    assert.equal(request.url, '/api/entitlement?email=account%40example.test');
    assert.equal(request.options.headers.Authorization, 'Bearer test-token');
  }
  assert.match(get('entitlementStatus').textContent, /已开通 专业版/);
  get('checkoutEmail').value = 'different@example.test';
  get('checkoutEmail').fire('input');
  assert.match(get('emailHelp').textContent, /权益将开通至该邮箱对应账号/);
});

test('a temporary pricing configuration failure can be retried without refreshing the page', async () => {
  const page = pageHarness('pricing', { failConfigOnce: true });
  page.buttons[1].fire('click');
  page.elements.get('checkoutEmail').value = 'buyer@example.test';
  page.elements.get('checkoutForm').fire('submit');
  await page.flush();
  assert.equal(page.checkouts.length, 0);
  assert.equal(page.elements.get('continueCheckoutBtn').disabled, false);
  page.elements.get('checkoutForm').fire('submit');
  await page.flush();
  assert.equal(page.checkouts.length, 1);
  assert.equal(page.checkouts[0].items[0].priceId, 'lifetime-price');
});

test('sponsor selection creates no order until explicit continuation and preserves the chosen amount', async () => {
  const page = pageHarness('sponsor');
  await page.flush();
  page.buttons[1].fire('click');
  assert.match(page.elements.get('selectedCodeLabel').textContent, /NOVA-M/);
  assert.equal(page.requests.filter(request => request.options.body?.includes('sponsor_order')).length, 0);
  page.elements.get('sponsorCheckoutForm').fire('submit');
  page.elements.get('sponsorCheckoutForm').fire('submit');
  await page.flush();
  assert.equal(page.checkouts.length, 1);
  assert.equal(page.checkouts[0].items[0].quantity, 6600);
  assert.equal(page.checkouts[0].customData.plan_code, 'NOVA-M');
  assert.equal(page.elements.get('continueSponsorBtn').disabled, true);
  page.paymentEvent('checkout.closed');
  assert.equal(page.elements.get('continueSponsorBtn').disabled, false);
});

test('sponsor empty order lookup provides a recovery instruction without a request', async () => {
  const page = pageHarness('sponsor');
  await page.flush();
  const before = page.requests.length;
  page.elements.get('lookupForm').fire('submit');
  await page.flush();
  assert.equal(page.requests.length, before);
  assert.match(page.elements.get('codeStatus').textContent, /请粘贴订单请求号/);
  assert.equal(page.focused, page.elements.get('requestLookup'));
});

test('both pages remain usable when local storage is disabled', () => {
  for (const name of ['pricing', 'sponsor']) {
    const page = pageHarness(name, { storageUnavailable: true });
    page.buttons[0].fire('click');
    assert.equal(page.buttons[0].getAttribute('aria-pressed'), 'true');
  }
});
