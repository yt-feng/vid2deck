import './landing.css';

const footer = document.querySelector('.site-footer');
const landing = document.createElement('section');
landing.className = 'landing-content';
landing.innerHTML = `
  <section class="landing-block proof-block">
    <p class="landing-kicker">Why Vid2Deck</p>
    <h2>面向课程、会议和教程视频的轻量工作台</h2>
    <p class="landing-lead">视频处理尽量在浏览器本地完成，适合把录屏、网课、讲座和演示视频快速整理成 PDF、Frames ZIP、逐字稿和 Summary。</p>
    <div class="proof-grid">
      <article><strong>本地优先</strong><span>视频默认不上传服务器，更适合课程、会议和项目资料。</span></article>
      <article><strong>去重抽帧</strong><span>自动跳过相似画面，保留更像 PPT 页面的关键帧。</span></article>
      <article><strong>可编辑输出</strong><span>导出前可勾选、删除、裁剪，也能从时间轴补抓。</span></article>
      <article><strong>批量打包</strong><span>多个视频可一次处理并下载 Frames ZIP。</span></article>
    </div>
  </section>

  <section id="cases" class="landing-block">
    <p class="landing-kicker">Use Cases</p>
    <h2>三类最常见的使用场景</h2>
    <div class="case-grid">
      <article class="case-card course"><div><h3>网课和讲座</h3><p>把长视频整理成去重后的 PDF，方便复习、标注和二次整理。</p></div><span>课程笔记</span></article>
      <article class="case-card meeting"><div><h3>会议录屏</h3><p>从屏幕共享和演示录屏中提取关键页，减少手动截图。</p></div><span>会议复盘</span></article>
      <article class="case-card batch"><div><h3>批量资料归档</h3><p>多个视频一次抽帧，下载 Frames ZIP 后继续做 OCR 或资料库整理。</p></div><span>批量处理</span></article>
    </div>
  </section>

  <section id="reviews" class="landing-block">
    <p class="landing-kicker">Feedback</p>
    <h2>用户评价区</h2>
    <p class="landing-lead">这里先放真实反馈入口和场景占位。等有真实用户授权后，再替换成具体头像、姓名、公司和评价内容。</p>
    <div class="review-grid">
      <article><strong>课程学习场景</strong><span>适合展示“省掉手动截图时间、复习资料更完整”的真实反馈。</span></article>
      <article><strong>会议复盘场景</strong><span>适合展示“录屏自动整理，复盘材料更快交付”的真实反馈。</span></article>
      <article><strong>批量处理场景</strong><span>适合展示“多个视频一次导出，方便归档”的真实反馈。</span></article>
    </div>
  </section>

  <section class="landing-block cta-block">
    <div>
      <p class="landing-kicker">Pricing</p>
      <h2>从免费试用开始，按需升级</h2>
      <p>免费版适合试用，专业版适合长视频、批量处理和高频转写，终身版适合长期整理课程和会议资料。</p>
    </div>
    <a href="/pricing/">查看定价</a>
  </section>
`;

if (footer) {
  footer.parentNode?.insertBefore(landing, footer);
} else {
  document.body.appendChild(landing);
}
