import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';

const html = readFileSync(new URL('../public/contact/index.html', import.meta.url), 'utf8');

function contactHarness({ replies = [], query = '', verified = true } = {}) {
  const elements = new Map();
  const requests = [];
  let timer;
  let widgetOptions;
  let resets = 0;
  class Element {
    constructor() { this.value = ''; this.events = {}; this.attributes = {}; this.textContent = ''; this.disabled = false; this.validationMessage = ''; }
    addEventListener(type, callback) { (this.events[type] ||= []).push(callback); }
    fire(type) { return Promise.all((this.events[type] || []).map(callback => callback({ preventDefault() {} }))); }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    setCustomValidity(message) { this.validationMessage = message; }
  }
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) elements.set(match[1], new Element());
  const get = id => elements.get(id);
  const inputs = ['contactName', 'contactEmail', 'contactSubject', 'contactMessage', 'contactWebsite'];
  get('contactForm').reset = () => { for (const id of inputs) get(id).value = ''; };
  get('contactForm').reportValidity = () => {
    if (inputs.some(id => get(id).validationMessage)) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(get('contactEmail').value) && Boolean(get('contactSubject').value) && get('contactMessage').value.length >= 10;
  };
  const fetch = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    const reply = replies.shift() ?? { success: true, reference: 'contact-test-001' };
    if (typeof reply === 'function') return reply(options);
    return { ok: !reply.detail, json: async () => reply };
  };
  const window = { location: { search: query }, turnstile: {
    render(selector, options) { widgetOptions = options; return 'contact-widget'; },
    reset() { resets += 1; }
  } };
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], vm.createContext({
    document: { getElementById: get, createElement: () => ({}), head: { appendChild() {} } }, window,
    fetch, crypto: webcrypto, URLSearchParams, AbortController, TypeError,
    setTimeout(callback) { timer = callback; return 1; }, clearTimeout() {}
  }));
  window.onContactTurnstileLoad();
  if (verified) widgetOptions.callback('verified-contact-token');
  return {
    get, requests,
    get widgetOptions() { return widgetOptions; },
    get resets() { return resets; },
    verify(token = 'renewed-contact-token') { widgetOptions.callback(token); },
    fill() { get('contactName').value = 'Test sender'; get('contactEmail').value = 'sender@example.test'; get('contactSubject').value = 'Video export help'; get('contactMessage').value = 'The export stops after selecting a page.'; },
    submit() { return get('contactForm').fire('submit'); },
    expire() { timer(); },
    async edit(id, value) { get(id).value = value; await get(id).fire('input'); await get('contactFields').fire('input'); }
  };
}

test('contact page exposes a real form, public email, field limits and accessible status', () => {
  assert.match(html, /action="\/api\/contact" method="post"/);
  assert.match(html, /href="mailto:info@vid2ppt\.com"/);
  assert.match(html, /name="email"[^>]*required maxlength="254"/);
  assert.match(html, /name="subject" required maxlength="160"/);
  assert.match(html, /name="message" required minlength="10" maxlength="5000"/);
  assert.match(html, /name="website"[^>]*tabindex="-1"/);
  assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit/);
  assert.doesNotMatch(html, /foxmail\.com|support@vid2deck\.com/);
});

test('contact form rejects blank subjects and whitespace-only details before requesting', async () => {
  const page = contactHarness();
  page.fill();
  page.get('contactSubject').value = '    ';
  page.get('contactMessage').value = '               ';
  await page.submit();
  assert.equal(page.requests.length, 0);
  assert.match(page.get('contactSubject').validationMessage, /主题/);
  assert.match(page.get('contactMessage').validationMessage, /详细内容/);
  assert.equal(page.get('contactSubmit').disabled, false);
});

test('contact submission suppresses duplicates while pending and clears inputs only after acceptance', async () => {
  let finish;
  const page = contactHarness({ replies: [() => new Promise(resolve => { finish = resolve; })] });
  page.fill();
  const pending = page.submit();
  await page.submit();
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].url, '/api/contact');
  assert.equal(page.requests[0].options.method, 'POST');
  assert.equal(page.get('contactFields').disabled, true);
  assert.equal(page.get('contactSubmit').disabled, true);
  assert.match(page.requests[0].body.request_id, /^[0-9a-f-]{36}$/);
  assert.equal(page.requests[0].body.turnstile_token, 'verified-contact-token');
  finish({ ok: true, json: async () => ({ success: true, reference: 'CONTACT-001' }) });
  await pending;
  assert.equal(page.get('contactFields').disabled, false);
  assert.equal(page.get('contactSubmit').disabled, true);
  assert.equal(page.resets, 1);
  assert.equal(page.get('contactMessage').value, '');
  assert.match(page.get('contactStatus').textContent, /sender@example\.test.*CONTACT-001/);
  assert.equal(page.get('contactStatus').attributes['data-state'], 'success');
  assert.equal(page.get('messageCount').textContent, '0 / 5,000');
});

test('failed contact submissions preserve text and retry with the same request ID', async () => {
  const page = contactHarness({ replies: [{ detail: '服务暂时不可用，请稍后再试。' }] });
  page.fill();
  const original = page.get('contactMessage').value;
  await page.submit();
  assert.equal(page.get('contactMessage').value, original);
  assert.equal(page.get('contactEmail').value, 'sender@example.test');
  assert.equal(page.get('contactStatus').attributes['data-state'], 'error');
  assert.match(page.get('contactStatus').textContent, /服务暂时不可用/);
  assert.equal(page.get('contactSubmit').disabled, true);
  page.verify();
  await page.submit();
  assert.equal(page.requests.length, 2);
  assert.equal(page.requests[0].body.request_id, page.requests[1].body.request_id);
});

test('edited contact submissions receive a fresh request ID', async () => {
  const page = contactHarness({ replies: [{ detail: 'Please retry.' }], query: '?subject=Order%20support' });
  assert.equal(page.get('contactSubject').value, 'Order support');
  page.fill();
  await page.submit();
  await page.edit('contactMessage', 'More details about the export problem.');
  page.verify();
  await page.submit();
  assert.notEqual(page.requests[0].body.request_id, page.requests[1].body.request_id);
});

test('timeout keeps user content and explains that acceptance could not be confirmed', async () => {
  const page = contactHarness({ replies: [options => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
  })] });
  page.fill();
  const pending = page.submit();
  page.expire();
  await pending;
  assert.match(page.get('contactStatus').textContent, /未能确认提交结果.*内容已保留/);
  assert.equal(page.get('contactSubmit').disabled, true);
  page.verify();
  assert.equal(page.get('contactSubmit').disabled, false);
  assert.notEqual(page.get('contactMessage').value, '');
});

test('a response without success is not presented as delivery confirmation', async () => {
  const page = contactHarness({ replies: [{}] });
  page.fill();
  await page.submit();
  assert.equal(page.get('contactStatus').attributes['data-state'], 'error');
  assert.notEqual(page.get('contactMessage').value, '');
});

test('unverified submissions are blocked and expired verification disables sending until renewed', async () => {
  const page = contactHarness({ verified: false });
  page.fill();
  await page.submit();
  assert.equal(page.requests.length, 0);
  assert.equal(page.get('contactSubmit').disabled, true);
  assert.match(page.get('verificationStatus').textContent, /请先完成/);
  assert.equal(page.widgetOptions.action, 'contact');
  page.verify();
  assert.equal(page.get('contactSubmit').disabled, false);
  page.widgetOptions['expired-callback']();
  assert.equal(page.get('contactSubmit').disabled, true);
  assert.equal(page.resets, 1);
  assert.notEqual(page.get('contactMessage').value, '');
  page.verify();
  await page.submit();
  assert.equal(page.requests.length, 1);
});

test('verification error and timeout show recovery without losing the message', async () => {
  const page = contactHarness();
  page.fill();
  page.widgetOptions['error-callback']('test-failure');
  assert.equal(page.get('contactSubmit').disabled, true);
  assert.equal(page.get('verificationRetry').hidden, false);
  assert.match(page.get('verificationStatus').textContent, /重新验证/);
  await page.get('verificationRetry').fire('click');
  assert.equal(page.resets, 1);
  page.widgetOptions['timeout-callback']();
  assert.match(page.get('verificationStatus').textContent, /超时/);
  assert.notEqual(page.get('contactMessage').value, '');
});
