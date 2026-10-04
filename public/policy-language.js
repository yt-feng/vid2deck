(function (root) {
  'use strict';
  var document = root.document;
  var policyPaths = ['privacy', 'terms-and-conditions', 'refund'];
  var page = root.location.pathname.replace(/^\/+|\/+$/g, '');
  if (!document || policyPaths.indexOf(page) < 0) return;
  var locale = root.Vid2PPTLocale;
  var params = new URLSearchParams(root.location.search);
  var requested = params.get('lang');
  var selected = (locale && locale.current) || 'en';
  // An explicitly selected non-Chinese language uses the English policy text.
  if (requested && !/^zh(?:-|_|$)/i.test(requested)) {
    selected = (locale && locale.normalize(requested)) || 'en';
  }
  var chinese = /^zh(?:-|_|$)/i.test(requested || selected);
  var main = document.querySelector('main.doc');
  if (!main) return;

  function linkLabel(href, labels) {
    var url = new URL(href, root.location.origin);
    if (url.pathname === '/' && url.hash === '#workspace') return labels.workspace;
    if (url.pathname === '/' && url.hash === '#account') return labels.account;
    if (/^\/pricing\/?$/.test(url.pathname)) return labels.pricing;
    if (/^\/contact\/?$/.test(url.pathname)) return labels.contact;
    if (/^\/privacy\/?$/.test(url.pathname)) return labels.privacy;
    if (/^\/terms-and-conditions\/?$/.test(url.pathname)) return labels.terms;
    if (/^\/refund\/?$/.test(url.pathname)) return labels.refund;
    return '';
  }
  function preserveLanguage() {
    document.querySelectorAll('a[href]').forEach(function (link) {
      var raw = link.getAttribute('href');
      // Page anchors retain the current query; email and external links are unchanged.
      if (!raw || raw.charAt(0) !== '/' || raw.indexOf('//') === 0) return;
      var url = new URL(raw, root.location.origin);
      if (url.pathname === '/' && !url.hash) url.pathname = '/welcome/';
      url.searchParams.set('lang', selected);
      link.setAttribute('href', url.pathname + url.search + url.hash);
    });
  }
  function languageNote(text) {
    var previous = document.getElementById('policyLanguageNote');
    if (previous) previous.remove();
    var note = document.createElement('p');
    note.id = 'policyLanguageNote';
    note.className = 'updated policy-language-note';
    note.setAttribute('role', 'note');
    note.textContent = text;
    var updated = main.querySelector('.updated');
    main.insertBefore(note, updated ? updated.nextSibling : main.firstChild);
  }
  function englishNavigation(labels) {
    var skip = document.querySelector('.skip-link');
    if (skip) skip.textContent = labels.skip;
    var brand = document.querySelector('.brand');
    if (brand) brand.setAttribute('aria-label', labels.home);
    document.querySelectorAll('.site-nav').forEach(function (nav) { nav.setAttribute('aria-label', labels.navigation); });
    document.querySelectorAll('header a:not(.brand), footer a').forEach(function (link) {
      var label = linkLabel(link.getAttribute('href'), labels);
      if (label) link.textContent = label;
    });
  }

  preserveLanguage();
  if (chinese) {
    document.documentElement.setAttribute('lang', 'zh-CN');
    document.documentElement.setAttribute('dir', 'ltr');
    if (selected === 'zh-TW') languageNote('政策文本语言：简体中文。');
    root.Vid2PPTPolicyReady = Promise.resolve({ language: 'zh-CN', selected: selected });
    return;
  }

  main.setAttribute('aria-busy', 'true');
  root.Vid2PPTPolicyReady = root.fetch('/policies/en.json', { credentials: 'same-origin' })
    .then(function (response) {
      if (!response.ok) throw new Error('Policy text unavailable');
      return response.json();
    })
    .then(function (payload) {
      var policy = payload && payload.policies && payload.policies[page];
      if (payload.language !== 'en' || !policy || typeof policy.main !== 'string' || !payload.labels) throw new Error('Invalid policy text');
      // This HTML is maintained with the site and loaded only from this fixed same-origin asset.
      main.innerHTML = policy.main;
      document.title = policy.title;
      var description = document.querySelector('meta[name="description"]');
      if (description) description.setAttribute('content', policy.description);
      document.documentElement.setAttribute('lang', 'en');
      document.documentElement.setAttribute('dir', 'ltr');
      englishNavigation(payload.labels);
      if (selected !== 'en') {
        var name = locale && locale.languageLabel ? locale.languageLabel(selected) : selected;
        languageNote('Policy language: English. Your selected site language is ' + name + '. These policies are available in English and Simplified Chinese.');
      }
      preserveLanguage();
      if (root.location.hash) {
        var target = document.getElementById(root.location.hash.slice(1));
        if (target) target.scrollIntoView();
      }
      return { language: 'en', selected: selected };
    })
    .catch(function () {
      // Retain the complete original policy and identify its language if loading fails.
      document.documentElement.setAttribute('lang', 'zh-CN');
      document.documentElement.setAttribute('dir', 'ltr');
      languageNote('English policy text could not be loaded. The original Simplified Chinese policy is shown below. Contact info@vid2ppt.com for help.');
      return { language: 'zh-CN', selected: selected, unavailable: true };
    })
    .finally(function () { main.removeAttribute('aria-busy'); });
}(typeof window === 'undefined' ? globalThis : window));
