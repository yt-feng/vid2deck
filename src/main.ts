import type { jsPDF as JsPdfDocument } from 'jspdf';
import JSZip from 'jszip';
import { cropTextBoxes } from './cropGeometry';
import { paintPdfTextBoxes } from './pdfTextLayer';
import './style.css';
import { readDraft, writeDraft } from './workspaceDraft';

type Slide = {
  id: number;
  time: number;
  hash: bigint;
  dataUrl: string;
  width: number;
  height: number;
  selected: boolean;
  textBoxes: SlideTextBox[];
};

type SlideTextBox = {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  color: string;
  bold: boolean;
  align: 'left' | 'center' | 'right';
};

type OcrBBox = { x0: number; y0: number; x1: number; y1: number };
type OcrLine = { text: string; confidence: number; bbox: OcrBBox };
type OcrParagraph = { lines?: OcrLine[]; text: string; confidence: number; bbox: OcrBBox };
type OcrBlock = { paragraphs?: OcrParagraph[]; text: string; confidence: number; bbox: OcrBBox };
type OcrPage = { blocks?: OcrBlock[] | null; text?: string; confidence?: number };
type OcrWorker = {
  recognize: (image: HTMLCanvasElement, options?: unknown, output?: { text?: boolean; blocks?: boolean }) => Promise<{ data: OcrPage }>;
  setParameters: (params: Record<string, string>) => Promise<unknown>;
  terminate: () => Promise<unknown>;
};
type TesseractApi = {
  createWorker: (langs: string[] | string, oem?: number, options?: Record<string, unknown>) => Promise<OcrWorker>;
  PSM?: { SPARSE_TEXT?: string; AUTO?: string };
};
type PdfViewport = { width: number; height: number };
type PdfRenderTask = { promise: Promise<void> };
type PdfPage = {
  getViewport: (options: { scale: number }) => PdfViewport;
  render: (options: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }) => PdfRenderTask;
};
type PdfDocument = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPage>;
  cleanup?: () => void;
  destroy?: () => Promise<void> | void;
};
type PdfJsApi = {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (source: { data: ArrayBuffer }) => { promise: Promise<PdfDocument> };
};
type NotebookMaskBox = { x: number; y: number; width: number; height: number; detected: boolean };
type Rgb = { r: number; g: number; b: number };
type PaddleConfig = {
  PADDLE_ENV?: string;
  PADDLE_CLIENT_TOKEN?: string;
  PADDLE_PRICE_AUTHOR_TIP_CNY_CENT?: string;
};
type PaddleApi = {
  Environment?: { set: (environment: string) => void };
  Initialize: (options: { token: string; eventCallback?: (event: unknown) => void }) => void;
  Checkout: {
    open: (options: {
      items: { priceId: string; quantity: number }[];
      customData?: Record<string, string | number | boolean>;
      settings?: { displayMode?: string; theme?: string; successUrl?: string };
    }) => void;
  };
};

type Settings = {
  sampleEvery: number;
  duplicateThreshold: number;
  minGap: number;
};

type OutputLanguage = 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ko';
type UserPreferences = {
  outputLanguage: OutputLanguage;
};

type AuthMode = 'login' | 'register';
type AuthUser = {
  id?: string;
  username: string;
  email: string;
  email_is_generated?: boolean;
};
type AuthSession = {
  token: string;
  user: AuthUser;
};
type AuthResponse = {
  token?: string;
  user?: AuthUser;
  admin_token?: string;
  detail?: string;
};

type PlanKey = 'free' | 'day_pass' | 'pro' | 'lifetime';
type PlanLimits = {
  video_max_minutes: number | null;
  video_conversions_monthly: number | null;
  editable_slides_monthly: number | null;
  summary_generations_monthly: number | null;
  transcribe_minutes_monthly: number | null;
  batch_processing: boolean;
  image_pptx: boolean;
  screen_recording: boolean;
};
type EntitlementPayload = {
  email: string;
  plan: string;
  effective_plan?: string;
  status?: string;
  lifetime?: boolean;
  current_period_end?: string | null;
  active: boolean;
  owner?: boolean;
  limits?: Partial<PlanLimits>;
  updated_at?: string;
};
type UsageEventType = 'video_conversion' | 'editable_slide' | 'summary_generation' | 'transcribe_minute';
type UsageSummary = {
  email: string;
  period?: string;
  period_start: string;
  monthly: Record<string, number>;
};

type CapturedFrame = {
  index: number;
  time: number;
  hash: bigint;
  dataUrl: string;
  width: number;
  height: number;
};

type VideoMeta = { duration: number; width: number; height: number };
type FrameExtractor = { capture: (index: number, time: number) => Promise<CapturedFrame>; dispose: () => void };
type JobStatus = 'queued' | 'processing' | 'done' | 'error';
type UrlDownloadMode = 'queue' | 'extract';
type MediaMetadata = {
  sourceType: 'url';
  provider: string;
  url: string;
  finalUrl?: string;
  title?: string;
  authorName?: string;
  authorUrl?: string;
  thumbnailUrl?: string;
  durationSeconds?: number | null;
  contentType?: string;
  contentLength?: string | null;
  formatCount?: number;
  downloadable?: boolean;
  allowedActions?: string[];
  policy?: {
    downloadAllowed?: boolean;
    reason?: string;
  };
};

type FileJobState = {
  slides: Slide[];
  transcript: string;
  summary: string;
  illustratedNotes: string;
  videoMeta: VideoMeta | null;
  status: JobStatus;
  error?: string;
  processedAt?: string;
};

type WorkerResult =
  | { type: 'ready' }
  | { type: 'model-progress'; status: string; progress?: number }
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id?: number; error: string };

type WorkspaceMode = 'video' | 'image';

const VISUAL_HASH_BITS = 320;
const FRAME_CONCURRENCY = 3;
const TRANSCRIBE_CHUNK_SECONDS = 30;
const TRANSCRIBE_CONTEXT_SECONDS = 2;
const TIMELINE_PAINT_INTERVAL_MS = 220;
const IMAGE_DECK_MAX_EDGE = 2400;
const PPTX_SLIDE_WIDTH_EMU = 12192000;
const PPTX_SLIDE_HEIGHT_EMU = 6858000;
const TESSERACT_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';
const OCR_LANGUAGES = ['eng', 'chi_sim'];
const OCR_MAX_EDGE = 2800;
const OCR_MIN_CONFIDENCE = 35;
const PDFJS_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
const PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
const PDF_RENDER_SCALE = 2;
const PDF_RENDER_MAX_EDGE = 3200;
const NOTEBOOK_MASK_FALLBACK_WIDTH = 0.09;
const NOTEBOOK_MASK_FALLBACK_HEIGHT = 0.045;
const NOTEBOOK_MASK_MARGIN = 0.012;
const PADDLE_SCRIPT_URL = 'https://cdn.paddle.com/paddle/v2/paddle.js';
const AUTH_STORAGE_KEY = 'vid2deck.auth.session';
const ADMIN_TOKEN_STORAGE_KEY = 'vid2deck.admin.token';
const ADMIN_USERNAME = 'twotigers_vid';
const PREFERENCES_STORAGE_PREFIX = 'vid2deck.preferences';
const CHECKOUT_EMAIL_STORAGE_KEY = 'vid2deck.checkout.email';
const USAGE_STORAGE_KEY = 'vid2deck.usage.monthly';
const CLOUD_DOWNLOADER_URL = '/api/download-video';
const YOUTUBE_FALLBACK_URL = '/api/youtube-fallback';
const MEDIA_METADATA_URL = '/api/media/metadata';
const TIP_AMOUNTS = [10, 20, 50, 80, 100, 200] as const;
const TIP_MIN_AMOUNT = 1;
const TIP_MIN_CHECKOUT_AMOUNT = 10;
const TIP_MAX_QUANTITY = 999999;
const FREE_PLAN_LIMITS: PlanLimits = {
  video_max_minutes: 10,
  video_conversions_monthly: 3,
  editable_slides_monthly: 100,
  summary_generations_monthly: 10,
  transcribe_minutes_monthly: 600,
  batch_processing: false,
  image_pptx: true,
  screen_recording: true
};
const USAGE_UNITS: Record<UsageEventType, string> = {
  video_conversion: '次',
  editable_slide: '张',
  summary_generation: '次',
  transcribe_minute: '分钟'
};
const SUMMARY_API_URL = '/api/summarize-simple';
const OUTPUT_LANGUAGE_LABELS: Record<OutputLanguage, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁体中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어'
};
const DEFAULT_USER_PREFERENCES: UserPreferences = { outputLanguage: 'zh-CN' };

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app');

app.innerHTML = `
  <main id="homeView">
    <section class="hero-shell" id="product">
      <div class="hero-copy">
        <p class="eyebrow">视频转 PPT · 无需注册即可试用</p>
        <h1>把视频里的课件，<br />整理成可用资料。</h1>
        <p class="subhead">放入课程、会议或教程视频，自动提取并去重。检查页面后，带走保留原画面的 PPTX、PDF 或图片。</p>
        <div class="hero-demo-action">
          <button id="openDemoProjectBtn" type="button">先看交互示例</button>
          <span>无需上传，不计入免费额度</span>
        </div>
        <ul class="hero-benefits" aria-label="产品优势">
          <li><strong>本地处理</strong><span>本地视频与录屏默认不离开设备</span></li>
          <li><strong>保留原版式</strong><span>提取原始画面，不用 AI 重写内容</span></li>
          <li><strong>导出前可检查</strong><span>漏页能补抓，重复页可删除</span></li>
        </ul>
        <div class="hero-output-row" aria-label="支持导出格式">
          <span>PPTX</span><span>PDF</span><span>页面图片</span><span>逐字稿</span><span>图文笔记</span>
        </div>
      </div>

      <section id="start" tabindex="-1" class="video-panel converter-card" aria-label="开始转换视频">
        <div class="converter-heading">
          <div>
            <span class="step-chip">01</span>
            <h2>选择你的视频来源</h2>
          </div>
          <small id="sourceQuota">免费版 · 10 分钟以内 · 每月 3 次</small>
        </div>

        <div class="source-tabs" role="tablist" aria-label="视频来源">
          <button id="sourceLocalTab" type="button" role="tab" aria-selected="true" aria-controls="sourceLocal" data-source="local">本地文件</button>
          <button id="sourceUrlTab" type="button" role="tab" aria-selected="false" aria-controls="sourceUrl" data-source="url" tabindex="-1">视频链接</button>
          <button id="sourceRecordTab" type="button" role="tab" aria-selected="false" aria-controls="sourceRecord" data-source="record" tabindex="-1">录制屏幕</button>
        </div>
        <div id="sourceLocal" role="tabpanel" aria-labelledby="sourceLocalTab">
        <div class="local-source-row">
          <label class="dropzone" id="dropzone" for="videoInput" role="button" tabindex="0">
            <input id="videoInput" type="file" multiple accept="video/*,audio/*,.mkv,.mov,.mp4,.webm,.avi,.m4v" />
            <span class="upload-mark" aria-hidden="true">＋</span>
            <span id="fileLabel">拖入视频，或点击选择文件</span>
            <small>MP4、WebM、MOV 等 · 在你的设备上处理</small>
          </label>

        </div>

        </div>
        <div id="sourceUrl" role="tabpanel" aria-labelledby="sourceUrlTab" hidden>
        <form id="videoUrlForm" class="url-import">
          <label class="sr-only" for="videoUrlInput">在线视频链接</label>
          <div class="url-input-shell">
            <span class="input-leading" aria-hidden="true">↗</span>
            <input id="videoUrlInput" type="url" inputmode="url" placeholder="粘贴 B 站、YouTube 或公开视频链接" autocomplete="off" />
          </div>
          <div class="url-import-actions">
            <button id="processUrlBtn" type="button">立即生成</button>
            <button id="downloadUrlBtn" type="button" class="ghost-btn">仅导入</button>
          </div>
          <div id="urlDownloadProgress" class="url-download-progress" hidden>
            <div class="url-download-progress-meta">
              <span id="urlDownloadProgressText">准备获取视频</span>
              <strong id="urlDownloadProgressPercent">0%</strong>
            </div>
            <div class="url-download-progress-track"><div id="urlDownloadProgressFill" class="url-download-progress-fill"></div></div>
          </div>
          <div id="mediaPreview" class="media-preview" hidden>
            <img id="mediaPreviewImage" alt="" hidden />
            <div class="media-preview-body">
              <div class="media-preview-heading">
                <p id="mediaPreviewProvider" class="eyebrow">视频来源</p>
                <h3 id="mediaPreviewTitle">已识别视频</h3>
              </div>
              <p id="mediaPreviewMeta" class="media-preview-meta"></p>
              <p id="mediaPreviewPolicy" class="media-preview-policy"></p>
              <label id="mediaRightsLabel" class="rights-confirm">
                <input id="mediaRightsConfirm" type="checkbox" />
                <span>我确认有权保存、转换或分析这个视频。</span>
              </label>
            </div>
          </div>
          <small id="urlDownloadStatus" class="url-download-status">在线链接会由服务端临时获取；完成导入后立即清理临时文件。</small>
        </form>

        </div>
        <div id="sourceRecord" class="record-source-panel" role="tabpanel" aria-labelledby="sourceRecordTab" hidden>
          <strong>把正在播放的课程录下来</strong>
          <p>选择一个标签页、窗口或屏幕。停止录制后，自动提取页面。</p>
          <div class="source-actions">
            <button id="recordScreenBtn" type="button" class="record-btn"><span aria-hidden="true">●</span> 直接录屏</button>
            <button id="stopRecordBtn" type="button" class="danger-btn" hidden>停止录制并开始生成</button>
            <small>适合在线课程、会议和无法下载的视频</small>
          </div>        </div>
        <div id="resumeDraftBanner" class="resume-banner" hidden>
          <span id="resumeDraftText">上次的任务已保存在此浏览器</span>
          <button id="resumeDraftBtn" type="button">继续上次任务</button>
          <button id="dismissDraftBtn" type="button" class="ghost-btn" aria-label="收起上次任务提示">×</button>
        </div>
        <div id="fileList" class="file-list" hidden></div>

        <details class="advanced-settings">
          <summary>调整页面识别灵敏度</summary>
          <div class="grid">
            <label>检查间隔（秒）<input id="sampleEvery" type="number" min="0.5" step="0.5" value="1" /></label>
            <label>相似页合并强度<input id="duplicateThreshold" type="number" min="1" max="20" step="0.5" value="4" /></label>
            <label>最短换页间隔（秒）<input id="minGap" type="number" min="0" step="0.5" value="3" /></label>
          </div>
          <p class="hint">默认设置适合大多数录屏和课程视频。页面切换很快时可缩短检查间隔；动画较多时可提高合并强度。</p>
        </details>

        <div class="actions converter-actions">
          <button id="extractBtn" disabled>选择文件后开始提取</button>
          <button id="batchZipBtn" class="ghost-btn" disabled hidden>批量处理并打包</button>
          <button id="downloadFramesZipBtn" class="ghost-btn" disabled hidden>下载已完成的页面图片</button>
        </div>

        <p id="batchPlanHint" class="hint" hidden>多个文件可以逐个处理，<a href="/pricing/" target="_blank" rel="noopener">升级套餐</a>可批量生成。</p>
        <div class="status" id="homeStatus" aria-live="polite">选择文件后即可开始，无需注册。</div>
      </section>
    </section>

    <div id="landingDetails"></div>

    <section class="utility-section" id="more-tools">
      <div class="section-heading compact">
        <div>
          <p class="section-kicker">更多输入方式</p>
          <h2>已有图片或 NotebookLM PDF？也能直接整理</h2>
        </div>
        <p>这些工具独立运行，不会打断你的视频任务。</p>
      </div>
      <div class="utility-grid">
        <section class="panel image-ppt-panel">
          <div class="panel-heading">
            <div><p class="eyebrow">图片转 PPT</p><h3>多张图片合成 PPTX</h3></div>
          </div>
          <label class="dropzone image-dropzone" id="imageDropzone" for="imageInput" role="button" tabindex="0">
            <input id="imageInput" type="file" multiple accept="image/png,image/jpeg,image/webp" />
            <span id="imageFileLabel">选择或拖入一组图片</span>
            <small>一张图片对应一页；需要改文字时可进入编辑工作台。</small>
          </label>
          <div id="imageFileList" class="file-list image-file-list" hidden></div>
          <div class="actions">
            <button id="imagePptBtn" disabled>生成图片版 PPTX</button>
            <button id="imageWorkspaceBtn" class="ghost-btn" disabled>识别文字后编辑</button>
          </div>
          <div class="status" id="imageStatus" aria-live="polite">选择图片后即可生成。</div>
        </section>

        <section class="panel notebook-pdf-panel">
          <div class="panel-heading">
            <div><p class="eyebrow">PDF 清理</p><h3>清理 NotebookLM 页脚标识</h3></div>
          </div>
          <label class="dropzone notebook-pdf-dropzone" id="notebookPdfDropzone" for="notebookPdfInput" role="button" tabindex="0">
            <input id="notebookPdfInput" type="file" accept="application/pdf,.pdf" />
            <span id="notebookPdfFileLabel">选择或拖入 NotebookLM PDF</span>
            <small>在设备上识别并遮盖右下角标识，再下载新 PDF。</small>
          </label>
          <div id="notebookPdfInfo" class="pdf-file-info" hidden></div>
          <div class="actions"><button id="notebookMaskPdfBtn" disabled>清理并下载 PDF</button></div>
          <div class="status" id="notebookPdfStatus" aria-live="polite">选择 PDF 后即可清理。</div>
        </section>
      </div>
    </section>

    <section class="account-panel" id="account" aria-label="用户账号">
      <div class="account-copy">
        <p class="eyebrow">账号与权益</p>
        <h2>偶尔用不必登录，跨设备同步权益时再登录</h2>
        <p id="accountStatus" class="account-status">免费额度记录在当前浏览器；登录后可同步套餐与付费权益；输出语言保存在当前浏览器。</p>
      </div>
      <form id="authForm" class="auth-form">
        <label>用户名<input id="authUsername" type="text" autocomplete="username" placeholder="3–32 位用户名" required minlength="3" maxlength="32" /></label>
        <label id="authEmailLabel">邮箱（可选）<input id="authEmail" type="email" autocomplete="email" placeholder="you@example.com" /></label>
        <label>密码<input id="authPassword" type="password" autocomplete="current-password" placeholder="请输入密码" required minlength="6" /></label>
        <label class="captcha-field">验证
          <div class="captcha-row">
            <img id="authCaptchaImage" alt="算式验证码" />
            <button id="refreshAuthCaptchaBtn" class="ghost-btn" type="button" aria-label="换一张验证码">换一张</button>
          </div>
          <input id="authCaptchaAnswer" type="text" inputmode="numeric" autocomplete="off" placeholder="输入算式结果" required />
        </label>
        <div class="auth-actions">
          <button id="authSubmitBtn" type="submit">登录</button>
          <button id="authModeToggleBtn" class="ghost-btn" type="button">没有账号？免费注册</button>
        </div>
      </form>
      <div id="authSignedIn" class="auth-signed-in" hidden>
        <div><span>当前账号</span><strong id="authSignedInName">-</strong><small id="authSignedInEmail">-</small></div>
        <div class="auth-signed-in-actions">
          <button id="openAccountSettingsBtn" class="ghost-btn" type="button">输出偏好</button>
          <button id="authLogoutBtn" class="ghost-btn" type="button">退出登录</button>
        </div>
      </div>
    </section>

    <section class="support-author-panel" aria-label="联系支持">
      <div>
        <p class="eyebrow">需要帮助？</p>
        <h2>特殊编码、超长视频或转换结果不理想，我们可以一起排查。</h2>
      </div>
      <button id="openTipDialogBtn" type="button">联系支持</button>
    </section>
  </main>

  <main id="workspaceView" class="workspace" hidden>
    <aside class="workspace-rail" aria-label="应用导航">
      <button id="railHomeBtn" class="rail-logo" type="button" title="回到 Vid2PPT 首页" aria-label="回到 Vid2PPT 首页"><img src="/brand/vid2ppt-mark.svg" alt="" /></button>
      <button id="railWorkspaceBtn" class="rail-item is-active" type="button">工作台</button>
      <button id="railOrdersBtn" class="rail-item" type="button">套餐权益</button>

      <a class="rail-item" href="/contact/" target="_blank" rel="noopener" title="在新窗口联系支持">联系我们</a>
      <button id="railSettingsBtn" class="rail-item" type="button">设置</button>
      <button id="railLoginBtn" class="rail-item" type="button">账号</button>
    </aside>

    <section class="workspace-main">
      <header class="workspace-bar">
        <button id="doneBtn" class="ghost-btn">回主页</button>
        <button id="toggleSideBtn" class="ghost-btn" aria-expanded="false" title="预览、文字编辑与笔记">编辑与笔记</button>
        <div class="workspace-title">
          <strong>工作台</strong>
          <small id="workspaceSubtitle">处理视频后，在这里勾选、预览和导出。</small>
        </div>
        <label class="select-all-control">
          <input id="selectAllBox" type="checkbox" checked />
          <span>全选</span>
          <small id="selectCount">0/0</small>
        </label>
        <div class="workspace-spacer"></div>
        <button id="downloadPdfBtn" hidden disabled>导出 PDF</button>
        <button id="downloadPptxBtn" hidden disabled>导出 PPTX</button>
        <button id="toggleImportBtn" class="ghost-btn" type="button" aria-expanded="true" aria-controls="workspaceImport">添加视频</button>
      </header>
      <ol class="workspace-steps" aria-label="转换步骤">
        <li data-step="source">1 选择来源</li><li data-step="extract">2 提取页面</li><li data-step="review">3 检查与导出</li>
      </ol>
      <section class="result-dock" id="resultDock" aria-live="polite">
        <div class="result-summary">
          <span id="resultBadge" class="result-badge">等待处理</span>
          <div>
            <strong id="resultTitle">等待生成页面</strong>
            <small id="resultSubtitle">生成页面后，导出入口会固定显示在这里。</small>
          </div>
        </div>
        <div class="result-actions">
          <button id="dockDownloadPdfBtn" class="primary-download" disabled>导出 PDF</button>
          <button id="dockDownloadPptxBtn" disabled>导出 PPTX</button>
          <button id="dockDownloadFramesBtn" disabled>导出页面图片</button>
          <button id="dockNotesBtn" hidden disabled>生成图文笔记</button>
        </div>
      </section>

      <section id="workspaceImport" class="workspace-command-bar" aria-label="导入视频">
        <form id="workspaceVideoUrlForm" class="workspace-url-import">
          <label>在线视频链接
            <input id="workspaceVideoUrlInput" type="url" inputmode="url" placeholder="粘贴 B站、YouTube 或公开视频链接" autocomplete="off" />
          </label>
          <label class="workspace-rights-confirm">
            <input id="workspaceRightsConfirm" type="checkbox" />
            <span>我确认有权处理这个视频</span>
          </label>
          <div class="workspace-url-actions">
            <button id="workspaceProcessUrlBtn" type="button">获取并开始生成</button>
            <button id="workspaceDownloadUrlBtn" class="ghost-btn" type="button">仅导入</button>
          </div>
          <small id="workspaceUrlStatus">粘贴链接后会直接进入获取视频和页面生成流程。</small>
        </form>
        <label class="workspace-file-dropzone" id="workspaceDropzone" for="workspaceVideoInput" role="button" tabindex="0">
          <input id="workspaceVideoInput" type="file" multiple accept="video/*,audio/*,.mkv,.mov,.mp4,.webm,.avi,.m4v" />
          <strong>选择本地视频</strong>
          <small>也可以拖到这里</small>
        </label>
        <div class="workspace-import-actions">
          <button id="workspaceRecordScreenBtn" type="button">录制屏幕</button>
          <button id="workspaceStopRecordBtn" class="danger-btn" type="button" hidden>停止录制并生成</button>
          <button id="emptyWorkspaceStartBtn" class="ghost-btn" type="button">开始当前任务</button>
        </div>
      </section>

      <section class="task-feedback" aria-label="任务状态">        <div class="progress-panel" id="progressPanel" hidden>
          <div class="progress-meta"><span id="progressText">准备开始</span><strong id="progressPercent">0%</strong></div>
          <div class="progress-track" id="progressTrack" role="progressbar" aria-label="处理进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="progress-fill" id="progressFill"></div></div>
        </div>

        <button id="cancelExtractionBtn" class="ghost-btn" type="button" hidden>停止提取</button>
        <div class="status" id="status" role="status" aria-live="polite">等待处理。</div>

<small id="draftStatus">当前任务只保存在本机；可用时自动保存最近一次任务</small></section>
      <section class="workspace-body">
        <aside class="workspace-side">
          <div class="preview-card">
            <img id="previewImage" alt="当前页面原始画面" />
            <small class="preview-caption">原始画面参考 · 文字修改见页面缩略图</small>
            <div id="previewEmpty" class="preview-empty">生成后会在这里预览当前页面</div>
          </div>

        <section class="export-panel" hidden aria-label="导出选中页面">
          <div>
            <strong>导出选中页面</strong>
            <small id="exportHint">生成完成后，从这里下载你勾选的页面。</small>
          </div>
          <div class="export-actions">
            <button id="sideDownloadPdfBtn" disabled>下载 PDF</button>
            <button id="sideDownloadPptxBtn" disabled>下载 PPTX</button>
            <button id="sideDownloadFramesBtn" disabled>下载页面图片</button>
          </div>
        </section>

        <details class="editor-disclosure"><summary>编辑页面文字 <small>OCR 与文本框</small></summary><section class="text-layer-panel" aria-label="可编辑文本框">
          <div class="text-layer-heading">
            <div>
              <strong>可编辑文本框</strong>
              <small id="textLayerHint">识别勾选页面的文字后，可在这里修改文本框。</small>
            </div>
            <div class="text-layer-buttons">
              <button id="runOcrBtn" type="button" disabled>识别勾选页文字</button>
              <button id="addTextBoxBtn" type="button" disabled>手动补文本框</button>
            </div>
          </div>
          <textarea id="textBoxContent" placeholder="选择或添加文本框后，在这里输入文字。" disabled></textarea>
          <div class="text-box-grid">
            <label>X %<input id="textBoxX" type="number" min="0" max="100" step="1" disabled /></label>
            <label>Y %<input id="textBoxY" type="number" min="0" max="100" step="1" disabled /></label>
            <label>宽 %<input id="textBoxWidth" type="number" min="5" max="100" step="1" disabled /></label>
            <label>高 %<input id="textBoxHeight" type="number" min="5" max="100" step="1" disabled /></label>
            <label>字号<input id="textBoxFontSize" type="number" min="8" max="96" step="1" disabled /></label>
            <label>颜色<input id="textBoxColor" type="color" value="#111827" disabled /></label>
          </div>
          <div class="text-box-options">
            <label><input id="textBoxBold" type="checkbox" disabled />粗体</label>
            <label>对齐
              <select id="textBoxAlign" disabled>
                <option value="left">左对齐</option>
                <option value="center">居中</option>
                <option value="right">右对齐</option>
              </select>
            </label>
            <button id="deleteTextBoxBtn" type="button" disabled>删除文本框</button>
          </div>
        </section>

        </details>
        <details class="notes-disclosure"><summary>逐字稿与笔记 <small>按需生成</small></summary>
        <p id="notesAccessHint" class="hint">逐字稿在本机识别；摘要与图文笔记需登录，会发送必要文本。</p>
        <button id="notesLoginBtn" type="button" class="ghost-btn">登录后生成摘要与笔记</button>
        <div class="workspace-actions">
          <button id="transcribeBtn" disabled>生成逐字稿</button>
          <button id="downloadTranscriptBtn" disabled>下载逐字稿</button>
          <button id="summarizeBtn" disabled>生成摘要</button>
          <button id="downloadSummaryBtn" disabled>下载摘要</button>
          <button id="generateNotesBtn" disabled>生成图文笔记</button>
        </div>

        <label class="workspace-text-label">逐字稿
          <textarea id="transcript" placeholder="点击“生成逐字稿”后，识别结果会分段输出；也可以手动粘贴文字再生成摘要或图文笔记。"></textarea>
        </label>
        <label class="workspace-text-label">摘要
          <textarea id="summary" placeholder="摘要会出现在这里，并使用设置中的偏好语言。"></textarea>
        </label>
        </details>
      </aside>

        <section class="workspace-grid-wrap">
          <div id="workspaceEmptyState" class="workspace-empty-state">
            <p class="eyebrow">开始任务</p>
            <h2 id="workspaceEmptyTitle">工作台还没有任务</h2>
            <p id="workspaceEmptyBody">粘贴 B 站或 YouTube 链接、上传视频，或录制屏幕后，处理进度和可导出的页面会出现在这里。</p>
          </div>
          <div id="reviewToolbar" class="review-toolbar" hidden>
            <span>取消勾选可排除页面 · 拖动可排序</span>
            <button id="undoEditBtn" class="ghost-btn" type="button" disabled>撤销上一步</button>
            <button id="selectAllReviewBtn" class="ghost-btn" type="button">全选</button>
            <button id="reextractBtn" class="ghost-btn" type="button">重新提取</button>
          </div>
          <div id="reextractPanel" class="reextract-panel" hidden>
            <strong>重新提取页面</strong><p>会重新识别原视频，替换本次的页面修改，并计入一次转换。提取失败或停止时会恢复现有页面。</p>
            <button id="confirmReextractBtn" type="button">重新提取</button><button id="cancelReextractBtn" class="ghost-btn" type="button">保留当前页面</button>
          </div>
          <div id="slides" class="slides workspace-slides"></div>
        </section>
      </section>
    </section>

    <section class="capture-timeline">
      <div class="timeline-meta">
        <span id="timelineTime">00:00:00</span>
        <strong>拖动时间轴补抓页面 / 按 C</strong>
        <span id="timelineDuration">00:00:00</span>
      </div>
      <div id="timelineRail" class="timeline-rail" role="slider" tabindex="0" aria-label="选择时间并补抓页面" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-valuetext="00:00:00">
        <div id="timelineMarkers" class="timeline-markers"></div>
        <div class="timeline-blue"></div>
        <div id="timelineHandle" class="timeline-handle"></div>
      </div>
    </section>
  </main>

  <dialog id="cropDialog" class="crop-dialog">
    <form method="dialog" class="crop-panel">
      <h2>裁剪当前页面</h2>
      <p>输入四周的裁剪范围，应用后会替换当前页面。</p>
      <img id="cropImage" alt="待裁剪页面" />
      <div class="crop-grid">
        <label>左侧 %<input id="cropLeft" type="number" min="0" max="99" value="0" /></label>
        <label>顶部 %<input id="cropTop" type="number" min="0" max="99" value="0" /></label>
        <label>保留宽度 %<input id="cropWidth" type="number" min="1" max="100" value="100" /></label>
        <label>保留高度 %<input id="cropHeight" type="number" min="1" max="100" value="100" /></label>
      </div>
      <div class="crop-actions">
        <button id="cropCancelBtn" value="cancel" class="ghost-btn">取消</button>
        <button id="cropApplyBtn" value="default">应用裁剪</button>
      </div>
    </form>
  </dialog>

  <dialog id="tipDialog" class="tip-dialog">
    <form method="dialog" class="tip-panel">
      <div class="tip-heading">
        <div>
          <p class="eyebrow">支持项目</p>
          <h2>赞助本站</h2>
        </div>
        <button id="showCustomTipBtn" type="button" class="tip-custom-link">自定义金额</button>
      </div>
      <div class="tip-amount-grid" role="group" aria-label="选择赞赏金额">
        ${TIP_AMOUNTS.map((amount) => `<button type="button" class="tip-amount-btn" data-amount="${amount}">¥${amount}</button>`).join('')}
      </div>
      <div id="customTipLabel" class="custom-tip-field" hidden>
        <label for="customTipAmount">赞赏金额</label>
        <div class="custom-tip-input">
          <span>¥</span>
          <input id="customTipAmount" type="number" min="1" step="1" inputmode="numeric" placeholder="1" />
        </div>
        <small>最低输入 ¥1，低于 ¥10 会按 ¥10 结账</small>
      </div>
      <div class="tip-status" id="tipStatus" aria-live="polite">请选择赞赏金额。</div>
      <div class="tip-actions">
        <button id="tipCancelBtn" value="cancel" class="ghost-btn">取消</button>
        <button id="customTipPayBtn" type="button" hidden>确定并支付</button>
      </div>
    </form>
  </dialog>

  <dialog id="urlFallbackDialog" class="url-fallback-dialog">
    <form method="dialog" class="url-fallback-panel">
      <div class="url-fallback-heading">
        <div>
          <p class="eyebrow">视频链接</p>
          <h2>这个链接需要网页登录验证</h2>
        </div>
      </div>
      <p id="urlFallbackMessage">这个链接需要网页登录验证。可以打开原视频后，用录屏方式继续处理。</p>
      <div class="url-fallback-actions">
        <button id="urlFallbackOpenBtn" type="button" class="ghost-btn">打开原视频</button>
        <button id="urlFallbackRecordBtn" type="button">开始录制并加入队列</button>
        <button id="urlFallbackCancelBtn" value="cancel" class="ghost-btn">取消</button>
      </div>
    </form>
  </dialog>

  <dialog id="settingsDialog" class="settings-dialog">
    <form id="settingsForm" method="dialog" class="settings-panel">
      <div class="settings-heading">
        <div>
          <p class="eyebrow">设置</p>
          <h2>输出偏好</h2>
        </div>
        <button id="settingsCloseBtn" type="button" class="ghost-btn" aria-label="关闭设置">关闭</button>
      </div>
      <label>摘要与图文笔记语言
        <select id="outputLanguageSelect">
          <option value="zh-CN">简体中文</option>
          <option value="zh-TW">繁体中文</option>
          <option value="en">English</option>
          <option value="ja">日本語</option>
          <option value="ko">한국어</option>
        </select>
      </label>
      <p id="settingsAccountHint" class="settings-account-hint">偏好会保存到当前账号。</p>
      <div class="settings-actions">
        <button id="settingsSaveBtn" type="submit">保存设置</button>
      </div>
    </form>
  </dialog>

  <dialog id="notesDialog" class="notes-dialog">
    <section class="notes-panel">
      <header class="notes-toolbar">
        <div>
          <p class="eyebrow">Illustrated Notes</p>
          <h2>图文笔记</h2>
          <small id="notesLanguageLabel">简体中文</small>
        </div>
        <div class="notes-toolbar-actions">
          <button id="regenerateNotesBtn" type="button" class="ghost-btn">重新生成</button>
          <button id="downloadNotesHtmlBtn" type="button">下载 HTML</button>
          <button id="printNotesBtn" type="button" class="ghost-btn">打印 / PDF</button>
          <button id="closeNotesBtn" type="button" class="ghost-btn">关闭</button>
        </div>
      </header>
      <article id="illustratedNotesPreview" class="illustrated-note-preview"></article>
    </section>
  </dialog>
`;

const $ = <T extends Element>(selector: string) => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing ${selector}`);
  return el;
};

const homeView = $<HTMLElement>('#homeView');
const workspaceView = $<HTMLElement>('#workspaceView');
const authForm = $<HTMLFormElement>('#authForm');
const authUsername = $<HTMLInputElement>('#authUsername');
const authEmailLabel = $<HTMLLabelElement>('#authEmailLabel');
const authEmail = $<HTMLInputElement>('#authEmail');
const authPassword = $<HTMLInputElement>('#authPassword');
const authCaptchaImage = $<HTMLImageElement>('#authCaptchaImage');
const refreshAuthCaptchaBtn = $<HTMLButtonElement>('#refreshAuthCaptchaBtn');
const authCaptchaAnswer = $<HTMLInputElement>('#authCaptchaAnswer');
const authSubmitBtn = $<HTMLButtonElement>('#authSubmitBtn');
const authModeToggleBtn = $<HTMLButtonElement>('#authModeToggleBtn');
const authSignedIn = $<HTMLDivElement>('#authSignedIn');
const authSignedInName = $<HTMLElement>('#authSignedInName');
const authSignedInEmail = $<HTMLElement>('#authSignedInEmail');
const openAccountSettingsBtn = $<HTMLButtonElement>('#openAccountSettingsBtn');
const authLogoutBtn = $<HTMLButtonElement>('#authLogoutBtn');
const accountStatus = $<HTMLElement>('#accountStatus');
const dropzone = $<HTMLLabelElement>('#dropzone');
const imageDropzone = $<HTMLLabelElement>('#imageDropzone');
const notebookPdfDropzone = $<HTMLLabelElement>('#notebookPdfDropzone');
const fileLabel = $<HTMLSpanElement>('#fileLabel');
const imageFileLabel = $<HTMLSpanElement>('#imageFileLabel');
const notebookPdfFileLabel = $<HTMLSpanElement>('#notebookPdfFileLabel');
const fileList = $<HTMLDivElement>('#fileList');
const imageFileList = $<HTMLDivElement>('#imageFileList');
const notebookPdfInfo = $<HTMLDivElement>('#notebookPdfInfo');
const videoInput = $<HTMLInputElement>('#videoInput');
const videoUrlForm = $<HTMLFormElement>('#videoUrlForm');
const videoUrlInput = $<HTMLInputElement>('#videoUrlInput');
const downloadUrlBtn = $<HTMLButtonElement>('#downloadUrlBtn');
const processUrlBtn = $<HTMLButtonElement>('#processUrlBtn');
const urlDownloadProgress = $<HTMLDivElement>('#urlDownloadProgress');
const urlDownloadProgressText = $<HTMLElement>('#urlDownloadProgressText');
const urlDownloadProgressPercent = $<HTMLElement>('#urlDownloadProgressPercent');
const urlDownloadProgressFill = $<HTMLDivElement>('#urlDownloadProgressFill');
const urlDownloadStatus = $<HTMLElement>('#urlDownloadStatus');
const mediaPreview = $<HTMLDivElement>('#mediaPreview');
const mediaPreviewImage = $<HTMLImageElement>('#mediaPreviewImage');
const mediaPreviewProvider = $<HTMLElement>('#mediaPreviewProvider');
const mediaPreviewTitle = $<HTMLElement>('#mediaPreviewTitle');
const mediaPreviewMeta = $<HTMLElement>('#mediaPreviewMeta');
const mediaPreviewPolicy = $<HTMLElement>('#mediaPreviewPolicy');
const mediaRightsLabel = $<HTMLLabelElement>('#mediaRightsLabel');
const mediaRightsConfirm = $<HTMLInputElement>('#mediaRightsConfirm');
const imageInput = $<HTMLInputElement>('#imageInput');
const notebookPdfInput = $<HTMLInputElement>('#notebookPdfInput');
const recordScreenBtn = $<HTMLButtonElement>('#recordScreenBtn');
const stopRecordBtn = $<HTMLButtonElement>('#stopRecordBtn');
const extractBtn = $<HTMLButtonElement>('#extractBtn');
const batchZipBtn = $<HTMLButtonElement>('#batchZipBtn');
const downloadFramesZipBtn = $<HTMLButtonElement>('#downloadFramesZipBtn');
const imagePptBtn = $<HTMLButtonElement>('#imagePptBtn');
const imageWorkspaceBtn = $<HTMLButtonElement>('#imageWorkspaceBtn');
const notebookMaskPdfBtn = $<HTMLButtonElement>('#notebookMaskPdfBtn');
const doneBtn = $<HTMLButtonElement>('#doneBtn');
const toggleSideBtn = $<HTMLButtonElement>('#toggleSideBtn');
const selectAllBox = $<HTMLInputElement>('#selectAllBox');
const selectCount = $<HTMLElement>('#selectCount');
const transcribeBtn = $<HTMLButtonElement>('#transcribeBtn');
const summarizeBtn = $<HTMLButtonElement>('#summarizeBtn');
const downloadPdfBtn = $<HTMLButtonElement>('#downloadPdfBtn');
const downloadPptxBtn = $<HTMLButtonElement>('#downloadPptxBtn');
const dockDownloadPdfBtn = $<HTMLButtonElement>('#dockDownloadPdfBtn');
const dockDownloadPptxBtn = $<HTMLButtonElement>('#dockDownloadPptxBtn');
const dockDownloadFramesBtn = $<HTMLButtonElement>('#dockDownloadFramesBtn');
const dockNotesBtn = $<HTMLButtonElement>('#dockNotesBtn');
const resultDock = $<HTMLElement>('#resultDock');
const resultBadge = $<HTMLElement>('#resultBadge');
const resultTitle = $<HTMLElement>('#resultTitle');
const resultSubtitle = $<HTMLElement>('#resultSubtitle');
const sideDownloadPdfBtn = $<HTMLButtonElement>('#sideDownloadPdfBtn');
const sideDownloadPptxBtn = $<HTMLButtonElement>('#sideDownloadPptxBtn');
const sideDownloadFramesBtn = $<HTMLButtonElement>('#sideDownloadFramesBtn');
const downloadTranscriptBtn = $<HTMLButtonElement>('#downloadTranscriptBtn');
const downloadSummaryBtn = $<HTMLButtonElement>('#downloadSummaryBtn');
const generateNotesBtn = $<HTMLButtonElement>('#generateNotesBtn');
const exportHint = $<HTMLElement>('#exportHint');
const homeStatus = $<HTMLDivElement>('#homeStatus');
const imageStatus = $<HTMLDivElement>('#imageStatus');
const notebookPdfStatus = $<HTMLDivElement>('#notebookPdfStatus');
const statusEl = $<HTMLDivElement>('#status');
const progressPanel = $<HTMLDivElement>('#progressPanel');
const progressText = $<HTMLSpanElement>('#progressText');
const progressPercent = $<HTMLElement>('#progressPercent');
const progressTrack = $<HTMLDivElement>('#progressTrack');
const progressFill = $<HTMLDivElement>('#progressFill');
const workspaceSubtitle = $<HTMLElement>('#workspaceSubtitle');
const workspaceEmptyState = $<HTMLDivElement>('#workspaceEmptyState');
const workspaceEmptyTitle = $<HTMLElement>('#workspaceEmptyTitle');
const workspaceEmptyBody = $<HTMLElement>('#workspaceEmptyBody');
const workspaceVideoUrlForm = $<HTMLFormElement>('#workspaceVideoUrlForm');
const workspaceVideoUrlInput = $<HTMLInputElement>('#workspaceVideoUrlInput');
const workspaceRightsConfirm = $<HTMLInputElement>('#workspaceRightsConfirm');
const workspaceProcessUrlBtn = $<HTMLButtonElement>('#workspaceProcessUrlBtn');
const workspaceDownloadUrlBtn = $<HTMLButtonElement>('#workspaceDownloadUrlBtn');
const workspaceUrlStatus = $<HTMLElement>('#workspaceUrlStatus');
const workspaceDropzone = $<HTMLLabelElement>('#workspaceDropzone');
const workspaceVideoInput = $<HTMLInputElement>('#workspaceVideoInput');
const workspaceRecordScreenBtn = $<HTMLButtonElement>('#workspaceRecordScreenBtn');
const workspaceStopRecordBtn = $<HTMLButtonElement>('#workspaceStopRecordBtn');
const emptyWorkspaceStartBtn = $<HTMLButtonElement>('#emptyWorkspaceStartBtn');
const slidesEl = $<HTMLDivElement>('#slides');
const transcriptEl = $<HTMLTextAreaElement>('#transcript');
const summaryEl = $<HTMLTextAreaElement>('#summary');
const previewImage = $<HTMLImageElement>('#previewImage');
const previewEmpty = $<HTMLDivElement>('#previewEmpty');
const timelineRail = $<HTMLDivElement>('#timelineRail');
const captureTimeline = $<HTMLElement>('.capture-timeline');
const timelineHandle = $<HTMLDivElement>('#timelineHandle');
const timelineMarkers = $<HTMLDivElement>('#timelineMarkers');
const timelineTimeEl = $<HTMLElement>('#timelineTime');
const timelineDurationEl = $<HTMLElement>('#timelineDuration');
const cropDialog = $<HTMLDialogElement>('#cropDialog');
const cropImage = $<HTMLImageElement>('#cropImage');
const cropLeft = $<HTMLInputElement>('#cropLeft');
const cropTop = $<HTMLInputElement>('#cropTop');
const cropWidth = $<HTMLInputElement>('#cropWidth');
const cropHeight = $<HTMLInputElement>('#cropHeight');
const cropApplyBtn = $<HTMLButtonElement>('#cropApplyBtn');
const openSiteTipDialogBtn = document.querySelector<HTMLButtonElement>('#openSiteTipDialogBtn');
const openWorkspaceBtn = document.querySelector<HTMLButtonElement>('#openWorkspaceBtn');
const openDemoProjectBtn = $<HTMLButtonElement>('#openDemoProjectBtn');
const openLoginBtn = document.querySelector<HTMLButtonElement>('#openLoginBtn');
const railHomeBtn = $<HTMLButtonElement>('#railHomeBtn');
const railWorkspaceBtn = $<HTMLButtonElement>('#railWorkspaceBtn');
const railOrdersBtn = $<HTMLButtonElement>('#railOrdersBtn');
const railSettingsBtn = $<HTMLButtonElement>('#railSettingsBtn');
const railLoginBtn = $<HTMLButtonElement>('#railLoginBtn');
const openTipDialogBtn = $<HTMLButtonElement>('#openTipDialogBtn');
const tipDialog = $<HTMLDialogElement>('#tipDialog');
const showCustomTipBtn = $<HTMLButtonElement>('#showCustomTipBtn');
const customTipLabel = $<HTMLDivElement>('#customTipLabel');
const customTipAmount = $<HTMLInputElement>('#customTipAmount');
const customTipPayBtn = $<HTMLButtonElement>('#customTipPayBtn');
const tipStatus = $<HTMLDivElement>('#tipStatus');
const urlFallbackDialog = $<HTMLDialogElement>('#urlFallbackDialog');
const urlFallbackMessage = $<HTMLElement>('#urlFallbackMessage');
const urlFallbackOpenBtn = $<HTMLButtonElement>('#urlFallbackOpenBtn');
const urlFallbackRecordBtn = $<HTMLButtonElement>('#urlFallbackRecordBtn');
const settingsDialog = $<HTMLDialogElement>('#settingsDialog');
const settingsForm = $<HTMLFormElement>('#settingsForm');
const settingsCloseBtn = $<HTMLButtonElement>('#settingsCloseBtn');
const outputLanguageSelect = $<HTMLSelectElement>('#outputLanguageSelect');
const settingsAccountHint = $<HTMLElement>('#settingsAccountHint');
const notesDialog = $<HTMLDialogElement>('#notesDialog');
const notesLanguageLabel = $<HTMLElement>('#notesLanguageLabel');
const illustratedNotesPreview = $<HTMLElement>('#illustratedNotesPreview');
const regenerateNotesBtn = $<HTMLButtonElement>('#regenerateNotesBtn');
const downloadNotesHtmlBtn = $<HTMLButtonElement>('#downloadNotesHtmlBtn');
const printNotesBtn = $<HTMLButtonElement>('#printNotesBtn');
const closeNotesBtn = $<HTMLButtonElement>('#closeNotesBtn');
const runOcrBtn = $<HTMLButtonElement>('#runOcrBtn');
const addTextBoxBtn = $<HTMLButtonElement>('#addTextBoxBtn');
const deleteTextBoxBtn = $<HTMLButtonElement>('#deleteTextBoxBtn');
const textLayerHint = $<HTMLElement>('#textLayerHint');
const textBoxContent = $<HTMLTextAreaElement>('#textBoxContent');
const textBoxX = $<HTMLInputElement>('#textBoxX');
const textBoxY = $<HTMLInputElement>('#textBoxY');
const textBoxWidth = $<HTMLInputElement>('#textBoxWidth');
const textBoxHeight = $<HTMLInputElement>('#textBoxHeight');
const textBoxFontSize = $<HTMLInputElement>('#textBoxFontSize');
const textBoxColor = $<HTMLInputElement>('#textBoxColor');
const textBoxBold = $<HTMLInputElement>('#textBoxBold');
const textBoxAlign = $<HTMLSelectElement>('#textBoxAlign');

let selectedFiles: File[] = [];
let selectedImageFiles: File[] = [];
let selectedNotebookPdfFile: File | null = null;
let currentFileIndex = -1;
let selectedFile: File | null = null;
const fileStates = new Map<string, FileJobState>();
let slides: Slide[] = [];
let videoMeta: VideoMeta | null = null;
let workspaceMode: WorkspaceMode = 'video';
let isDemoProject = false;
let demoRestoreFileIndex = -1;
let timelineTime = 0;
let cropTargetSlideId: number | null = null;
let activeSlideId: number | null = null;
let activeTextBoxId: string | null = null;
let draggedSlideId: number | null = null;
let isDraggingTimeline = false;
let extractionTimelineMax = 0;
let lastTimelinePaint = 0;
let isExtracting = false;
let isExporting = false;
let extractionAbort: AbortController | null = null;
let undoSnapshot: { slides: Slide[]; activeSlideId: number | null; file: File | null } | null = null;
type WorkspaceDraft = { version: 1; file: File; state: FileJobState; mode: WorkspaceMode; savedAt: string };
let savedDraft: WorkspaceDraft | null = null;
let draftTimer = 0;
let draftRevision = 0;
let savedDraftRevision = 0;
let draftWrites: Promise<void> = Promise.resolve();
let demoSnapshot: { file: File | null; mode: WorkspaceMode; state: FileJobState; index: number } | null = null;
let isBatchProcessing = false;
let isUrlDownloading = false;
let isTranscribing = false;
let isSummarizing = false;
let isGeneratingNotes = false;
let isOcrRunning = false;
let isPdfMasking = false;
let isRecording = false;
let isPreparingRecording = false;
let mediaRecorder: MediaRecorder | null = null;
let recordingStream: MediaStream | null = null;
let recordedChunks: Blob[] = [];
let currentRecordingMimeType = 'video/webm';
let recordingCompletionMode: UrlDownloadMode = 'queue';
let fallbackSourceUrl = '';
let fallbackUrlMode: UrlDownloadMode = 'queue';
let currentMediaMetadata: MediaMetadata | null = null;
let currentMediaMetadataUrl = '';
let mediaMetadataRequestId = 0;
let mediaMetadataDebounce = 0;
let tesseractLoadPromise: Promise<TesseractApi> | null = null;
let pdfJsLoadPromise: Promise<PdfJsApi> | null = null;
let paddleConfigPromise: Promise<PaddleConfig> | null = null;
let paddleLoadPromise: Promise<PaddleConfig> | null = null;
let paddleInitialized = false;
let isTipCheckoutOpening = false;
let authMode: AuthMode = 'login';
let authSession: AuthSession | null = loadAuthSession();
let userPreferences: UserPreferences = loadUserPreferences();
let illustratedNotesMarkdown = '';
let authCaptchaToken = '';
let isAuthBusy = false;
let entitlement: EntitlementPayload = freeEntitlement(authSession?.user.email ?? '');
let usageSummary: UsageSummary = loadLocalUsageSummary();
let entitlementFetchedAt = 0;

authForm.addEventListener('focusin', () => {
  if (!authSession && !authCaptchaToken && !refreshAuthCaptchaBtn.disabled) void loadAuthCaptcha();
});
authForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void submitAuthForm();
});
authModeToggleBtn.addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));
refreshAuthCaptchaBtn.addEventListener('click', () => {
  void loadAuthCaptcha();
});
authLogoutBtn.addEventListener('click', () => {
  const wasAdminUser = authSession?.user.username === ADMIN_USERNAME;
  authSession = null;
  userPreferences = loadUserPreferences();
  entitlement = freeEntitlement();
  usageSummary = loadLocalUsageSummary();
  entitlementFetchedAt = 0;
  localStorage.removeItem(AUTH_STORAGE_KEY);
  if (wasAdminUser) localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
  syncAdminNav();
  setAuthStatus('已退出登录。', '');
  updateAuthUi();
});
openAccountSettingsBtn.addEventListener('click', () => openSettingsDialog());
settingsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  savePreferencesFromDialog();
});
settingsCloseBtn.addEventListener('click', () => settingsDialog.close());
settingsDialog.addEventListener('click', (event) => {
  if (event.target === settingsDialog) settingsDialog.close();
});
closeNotesBtn.addEventListener('click', () => notesDialog.close());
notesDialog.addEventListener('click', (event) => {
  if (event.target === notesDialog) notesDialog.close();
});
regenerateNotesBtn.addEventListener('click', () => {
  notesDialog.close();
  void generateIllustratedNotes(true);
});
downloadNotesHtmlBtn.addEventListener('click', () => downloadIllustratedNotesHtml());
printNotesBtn.addEventListener('click', () => printIllustratedNotes());
syncAdminNav();
updateAuthUi();
void refreshEntitlement();

videoInput.addEventListener('change', () => addFiles(Array.from(videoInput.files ?? [])));
videoUrlForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void downloadVideoFromUrl('extract');
});
downloadUrlBtn.addEventListener('click', () => { void downloadVideoFromUrl('queue'); });
processUrlBtn.addEventListener('click', () => {
  void downloadVideoFromUrl('extract');
});
videoUrlInput.addEventListener('input', () => {
  scheduleMediaMetadataPreview();
});
videoUrlInput.addEventListener('blur', () => {
  void refreshMediaMetadataPreview();
});
mediaRightsConfirm.addEventListener('change', () => {
  if (mediaRightsConfirm.checked && currentMediaMetadata?.provider === 'bilibili') {
    setUrlDownloadStatus('已确认，可下载这个 B 站视频到队列。', 'ok');
  }
  updateActionState();
});
imageInput.addEventListener('change', () => addImageFiles(Array.from(imageInput.files ?? [])));
notebookPdfInput.addEventListener('change', () => selectNotebookPdfFile(Array.from(notebookPdfInput.files ?? [])[0] ?? null));
recordScreenBtn.addEventListener('click', () => startScreenRecording('extract'));
stopRecordBtn.addEventListener('click', () => stopScreenRecording());
extractBtn.addEventListener('click', () => { if (slides.length && !isDemoProject) showWorkspace(); else void processCurrentFile(); });
batchZipBtn.addEventListener('click', () => batchExtractAndDownloadZip());
downloadFramesZipBtn.addEventListener('click', () => downloadProcessedFramesZip());
imagePptBtn.addEventListener('click', () => downloadImagesAsPptx());
imageWorkspaceBtn.addEventListener('click', () => openImagesInWorkspace());
notebookMaskPdfBtn.addEventListener('click', () => maskSelectedNotebookPdf());
[dropzone, imageDropzone, notebookPdfDropzone, workspaceDropzone].forEach((zone) => {
  zone.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    zone.click();
  });
});
transcriptEl.addEventListener('input', () => { persistWorkspaceToState(); updateActionState(); });
summaryEl.addEventListener('input', () => persistWorkspaceToState());
dockNotesBtn.addEventListener('click', () => {
  if (illustratedNotesMarkdown.trim()) openIllustratedNotes();
  else void generateIllustratedNotes();
});
generateNotesBtn.addEventListener('click', () => {
  if (illustratedNotesMarkdown.trim()) openIllustratedNotes();
  else void generateIllustratedNotes();
});

doneBtn.addEventListener('click', () => {
  const closedDemo = isDemoProject;
  if (!closedDemo && !isBusy()) persistWorkspaceToState({ markProcessed: slides.length > 0 });
  workspaceView.hidden = true;
  homeView.hidden = false;
  if (!isBusy()) hideProgress();
  if (closedDemo) restoreWorkspaceAfterDemo();
  renderFileList();
  setHomeStatus(closedDemo
    ? '交互示例已关闭。现在可以用自己的视频开始转换。'
    : workspaceMode === 'image'
      ? '图片 PPT 工作台已关闭，可继续上传图片或视频。'
      : selectedFile ? `当前视频：${selectedFile.name}` : '等待上传视频。');
});

toggleSideBtn.addEventListener('click', () => {
  workspaceView.classList.toggle('side-collapsed');
  toggleSideBtn.setAttribute('aria-expanded', String(!workspaceView.classList.contains('side-collapsed')));
});

selectAllBox.addEventListener('change', () => setAllSlidesSelected(selectAllBox.checked));
runOcrBtn.addEventListener('click', () => runOcrForSelectedSlides());
addTextBoxBtn.addEventListener('click', () => addTextBoxToActiveSlide());
deleteTextBoxBtn.addEventListener('click', () => deleteActiveTextBox());
textBoxContent.addEventListener('input', () => updateActiveTextBoxFromControls());
[textBoxX, textBoxY, textBoxWidth, textBoxHeight, textBoxFontSize, textBoxColor, textBoxBold].forEach((control) => {
  control.addEventListener('input', () => updateActiveTextBoxFromControls());
});
textBoxAlign.addEventListener('change', () => updateActiveTextBoxFromControls());

for (const name of ['dragenter', 'dragover']) {
  dropzone.addEventListener(name, (event) => {
    event.preventDefault();
    event.stopPropagation();
    dropzone.classList.add('is-dragover');
  });
}
for (const name of ['dragleave', 'dragend']) {
  dropzone.addEventListener(name, (event) => {
    event.preventDefault();
    event.stopPropagation();
    dropzone.classList.remove('is-dragover');
  });
}
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  event.stopPropagation();
  dropzone.classList.remove('is-dragover');
  addFiles(Array.from(event.dataTransfer?.files ?? []));
});

for (const name of ['dragenter', 'dragover']) {
  imageDropzone.addEventListener(name, (event) => {
    event.preventDefault();
    event.stopPropagation();
    imageDropzone.classList.add('is-dragover');
  });
}
for (const name of ['dragleave', 'dragend']) {
  imageDropzone.addEventListener(name, (event) => {
    event.preventDefault();
    event.stopPropagation();
    imageDropzone.classList.remove('is-dragover');
  });
}
imageDropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  event.stopPropagation();
  imageDropzone.classList.remove('is-dragover');
  addImageFiles(Array.from(event.dataTransfer?.files ?? []));
});

for (const name of ['dragenter', 'dragover']) {
  notebookPdfDropzone.addEventListener(name, (event) => {
    event.preventDefault();
    event.stopPropagation();
    notebookPdfDropzone.classList.add('is-dragover');
  });
}
for (const name of ['dragleave', 'dragend']) {
  notebookPdfDropzone.addEventListener(name, (event) => {
    event.preventDefault();
    event.stopPropagation();
    notebookPdfDropzone.classList.remove('is-dragover');
  });
}
notebookPdfDropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  event.stopPropagation();
  notebookPdfDropzone.classList.remove('is-dragover');
  selectNotebookPdfFile(Array.from(event.dataTransfer?.files ?? []).find(isSupportedPdfFile) ?? null);
});

for (const name of ['dragenter', 'dragover']) {
  workspaceDropzone.addEventListener(name, (event) => {
    event.preventDefault();
    event.stopPropagation();
    workspaceDropzone.classList.add('is-dragover');
  });
}
for (const name of ['dragleave', 'dragend']) {
  workspaceDropzone.addEventListener(name, (event) => {
    event.preventDefault();
    event.stopPropagation();
    workspaceDropzone.classList.remove('is-dragover');
  });
}
workspaceDropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  event.stopPropagation();
  workspaceDropzone.classList.remove('is-dragover');
  addWorkspaceFiles(Array.from(event.dataTransfer?.files ?? []));
});

timelineRail.addEventListener('pointerdown', (event) => {
  if (!videoMeta || isBusy()) return;
  isDraggingTimeline = true;
  timelineRail.setPointerCapture(event.pointerId);
  updateTimelineFromPointer(event);
});
timelineRail.addEventListener('pointermove', (event) => {
  if (!isDraggingTimeline) return;
  updateTimelineFromPointer(event);
});
timelineRail.addEventListener('pointerup', async (event) => {
  if (!isDraggingTimeline) return;
  isDraggingTimeline = false;
  timelineRail.releasePointerCapture(event.pointerId);
  updateTimelineFromPointer(event);
  await captureManualFrameAt(timelineTime);
});
timelineRail.addEventListener('pointercancel', () => { isDraggingTimeline = false; });
timelineRail.addEventListener('keydown', async (event) => {
  if (!videoMeta || isBusy()) return;
  const duration = videoMeta.duration;
  const step = event.shiftKey ? 30 : 5;
  if (event.key === 'ArrowLeft') timelineTime = Math.max(0, timelineTime - step);
  else if (event.key === 'ArrowRight') timelineTime = Math.min(duration, timelineTime + step);
  else if (event.key === 'Home') timelineTime = 0;
  else if (event.key === 'End') timelineTime = duration;
  else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    await captureManualFrameAt(timelineTime);
    return;
  } else return;
  event.preventDefault();
  extractionTimelineMax = Math.max(extractionTimelineMax, timelineTime);
  updateTimelinePosition();
});

document.addEventListener('keydown', async (event) => {
  const target = event.target as HTMLElement | null;
  const isTyping = target?.matches('input, textarea, select, [contenteditable="true"]') || document.querySelector('dialog[open]') || event.metaKey || event.ctrlKey || event.altKey;
  if (isTyping || workspaceView.hidden || event.key.toLowerCase() !== 'c') return;
  event.preventDefault();
  await captureManualFrameAt(timelineTime);
});

cropApplyBtn.addEventListener('click', async (event) => {
  event.preventDefault();
  await applyCrop();
});

openSiteTipDialogBtn?.addEventListener('click', () => openTipDialog());
openWorkspaceBtn?.addEventListener('click', () => openWorkspaceFromNav());
openDemoProjectBtn.addEventListener('click', () => openDemoProject());
openLoginBtn?.addEventListener('click', () => focusLoginPanel());
railHomeBtn.addEventListener('click', () => returnHomeForVideoStart());
railWorkspaceBtn.addEventListener('click', () => openWorkspaceFromNav());
railOrdersBtn.addEventListener('click', () => showOrdersPlaceholder());
railSettingsBtn.addEventListener('click', () => openSettingsDialog());
railLoginBtn.addEventListener('click', () => focusLoginPanel());
emptyWorkspaceStartBtn.addEventListener('click', () => {
  if (selectedFile && workspaceMode === 'video' && slides.length === 0) void processCurrentFile();
  else if (workspaceMode === 'image') returnHomeForVideoStart();
  else workspaceVideoInput.click();
});
workspaceVideoUrlForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void startWorkspaceUrlDownload('extract');
});
workspaceDownloadUrlBtn.addEventListener('click', () => { void startWorkspaceUrlDownload('queue'); });
workspaceProcessUrlBtn.addEventListener('click', () => {
  void startWorkspaceUrlDownload('extract');
});
workspaceVideoInput.addEventListener('change', () => addWorkspaceFiles(Array.from(workspaceVideoInput.files ?? [])));
workspaceRecordScreenBtn.addEventListener('click', () => {
  setWorkspaceUrlStatus('正在录制屏幕，停止后会自动生成页面。', 'warn');
  void startScreenRecording('extract');
});
workspaceStopRecordBtn.addEventListener('click', () => stopScreenRecording());
openTipDialogBtn.addEventListener('click', () => {
  window.open('/contact/?subject=Vid2PPT%20%E4%BD%BF%E7%94%A8%E9%97%AE%E9%A2%98', '_blank', 'noopener');
});
showCustomTipBtn.addEventListener('click', () => showCustomTipInput());
customTipPayBtn.addEventListener('click', () => {
  void openTipCheckout(readCustomTipAmount());
});
customTipAmount.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void openTipCheckout(readCustomTipAmount());
  }
});

tipDialog.addEventListener('click', (event) => {
  if (event.target === tipDialog) tipDialog.close();
});

urlFallbackDialog.addEventListener('click', (event) => {
  if (event.target === urlFallbackDialog) urlFallbackDialog.close();
});
urlFallbackOpenBtn.addEventListener('click', () => {
  if (fallbackSourceUrl) window.open(fallbackSourceUrl, '_blank', 'noopener,noreferrer');
});
urlFallbackRecordBtn.addEventListener('click', () => {
  urlFallbackDialog.close();
  void startScreenRecording(fallbackUrlMode);
});

tipDialog.querySelectorAll<HTMLButtonElement>('.tip-amount-btn').forEach((button) => {
  button.addEventListener('click', () => {
    void openTipCheckout(Number(button.dataset.amount));
  });
});

function loadAuthSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as Partial<AuthSession>;
    if (!session.token || !session.user?.username || !session.user.email) return null;
    return session as AuthSession;
  } catch {
    return null;
  }
}

function preferencesStorageKey(): string {
  const identity = authSession?.user.username?.trim().toLowerCase() || 'guest';
  return `${PREFERENCES_STORAGE_PREFIX}.${identity}`;
}

function loadUserPreferences(): UserPreferences {
  try {
    const raw = localStorage.getItem(preferencesStorageKey());
    if (!raw) return { ...DEFAULT_USER_PREFERENCES };
    const parsed = JSON.parse(raw) as Partial<UserPreferences>;
    return {
      outputLanguage: isOutputLanguage(parsed.outputLanguage) ? parsed.outputLanguage : DEFAULT_USER_PREFERENCES.outputLanguage
    };
  } catch {
    return { ...DEFAULT_USER_PREFERENCES };
  }
}

function isOutputLanguage(value: unknown): value is OutputLanguage {
  return typeof value === 'string' && value in OUTPUT_LANGUAGE_LABELS;
}

function syncPreferencesUi(): void {
  outputLanguageSelect.value = userPreferences.outputLanguage;
  const languageLabel = OUTPUT_LANGUAGE_LABELS[userPreferences.outputLanguage];
  settingsAccountHint.textContent = authSession
    ? `已在此浏览器为 ${authSession.user.username} 保存，摘要和图文笔记使用${languageLabel}。`
    : `当前使用${languageLabel}，偏好保存在此浏览器。`;
  notesLanguageLabel.textContent = languageLabel;
}

function openSettingsDialog(): void {
  syncPreferencesUi();
  if (typeof settingsDialog.showModal === 'function') settingsDialog.showModal();
  else settingsDialog.setAttribute('open', '');
}

function savePreferencesFromDialog(): void {
  const outputLanguage = isOutputLanguage(outputLanguageSelect.value)
    ? outputLanguageSelect.value
    : DEFAULT_USER_PREFERENCES.outputLanguage;
  userPreferences = { outputLanguage };
  localStorage.setItem(preferencesStorageKey(), JSON.stringify(userPreferences));
  syncPreferencesUi();
  settingsDialog.close();
  const message = `输出语言已设置为${OUTPUT_LANGUAGE_LABELS[outputLanguage]}。`;
  if (workspaceView.hidden) setHomeStatus(message);
  else setStatus(message);
}

function saveAuthSession(session: AuthSession, adminToken = ''): void {
  authSession = session;
  userPreferences = loadUserPreferences();
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
  if (adminToken && adminTokenIsCurrent(adminToken)) {
    localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, adminToken);
  }
  syncAdminNav();
  localStorage.setItem(CHECKOUT_EMAIL_STORAGE_KEY, session.user.email);
  void refreshEntitlement();
}

function adminTokenIsCurrent(token: string | null): boolean {
  try {
    const payloadPart = String(token || '').split('.')[0] || '';
    const padded = payloadPart.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - payloadPart.length % 4) % 4);
    const payload = JSON.parse(atob(padded)) as { kind?: string; sub?: string };
    return payload.kind === 'admin' && payload.sub === ADMIN_USERNAME;
  } catch {
    return false;
  }
}

function syncAdminNav(): void {
  const unlocked = adminTokenIsCurrent(localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY));
  document.querySelectorAll<HTMLAnchorElement>('.nav-action[href="/admin/"]').forEach((link) => {
    link.hidden = !unlocked;
  });
}

function setAuthStatus(message: string, tone: 'ok' | 'warn' | 'error' | '' = ''): void {
  accountStatus.textContent = message;
  accountStatus.className = `account-status${tone ? ` ${tone}` : ''}`;
}

function setAuthMode(mode: AuthMode): void {
  authMode = mode;
  authPassword.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  authSubmitBtn.textContent = mode === 'register' ? '注册并登录' : '登录';
  authModeToggleBtn.textContent = mode === 'register' ? '已有账号，去登录' : '注册新账号';
  authEmailLabel.hidden = mode !== 'register';
  renderEntitlementSummary();
  authCaptchaAnswer.value = '';
  if (document.activeElement?.closest('#account')) void loadAuthCaptcha();
}

function updateAuthUi(): void {
  const signedIn = !!authSession;
  authForm.hidden = signedIn;
  authSignedIn.hidden = !signedIn;
  if (openLoginBtn) openLoginBtn.textContent = authSession ? `账号：${authSession.user.username}` : '登录';
  if (authSession) {
    authSignedInName.textContent = authSession.user.username;
    authSignedInEmail.textContent = authSession.user.email_is_generated ? '此账号未填写联系邮箱。购买前请在定价页核对权益绑定信息。' : authSession.user.email;
    renderEntitlementSummary();
  } else {
    setAuthMode(authMode);
  }
  syncPreferencesUi();
  updateActionState();
}

async function loadAuthCaptcha(): Promise<void> {
  if (authSession) return;
  try {
    refreshAuthCaptchaBtn.disabled = true;
    const response = await fetch('/api/captcha', { cache: 'no-store' });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('登录服务暂时不可用，请稍后重试。无需登录仍可使用本地转换。');
    const data = await response.json() as { image?: string; token?: string; detail?: string };
    if (!response.ok || !data.image || !data.token) throw new Error(data.detail || '验证码加载失败。');
    authCaptchaImage.src = data.image;
    authCaptchaToken = data.token;
  } catch (error) {
    authCaptchaToken = '';
    setAuthStatus('验证码未能加载。请点击“换一张”重试；本地转换仍可使用。', 'error');
  } finally {
    refreshAuthCaptchaBtn.disabled = false;
  }
}

async function submitAuthForm(): Promise<void> {
  const username = authUsername.value.trim();
  const password = authPassword.value;
  const captchaAnswer = authCaptchaAnswer.value.trim();
  if (!username || !password || !captchaAnswer) {
    setAuthStatus('请填写用户名、密码和验证码。', 'error');
    return;
  }
  if (!authCaptchaToken) {
    setAuthStatus('验证码还没有加载完成，请换一张再试。', 'error');
    return;
  }

  isAuthBusy = true;
  setAuthBusy(true);
  setAuthStatus(authMode === 'register' ? '正在注册...' : '正在登录...', 'warn');
  try {
    const response = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: authMode,
        username,
        password,
        email: authMode === 'register' ? authEmail.value.trim() : '',
        captcha_token: authCaptchaToken,
        captcha_answer: captchaAnswer
      })
    });
    const data = await response.json() as AuthResponse;
    if (!response.ok || !data.token || !data.user) throw new Error(data.detail || '账号请求失败。');
    saveAuthSession({ token: data.token, user: data.user }, data.admin_token || '');
    authPassword.value = '';
    authCaptchaAnswer.value = '';
    updateAuthUi();
  } catch (error) {
    setAuthStatus(error instanceof Error ? error.message : '账号请求失败。', 'error');
    authCaptchaAnswer.value = '';
    void loadAuthCaptcha();
  } finally {
    isAuthBusy = false;
    setAuthBusy(false);
  }
}

function setAuthBusy(busy: boolean): void {
  authUsername.disabled = busy;
  authEmail.disabled = busy;
  authPassword.disabled = busy;
  authCaptchaAnswer.disabled = busy;
  authSubmitBtn.disabled = busy;
  authModeToggleBtn.disabled = busy;
  refreshAuthCaptchaBtn.disabled = busy;
}

function freeEntitlement(email = ''): EntitlementPayload {
  return {
    email,
    plan: 'free',
    effective_plan: 'free',
    status: 'inactive',
    lifetime: false,
    current_period_end: null,
    active: false,
    limits: { ...FREE_PLAN_LIMITS }
  };
}

function emptyUsageSummary(email = 'anonymous'): UsageSummary {
  return {
    email,
    period: 'monthly',
    period_start: currentMonthStartIso(),
    monthly: {
      video_conversion: 0,
      editable_slide: 0,
      summary_generation: 0,
      transcribe_minute: 0
    }
  };
}

function loadLocalUsageSummary(): UsageSummary {
  try {
    const raw = localStorage.getItem(USAGE_STORAGE_KEY);
    if (!raw) return emptyUsageSummary();
    const parsed = JSON.parse(raw) as Partial<UsageSummary>;
    if (!sameMonthlyPeriod(parsed.period_start)) return emptyUsageSummary();
    return {
      email: 'anonymous',
      period: 'monthly',
      period_start: parsed.period_start ?? currentMonthStartIso(),
      monthly: normalizeMonthlyUsage(parsed.monthly)
    };
  } catch {
    return emptyUsageSummary();
  }
}

function saveLocalUsageSummary(summary: UsageSummary): void {
  localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify(summary));
}

function normalizeMonthlyUsage(value: unknown): Record<string, number> {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    video_conversion: nonNegativeInteger(source.video_conversion),
    editable_slide: nonNegativeInteger(source.editable_slide),
    summary_generation: nonNegativeInteger(source.summary_generation),
    transcribe_minute: nonNegativeInteger(source.transcribe_minute)
  };
}

function nonNegativeInteger(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.max(0, Math.floor(numberValue)) : 0;
}

function currentMonthStartIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function sameMonthlyPeriod(periodStart: unknown): boolean {
  return typeof periodStart === 'string' && periodStart.slice(0, 7) === currentMonthStartIso().slice(0, 7);
}

async function refreshEntitlement(): Promise<void> {
  if (!authSession) {
    entitlement = freeEntitlement();
    usageSummary = loadLocalUsageSummary();
    renderEntitlementSummary();
    updateActionState();
    return;
  }

  const email = authSession.user.email;
  try {
    const [entitlementResponse, usageResponse] = await Promise.all([
      fetch(`/api/entitlement?email=${encodeURIComponent(email)}`, { cache: 'no-store', headers: authHeaders() }),
      fetch(`/api/usage?email=${encodeURIComponent(email)}`, { cache: 'no-store', headers: authHeaders() })
    ]);
    if (!entitlementResponse.ok) throw new Error('权益接口异常。');
    if (!usageResponse.ok) throw new Error('用量接口异常。');
    entitlement = normalizeEntitlement(await entitlementResponse.json(), email);
    usageSummary = normalizeUsageSummary(await usageResponse.json(), email);
    entitlementFetchedAt = Date.now();
    renderEntitlementSummary();
  } catch (error) {
    console.warn(error);
    if (entitlement.email !== email) entitlement = freeEntitlement(email);
    if (usageSummary.email !== email) usageSummary = emptyUsageSummary(email);
    setAuthStatus(`已登录，但权益刷新失败：${error instanceof Error ? error.message : '请稍后重试。'}`, 'warn');
  } finally {
    updateActionState();
  }
}

function authHeaders(): Record<string, string> {
  return authSession ? { Authorization: `Bearer ${authSession.token}` } : {};
}

function normalizeEntitlement(value: unknown, email: string): EntitlementPayload {
  const data = value && typeof value === 'object' ? value as Partial<EntitlementPayload> : {};
  const plan = typeof data.plan === 'string' ? data.plan : 'free';
  const effectivePlan = typeof data.effective_plan === 'string' ? data.effective_plan : plan;
  return {
    email,
    plan,
    effective_plan: isPlanKey(effectivePlan) ? effectivePlan : 'free',
    status: typeof data.status === 'string' ? data.status : 'inactive',
    lifetime: Boolean(data.lifetime),
    current_period_end: typeof data.current_period_end === 'string' ? data.current_period_end : null,
      active: Boolean(data.active),
      owner: Boolean(data.owner),
    limits: normalizePlanLimits(data.limits),
    updated_at: typeof data.updated_at === 'string' ? data.updated_at : undefined
  };
}

function normalizeUsageSummary(value: unknown, email: string): UsageSummary {
  const data = value && typeof value === 'object' ? value as Partial<UsageSummary> : {};
  return {
    email,
    period: 'monthly',
    period_start: typeof data.period_start === 'string' ? data.period_start : currentMonthStartIso(),
    monthly: normalizeMonthlyUsage(data.monthly)
  };
}

function normalizePlanLimits(limits: Partial<PlanLimits> | undefined): PlanLimits {
  return {
    video_max_minutes: limitNumberOrNull(limits?.video_max_minutes, FREE_PLAN_LIMITS.video_max_minutes),
    video_conversions_monthly: limitNumberOrNull(limits?.video_conversions_monthly, FREE_PLAN_LIMITS.video_conversions_monthly),
    editable_slides_monthly: limitNumberOrNull(limits?.editable_slides_monthly, FREE_PLAN_LIMITS.editable_slides_monthly),
    summary_generations_monthly: limitNumberOrNull(limits?.summary_generations_monthly, FREE_PLAN_LIMITS.summary_generations_monthly),
    transcribe_minutes_monthly: limitNumberOrNull(limits?.transcribe_minutes_monthly, FREE_PLAN_LIMITS.transcribe_minutes_monthly),
    batch_processing: Boolean(limits?.batch_processing ?? FREE_PLAN_LIMITS.batch_processing),
    image_pptx: Boolean(limits?.image_pptx ?? FREE_PLAN_LIMITS.image_pptx),
    screen_recording: Boolean(limits?.screen_recording ?? FREE_PLAN_LIMITS.screen_recording)
  };
}

function limitNumberOrNull(value: unknown, fallback: number | null): number | null {
  if (value === null) return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.max(0, numberValue) : fallback;
}

function isPlanKey(value: string): value is PlanKey {
  return value === 'free' || value === 'day_pass' || value === 'pro' || value === 'lifetime';
}

function currentPlan(): PlanKey {
  const plan = entitlement.effective_plan ?? entitlement.plan;
  return isPlanKey(plan) ? plan : 'free';
}

function currentLimits(): PlanLimits {
  return normalizePlanLimits(entitlement.limits);
}

function planLabel(plan: PlanKey | string): string {
  if (plan === 'day_pass') return '临时版';
  if (plan === 'pro') return '专业版';
  if (plan === 'lifetime') return '终身版';
  return '免费版';
}

function periodText(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `，有效期至 ${date.toLocaleString('zh-CN', { hour12: false })}`;
}

function renderEntitlementSummary(): void {
  const plan = currentPlan();
  const prefix = authSession
    ? `已登录，当前权限：${entitlement.owner ? '所有者' : planLabel(plan)}${periodText(entitlement.current_period_end)}`
    : `${authMode === 'register' ? '创建用户名账号，邮箱可留空。' : '登录后可同步付费权益。'} 当前按免费版额度使用`;
  const message = `${prefix}。转换${quotaText('video_conversion')}，文字识别页${quotaText('editable_slide')}，摘要与笔记${quotaText('summary_generation')}，转写${quotaText('transcribe_minute')}。`;
  const tone: 'ok' | 'warn' | '' = authSession ? (plan === 'free' ? 'warn' : 'ok') : '';
  setAuthStatus(message, tone);
}

function quotaText(eventType: UsageEventType): string {
  const limit = monthlyLimitFor(eventType);
  const used = usageValue(eventType);
  const unit = USAGE_UNITS[eventType];
  if (limit === null) return `已用 ${used}${unit}/不限`;
  return `剩余 ${Math.max(0, Math.floor(limit - used))}${unit}（${used}/${limit}${unit}）`;
}

function monthlyLimitFor(eventType: UsageEventType): number | null {
  const limits = currentLimits();
  if (eventType === 'video_conversion') return limits.video_conversions_monthly;
  if (eventType === 'editable_slide') return limits.editable_slides_monthly;
  if (eventType === 'summary_generation') return limits.summary_generations_monthly;
  return limits.transcribe_minutes_monthly;
}

function usageValue(eventType: UsageEventType): number {
  const currentSummary = authSession ? usageSummary : loadLocalUsageSummary();
  return nonNegativeInteger(currentSummary.monthly[eventType]);
}

async function ensureUsageCapacity(
  eventType: UsageEventType,
  units: number,
  featureLabel: string,
  report: (message: string) => void
): Promise<boolean> {
  const safeUnits = Math.max(1, Math.ceil(units));
  if (authSession && (entitlement.email !== authSession.user.email || Date.now() - entitlementFetchedAt > 30_000)) {
    await refreshEntitlement();
  }
  if (!authSession) usageSummary = loadLocalUsageSummary();

  const limit = monthlyLimitFor(eventType);
  if (limit === null) return true;

  const used = usageValue(eventType);
  if (used + safeUnits <= limit) return true;

  const unit = USAGE_UNITS[eventType];
  report(`${featureLabel}额度不足：当前套餐 ${planLabel(currentPlan())} 本月已用 ${used}${unit}/${limit}${unit}，本次需要 ${safeUnits}${unit}。请在定价页开通或升级后继续。`);
  return false;
}

async function recordUsage(eventType: UsageEventType, units: number, metadata: Record<string, unknown> = {}): Promise<void> {
  const safeUnits = Math.max(1, Math.ceil(units));
  if (!authSession) {
    usageSummary = addUsageToSummary(loadLocalUsageSummary(), eventType, safeUnits, 'anonymous');
    saveLocalUsageSummary(usageSummary);
    renderEntitlementSummary();
    updateActionState();
    return;
  }

  const email = authSession.user.email;
  try {
    const response = await fetch('/api/usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ email, event_type: eventType, units: safeUnits, metadata })
    });
    if (!response.ok) throw new Error('用量记录失败。');
    usageSummary = normalizeUsageSummary(await response.json(), email);
  } catch (error) {
    console.warn(error);
    usageSummary = addUsageToSummary(usageSummary, eventType, safeUnits, email);
  } finally {
    renderEntitlementSummary();
    updateActionState();
  }
}

function addUsageToSummary(summary: UsageSummary, eventType: UsageEventType, units: number, email: string): UsageSummary {
  const currentSummary = sameMonthlyPeriod(summary.period_start) ? summary : emptyUsageSummary(email);
  const monthly = normalizeMonthlyUsage(currentSummary.monthly);
  monthly[eventType] = nonNegativeInteger(monthly[eventType]) + units;
  return { ...currentSummary, email, monthly };
}

async function ensureVideoDurationAllowed(file: File, report: (message: string) => void): Promise<boolean> {
  const limitMinutes = currentLimits().video_max_minutes;
  if (limitMinutes === null) return true;

  try {
    report(`正在检查视频时长：${file.name}`);
    const meta = await readFileVideoMetadata(file);
    if (meta.duration <= limitMinutes * 60 + 0.5) return true;
    report(`当前套餐 ${planLabel(currentPlan())} 单个视频限制 ${limitMinutes} 分钟；${file.name} 约 ${formatTime(meta.duration)}，请升级后处理。`);
    return false;
  } catch (error) {
    report(error instanceof Error ? error.message : '无法读取视频时长。');
    return false;
  }
}

async function readFileVideoMetadata(file: File): Promise<VideoMeta> {
  const url = URL.createObjectURL(file);
  try {
    return await readVideoMetadata(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function isBusy(): boolean {
  return isPreparingRecording || isExporting || isExtracting || isBatchProcessing || isUrlDownloading || isTranscribing || isSummarizing || isGeneratingNotes || isOcrRunning || isPdfMasking || isRecording || isTipCheckoutOpening || isAuthBusy;
}

function openTipDialog(): void {
  tipStatus.textContent = '请选择赞赏金额。';
  tipStatus.className = 'tip-status';
  customTipLabel.hidden = true;
  customTipPayBtn.hidden = true;
  customTipAmount.value = '';
  if (typeof tipDialog.showModal === 'function') tipDialog.showModal();
  else tipDialog.setAttribute('open', '');
}

function showCustomTipInput(): void {
  customTipLabel.hidden = false;
  customTipPayBtn.hidden = false;
  tipStatus.textContent = '请输入任意金额，低于 ¥10 会自动按 ¥10 打开支付。';
  tipStatus.className = 'tip-status';
  customTipAmount.focus();
}

function readCustomTipAmount(): number {
  return Number(customTipAmount.value);
}

function amountToCentQuantity(amount: number): number {
  return Math.round(amount * 100);
}

function validTipAmount(amount: number): boolean {
  if (!Number.isFinite(amount)) return false;
  const quantity = amountToCentQuantity(amount);
  return amount >= TIP_MIN_AMOUNT && quantity >= 1 && quantity <= TIP_MAX_QUANTITY;
}

function setTipStatus(message: string, tone: 'ok' | 'warn' | 'error' | '' = ''): void {
  tipStatus.textContent = message;
  tipStatus.className = `tip-status${tone ? ` ${tone}` : ''}`;
}

async function fetchPaddleConfig(): Promise<PaddleConfig> {
  if (paddleConfigPromise) return paddleConfigPromise;
  paddleConfigPromise = fetch('/api/paddle-config')
    .then((response) => {
      if (!response.ok) throw new Error('支付配置接口异常。');
      return response.json() as Promise<{ config?: PaddleConfig; missing?: string[] }>;
    })
    .then((payload) => payload.config ?? {});
  return paddleConfigPromise;
}

function loadPaddleScript(): Promise<void> {
  if (windowPaddle()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(`script[src="${PADDLE_SCRIPT_URL}"]`);
    if (existingScript) {
      existingScript.addEventListener('load', () => resolve(), { once: true });
      existingScript.addEventListener('error', () => reject(new Error('支付组件加载失败，请稍后重试。')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = PADDLE_SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('支付组件加载失败，请稍后重试。'));
    document.head.appendChild(script);
  });
}

async function ensurePaddle(): Promise<PaddleConfig> {
  if (paddleLoadPromise) return paddleLoadPromise;
  paddleLoadPromise = Promise.all([fetchPaddleConfig(), loadPaddleScript()]).then(([config]) => {
    const paddle = windowPaddle();
    if (!paddle) throw new Error('支付组件暂时不可用，请稍后重试。');
    if (config.PADDLE_ENV === 'sandbox' && paddle.Environment?.set) {
      paddle.Environment.set('sandbox');
    }
    if (!paddleInitialized) {
      const token = config.PADDLE_CLIENT_TOKEN;
      if (!token) throw new Error('支付功能暂时不可用，请稍后重试或联系支持。');
      paddle.Initialize({
        token,
        eventCallback: (event) => {
          const name = String(eventName(event));
          if (name === 'checkout.completed') setTipStatus('谢谢支持，支付已完成。', 'ok');
        }
      });
      paddleInitialized = true;
    }
    return config;
  });
  return paddleLoadPromise;
}

async function openTipCheckout(amount: number): Promise<void> {
  if (!validTipAmount(amount)) {
    setTipStatus('请输入不小于 ¥1 的有效金额。', 'error');
    showCustomTipInput();
    return;
  }

  const requestedQuantity = amountToCentQuantity(amount);
  const minimumCheckoutQuantity = amountToCentQuantity(TIP_MIN_CHECKOUT_AMOUNT);
  const quantity = Math.max(requestedQuantity, minimumCheckoutQuantity);
  const requestedAmount = requestedQuantity / 100;
  const normalizedAmount = quantity / 100;
  isTipCheckoutOpening = true;
  setTipButtonsBusy(true);
  updateActionState();
  setTipStatus('正在打开支付窗口...', 'warn');
  let tipDialogClosedForCheckout = false;

  try {
    const config = await ensurePaddle();
    const priceId = config.PADDLE_PRICE_AUTHOR_TIP_CNY_CENT;
    if (!priceId) throw new Error('该支持项目暂时不可购买，请稍后重试。');
    const paddle = windowPaddle();
    if (!paddle) throw new Error('支付组件暂时不可用，请稍后重试。');
    if (tipDialog.open) {
      tipDialog.close();
      tipDialogClosedForCheckout = true;
    }
    paddle.Checkout.open({
      items: [{ priceId, quantity }],
      customData: {
        plan: 'author_tip',
        order_kind: 'author_tip',
        source: 'home_tip_dialog',
        amount_cny: normalizedAmount.toFixed(2),
        requested_amount_cny: requestedAmount.toFixed(2),
        quantity,
        requested_quantity: requestedQuantity
      },
      settings: {
        displayMode: 'overlay',
        theme: 'light',
        successUrl: `${window.location.origin}/?checkout=success&plan=author_tip`
      }
    });
    setTipStatus(
      normalizedAmount === requestedAmount
        ? `支付窗口已打开：¥${normalizedAmount.toFixed(2)}。`
        : `支付窗口已打开：¥${normalizedAmount.toFixed(2)}（已从 ¥${requestedAmount.toFixed(2)} 自动调整）。`,
      'ok'
    );
  } catch (error) {
    if (tipDialogClosedForCheckout) {
      if (typeof tipDialog.showModal === 'function') tipDialog.showModal();
      else tipDialog.setAttribute('open', '');
    }
    setTipStatus(error instanceof Error ? error.message : '支付窗口打开失败。', 'error');
  } finally {
    isTipCheckoutOpening = false;
    setTipButtonsBusy(false);
    updateActionState();
  }
}

function setTipButtonsBusy(busy: boolean): void {
  if (openSiteTipDialogBtn) openSiteTipDialogBtn.disabled = busy;
  openTipDialogBtn.disabled = busy;
  showCustomTipBtn.disabled = busy;
  customTipPayBtn.disabled = busy;
  tipDialog.querySelectorAll<HTMLButtonElement>('.tip-amount-btn').forEach((button) => {
    button.disabled = busy;
  });
}

function windowPaddle(): PaddleApi | undefined {
  return (window as Window & { Paddle?: PaddleApi }).Paddle;
}

function eventName(event: unknown): string {
  if (!event || typeof event !== 'object') return '';
  const data = event as { name?: unknown; eventName?: unknown; type?: unknown };
  return String(data.name ?? data.eventName ?? data.type ?? '');
}

function setUrlDownloadStatus(message: string, tone: 'ok' | 'warn' | 'error' | '' = ''): void {
  urlDownloadStatus.textContent = message;
  urlDownloadStatus.className = `url-download-status${tone ? ` ${tone}` : ''}`;
  setWorkspaceUrlStatus(message, tone);
}

function setUrlDownloadProgress(message: string, percent: number | null = null): void {
  urlDownloadProgress.hidden = false;
  urlDownloadProgressText.textContent = message;
  if (percent === null) {
    urlDownloadProgressPercent.textContent = '...';
    urlDownloadProgressFill.classList.add('is-indeterminate');
    urlDownloadProgressFill.style.width = '38%';
    return;
  }
  const clamped = Math.round(clamp(percent, 0, 100));
  urlDownloadProgressFill.classList.remove('is-indeterminate');
  urlDownloadProgressFill.style.width = `${clamped}%`;
  urlDownloadProgressPercent.textContent = `${clamped}%`;
}

function setWorkspaceUrlStatus(message: string, tone: 'ok' | 'warn' | 'error' | '' = ''): void {
  workspaceUrlStatus.textContent = message;
  workspaceUrlStatus.className = `workspace-url-status${tone ? ` ${tone}` : ''}`;
  if (!workspaceView.hidden) setStatus(message);
}

function resetUrlDownloadProgress(): void {
  urlDownloadProgress.hidden = true;
  urlDownloadProgressFill.classList.remove('is-indeterminate');
  urlDownloadProgressFill.style.width = '0%';
  urlDownloadProgressText.textContent = '准备下载';
  urlDownloadProgressPercent.textContent = '0%';
}

function scheduleMediaMetadataPreview(): void {
  window.clearTimeout(mediaMetadataDebounce);
  const parsedUrl = parseDownloadUrl(videoUrlInput.value.trim());
  if (!parsedUrl || !isBilibiliDownloadUrl(parsedUrl)) {
    clearMediaPreview();
    return;
  }
  mediaMetadataRequestId += 1;
  clearMediaPreview(false);
  mediaMetadataDebounce = window.setTimeout(() => {
    void refreshMediaMetadataPreview();
  }, 650);
}

async function refreshMediaMetadataPreview(): Promise<MediaMetadata | null> {
  const parsedUrl = parseDownloadUrl(videoUrlInput.value.trim());
  if (!parsedUrl || !isBilibiliDownloadUrl(parsedUrl)) {
    clearMediaPreview();
    return null;
  }
  const sourceUrl = parsedUrl.toString();
  if (currentMediaMetadata && currentMediaMetadataUrl === sourceUrl) return currentMediaMetadata;

  const requestId = mediaMetadataRequestId + 1;
  mediaMetadataRequestId = requestId;
  setUrlDownloadStatus('正在识别 B 站视频...', 'warn');
  try {
    const metadata = await fetchMediaMetadata(parsedUrl);
    if (requestId !== mediaMetadataRequestId) return null;
    renderMediaPreview(metadata, sourceUrl);
    setUrlDownloadStatus('已识别 B 站视频，确认有权处理后即可下载。', 'warn');
    return metadata;
  } catch (error) {
    if (requestId !== mediaMetadataRequestId) return null;
    const metadata = renderBilibiliAttemptPreview(parsedUrl, urlDownloadErrorMessage(error));
    setUrlDownloadStatus('B 站预览暂时不可用，确认有权处理后仍会直接尝试下载。', 'warn');
    return metadata;
  } finally {
    updateActionState();
  }
}

async function fetchMediaMetadata(parsedUrl: URL): Promise<MediaMetadata> {
  const response = await fetch(MEDIA_METADATA_URL, {
    method: 'POST',
    mode: 'cors',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceType: 'url', url: parsedUrl.toString() })
  });
  if (!response.ok) throw new Error(await readResponseError(response));
  const metadata = await response.json() as MediaMetadata;
  if (!metadata || metadata.sourceType !== 'url') throw new Error('没有识别到可处理的视频信息。');
  return metadata;
}

function renderMediaPreview(metadata: MediaMetadata, sourceUrl: string): void {
  currentMediaMetadata = metadata;
  currentMediaMetadataUrl = sourceUrl;
  mediaRightsConfirm.checked = false;
  mediaPreviewProvider.textContent = metadataProviderLabel(metadata.provider);
  mediaPreviewTitle.textContent = metadata.title || '已识别媒体';
  mediaPreviewMeta.textContent = mediaMetadataLine(metadata);
  mediaPreviewPolicy.textContent = metadata.policy?.reason || '处理前请确认你有权保存、转换或分析该媒体。';
  mediaRightsLabel.hidden = metadata.policy?.downloadAllowed === false;
  if (metadata.thumbnailUrl) {
    mediaPreviewImage.src = metadata.thumbnailUrl;
    mediaPreviewImage.alt = metadata.title || '视频封面';
    mediaPreviewImage.hidden = false;
  } else {
    mediaPreviewImage.removeAttribute('src');
    mediaPreviewImage.alt = '';
    mediaPreviewImage.hidden = true;
  }
  mediaPreview.hidden = false;
}

function renderBilibiliAttemptPreview(parsedUrl: URL, message: string): MediaMetadata {
  const metadata: MediaMetadata = {
    sourceType: 'url',
    provider: 'bilibili',
    url: parsedUrl.toString(),
    title: 'Bilibili 视频',
    downloadable: true,
    allowedActions: ['download', 'transcode', 'thumbnail'],
    policy: {
      downloadAllowed: true,
      reason: `${message} 确认你有权处理后，仍可以继续尝试导入。`
    }
  };
  renderMediaPreview(metadata, parsedUrl.toString());
  return metadata;
}

function clearMediaPreview(cancelPending = true): void {
  if (cancelPending) {
    window.clearTimeout(mediaMetadataDebounce);
    mediaMetadataRequestId += 1;
  }
  currentMediaMetadata = null;
  currentMediaMetadataUrl = '';
  mediaRightsConfirm.checked = false;
  mediaPreviewImage.removeAttribute('src');
  mediaPreviewImage.hidden = true;
  mediaPreview.hidden = true;
  updateActionState();
}

async function ensureUrlDownloadAllowed(parsedUrl: URL, rightsConfirmed = mediaRightsConfirm.checked): Promise<boolean> {
  if (!isBilibiliDownloadUrl(parsedUrl)) return true;
  const hasConfirmedRights = rightsConfirmed || mediaRightsConfirm.checked;
  let metadata = currentMediaMetadataUrl === parsedUrl.toString()
    ? currentMediaMetadata
    : await refreshMediaMetadataPreview();
  if (!metadata) {
    metadata = renderBilibiliAttemptPreview(parsedUrl, 'B 站预览暂时不可用。');
  }
  if (metadata.policy?.downloadAllowed === false || metadata.downloadable === false) {
    setUrlDownloadStatus(metadata.policy?.reason || '这个链接当前不可下载。', 'error');
    return false;
  }
  if (!hasConfirmedRights && !mediaRightsConfirm.checked) {
    mediaPreview.hidden = false;
    setUrlDownloadStatus('请先勾选“我确认有权保存、转换或分析这个媒体内容”。', 'warn');
    updateActionState();
    return false;
  }
  if (hasConfirmedRights) mediaRightsConfirm.checked = true;
  return true;
}

function isBilibiliDownloadUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === 'b23.tv' || host === 'bilibili.com' || host.endsWith('.bilibili.com');
}

function metadataProviderLabel(provider: string): string {
  if (provider === 'bilibili') return 'Bilibili';
  if (provider === 'youtube-oembed') return 'YouTube';
  if (provider === 'direct-media') return '视频直链';
  return provider || '视频来源';
}

function mediaMetadataLine(metadata: MediaMetadata): string {
  const parts = [
    metadata.authorName,
    typeof metadata.durationSeconds === 'number' ? formatDuration(metadata.durationSeconds) : '',
    metadata.contentType,
    metadata.contentLength ? formatMediaBytes(Number(metadata.contentLength)) : ''
  ].filter(Boolean);
  return parts.join(' / ') || '可加入视频队列';
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return hh > 0
    ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${mm}:${String(ss).padStart(2, '0')}`;
}

function formatMediaBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
}

async function downloadVideoFromUrl(mode: UrlDownloadMode): Promise<void> {
  if (isBusy()) return;
  const sourceUrl = videoUrlInput.value.trim();
  const parsedUrl = parseDownloadUrl(sourceUrl);
  if (!parsedUrl) {
    setUrlDownloadStatus('请输入有效的 http 或 https 视频网址。', 'error');
    videoUrlInput.focus();
    return;
  }
  isUrlDownloading = true;
  updateActionState();
  if (!await ensureUrlDownloadAllowed(parsedUrl, mediaRightsConfirm.checked)) {
    isUrlDownloading = false;
    updateActionState();
    return;
  }
  setUrlDownloadStatus(mode === 'extract' ? '正在获取视频，完成后会自动生成页面。' : '正在获取视频，完成后会加入队列。', 'warn');
  setUrlDownloadProgress('正在获取视频', null);
  let shouldExtract = false;

  try {
    let response: Response | null = null;
    let primaryError = '';
    const youtubeDownload = isYoutubeDownloadUrl(parsedUrl);
    try {
      response = await fetch(youtubeDownload ? YOUTUBE_FALLBACK_URL : CLOUD_DOWNLOADER_URL, {
        method: 'POST',
        mode: 'cors',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(youtubeDownload ? {
          action: 'video',
          language: userPreferences.outputLanguage,
          rightsConfirmed: mediaRightsConfirm.checked,
          url: parsedUrl.toString()
        } : {
          url: parsedUrl.toString(),
          rightsConfirmed: mediaRightsConfirm.checked
        })
      });
      if (!response.ok) primaryError = await readResponseError(response);
    } catch (error) {
      primaryError = error instanceof Error ? error.message : String(error || '');
    }

    if ((!response || !response.ok) && youtubeDownload) {
      setUrlDownloadStatus('第一次获取没有成功，正在换一种方式重试。', 'warn');
      setUrlDownloadProgress('正在重新尝试获取视频', null);
      response = await fetch(CLOUD_DOWNLOADER_URL, {
        method: 'POST',
        mode: 'cors',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: parsedUrl.toString(), rightsConfirmed: mediaRightsConfirm.checked })
      });
    }

    if (!response) throw new Error(primaryError || '无法连接视频下载服务。');
    if (!response.ok) throw new Error(await readResponseError(response));

    const filename = sanitizeDownloadedFilename(
      response.headers.get('X-Filename')
      || filenameFromContentDisposition(response.headers.get('Content-Disposition'))
      || `${parsedUrl.hostname || 'online-video'}.mp4`
    );
    const blob = await responseToBlobWithProgress(response, (percent) => {
      setUrlDownloadProgress('正在导入视频', percent);
    });
    if (blob.size === 0) throw new Error('没有获取到可处理的视频文件。');
    const file = new File([blob], filename, { type: blob.type || 'video/mp4', lastModified: Date.now() });
    addFiles([file], true);
    if (youtubeDownload) void importYoutubeTranscript(parsedUrl, file);
    videoUrlInput.value = '';
    clearMediaPreview();
    setUrlDownloadProgress(mode === 'extract' ? '已获取视频，准备生成页面' : '已加入 Vid2PPT 队列', 100);
    setUrlDownloadStatus(mode === 'extract' ? `已获取 ${filename}，正在进入处理工作台。` : `已获取 ${filename}，并加入视频队列。`, 'ok');
    setHomeStatus(mode === 'extract' ? `已获取 ${filename}，正在准备生成页面。` : `已获取 ${filename}，点击“处理当前视频”开始生成页面。`);
    shouldExtract = mode === 'extract';
  } catch (error) {
    console.error(error);
    const message = urlDownloadErrorMessage(error);
    setUrlDownloadStatus(message, 'error');
    setUrlDownloadProgress('获取失败', 100);
    if (shouldOfferRecordingFallback(message)) openUrlRecordingFallback(parsedUrl.toString(), mode, message);
  } finally {
    isUrlDownloading = false;
    updateActionState();
  }

  if (shouldExtract) {
    setUrlDownloadStatus('视频已获取，正在检查并生成页面。进度会显示在工作台左侧。', 'warn');
    setUrlDownloadProgress('正在进入处理工作台', 100);
    const started = await processCurrentFile();
    if (started) {
      setUrlDownloadStatus('页面生成完成，已在工作台展示。', 'ok');
    } else {
      setUrlDownloadStatus('视频已加入队列，但这次没有开始生成页面。请查看工作台或主页状态提示。', 'warn');
    }
  }
}

function isYoutubeDownloadUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  return host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com');
}

async function importYoutubeTranscript(sourceUrl: URL, file: File): Promise<void> {
  try {
    const response = await fetch(YOUTUBE_FALLBACK_URL, {
      method: 'POST',
      mode: 'cors',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'transcript',
        language: userPreferences.outputLanguage,
        rightsConfirmed: true,
        url: sourceUrl.toString()
      })
    });
    if (!response.ok) return;
    const data = await response.json().catch(() => null) as { transcript?: unknown } | null;
    const transcript = typeof data?.transcript === 'string' ? cleanTranscriptText(data.transcript) : '';
    if (!transcript) return;
    const state = ensureState(file);
    if (!state.transcript.trim()) state.transcript = transcript;
    if (selectedFile === file && !transcriptEl.value.trim() && !isTranscribing) {
      transcriptEl.value = transcript;
      persistWorkspaceToState({ markProcessed: slides.length > 0 });
      updateActionState();
      if (!isBusy()) setStatus('已自动导入 YouTube 字幕，可直接生成中文摘要或图文笔记。');
    }
  } catch (error) {
    console.info('YouTube 字幕未导入，将保留本地转写方式。', error);
  }
}

async function responseToBlobWithProgress(response: Response, onProgress: (percent: number | null) => void): Promise<Blob> {
  const contentType = response.headers.get('content-type') || 'video/mp4';
  const length = Number(response.headers.get('content-length') || '0');
  const estimatedLength = Number(response.headers.get('x-estimated-bytes') || '0');
  const progressLength = Number.isFinite(length) && length > 0
    ? length
    : Number.isFinite(estimatedLength) && estimatedLength > 0 ? estimatedLength : 0;
  if (!response.body || progressLength <= 0) {
    onProgress(null);
    return response.blob();
  }
  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value as unknown as BlobPart);
      received += value.byteLength;
      const percent = (received / progressLength) * 100;
      onProgress(length > 0 ? Math.min(100, percent) : Math.min(96, percent));
    }
  }
  onProgress(100);
  return new Blob(chunks, { type: contentType });
}

function parseDownloadUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

async function readResponseError(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await response.json().catch(() => null) as { detail?: unknown; error?: unknown; message?: unknown } | null;
    const detail = data?.detail ?? data?.message ?? data?.error;
    if (typeof detail === 'string' && detail.trim()) return detail;
  }
  const text = await response.text().catch(() => '');
  return text.trim() || `链接获取请求失败：HTTP ${response.status}`;
}

function urlDownloadErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (!message || /failed to fetch|load failed|networkerror/i.test(message)) {
    return `无法获取链接，请稍后重试，或先保存视频文件后上传。`;
  }
  if (/unable to connect to proxy|tunnel connection failed|proxyerror/i.test(message)) {
    return 'YouTube 备用线路暂时不可用，系统已保留其他获取方式，请稍后重试。';
  }
  if (/please report this issue|confirm you are on the latest version/i.test(message)) {
    return '这个视频暂时没有返回可处理的视频流，请稍后重试。';
  }
  return message;
}

function shouldOfferRecordingFallback(message: string): boolean {
  return /youtube|登录|验证|真人|cookie/i.test(message);
}

function openUrlRecordingFallback(sourceUrl: string, mode: UrlDownloadMode, message: string): void {
  fallbackSourceUrl = sourceUrl;
  fallbackUrlMode = mode;
  urlFallbackMessage.textContent = `${message} 可以打开原视频后，用录屏方式继续处理。`;
  urlFallbackRecordBtn.textContent = mode === 'extract' ? '开始录制并直接生成' : '开始录制并加入队列';
  if (typeof urlFallbackDialog.showModal === 'function') urlFallbackDialog.showModal();
  else urlFallbackDialog.setAttribute('open', '');
}

function filenameFromContentDisposition(header: string | null): string {
  if (!header) return '';
  const encoded = header.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded); } catch { return encoded; }
  }
  return header.match(/filename="?([^";]+)"?/i)?.[1] ?? '';
}

function sanitizeDownloadedFilename(filename: string): string {
  const cleaned = filename
    .replace(/[\\/:*?"<>|\x00-\x1F]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  const safeName = cleaned || 'online-video.mp4';
  return /\.(mkv|mov|mp4|webm|avi|m4v|mp3|m4a|wav)$/i.test(safeName)
    ? safeName
    : `${baseName(safeName)}.mp4`;
}

function addFiles(files: File[], selectAdded = false): void {
  if (isBusy() && !(selectAdded && isUrlDownloading)) { setHomeStatus('请等待当前任务完成后再添加文件。'); return; }
  if (isDemoProject) restoreWorkspaceAfterDemo();
  const validFiles = files.filter((file) => isSupportedMediaFile(file) && file.size > 0);
  if (validFiles.length === 0) {
    setHomeStatus('没有检测到可处理的视频/音频文件。');
    return;
  }

  const existingKeys = new Set(selectedFiles.map(fileKey));
  let firstAddedIndex = -1;
  for (const file of validFiles) {
    const key = fileKey(file);
    if (existingKeys.has(key)) {
      if (selectAdded && firstAddedIndex < 0) firstAddedIndex = selectedFiles.findIndex((item) => fileKey(item) === key);
      continue;
    }
    selectedFiles.push(file);
    existingKeys.add(key);
    ensureState(file);
    if (firstAddedIndex < 0) firstAddedIndex = selectedFiles.length - 1;
  }

  const allowBusySelection = selectAdded && isUrlDownloading;
  if (currentFileIndex < 0 && selectedFiles.length > 0) chooseFile(0, allowBusySelection);
  else if (selectAdded && firstAddedIndex >= 0) chooseFile(firstAddedIndex, allowBusySelection);
  else {
    renderFileList();
    updateHomeFileStatus();
    updateActionState();
  }
  videoInput.value = '';
}

function addImageFiles(files: File[]): void {
  const validFiles = files.filter(isSupportedImageFile);
  if (validFiles.length === 0) {
    setImageStatus('没有检测到可处理的图片文件。');
    imageInput.value = '';
    return;
  }

  const existingKeys = new Set(selectedImageFiles.map(fileKey));
  for (const file of validFiles) {
    const key = fileKey(file);
    if (existingKeys.has(key)) continue;
    selectedImageFiles.push(file);
    existingKeys.add(key);
  }

  selectedImageFiles.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
  renderImageFileList();
  setImageStatus(`已选择 ${selectedImageFiles.length} 张图片，可快速生成图片版 PPTX，或进入编辑模式添加真实文本框。`);
  updateActionState();
  imageInput.value = '';
}

function removeImageFile(index: number): void {
  if (isBusy()) {
    setImageStatus('当前有任务正在运行，完成后再移除图片。');
    return;
  }
  selectedImageFiles.splice(index, 1);
  renderImageFileList();
  setImageStatus(selectedImageFiles.length > 0 ? `已选择 ${selectedImageFiles.length} 张图片。` : '等待上传图片。');
  updateActionState();
}

function chooseFile(index: number, allowBusySelection = false): void {
  if (index < 0 || index >= selectedFiles.length) return;
  if (isBusy() && !allowBusySelection) {
    setHomeStatus('当前有任务正在运行，完成后再切换视频。');
    return;
  }
  persistWorkspaceToState({ markProcessed: slides.length > 0 });
  setWorkspaceMode('video');
  currentFileIndex = index;
  selectedFile = selectedFiles[index];
  loadStateIntoWorkspace(selectedFile);
  renderFileList();
  updateHomeFileStatus();
  updateActionState();
}

function removeFile(index: number): void {
  if (isBusy()) {
    setHomeStatus('当前有任务正在运行，完成后再移除文件。');
    return;
  }
  const file = selectedFiles[index];
  if (!file) return;
  fileStates.delete(fileKey(file));
  selectedFiles.splice(index, 1);
  if (selectedFiles.length === 0) {
    currentFileIndex = -1;
    selectedFile = null;
    resetCurrentFileState();
    renderFileList();
    setHomeStatus('等待上传视频。');
    updateActionState();
    return;
  }
  chooseFile(Math.min(index, selectedFiles.length - 1));
}

async function processCurrentFile(): Promise<boolean> {
  if (!selectedFile || isBusy() || isDemoProject) return false;
  const file = selectedFile;
  if (isAudioSource(file)) {
    showWorkspace();
    workspaceView.classList.remove('side-collapsed');
    $<HTMLDetailsElement>('.notes-disclosure').open = true;
    toggleSideBtn.setAttribute('aria-expanded', 'true');
    $<HTMLElement>('#workspaceImport').hidden = true;
    $<HTMLElement>('#toggleImportBtn').setAttribute('aria-expanded', 'false');
    setStatus('这是音频文件，没有可提取的画面。可在“逐字稿与笔记”中开始转写。');
    return false;
  }
  const previous = snapshotWorkspace();
  let started = false;
  let completed = false;
  isExtracting = true;
  extractionAbort = new AbortController();
  const signal = extractionAbort.signal;
  setWorkspaceMode('video');
  showWorkspace();
  updateActionState();
  setProgress('正在检查视频', undefined, true);
  setStatus(`正在读取本地视频：${file.name}`);
  $<HTMLElement>('#workspaceImport').hidden = true;
  const reportGateStatus = (message: string) => { setStatus(message); setHomeStatus(message); };
  try {
    if (!await ensureUsageCapacity('video_conversion', 1, '视频转换次数', reportGateStatus)) {
      hideProgress();
      return false;
    }
    signal.throwIfAborted();
    if (!await ensureVideoDurationAllowed(file, reportGateStatus)) {
      hideProgress();
      return false;
    }
    signal.throwIfAborted();
    const settings = readSettings();
    started = true;
    resetFrameOutputs();
    setStateStatus(file, 'processing');
    renderFileList();
    setStatus(`正在提取 ${file.name}，页面会陆续出现。请保持此页面打开。`);
    const result = await extractSlidesFromFile(file, settings, {
      signal,
      onMetadata: (meta) => { videoMeta = meta; setupTimeline(meta.duration); },
      onKeep: (slide) => {
        slides.push(slide);
        appendSlideCard(slide);
        updateSelectionUI();
        updateTimelineMarkers();
      },
      onProgress: ({ completed, total, time, duration, kept }) => {
        setProgress(`扫描 ${formatTime(time)} / ${formatTime(duration)} · 找到 ${kept} 页`, Math.round(completed / Math.max(total, 1) * 100));
        updateExtractionTimeline(time);
      }
    });
    slides = result.slides;
    videoMeta = result.meta;
    forceTimelineToEnd();
    completed = true;
    setStateForFile(file, { ...snapshotWorkspace(), status: 'done', processedAt: new Date().toISOString() });
    if (slides[0]) setPreview(slides[0]);
    setProgress('提取完成', 100);
    setStatus(`已提取 ${slides.length} 页。取消勾选可排除重复页，拖动可排序，然后选择格式导出。`);
    await recordUsage('video_conversion', 1, { name: file.name, duration_seconds: Math.round(videoMeta.duration), slides: slides.length });
  } catch (error) {
    const stopped = signal.aborted;
    const message = stopped ? '已停止提取，本次未计入转换额度。' : error instanceof Error ? error.message : '提取没有完成，请换用可播放的 MP4 文件后重试。';
    if (started) {
      if (previous.slides.length) {
        setStateForFile(file, previous);
        loadStateIntoWorkspace(file);
      } else {
        setStateForFile(file, { ...snapshotWorkspace(), status: 'error', error: message });
      }
    }
    hideProgress();
    setStatus(message + (previous.slides.length ? ' 之前的编辑结果已保留。' : slides.length ? ` 已提取的 ${slides.length} 页可检查并导出。` : ' 可以重新选择文件或重试。'));
  } finally {
    extractionAbort = null;
    isExtracting = false;
    undoSnapshot = null;
    renderFileList();
    renderSlides();
    updateActionState();
    if (slides.length) scheduleDraftSave();
  }
  return completed;
}

async function batchExtractAndDownloadZip(): Promise<void> {
  if (selectedFiles.length === 0 || isBusy()) return;
  if (!currentLimits().batch_processing) {
    setHomeStatus('当前套餐不支持批量处理；专业版或终身版可批量生成并打包 ZIP。');
    return;
  }
  const files = selectedFiles.slice();
  const successfulFiles: string[] = [];
  const failedFiles: string[] = [];
  isBatchProcessing = true;
  homeView.hidden = false;
  workspaceView.hidden = true;
  updateActionState();
  renderFileList();

  try {
    if (!await ensureUsageCapacity('video_conversion', files.length, '视频转换次数', setHomeStatus)) return;
    const settings = readSettings();
    const zip = new JSZip();
    persistWorkspaceToState();
    for (const [index, file] of files.entries()) {
      currentFileIndex = selectedFiles.indexOf(file);
      selectedFile = file;
      setStateStatus(file, 'processing');
      renderFileList();
      setHomeStatus(`批量生成 ${index + 1}/${files.length}：${file.name}`);

      try {
        let durationMessage = '';
        if (!await ensureVideoDurationAllowed(file, (message) => { durationMessage = message; setHomeStatus(message); })) {
          throw new Error(durationMessage || '无法读取这个视频的时长。');
        }
        const result = await extractSlidesFromFile(file, settings, {
          onMetadata: (meta) => {
            videoMeta = meta;
            setupTimeline(meta.duration);
          },
          onProgress: ({ completed, total, time, duration, kept }) => {
            const filePercent = Math.round((completed / Math.max(total, 1)) * 100);
            setHomeStatus(`批量生成 ${index + 1}/${files.length}：${file.name} · ${filePercent}% · ${formatTime(time)} / ${formatTime(duration)} · 已生成 ${kept} 页`);
          }
        });

        setStateForFile(file, {
          slides: result.slides,
          transcript: getState(file).transcript,
          summary: getState(file).summary,
          illustratedNotes: getState(file).illustratedNotes,
          videoMeta: result.meta,
          status: 'done',
          processedAt: new Date().toISOString()
        });
        addSlidesToZip(zip, file, result.slides);
        successfulFiles.push(file.name);
      } catch (error) {
        const message = error instanceof Error ? error.message : '这个视频未能完成生成。';
        failedFiles.push(file.name);
        setStateStatus(file, 'error', message);
        setHomeStatus(`${file.name} 未完成：${message}。继续处理其余视频。`);
      }
      renderFileList();
      await yieldToBrowser();
    }

    if (successfulFiles.length === 0) {
      setHomeStatus(`本次 ${files.length} 个视频均未完成。展开队列可查看原因，修正后可单独重试。`);
      return;
    }
    setHomeStatus('正在打包页面图片...');
    const blob = await zip.generateAsync({ type: 'blob' }, (metadata) => {
      setHomeStatus(`正在打包页面图片：${Math.round(metadata.percent)}%`);
    });
    downloadBlob(blob, `vid2deck-frames-${timestampForFilename()}.zip`);
    setHomeStatus(`批量完成：${successfulFiles.length} 个视频的页面图片已打包下载。${failedFiles.length > 0 ? `另有 ${failedFiles.length} 个未完成，请在队列中查看原因并重试。` : ''}`);
  } catch (error) {
    console.error(error);
    setHomeStatus(error instanceof Error ? error.message : '批量生成失败。');
  } finally {
    try {
      if (successfulFiles.length > 0) {
        await recordUsage('video_conversion', successfulFiles.length, {
          batch: true,
          files: successfulFiles.slice(0, 30)
        });
      }
    } finally {
      isBatchProcessing = false;
      if (selectedFile) loadStateIntoWorkspace(selectedFile);
      renderFileList();
      updateActionState();
    scheduleDraftSave();
    }
  }
}

async function downloadProcessedFramesZip(): Promise<void> {
  if (isBusy()) return;
  const processed = selectedFiles.filter((file) => getState(file).slides.length > 0);
  if (processed.length === 0) {
    setHomeStatus('还没有已完成的页面图片可以打包。');
    return;
  }
  isBatchProcessing = true;
  updateActionState();
  try {
    const zip = new JSZip();
    processed.forEach((file) => addSlidesToZip(zip, file, getState(file).slides));
    const blob = await zip.generateAsync({ type: 'blob' }, (metadata) => {
      setHomeStatus(`正在打包已完成页面：${Math.round(metadata.percent)}%`);
    });
    downloadBlob(blob, `vid2deck-processed-frames-${timestampForFilename()}.zip`);
    setHomeStatus(`已下载 ${processed.length} 个视频的页面图片压缩包。`);
  } catch (error) {
    console.error(error);
    setHomeStatus(error instanceof Error ? error.message : '页面图片打包失败，请重试。');
  } finally {
    isBatchProcessing = false;
    updateActionState();
  }
}

async function transcribeCurrentFile(): Promise<boolean> {
  if (!selectedFile || isBusy()) return false;
  const file = selectedFile;
  const previousTranscript = transcriptEl.value;
  let completed = false;
  isTranscribing = true;
  updateActionState();
  let transcribeMinutes = 1;
  try {
    const meta = videoMeta ?? await readFileVideoMetadata(file);
    transcribeMinutes = Math.max(1, Math.ceil(meta.duration / 60));
    if (!await ensureUsageCapacity('transcribe_minute', transcribeMinutes, '视频转录时长', setStatus)) return false;
    transcriptEl.value = '';
    setProgress('准备转写音频', 0);
    setStatus(`正在转写：${file.name}，结果会分段输出。`);
    const transcriptText = await transcribeLocally(file, setStatus);
    if (!transcriptText.trim() && previousTranscript.trim()) transcriptEl.value = previousTranscript;
    setProgress('转写完成', 100);
    setStatus(transcriptText ? '转写完成。' : previousTranscript.trim() ? '未识别到有效语音，已保留之前的逐字稿。' : '未识别到有效语音，你也可以手动粘贴逐字稿。');
    persistWorkspaceToState({ markProcessed: slides.length > 0 });
    await recordUsage('transcribe_minute', transcribeMinutes, {
      name: file.name,
      minutes: transcribeMinutes
    });
    completed = Boolean(transcriptText.trim());
  } catch (error) {
    console.error(error);
    if (previousTranscript.trim()) transcriptEl.value = previousTranscript;
    persistWorkspaceToState();
    setProgress('转写失败', 100);
    const message = error instanceof Error ? error.message : '逐字稿没有生成成功，请重试或换一个包含清晰语音的视频。';
    setStatus(`${message}${previousTranscript.trim() ? ' 已保留之前的逐字稿。' : transcriptEl.value.trim() ? ' 已保留完成的部分，可以复制或下载。' : ''}`);
  } finally {
    isTranscribing = false;
    updateActionState();
    scheduleDraftSave();
  }
  return completed;
}

transcribeBtn.addEventListener('click', () => transcribeCurrentFile());

summarizeBtn.addEventListener('click', () => {
  void generateSummary();
});

async function generateSummary(): Promise<void> {
  const transcriptForSummary = transcriptEl.value.trim();
  if (!transcriptForSummary || isBusy()) {
    if (!transcriptForSummary) setStatus('没有逐字稿可总结。');
    return;
  }
  isSummarizing = true;
  updateActionState();
  try {
    if (!await ensureUsageCapacity('summary_generation', 1, '摘要次数', setStatus)) return;
    setProgress('正在生成摘要', 50, true);
    setStatus(`正在用${OUTPUT_LANGUAGE_LABELS[userPreferences.outputLanguage]}生成摘要...`);
    summaryEl.value = await summarizeWithApi(transcriptForSummary, 'summary', selectedFile?.name ?? '');
    setProgress('摘要完成', 100);
    setStatus('摘要已生成。');
    persistWorkspaceToState({ markProcessed: slides.length > 0 });
  } catch (error) {
    console.error(error);
    setProgress('摘要失败', 100);
    setStatus(error instanceof Error ? error.message : '摘要生成失败。');
  } finally {
    isSummarizing = false;
    updateActionState();
    scheduleDraftSave();
  }
}

async function generateIllustratedNotes(forceRegenerate = false): Promise<void> {
  if (!selectedFile || workspaceMode !== 'video') {
    setStatus('请先选择并处理一个视频。');
    return;
  }
  if (!authSession) {
    setStatus('请先登录账号，再生成图文笔记。');
    return;
  }
  if (isBusy()) return;
  if (illustratedNotesMarkdown.trim() && !forceRegenerate) {
    openIllustratedNotes();
    return;
  }

  if (!transcriptEl.value.trim()) {
    setStatus('正在先生成逐字稿，完成后会继续生成图文笔记。');
    const transcribed = await transcribeCurrentFile();
    if (!transcribed) {
      setStatus('没有识别到可用于生成笔记的逐字稿。');
      return;
    }
  }
  isGeneratingNotes = true;
  updateActionState();
  try {
    if (!await ensureUsageCapacity('summary_generation', 1, '图文笔记次数', setStatus)) return;
    setProgress('正在生成图文笔记', 56, true);
    setStatus(`正在用${OUTPUT_LANGUAGE_LABELS[userPreferences.outputLanguage]}生成图文笔记...`);
    illustratedNotesMarkdown = await summarizeWithApi(
      transcriptEl.value.trim(),
      'illustrated_notes',
      selectedFile.name
    );
    persistWorkspaceToState({ markProcessed: slides.length > 0 });
    renderIllustratedNotes();
    setProgress('图文笔记完成', 100);
    setStatus('图文笔记已生成，可预览、打印或下载 HTML。');
    openIllustratedNotes();
  } catch (error) {
    console.error(error);
    setProgress('图文笔记生成失败', 100);
    setStatus(error instanceof Error ? error.message : '图文笔记生成失败。');
  } finally {
    isGeneratingNotes = false;
    updateActionState();
    scheduleDraftSave();
  }
}

downloadPdfBtn.addEventListener('click', () => downloadSelectedPdf());
downloadPptxBtn.addEventListener('click', () => downloadSelectedPptx());
dockDownloadPdfBtn.addEventListener('click', () => downloadSelectedPdf());
dockDownloadPptxBtn.addEventListener('click', () => downloadSelectedPptx());
dockDownloadFramesBtn.addEventListener('click', () => downloadSelectedFramesZip());
sideDownloadPdfBtn.addEventListener('click', () => downloadSelectedPdf());
sideDownloadPptxBtn.addEventListener('click', () => downloadSelectedPptx());
sideDownloadFramesBtn.addEventListener('click', () => downloadSelectedFramesZip());
downloadTranscriptBtn.addEventListener('click', () => {
  if (!selectedFile) return;
  downloadBlob(new Blob([transcriptEl.value], { type: 'text/plain;charset=utf-8' }), `${baseName(selectedFile.name)}-transcript.txt`);
});
downloadSummaryBtn.addEventListener('click', () => {
  if (!selectedFile) return;
  downloadBlob(new Blob([summaryEl.value], { type: 'text/markdown;charset=utf-8' }), `${baseName(selectedFile.name)}-summary.md`);
});

function renderFileList(): void {
  fileList.innerHTML = '';
  fileList.hidden = selectedFiles.length === 0;
  selectedFiles.forEach((file, index) => {
    const state = getState(file);
    const selectedSlides = state.slides.filter((slide) => slide.selected).length;
    const totalSlides = state.slides.length;
    const item = document.createElement('div');
    item.className = `file-list-item${index === currentFileIndex ? ' is-active' : ''}${totalSlides > 0 ? ' is-processed' : ''}${state.status === 'processing' ? ' is-processing' : ''}`;

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'file-pick-btn';
    main.disabled = isBusy();
    main.addEventListener('click', () => chooseFile(index));

    const title = document.createElement('strong');
    title.textContent = file.name;
    const meta = document.createElement('small');
    const statusText = state.status === 'processing'
      ? ' · 处理中'
      : state.status === 'error'
        ? ` · 失败：${state.error ?? '未知错误'}`
        : totalSlides > 0
          ? ` · 已处理 ${selectedSlides}/${totalSlides} 张`
          : ' · 待处理';
    meta.textContent = `${formatBytes(file.size)}${index === currentFileIndex ? ' · 当前' : ''}${statusText}`;
    main.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'file-list-actions';

    if (totalSlides > 0) {
      const view = document.createElement('button');
      view.type = 'button';
      view.className = 'file-result-btn';
      view.textContent = '查看结果';
      view.disabled = isBusy();
      view.addEventListener('click', (event) => {
        event.stopPropagation();
        openProcessedFile(index);
      });

      const download = document.createElement('button');
      download.type = 'button';
      download.className = 'file-result-btn primary';
      download.textContent = '下载 PDF';
      download.disabled = isBusy();
      download.addEventListener('click', async (event) => {
        event.stopPropagation();
        await downloadProcessedPdf(index);
      });

      const frames = document.createElement('button');
      frames.type = 'button';
      frames.className = 'file-result-btn';
      frames.textContent = '下载页面图片';
      frames.disabled = isBusy();
      frames.addEventListener('click', async (event) => {
        event.stopPropagation();
        await downloadSingleFramesZip(index);
      });

      const pptx = document.createElement('button');
      pptx.type = 'button';
      pptx.className = 'file-result-btn';
      pptx.textContent = '下载 PPTX';
      pptx.disabled = isBusy();
      pptx.addEventListener('click', async (event) => {
        event.stopPropagation();
        await downloadProcessedPptx(index);
      });

      actions.append(view, download, pptx, frames);
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'file-remove-btn';
    remove.textContent = '移除';
    remove.disabled = isBusy();
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      removeFile(index);
    });

    actions.append(remove);
    item.append(main, actions);
    fileList.appendChild(item);
  });
}

function renderImageFileList(): void {
  imageFileList.innerHTML = '';
  imageFileList.hidden = selectedImageFiles.length === 0;
  imageFileLabel.textContent = selectedImageFiles.length > 0 ? `已选择 ${selectedImageFiles.length} 张图片` : '选择或拖入一组图片';

  selectedImageFiles.forEach((file, index) => {
    const item = document.createElement('div');
    item.className = 'file-list-item image-list-item';

    const main = document.createElement('div');
    main.className = 'file-pick-btn image-pick-label';

    const title = document.createElement('strong');
    title.textContent = file.name;
    const meta = document.createElement('small');
    meta.textContent = `${formatBytes(file.size)} · 第 ${index + 1} 页`;
    main.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'file-list-actions';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'file-remove-btn';
    remove.textContent = '移除';
    remove.disabled = isBusy();
    remove.addEventListener('click', () => removeImageFile(index));
    actions.append(remove);

    item.append(main, actions);
    imageFileList.appendChild(item);
  });
}

function openProcessedFile(index: number): void {
  setWorkspaceMode('video');
  chooseFile(index);
  showWorkspace();
  setStatus('已回到当前处理结果，可继续勾选、裁剪、删除或补抓页面。');
}

async function downloadProcessedPdf(index: number): Promise<void> { await exportProcessedFile(index, 'pdf'); }
async function downloadProcessedPptx(index: number): Promise<void> { await exportProcessedFile(index, 'pptx'); }
async function downloadSingleFramesZip(index: number): Promise<void> { await exportProcessedFile(index, 'zip'); }

async function exportProcessedFile(index: number, format: 'pdf' | 'pptx' | 'zip'): Promise<void> {
  if (isBusy() || !selectedFiles[index]) return;
  chooseFile(index);
  setHomeStatus(`正在生成 ${selectedFiles[index].name} 的导出文件…`);
  await exportSelected(format);
  setHomeStatus(statusEl.textContent ?? '导出完成，请查看浏览器下载列表。');
  renderFileList();
}

async function downloadImagesAsPptx(): Promise<void> {
  if (selectedImageFiles.length === 0 || isBusy()) return;
  if (isDemoProject) restoreWorkspaceAfterDemo();
  const files = selectedImageFiles.slice();
  isBatchProcessing = true;
  updateActionState();
  renderImageFileList();
  try {
    setImageStatus(`正在读取 ${files.length} 张本地图片...`);
    await yieldToBrowser();
    const imageSlides = await buildSlidesFromImages(files, (index, total) => {
      setImageStatus(`正在生成图片页：${index} / ${total}`);
    });
    setImageStatus('正在生成图片版 PPTX...');
    const pptxBlob = await makePptx(imageSlides);
    downloadBlob(pptxBlob, `vid2ppt-deck-images-${timestampForFilename()}.pptx`);
    setImageStatus(`已生成 ${imageSlides.length} 页图片版 PPTX；如需文本框，请进入编辑模式。`);
  } catch (error) {
    console.error(error);
    setImageStatus(error instanceof Error ? error.message : '图片生成 PPTX 失败。');
  } finally {
    isBatchProcessing = false;
    renderImageFileList();
    updateActionState();
  }
}

async function openImagesInWorkspace(): Promise<void> {
  if (selectedImageFiles.length === 0 || isBusy()) return;
  if (isDemoProject) restoreWorkspaceAfterDemo();
  const files = selectedImageFiles.slice();
  let workspaceOpened = false;
  isBatchProcessing = true;
  updateActionState();
  renderImageFileList();
  try {
    if (!await ensureUsageCapacity('editable_slide', files.length, '文字识别页面', setImageStatus)) return;
    persistWorkspaceToState();
    setWorkspaceMode('image');
    selectedFile = new File([], `image-deck-${timestampForFilename()}.images`, { type: 'application/x-vid2deck-image-deck' });
    currentFileIndex = -1;
    resetCurrentFileState();
    workspaceOpened = true;
    showWorkspace();
    setProgress('正在读取本地图片', 5, true);
    setStatus(`正在读取 ${files.length} 张本地图片，文件不会上传。`);
    await yieldToBrowser();

    setProgress('页面加载中', 10, true);
    setStatus('正在生成图片页面，结果会陆续出现。');
    slides = [];
    slidesEl.innerHTML = '';
    const imageSlides = await buildSlidesFromImages(files, (index, total) => {
      setProgress(`页面加载中：${index} / ${total}`, 10 + Math.round((index / Math.max(total, 1)) * 38), true);
    }, (slide) => {
      slides.push(slide);
      appendSlideCard(slide);
      if (slides.length === 1) setPreview(slide);
      updateSelectionUI();
    });
    slides = imageSlides;
    videoMeta = null;
    if (slides[0]) setPreview(slides[0]);
    setProgress('图片页已准备，正在识别文字', 50, true);
    setStatus('正在识别图片文字，并生成可编辑文本框。');
    const textBoxCount = await recognizeSlidesToTextBoxes(slides, {
      replaceExisting: true,
      onProgress: (index, total, message) => {
        const base = 50;
        const span = 49;
        setProgress(`识别文字：${index} / ${total} · ${message}`, base + Math.round((index / Math.max(total, 1)) * span), true);
      }
    });
    renderSlides();
    if (slides[0]) setPreview(slides[0]);
    setProgress('文字识别完成', 100);
    setStatus(`已生成 ${slides.length} 张图片页，并自动识别出 ${textBoxCount} 个可编辑文本框。顶部导出 PPTX 后可直接编辑文字。`);
    persistWorkspaceToState({ markProcessed: true });
    await recordUsage('editable_slide', slides.length, {
      source: 'image_workspace',
      images: files.length,
      text_boxes: textBoxCount
    });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : '图片进入编辑模式失败。';
    if (workspaceOpened && slides.length > 0) {
      persistWorkspaceToState({ markProcessed: true });
      renderSlides();
      if (slides[0]) setPreview(slides[0]);
      setProgress('已保留加载的图片页', 100);
      setStatus(`${message} 已保留 ${slides.length} 页，可以先导出图片版 PPTX，或稍后重试文字识别。`);
    } else {
      setImageStatus(message);
      setStatus(message);
    }
  } finally {
    isBatchProcessing = false;
    renderImageFileList();
    updateActionState();
    scheduleDraftSave();
  }
}

function selectNotebookPdfFile(file: File | null): void {
  if (isBusy()) {
    setNotebookPdfStatus('当前有任务正在运行，完成后再选择 PDF。');
    notebookPdfInput.value = '';
    return;
  }
  if (!file || !isSupportedPdfFile(file)) {
    selectedNotebookPdfFile = null;
    notebookPdfFileLabel.textContent = '选择或拖入 NotebookLM 生成的 PDF';
    notebookPdfInfo.hidden = true;
    notebookPdfInfo.textContent = '';
    setNotebookPdfStatus('请选择 PDF 文件。');
    updateActionState();
    notebookPdfInput.value = '';
    return;
  }
  selectedNotebookPdfFile = file;
  notebookPdfFileLabel.textContent = file.name;
  notebookPdfInfo.hidden = false;
  notebookPdfInfo.textContent = `${file.name} · ${formatBytes(file.size)}`;
  setNotebookPdfStatus('PDF 已选择，可以开始抹除右下角 Logo。');
  updateActionState();
  notebookPdfInput.value = '';
}

async function maskSelectedNotebookPdf(): Promise<void> {
  const file = selectedNotebookPdfFile;
  if (!file || isBusy()) return;
  isPdfMasking = true;
  updateActionState();
  try {
    setNotebookPdfStatus('正在加载 PDF 引擎...');
    const result = await maskNotebookPdf(file, (page, total, detectedCount) => {
      setNotebookPdfStatus(`正在处理 PDF：${page} / ${total} 页，已识别 ${detectedCount} 页 Logo。`);
    });
    downloadBlob(result.blob, `${baseName(file.name)}-no-notebooklm.pdf`);
    setNotebookPdfStatus(`已生成处理版 PDF：共 ${result.pageCount} 页，识别到 ${result.detectedPageCount} 页 Logo。`);
  } catch (error) {
    console.error(error);
    setNotebookPdfStatus(error instanceof Error ? error.message : 'PDF 处理失败。');
  } finally {
    isPdfMasking = false;
    updateActionState();
  }
}

async function maskNotebookPdf(
  file: File,
  onProgress: (page: number, total: number, detectedCount: number) => void
): Promise<{ blob: Blob; pageCount: number; detectedPageCount: number }> {
  const { jsPDF } = await import('jspdf');
  const pdfjs = await loadPdfJs();
  const documentData = await file.arrayBuffer();
  const pdfDocument = await pdfjs.getDocument({ data: documentData }).promise;
  let outputPdf: JsPdfDocument | null = null;
  let detectedPageCount = 0;

  try {
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.max(1, Math.min(PDF_RENDER_SCALE, PDF_RENDER_MAX_EDGE / Math.max(baseViewport.width, baseViewport.height)));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('浏览器不支持 PDF 渲染所需的 Canvas。');

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;

      const maskBox = detectNotebookMaskBox(ctx, canvas.width, canvas.height);
      if (maskBox.detected) detectedPageCount += 1;
      coverNotebookMaskBox(ctx, canvas.width, canvas.height, maskBox);

      const pageWidth = baseViewport.width;
      const pageHeight = baseViewport.height;
      const orientation = pageWidth >= pageHeight ? 'landscape' : 'portrait';
      if (!outputPdf) {
        outputPdf = new jsPDF({ orientation, unit: 'pt', format: [pageWidth, pageHeight] });
      } else {
        outputPdf.addPage([pageWidth, pageHeight], orientation);
      }
      outputPdf.addImage(canvas.toDataURL('image/jpeg', 0.94), 'JPEG', 0, 0, pageWidth, pageHeight);
      onProgress(pageNumber, pdfDocument.numPages, detectedPageCount);
      await yieldToBrowser();
    }
  } finally {
    pdfDocument.cleanup?.();
    await Promise.resolve(pdfDocument.destroy?.()).catch(() => undefined);
  }

  if (!outputPdf) throw new Error('PDF 没有可处理的页面。');
  return {
    blob: outputPdf.output('blob'),
    pageCount: pdfDocument.numPages,
    detectedPageCount
  };
}

function loadPdfJs(): Promise<PdfJsApi> {
  const existing = (window as Window & { pdfjsLib?: PdfJsApi }).pdfjsLib;
  if (existing) {
    existing.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
    return Promise.resolve(existing);
  }
  if (pdfJsLoadPromise) return pdfJsLoadPromise;
  pdfJsLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = PDFJS_SCRIPT_URL;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = () => {
      const api = (window as Window & { pdfjsLib?: PdfJsApi }).pdfjsLib;
      if (api) {
        api.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        resolve(api);
      } else {
        pdfJsLoadPromise = null;
        reject(new Error('PDF 脚本已加载，但没有找到 PDF.js API。'));
      }
    };
    script.onerror = () => {
      pdfJsLoadPromise = null;
      reject(new Error('无法加载 PDF 引擎。请检查网络或稍后重试。'));
    };
    document.head.appendChild(script);
  });
  return pdfJsLoadPromise;
}

function detectNotebookMaskBox(ctx: CanvasRenderingContext2D, width: number, height: number): NotebookMaskBox {
  const searchX = Math.floor(width * 0.68);
  const searchY = Math.floor(height * 0.72);
  const searchWidth = width - searchX;
  const searchHeight = height - searchY;
  if (searchWidth <= 20 || searchHeight <= 20) return fallbackNotebookMaskBox(width, height);

  const imageData = ctx.getImageData(searchX, searchY, searchWidth, searchHeight).data;
  const rowCounts = new Array<number>(searchHeight).fill(0);
  for (let y = Math.floor(searchHeight * 0.35); y < searchHeight; y += 1) {
    for (let x = 0; x < searchWidth; x += 1) {
      if (isNotebookCandidatePixel(imageData, searchWidth, searchHeight, x, y)) rowCounts[y] += 1;
    }
  }

  const rowThreshold = Math.max(8, Math.floor(searchWidth * 0.008));
  const rowBands = findSignalBands(rowCounts, rowThreshold, 3)
    .filter((band) => band.end > searchHeight * 0.48 && band.total > 70 && band.end - band.start >= 4);
  const rowBand = rowBands[rowBands.length - 1];
  if (!rowBand) return fallbackNotebookMaskBox(width, height);

  const colCounts = new Array<number>(searchWidth).fill(0);
  for (let y = rowBand.start; y <= rowBand.end; y += 1) {
    for (let x = 0; x < searchWidth; x += 1) {
      if (isNotebookCandidatePixel(imageData, searchWidth, searchHeight, x, y)) colCounts[x] += 1;
    }
  }

  const bandHeight = rowBand.end - rowBand.start + 1;
  const colThreshold = Math.max(2, Math.floor(bandHeight * 0.08));
  const minWidth = Math.max(36, Math.floor(width * 0.035));
  const colBands = findSignalBands(colCounts, colThreshold, 14)
    .filter((band) => band.end > searchWidth * 0.45 && band.end - band.start >= minWidth && band.total > 45);
  const colBand = colBands[colBands.length - 1];
  if (!colBand) return fallbackNotebookMaskBox(width, height);

  return normalizeNotebookMaskBox({
    x: searchX + colBand.start,
    y: searchY + rowBand.start,
    width: colBand.end - colBand.start + 1,
    height: rowBand.end - rowBand.start + 1,
    detected: true
  }, width, height);
}

function isNotebookCandidatePixel(data: Uint8ClampedArray, width: number, height: number, x: number, y: number): boolean {
  const index = (y * width + x) * 4;
  const alpha = data[index + 3];
  if (alpha < 24) return false;
  const r = data[index];
  const g = data[index + 1];
  const b = data[index + 2];
  const luminance = pixelLuminance(r, g, b);
  const colorSpread = Math.max(r, g, b) - Math.min(r, g, b);
  if (colorSpread > 88 && luminance > 95 && luminance < 225) return false;

  const neighborLuminance = averageNeighborLuminance(data, width, height, x, y, 4);
  const contrast = Math.abs(luminance - neighborLuminance);
  return contrast > 28 && (luminance < 150 || luminance > 165);
}

function averageNeighborLuminance(data: Uint8ClampedArray, width: number, height: number, x: number, y: number, distance: number): number {
  const points = [
    [clamp(x - distance, 0, width - 1), y],
    [clamp(x + distance, 0, width - 1), y],
    [x, clamp(y - distance, 0, height - 1)],
    [x, clamp(y + distance, 0, height - 1)]
  ];
  let total = 0;
  for (const [px, py] of points) {
    const index = (py * width + px) * 4;
    total += pixelLuminance(data[index], data[index + 1], data[index + 2]);
  }
  return total / points.length;
}

function findSignalBands(counts: number[], threshold: number, mergeGap: number): Array<{ start: number; end: number; total: number }> {
  const bands: Array<{ start: number; end: number; total: number }> = [];
  let start = -1;
  let end = -1;
  let total = 0;
  let gap = 0;

  counts.forEach((count, index) => {
    if (count >= threshold) {
      if (start < 0) start = index;
      end = index;
      total += count;
      gap = 0;
      return;
    }
    if (start >= 0) {
      gap += 1;
      if (gap > mergeGap) {
        bands.push({ start, end, total });
        start = -1;
        end = -1;
        total = 0;
        gap = 0;
      }
    }
  });

  if (start >= 0) bands.push({ start, end, total });
  return bands;
}

function fallbackNotebookMaskBox(width: number, height: number): NotebookMaskBox {
  const margin = Math.round(Math.min(width, height) * NOTEBOOK_MASK_MARGIN);
  const boxWidth = Math.round(width * NOTEBOOK_MASK_FALLBACK_WIDTH);
  const boxHeight = Math.round(height * NOTEBOOK_MASK_FALLBACK_HEIGHT);
  return {
    x: width - boxWidth - margin,
    y: height - boxHeight - margin,
    width: boxWidth,
    height: boxHeight,
    detected: false
  };
}

function normalizeNotebookMaskBox(box: NotebookMaskBox, canvasWidth: number, canvasHeight: number): NotebookMaskBox {
  const padding = Math.round(Math.min(canvasWidth, canvasHeight) * 0.014);
  let x = box.x - padding;
  let y = box.y - padding;
  let width = box.width + padding * 2;
  let height = box.height + padding * 2;

  const minWidth = Math.round(canvasWidth * 0.08);
  const minHeight = Math.round(canvasHeight * 0.035);
  const maxWidth = Math.round(canvasWidth * 0.09);
  const maxHeight = Math.round(canvasHeight * 0.05);
  if (width < minWidth) {
    const right = Math.min(canvasWidth - padding, x + width);
    x = right - minWidth;
    width = minWidth;
  }
  if (height < minHeight) {
    const center = y + height / 2;
    y = center - minHeight / 2;
    height = minHeight;
  }
  if (width > maxWidth) {
    const right = Math.min(canvasWidth, x + width);
    x = right - maxWidth;
    width = maxWidth;
  }
  if (height > maxHeight) {
    const bottom = Math.min(canvasHeight, y + height);
    y = bottom - maxHeight;
    height = maxHeight;
  }

  x = clamp(Math.round(x), 0, canvasWidth - 1);
  y = clamp(Math.round(y), 0, canvasHeight - 1);
  width = clamp(Math.round(width), 1, canvasWidth - x);
  height = clamp(Math.round(height), 1, canvasHeight - y);
  return { x, y, width, height, detected: box.detected };
}

function coverNotebookMaskBox(ctx: CanvasRenderingContext2D, canvasWidth: number, canvasHeight: number, box: NotebookMaskBox): void {
  const x = Math.round(box.x);
  const y = Math.round(box.y);
  const width = Math.round(box.width);
  const height = Math.round(box.height);
  if (width <= 0 || height <= 0) return;

  const fill = sampleMaskFillColor(ctx, canvasWidth, canvasHeight, { x, y, width, height, detected: box.detected });
  const cellSize = Math.max(10, Math.min(34, Math.round(Math.min(width, height) * 0.48)));
  const source = document.createElement('canvas');
  source.width = width;
  source.height = height;
  const sourceCtx = source.getContext('2d');
  if (sourceCtx) {
    sourceCtx.drawImage(ctx.canvas, x, y, width, height, 0, 0, width, height);
    const small = document.createElement('canvas');
    small.width = Math.max(1, Math.ceil(width / cellSize));
    small.height = Math.max(1, Math.ceil(height / cellSize));
    const smallCtx = small.getContext('2d');
    if (smallCtx) {
      smallCtx.imageSmoothingEnabled = false;
      smallCtx.drawImage(source, 0, 0, small.width, small.height);
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(small, x, y, width, height);
      ctx.restore();
    }
  }

  ctx.save();
  ctx.fillStyle = `rgba(${fill.r}, ${fill.g}, ${fill.b}, 0.9)`;
  ctx.fillRect(x, y, width, height);
  for (let yy = y; yy < y + height; yy += cellSize) {
    for (let xx = x; xx < x + width; xx += cellSize) {
      const shade = ((Math.floor(xx / cellSize) + Math.floor(yy / cellSize)) % 2 === 0) ? 8 : -8;
      ctx.fillStyle = `rgba(${clamp(fill.r + shade, 0, 255)}, ${clamp(fill.g + shade, 0, 255)}, ${clamp(fill.b + shade, 0, 255)}, 0.24)`;
      ctx.fillRect(xx, yy, Math.min(cellSize, x + width - xx), Math.min(cellSize, y + height - yy));
    }
  }
  ctx.restore();
}

function sampleMaskFillColor(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  box: NotebookMaskBox
): Rgb {
  const margin = Math.max(6, Math.round(Math.min(canvasWidth, canvasHeight) * 0.012));
  const sx = clamp(box.x - margin, 0, canvasWidth - 1);
  const sy = clamp(box.y - margin, 0, canvasHeight - 1);
  const ex = clamp(box.x + box.width + margin, sx + 1, canvasWidth);
  const ey = clamp(box.y + box.height + margin, sy + 1, canvasHeight);
  const data = ctx.getImageData(sx, sy, ex - sx, ey - sy).data;
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  for (let y = 0; y < ey - sy; y += 3) {
    for (let x = 0; x < ex - sx; x += 3) {
      const globalX = sx + x;
      const globalY = sy + y;
      const inside = globalX >= box.x && globalX <= box.x + box.width && globalY >= box.y && globalY <= box.y + box.height;
      if (inside) continue;
      const index = (y * (ex - sx) + x) * 4;
      const alpha = data[index + 3] / 255;
      if (alpha < 0.1) continue;
      r += data[index] * alpha;
      g += data[index + 1] * alpha;
      b += data[index + 2] * alpha;
      count += alpha;
    }
  }

  if (count <= 0) return { r: 248, g: 250, b: 252 };
  return {
    r: Math.round(r / count),
    g: Math.round(g / count),
    b: Math.round(b / count)
  };
}

function pixelLuminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function updateHomeFileStatus(): void {
  fileLabel.textContent = selectedFiles.length > 0 ? `已选择 ${selectedFiles.length} 个文件` : '选择或拖入一个或多个视频文件';
  setHomeStatus(selectedFile ? `当前视频：${selectedFile.name}` : '等待上传视频。');
}

async function startWorkspaceUrlDownload(mode: UrlDownloadMode): Promise<void> {
  const value = workspaceVideoUrlInput.value.trim();
  const parsedUrl = parseDownloadUrl(value);
  if (!parsedUrl) {
    setWorkspaceUrlStatus('请输入有效的视频链接。', 'error');
    workspaceVideoUrlInput.focus();
    return;
  }
  if (isBilibiliDownloadUrl(parsedUrl) && !workspaceRightsConfirm.checked) {
    setWorkspaceUrlStatus('B 站视频请先勾选“我确认有权处理这个视频”。', 'warn');
    workspaceRightsConfirm.focus();
    return;
  }
  videoUrlInput.value = parsedUrl.toString();
  mediaRightsConfirm.checked = workspaceRightsConfirm.checked;
  setWorkspaceUrlStatus(mode === 'extract' ? '正在获取视频并准备生成页面。' : '正在下载到队列。', 'warn');
  await downloadVideoFromUrl(mode);
  if (!videoUrlInput.value.trim()) {
    workspaceVideoUrlInput.value = '';
    workspaceRightsConfirm.checked = false;
  }
}

function addWorkspaceFiles(files: File[]): void {
  addFiles(files, true);
  workspaceVideoInput.value = '';
  setWorkspaceMode('video');
  showWorkspace();
  if (selectedFile && slides.length === 0) {
    setWorkspaceUrlStatus(`已加入：${selectedFile.name}。点击“开始当前任务”即可生成页面。`, 'ok');
    setStatus(`已选择 ${selectedFile.name}，点击上方“开始当前任务”。`);
    emptyWorkspaceStartBtn.focus();
  }
}

function openWorkspaceFromNav(): void {
  setWorkspaceMode(workspaceMode);
  showWorkspace();
  if (!selectedFile && slides.length === 0) {
    setStatus('选择本地视频或粘贴链接开始，也可以回首页体验示例。');
  }
  updateActionState();
}

function showOrdersPlaceholder(): void {
  window.open('/pricing/', '_blank', 'noopener');
}

function focusLoginPanel(): void {
  if (!isBusy()) persistWorkspaceToState();
  if (isDemoProject) restoreWorkspaceAfterDemo();
  void loadAuthCaptcha();
  workspaceView.hidden = true;
  homeView.hidden = false;
  requestAnimationFrame(() => {
    document.querySelector('.account-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!authSession) authUsername.focus({ preventScroll: true });
  });
}

function returnHomeForVideoStart(): void {
  if (!isBusy()) persistWorkspaceToState();
  workspaceView.hidden = true;
  homeView.hidden = false;
  hideProgress();
  const closedDemo = isDemoProject;
  if (closedDemo) restoreWorkspaceAfterDemo();
  requestAnimationFrame(() => {
    document.querySelector('.video-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    dropzone.focus({ preventScroll: true });
  });
  setHomeStatus(closedDemo
    ? '交互示例已关闭。现在可以粘贴链接、上传文件或录制屏幕。'
    : '在这里粘贴视频链接、上传文件或录制屏幕，处理后会自动进入工作台。');
}

function showWorkspace(): void {
  if (slides.length) $<HTMLElement>('#workspaceImport').hidden = true;
  homeView.hidden = true;
  workspaceView.hidden = false;
  captureTimeline.hidden = workspaceMode !== 'video' || !selectedFile || isDemoProject || isAudioSource(selectedFile);
  updateWorkspaceEmptyState();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function setWorkspaceMode(mode: WorkspaceMode): void {
  workspaceMode = mode;
  workspaceView.classList.toggle('image-mode', mode === 'image');
  workspaceSubtitle.textContent = mode === 'image'
    ? '图片页会在这里勾选、编辑文本框并导出 PPTX。'
    : '视频生成页面后，在这里勾选、预览、补抓和导出。';
  captureTimeline.hidden = mode !== 'video' || !selectedFile || isDemoProject || isAudioSource(selectedFile);
  updateWorkspaceEmptyState();
}

function openDemoProject(): void {
  if (isBusy()) {
    setHomeStatus('请等待当前任务完成后再打开交互示例。');
    return;
  }
  if (isDemoProject) return;
  persistWorkspaceToState();
  demoSnapshot = { file: selectedFile, mode: workspaceMode, state: snapshotWorkspace(), index: currentFileIndex };
  demoRestoreFileIndex = currentFileIndex;
  undoSnapshot = null;
  isDemoProject = true;
  currentFileIndex = -1;
  selectedFile = new File([], 'Vid2PPT-交互示例.mp4', { type: 'video/mp4', lastModified: 0 });
  slides = createDemoSlides();
  videoMeta = null;
  activeSlideId = slides[0]?.id ?? null;
  activeTextBoxId = null;
  timelineTime = 0;
  extractionTimelineMax = 0;
  transcriptEl.value = '[00:00 - 00:28] 从视频中识别真正出现过的页面。\n[00:28 - 00:55] 合并重复画面，并保留原始图表与顺序。\n[00:55 - 01:18] 导出前可以勾选、排序、裁剪或删除。';
  summaryEl.value = '这是一个内置交互示例，用来体验页面检查与导出流程，不代表任何特定视频的转换结果。';
  illustratedNotesMarkdown = '';
  setWorkspaceMode('video');
  persistWorkspaceToState({ markProcessed: true });
  renderSlides();
  if (slides[0]) setPreview(slides[0]);
  hideProgress();
  showWorkspace();
  $<HTMLElement>('#workspaceImport').hidden = true;
  workspaceSubtitle.textContent = '交互示例：试试勾选、拖动排序、裁剪和导出；不会计入额度。';
  setStatus('这是内置交互示例，不代表特定视频的实际提取页数。你可以直接调整页面顺序或下载结果。');
  updateActionState();
}

function restoreWorkspaceAfterDemo(): void {
  if (!isDemoProject) return;
  isDemoProject = false;
  const previous = demoSnapshot;
  demoSnapshot = null;
  currentFileIndex = previous?.index ?? demoRestoreFileIndex;
  demoRestoreFileIndex = -1;
  selectedFile = previous?.file ?? null;
  if (selectedFile && previous) {
    setStateForFile(selectedFile, previous.state);
    loadStateIntoWorkspace(selectedFile);
  } else resetCurrentFileState();
  setWorkspaceMode(previous?.mode ?? 'video');
}

function createDemoSlides(): Slide[] {
  const specs = [
    { title: '从视频到页面', subtitle: '保留原画面，不重新编写内容', accent: '#5d78e8', variant: 0 },
    { title: '自动去掉重复画面', subtitle: '同一页连续出现，只保留清晰的一张', accent: '#f47a45', variant: 1 },
    { title: '导出前由你决定', subtitle: '勾选 · 排序 · 裁剪 · 补抓', accent: '#178a61', variant: 2 }
  ];
  return specs.map((spec, index) => ({
    id: 9001 + index,
    time: [0, 28, 55][index] ?? index * 25,
    hash: BigInt(index + 1),
    dataUrl: createDemoSlideImage(spec.title, spec.subtitle, spec.accent, spec.variant),
    width: 1600,
    height: 900,
    selected: true,
    textBoxes: []
  }));
}

function createDemoSlideImage(title: string, subtitle: string, accent: string, variant: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = 1600;
  canvas.height = 900;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = variant === 0 ? '#101828' : '#f4f5f1';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = accent;
  ctx.fillRect(100, 92, 86, 12);
  ctx.fillStyle = variant === 0 ? '#ffffff' : '#101828';
  ctx.font = '800 76px Inter, system-ui, sans-serif';
  ctx.fillText(title, 100, 215);
  ctx.fillStyle = variant === 0 ? '#cbd5e1' : '#5d6879';
  ctx.font = '34px Inter, system-ui, sans-serif';
  ctx.fillText(subtitle, 100, 280);

  if (variant === 0) {
    ['视频画面', '页面去重', '检查导出'].forEach((label, index) => {
      const x = 100 + index * 470;
      ctx.fillStyle = index === 1 ? accent : '#1d2a45';
      roundedRect(ctx, x, 390, 410, 260, 28);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 34px Inter, system-ui, sans-serif';
      ctx.fillText(label, x + 38, 470);
      ctx.fillStyle = index === 1 ? '#dce3ff' : '#8f9bb0';
      ctx.fillRect(x + 38, 520, 260, 16);
      ctx.fillRect(x + 38, 560, 190, 16);
    });
  } else if (variant === 1) {
    [0.58, 0.58, 0.91, 0.91, 0.68].forEach((height, index) => {
      const x = 130 + index * 250;
      ctx.fillStyle = index === 2 ? accent : '#d9dee7';
      roundedRect(ctx, x, 700 - height * 360, 150, height * 360, 18);
      ctx.fill();
      ctx.fillStyle = '#101828';
      ctx.font = '700 25px Inter, system-ui, sans-serif';
      ctx.fillText(index === 2 ? '保留' : index === 3 ? '重复' : `帧 ${index + 1}`, x + 32, 755);
    });
  } else {
    ['勾选需要的页面', '拖动调整顺序', '下载 PPTX / PDF'].forEach((label, index) => {
      const y = 370 + index * 140;
      ctx.fillStyle = '#ffffff';
      roundedRect(ctx, 100, y, 1120, 94, 20);
      ctx.fill();
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(155, y + 47, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#101828';
      ctx.font = '700 32px Inter, system-ui, sans-serif';
      ctx.fillText(label, 210, y + 58);
    });
  }
  ctx.fillStyle = variant === 0 ? '#718096' : '#7a8494';
  ctx.font = '700 24px Inter, system-ui, sans-serif';
  ctx.fillText(`Vid2PPT 交互示例 · ${variant + 1}/3`, 100, 830);
  return canvas.toDataURL('image/jpeg', 0.92);
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + safeRadius, y);
  ctx.lineTo(x + width - safeRadius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  ctx.lineTo(x + width, y + height - safeRadius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  ctx.lineTo(x + safeRadius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  ctx.lineTo(x, y + safeRadius);
  ctx.quadraticCurveTo(x, y, x + safeRadius, y);
  ctx.closePath();
}

function getState(file: File): FileJobState {
  return ensureState(file);
}

function ensureState(file: File): FileJobState {
  const key = fileKey(file);
  const existing = fileStates.get(key);
  if (existing) return existing;
  const created: FileJobState = { slides: [], transcript: '', summary: '', illustratedNotes: '', videoMeta: null, status: 'queued' };
  fileStates.set(key, created);
  return created;
}

function setStateStatus(file: File, status: JobStatus, error?: string): void {
  const state = ensureState(file);
  state.status = status;
  state.error = error;
}

function setStateForFile(file: File, state: FileJobState): void {
  fileStates.set(fileKey(file), {
    slides: cloneSlides(state.slides),
    transcript: state.transcript,
    summary: state.summary,
    illustratedNotes: state.illustratedNotes,
    videoMeta: state.videoMeta ? { ...state.videoMeta } : null,
    status: state.status,
    error: state.error,
    processedAt: state.processedAt
  });
}

function persistWorkspaceToState(options: { markProcessed?: boolean } = {}): void {
  if (!selectedFile || isDemoProject) return;
  const previous = getState(selectedFile);
  setStateForFile(selectedFile, {
    slides,
    transcript: transcriptEl.value,
    summary: summaryEl.value,
    illustratedNotes: illustratedNotesMarkdown,
    videoMeta,
    status: isExtracting ? previous.status : slides.length > 0 ? 'done' : previous.status,
    error: previous.error,
    processedAt: options.markProcessed ? new Date().toISOString() : previous.processedAt
  });
  if (!isBusy()) scheduleDraftSave();
}

function loadStateIntoWorkspace(file: File): void {
  const state = getState(file);
  undoSnapshot = null;
  slides = cloneSlides(state.slides);
  videoMeta = state.videoMeta ? { ...state.videoMeta } : null;
  activeSlideId = slides[0]?.id ?? null;
  activeTextBoxId = null;
  timelineTime = slides[0]?.time ?? 0;
  extractionTimelineMax = timelineTime;
  lastTimelinePaint = 0;
  transcriptEl.value = state.transcript;
  summaryEl.value = state.summary;
  illustratedNotesMarkdown = state.illustratedNotes;
  previewImage.removeAttribute('src');
  previewEmpty.hidden = false;
  hideProgress();
  renderSlides();
  updateTimelinePosition();
  if (slides[0]) setPreview(slides[0]);
}

function cloneSlides(items: Slide[]): Slide[] {
  return items.map((slide) => ({
    ...slide,
    textBoxes: (slide.textBoxes ?? []).map((box) => ({ ...box }))
  }));
}

function resetCurrentFileState(): void {
  slides = [];
  videoMeta = null;
  activeSlideId = null;
  activeTextBoxId = null;
  timelineTime = 0;
  extractionTimelineMax = 0;
  lastTimelinePaint = 0;
  slidesEl.innerHTML = '';
  transcriptEl.value = '';
  summaryEl.value = '';
  illustratedNotesMarkdown = '';
  previewImage.removeAttribute('src');
  previewEmpty.hidden = false;
  timelineMarkers.innerHTML = '';
  updateTimelinePosition();
  hideProgress();
  updateSelectionUI();
}

function resetFrameOutputs(): void {
  slides = [];
  illustratedNotesMarkdown = '';
  activeSlideId = null;
  activeTextBoxId = null;
  slidesEl.innerHTML = '';
  previewImage.removeAttribute('src');
  previewEmpty.hidden = false;
  timelineMarkers.innerHTML = '';
  timelineTime = 0;
  extractionTimelineMax = 0;
  updateTimelinePosition();
  updateSelectionUI();
}

async function extractSlidesFromFile(
  file: File,
  settings: Settings,
  hooks: {
    signal?: AbortSignal;
    onMetadata?: (meta: VideoMeta) => void;
    onKeep?: (slide: Slide) => void;
    onProgress?: (data: { completed: number; total: number; time: number; duration: number; kept: number }) => void;
  } = {}
): Promise<{ slides: Slide[]; meta: VideoMeta }> {
  const url = URL.createObjectURL(file);
  const extractors: FrameExtractor[] = [];
  try {
    hooks.signal?.throwIfAborted();
    const meta = await readVideoMetadata(url);
    hooks.signal?.throwIfAborted();
    hooks.onMetadata?.(meta);
    const times = buildFrameTimes(meta.duration, settings.sampleEvery);
    const workerCount = Math.min(FRAME_CONCURRENCY, times.length || 1);
    for (let i = 0; i < workerCount; i += 1) extractors.push(await createFrameExtractor(url, meta.width, meta.height));

    const kept: Slide[] = [];
    const captured = new Map<number, CapturedFrame>();
    let nextCapture = 0;
    let nextCommit = 0;
    let completed = 0;

    const commitReadyFrames = () => {
      while (captured.has(nextCommit)) {
        const frame = captured.get(nextCommit)!;
        captured.delete(nextCommit);
        nextCommit += 1;
        const duplicate = kept.some((slide) => isDuplicateSlide(slide, frame.hash, frame.time, settings));
        if (!duplicate) {
          const slide: Slide = { id: kept.length + 1, time: frame.time, hash: frame.hash, dataUrl: frame.dataUrl, width: frame.width, height: frame.height, selected: true, textBoxes: [] };
          kept.push(slide);
          hooks.onKeep?.({ ...slide });
        }
        hooks.onProgress?.({ completed, total: times.length, time: frame.time, duration: meta.duration, kept: kept.length });
      }
    };

    const runCapture = async (extractor: FrameExtractor) => {
      while (nextCapture < times.length) {
        hooks.signal?.throwIfAborted();
        const index = nextCapture;
        nextCapture += 1;
        const frame = await extractor.capture(index, times[index]);
        hooks.signal?.throwIfAborted();
        captured.set(index, frame);
        completed += 1;
        commitReadyFrames();
        await yieldToBrowser();
      }
    };

    const outcomes = await Promise.allSettled(extractors.map((extractor) => runCapture(extractor)));
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    hooks.signal?.throwIfAborted();
    commitReadyFrames();
    return { slides: kept, meta };
  } finally {
    extractors.forEach((extractor) => extractor.dispose());
    URL.revokeObjectURL(url);
  }
}

async function readVideoMetadata(url: string): Promise<VideoMeta> {
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.preload = 'metadata';
  video.playsInline = true;
  await waitForEvent(video, 'loadedmetadata', 5000);
  const duration = await resolveVideoDuration(video);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('无法读取视频时长。浏览器录屏 WebM 可能还没写入可读 duration；请重新停止录制后再试，或转成 H.264 mp4/WebM 后上传。');
  }
  return { duration, width: video.videoWidth || 1280, height: video.videoHeight || 720 };
}

async function resolveVideoDuration(video: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (duration: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (Number.isFinite(duration) && duration > 0) {
        try { video.currentTime = 0; } catch { /* ignore */ }
      }
      resolve(duration);
    };
    const onMaybeResolved = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) finish(video.duration);
    };
    const onError = () => finish(video.duration);
    const timer = window.setTimeout(() => finish(video.duration), 4500);
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('durationchange', onMaybeResolved);
      video.removeEventListener('timeupdate', onMaybeResolved);
      video.removeEventListener('seeked', onMaybeResolved);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('durationchange', onMaybeResolved);
    video.addEventListener('timeupdate', onMaybeResolved);
    video.addEventListener('seeked', onMaybeResolved);
    video.addEventListener('error', onError, { once: true });
    try { video.currentTime = 1e101; } catch { finish(video.duration); }
  });
}

function buildFrameTimes(duration: number, sampleEvery: number): number[] {
  const times: number[] = [];
  for (let t = 0; t < duration; t += sampleEvery) times.push(Math.min(t, Math.max(0, duration - 0.05)));
  if (times.length === 0) times.push(0);
  return times;
}

async function createFrameExtractor(url: string, width: number, height: number): Promise<FrameExtractor> {
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  await waitForEvent(video, 'loadedmetadata', 5000);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('浏览器不支持 Canvas。');

  return {
    capture: async (index: number, time: number) => {
      await seekVideo(video, time);
      await waitForVideoFrame(video);
      ctx.drawImage(video, 0, 0, width, height);
      const actualTime = Number.isFinite(video.currentTime) ? video.currentTime : time;
      return { index, time: actualTime, hash: visualHash(ctx, width, height), dataUrl: canvas.toDataURL('image/jpeg', 0.9), width, height };
    },
    dispose: () => {
      video.removeAttribute('src');
      video.load();
    }
  };
}

async function captureManualFrameAt(time: number): Promise<void> {
  if (!selectedFile || !videoMeta || isBusy()) return;
  const file = selectedFile;
  const url = URL.createObjectURL(file);
  isBatchProcessing = true;
  updateActionState();
  let extractor: FrameExtractor | null = null;
  try {
    const requestedTime = Math.min(Math.max(time, 0), Math.max(videoMeta.duration - 0.05, 0));
    setProgress(`正在补抓 ${formatClock(requestedTime)} 的页面`, 50, true);
    extractor = await createFrameExtractor(url, videoMeta.width, videoMeta.height);
    const frame = await extractor.capture(slides.length, requestedTime);
    const slide: Slide = { id: Math.max(0, ...slides.map((item) => item.id)) + 1, time: frame.time, hash: frame.hash, dataUrl: frame.dataUrl, width: frame.width, height: frame.height, selected: getDefaultNewSlideSelected(), textBoxes: [] };
    rememberSlideEdit();
    slides.push(slide);
    timelineTime = frame.time;
    updateTimelinePosition();
    renderSlides();
    setPreview(slide);
    setStatus(`已补抓 ${formatClock(frame.time)} 的页面并加入末尾，可拖动调整位置。`);
    setProgress('补抓完成', 100);
    persistWorkspaceToState({ markProcessed: true });
    renderFileList();
  } catch (error) {
    console.error(error);
    setStatus(error instanceof Error ? error.message : '补抓页面失败，请换一个时间点重试。');
  } finally {
    extractor?.dispose();
    URL.revokeObjectURL(url);
    isBatchProcessing = false;
    updateActionState();
    scheduleDraftSave();
  }
}

function isDuplicateSlide(slide: Slide, currentHash: bigint, currentTime: number, settings: Settings): boolean {
  const distancePercent = normalizedHashDistance(slide.hash, currentHash);
  const closeInTime = Math.abs(slide.time - currentTime) < settings.minGap;
  const threshold = closeInTime ? settings.duplicateThreshold * 1.15 : settings.duplicateThreshold;
  return distancePercent <= threshold;
}

function visualHash(ctx: CanvasRenderingContext2D, width: number, height: number): bigint {
  return averageHashBits(ctx, width, height, 8) | (differenceHashBits(ctx, width, height, 17, 16) << 64n);
}

function averageHashBits(ctx: CanvasRenderingContext2D, width: number, height: number, size: number): bigint {
  const grays = grayscaleThumbnail(ctx, width, height, size, size);
  const avg = grays.reduce((sum, value) => sum + value, 0) / Math.max(grays.length, 1);
  return grays.reduce((hash, value, index) => value >= avg ? hash | (1n << BigInt(index)) : hash, 0n);
}

function differenceHashBits(ctx: CanvasRenderingContext2D, width: number, height: number, hashWidth: number, hashHeight: number): bigint {
  const grays = grayscaleThumbnail(ctx, width, height, hashWidth, hashHeight);
  let hash = 0n;
  let bit = 0n;
  for (let y = 0; y < hashHeight; y += 1) {
    for (let x = 0; x < hashWidth - 1; x += 1) {
      if (grays[y * hashWidth + x] >= grays[y * hashWidth + x + 1]) hash |= 1n << bit;
      bit += 1n;
    }
  }
  return hash;
}

function grayscaleThumbnail(ctx: CanvasRenderingContext2D, width: number, height: number, targetWidth: number, targetHeight: number): number[] {
  const tmp = document.createElement('canvas');
  const tctx = tmp.getContext('2d', { willReadFrequently: true });
  if (!tctx) return [];
  tmp.width = targetWidth;
  tmp.height = targetHeight;
  tctx.drawImage(ctx.canvas, 0, 0, width, height, 0, 0, targetWidth, targetHeight);
  const data = tctx.getImageData(0, 0, targetWidth, targetHeight).data;
  const grays: number[] = [];
  for (let i = 0; i < data.length; i += 4) grays.push(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
  return grays;
}

function normalizedHashDistance(a: bigint, b: bigint): number {
  return (hammingDistance(a, b) / VISUAL_HASH_BITS) * 100;
}

function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x) { count += Number(x & 1n); x >>= 1n; }
  return count;
}

async function makePdf(items: Slide[]): Promise<Blob> {
  if (items.length === 0) throw new Error('没有可导出的页面。');
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  for (const [index, slide] of items.entries()) {
    if (index > 0) pdf.addPage();
    const ratio = Math.min(pageWidth / slide.width, pageHeight / slide.height);
    const drawWidth = slide.width * ratio;
    const drawHeight = slide.height * ratio;
    const imageX = (pageWidth - drawWidth) / 2;
    const imageY = (pageHeight - drawHeight) / 2;
    let imageData = slide.dataUrl;
    if (slide.textBoxes?.some((box) => box.text.trim())) {
      await document.fonts?.ready;
      const image = await loadImage(slide.dataUrl);
      const canvas = document.createElement('canvas');
      canvas.width = slide.width;
      canvas.height = slide.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('当前浏览器无法渲染 PDF 文字，请改用 PPTX 导出。');
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      paintPdfTextBoxes(ctx, canvas.width, canvas.height, slide.textBoxes);
      imageData = canvas.toDataURL('image/jpeg', 0.95);
    }
    pdf.addImage(imageData, 'JPEG', imageX, imageY, drawWidth, drawHeight);
    await yieldToBrowser();
  }
  return pdf.output('blob');
}

async function buildSlidesFromImages(
  files: File[],
  onProgress?: (index: number, total: number) => void,
  onSlide?: (slide: Slide, index: number, total: number) => void
): Promise<Slide[]> {
  const imageSlides: Slide[] = [];
  for (const [index, file] of files.entries()) {
    onProgress?.(index + 1, files.length);
    const slide = await imageFileToSlide(file, index);
    imageSlides.push(slide);
    onSlide?.(slide, index + 1, files.length);
    await yieldToBrowser();
  }
  return imageSlides;
}

async function imageFileToSlide(file: File, index: number): Promise<Slide> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, IMAGE_DECK_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('浏览器不支持 Canvas。');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    return {
      id: index + 1,
      time: index,
      hash: visualHash(ctx, width, height),
      dataUrl: canvas.toDataURL('image/jpeg', 0.92),
      width,
      height,
      selected: true,
      textBoxes: []
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function runOcrForSelectedSlides(): Promise<void> {
  if (isBusy()) return;
  const targets = slides.filter((slide) => slide.selected);
  const fallback = getActiveSlide();
  const targetSlides = targets.length > 0 ? targets : fallback ? [fallback] : [];
  if (targetSlides.length === 0) {
    setStatus('请先选择至少一页再识别文字。');
    return;
  }
  const previousTextBoxes = targetSlides.map((slide) => ({ slide, boxes: slide.textBoxes.map((box) => ({ ...box })) }));
  isBatchProcessing = true;
  updateActionState();
  try {
    if (!await ensureUsageCapacity('editable_slide', targetSlides.length, '文字识别页面', setStatus)) return;
    setProgress('正在准备文字识别', 5, true);
    setStatus('正在识别勾选页面的文字；新结果会替换这些页面现有文本框。');
    const textBoxCount = await recognizeSlidesToTextBoxes(targetSlides, {
      replaceExisting: true,
      onProgress: (index, total, message) => {
        setProgress(`文字识别：${index} / ${total} · ${message}`, 5 + Math.round((index / Math.max(total, 1)) * 90), true);
      }
    });
    renderSlides();
    if (targetSlides[0]) setPreview(targetSlides[0]);
    setProgress('文字识别完成', 100);
    setStatus(`文字识别完成：已为 ${targetSlides.length} 页生成 ${textBoxCount} 个可编辑文本框。`);
    persistWorkspaceToState({ markProcessed: slides.length > 0 });
    await recordUsage('editable_slide', targetSlides.length, {
      source: 'workspace_ocr',
      pages: targetSlides.length,
      text_boxes: textBoxCount
    });
  } catch (error) {
    console.error(error);
    previousTextBoxes.forEach(({ slide, boxes }) => { slide.textBoxes = boxes; });
    renderSlides();
    persistWorkspaceToState();
    const message = error instanceof Error ? error.message : '文字识别失败，请稍后重试。';
    setProgress('文字识别未完成', 100);
    setStatus(`${message} 已保留原有文本框，可以重试。`);
  } finally {
    isBatchProcessing = false;
    updateActionState();
    scheduleDraftSave();
  }
}

async function recognizeSlidesToTextBoxes(
  targetSlides: Slide[],
  options: {
    replaceExisting: boolean;
    onProgress?: (index: number, total: number, message: string) => void;
  }
): Promise<number> {
  if (targetSlides.length === 0) return 0;
  isOcrRunning = true;
  updateActionState();
  let currentIndex = 0;
  let totalTextBoxes = 0;
  let worker: OcrWorker | null = null;
  try {
    options.onProgress?.(0, targetSlides.length, '加载 OCR 引擎');
    const tesseract = await loadTesseract();
    worker = await tesseract.createWorker(OCR_LANGUAGES, 1, {
      logger: (message: { status?: string; progress?: number }) => {
        const label = formatOcrLoggerMessage(message);
        if (label) options.onProgress?.(currentIndex, targetSlides.length, label);
      }
    });
    await worker.setParameters({
      preserve_interword_spaces: '1',
      tessedit_pageseg_mode: tesseract.PSM?.SPARSE_TEXT ?? '11'
    });

    for (const [index, slide] of targetSlides.entries()) {
      currentIndex = index + 1;
      options.onProgress?.(currentIndex, targetSlides.length, `识别第 ${slide.id} 页`);
      const prepared = await prepareSlideForOcr(slide);
      const result = await worker.recognize(prepared.canvas, undefined, { text: true, blocks: true });
      const boxes = ocrPageToTextBoxes(result.data, prepared.canvas, slide.id);
      if (options.replaceExisting) slide.textBoxes = boxes;
      else slide.textBoxes.push(...boxes);
      totalTextBoxes += boxes.length;
      activeSlideId = slide.id;
      activeTextBoxId = slide.textBoxes[0]?.id ?? null;
      options.onProgress?.(currentIndex, targetSlides.length, `第 ${slide.id} 页识别出 ${boxes.length} 个文本框`);
      await yieldToBrowser();
    }
    return totalTextBoxes;
  } catch (error) {
    throw new Error(error instanceof Error
      ? `OCR 失败：${error.message}`
      : 'OCR 失败：无法加载或运行 OCR 引擎。');
  } finally {
    if (worker) await worker.terminate().catch(() => undefined);
    isOcrRunning = false;
    updateActionState();
  }
}

function loadTesseract(): Promise<TesseractApi> {
  const existing = (window as Window & { Tesseract?: TesseractApi }).Tesseract;
  if (existing) return Promise.resolve(existing);
  if (tesseractLoadPromise) return tesseractLoadPromise;
  tesseractLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TESSERACT_SCRIPT_URL;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = () => {
      const api = (window as Window & { Tesseract?: TesseractApi }).Tesseract;
      if (api) resolve(api);
      else {
        tesseractLoadPromise = null;
        reject(new Error('OCR 脚本已加载，但没有找到 Tesseract API。'));
      }
    };
    script.onerror = () => {
      tesseractLoadPromise = null;
      reject(new Error('无法加载 OCR 引擎。请检查网络或稍后重试。'));
    };
    document.head.appendChild(script);
  });
  return tesseractLoadPromise;
}

async function prepareSlideForOcr(slide: Slide): Promise<{ canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }> {
  const img = await loadImage(slide.dataUrl);
  const scale = Math.max(1, Math.min(2, OCR_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight)));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('浏览器不支持 Canvas OCR。');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return { canvas, ctx };
}

function ocrPageToTextBoxes(page: OcrPage, canvas: HTMLCanvasElement, slideId: number): SlideTextBox[] {
  const boxes: SlideTextBox[] = [];
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return boxes;
  const candidates = ocrTextCandidates(page);
  if (candidates.length === 0 && page.text?.trim()) {
    candidates.push({
      text: page.text,
      confidence: page.confidence ?? OCR_MIN_CONFIDENCE,
      bbox: {
        x0: canvas.width * 0.06,
        y0: canvas.height * 0.08,
        x1: canvas.width * 0.94,
        y1: canvas.height * 0.92
      }
    });
  }
  candidates.forEach((candidate, index) => {
    const text = cleanOcrText(candidate.text);
    if (!text) return;
    if (candidate.confidence < OCR_MIN_CONFIDENCE && text.length < 8) return;
    const bbox = padOcrBBox(candidate.bbox, canvas.width, canvas.height, 4);
    const widthPx = bbox.x1 - bbox.x0;
    const heightPx = bbox.y1 - bbox.y0;
    if (widthPx < 8 || heightPx < 6) return;
    const x = clamp((bbox.x0 / canvas.width) * 100, 0, 98);
    const y = clamp((bbox.y0 / canvas.height) * 100, 0, 98);
    const width = clamp((widthPx / canvas.width) * 100, 5, 100 - x);
    const height = clamp((heightPx / canvas.height) * 100, 5, 100 - y);
    const lineCount = Math.max(1, text.split('\n').length);
    boxes.push({
      id: `ocr-${slideId}-${index}-${Date.now().toString(36)}`,
      text,
      x,
      y,
      width,
      height,
      fontSize: estimateFontSize(height, lineCount),
      color: estimateReadableTextColor(ctx, bbox),
      bold: height / lineCount > 8 || text.length < 28,
      align: 'left'
    });
  });
  return mergeNearbyOcrBoxes(boxes);
}

function ocrTextCandidates(page: OcrPage): Array<{ text: string; confidence: number; bbox: OcrBBox }> {
  const candidates: Array<{ text: string; confidence: number; bbox: OcrBBox }> = [];
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      const lines = paragraph.lines ?? [];
      const text = lines.length > 0 ? lines.map((line) => line.text).join('\n') : paragraph.text;
      candidates.push({ text, confidence: paragraph.confidence, bbox: paragraph.bbox });
    }
    if ((block.paragraphs ?? []).length === 0) {
      candidates.push({ text: block.text, confidence: block.confidence, bbox: block.bbox });
    }
  }
  return candidates;
}

function mergeNearbyOcrBoxes(items: SlideTextBox[]): SlideTextBox[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const merged: SlideTextBox[] = [];
  for (const item of sorted) {
    const previous = merged[merged.length - 1];
    const sameColumn = previous && Math.abs(previous.x - item.x) < 3 && Math.abs(previous.width - item.width) < 8;
    const closeVertical = previous && item.y - (previous.y + previous.height) < 2.2;
    const compatibleSize = previous && Math.abs(previous.fontSize - item.fontSize) < 3;
    if (previous && sameColumn && closeVertical && compatibleSize && previous.text.length + item.text.length < 500) {
      previous.text = `${previous.text}\n${item.text}`;
      const bottom = Math.max(previous.y + previous.height, item.y + item.height);
      previous.height = bottom - previous.y;
      previous.width = Math.max(previous.width, item.width);
      continue;
    }
    merged.push({ ...item });
  }
  return merged;
}

function padOcrBBox(bbox: OcrBBox, width: number, height: number, pad: number): OcrBBox {
  return {
    x0: clamp(bbox.x0 - pad, 0, width),
    y0: clamp(bbox.y0 - pad, 0, height),
    x1: clamp(bbox.x1 + pad, 0, width),
    y1: clamp(bbox.y1 + pad, 0, height)
  };
}

function cleanOcrText(text: string): string {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function estimateFontSize(heightPercent: number, lineCount: number): number {
  const pointHeight = (heightPercent / 100) * 540;
  return Math.round(clamp((pointHeight / Math.max(lineCount, 1)) * 0.78, 9, 44));
}

function estimateReadableTextColor(ctx: CanvasRenderingContext2D, bbox: OcrBBox): string {
  const width = Math.max(1, bbox.x1 - bbox.x0);
  const height = Math.max(1, bbox.y1 - bbox.y0);
  const stepX = Math.max(1, Math.floor(width / 8));
  const stepY = Math.max(1, Math.floor(height / 8));
  let total = 0;
  let count = 0;
  for (let y = bbox.y0; y < bbox.y1; y += stepY) {
    for (let x = bbox.x0; x < bbox.x1; x += stepX) {
      const [r, g, b, a] = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
      if (a < 20) continue;
      total += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      count += 1;
    }
  }
  const avg = count > 0 ? total / count : 255;
  return avg < 115 ? '#ffffff' : '#111827';
}

function formatOcrLoggerMessage(message: { status?: string; progress?: number }): string {
  const status = message.status ? message.status.replace(/_/g, ' ') : '';
  if (!status) return '';
  const progress = typeof message.progress === 'number' ? ` ${Math.round(message.progress * 100)}%` : '';
  return `${status}${progress}`;
}

async function downloadSelectedPdf(): Promise<void> { await exportSelected('pdf'); }
async function downloadSelectedPptx(): Promise<void> { await exportSelected('pptx'); }
async function downloadSelectedFramesZip(): Promise<void> { await exportSelected('zip'); }

async function exportSelected(format: 'pdf' | 'pptx' | 'zip'): Promise<void> {
  if (isBusy()) return;
  const items = cloneSlides(slides.filter((slide) => slide.selected));
  const file = selectedFile;
  if (!file || !items.length) { setStatus('请至少勾选 1 页后导出。'); return; }
  isExporting = true;
  updateActionState();
  const label = format === 'zip' ? '页面图片 ZIP' : format.toUpperCase();
  setProgress(`正在生成 ${label} · ${items.length} 页`, undefined, true);
  try {
    let blob: Blob;
    if (format === 'pdf') blob = await makePdf(items);
    else if (format === 'pptx') blob = await makePptx(items);
    else {
      const zip = new JSZip();
      addSlidesToZip(zip, file, items);
      blob = await zip.generateAsync({ type: 'blob' });
    }
    downloadBlob(blob, `${baseName(file.name)}.${format}`);
    setProgress(`${label} 已生成`, 100);
    setStatus(`已生成 ${items.length} 页 ${label}，请在浏览器下载列表中查看。可以继续导出其他格式。`);
  } catch (error) {
    hideProgress();
    setStatus(error instanceof Error ? error.message : `${label} 生成失败，页面已保留，请重试。`);
  } finally {
    isExporting = false;
    updateActionState();
  }
}

async function makePptx(items: Slide[]): Promise<Blob> {
  if (items.length === 0) throw new Error('没有可导出的页面。');
  const zip = new JSZip();
  const media = items.map((slide, index) => {
    const image = dataUrlToPptImage(slide.dataUrl);
    return { ...image, name: `image${index + 1}.${image.ext}` };
  });

  zip.file('[Content_Types].xml', pptxContentTypes(items.length));
  zip.folder('_rels')?.file('.rels', pptxRootRels());
  zip.folder('docProps')?.file('app.xml', pptxAppXml(items.length));
  zip.folder('docProps')?.file('core.xml', pptxCoreXml());
  zip.folder('ppt')?.file('presentation.xml', pptxPresentationXml(items.length));
  zip.folder('ppt')?.folder('_rels')?.file('presentation.xml.rels', pptxPresentationRels(items.length));
  zip.folder('ppt')?.folder('theme')?.file('theme1.xml', pptxThemeXml());
  zip.folder('ppt')?.folder('slideMasters')?.file('slideMaster1.xml', pptxSlideMasterXml());
  zip.folder('ppt')?.folder('slideMasters')?.folder('_rels')?.file('slideMaster1.xml.rels', pptxSlideMasterRels());
  zip.folder('ppt')?.folder('slideLayouts')?.file('slideLayout1.xml', pptxSlideLayoutXml());
  zip.folder('ppt')?.folder('slideLayouts')?.folder('_rels')?.file('slideLayout1.xml.rels', pptxSlideLayoutRels());

  const slidesFolder = zip.folder('ppt')?.folder('slides');
  const slideRelsFolder = slidesFolder?.folder('_rels');
  const mediaFolder = zip.folder('ppt')?.folder('media');

  items.forEach((slide, index) => {
    slidesFolder?.file(`slide${index + 1}.xml`, pptxSlideXml(slide, index + 1, media[index].name));
    slideRelsFolder?.file(`slide${index + 1}.xml.rels`, pptxSlideRels(media[index].name));
    mediaFolder?.file(media[index].name, media[index].base64, { base64: true });
  });

  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
}

function dataUrlToPptImage(dataUrl: string): { ext: 'jpg' | 'png'; contentType: string; base64: string } {
  const mime = dataUrl.match(/^data:([^;,]+)/)?.[1] ?? 'image/jpeg';
  const ext = mime.includes('png') ? 'png' : 'jpg';
  return {
    ext,
    contentType: ext === 'png' ? 'image/png' : 'image/jpeg',
    base64: dataUrlToBase64(dataUrl)
  };
}

function pptxImagePlacement(slide: Slide): { x: number; y: number; cx: number; cy: number } {
  const ratio = Math.min(PPTX_SLIDE_WIDTH_EMU / slide.width, PPTX_SLIDE_HEIGHT_EMU / slide.height);
  const cx = Math.round(slide.width * ratio);
  const cy = Math.round(slide.height * ratio);
  return {
    x: Math.round((PPTX_SLIDE_WIDTH_EMU - cx) / 2),
    y: Math.round((PPTX_SLIDE_HEIGHT_EMU - cy) / 2),
    cx,
    cy
  };
}

function pptxContentTypes(slideCount: number): string {
  const slideOverrides = Array.from({ length: slideCount }, (_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  ${slideOverrides}
</Types>`;
}

function pptxRootRels(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function pptxPresentationRels(slideCount: number): string {
  const slideRels = Array.from({ length: slideCount }, (_, index) => `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  ${slideRels}
</Relationships>`;
}

function pptxPresentationXml(slideCount: number): string {
  const slideIds = Array.from({ length: slideCount }, (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:sldIdLst>${slideIds}</p:sldIdLst>
  <p:sldSz cx="${PPTX_SLIDE_WIDTH_EMU}" cy="${PPTX_SLIDE_HEIGHT_EMU}" type="wide"/>
  <p:notesSz cx="6858000" cy="9144000"/>
  <p:defaultTextStyle/>
</p:presentation>`;
}

function pptxSlideRels(mediaName: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${escapeXml(mediaName)}"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`;
}

function pptxSlideXml(slide: Slide, slideNumber: number, mediaName: string): string {
  const placement = pptxImagePlacement(slide);
  const title = escapeXml(`Page ${slideNumber}: ${mediaName}`);
  const textBoxes = (slide.textBoxes ?? [])
    .map((box, index) => pptxTextBoxXml(box, slideNumber * 100 + index + 10, placement))
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${PPTX_SLIDE_WIDTH_EMU}" cy="${PPTX_SLIDE_HEIGHT_EMU}"/><a:chOff x="0" y="0"/><a:chExt cx="${PPTX_SLIDE_WIDTH_EMU}" cy="${PPTX_SLIDE_HEIGHT_EMU}"/></a:xfrm></p:grpSpPr>
      <p:pic>
        <p:nvPicPr><p:cNvPr id="${slideNumber + 1}" name="${title}" descr="${title}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
        <p:spPr><a:xfrm><a:off x="${placement.x}" y="${placement.y}"/><a:ext cx="${placement.cx}" cy="${placement.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
      </p:pic>
      ${textBoxes}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

function pptxTextBoxXml(box: SlideTextBox, shapeId: number, placement: { x: number; y: number; cx: number; cy: number }): string {
  const x = Math.round(placement.x + (box.x / 100) * placement.cx);
  const y = Math.round(placement.y + (box.y / 100) * placement.cy);
  const cx = Math.round((box.width / 100) * placement.cx);
  const cy = Math.round((box.height / 100) * placement.cy);
  const fontSize = Math.round(clamp(box.fontSize, 8, 96) * 100);
  const color = normalizeHexColor(box.color).replace('#', '').toUpperCase();
  const align = box.align === 'center' ? 'ctr' : box.align === 'right' ? 'r' : 'l';
  const paragraphs = (box.text || ' ')
    .split(/\r?\n/)
    .map((line) => `<a:p><a:pPr algn="${align}"/><a:r><a:rPr lang="zh-CN" sz="${fontSize}"${box.bold ? ' b="1"' : ''}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Arial"/><a:ea typeface="Microsoft YaHei"/></a:rPr><a:t>${escapeXml(line || ' ')}</a:t></a:r><a:endParaRPr lang="zh-CN" sz="${fontSize}"/></a:p>`)
    .join('');
  return `<p:sp>
        <p:nvSpPr><p:cNvPr id="${shapeId}" name="Editable Text ${shapeId}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>
        <p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody>
      </p:sp>`;
}

function pptxAppXml(slideCount: number): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Vid2PPT</Application>
  <PresentationFormat>Widescreen</PresentationFormat>
  <Slides>${slideCount}</Slides>
</Properties>`;
}

function pptxCoreXml(): string {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Vid2PPT Export</dc:title>
  <dc:creator>Vid2PPT</dc:creator>
  <cp:lastModifiedBy>Vid2PPT</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

function pptxSlideMasterRels(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`;
}

function pptxSlideLayoutRels(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`;
}

function pptxSlideMasterXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${PPTX_SLIDE_WIDTH_EMU}" cy="${PPTX_SLIDE_HEIGHT_EMU}"/><a:chOff x="0" y="0"/><a:chExt cx="${PPTX_SLIDE_WIDTH_EMU}" cy="${PPTX_SLIDE_HEIGHT_EMU}"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
  <p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>
</p:sldMaster>`;
}

function pptxSlideLayoutXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
  <p:cSld name="Blank">
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${PPTX_SLIDE_WIDTH_EMU}" cy="${PPTX_SLIDE_HEIGHT_EMU}"/><a:chOff x="0" y="0"/><a:chExt cx="${PPTX_SLIDE_WIDTH_EMU}" cy="${PPTX_SLIDE_HEIGHT_EMU}"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;
}

function pptxThemeXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Vid2PPT">
  <a:themeElements>
    <a:clrScheme name="Office">
      <a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F8FAFC"/></a:lt2>
      <a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="16A34A"/></a:accent2>
      <a:accent3><a:srgbClr val="F97316"/></a:accent3><a:accent4><a:srgbClr val="7C3AED"/></a:accent4>
      <a:accent5><a:srgbClr val="0F172A"/></a:accent5><a:accent6><a:srgbClr val="64748B"/></a:accent6>
      <a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Office"><a:majorFont><a:latin typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme>
    <a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
  </a:themeElements>
</a:theme>`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function normalizeHexColor(value: string): string {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed;
  if (/^[0-9a-f]{6}$/i.test(trimmed)) return `#${trimmed}`;
  return '#111827';
}

function hexToRgb(value: string): [number, number, number] {
  const hex = normalizeHexColor(value).replace('#', '');
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16)
  ];
}

function addSlidesToZip(zip: JSZip, file: File, items: Slide[]): void {
  const folder = zip.folder(baseName(file.name)) ?? zip;
  items.forEach((slide, index) => {
    const safeTime = formatClock(slide.time).replace(/:/g, '-');
    folder.file(`${String(index + 1).padStart(4, '0')}_${safeTime}.jpg`, dataUrlToBase64(slide.dataUrl), { base64: true });
  });
}

function dataUrlToBase64(dataUrl: string): string {
  const commaIndex = dataUrl.indexOf(',');
  return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
}

async function transcribeLocally(file: File, onProgress: (message: string) => void): Promise<string> {
  transcriptEl.value = '';
  const worker = new Worker(new URL('./transcribeWorker.ts', import.meta.url), { type: 'module' });
  try {
    const audio = await decodeToMono16k(file, onProgress);
    const sampleRate = 16000;
    const chunkSize = TRANSCRIBE_CHUNK_SECONDS * sampleRate;
    const contextSize = TRANSCRIBE_CONTEXT_SECONDS * sampleRate;
    const totalChunks = Math.ceil(audio.length / chunkSize);
    let lastText = '';
    onProgress('准备转写引擎...');
    setProgress('准备转写引擎', 5, true);
    await loadTranscriptionWorker(worker);

    for (let index = 0; index < totalChunks; index += 1) {
      const logicalStart = index * chunkSize;
      const logicalEnd = Math.min(audio.length, logicalStart + chunkSize);
      const decodeStart = Math.max(0, logicalStart - contextSize);
      const chunk = audio.slice(decodeStart, Math.min(audio.length, logicalEnd + contextSize));
      const startSec = logicalStart / sampleRate;
      const endSec = logicalEnd / sampleRate;
      setProgress(`转写中：第 ${index + 1} / ${totalChunks} 段，${formatClock(startSec)} - ${formatClock(endSec)}`, 10 + Math.round((index / Math.max(totalChunks, 1)) * 85), true);
      onProgress(`转写中：第 ${index + 1} / ${totalChunks} 段，${formatClock(startSec)} - ${formatClock(endSec)}`);
      if (index > 0 && rms(chunk) < 0.0025) { await yieldToBrowser(); continue; }
      const rawText = await transcribeChunkWithRetry(worker, index, chunk, index === 0 ? 2 : 1);
      const cleanedText = cleanTranscriptText(rawText);
      if (cleanedText && !isNearDuplicate(cleanedText, lastText)) {
        appendTranscript(`[${formatClock(startSec)} - ${formatClock(endSec)}] ${cleanedText}`);
        lastText = cleanedText;
      }
      await yieldToBrowser();
    }
    return transcriptEl.value.trim();
  } catch (error) {
    console.warn(error);
    return transcriptEl.value.trim();
  } finally {
    worker.terminate();
  }
}

async function decodeToMono16k(file: File, onProgress: (message: string) => void): Promise<Float32Array> {
  onProgress('正在解码音频...');
  setProgress('正在解码音频', 2, true);
  const audioContext = new AudioContext();
  const audioBuffer = await audioContext.decodeAudioData(await file.arrayBuffer());
  await audioContext.close().catch(() => undefined);
  const mono = new Float32Array(audioBuffer.length);
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) mono[i] += data[i] / audioBuffer.numberOfChannels;
  }
  if (audioBuffer.sampleRate === 16000) return mono;
  onProgress('正在重采样音频到 16kHz...');
  setProgress('正在重采样音频到 16kHz', 4, true);
  const targetLength = Math.ceil(mono.length * 16000 / audioBuffer.sampleRate);
  const offline = new OfflineAudioContext(1, targetLength, 16000);
  const sourceBuffer = offline.createBuffer(1, mono.length, audioBuffer.sampleRate);
  sourceBuffer.copyToChannel(mono, 0);
  const source = offline.createBufferSource();
  source.buffer = sourceBuffer;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

function loadTranscriptionWorker(worker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<WorkerResult>) => {
      if (event.data.type === 'ready') { cleanup(); resolve(); }
      else if (event.data.type === 'error') { cleanup(); reject(new Error(event.data.error)); }
      else if (event.data.type === 'model-progress') {
        const pct = typeof event.data.progress === 'number' ? Math.round(event.data.progress) : undefined;
        const overall = typeof pct === 'number' ? 5 + Math.round(pct * 0.05) : undefined;
        setProgress(`加载转写模型：${event.data.status}`, overall, typeof overall !== 'number');
      }
    };
    const onError = () => { cleanup(); reject(new Error('转写 Worker 加载失败。')); };
    const cleanup = () => {
      worker.removeEventListener('message', onMessage as EventListener);
      worker.removeEventListener('error', onError);
    };
    worker.addEventListener('message', onMessage as EventListener);
    worker.addEventListener('error', onError);
    worker.postMessage({ type: 'load' });
  });
}

async function transcribeChunkWithRetry(worker: Worker, id: number, audio: Float32Array, attempts: number): Promise<string> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await transcribeChunk(worker, id * 10 + attempt, audio.slice()); }
    catch (error) { lastError = error instanceof Error ? error : new Error(String(error)); await yieldToBrowser(); }
  }
  throw lastError ?? new Error('转写失败。');
}

function transcribeChunk(worker: Worker, id: number, audio: Float32Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<WorkerResult>) => {
      if (event.data.type === 'result' && event.data.id === id) { cleanup(); resolve(event.data.text); }
      else if (event.data.type === 'error' && event.data.id === id) { cleanup(); reject(new Error(event.data.error)); }
    };
    const onError = () => { cleanup(); reject(new Error('转写 Worker 运行失败。')); };
    const cleanup = () => {
      worker.removeEventListener('message', onMessage as EventListener);
      worker.removeEventListener('error', onError);
    };
    worker.addEventListener('message', onMessage as EventListener);
    worker.addEventListener('error', onError);
    worker.postMessage({ type: 'transcribe', id, audio }, [audio.buffer as ArrayBuffer]);
  });
}

function clearSlideDropIndicators(): void {
  slidesEl.querySelectorAll<HTMLElement>('.slide-card').forEach((card) => {
    card.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after');
    delete card.dataset.dropPosition;
  });
}

function finishSlideReorder(slideId: number, previousIndex: number): void {
  const nextIndex = slides.findIndex((slide) => slide.id === slideId);
  if (nextIndex < 0 || nextIndex === previousIndex) return;
  persistWorkspaceToState({ markProcessed: true });
  renderSlides();
  setStatus(`已将第 ${previousIndex + 1} 页移到第 ${nextIndex + 1} 页，勾选和当前预览保持不变。`);
}

function moveSlideByStep(slideId: number, direction: -1 | 1): void {
  if (isBusy()) {
    setStatus('请等待当前任务完成后再调整页面顺序。');
    return;
  }
  const previousIndex = slides.findIndex((slide) => slide.id === slideId);
  const nextIndex = previousIndex + direction;
  if (previousIndex < 0 || nextIndex < 0 || nextIndex >= slides.length) return;
  rememberSlideEdit();
  const [movedSlide] = slides.splice(previousIndex, 1);
  if (!movedSlide) return;
  slides.splice(nextIndex, 0, movedSlide);
  finishSlideReorder(slideId, previousIndex);
}

function moveSlideAroundTarget(slideId: number, targetSlideId: number, placeAfter: boolean): void {
  if (isBusy()) {
    setStatus('请等待当前任务完成后再调整页面顺序。');
    return;
  }
  const previousIndex = slides.findIndex((slide) => slide.id === slideId);
  const targetIndex = slides.findIndex((slide) => slide.id === targetSlideId);
  if (previousIndex < 0 || targetIndex < 0 || slideId === targetSlideId) return;
  rememberSlideEdit();
  const [movedSlide] = slides.splice(previousIndex, 1);
  if (!movedSlide) return;
  const remainingTargetIndex = slides.findIndex((slide) => slide.id === targetSlideId);
  slides.splice(remainingTargetIndex + (placeAfter ? 1 : 0), 0, movedSlide);
  finishSlideReorder(slideId, previousIndex);
}

function updateSlideDropIndicator(card: HTMLElement, event: DragEvent): void {
  if (draggedSlideId === null || card.dataset.slideId === String(draggedSlideId)) return;
  slidesEl.querySelectorAll<HTMLElement>('.slide-card.is-drop-before, .slide-card.is-drop-after').forEach((candidate) => {
    if (candidate === card) return;
    candidate.classList.remove('is-drop-before', 'is-drop-after');
    delete candidate.dataset.dropPosition;
  });
  const bounds = card.getBoundingClientRect();
  const midpointX = bounds.left + bounds.width / 2;
  const midpointY = bounds.top + bounds.height / 2;
  const pointerIsNearSameRow = Math.abs(event.clientY - midpointY) <= bounds.height * 0.3;
  const placeAfter = pointerIsNearSameRow ? event.clientX >= midpointX : event.clientY >= midpointY;
  card.classList.toggle('is-drop-before', !placeAfter);
  card.classList.toggle('is-drop-after', placeAfter);
  card.dataset.dropPosition = placeAfter ? 'after' : 'before';
}

function syncSlideOrderControls(): void {
  const cards = Array.from(slidesEl.querySelectorAll<HTMLElement>('.slide-card'));
  cards.forEach((card, index) => {
    card.draggable = cards.length > 1;
    const previousButton = card.querySelector<HTMLButtonElement>('.move-slide-previous');
    const nextButton = card.querySelector<HTMLButtonElement>('.move-slide-next');
    if (previousButton) previousButton.disabled = index === 0;
    if (nextButton) nextButton.disabled = index === cards.length - 1;
  });
}

function appendSlideCard(slide: Slide): void {
  const card = document.createElement('figure');
  card.className = 'slide-card';
  if (slide.id === activeSlideId) card.classList.add('is-active');
  card.dataset.slideId = String(slide.id);
  card.draggable = slides.length > 1;
  const slideIndex = slides.findIndex((item) => item.id === slide.id);
  const pageNumber = slideIndex + 1;
  const caption = workspaceMode === 'image' ? `第 ${pageNumber} 页 · 图片页` : `第 ${pageNumber} 页 · ${formatTime(slide.time)}`;
  card.setAttribute('aria-label', `${caption}，可拖动排序`);
  card.innerHTML = `
    <label class="slide-select"><input class="frame-checkbox" type="checkbox" /><span>选入导出</span></label>
    <div class="frame-tools">
      <button class="add-text-box" title="添加可编辑文本框" aria-label="为第 ${pageNumber} 页添加文本框" type="button">T</button>
      <button class="crop-frame" title="裁剪" aria-label="裁剪第 ${pageNumber} 页" type="button">⌗</button>
      <button class="delete-frame" title="删除" aria-label="删除第 ${pageNumber} 页" type="button">🗑</button>
    </div>
    <div class="slide-thumb" style="aspect-ratio: ${slide.width} / ${slide.height}">
      <img src="${slide.dataUrl}" alt="第 ${pageNumber} 页预览" loading="lazy" tabindex="0" role="button" aria-label="预览第 ${pageNumber} 页" />
      <div class="text-box-layer"></div>
    </div>
    <figcaption>
      <span class="slide-caption-text"><span class="slide-drag-hint" aria-hidden="true">⠿</span>${caption}</span>
      <span class="slide-order-controls" aria-label="第 ${pageNumber} 页排序">
        <button class="move-slide-previous" type="button" title="前移一页" aria-label="将第 ${pageNumber} 页前移" ${slideIndex <= 0 ? 'disabled' : ''}>←</button>
        <button class="move-slide-next" type="button" title="后移一页" aria-label="将第 ${pageNumber} 页后移" ${slideIndex >= slides.length - 1 ? 'disabled' : ''}>→</button>
      </span>
    </figcaption>
  `;
  card.addEventListener('dragstart', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (slides.length < 2 || isBusy() || target?.closest('button, input, label, .slide-text-box')) {
      event.preventDefault();
      if (isBusy()) setStatus('请等待当前任务完成后再调整页面顺序。');
      return;
    }
    draggedSlideId = slide.id;
    event.dataTransfer?.setData('application/x-vid2ppt-slide-id', String(slide.id));
    event.dataTransfer?.setData('text/plain', String(slide.id));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    card.classList.add('is-dragging');
  });
  card.addEventListener('dragenter', (event) => {
    if (draggedSlideId === null || draggedSlideId === slide.id) return;
    event.preventDefault();
    updateSlideDropIndicator(card, event);
  });
  card.addEventListener('dragover', (event) => {
    if (draggedSlideId === null || draggedSlideId === slide.id) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    updateSlideDropIndicator(card, event);
  });
  card.addEventListener('dragleave', (event) => {
    if (event.relatedTarget instanceof Node && card.contains(event.relatedTarget)) return;
    card.classList.remove('is-drop-before', 'is-drop-after');
    delete card.dataset.dropPosition;
  });
  card.addEventListener('drop', (event) => {
    event.preventDefault();
    const sourceSlideId = draggedSlideId;
    const placeAfter = card.dataset.dropPosition === 'after';
    clearSlideDropIndicators();
    draggedSlideId = null;
    if (sourceSlideId === null) return;
    moveSlideAroundTarget(sourceSlideId, slide.id, placeAfter);
  });
  card.addEventListener('dragend', () => {
    clearSlideDropIndicators();
    draggedSlideId = null;
  });
  const img = card.querySelector<HTMLImageElement>('img');
  img?.addEventListener('click', () => setPreview(slide));
  img?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setPreview(slide); }
  });
  card.querySelector<HTMLDivElement>('.slide-thumb')?.addEventListener('click', () => {
    setPreview(slide);
    activeTextBoxId = null;
    updateTextBoxPanel();
    syncActiveSlideSelection();
  });
  const checkbox = card.querySelector<HTMLInputElement>('.frame-checkbox');
  if (checkbox) checkbox.checked = slide.selected;
  checkbox?.addEventListener('change', () => {
    slide.selected = Boolean(checkbox.checked);
    const original = slides.find((item) => item.id === slide.id);
    if (original) original.selected = slide.selected;
    persistWorkspaceToState({ markProcessed: slides.length > 0 });
    renderFileList();
    updateActionState();
  });
  card.querySelector<HTMLButtonElement>('.delete-frame')?.addEventListener('click', (event) => { event.stopPropagation(); deleteSlide(slide.id); });
  card.querySelector<HTMLButtonElement>('.crop-frame')?.addEventListener('click', (event) => { event.stopPropagation(); openCropDialog(slide); });
  card.querySelector<HTMLButtonElement>('.add-text-box')?.addEventListener('click', (event) => {
    if (isBusy()) return;
    event.stopPropagation();
    workspaceView.classList.remove('side-collapsed');
    $<HTMLDetailsElement>('.editor-disclosure').open = true;
    toggleSideBtn.setAttribute('aria-expanded', 'true');
    setPreview(slide);
    addTextBoxToActiveSlide();
  });
  card.querySelector<HTMLButtonElement>('.move-slide-previous')?.addEventListener('click', (event) => {
    event.stopPropagation();
    moveSlideByStep(slide.id, -1);
  });
  card.querySelector<HTMLButtonElement>('.move-slide-next')?.addEventListener('click', (event) => {
    event.stopPropagation();
    moveSlideByStep(slide.id, 1);
  });
  card.querySelectorAll<HTMLInputElement | HTMLButtonElement>('.frame-checkbox, .frame-tools button').forEach((control) => { control.disabled = isBusy(); });
  slidesEl.appendChild(card);
  syncSlideOrderControls();
  refreshSlideTextLayer(slide);
  if (!activeSlideId && slide.id === 1) setPreview(slide);
}

function renderSlides(): void {
  draggedSlideId = null;
  slidesEl.innerHTML = '';
  if (activeSlideId && !slides.some((slide) => slide.id === activeSlideId)) activeSlideId = slides[0]?.id ?? null;
  if (!activeSlideId && slides[0]) activeSlideId = slides[0].id;
  slides.forEach((slide) => appendSlideCard(slide));
  updateTimelineMarkers();
  updateActionState();
  updateTextBoxPanel();
}

function addTextBoxToActiveSlide(): void {
  const slide = getActiveSlide() ?? slides[0];
  if (!slide || isBusy()) return;
  activeSlideId = slide.id;
  const box: SlideTextBox = {
    id: `tb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    text: '在这里输入文字',
    x: 12,
    y: 14,
    width: 46,
    height: 14,
    fontSize: 24,
    color: '#111827',
    bold: false,
    align: 'left'
  };
  slide.textBoxes.push(box);
  activeTextBoxId = box.id;
  refreshSlideTextLayer(slide);
  syncActiveSlideSelection();
  updateTextBoxPanel();
  persistWorkspaceToState({ markProcessed: slides.length > 0 });
  setStatus('已添加可编辑文本框。导出 PPTX 后可在 PowerPoint 里继续修改。');
}

function deleteActiveTextBox(): void {
  const slide = getActiveSlide();
  if (!slide || !activeTextBoxId) return;
  const before = slide.textBoxes.length;
  slide.textBoxes = slide.textBoxes.filter((box) => box.id !== activeTextBoxId);
  if (slide.textBoxes.length === before) return;
  activeTextBoxId = slide.textBoxes[0]?.id ?? null;
  refreshSlideTextLayer(slide);
  updateTextBoxPanel();
  persistWorkspaceToState({ markProcessed: slides.length > 0 });
  setStatus('已删除文本框。');
}

function updateActiveTextBoxFromControls(): void {
  const slide = getActiveSlide();
  const box = getActiveTextBox();
  if (!slide || !box) return;
  box.text = textBoxContent.value;
  box.x = clamp(Number(textBoxX.value || 0), 0, 100);
  box.y = clamp(Number(textBoxY.value || 0), 0, 100);
  box.width = clamp(Number(textBoxWidth.value || 5), 5, 100);
  box.height = clamp(Number(textBoxHeight.value || 5), 5, 100);
  box.width = Math.min(box.width, 100 - box.x);
  box.height = Math.min(box.height, 100 - box.y);
  box.fontSize = clamp(Number(textBoxFontSize.value || 24), 8, 96);
  box.color = normalizeHexColor(textBoxColor.value);
  box.bold = textBoxBold.checked;
  box.align = isTextAlign(textBoxAlign.value) ? textBoxAlign.value : 'left';
  refreshSlideTextLayer(slide);
  updateTextBoxPanel(false);
  persistWorkspaceToState({ markProcessed: slides.length > 0 });
}

function refreshSlideTextLayer(slide: Slide): void {
  const layer = slidesEl.querySelector<HTMLDivElement>(`.slide-card[data-slide-id="${slide.id}"] .text-box-layer`);
  if (!layer) return;
  layer.innerHTML = '';
  for (const box of slide.textBoxes) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'slide-text-box';
    if (box.id === activeTextBoxId && slide.id === activeSlideId) node.classList.add('is-selected');
    node.dataset.textBoxId = box.id;
    node.style.left = `${box.x}%`;
    node.style.top = `${box.y}%`;
    node.style.width = `${box.width}%`;
    node.style.height = `${box.height}%`;
    node.style.color = normalizeHexColor(box.color);
    node.style.fontSize = `max(10px, ${(box.fontSize / 960) * 100}cqw)`;
    node.style.fontWeight = box.bold ? '900' : '700';
    node.style.textAlign = box.align;
    node.textContent = box.text || '空文本框';
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      activeSlideId = slide.id;
      activeTextBoxId = box.id;
      setPreview(slide);
      updateTextBoxPanel();
      syncActiveSlideSelection();
      refreshSlideTextLayer(slide);
    });
    bindTextBoxDrag(node, slide, box);
    layer.appendChild(node);
  }
}

function bindTextBoxDrag(node: HTMLButtonElement, slide: Slide, box: SlideTextBox): void {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  node.addEventListener('pointerdown', (event) => {
    if (isBusy()) return;
    event.preventDefault();
    event.stopPropagation();
    const layer = node.parentElement;
    if (!layer) return;
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    startLeft = box.x;
    startTop = box.y;
    activeSlideId = slide.id;
    activeTextBoxId = box.id;
    node.setPointerCapture(event.pointerId);
    setPreview(slide);
    updateTextBoxPanel();
    syncActiveSlideSelection();
    slidesEl.querySelectorAll<HTMLElement>('.slide-text-box').forEach((item) => item.classList.remove('is-selected'));
    node.classList.add('is-selected');
  });

  node.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const layer = node.parentElement;
    if (!layer) return;
    const rect = layer.getBoundingClientRect();
    box.x = clamp(startLeft + ((event.clientX - startX) / Math.max(rect.width, 1)) * 100, 0, 100 - box.width);
    box.y = clamp(startTop + ((event.clientY - startY) / Math.max(rect.height, 1)) * 100, 0, 100 - box.height);
    node.style.left = `${box.x}%`;
    node.style.top = `${box.y}%`;
    updateTextBoxPanel(false);
  });

  node.addEventListener('pointerup', (event) => {
    if (!dragging) return;
    dragging = false;
    node.releasePointerCapture(event.pointerId);
    persistWorkspaceToState({ markProcessed: slides.length > 0 });
  });

  node.addEventListener('pointercancel', () => { dragging = false; });
}

function updateTextBoxPanel(syncValues = true): void {
  const slide = getActiveSlide();
  const box = getActiveTextBox();
  const hasSlide = Boolean(slide);
  const hasBox = Boolean(box);
  runOcrBtn.disabled = !hasSlide || isBusy();
  addTextBoxBtn.disabled = !hasSlide || isBusy();
  deleteTextBoxBtn.disabled = !hasBox || isBusy();
  [textBoxContent, textBoxX, textBoxY, textBoxWidth, textBoxHeight, textBoxFontSize, textBoxColor, textBoxBold, textBoxAlign].forEach((control) => {
    control.disabled = !hasBox || isBusy();
  });
  textLayerHint.textContent = hasBox
    ? `正在编辑第 ${slide ? slides.indexOf(slide) + 1 : '-'} 页的文本框。可拖动缩略图上的文本框调整位置。`
    : hasSlide
      ? `当前选中第 ${slide ? slides.indexOf(slide) + 1 : '-'} 页；可识别勾选页文字，也可手动补文本框。`
      : '选择页面后，可识别文字或手动添加文本框。';

  if (!syncValues) return;
  if (!box) {
    textBoxContent.value = '';
    textBoxX.value = '';
    textBoxY.value = '';
    textBoxWidth.value = '';
    textBoxHeight.value = '';
    textBoxFontSize.value = '';
    textBoxColor.value = '#111827';
    textBoxBold.checked = false;
    textBoxAlign.value = 'left';
    return;
  }

  textBoxContent.value = box.text;
  textBoxX.value = String(Math.round(box.x));
  textBoxY.value = String(Math.round(box.y));
  textBoxWidth.value = String(Math.round(box.width));
  textBoxHeight.value = String(Math.round(box.height));
  textBoxFontSize.value = String(Math.round(box.fontSize));
  textBoxColor.value = normalizeHexColor(box.color);
  textBoxBold.checked = box.bold;
  textBoxAlign.value = box.align;
}

function syncActiveSlideSelection(): void {
  slidesEl.querySelectorAll<HTMLElement>('.slide-card').forEach((card) => {
    card.classList.toggle('is-active', card.dataset.slideId === String(activeSlideId));
  });
}

function getActiveSlide(): Slide | null {
  if (!activeSlideId) return null;
  return slides.find((slide) => slide.id === activeSlideId) ?? null;
}

function getActiveTextBox(): SlideTextBox | null {
  const slide = getActiveSlide();
  if (!slide || !activeTextBoxId) return null;
  return slide.textBoxes.find((box) => box.id === activeTextBoxId) ?? null;
}

function isTextAlign(value: string): value is SlideTextBox['align'] {
  return value === 'left' || value === 'center' || value === 'right';
}

function deleteSlide(id: number): void {
  if (isBusy()) return;
  const index = slides.findIndex((slide) => slide.id === id);
  if (index < 0) return;
  rememberSlideEdit();
  slides.splice(index, 1);
  if (activeSlideId === id) {
    activeSlideId = slides[Math.min(index, slides.length - 1)]?.id ?? null;
    activeTextBoxId = null;
  }
  renderSlides();
  const active = getActiveSlide();
  if (active) setPreview(active);
  else { previewImage.removeAttribute('src'); previewEmpty.hidden = false; }
  setStatus(`已删除第 ${index + 1} 页，其余页面顺序保持不变。可点击“撤销上一步”恢复。`);
  persistWorkspaceToState();
  renderFileList();
}

function openCropDialog(slide: Slide): void {
  if (isBusy()) return;
  cropTargetSlideId = slide.id;
  cropImage.src = slide.dataUrl;
  cropLeft.value = '0';
  cropTop.value = '0';
  cropWidth.value = '100';
  cropHeight.value = '100';
  cropDialog.showModal();
}

async function applyCrop(): Promise<void> {
  const slide = slides.find((item) => item.id === cropTargetSlideId);
  if (!slide || isBusy()) return;
  const left = clamp(Number(cropLeft.value || 0), 0, 99) / 100;
  const top = clamp(Number(cropTop.value || 0), 0, 99) / 100;
  const widthPct = clamp(Number(cropWidth.value || 100), 1, 100) / 100;
  const heightPct = clamp(Number(cropHeight.value || 100), 1, 100) / 100;
  isBatchProcessing = true;
  cropApplyBtn.disabled = true;
  updateActionState();
  try {
    const img = await loadImage(slide.dataUrl);
    const sx = Math.floor(img.naturalWidth * left);
    const sy = Math.floor(img.naturalHeight * top);
    const sw = Math.max(1, Math.min(Math.floor(img.naturalWidth * widthPct), img.naturalWidth - sx));
    const sh = Math.max(1, Math.min(Math.floor(img.naturalHeight * heightPct), img.naturalHeight - sy));
    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('当前浏览器无法创建裁剪画布，请重试。');
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    rememberSlideEdit();
    slide.textBoxes = cropTextBoxes(slide.textBoxes, {
      x: sx / img.naturalWidth,
      y: sy / img.naturalHeight,
      width: sw / img.naturalWidth,
      height: sh / img.naturalHeight
    });
    if (!slide.textBoxes.some((box) => box.id === activeTextBoxId)) activeTextBoxId = null;
    slide.dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    slide.width = sw;
    slide.height = sh;
    slide.hash = visualHash(ctx, sw, sh);
    cropDialog.close();
    renderSlides();
    setPreview(slide);
    setStatus('已裁剪页面，文本框已同步到新画面。');
    persistWorkspaceToState({ markProcessed: slides.length > 0 });
    renderFileList();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '裁剪未能完成，请重试。');
  } finally {
    isBatchProcessing = false;
    cropApplyBtn.disabled = false;
    updateActionState();
    scheduleDraftSave();
  }
}

function setPreview(slide: Slide): void {
  activeSlideId = slide.id;
  previewImage.src = slide.dataUrl;
  previewEmpty.hidden = true;
  syncActiveSlideSelection();
  updateTextBoxPanel();
}

function setupTimeline(duration: number): void {
  timelineTime = 0;
  extractionTimelineMax = 0;
  lastTimelinePaint = 0;
  timelineDurationEl.textContent = formatClock(duration);
  timelineRail.setAttribute('aria-valuemax', String(Math.max(0, Math.round(duration))));
  timelineMarkers.innerHTML = '';
  updateTimelinePosition();
}

function updateTimelineFromPointer(event: PointerEvent): void {
  if (!videoMeta) return;
  const rect = timelineRail.getBoundingClientRect();
  const ratio = clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
  timelineTime = ratio * videoMeta.duration;
  extractionTimelineMax = Math.max(extractionTimelineMax, timelineTime);
  updateTimelinePosition();
}

function updateExtractionTimeline(time: number, force = false): void {
  if (!videoMeta || isDraggingTimeline) return;
  extractionTimelineMax = Math.max(extractionTimelineMax, time);
  const now = performance.now();
  if (!force && now - lastTimelinePaint < TIMELINE_PAINT_INTERVAL_MS) return;
  timelineTime = Math.min(extractionTimelineMax, videoMeta.duration);
  lastTimelinePaint = now;
  updateTimelinePosition();
}

function forceTimelineToEnd(): void {
  if (!videoMeta) return;
  updateExtractionTimeline(videoMeta.duration, true);
}

function updateTimelinePosition(): void {
  const duration = videoMeta?.duration ?? 0;
  const percent = duration > 0 ? clamp(timelineTime / duration, 0, 1) * 100 : 0;
  timelineHandle.style.left = `${percent}%`;
  timelineTimeEl.textContent = formatClock(timelineTime);
  timelineDurationEl.textContent = formatClock(duration);
  timelineRail.setAttribute('aria-valuenow', String(Math.max(0, Math.round(timelineTime))));
  timelineRail.setAttribute('aria-valuemax', String(Math.max(0, Math.round(duration))));
  timelineRail.setAttribute('aria-valuetext', formatClock(timelineTime));
}

function updateTimelineMarkers(): void {
  const duration = videoMeta?.duration ?? 0;
  timelineMarkers.innerHTML = '';
  if (duration <= 0) return;
  for (const slide of slides) {
    const marker = document.createElement('span');
    marker.className = 'timeline-marker';
    marker.style.left = `${clamp(slide.time / duration, 0, 1) * 100}%`;
    marker.title = `#${slide.id} · ${formatClock(slide.time)}`;
    marker.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      timelineTime = slide.time;
      updateTimelinePosition();
      setPreview(slide);
    });
    timelineMarkers.appendChild(marker);
  }
}

function updateActionState(): void {
  const busy = isBusy();
  const hasFile = Boolean(selectedFile);
  const hasVideoFile = Boolean(selectedFile) && currentFileIndex >= 0 && workspaceMode === 'video';
  const imageMode = workspaceMode === 'image';
  const limits = currentLimits();
  const selectedCount = slides.filter((slide) => slide.selected).length;
  selectAllBox.disabled = busy || !slides.length;
  $<HTMLButtonElement>('#undoEditBtn').disabled = busy || !undoSnapshot || undoSnapshot.file !== selectedFile;
  $<HTMLButtonElement>('#selectAllReviewBtn').disabled = busy || !slides.length;
  $<HTMLButtonElement>('#reextractBtn').disabled = busy;
  $<HTMLElement>('#reextractBtn').hidden = isDemoProject || workspaceMode !== 'video' || currentFileIndex < 0;
  $<HTMLElement>('#cancelExtractionBtn').hidden = !isExtracting;
  slidesEl.querySelectorAll<HTMLInputElement | HTMLButtonElement>('.frame-checkbox, .frame-tools button').forEach((control) => { control.disabled = busy; });
  $<HTMLElement>('#notesLoginBtn').hidden = !!authSession || isDemoProject;
  $<HTMLElement>('#notesAccessHint').textContent = isDemoProject ? '这是示例逐字稿与摘要；导入自己的视频后可生成实际内容。' : authSession ? '逐字稿在本机识别；摘要与笔记会发送必要文本。选择好页面后再生成笔记。' : '逐字稿在本机识别；摘要与图文笔记需登录，会发送必要文本。';
  const limit = limits.video_max_minutes;
  $<HTMLButtonElement>('#toggleImportBtn').disabled = busy;
  $<HTMLElement>('#sourceQuota').textContent = `${planLabel(currentPlan())} · ${limit === null ? '不限时长' : `${limit} 分钟以内`} · 本月${quotaText('video_conversion')}`;
  const waitingForMediaRights = !mediaPreview.hidden && !mediaRightsConfirm.checked && currentMediaMetadata?.provider === 'bilibili';
  extractBtn.disabled = !hasVideoFile || busy;
  extractBtn.textContent = !busy && isAudioSource(selectedFile) ? '打开音频转写' : busy ? '正在处理…' : !hasVideoFile ? '选择文件后开始提取' : slides.length && !isDemoProject ? '继续检查已提取页面' : '开始提取页面';
  batchZipBtn.hidden = selectedFiles.length < 2;
  $<HTMLElement>('#batchPlanHint').hidden = selectedFiles.length < 2 || limits.batch_processing;
  downloadFramesZipBtn.hidden = selectedFiles.every((file) => !getState(file).slides.length);
  batchZipBtn.disabled = selectedFiles.length === 0 || busy || !limits.batch_processing;
  batchZipBtn.title = limits.batch_processing ? '' : '批量处理属于专业版和终身版权益';
  downloadFramesZipBtn.disabled = busy || selectedFiles.every((file) => getState(file).slides.length === 0);
  imagePptBtn.disabled = selectedImageFiles.length === 0 || busy || !limits.image_pptx;
  imageWorkspaceBtn.disabled = selectedImageFiles.length === 0 || busy || !limits.image_pptx;
  notebookMaskPdfBtn.disabled = !selectedNotebookPdfFile || busy;
  transcribeBtn.disabled = !hasVideoFile || busy || imageMode;
  downloadPdfBtn.disabled = selectedCount === 0 || busy;
  downloadPptxBtn.disabled = selectedCount === 0 || busy;
  dockDownloadPdfBtn.disabled = selectedCount === 0 || busy;
  dockDownloadPptxBtn.disabled = selectedCount === 0 || busy;
  dockDownloadFramesBtn.disabled = selectedCount === 0 || busy;
  dockNotesBtn.disabled = !hasVideoFile || slides.length === 0 || busy || !authSession;
  dockNotesBtn.textContent = illustratedNotesMarkdown.trim() ? '查看图文笔记' : '生成图文笔记';
  sideDownloadPdfBtn.disabled = selectedCount === 0 || busy;
  sideDownloadPptxBtn.disabled = selectedCount === 0 || busy;
  sideDownloadFramesBtn.disabled = selectedCount === 0 || busy;
  downloadTranscriptBtn.disabled = !transcriptEl.value.trim() || isTranscribing || imageMode;
  summarizeBtn.disabled = !transcriptEl.value.trim() || busy || imageMode || !authSession;
  downloadSummaryBtn.disabled = !summaryEl.value.trim() || isSummarizing || imageMode;
  generateNotesBtn.disabled = !hasVideoFile || slides.length === 0 || busy || !authSession;
  generateNotesBtn.textContent = illustratedNotesMarkdown.trim() ? '查看图文笔记' : '生成图文笔记';
  videoInput.disabled = busy;
  videoUrlInput.disabled = busy;
  downloadUrlBtn.disabled = busy || waitingForMediaRights;
  processUrlBtn.disabled = busy || waitingForMediaRights;
  workspaceVideoUrlInput.disabled = busy;
  workspaceRightsConfirm.disabled = busy;
  workspaceDownloadUrlBtn.disabled = busy;
  workspaceProcessUrlBtn.disabled = busy;
  workspaceVideoInput.disabled = busy;
  workspaceRecordScreenBtn.disabled = busy || !limits.screen_recording;
  workspaceStopRecordBtn.hidden = !isRecording;
  imageInput.disabled = busy;
  notebookPdfInput.disabled = busy;
  recordScreenBtn.disabled = busy || !limits.screen_recording;
  stopRecordBtn.hidden = !isRecording;
  stopRecordBtn.textContent = recordingCompletionMode === 'extract' ? '停止录制并直接生成' : '停止录制并加入队列';
  updateSelectionUI();
}

function updateWorkspaceEmptyState(): void {
  const hasSlides = slides.length > 0;
  const audioSource = isAudioSource(selectedFile);
  workspaceView.classList.toggle('audio-mode', audioSource);
  const busy = isUrlDownloading || isExtracting || isBatchProcessing || isRecording;
  workspaceEmptyState.hidden = hasSlides;
  $<HTMLElement>('#reviewToolbar').hidden = !hasSlides;
  if (busy) $<HTMLElement>('#workspaceImport').hidden = true;
  else if (!hasSlides) $<HTMLElement>('#workspaceImport').hidden = false;
  $<HTMLElement>('#toggleImportBtn').setAttribute('aria-expanded', String(!$<HTMLElement>('#workspaceImport').hidden));
  document.querySelectorAll<HTMLElement>('[data-step]').forEach((step) => {
    const current = busy ? 'extract' : hasSlides ? 'review' : 'source';
    if (step.dataset.step === current) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  });
  workspaceView.classList.toggle('has-timeline', !captureTimeline.hidden);
  workspaceSubtitle.textContent = selectedFile ? selectedFile.name : '选择来源开始转换';
  slidesEl.hidden = !hasSlides;
  workspaceEmptyState.classList.toggle('is-busy', busy);
  emptyWorkspaceStartBtn.disabled = isBusy();

  if (hasSlides) {
    emptyWorkspaceStartBtn.textContent = '继续导入';
    return;
  }

  if (isUrlDownloading) {
    workspaceEmptyTitle.textContent = '正在获取视频';
    workspaceEmptyBody.textContent = '下载完成后会自动进入页面生成，左侧会显示处理进度；完成后页面会出现在这里。';
    emptyWorkspaceStartBtn.textContent = '正在获取视频';
    emptyWorkspaceStartBtn.disabled = true;
    return;
  }

  if (isExtracting || isBatchProcessing) {
    workspaceEmptyTitle.textContent = '正在生成页面';
    workspaceEmptyBody.textContent = '关键页面会陆续加载出来，完成后可直接勾选、预览和导出。';
    emptyWorkspaceStartBtn.textContent = '生成中';
    emptyWorkspaceStartBtn.disabled = true;
    return;
  }

  if (isRecording) {
    workspaceEmptyTitle.textContent = '正在录制屏幕';
    workspaceEmptyBody.textContent = '录制完成后会自动进入页面生成流程，页面会显示在这里。';
    emptyWorkspaceStartBtn.textContent = '录制中';
    emptyWorkspaceStartBtn.disabled = true;
    return;
  }

  if (audioSource) {
    workspaceEmptyTitle.textContent = '把音频整理成文字';
    workspaceEmptyBody.textContent = '音频没有视频页面。点击“编辑与笔记”，展开“逐字稿与笔记”开始转写；完成后可下载逐字稿。';
    emptyWorkspaceStartBtn.textContent = '打开音频转写';
    return;
  }

  if (selectedFile && workspaceMode === 'video') {
    workspaceEmptyTitle.textContent = '当前视频还没有生成页面';
    workspaceEmptyBody.textContent = `已选择 ${selectedFile.name}。点击上方“开始当前任务”，自动提取页面后再检查与导出。`;
    emptyWorkspaceStartBtn.textContent = '开始当前任务';
    emptyWorkspaceStartBtn.disabled = false;
    return;
  }

  if (workspaceMode === 'image' && selectedImageFiles.length > 0) {
    workspaceEmptyTitle.textContent = '图片工作台还没有页面';
    workspaceEmptyBody.textContent = '选择图片后进入编辑模式，图片页和可编辑文本框会显示在这里。';
    emptyWorkspaceStartBtn.textContent = '返回图片上传';
    emptyWorkspaceStartBtn.disabled = false;
    return;
  }

  workspaceEmptyTitle.textContent = '工作台还没有任务';
  workspaceEmptyBody.textContent = '在顶部横向输入框粘贴 B 站或 YouTube 链接，也可以上传视频或录制屏幕。处理后生成进度和可导出的页面会出现在这里。';
  emptyWorkspaceStartBtn.textContent = '选择本地视频';
  emptyWorkspaceStartBtn.disabled = false;
}

function updateSelectionUI(): void {
  const selectedCount = slides.filter((slide) => slide.selected).length;
  selectCount.textContent = `${selectedCount}/${slides.length}`;
  exportHint.textContent = slides.length > 0
    ? `已选 ${selectedCount} / ${slides.length} 张。默认全选；取消勾选可排除页面。`
    : '生成完成后，也可以从这里下载选中页面。';
  selectAllBox.checked = slides.length > 0 && selectedCount === slides.length;
  selectAllBox.indeterminate = selectedCount > 0 && selectedCount < slides.length;
  updateResultDock(selectedCount);
  updateWorkspaceEmptyState();
  updateTextBoxPanel();
}

function updateResultDock(selectedCount: number): void {
  const busy = isBusy();
  const hasSlides = slides.length > 0;
  resultDock.classList.toggle('is-ready', hasSlides && selectedCount > 0 && !busy);
  resultDock.classList.toggle('is-empty', !hasSlides);
  resultDock.classList.toggle('is-busy', busy);

  if (busy) {
    resultBadge.textContent = '正在处理';
    resultTitle.textContent = isExporting ? '正在生成导出文件' : isGeneratingNotes
      ? '正在生成图文笔记'
      : isSummarizing
        ? '正在生成摘要'
        : isTranscribing
          ? '正在生成逐字稿'
          : hasSlides ? `已生成 ${slides.length} 页，继续处理中` : '正在生成页面';
    resultSubtitle.textContent = isGeneratingNotes
      ? `正在整理为${OUTPUT_LANGUAGE_LABELS[userPreferences.outputLanguage]}并匹配关键页面。`
      : '处理完成后可检查页面，并选择格式导出。';
    return;
  }

  if (!hasSlides) {
    resultBadge.textContent = selectedFile ? '等待处理' : '工作台';
    resultTitle.textContent = selectedFile ? '等待生成页面' : '还没有任务';
    resultSubtitle.textContent = selectedFile
      ? '点击开始生成后，进度和下载入口会固定显示在这里。'
      : '先粘贴链接、上传视频或录制屏幕，处理后这里会出现页面和导出按钮。';
    return;
  }

  if (selectedCount === 0) {
    resultBadge.textContent = '需要选择';
    resultTitle.textContent = `已生成 ${slides.length} 页`;
    resultSubtitle.textContent = '请至少勾选 1 页，之后即可下载 PDF、PPTX 或页面图片。';
    return;
  }

  resultBadge.textContent = '可以导出';
  resultTitle.textContent = `已生成 ${slides.length} 页，已选 ${selectedCount} 页`;
  resultSubtitle.textContent = isDemoProject ? '交互示例 · 不计额度 · 可体验勾选、排序、裁剪与导出' : 'PPTX 保留原画面；需要可编辑文字，可在“编辑与笔记”中识别。';
}

function setAllSlidesSelected(selected: boolean): void {
  slides.forEach((slide) => { slide.selected = selected; });
  slidesEl.querySelectorAll<HTMLInputElement>('.frame-checkbox').forEach((box) => { box.checked = selected; });
  persistWorkspaceToState({ markProcessed: slides.length > 0 });
  renderFileList();
  updateActionState();
}

function isAudioSource(file: File | null): boolean {
  return !!file && (file.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i.test(file.name));
}

function getDefaultNewSlideSelected(): boolean { return true; }

async function startScreenRecording(mode: UrlDownloadMode = 'queue'): Promise<void> {
  if (isBusy()) return;
  if (!navigator.mediaDevices?.getDisplayMedia || typeof MediaRecorder === 'undefined') {
    setStatus('当前浏览器不支持屏幕录制。请改用本地视频。');
    setHomeStatus('当前浏览器不支持屏幕录制。请使用最新版 Chrome / Edge / Safari。');
    return;
  }
  isPreparingRecording = true;
  updateActionState();
  setStatus('请选择要录制的标签页、窗口或屏幕。');
  try {
    recordedChunks = [];
    recordingCompletionMode = mode;
    currentRecordingMimeType = getSupportedRecordingMimeType();
    recordingStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    mediaRecorder = new MediaRecorder(recordingStream, currentRecordingMimeType ? { mimeType: currentRecordingMimeType } : undefined);
    mediaRecorder.ondataavailable = (event) => { if (event.data.size > 0) recordedChunks.push(event.data); };
    mediaRecorder.onstop = () => finishScreenRecording();
    recordingStream.getTracks().forEach((track) => {
      track.onended = () => { if (mediaRecorder?.state === 'recording') mediaRecorder.stop(); };
    });
    mediaRecorder.start(1000);
    isRecording = true;
    setStatus('正在录制屏幕，停止后会继续处理。');
    setHomeStatus(mode === 'extract' ? '正在录制屏幕。完成后点击“停止录制并直接生成”。' : '正在录制屏幕。完成后点击“停止录制并加入队列”。');
  } catch (error) {
    console.error(error);
    cleanupRecording();
    const message = error instanceof DOMException && error.name === 'NotAllowedError' ? '已取消录屏。可以重新选择屏幕，或改用本地视频。' : '录屏未能开始，请重试或选择本地视频。';
    setHomeStatus(message);
    setStatus(message);
  } finally {
    isPreparingRecording = false;
    updateActionState();
  }
}

function stopScreenRecording(): void {
  if (mediaRecorder?.state === 'recording') {
    mediaRecorder.requestData();
    mediaRecorder.stop();
  } else {
    finishScreenRecording();
  }
}

function finishScreenRecording(): void {
  const chunks = recordedChunks.slice();
  const completionMode = recordingCompletionMode;
  cleanupRecording();
  if (chunks.length === 0) {
    setHomeStatus('录制结束，但没有生成有效视频。');
    updateActionState();
    return;
  }
  const mimeType = currentRecordingMimeType || chunks[0]?.type || 'video/webm';
  const blob = new Blob(chunks, { type: mimeType });
  const extension = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const file = new File([blob], `screen-recording-${timestampForFilename()}.${extension}`, { type: mimeType });
  addFiles([file], true);
  setHomeStatus(completionMode === 'extract' ? `录制完成，正在处理：${file.name}` : `录制完成，已加入队列并切换到：${file.name}`);
  updateActionState();
  if (completionMode === 'extract') void processCurrentFile();
}

function cleanupRecording(): void {
  recordingStream?.getTracks().forEach((track) => track.stop());
  recordingStream = null;
  mediaRecorder = null;
  recordedChunks = [];
  isRecording = false;
  recordingCompletionMode = 'queue';
}

function getSupportedRecordingMimeType(): string {
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

function appendTranscript(line: string): void {
  transcriptEl.value = `${transcriptEl.value}${transcriptEl.value ? '\n' : ''}${line}`;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  persistWorkspaceToState({ markProcessed: slides.length > 0 });
  updateActionState();
}

function rms(audio: Float32Array): number { let sum = 0; for (const value of audio) sum += value * value; return Math.sqrt(sum / Math.max(audio.length, 1)); }
function cleanTranscriptText(text: string): string { return text.replace(/([\s\S]{2,24})\1{2,}/g, '$1').replace(/\s+/g, ' ').trim(); }
function isNearDuplicate(current: string, previous: string): boolean {
  if (!current || !previous) return false;
  if (current === previous) return true;
  if (current.length > 12 && previous.includes(current)) return true;
  if (previous.length > 12 && current.includes(previous)) return true;
  return false;
}

async function summarizeWithApi(
  transcript: string,
  mode: 'summary' | 'illustrated_notes' = 'summary',
  sourceTitle = ''
): Promise<string> {
  const token = authSession?.token;
  if (!token) throw new Error('请先注册或登录账号，再生成内容。');
  const response = await fetch(SUMMARY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      transcript,
      mode,
      language: userPreferences.outputLanguage,
      source_title: sourceTitle
    })
  });
  const data = await response.json().catch(() => ({})) as { detail?: string; summary?: string; usage?: UsageSummary };
  if (!response.ok) throw new Error(data.detail || `内容生成失败：${response.status}`);
  if (data.usage && authSession) {
    usageSummary = normalizeUsageSummary(data.usage, authSession.user.email);
    renderEntitlementSummary();
  }
  return data.summary ?? '';
}

function openIllustratedNotes(): void {
  if (!illustratedNotesMarkdown.trim()) {
    setStatus('还没有图文笔记，点击“生成图文笔记”开始。');
    return;
  }
  renderIllustratedNotes();
  if (typeof notesDialog.showModal === 'function') notesDialog.showModal();
  else notesDialog.setAttribute('open', '');
}

function renderIllustratedNotes(): void {
  illustratedNotesPreview.innerHTML = '';
  notesLanguageLabel.textContent = OUTPUT_LANGUAGE_LABELS[userPreferences.outputLanguage];
  const lines = illustratedNotesMarkdown.replace(/\r\n?/g, '\n').split('\n');
  const sectionCount = lines.filter((line) => /^##\s+/.test(line.trim())).length;
  const illustrations = selectNoteIllustrations(Math.min(8, Math.max(1, sectionCount + 1)));
  let illustrationIndex = 0;
  let currentList: HTMLUListElement | HTMLOListElement | null = null;
  let sawTitle = false;

  const appendIllustration = () => {
    const slide = illustrations[illustrationIndex];
    if (!slide) return;
    illustratedNotesPreview.appendChild(createNoteFigure(slide, illustrationIndex + 1));
    illustrationIndex += 1;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      currentList = null;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      currentList = null;
      const level = heading[1].length;
      const element = document.createElement(level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3');
      appendMarkdownInline(element, heading[2]);
      illustratedNotesPreview.appendChild(element);
      if (level === 1) {
        sawTitle = true;
        appendIllustration();
      } else if (level === 2) {
        appendIllustration();
      }
      continue;
    }

    const unorderedItem = line.match(/^[-*]\s+(.+)$/);
    const orderedItem = line.match(/^\d+[.)]\s+(.+)$/);
    if (unorderedItem || orderedItem) {
      const listTag = orderedItem ? 'OL' : 'UL';
      if (!currentList || currentList.tagName !== listTag) {
        currentList = document.createElement(orderedItem ? 'ol' : 'ul');
        illustratedNotesPreview.appendChild(currentList);
      }
      const item = document.createElement('li');
      appendMarkdownInline(item, (orderedItem ?? unorderedItem)?.[1] ?? line);
      currentList.appendChild(item);
      continue;
    }

    currentList = null;
    const element = document.createElement(line.startsWith('> ') ? 'blockquote' : 'p');
    appendMarkdownInline(element, line.replace(/^>\s*/, ''));
    illustratedNotesPreview.appendChild(element);
  }

  if (!sawTitle) {
    const title = document.createElement('h1');
    title.textContent = selectedFile ? `${baseName(selectedFile.name)} · 图文笔记` : '图文笔记';
    illustratedNotesPreview.prepend(title);
    if (illustrationIndex === 0 && illustrations[0]) title.after(createNoteFigure(illustrations[0], 1));
  }
}

function appendMarkdownInline(element: HTMLElement, text: string): void {
  const matcher = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let cursor = 0;
  for (const match of text.matchAll(matcher)) {
    const index = match.index ?? 0;
    if (index > cursor) element.append(document.createTextNode(text.slice(cursor, index)));
    const token = match[0];
    const child = document.createElement(token.startsWith('**') ? 'strong' : 'code');
    child.textContent = token.startsWith('**') ? token.slice(2, -2) : token.slice(1, -1);
    element.append(child);
    cursor = index + token.length;
  }
  if (cursor < text.length) element.append(document.createTextNode(text.slice(cursor)));
}

function selectNoteIllustrations(maxCount: number): Slide[] {
  const selected = slides.filter((slide) => slide.selected);
  const pool = selected.length > 0 ? selected : slides;
  if (pool.length <= maxCount) return pool.slice();
  const result: Slide[] = [];
  for (let index = 0; index < maxCount; index += 1) {
    const poolIndex = Math.round((index * (pool.length - 1)) / Math.max(1, maxCount - 1));
    const slide = pool[poolIndex];
    if (slide && !result.some((item) => item.id === slide.id)) result.push(slide);
  }
  return result;
}

function createNoteFigure(slide: Slide, index: number): HTMLElement {
  const figure = document.createElement('figure');
  figure.className = 'note-figure';
  const image = document.createElement('img');
  image.src = slide.dataUrl;
  image.alt = `视频关键页面 ${index}`;
  const caption = document.createElement('figcaption');
  caption.textContent = `视频关键页面 ${index} · ${formatTime(slide.time)}`;
  figure.append(image, caption);
  return figure;
}

function illustratedNotesDocument(): string {
  const title = illustratedNotesMarkdown.match(/^#\s+(.+)$/m)?.[1]?.trim()
    || (selectedFile ? `${baseName(selectedFile.name)} · 图文笔记` : '图文笔记');
  return `<!doctype html>
<html lang="${escapeXml(userPreferences.outputLanguage)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeXml(title)}</title>
  <style>
    :root{font-family:Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#172033;background:#eef2f7}
    *{box-sizing:border-box}body{margin:0;padding:40px 18px}main{width:min(860px,100%);margin:auto;padding:54px 64px;background:#fff;box-shadow:0 18px 60px rgba(15,23,42,.12)}
    h1{margin:0 0 24px;font-size:42px;line-height:1.15}h2{margin:42px 0 14px;padding-top:20px;border-top:1px solid #dbe3ef;font-size:27px}h3{margin:28px 0 10px;font-size:21px}
    p,li,blockquote{font-size:17px;line-height:1.85}p{margin:12px 0}li{margin:7px 0}blockquote{margin:18px 0;padding:12px 18px;border-left:4px solid #2563eb;background:#eff6ff}
    figure{margin:24px 0 32px;background:#f8fafc;border:1px solid #dbe3ef}figure img{display:block;width:100%;height:auto}figcaption{padding:10px 14px;color:#64748b;font-size:13px;font-weight:700}
    code{padding:2px 5px;background:#f1f5f9}@media(max-width:640px){body{padding:0}main{padding:28px 20px}h1{font-size:32px}}
    @media print{body{padding:0;background:#fff}main{width:100%;padding:0;box-shadow:none}figure{break-inside:avoid}h2{break-after:avoid}}
  </style>
</head>
<body><main>${illustratedNotesPreview.innerHTML}</main></body>
</html>`;
}

function downloadIllustratedNotesHtml(): void {
  if (!illustratedNotesMarkdown.trim()) return;
  renderIllustratedNotes();
  const filename = `${selectedFile ? baseName(selectedFile.name) : 'vid2ppt'}-illustrated-notes.html`;
  downloadBlob(new Blob([illustratedNotesDocument()], { type: 'text/html;charset=utf-8' }), filename);
}

function printIllustratedNotes(): void {
  if (!illustratedNotesMarkdown.trim()) return;
  renderIllustratedNotes();
  const frame = document.createElement('iframe');
  frame.hidden = true;
  document.body.appendChild(frame);
  const documentRef = frame.contentDocument;
  if (!documentRef) {
    frame.remove();
    setStatus('无法打开打印视图，请下载 HTML 后打印。');
    return;
  }
  documentRef.open();
  documentRef.write(illustratedNotesDocument());
  documentRef.close();
  window.setTimeout(() => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    window.setTimeout(() => frame.remove(), 1200);
  }, 400);
}

function readSettings(): Settings {
  const value = (id: string, fallback: number, min: number, max: number) => {
    const raw = $<HTMLInputElement>(id).value;
    const number = raw.trim() ? Number(raw) : fallback;
    return Number.isFinite(number) ? clamp(number, min, max) : fallback;
  };
  return { sampleEvery: value('#sampleEvery', 1, 0.5, 60), duplicateThreshold: value('#duplicateThreshold', 4, 1, 20), minGap: value('#minGap', 3, 0, 120) };
}

function setProgress(label: string, percent?: number, indeterminate = false): void {
  progressPanel.hidden = false;
  progressText.textContent = label;
  progressFill.classList.toggle('is-indeterminate', indeterminate);
  if (typeof percent === 'number' && Number.isFinite(percent)) {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    progressFill.style.width = `${clamped}%`;
    progressPercent.textContent = indeterminate ? `${clamped}% · 处理中` : `${clamped}%`;
    progressTrack.setAttribute('aria-valuenow', String(clamped));
    progressTrack.setAttribute('aria-valuetext', `${label}，${clamped}%`);
  } else {
    progressFill.style.width = '100%';
    progressPercent.textContent = '处理中';
    progressTrack.removeAttribute('aria-valuenow');
    progressTrack.setAttribute('aria-valuetext', `${label}，处理中`);
  }
}

function hideProgress(): void {
  progressPanel.hidden = true;
  progressFill.classList.remove('is-indeterminate');
  progressFill.style.width = '0%';
  progressText.textContent = '准备开始';
  progressPercent.textContent = '0%';
}

function setStatus(message: string): void { statusEl.textContent = message; }
function setHomeStatus(message: string): void { homeStatus.textContent = message; }
function setImageStatus(message: string): void { imageStatus.textContent = message; }
function setNotebookPdfStatus(message: string): void { notebookPdfStatus.textContent = message; }

function waitForEvent(target: EventTarget, eventName: string, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { cleanup(); reject(new Error(`等待 ${eventName} 超时。`)); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); target.removeEventListener(eventName, onSuccess); target.removeEventListener('error', onError); };
    const onSuccess = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('视频读取失败。浏览器可能不支持该编码。')); };
    target.addEventListener(eventName, onSuccess, { once: true });
    target.addEventListener('error', onError, { once: true });
  });
}

function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (Math.abs(video.currentTime - time) < 0.015) {
      requestAnimationFrame(() => resolve());
      return;
    }
    let settled = false;
    const cleanup = () => { clearTimeout(timer); video.removeEventListener('seeked', onSeeked); video.removeEventListener('error', onError); };
    const finish = () => { if (settled) return; settled = true; cleanup(); resolve(); };
    const onSeeked = () => finish();
    const onError = () => { if (settled) return; settled = true; cleanup(); reject(new Error('视频 seek 失败。')); };
    const timer = window.setTimeout(() => finish(), 2200);
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.currentTime = time;
  });
}

function waitForVideoFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    const withCallback = video as HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number };
    if (typeof withCallback.requestVideoFrameCallback === 'function') {
      const timer = window.setTimeout(() => resolve(), 160);
      withCallback.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(); });
    } else {
      requestAnimationFrame(() => resolve());
    }
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败。'));
    img.src = src;
  });
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function isSupportedMediaFile(file: File): boolean {
  return file.type.startsWith('video/') || file.type.startsWith('audio/') || /\.(mkv|mov|mp4|webm|avi|m4v)$/i.test(file.name);
}
function isSupportedImageFile(file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(file.name);
}
function isSupportedPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}
function fileKey(file: File): string { return `${file.name}:${file.size}:${file.lastModified}`; }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
function baseName(filename: string): string { return filename.replace(/\.[^/.]+$/, '').replace(/[^\p{L}\p{N}._-]+/gu, '_') || 'vid2deck'; }
function timestampForFilename(): string { return new Date().toISOString().replace(/[:.]/g, '-'); }
function formatTime(seconds: number): string { return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`; }
function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600).toString().padStart(2, '0');
  const minutes = Math.floor((total % 3600) / 60).toString().padStart(2, '0');
  const secs = (total % 60).toString().padStart(2, '0');
  return `${hours}:${minutes}:${secs}`;
}
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
function yieldToBrowser(): Promise<void> { return new Promise((resolve) => setTimeout(resolve, 0)); }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

function snapshotWorkspace(): FileJobState {
  return { slides: cloneSlides(slides), transcript: transcriptEl.value, summary: summaryEl.value,
    illustratedNotes: illustratedNotesMarkdown, videoMeta: videoMeta ? { ...videoMeta } : null,
    status: slides.length ? 'done' : 'queued', processedAt: new Date().toISOString() };
}

function rememberSlideEdit(): void {
  undoSnapshot = { slides: cloneSlides(slides), activeSlideId, file: selectedFile };
}

function scheduleDraftSave(): void {
  if (isDemoProject || !selectedFile || (!slides.length && !transcriptEl.value.trim())) return;
  draftRevision += 1;
  const revision = draftRevision;
  const draft: WorkspaceDraft = { version: 1, file: selectedFile, state: snapshotWorkspace(), mode: workspaceMode, savedAt: new Date().toISOString() };
  $<HTMLElement>('#draftStatus').textContent = '正在保存当前任务到本机…';
  window.clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => {
    draftWrites = draftWrites.catch(() => {}).then(() => writeDraft(draft)).then(() => {
      savedDraftRevision = revision;
      if (revision === draftRevision) $<HTMLElement>('#draftStatus').textContent = '当前任务已保存到此浏览器 · 关闭后可继续';
    }).catch(() => {
      $<HTMLElement>('#draftStatus').textContent = '本机保存暂不可用，请在离开前导出结果。';
    });
  }, 650);
}

async function discoverDraft(): Promise<void> {
  try {
    const draft = await readDraft<WorkspaceDraft>();
    if (!draft || draft.version !== 1 || !(draft.file instanceof File) || !Array.isArray(draft.state?.slides)) return;
    savedDraft = draft;
    $<HTMLElement>('#resumeDraftText').textContent = `继续上次：${draft.file.name} · ${draft.state.slides.length} 页`;
    $<HTMLElement>('#resumeDraftBanner').hidden = false;
  } catch { /* Local conversion remains usable when storage is unavailable. */ }
}

function setSourceTab(source: string, focus = false): void {
  const panels: Record<string, string> = { local: '#sourceLocal', url: '#sourceUrl', record: '#sourceRecord' };
  document.querySelectorAll<HTMLButtonElement>('[data-source]').forEach((button) => {
    const selected = button.dataset.source === source;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected && focus) button.focus();
  });
  Object.entries(panels).forEach(([key, selector]) => { $<HTMLElement>(selector).hidden = key !== source; });
  extractBtn.hidden = source !== 'local' && !selectedFiles.length;
  setHomeStatus(source === 'local' ? '文件留在本机。选择后即可开始提取。' : source === 'url' ? '在线链接由服务端临时获取。导入失败时可改用本地文件或录屏。' : '录屏在本机处理，停止后自动提取页面。');
}

document.querySelectorAll<HTMLButtonElement>('[data-source]').forEach((button, index, buttons) => {
  button.addEventListener('click', () => setSourceTab(button.dataset.source ?? 'local'));
  button.addEventListener('keydown', (event) => {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % buttons.length;
    else if (event.key === 'ArrowLeft') next = (index + buttons.length - 1) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else return;
    event.preventDefault();
    setSourceTab(buttons[next].dataset.source ?? 'local', true);
  });
});

$<HTMLButtonElement>('#toggleImportBtn').addEventListener('click', () => {
  const panel = $<HTMLElement>('#workspaceImport');
  panel.hidden = !panel.hidden;
  $<HTMLElement>('#toggleImportBtn').setAttribute('aria-expanded', String(!panel.hidden));
});
$<HTMLButtonElement>('#cancelExtractionBtn').addEventListener('click', () => {
  extractionAbort?.abort();
  setStatus('正在停止，已完成的页面会保留。');
});
$<HTMLButtonElement>('#notesLoginBtn').addEventListener('click', focusLoginPanel);
$<HTMLButtonElement>('#selectAllReviewBtn').addEventListener('click', () => setAllSlidesSelected(true));
$<HTMLButtonElement>('#reextractBtn').addEventListener('click', () => { $<HTMLElement>('#reextractPanel').hidden = false; });
$<HTMLButtonElement>('#cancelReextractBtn').addEventListener('click', () => { $<HTMLElement>('#reextractPanel').hidden = true; });
$<HTMLButtonElement>('#confirmReextractBtn').addEventListener('click', () => {
  $<HTMLElement>('#reextractPanel').hidden = true;
  void processCurrentFile();
});
$<HTMLButtonElement>('#undoEditBtn').addEventListener('click', () => {
  if (!undoSnapshot || undoSnapshot.file !== selectedFile || isBusy()) return;
  slides = cloneSlides(undoSnapshot.slides);
  activeSlideId = undoSnapshot.activeSlideId;
  activeTextBoxId = null;
  undoSnapshot = null;
  renderSlides();
  const active = getActiveSlide();
  if (active) setPreview(active);
  persistWorkspaceToState();
  setStatus('已撤销上一次页面操作，页面与顺序已恢复。');
});
$<HTMLButtonElement>('#dismissDraftBtn').addEventListener('click', () => { $<HTMLElement>('#resumeDraftBanner').hidden = true; });
$<HTMLButtonElement>('#resumeDraftBtn').addEventListener('click', () => {
  if (!savedDraft || isBusy()) return;
  if (isDemoProject) restoreWorkspaceAfterDemo();
  persistWorkspaceToState();
  const draft = savedDraft;
  selectedFile = draft.file;
  if (draft.mode === 'video') {
    const existing = selectedFiles.findIndex((file) => fileKey(file) === fileKey(draft.file));
    if (existing < 0) selectedFiles.push(draft.file);
    currentFileIndex = existing >= 0 ? existing : selectedFiles.length - 1;
  } else currentFileIndex = -1;
  setStateForFile(draft.file, draft.state);
  loadStateIntoWorkspace(draft.file);
  setWorkspaceMode(draft.mode);
  $<HTMLElement>('#resumeDraftBanner').hidden = true;
  $<HTMLElement>('#workspaceImport').hidden = true;
  showWorkspace();
  renderFileList();
  updateActionState();
  setStatus('已恢复上次的页面、排序与文字，可继续编辑或导出。');
  $<HTMLElement>('#draftStatus').textContent = '已恢复此浏览器保存的任务';
  scheduleDraftSave();
});
window.addEventListener('beforeunload', (event) => {
  if ((!isDemoProject && isBusy()) || draftRevision > savedDraftRevision) {
    event.preventDefault();
    event.returnValue = '';
  }
});
// Dropping a file outside a picker should not navigate away and discard the task.
window.addEventListener('dragover', (event) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
window.addEventListener('drop', (event) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
workspaceView.classList.add('side-collapsed');
void discoverDraft();
