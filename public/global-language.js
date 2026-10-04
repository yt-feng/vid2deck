(function (root) {
  'use strict';
  var languages = [
    ['en', 'English'], ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['es', 'Español'],
    ['fr', 'Français'], ['de', 'Deutsch'], ['pt', 'Português'], ['pt-BR', 'Português (Brasil)'],
    ['it', 'Italiano'], ['ja', '日本語'], ['ko', '한국어'], ['ar', 'العربية'], ['ru', 'Русский'],
    ['hi', 'हिन्दी'], ['id', 'Bahasa Indonesia'], ['tr', 'Türkçe'], ['vi', 'Tiếng Việt'],
    ['th', 'ไทย'], ['nl', 'Nederlands'], ['pl', 'Polski'], ['sv', 'Svenska'], ['da', 'Dansk'],
    ['no', 'Norsk'], ['fi', 'Suomi'], ['cs', 'Čeština'], ['uk', 'Українська'], ['ro', 'Română'],
    ['hu', 'Magyar'], ['el', 'Ελληνικά'], ['he', 'עברית'], ['bn', 'বাংলা'], ['ms', 'Bahasa Melayu'], ['tl', 'Filipino']
  ];
  var paddleLanguages = ['en', 'es', 'fr', 'de', 'pt', 'pt-BR', 'it', 'ja', 'ko', 'ar', 'ru', 'tr', 'nl', 'pl', 'sv', 'da', 'no'];
  var languageCountries = {
    en: 'US', 'zh-CN': 'CN', 'zh-TW': 'TW', es: 'ES', fr: 'FR', de: 'DE', pt: 'PT', 'pt-BR': 'BR',
    it: 'IT', ja: 'JP', ko: 'KR', ar: 'AE', ru: 'RU', hi: 'IN', id: 'ID', tr: 'TR', vi: 'VN',
    th: 'TH', nl: 'NL', pl: 'PL', sv: 'SE', da: 'DK', no: 'NO', fi: 'FI', cs: 'CZ', uk: 'UA',
    ro: 'RO', hu: 'HU', el: 'GR', he: 'IL', bn: 'BD', ms: 'MY', tl: 'PH'
  };
  var storageKey = 'vid2ppt.language';
  function normalize(value) {
    var tag = String(value || '').trim().replace(/_/g, '-').toLowerCase();
    if (/^zh(?:-|$)/.test(tag)) return /(?:hant|tw|hk|mo)/.test(tag) ? 'zh-TW' : 'zh-CN';
    if (/^pt-br(?:-|$)/.test(tag)) return 'pt-BR';
    var base = tag.split('-')[0];
    if (base === 'nb' || base === 'nn') base = 'no';
    if (base === 'fil') base = 'tl';
    return languages.some(function (item) { return item[0] === base; }) ? base : '';
  }
  function readSaved() { try { return root.localStorage.getItem(storageKey) || ''; } catch (error) { return ''; } }
  function resolveLanguage(query, saved, browserLanguages) {
    var explicit = normalize(query);
    if (explicit) return explicit;
    var stored = normalize(saved);
    if (stored) return stored;
    for (var i = 0; i < (browserLanguages || []).length; i++) {
      var detected = normalize(browserLanguages[i]);
      if (detected) return detected;
    }
    return 'en';
  }
  function paddleLocale(locale) {
    var normalized = normalize(locale) || 'en';
    if (normalized === 'zh-CN') return 'zh-Hans';
    if (normalized === 'zh-TW') return 'zh-TW';
    return paddleLanguages.indexOf(normalized) >= 0 ? normalized : 'en';
  }
  function countryFlag(country) {
    var code = String(country || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) return '';
    return String.fromCodePoint(0x1F1E6 + code.charCodeAt(0) - 65, 0x1F1E6 + code.charCodeAt(1) - 65);
  }
  function languageLabel(code) {
    var normalized = normalize(code) || 'en';
    var language = languages.find(function (item) { return item[0] === normalized; });
    return language[1];
  }
  function languageFlag(code) { return countryFlag(languageCountries[normalize(code) || 'en']); }
  var query = new URLSearchParams(root.location.search).get('lang');
  var current = resolveLanguage(query, readSaved(), (root.navigator && (root.navigator.languages || [root.navigator.language])) || []);
  if (/^\/(?:pricing|one-time-pass)\/?$/.test(root.location.pathname) && root.document && root.document.documentElement && root.document.documentElement.setAttribute) {
    root.document.documentElement.setAttribute('data-global-loading', 'true');
  }
  function save(locale) { try { root.localStorage.setItem(storageKey, normalize(locale) || 'en'); } catch (error) {} }
  if (normalize(query)) save(current);
  function localizedUrl(path, locale) {
    var url = new URL(path, root.location.origin);
    url.searchParams.set('lang', normalize(locale || api.current) || 'en');
    return url.pathname + url.search + url.hash;
  }
  function successUrl(path, plan) {
    var url = new URL(localizedUrl(path), root.location.origin);
    url.searchParams.set('checkout', 'success');
    if (plan) url.searchParams.set('plan', plan);
    return url.toString();
  }
  function languageSelector(label) {
    var select = root.document.createElement('select');
    select.id = 'siteLanguage';
    select.setAttribute('aria-label', label || 'Language');
    select.className = 'language-select region-language-select';
    select.setAttribute('dir', 'auto');
    languages.forEach(function (item) {
      var option = root.document.createElement('option');
      option.value = item[0]; option.textContent = languageFlag(item[0]) + ' ' + item[1]; option.selected = item[0] === api.current;
      option.setAttribute('lang', item[0]);
      option.setAttribute('dir', 'auto');
      select.appendChild(option);
    });
    select.addEventListener('change', function () {
      save(select.value);
      var url = new URL(root.location.href);
      url.searchParams.set('lang', select.value);
      if (api.currencyForLanguage && /^\/(?:pricing|one-time-pass)\/?$/.test(url.pathname)) url.searchParams.set('currency', api.currencyForLanguage(select.value));
      if (url.pathname === '/' && select.value !== 'zh-CN' && !/^#(?:start|account|workspace)$/.test(url.hash)) { url.pathname = '/welcome/'; url.hash = ''; }
      if (url.pathname === '/welcome/' && select.value === 'zh-CN') url.pathname = '/';
      root.location.assign(url.toString());
    });
    return select;
  }
  var api = { languages: languages, current: current, normalize: normalize, resolve: resolveLanguage,
    paddleLocale: paddleLocale, url: localizedUrl, successUrl: successUrl, save: save, selector: languageSelector,
    flag: countryFlag, languageLabel: languageLabel, languageFlag: languageFlag };
  root.Vid2PPTLocale = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window === 'undefined' ? globalThis : window));
