import './landing.css';

const details = document.querySelector<HTMLDivElement>('#landingDetails');

if (details) {
  details.innerHTML = `
    <section class="result-story" id="how-it-works" aria-labelledby="workflowTitle">
      <div class="section-heading">
        <div><p class="section-kicker">从视频到资料</p><h2 id="workflowTitle">看过的内容，<br />变成留得住的页面。</h2></div>
        <div class="section-intro"><p>自动识别换页、合并相似画面。先检查每一页，再把需要的内容带走。</p><button class="text-action" data-open-demo type="button">体验示例工作台 <span aria-hidden="true">↗</span></button></div>
      </div>
      <div class="result-visual" aria-label="视频页面提取流程示意，非实际转换结果">
        <div class="video-strip-card">
          <div class="mock-window-bar"><span></span><span></span><span></span><b>课程录屏.mp4</b><small>流程示意</small></div>
          <div class="mock-video"><div class="mock-slide"><strong>把重要的内容留下来</strong><p>课程 · 图表 · 讲解顺序</p><i></i><i></i><i></i></div><div class="mock-speaker" aria-hidden="true"></div><span class="mock-duration">00:42</span></div>
          <div class="mock-timeline" aria-label="5 个采样画面，合并其中的 2 个重复画面"><span class="is-kept">01</span><span class="is-duplicate">重复</span><span class="is-duplicate">重复</span><span class="is-kept">02</span><span class="is-kept">03</span></div>
          <p>相似画面自动合并，减少重复整理。</p>
        </div>
        <div class="result-arrow" aria-hidden="true">→</div>
        <div class="deck-result-card">
          <div class="deck-result-heading"><strong>你的页面资料</strong><span>检查后导出</span></div>
          <div class="deck-thumbs"><div class="deck-thumb blue"><span>01</span><b>核心概念</b></div><div class="deck-thumb orange"><span>02</span><b>案例拆解</b></div><div class="deck-thumb green"><span>03</span><b>结论回顾</b></div></div>
          <div class="export-choice"><span>PPTX 演示</span><span>PDF 阅读</span><span>图片复用</span></div>
          <p class="result-caption">默认导出原画面；需要修改文字时，可再运行文字识别。</p>
        </div>
      </div>
      <ol class="workflow-grid">
        <li><span>01</span><div><strong>导入视频</strong><p>选择本地文件、粘贴链接，或录制屏幕。</p></div></li>
        <li><span>02</span><div><strong>检查与调整</strong><p>预览页面，删除重复、补抓漏页，按需裁剪。</p></div></li>
        <li><span>03</span><div><strong>选择格式导出</strong><p>勾选需要的页面，下载 PPTX、PDF 或图片。</p></div></li>
      </ol>
    </section>

    <section class="difference-section" id="features" aria-labelledby="featuresTitle">
      <div class="section-heading compact"><div><p class="section-kicker">围绕原始内容，保留你的选择</p><h2 id="featuresTitle">提取够快，结果也能自己检查。</h2></div></div>
      <div class="difference-grid">
        <article class="feature-card"><span class="feature-symbol" aria-hidden="true">▧</span><h3>保留原画面</h3><p>保留视频里出现的页面、图表和标注，按讲解顺序整理。</p><span class="feature-detail">适合找回原课件</span></article>
        <article class="feature-card"><span class="feature-symbol" aria-hidden="true">✓</span><h3>导出前可调整</h3><p>勾选、排序、裁剪和补抓，把自动提取的结果整理到可用。</p><span class="feature-detail">每一页由你决定</span></article>
        <article class="feature-card"><span class="feature-symbol" aria-hidden="true">⌂</span><h3>本地视频在本机处理</h3><p>本地文件与录屏在浏览器中抽帧、去重和导出。</p><a class="feature-detail" href="#faq">了解联网功能的处理方式 →</a></article>
      </div>
      <div class="fit-note"><strong>什么视频效果更好？</strong><p>画面清晰、页面相对稳定的课程、会议分享和软件教程。快速动画、镜头频繁切换的视频需要更多手动检查；仅有讲师出镜时，不会自动生成一套课件。</p></div>
    </section>

    <section class="use-case-section" id="use-cases" aria-labelledby="useCasesTitle">
      <div class="section-heading compact"><div><p class="section-kicker">按你的用途开始</p><h2 id="useCasesTitle">一段视频，可以有不同的去处。</h2></div></div>
      <div class="use-case-grid">
        <article><span class="case-icon" aria-hidden="true">课</span><div><h3>课程复习</h3><p>把课程里的页面整理成讲义，按顺序复习和标注。</p><span class="case-output">推荐导出 · PDF</span><a href="#start" aria-label="开始整理课程视频">整理我的课程 <span aria-hidden="true">↗</span></a></div></article>
        <article><span class="case-icon" aria-hidden="true">会</span><div><h3>会后资料</h3><p>从会议或培训录屏中找回分享页，交付会后材料。</p><span class="case-output">推荐导出 · PPTX</span><a href="#start" aria-label="开始整理会议录屏">整理会议录屏 <span aria-hidden="true">↗</span></a></div></article>
        <article><span class="case-icon" aria-hidden="true">作</span><div><h3>素材复用</h3><p>把教程和产品演示拆成页面，用于笔记、文档或知识库。</p><span class="case-output">推荐导出 · 页面图片</span><a href="#start" aria-label="开始提取视频素材">提取视频素材 <span aria-hidden="true">↗</span></a></div></article>
      </div>
    </section>

    <section class="pricing-preview" aria-labelledby="pricingPreviewTitle">
      <div><p class="section-kicker">先用自己的视频试一试</p><h2 id="pricingPreviewTitle">免费开始，按需要升级。</h2><p>免费版支持 10 分钟以内的视频，每月 3 次转换。无需注册，处理后可预览并导出。</p><a class="inline-link" href="/pricing/">查看完整套餐与额度 <span aria-hidden="true">→</span></a></div>
      <div class="pricing-start"><strong>¥0<span>开始使用</span></strong><a class="primary-link" href="#start">免费提取页面 <span aria-hidden="true">→</span></a><small>更长视频、更多次数与批量处理可按需升级。</small></div>
    </section>

    <section class="faq-section" id="faq" aria-labelledby="faqTitle">
      <div class="section-heading compact"><div><p class="section-kicker">常见问题</p><h2 id="faqTitle">开始前，再确认几件事。</h2></div><a class="inline-link" href="/contact/">联系支持 ↗</a></div>
      <div class="faq-grid">
        <details><summary>导出的 PPTX 可以编辑吗？</summary><p>默认每页以视频画面作为底图，保留原始视觉效果。需要改文字时，可以对选中页面运行文字识别，生成可编辑文本框。复杂图表和图片仍保留为原画面，不会自动还原为原始图形对象。</p></details>
        <details><summary>本地视频会上传到服务器吗？</summary><p>本地视频和屏幕录制默认在浏览器中读取、抽帧、去重和导出。使用在线视频链接时，服务端需要临时获取视频；生成摘要等联网功能会发送必要文本。<a href="/privacy/">查看隐私说明</a>。</p></details>
        <details><summary>支持哪些视频来源和格式？</summary><p>支持浏览器能够解码的 MP4、WebM、MOV 等格式；也支持 B 站、YouTube 和部分公开视频链接。文件扩展名不代表一定可解码；遇到格式问题时，可先转为 H.264 编码的 MP4 后重试。部分链接会受来源平台限制。</p></details>
        <details><summary>重复页太多，或者漏掉页面怎么办？</summary><p>先用默认设置提取，再在工作台逐页检查。重复页可删除，漏页可在时间轴定位后补抓；动画较多时可提高相似页合并强度，快速换页时可缩短检查间隔。</p></details>
        <details><summary>免费额度如何计算？需要登录吗？</summary><p>无需注册即可开始。免费版每月支持 3 次、每段不超过 10 分钟的视频转换；交互示例不计入额度。免费额度记录在当前浏览器，登录后可查看和同步账号权益。具体能力与额度请见<a href="/pricing/">套餐页面</a>。</p></details>
        <details><summary>页面、逐字稿和摘要会一起生成吗？</summary><p>视频页面提取完成后，可以直接检查并导出。逐字稿、摘要和图文笔记可在工作台按需生成，耗时与视频长度、设备性能有关，不必等待这些内容完成才下载页面。</p></details>
      </div>
    </section>

    <section class="final-cta" aria-labelledby="finalCtaTitle">
      <div><p class="section-kicker">从第一段视频开始</p><h2 id="finalCtaTitle">少做截图，多用内容。</h2><p>免费试用无需注册，也可以先体验一个完整示例。</p></div>
      <div class="final-cta-actions"><a href="#start">选择我的视频 <span aria-hidden="true">→</span></a><button class="text-action" data-open-demo type="button">先体验交互示例</button></div>
    </section>
  `;

  // Keep the independent tools within the discovery flow, before questions and the closing action.
  const utilities = document.querySelector<HTMLElement>('#more-tools');
  const faq = details.querySelector<HTMLElement>('#faq');
  if (utilities && faq) details.insertBefore(utilities, faq);
}

const navigation = document.querySelector<HTMLElement>('.site-nav');
const menuToggle = document.querySelector<HTMLButtonElement>('#navMenuToggle');
const navLinks = document.querySelector<HTMLElement>('#siteNavLinks');
const narrowNavigation = window.matchMedia('(max-width: 1080px)');

function closeNavigation(restoreFocus = false): void {
  if (!navigation || !menuToggle) return;
  navigation.dataset.menuOpen = 'false';
  menuToggle.setAttribute('aria-expanded', 'false');
  menuToggle.setAttribute('aria-label', '打开导航菜单');
  if (restoreFocus) menuToggle.focus();
}

menuToggle?.addEventListener('click', () => {
  const isOpen = menuToggle.getAttribute('aria-expanded') === 'true';
  if (isOpen) closeNavigation();
  else {
    if (navigation) navigation.dataset.menuOpen = 'true';
    menuToggle.setAttribute('aria-expanded', 'true');
    menuToggle.setAttribute('aria-label', '关闭导航菜单');
  }
});
navLinks?.addEventListener('click', (event) => {
  if ((event.target as HTMLElement).closest('a, button')) closeNavigation();
});
document.addEventListener('click', (event) => {
  if (navigation?.dataset.menuOpen === 'true' && !navigation.contains(event.target as Node)) closeNavigation();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && navigation?.dataset.menuOpen === 'true') {
    event.preventDefault();
    closeNavigation(true);
  }
});
narrowNavigation.addEventListener('change', () => closeNavigation());

document.querySelectorAll<HTMLButtonElement>('[data-open-demo]').forEach((button) => {
  button.addEventListener('click', () => document.querySelector<HTMLButtonElement>('#openDemoProjectBtn')?.click());
});

function navigateToSection(hash: string, smooth = true): void {
  if (hash === '#workspace') {
    document.querySelector<HTMLButtonElement>('#openWorkspaceBtn')?.click();
    closeNavigation();
    return;
  }
  let anchor: string;
  try { anchor = decodeURIComponent(hash.slice(1)); } catch { return; }
  const target = anchor ? document.getElementById(anchor) : null;
  if (!target) return;
  const workspace = document.querySelector<HTMLElement>('#workspaceView');
  if (workspace && !workspace.hidden) document.querySelector<HTMLButtonElement>('#doneBtn')?.click();
  if (anchor === 'account') document.querySelector<HTMLButtonElement>('#openLoginBtn')?.click();
  closeNavigation();
  requestAnimationFrame(() => {
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    // The login handler moves focus to the first relevant account field.
    if (anchor !== 'account') target.focus({ preventScroll: true });
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: smooth && !reducedMotion ? 'smooth' : 'instant', block: 'start' });
  });
  navLinks?.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((link) => {
    if (link.hash === hash) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
}

document.addEventListener('click', (event) => {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
  const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#"]');
  if (!link?.hash || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
  if (link.hash !== '#workspace' && !document.getElementById(decodeURIComponent(link.hash.slice(1)))) return;
  event.preventDefault();
  if (window.location.hash !== link.hash) history.pushState(history.state, '', link.hash);
  navigateToSection(link.hash);
});
window.addEventListener('hashchange', () => navigateToSection(window.location.hash || '#product'));
document.querySelector<HTMLButtonElement>('#doneBtn')?.addEventListener('click', () => {
  if (window.location.hash === '#workspace') history.replaceState(history.state, '', '#start');
});
if (window.location.hash) requestAnimationFrame(() => navigateToSection(window.location.hash, false));
