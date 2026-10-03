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
  var quotes = {}, quoteVersion = 0, quoteReady = false, quoteTimer;
  var passMinimum = 1, passMaximum = 999999;
  var countryKey = 'vid2ppt.billingCountry';
  var rateKey = 'vid2ppt.exchangeRates', ratesPromise, exchangeRates;
  var localeCurrencies = { en:'USD', 'zh-CN':'CNY', 'zh-TW':'TWD', es:'EUR', fr:'EUR', de:'EUR', pt:'EUR', 'pt-BR':'BRL', it:'EUR', ja:'JPY', ko:'KRW', ar:'AED', ru:'RUB', hi:'INR', id:'IDR', tr:'TRY', vi:'VND', th:'THB', nl:'EUR', pl:'PLN', sv:'SEK', da:'DKK', no:'NOK', fi:'EUR', cs:'CZK', uk:'UAH', ro:'RON', hu:'HUF', el:'EUR', he:'ILS', bn:'BDT', ms:'MYR', tl:'PHP' };
  var countryCurrencies = { US:'USD', GB:'GBP', CA:'CAD', AU:'AUD', NZ:'NZD', CN:'CNY', TW:'TWD', HK:'HKD', MO:'MOP', SG:'SGD', AE:'AED', SA:'SAR', QA:'QAR', KW:'KWD', BH:'BHD', OM:'OMR', JP:'JPY', KR:'KRW', IN:'INR', ID:'IDR', MY:'MYR', PH:'PHP', BD:'BDT', VN:'VND', TH:'THB', TR:'TRY', UA:'UAH', IL:'ILS', PL:'PLN', SE:'SEK', DK:'DKK', NO:'NOK', CZ:'CZK', HU:'HUF', RO:'RON', CH:'CHF', BR:'BRL', MX:'MXN', AR:'ARS', CL:'CLP', CO:'COP', PE:'PEN', ZA:'ZAR', EG:'EGP', MA:'MAD', TN:'TND', NG:'NGN', KE:'KES', PK:'PKR', LK:'LKR', NP:'NPR', IS:'ISK', RS:'RSD', KZ:'KZT', UZ:'UZS', GE:'GEL', AM:'AMD', AZ:'AZN' };
  ['AT','BE','BG','CY','DE','EE','ES','FI','FR','GR','HR','IE','IT','LT','LU','LV','MT','NL','PT','SI','SK','AD','MC','SM','VA'].forEach(function (country) { countryCurrencies[country] = 'EUR'; });
  var defaultCountries = { en: 'US', 'zh-CN': 'CN', 'zh-TW': 'TW', es: 'ES', fr: 'FR', de: 'DE', pt: 'PT', 'pt-BR': 'BR', it: 'IT', ja: 'JP', ko: 'KR', ar: 'AE', ru: 'US', hi: 'IN', id: 'ID', tr: 'TR', vi: 'VN', th: 'TH', nl: 'NL', pl: 'PL', sv: 'SE', da: 'DK', no: 'NO', fi: 'FI', cs: 'CZ', uk: 'UA', ro: 'RO', hu: 'HU', el: 'GR', he: 'IL', bn: 'BD', ms: 'MY', tl: 'PH' };
  // Paddle supported selling countries, from its countries documentation (2026-10-03).
  var countries = ["AD", "AE", "AG", "AI", "AL", "AM", "AO", "AR", "AS", "AT", "AU", "AW", "AX", "AZ", "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS", "BT", "BV", "BW", "BZ", "CA", "CC", "CG", "CH", "CI", "CK", "CL", "CM", "CN", "CO", "CR", "CV", "CW", "CX", "CY", "CZ", "DE", "DJ", "DK", "DM", "DO", "DZ", "EC", "EE", "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK", "FM", "FO", "FR", "GA", "GB", "GD", "GE", "GF", "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY", "HK", "HM", "HN", "HR", "HU", "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IS", "IT", "JE", "JM", "JO", "JP", "KE", "KG", "KH", "KI", "KM", "KN", "KR", "KW", "KY", "KZ", "LA", "LB", "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV", "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ", "NA", "NC", "NE", "NF", "NG", "NL", "NO", "NP", "NR", "NU", "NZ", "OM", "PA", "PE", "PF", "PG", "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY", "QA", "RE", "RO", "RS", "RW", "SA", "SB", "SC", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SR", "ST", "SV", "SX", "SZ", "TC", "TD", "TF", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO", "TR", "TT", "TV", "TW", "TZ", "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VG", "VI", "VN", "VU", "WF", "WS", "XK", "YT", "ZA", "ZM"];
  var billingCountry = resolveCountry();
  var requestedCurrency = String(new URLSearchParams(location.search).get('currency') || '').toUpperCase();
  var knownCurrencies = Object.values(localeCurrencies).concat(Object.values(countryCurrencies));
  var countryWasSelected = Boolean(new URLSearchParams(location.search).get('country') || read(localStorage, countryKey) || billingCountry !== defaultCountries[locale.current]);
  var displayCurrency = knownCurrencies.indexOf(requestedCurrency) >= 0 ? requestedCurrency : countryWasSelected ? countryCurrencies[billingCountry] || 'USD' : localeCurrencies[locale.current] || 'USD';
  locale.currencyForLanguage = function (language) { return localeCurrencies[language] || 'USD'; };
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
  function resolveCountry() {
    var params = new URLSearchParams(location.search);
    var explicit = String(params.get('country') || read(localStorage, countryKey)).toUpperCase();
    if (countries.indexOf(explicit) >= 0) return explicit;
    var tags = [params.get('lang')].concat(navigator.languages || [navigator.language]);
    for (var i = 0; i < tags.length; i++) {
      var tag = String(tags[i] || '');
      if (locale.normalize(tag) !== locale.current) continue;
      var region = tag.match(/-([A-Z]{2})(?:-|$)/i);
      if (region && countries.indexOf(region[1].toUpperCase()) >= 0) return region[1].toUpperCase();
    }
    return defaultCountries[locale.current] || 'US';
  }
  function money(amount, currency) {
    var formatter = new Intl.NumberFormat(locale.current, { style: 'currency', currency: currency });
    var digits = formatter.resolvedOptions().maximumFractionDigits;
    return formatter.format(Number(amount) / Math.pow(10, digits));
  }
  function referenceMoney(amount, currency) {
    if (displayCurrency === currency) return money(amount, currency);
    if (!exchangeRates || !exchangeRates.rates[currency] || !exchangeRates.rates[displayCurrency]) throw new Error(t('quoteFailed'));
    var digits = new Intl.NumberFormat(locale.current, { style:'currency', currency:currency }).resolvedOptions().maximumFractionDigits;
    var value = Number(amount) / Math.pow(10, digits) / exchangeRates.rates[currency] * exchangeRates.rates[displayCurrency];
    return '≈ ' + new Intl.NumberFormat(locale.current, { style:'currency', currency:displayCurrency }).format(value);
  }
  function quotedPrice(plan) { return quotes[plan] ? referenceMoney(quotes[plan].unitTotals.total, quotes[plan].currency) : '—'; }
  function loadExchangeRates() {
    if (ratesPromise) return ratesPromise;
    var cached;
    try { cached = JSON.parse(read(localStorage, rateKey)); } catch (error) {}
    function valid(value) { return value && value.result === 'success' && value.base_code === 'CNY' && value.rates && value.rates.CNY === 1 && Number.isFinite(value.time_last_update_unix) && value.time_last_update_unix <= Date.now()/1000 && Object.keys(localeCurrencies).every(function (lang) { var rate = value.rates[localeCurrencies[lang]]; return Number.isFinite(rate) && rate > 0; }); }
    if (valid(cached) && Date.now()/1000 - cached.time_last_update_unix < 86400) {
      exchangeRates = cached; ratesPromise = Promise.resolve(cached); return ratesPromise;
    }
    ratesPromise = fetch('https://open.er-api.com/v6/latest/CNY').then(function (response) {
      if (!response.ok) throw new Error(t('quoteFailed'));
      return response.json();
    }).then(function (data) {
      if (!valid(data)) throw new Error(t('quoteFailed'));
      exchangeRates = data; write(localStorage, rateKey, JSON.stringify(data)); return data;
    }).catch(function (error) { ratesPromise = null; throw error; });
    return ratesPromise;
  }
  function countryControl() {
    var names = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames([locale.current], { type: 'region' }) : null;
    var choices = countries.map(function (code) { return { code: code, name: names ? names.of(code) : code }; });
    choices.sort(function (a, b) { return a.name.localeCompare(b.name, locale.current); });
    return '<div class="field global-country"><label for="globalCountry">' + e('billingCountry') + '</label><select id="globalCountry" aria-describedby="globalCountryHelp">' + choices.map(function (choice) { return '<option value="' + choice.code + '"' + (choice.code === billingCountry ? ' selected' : '') + '>' + escape(choice.name) + '</option>'; }).join('') + '</select><p class="global-note" id="globalCountryHelp">' + e('countryHelp') + '</p><p id="globalRateDate" class="global-note"></p><p class="global-note"><a href="https://www.exchangerate-api.com" target="_blank" rel="noopener noreferrer">Rates By Exchange Rate API</a></p><p id="globalQuoteStatus" class="global-note" role="status" aria-live="polite">' + e('quoteLoading') + '</p><button type="button" class="global-action secondary" id="globalRetryQuote">' + e('retryPrice') + '</button></div>';
  }
  function shareLink() {
    var link = new URL('/one-time-pass/', location.origin);
    link.searchParams.set('lang', locale.current); link.searchParams.set('country', billingCountry); link.searchParams.set('currency', displayCurrency);
    link.searchParams.set('quantity', String(quantity() || 1));
    return link.toString();
  }
  function updateShare() {
    var input = document.getElementById('globalShare'); if (input) input.value = shareLink();
    if (window.history && window.history.replaceState) {
      var current = new URL(location.href); current.searchParams.set('country', billingCountry); current.searchParams.set('currency', displayCurrency);
      if (page === 'pass') current.searchParams.set('quantity', document.getElementById('globalQuantity').value);
      window.history.replaceState(null, '', current.toString());
    }
  }
  function checkoutSuccessUrl(plan) {
    var target = new URL(locale.successUrl(page === 'pass' ? '/one-time-pass/' : '/pricing/', plan));
    target.searchParams.set('country', billingCountry);
    target.searchParams.set('currency', displayCurrency);
    if (page === 'pass') target.searchParams.set('quantity', String(quantity() || 1));
    return target.toString();
  }
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
    var features = [t('maxVideo', { value: free ? t('minutes', { value: 10 }) : t('unlimited') }),
      t('conversions', { value: free ? 3 : plan === 'pro' ? 100 : '∞' }),
      t('ocr', { value: free ? 100 : plan === 'pro' ? new Intl.NumberFormat(locale.current).format(10000) : '∞' }),
      t('transcription', { value: free ? t('minutes', { value: 600 }) : '∞' }),
      free ? t('single') : t('batch'), t('exports')];
    return '<article class="global-card" data-card-plan="' + plan + '"><h2>' + e(plan) + '</h2><p>' + e(plan + 'Desc') + '</p><p class="price" data-price-plan="' + plan + '">' + (free ? e('free') : '—') + '</p><p class="cadence">' + (free ? e('free') : e(plan === 'pro' ? 'monthly' : 'oneOff')) + '</p><ul>' + features.map(function (feature) { return '<li>' + escape(feature) + '</li>'; }).join('') + '</ul>' +
      (free ? '<a class="global-action secondary" href="' + url('/#start') + '">' + e('start') + '</a>' : '<button class="global-action plan-button" type="button" data-plan="' + plan + '" aria-pressed="false">' + e('choose', { plan: t(plan) }) + '</button>') + '</article>';
  }
  function checkout() {
    var pass = page === 'pass';
    var fallback = locale.paddleLocale(locale.current) === 'en' && locale.current !== 'en';
    return '<section class="global-section global-checkout" id="globalCheckout"><div><h2>' + e('orderSummary') + '</h2><p id="globalSelected">' + (pass ? e('selected', { plan: t('day_pass') }) : e('selectPlan')) + '</p><p id="globalPlanTerms">' + (pass ? e('dayDesc') + ' ' + e('oneOff') : '') + '</p><p class="global-note">' + e('finalAmount') + '</p><p class="global-notice" id="globalChargeSummary"></p>' + (fallback ? '<p class="global-notice">' + e('checkoutEnglish') + '</p>' : '') + '<p class="global-note">' + e('secure') + '</p><p class="global-note">' + e('support') + '</p></div>' +
      '<form id="globalCheckoutForm" novalidate><div class="field"><label for="globalEmail">' + e('buyEmail') + '</label><input id="globalEmail" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" aria-describedby="globalEmailHelp" required /><p class="global-note" id="globalEmailHelp">' + e('emailHelp') + '</p></div>' +
      (pass ? '<div class="field"><label for="globalQuantity">' + e('quantity') + '</label><input id="globalQuantity" type="number" min="1" max="999999" step="1" inputmode="numeric" value="1" aria-describedby="globalQuantityHelp" required /><p class="global-note" id="globalQuantityHelp">' + e('quantityHelp', { min: passMinimum, max: passMaximum }) + '</p><p class="global-note">' + e('multiplePass') + '</p><div class="global-quantity-presets" role="group" aria-label="' + e('quantityPresets') + '">' + [1, 10, 100, 1000].map(function (count) { return '<button type="button" class="global-action secondary quantity-preset" data-quantity="' + count + '">' + new Intl.NumberFormat(locale.current).format(count) + '</button>'; }).join('') + '</div></div><div class="global-subtotal"><span>' + e('subtotal') + '</span><strong id="globalTotal">—</strong></div><div class="global-subtotal"><span>' + e('tax') + '</span><strong id="globalTax">—</strong></div><div class="global-subtotal global-total"><span>' + e('estimatedTotal') + '</span><strong id="globalGrandTotal">—</strong></div><div class="field"><label for="globalShare">' + e('shareLink') + '</label><input id="globalShare" type="url" readonly /><p class="global-note">' + e('shareHelp') + '</p></div>' : '') +
      '<button class="global-action" type="submit" id="globalPay"' + (pass ? '' : ' disabled') + '>' + e('continuePay') + '</button><p class="global-note">' + e('readPolicies') + ' <a href="' + url('/terms-and-conditions/') + '">' + e('terms') + '</a> · <a href="' + url('/refund/') + '">' + e('refund') + '</a></p><div class="global-status" id="globalPaymentStatus" role="status" aria-live="polite"></div><div class="global-actions"><button class="global-action secondary" type="button" id="globalRefresh">' + e('refresh') + '</button><a href="' + url('/#account') + '">' + e('login') + '</a></div><div class="global-status" id="globalEntitlementStatus" role="status" aria-live="polite">' + e('accountHelp') + '</div></form></section>';
  }
  function pricing() {
    return '<section class="global-hero"><div class="global-tag">Vid2PPT</div><h1>' + e('pricing') + '</h1><p>' + e('freeIntro') + '</p></section>' + countryControl() + '<div class="global-grid">' + ['free', 'pro', 'lifetime'].map(card).join('') + '</div>' +
      '<section class="global-section global-card" data-card-plan="day_pass"><h2>' + e('day_pass') + '</h2><p>' + e('dayDesc') + '</p><p class="price" data-price-plan="day_pass">' + '—' + '</p><p class="cadence">' + e('oneOff') + '</p><button class="global-action plan-button" type="button" data-plan="day_pass" aria-pressed="false">' + e('choose', { plan: t('day_pass') }) + '</button></section>' + checkout() +
      '<a href="' + url('/one-time-pass/') + '">' + e('passEntry') + '</a>' + workspaceNotice() + faq();
  }
  function pass() {
    return '<section class="global-hero"><div class="global-tag">Vid2PPT</div><h1>' + e('day_pass') + '</h1><p>' + e('dayDesc') + '</p><p><span id="globalUnitPrice">—</span> / ' + e('perPass') + ' · ' + e('oneOff') + '</p></section>' + countryControl() + checkout() + '<a href="' + url('/pricing/') + '">' + e('pricing') + '</a>' + workspaceNotice();
  }
  function setBusy(value) {
    busy = value;
    document.getElementById('globalPay').disabled = value || !selectedPlan || !quoteReady;
    document.getElementById('globalPay').textContent = t(value ? 'loading' : 'continuePay');
    document.getElementById('globalEmail').disabled = value;
    var quantity = document.getElementById('globalQuantity'); if (quantity) quantity.disabled = value;
    document.getElementById('globalCountry').disabled = value;
    document.querySelectorAll('.quantity-preset').forEach(function (button) { button.disabled = value; });
    document.querySelectorAll('.plan-button').forEach(function (button) { button.disabled = value; });
    document.getElementById('globalCheckoutForm').setAttribute('aria-busy', String(value));
  }
  function selectPlan(plan) {
    if (busy || !priceKeys[plan]) return;
    selectedPlan = plan;
    document.querySelectorAll('.plan-button').forEach(function (button) { button.setAttribute('aria-pressed', String(button.getAttribute('data-plan') === plan)); });
    document.querySelectorAll('[data-card-plan]').forEach(function (card) { card.classList.toggle('selected', card.getAttribute('data-card-plan') === plan); });
    document.getElementById('globalSelected').textContent = t('selected', { plan: t(plan) }) + ' · ' + quotedPrice(plan);
    document.getElementById('globalPlanTerms').textContent = t(plan === 'pro' ? 'monthly' : plan === 'lifetime' ? 'duringService' : 'dayDesc') + (plan === 'pro' ? '' : ' · ' + t('oneOff'));
    updateChargeSummary(); setBusy(false);
    document.getElementById('globalCheckout').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    document.getElementById('globalEmail').focus({ preventScroll: true });
  }
  function updateChargeSummary() {
    var quote = quotes[selectedPlan];
    document.getElementById('globalChargeSummary').textContent = quote ? t('chargeAmount', { amount: money(quote.totals.total, quote.currency) + ' (' + quote.currency + ')' }) : '';
  }
  function invalidatePrices() {
    quoteVersion++; quotes = {}; quoteReady = false;
    document.querySelectorAll('[data-price-plan]').forEach(function (node) { if (node.getAttribute('data-price-plan') !== 'free') node.textContent = '—'; });
    ['globalUnitPrice', 'globalTotal', 'globalTax', 'globalGrandTotal'].forEach(function (id) { var node = document.getElementById(id); if (node) node.textContent = '—'; });
    if (selectedPlan) document.getElementById('globalSelected').textContent = t('selected', { plan: t(selectedPlan) });
    updateChargeSummary();
    setBusy(busy);
  }
  function refreshPrices() {
    clearTimeout(quoteTimer); invalidatePrices();
    var version = quoteVersion, country = billingCountry, count = quantity();
    if (!count) { status('globalQuoteStatus', t('quantityValid', { min: passMinimum, max: passMaximum }), 'error'); return Promise.resolve(); }
    status('globalQuoteStatus', t('quoteLoading'));
    return Promise.all([ensurePaddle(), loadExchangeRates()]).then(function (results) {
      var config = results[0];
      var plans = page === 'pass' ? ['day_pass'] : ['pro', 'lifetime', 'day_pass'];
      var items = plans.map(function (plan) { if (!config[priceKeys[plan]]) throw new Error(t('unavailable')); return { priceId: config[priceKeys[plan]], quantity: page === 'pass' ? count : 1 }; });
      return window.Paddle.PricePreview({ items: items, address: { countryCode: country } }).then(function (response) {
        if (version !== quoteVersion) return;
        var data = response.data || {}, lines = data.details && data.details.lineItems || [];
        if (!/^[A-Z]{3}$/.test(data.currencyCode)) throw new Error(t('quoteFailed'));
        plans.forEach(function (plan) {
          var line = lines.find(function (item) { return item.price && item.price.id === config[priceKeys[plan]]; });
          if (!line || line.quantity !== (page === 'pass' ? count : 1) || !line.unitTotals || !line.totals || !['total','subtotal','tax'].every(function (key) { return /^\d+$/.test(String(line.unitTotals[key])) && /^\d+$/.test(String(line.totals[key])); })) throw new Error(t('quoteFailed'));
          quotes[plan] = { currency: data.currencyCode, unitTotals: line.unitTotals, totals: line.totals, quantity: line.quantity };
          if (plan === 'day_pass' && line.price.quantity) {
            passMinimum = Math.max(1, Number(line.price.quantity.minimum) || 1); passMaximum = Math.min(999999, Number(line.price.quantity.maximum) || 999999);
            var input = document.getElementById('globalQuantity');
            if (input) { input.min = String(passMinimum); input.max = String(passMaximum); document.getElementById('globalQuantityHelp').textContent = t('quantityHelp', { min: new Intl.NumberFormat(locale.current).format(passMinimum), max: new Intl.NumberFormat(locale.current).format(passMaximum) }); }
          }
        });
        if (!quantity()) throw new Error(t('quantityValid', { min: passMinimum, max: passMaximum }));
        quoteReady = true;
        document.querySelectorAll('[data-price-plan]').forEach(function (node) { var plan = node.getAttribute('data-price-plan'); if (plan !== 'free') node.textContent = quotedPrice(plan); });
        if (selectedPlan) document.getElementById('globalSelected').textContent = t('selected', { plan: t(selectedPlan) }) + ' · ' + quotedPrice(selectedPlan);
        if (page === 'pass') {
          var quote = quotes.day_pass;
          document.getElementById('globalUnitPrice').textContent = quotedPrice('day_pass');
          document.getElementById('globalTotal').textContent = referenceMoney(quote.totals.subtotal, quote.currency);
          document.getElementById('globalTax').textContent = referenceMoney(quote.totals.tax, quote.currency);
          document.getElementById('globalGrandTotal').textContent = referenceMoney(quote.totals.total, quote.currency);
        }
        updateChargeSummary();
        document.getElementById('globalRateDate').textContent = t('rateDate', { date:new Date(exchangeRates.time_last_update_unix*1000).toLocaleDateString(locale.current) });
        status('globalQuoteStatus', displayCurrency, 'ok'); setBusy(busy);
      });
    }).catch(function (error) {
      if (version !== quoteVersion) return;
      quotes = {}; quoteReady = false; setBusy(busy);
      status('globalQuoteStatus', error.message || t('quoteFailed'), 'error');
    });
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
          checkout: { settings: { locale: locale.paddleLocale(locale.current), successUrl: checkoutSuccessUrl() } },
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
    return Number.isInteger(value) && value >= passMinimum && value <= passMaximum ? value : 0;
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
      document.getElementById('globalQuantity').focus(); status('globalPaymentStatus', t('quantityValid', { min: passMinimum, max: passMaximum }), 'error'); return;
    }
    if (!quoteReady || !quotes[selectedPlan] || quotes[selectedPlan].quantity !== count) {
      var requestedCountry = billingCountry, requestedPlan = selectedPlan;
      status('globalPaymentStatus', t('quoteLoading'));
      refreshPrices().then(function () {
        if (quoteReady && quantity() === count && billingCountry === requestedCountry && selectedPlan === requestedPlan) openCheckout(event);
      }); return;
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
        items: [{ priceId: priceId, quantity: count }], customer: { email: email, address: { countryCode: billingCountry } },
        customData: { email: email, plan: selectedPlan, source: page === 'pass' ? 'one_time_pass_page' : 'pricing_page',
          order_kind: page === 'pass' ? 'one_time_pass' : 'membership', quantity: count, billing_quantity: count,
          pass_quantity: selectedPlan === 'day_pass' ? count : 1,
          username: user && user.username || '', account_id: user && user.id || '',
          site_locale: locale.current, checkout_locale: locale.paddleLocale(locale.current), billing_country: billingCountry, quoted_currency: quotes[selectedPlan].currency, display_currency: displayCurrency },
        settings: { displayMode: 'overlay', theme: 'light', locale: locale.paddleLocale(locale.current),
          successUrl: checkoutSuccessUrl(selectedPlan) }
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
    document.getElementById('globalCountry').value = billingCountry;
    document.getElementById('globalCountry').addEventListener('change', function () {
      billingCountry = this.value; displayCurrency = countryCurrencies[billingCountry] || 'USD'; write(localStorage, countryKey, billingCountry); refreshPrices(); updateShare();
    });
    document.getElementById('globalRetryQuote').addEventListener('click', refreshPrices);
    var input = document.getElementById('globalQuantity');
    if (input) {
      var requested = new URLSearchParams(location.search).get('quantity');
      if (requested !== null) input.value = requested;
      input.addEventListener('input', function () {
        this.removeAttribute('aria-invalid'); invalidatePrices(); updateShare();
        clearTimeout(quoteTimer); quoteTimer = setTimeout(refreshPrices, 250);
      });
      document.querySelectorAll('.quantity-preset').forEach(function (button) { button.addEventListener('click', function () {
        if (busy) return; input.value = button.getAttribute('data-quantity'); input.removeAttribute('aria-invalid'); refreshPrices(); updateShare();
      }); });
      updateShare();
    }
    refreshPrices(); updateShare();
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
    if (document.documentElement.removeAttribute) document.documentElement.removeAttribute('data-global-loading');
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
    if (document.documentElement.removeAttribute) document.documentElement.removeAttribute('data-global-loading');
    document.body.innerHTML = '<main class="global-error"><h1>Vid2PPT</h1><p>Unable to load this page. Please reload or contact <a href="mailto:info@vid2ppt.com">info@vid2ppt.com</a>.</p></main>';
  });
}());
