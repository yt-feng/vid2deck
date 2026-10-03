(function () {
  'use strict';
  var locale = window.Vid2PPTLocale;
  if (!locale) return;
  var page = location.pathname.indexOf('/one-time-pass') === 0 ? 'pass' : location.pathname.indexOf('/pricing') === 0 ? 'pricing' : 'welcome';
  var dictionary;
  var selectedPlan = page === 'pass' ? 'day_pass' : '';
  var busy = false, paymentOpen = false, paymentCompleted = false;
  var paddlePromise = null, paddleInitialized = false;
  var authKey = 'vid2deck.auth.session', emailKey = 'vid2deck.checkout.email';
  var prices = { pro: 39, lifetime: 498, day_pass: 9.9 };
  var priceKeys = { pro: 'PADDLE_PRICE_PRO_MONTHLY', lifetime: 'PADDLE_PRICE_LIFETIME', day_pass: 'PADDLE_PRICE_DAY_PASS' };
  function escape(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); }
  function t(key, values) {
    var text = dictionary[key] || key;
    return text.replace(/\{(\w+)\}/g, function (match, name) { return values && values[name] != null ? String(values[name]) : match; });
  }
  function e(key, values) { return escape(t(key, values)); }
  function read(storage, key) { try { return storage.getItem(key) || ''; } catch (error) { return ''; } }
  function write(storage, key, value) { try { storage.setItem(key, value); } catch (error) {} }
  function session() {
    try {
      var value = JSON.parse(read(localStorage, authKey));
      return value && value.token && value.user && value.user.email ? value : null;
    } catch (error) { return null; }
  }
  function money(value) { return new Intl.NumberFormat(locale.current, { style: 'currency', currency: 'CNY' }).format(value); }
  function url(path) { return escape(locale.url(path)); }
  function status(id, message, tone) {
    var node = document.getElementById(id); if (!node) return;
    node.textContent = message; node.setAttribute('data-tone', tone || '');
  }
  function nav() {
    return '<nav class="global-nav"><a class="global-brand" href="' + url(locale.current === 'zh-CN' ? '/' : '/welcome/') + '"><img src="/brand/vid2ppt-mark.svg" alt="" />Vid2PPT</a><div class="global-links"><a href="' + url('/pricing/') + '">' + e('pricing') + '</a><a href="' + url('/#account') + '">' + e('login') + '</a><span id="languageControl"></span></div></nav>';
  }
  function footer() {
    return '<footer class="global-footer"><span>© 2026 Vid2PPT</span><a href="mailto:info@vid2ppt.com">' + e('contact') + '</a><a href="' + url('/terms-and-conditions/') + '">' + e('terms') + '</a><a href="' + url('/privacy/') + '">' + e('privacy') + '</a><a href="' + url('/refund/') + '">' + e('refund') + '</a></footer>';
  }
  function faq() {
    return '<section class="global-section global-faq"><h2>' + e('faqTitle') + '</h2>' + ['Local', 'Account', 'Renew', 'Lifetime'].map(function (topic) {
      return '<details><summary>' + e('faq' + topic + 'Q') + '</summary><p>' + e('faq' + topic + 'A') + '</p></details>';
    }).join('') + '</section>';
  }
  function workspaceNotice() { return locale.current.indexOf('zh-') === 0 ? '' : '<p class="global-notice">' + e('workspaceLanguage') + '</p>'; }
  function welcome() {
    return '<section class="global-hero"><div class="global-tag">' + e('tag') + '</div><h1>' + e('title') + '</h1><p>' + e('lead') + '</p><div class="global-actions"><a class="global-action" href="' + url('/#start') + '">' + e('start') + '</a><a class="global-action secondary" href="' + url('/pricing/') + '">' + e('pricing') + '</a></div><p class="global-note">' + e('freeIntro') + '</p></section>' +
      '<div class="global-grid">' + ['local', 'ai', 'exports'].map(function (key) { return '<article class="global-card"><p>' + e(key) + '</p></article>'; }).join('') + '</div>' +
      '<section class="global-section"><h2>' + e('stepsTitle') + '</h2><div class="global-grid">' + [1, 2, 3].map(function (n) { return '<article class="global-card"><div class="global-tag">0' + n + '</div><h2>' + e('step' + n + 'Title') + '</h2><p>' + e('step' + n) + '</p></article>'; }).join('') + '</div></section>' + workspaceNotice() + faq();
  }
  function card(plan) {
    var free = plan === 'free';
    var value = free ? 0 : prices[plan];
    var features = [t('maxVideo', { value: free ? t('minutes', { value: 10 }) : t('unlimited') }),
      t('conversions', { value: free ? 3 : plan === 'pro' ? 100 : '∞' }),
      t('ocr', { value: free ? 100 : plan === 'pro' ? new Intl.NumberFormat(locale.current).format(10000) : '∞' }),
      t('transcription', { value: free ? t('minutes', { value: 600 }) : '∞' }),
      free ? t('single') : t('batch'), t('exports')];
    return '<article class="global-card" data-card-plan="' + plan + '"><h2>' + e(plan) + '</h2><p>' + e(plan + 'Desc') + '</p><p class="price">' + escape(money(value)) + '</p><p class="cadence">' + (free ? e('free') : e(plan === 'pro' ? 'monthly' : 'oneOff')) + '</p><ul>' + features.map(function (feature) { return '<li>' + escape(feature) + '</li>'; }).join('') + '</ul>' +
      (free ? '<a class="global-action secondary" href="' + url('/#start') + '">' + e('start') + '</a>' : '<button class="global-action plan-button" type="button" data-plan="' + plan + '" aria-pressed="false">' + e('choose', { plan: t(plan) }) + '</button>') + '</article>';
  }
  function checkout() {
    var pass = page === 'pass';
    var fallback = locale.paddleLocale(locale.current) === 'en' && locale.current !== 'en';
    return '<section class="global-section global-checkout" id="globalCheckout"><div><h2>' + e('orderSummary') + '</h2><p id="globalSelected">' + (pass ? e('selected', { plan: t('day_pass') }) : e('selectPlan')) + '</p><p id="globalPlanTerms">' + (pass ? e('dayDesc') + ' ' + e('oneOff') : '') + '</p><p class="global-note">' + e('finalAmount') + '</p>' + (fallback ? '<p class="global-notice">' + e('checkoutEnglish') + '</p>' : '') + '<p class="global-note">' + e('secure') + '</p><p class="global-note">' + e('support') + '</p></div>' +
      '<form id="globalCheckoutForm" novalidate><div class="field"><label for="globalEmail">' + e('buyEmail') + '</label><input id="globalEmail" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" aria-describedby="globalEmailHelp" required /><p class="global-note" id="globalEmailHelp">' + e('emailHelp') + '</p></div>' +
      (pass ? '<div class="field"><label for="globalQuantity">' + e('quantity') + '</label><input id="globalQuantity" type="number" min="1" max="999" step="1" inputmode="numeric" value="1" aria-describedby="globalQuantityHelp" required /><p class="global-note" id="globalQuantityHelp">' + e('quantityHelp') + '</p><p class="global-note">' + e('multiplePass') + '</p></div><div class="global-subtotal"><span>' + e('subtotal') + '</span><strong id="globalTotal">' + escape(money(9.9)) + '</strong></div>' : '') +
      '<button class="global-action" type="submit" id="globalPay"' + (pass ? '' : ' disabled') + '>' + e('continuePay') + '</button><p class="global-note">' + e('readPolicies') + ' <a href="' + url('/terms-and-conditions/') + '">' + e('terms') + '</a> · <a href="' + url('/refund/') + '">' + e('refund') + '</a></p><div class="global-status" id="globalPaymentStatus" role="status" aria-live="polite"></div><div class="global-actions"><button class="global-action secondary" type="button" id="globalRefresh">' + e('refresh') + '</button><a href="' + url('/#account') + '">' + e('login') + '</a></div><div class="global-status" id="globalEntitlementStatus" role="status" aria-live="polite">' + e('accountHelp') + '</div></form></section>';
  }
  function pricing() {
    return '<section class="global-hero"><div class="global-tag">Vid2PPT</div><h1>' + e('pricing') + '</h1><p>' + e('freeIntro') + '</p></section><div class="global-grid">' + ['free', 'pro', 'lifetime'].map(card).join('') + '</div>' +
      '<section class="global-section global-card" data-card-plan="day_pass"><h2>' + e('day_pass') + '</h2><p>' + e('dayDesc') + '</p><p class="price">' + escape(money(9.9)) + '</p><p class="cadence">' + e('oneOff') + '</p><button class="global-action plan-button" type="button" data-plan="day_pass" aria-pressed="false">' + e('choose', { plan: t('day_pass') }) + '</button></section>' + checkout() +
      '<a href="' + url('/one-time-pass/') + '">' + e('passEntry') + '</a>' + workspaceNotice() + faq();
  }
  function pass() {
    return '<section class="global-hero"><div class="global-tag">Vid2PPT</div><h1>' + e('day_pass') + '</h1><p>' + e('dayDesc') + '</p><p>' + escape(money(9.9)) + ' / ' + e('perPass') + ' · ' + e('oneOff') + '</p></section>' + checkout() + '<a href="' + url('/pricing/') + '">' + e('pricing') + '</a>' + workspaceNotice();
  }
  function setBusy(value) {
    busy = value;
    document.getElementById('globalPay').disabled = value || !selectedPlan;
    document.getElementById('globalPay').textContent = t(value ? 'loading' : 'continuePay');
    document.getElementById('globalEmail').disabled = value;
    var quantity = document.getElementById('globalQuantity'); if (quantity) quantity.disabled = value;
    document.querySelectorAll('.plan-button').forEach(function (button) { button.disabled = value; });
    document.getElementById('globalCheckoutForm').setAttribute('aria-busy', String(value));
  }
  function selectPlan(plan) {
    if (busy || !priceKeys[plan]) return;
    selectedPlan = plan;
    document.querySelectorAll('.plan-button').forEach(function (button) { button.setAttribute('aria-pressed', String(button.getAttribute('data-plan') === plan)); });
    document.querySelectorAll('[data-card-plan]').forEach(function (card) { card.classList.toggle('selected', card.getAttribute('data-card-plan') === plan); });
    document.getElementById('globalSelected').textContent = t('selected', { plan: t(plan) }) + ' · ' + money(prices[plan]);
    document.getElementById('globalPlanTerms').textContent = t(plan === 'pro' ? 'monthly' : plan === 'lifetime' ? 'duringService' : 'dayDesc') + (plan === 'pro' ? '' : ' · ' + t('oneOff'));
    setBusy(false);
    document.getElementById('globalCheckout').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    document.getElementById('globalEmail').focus({ preventScroll: true });
  }
  function loadPaddle() {
    if (window.Paddle) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = 'https://cdn.paddle.com/paddle/v2/paddle.js'; script.async = true;
      script.onload = resolve; script.onerror = function () { script.remove(); reject(new Error(t('paymentFailed'))); };
      document.head.appendChild(script);
    });
  }
  function ensurePaddle() {
    if (paddlePromise) return paddlePromise;
    paddlePromise = Promise.all([fetch('/api/paddle-config', { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error(t('paymentFailed'));
      return response.json();
    }), loadPaddle()]).then(function (results) {
      var config = results[0].config || {};
      if (!config.PADDLE_CLIENT_TOKEN || !window.Paddle) throw new Error(t('paymentFailed'));
      if (config.PADDLE_ENV === 'sandbox') window.Paddle.Environment.set('sandbox');
      if (!paddleInitialized) {
        window.Paddle.Initialize({ token: config.PADDLE_CLIENT_TOKEN,
          checkout: { settings: { locale: locale.paddleLocale(locale.current), successUrl: locale.successUrl(page === 'pass' ? '/one-time-pass/' : '/pricing/') } },
          eventCallback: function (event) {
            var name = String(event && (event.name || event.eventName || event.type) || '');
            if (name === 'checkout.closed') {
              paymentOpen = false; setBusy(false);
              if (!paymentCompleted) status('globalPaymentStatus', t('closed'));
            } else if (name === 'checkout.completed') {
              paymentCompleted = true; paymentOpen = false; setBusy(false);
              status('globalPaymentStatus', t('completed'), 'ok');
              syncAccess();
            } else if (name === 'checkout.error') {
              paymentOpen = false; setBusy(false); status('globalPaymentStatus', t('paymentFailed'), 'error');
            }
          }
        });
        paddleInitialized = true;
      }
      return config;
    }).catch(function (error) { paddlePromise = null; throw error; });
    return paddlePromise;
  }
  function normalizedEmail(value) { return String(value || '').trim().toLowerCase(); }
  function quantity() {
    if (page !== 'pass') return 1;
    var value = Number(document.getElementById('globalQuantity').value);
    return Number.isInteger(value) && value >= 1 && value <= 999 ? value : 0;
  }
  function openCheckout(event) {
    event.preventDefault();
    if (busy || paymentOpen) return;
    if (!selectedPlan) { status('globalPaymentStatus', t('selectPlan'), 'warn'); return; }
    var input = document.getElementById('globalEmail');
    var email = normalizedEmail(input.value);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      input.setAttribute('aria-invalid', 'true'); input.focus(); status('globalPaymentStatus', t('emailValid'), 'error'); return;
    }
    input.removeAttribute('aria-invalid');
    var count = quantity();
    if (!count) {
      document.getElementById('globalQuantity').setAttribute('aria-invalid', 'true');
      document.getElementById('globalQuantity').focus(); status('globalPaymentStatus', t('quantityValid'), 'error'); return;
    }
    write(localStorage, emailKey, email);
    write(sessionStorage, 'vid2deck.checkout.plan', selectedPlan);
    paymentCompleted = false; setBusy(true); status('globalPaymentStatus', t('loading'), 'warn');
    ensurePaddle().then(function (config) {
      var priceId = config[priceKeys[selectedPlan]];
      if (!priceId) throw new Error(t('unavailable'));
      var signedIn = session(); var user = signedIn && signedIn.user;
      paymentOpen = true;
      window.Paddle.Checkout.open({
        items: [{ priceId: priceId, quantity: count }], customer: { email: email },
        customData: { email: email, plan: selectedPlan, source: page === 'pass' ? 'one_time_pass_page' : 'pricing_page',
          order_kind: page === 'pass' ? 'one_time_pass' : 'membership', quantity: count, billing_quantity: count,
          pass_quantity: selectedPlan === 'day_pass' ? count : 1,
          username: user && user.username || '', account_id: user && user.id || '',
          site_locale: locale.current, checkout_locale: locale.paddleLocale(locale.current) },
        settings: { displayMode: 'overlay', theme: 'light', locale: locale.paddleLocale(locale.current),
          successUrl: locale.successUrl(page === 'pass' ? '/one-time-pass/' : '/pricing/', selectedPlan) }
      });
      status('globalPaymentStatus', t('opened'));
    }).catch(function (error) { paymentOpen = false; status('globalPaymentStatus', error.message || t('paymentFailed'), 'error'); })
      .finally(function () { if (!paymentOpen) setBusy(false); });
  }
  function refreshAccess() {
    var signedIn = session();
    if (!signedIn) { status('globalEntitlementStatus', t('loggedOut') + ' ' + t('accountHelp'), 'warn'); return Promise.resolve(); }
    var button = document.getElementById('globalRefresh'); button.disabled = true;
    status('globalEntitlementStatus', t('checking'));
    // Purchase-email input never authorizes an account entitlement lookup.
    return fetch('/api/entitlement?email=' + encodeURIComponent(normalizedEmail(signedIn.user.email)), {
      cache: 'no-store', headers: { Authorization: 'Bearer ' + signedIn.token }
    }).then(function (response) {
      if (response.status === 401) throw new Error(t('expiredSession'));
      if (!response.ok) throw new Error(t('checkFailed'));
      return response.json();
    }).then(function (data) {
      var plan = data.effective_plan || data.plan;
      var date = data.current_period_end ? new Date(data.current_period_end) : null;
      var expiry = date && !Number.isNaN(date.getTime()) ? t('expiry', { value: date.toLocaleString(locale.current) }) : '';
      status('globalEntitlementStatus', data.active ? t('active', { plan: dictionary[plan] || plan, expiry: expiry }) : t('freeAccess'), data.active ? 'ok' : 'warn');
    }).catch(function (error) { status('globalEntitlementStatus', error.message || t('checkFailed'), 'error'); })
      .finally(function () { button.disabled = false; });
  }
  function syncAccess() {
    var signedIn = session();
    if (!signedIn) { status('globalEntitlementStatus', t('accountHelp')); return; }
    var email = normalizedEmail(document.getElementById('globalEmail').value);
    if (email && email !== normalizedEmail(signedIn.user.email)) { status('globalEntitlementStatus', t('emailMismatch'), 'warn'); return; }
    refreshAccess(); setTimeout(refreshAccess, 1800); setTimeout(refreshAccess, 7000);
  }
  function bindCheckout() {
    var signedIn = session();
    document.getElementById('globalEmail').value = signedIn && !signedIn.user.email_is_generated ? signedIn.user.email : read(localStorage, emailKey);
    document.getElementById('globalCheckoutForm').addEventListener('submit', openCheckout);
    document.getElementById('globalRefresh').addEventListener('click', refreshAccess);
    document.querySelectorAll('.plan-button').forEach(function (button) { button.addEventListener('click', function () { selectPlan(button.getAttribute('data-plan')); }); });
    document.getElementById('globalEmail').addEventListener('input', function () {
      this.removeAttribute('aria-invalid');
      var signedIn = session();
      document.getElementById('globalEmailHelp').textContent = signedIn && normalizedEmail(this.value) && normalizedEmail(this.value) !== normalizedEmail(signedIn.user.email) ? t('emailMismatch') : t('emailHelp');
    });
    var input = document.getElementById('globalQuantity');
    if (input) input.addEventListener('input', function () {
      this.removeAttribute('aria-invalid'); document.getElementById('globalTotal').textContent = quantity() ? money(quantity() * 9.9) : '—';
    });
    window.addEventListener('storage', function (event) { if (event.key === authKey) refreshAccess(); });
    if (signedIn) refreshAccess();
    var params = new URLSearchParams(location.search);
    if (params.get('checkout') === 'success') {
      status('globalPaymentStatus', t('returned'), 'warn'); syncAccess();
      document.getElementById('globalCheckout').scrollIntoView({ block: 'start' });
    }
    // Paddle payment links use _ptxn. Initializing Paddle opens the existing transaction.
    if (/^txn_[a-z0-9]+$/.test(params.get('_ptxn') || '')) {
      ensurePaddle().catch(function () { status('globalPaymentStatus', t('paymentFailed'), 'error'); });
    }
  }
  function render() {
    if (page !== 'welcome') document.querySelectorAll('style').forEach(function (style) { style.remove(); });
    document.documentElement.lang = locale.current;
    document.documentElement.dir = locale.current === 'ar' || locale.current === 'he' ? 'rtl' : 'ltr';
    document.title = 'Vid2PPT | ' + t(page === 'welcome' ? 'title' : page === 'pass' ? 'day_pass' : 'pricing');
    var meta = document.querySelector('meta[name="description"]'); if (meta) meta.setAttribute('content', t(page === 'welcome' ? 'lead' : page === 'pass' ? 'dayDesc' : 'freeIntro'));
    document.body.innerHTML = '<div class="global-wrap">' + nav() + '<main id="globalMain">' + (page === 'welcome' ? welcome() : page === 'pricing' ? pricing() : pass()) + '</main>' + footer() + '</div>';
    document.getElementById('languageControl').appendChild(locale.selector(t('language')));
    if (page !== 'welcome') bindCheckout();
  }
  async function boot() {
    var response = await fetch('/locales/en.json');
    if (!response.ok) throw new Error('Unable to load website language.');
    var english = await response.json();
    dictionary = english;
    if (locale.current !== 'en') {
      try {
        var localized = await fetch('/locales/' + locale.current + '.json');
        if (!localized.ok) throw new Error('missing language');
        var translated = await localized.json();
        if (Object.keys(english).some(function (key) { return typeof translated[key] !== 'string' || !translated[key].trim(); })) throw new Error('incomplete language');
        dictionary = translated;
      } catch (error) { locale.current = 'en'; }
    }
    render();
  }
  boot().catch(function () {
    document.body.innerHTML = '<main class="global-error"><h1>Vid2PPT</h1><p>Unable to load this page. Please reload or contact <a href="mailto:info@vid2ppt.com">info@vid2ppt.com</a>.</p></main>';
  });
}());
