import './landing.css';

const details = document.querySelector<HTMLDivElement>('#landingDetails');

if (details) {
  details.innerHTML = `
    <section class="result-story" id="how-it-works" aria-labelledby="workflowTitle">
      <div class="section-heading">
        <div><p class="section-kicker">视频笔记效果</p><h2 id="workflowTitle">课程重点，<br />翻开笔记就能看。</h2></div>
        <div class="section-intro"><p>原画面配上时间位置，方便浏览和回看。AI 要点可按需生成，笔记支持下载保存。</p><button class="text-action" data-open-demo type="button">查看示例笔记 <span aria-hidden="true">↗</span></button></div>
      </div>
      <div class="result-visual" aria-label="使用演示素材制作的视频笔记效果示意">
        <div class="video-strip-card">
          <div class="mock-window-bar"><span></span><span></span><span></span><b>课程录屏.mp4</b><small>效果示意</small></div>
          <div class="mock-video"><div class="mock-slide"><strong>如何把新知识用起来</strong><p>核心概念 · 案例 · 应用方法</p><i></i><i></i><i></i></div><div class="mock-speaker" aria-hidden="true"></div><span class="mock-duration">00:42</span></div>
          <div class="mock-timeline" aria-label="5 个采样画面，合并其中的 2 个重复画面"><span class="is-kept">01</span><span class="is-duplicate">重复</span><span class="is-duplicate">重复</span><span class="is-kept">02</span><span class="is-kept">03</span></div>
          <p>自动提取画面、记录时间，合并重复页面。</p>
        </div>
        <div class="result-arrow" aria-hidden="true">→</div>
        <div class="deck-result-card note-result-card">
          <div class="deck-result-heading"><strong>我的课程笔记</strong><span>原画面 + 时间位置</span></div>
          <div class="note-preview-page"><span class="note-preview-time">01 · 00:42</span><strong>如何把新知识用起来</strong><div class="note-preview-diagram" aria-label="概念到应用的示意"><span>理解概念</span><i aria-hidden="true">→</i><span>看一个案例</span><i aria-hidden="true">→</i><span>试着应用</span></div><small>保留视频里真正出现的页面</small></div>
          <div class="note-preview-insights"><span>可选 · AI 要点示意</span><p>用自己的话解释概念，找一个案例验证，记录可尝试的方法。</p></div>
          <div class="export-choice"><span>笔记阅读</span><span>HTML / Markdown</span><span>PPTX / PDF</span></div>
          <p class="result-caption">以上为效果示意。原画面笔记无需登录；AI 要点需登录并按额度生成。</p>
        </div>
      </div>
      <ol class="workflow-grid">
        <li><span>01</span><div><strong>放入一段视频</strong><p>选择课程、培训或行业分享录屏，也可以粘贴支持的视频链接。</p></div></li>
        <li><span>02</span><div><strong>阅读画面笔记</strong><p>自动提取并合并相似画面，保留时间位置。删除多余页面，补充遗漏画面。</p></div></li>
        <li><span>03</span><div><strong>保存笔记</strong><p>按需生成 AI 要点，或直接导出笔记、PDF 与 PPTX，留给下次复习。</p></div></li>
      </ol>
    </section>

    <section class="difference-section" id="features" aria-labelledby="featuresTitle">
      <div class="section-heading compact"><div><p class="section-kicker">阅读与导出</p><h2 id="featuresTitle">图表、要点、时间位置，一起保存。</h2></div></div>
      <div class="difference-grid">
        <article class="feature-card"><span class="feature-symbol" aria-hidden="true">▧</span><h3>保留原始图表</h3><p>保留课程里的原始图表、标注和时间位置。复习时知道这一页来自哪里。</p><span class="feature-detail">打开笔记即可翻阅原画面</span></article>
        <article class="feature-card"><span class="feature-symbol" aria-hidden="true">✓</span><h3>提炼内容要点</h3><p>语音转成逐字稿后，可登录生成 AI 要点。原画面支持直接查看和导出。</p><span class="feature-detail">AI 整理基于逐字稿，保留原页供回看</span></article>
        <article class="feature-card"><span class="feature-symbol" aria-hidden="true">↗</span><h3>选择保存格式</h3><p>用 HTML 离线阅读，用 Markdown 保存笔记，或导出 PPTX、PDF 和图片继续整理。</p><span class="feature-detail">支持常用文档与笔记格式</span></article>
      </div>
      <div class="fit-note"><strong>从一段有课件的视频开始</strong><p>画面清晰、页面相对稳定的课程、培训和行业分享最合适。纯聊天、只有讲师出镜或快速动画的视频，原画面笔记的信息量可能有限；AI 要点还取决于语音与逐字稿质量。</p></div>
    </section>

    <section class="use-case-section" id="use-cases" aria-labelledby="useCasesTitle">
      <div class="section-heading compact"><div><p class="section-kicker">适合整理这些视频</p><h2 id="useCasesTitle">课程、培训与行业分享。</h2></div></div>
      <div class="use-case-grid">
        <article><span class="case-icon" aria-hidden="true">课</span><div><h3>复习课程</h3><p>把课程页面整理成可翻阅的笔记，浏览课程框架，按时间位置回看重点。</p><span class="case-output">留下 · 原画面笔记与 PDF 讲义</span><a href="#start" aria-label="开始整理课程视频">整理我的课程 <span aria-hidden="true">↗</span></a></div></article>
        <article><span class="case-icon" aria-hidden="true">训</span><div><h3>查阅培训方法</h3><p>把培训中的流程、步骤和示例整理在一起，工作时打开笔记就能查阅。</p><span class="case-output">留下 · 步骤截图与时间位置</span><a href="#start" aria-label="开始整理培训录屏">整理培训录屏 <span aria-hidden="true">↗</span></a></div></article>
        <article><span class="case-icon" aria-hidden="true">研</span><div><h3>整理行业分享</h3><p>保留关键图表，按需提炼观点。准备下一次讨论时，有原页可以核对。</p><span class="case-output">留下 · 原始图表与 AI 要点</span><a href="#start" aria-label="开始整理行业分享">整理一段分享 <span aria-hidden="true">↗</span></a></div></article>
      </div>
    </section>

    <section class="pricing-preview" aria-labelledby="pricingPreviewTitle">
      <div><p class="section-kicker">免费试用</p><h2 id="pricingPreviewTitle">用一段短视频，做一份笔记。</h2><p>免费版支持 10 分钟以内的视频，每月 3 次转换。原画面笔记无需注册即可查看和导出；AI 要点需登录，按套餐额度生成。</p><a class="inline-link" href="/pricing/">查看完整套餐与额度 <span aria-hidden="true">→</span></a></div>
      <div class="pricing-start"><strong>¥0<span>开始使用</span></strong><a class="primary-link" href="#start">整理我的第一份笔记 <span aria-hidden="true">→</span></a><small>更长视频、更多次数与批量处理可按需升级。</small></div>
    </section>

    <section class="faq-section" id="faq" aria-labelledby="faqTitle">
      <div class="section-heading compact"><div><p class="section-kicker">常见问题</p><h2 id="faqTitle">使用中常见的问题。</h2></div><a class="inline-link" href="/guide/">查看完整使用指南 →</a></div>
      <div class="faq-grid">
        <details><summary>没有视频文件，从哪里开始？</summary><p>已有课程或会议文件可以直接导入；公开视频可以尝试链接导入；手机或云盘中的视频可下载为文件后导入。只有课程观看入口时，可向提供方索取原始 MP4，或在获得允许后录制。<a href="/guide/#get-video">按你的来源，查看一步步教程</a>。</p></details>
        <details><summary>导出的 PPTX 可以编辑吗？</summary><p>默认每页以视频画面作为底图，保留原始视觉效果。需要改文字时，可以对选中页面运行文字识别，生成可编辑文本框。复杂图表和图片以原画面保存，图形元素保持整图形式。</p></details>
        <details><summary>本地视频会上传到服务器吗？</summary><p>本地视频和屏幕录制默认在浏览器中读取、抽帧、去重和导出。使用在线视频链接时，服务端需要临时获取视频；生成摘要等联网功能会发送必要文本。<a href="/privacy/">查看隐私说明</a>。</p></details>
        <details><summary>支持哪些视频来源和格式？</summary><p>支持浏览器能够解码的 MP4、WebM、MOV 等格式；也支持 B 站、YouTube 和部分公开视频链接。播放兼容性取决于文件内部编码；遇到格式问题时，可转换为 H.264 编码的 MP4 后重试。部分链接会受来源平台限制。<a href="/guide/#troubleshooting">查看导入与声音问题的处理方法</a>。</p></details>
        <details><summary>重复页太多，或者漏掉页面怎么办？</summary><p>使用默认设置提取后，可在工作台逐页检查。重复页可删除，漏页可在时间轴定位后补抓；动画较多时可提高相似页合并强度，快速换页时可缩短检查间隔。</p></details>
        <details><summary>免费额度如何计算？需要登录吗？</summary><p>无需注册即可开始。免费版每月支持 3 次、每段最多 10 分钟的视频转换；交互示例可免费体验，保留全部额度。免费额度记录在当前浏览器，登录后可查看和同步账号权益。具体能力与额度请见<a href="/pricing/">套餐页面</a>。</p></details>
        <details><summary>原画面笔记和 AI 笔记有什么区别？</summary><p>原画面笔记把提取出的页面和时间位置排成可阅读的资料，无需登录。AI 笔记根据逐字稿提炼内容，需登录并使用相应额度；附带的视频页面用于回看参考，与文字段落的对应关系需要手动核对。</p></details>
        <details><summary>需要等多久？可以关掉页面吗？</summary><p>页面会随处理陆续出现，提取完成后就能阅读和导出。转写与 AI 整理按需运行，耗时取决于视频长度、设备性能和服务响应；首次语音识别还需加载模型。处理时请保持页面打开。</p></details>
      </div>
    </section>

    <section class="final-cta" aria-labelledby="finalCtaTitle">
      <div><p class="section-kicker">开始整理</p><h2 id="finalCtaTitle">把一段视频，存成一份笔记。</h2><p>选择一段 10 分钟内的视频即可开始，原画面笔记免注册。也可以通过交互示例体验阅读和导出。</p></div>
      <div class="final-cta-actions"><a href="#start">开始整理视频 <span aria-hidden="true">→</span></a><button class="text-action" data-open-demo type="button">查看示例笔记</button></div>
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
