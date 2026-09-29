import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const html = readFileSync(new URL('../public/one-time-pass/index.html', import.meta.url), 'utf8');

function pageHarness() {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const requests = [];
  const checkouts = [];
  let focused = null;
  let callback;

  class Element {
    constructor(attributes = {}) {
      this.attributes = attributes;
      this.events = {};
      this.value = '';
      this.textContent = '';
      this.disabled = false;
      this.className = '';
    }
    addEventListener(type, handler) { (this.events[type] ||= []).push(handler); }
    fire(type) {
      return Promise.all((this.events[type] || []).map(handler => handler({ preventDefault() {} })));
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    focus() { focused = this; }
  }

  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    elements.set(match[1], new Element());
  }

  const storage = new Map();
  const storageApi = {
    getItem(key) { return storage.get(key) ?? null; },
    setItem(key, value) { storage.set(key, value); }
  };
  const config = {
    PADDLE_CLIENT_TOKEN: 'test-client',
    PADDLE_PRICE_DAY_PASS: 'day-pass-price'
  };
  const window = {
    location: { search: '', origin: 'http://localhost' },
    Paddle: {
      Initialize(options) { callback = options.eventCallback; },
      Checkout: { open(options) { checkouts.push(options); } }
    },
    matchMedia: () => ({ matches: true })
  };
  const fetch = async url => {
    requests.push(url);
    return { ok: true, json: async () => ({ config }) };
  };

  vm.runInContext(script, vm.createContext({
    window,
    fetch,
    localStorage: storageApi,
    URLSearchParams,
    document: {
      getElementById: id => elements.get(id),
      createElement: () => new Element(),
      head: { appendChild() {} }
    }
  }));

  return {
    elements,
    requests,
    checkouts,
    get focused() { return focused; },
    paymentEvent(name) { callback({ name }); },
    flush() { return new Promise(resolve => setImmediate(resolve)); }
  };
}

test('one-time pass page is a quiet noindex entry with quantity checkout controls', () => {
  assert.match(html, /name="robots" content="noindex,nofollow"/);
  assert.match(html, /Vid2PPT One-time Pass/);
  assert.match(html, /id="passQuantity"[^>]*min="1"[^>]*max="999"/);
});

test('one-time pass validates email and sends the entered quantity to Paddle', async () => {
  const page = pageHarness();
  const get = id => page.elements.get(id);

  get('passQuantity').value = '10';
  await get('passQuantity').fire('input');
  assert.equal(get('passTotal').textContent, '¥99.00');
  assert.equal(get('passPayButton').textContent, '支付 ¥99.00');

  await get('oneTimePassForm').fire('submit');
  assert.equal(page.checkouts.length, 0);
  assert.equal(page.focused, get('passEmail'));
  assert.equal(get('passEmail').attributes['aria-invalid'], 'true');

  get('passEmail').value = 'buyer@example.test';
  await get('oneTimePassForm').fire('submit');
  await get('oneTimePassForm').fire('submit');
  await page.flush();

  assert.equal(page.requests.length, 1);
  assert.equal(page.checkouts.length, 1);
  assert.equal(page.checkouts[0].items.length, 1);
  assert.equal(page.checkouts[0].items[0].priceId, 'day-pass-price');
  assert.equal(page.checkouts[0].items[0].quantity, 10);
  assert.equal(page.checkouts[0].customer.email, 'buyer@example.test');
  assert.equal(page.checkouts[0].customData.plan, 'day_pass');
  assert.equal(page.checkouts[0].customData.source, 'one_time_pass_page');
  assert.equal(page.checkouts[0].customData.order_kind, 'one_time_pass');
  assert.equal(page.checkouts[0].customData.quantity, 10);
  assert.equal(page.checkouts[0].settings.successUrl, 'http://localhost/one-time-pass/?checkout=success');

  page.paymentEvent('checkout.closed');
  assert.equal(get('passPayButton').disabled, false);
  assert.match(get('passStatus').textContent, /支付窗口已关闭/);
});

test('one-time pass rejects non-integer and out-of-range quantities', async () => {
  const page = pageHarness();
  const get = id => page.elements.get(id);
  get('passEmail').value = 'buyer@example.test';

  for (const value of ['0', '1.5', '1000']) {
    get('passQuantity').value = value;
    await get('oneTimePassForm').fire('submit');
    assert.equal(page.checkouts.length, 0);
    assert.match(get('passStatus').textContent, /1–999/);
  }
});
