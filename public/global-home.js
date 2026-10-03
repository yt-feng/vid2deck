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
    nav.appendChild(locale.selector('Language / 语言'));
    if (locale.current !== 'zh-CN') {
      var link = document.createElement('a');
      link.href = locale.url('/welcome/'); link.textContent = 'Vid2PPT · ' + locale.current;
      nav.appendChild(link);
    }
  }
  document.querySelectorAll('a[href^="/pricing"], a[href^="/one-time-pass"]').forEach(function (link) {
    link.href = locale.url(link.getAttribute('href'));
  });
}());
