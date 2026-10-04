(function () {
  var locale = window.Vid2PPTLocale;
  if (!locale) return;
  // Direct workspace/account links continue to open the existing application.
  var params = new URLSearchParams(location.search);
  if (/^txn_[a-z0-9]+$/.test(params.get('_ptxn') || '')) {
    var checkout = new URL(locale.url('/pricing/'), location.origin);
    checkout.searchParams.set('_ptxn', params.get('_ptxn'));
    location.replace(checkout.toString());
    return;
  }
  if (!/^#(?:start|account|workspace)$/.test(location.hash) && locale.current !== 'zh-CN') {
    location.replace(locale.url('/welcome/'));
    return;
  }
  var nav = document.querySelector('.site-nav');
  if (nav) {
    var menu = document.createElement('details');
    menu.id = 'globalRegionMenu'; menu.className = 'global-region';
    var summary = document.createElement('summary');
    summary.className = 'region-summary';
    summary.setAttribute('aria-label', locale.current === 'zh-CN' ? '选择语言' : 'Choose language');
    summary.innerHTML = '<svg class="region-globe" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a16 16 0 0 1 0 18 16 16 0 0 1 0-18Z"/></svg>';
    var flag = document.createElement('span');
    flag.className = 'region-flag'; flag.setAttribute('aria-hidden', 'true'); flag.textContent = locale.languageFlag(locale.current);
    summary.appendChild(flag);
    var name = document.createElement('span');
    name.className = 'region-label'; name.textContent = locale.languageLabel(locale.current);
    summary.appendChild(name);
    var chevron = document.createElement('span');
    chevron.className = 'region-chevron-wrap';
    chevron.innerHTML = '<svg class="region-chevron" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>';
    summary.appendChild(chevron); menu.appendChild(summary);
    var panel = document.createElement('div'); panel.className = 'region-panel';
    var field = document.createElement('div'); field.className = 'field';
    var label = document.createElement('label');
    label.setAttribute('for', 'siteLanguage'); label.textContent = '语言 / Language';
    field.appendChild(label);
    var languageControl = document.createElement('span'); languageControl.id = 'languageControl';
    languageControl.appendChild(locale.selector('Language / 语言')); field.appendChild(languageControl);
    panel.appendChild(field); menu.appendChild(panel); nav.appendChild(menu);
    document.addEventListener('click', function (event) { if (!menu.contains(event.target)) menu.open = false; });
    menu.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { menu.open = false; summary.focus(); }
    });
    if (locale.current !== 'zh-CN') {
      var link = document.createElement('a');
      link.href = locale.url('/welcome/'); link.textContent = 'Vid2PPT · ' + locale.languageLabel(locale.current);
      nav.appendChild(link);
    }
  }
  document.querySelectorAll('a[href^="/pricing"], a[href^="/one-time-pass"]').forEach(function (link) {
    link.href = locale.url(link.getAttribute('href'));
  });
}());
