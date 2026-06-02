import { jsPDF } from 'jspdf';
import JSZip from 'jszip';
import './style.css';

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

type Settings = {
  sampleEvery: number;
  duplicateThreshold: number;
  minGap: number;
  summaryApiUrl: string;
  authCode: string;
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

type FileJobState = {
  slides: Slide[];
  transcript: string;
  summary: string;
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

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app');

app.innerHTML = `
  <main id="homeView">
    <section class="hero">
      <div>
        <p class="eyebrow">Vid2PPT Deck</p>
        <h1>视频和图片一键生成去重版PPT、PDF、逐字稿与Summary</h1>
        <p class="subhead">支持批量上传视频、图片或直接录制屏幕。单个视频可进入工作台精修；图片可本地生成 PPTX；批量上传后，一键抽帧即可下载所有帧图片压缩包（Frames ZIP）。</p>
      </div>
    </section>

    <section class="panel image-ppt-panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Image to PPT</p>
          <h2>图片本地生成可编辑 PPTX</h2>
        </div>
        <span>本地渲染 · 适合普通 MacBook Air</span>
      </div>

      <label class="dropzone image-dropzone" id="imageDropzone" for="imageInput">
        <input id="imageInput" type="file" multiple accept="image/png,image/jpeg,image/webp" />
        <span id="imageFileLabel">选择或拖入一组图片页</span>
        <small>每张图片生成一页 PPT；进入编辑模式后可添加真实文本框，再导出可编辑 PPTX。</small>
      </label>

      <div id="imageFileList" class="file-list image-file-list" hidden></div>

      <div class="actions">
        <button id="imagePptBtn" disabled>快速生成图片版 PPTX</button>
        <button id="imageWorkspaceBtn" disabled>编辑图片为可编辑 PPTX</button>
      </div>

      <div class="status" id="imageStatus">等待上传图片。</div>
    </section>

    <section class="panel">
      <label class="dropzone" id="dropzone" for="videoInput">
        <input id="videoInput" type="file" multiple accept="video/*,audio/*,.mkv,.mov,.mp4,.webm,.avi,.m4v" />
        <span id="fileLabel">选择或拖入一个或多个视频文件</span>
        <small>可以一次选择多个文件，也可以多次追加。视频处理在浏览器本地完成。</small>
      </label>

      <div class="source-actions">
        <button id="recordScreenBtn" type="button">录制屏幕</button>
        <button id="stopRecordBtn" type="button" class="danger-btn" hidden>停止录制并加入队列</button>
      </div>

      <div id="fileList" class="file-list" hidden></div>

      <div class="grid">
        <label>抽帧间隔（秒）<input id="sampleEvery" type="number" min="0.5" step="0.5" value="1" /></label>
        <label>去重阈值（越大越容易合并）<input id="duplicateThreshold" type="number" min="1" max="20" step="0.5" value="4" /></label>
        <label>同页合并窗口（秒）<input id="minGap" type="number" min="0" step="0.5" value="3" /></label>
        <label>Summary API URL<input id="summaryApiUrl" type="url" value="https://vid2deck.vercel.app/api/summarize-simple" /></label>
        <label>访问码<input id="authCode" type="password" placeholder="填 Vercel 的 AUTH_CODE" autocomplete="current-password" /></label>
      </div>

      <div class="hint">单文件：点击“处理当前视频”进入工作台，支持勾选、裁剪、删除、补抓帧，最后下载 PDF。多文件：点击“批量抽帧并下载 ZIP”，自动逐个处理全部视频，仅打包输出抽帧图片（不含转写与 Summary）。</div>

      <div class="actions">
        <button id="extractBtn" disabled>处理当前视频</button>
        <button id="batchZipBtn" disabled>批量抽帧并下载 ZIP</button>
        <button id="downloadFramesZipBtn" disabled>下载已处理 Frames ZIP</button>
      </div>

      <div class="status" id="homeStatus">等待上传视频。</div>
    </section>
  </main>

  <main id="workspaceView" class="workspace" hidden>
    <header class="workspace-bar">
      <button id="doneBtn" class="ghost-btn">回主页</button>
      <button id="toggleSideBtn" class="ghost-btn" title="收起/展开左侧面板">⇤ 收起左栏</button>
      <label class="select-all-control">
        <input id="selectAllBox" type="checkbox" checked />
        <span>全选</span>
        <small id="selectCount">0/0</small>
      </label>
      <div class="workspace-spacer"></div>
      <button id="downloadPdfBtn" disabled>导出 PDF</button>
      <button id="downloadPptxBtn" disabled>导出 PPTX</button>
    </header>

    <section class="result-dock" id="resultDock" aria-live="polite">
      <div class="result-summary">
        <span id="resultBadge" class="result-badge">等待处理</span>
        <div>
          <strong id="resultTitle">等待生成页面</strong>
          <small id="resultSubtitle">上传并处理视频后，下载入口会固定显示在这里。</small>
        </div>
      </div>
      <div class="result-actions">
        <button id="dockDownloadPdfBtn" class="primary-download" disabled>立即下载 PDF</button>
        <button id="dockDownloadPptxBtn" disabled>导出 PPTX</button>
        <button id="dockDownloadFramesBtn" disabled>导出 Frames ZIP</button>
      </div>
    </section>

    <section class="workspace-body">
      <aside class="workspace-side">
        <div class="preview-card">
          <img id="previewImage" alt="当前 frame 预览" />
          <div id="previewEmpty" class="preview-empty">抽帧后会在这里预览当前 frame</div>
        </div>

        <div class="progress-panel" id="progressPanel" hidden>
          <div class="progress-meta"><span id="progressText">准备开始</span><strong id="progressPercent">0%</strong></div>
          <div class="progress-track" aria-label="处理进度"><div class="progress-fill" id="progressFill"></div></div>
        </div>

        <div class="status" id="status">等待抽帧。</div>

        <section class="export-panel" aria-label="导出选中页面">
          <div>
            <strong>备用导出</strong>
            <small id="exportHint">抽帧完成后，也可以从这里下载选中页面。</small>
          </div>
          <div class="export-actions">
            <button id="sideDownloadPdfBtn" disabled>下载 PDF</button>
            <button id="sideDownloadPptxBtn" disabled>下载 PPTX</button>
            <button id="sideDownloadFramesBtn" disabled>下载 Frames ZIP</button>
          </div>
        </section>

        <section class="text-layer-panel" aria-label="可编辑文本框">
          <div class="text-layer-heading">
            <div>
              <strong>可编辑文本框</strong>
              <small id="textLayerHint">选择一页后添加文本框；导出 PPTX 时会变成真实 PowerPoint 文本对象。</small>
            </div>
            <button id="addTextBoxBtn" type="button" disabled>添加文本框</button>
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

        <div class="workspace-actions">
          <button id="transcribeBtn" disabled>Transcribe</button>
          <button id="downloadTranscriptBtn" disabled>下载逐字稿</button>
          <button id="summarizeBtn" disabled>生成 Summary</button>
          <button id="downloadSummaryBtn" disabled>下载 Summary</button>
        </div>

        <label class="workspace-text-label">逐字稿
          <textarea id="transcript" placeholder="点击 Transcribe 后，转写结果会分段流式输出；也可以手动粘贴文字再生成 summary。"></textarea>
        </label>
        <label class="workspace-text-label">Summary
          <textarea id="summary" placeholder="summary 会出现在这里。"></textarea>
        </label>
      </aside>

      <section class="workspace-grid-wrap">
        <div id="slides" class="slides workspace-slides"></div>
      </section>
    </section>

    <section class="capture-timeline">
      <div class="timeline-meta">
        <span id="timelineTime">00:00:00</span>
        <strong>拖动时间轴补抓页面 / 按 C</strong>
        <span id="timelineDuration">00:00:00</span>
      </div>
      <div id="timelineRail" class="timeline-rail" role="slider" aria-label="拖动选择时间并补抓 frame">
        <div id="timelineMarkers" class="timeline-markers"></div>
        <div class="timeline-blue"></div>
        <div id="timelineHandle" class="timeline-handle"></div>
      </div>
    </section>
  </main>

  <dialog id="cropDialog" class="crop-dialog">
    <form method="dialog" class="crop-panel">
      <h2>裁剪 frame</h2>
      <p>用百分比粗略裁剪。默认是整张图，Apply 后会替换当前 frame。</p>
      <img id="cropImage" alt="待裁剪 frame" />
      <div class="crop-grid">
        <label>Left %<input id="cropLeft" type="number" min="0" max="99" value="0" /></label>
        <label>Top %<input id="cropTop" type="number" min="0" max="99" value="0" /></label>
        <label>Width %<input id="cropWidth" type="number" min="1" max="100" value="100" /></label>
        <label>Height %<input id="cropHeight" type="number" min="1" max="100" value="100" /></label>
      </div>
      <div class="crop-actions">
        <button id="cropCancelBtn" value="cancel" class="ghost-btn">Cancel</button>
        <button id="cropApplyBtn" value="default">Apply Crop</button>
      </div>
    </form>
  </dialog>
`;

const $ = <T extends Element>(selector: string) => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing ${selector}`);
  return el;
};

const homeView = $<HTMLElement>('#homeView');
const workspaceView = $<HTMLElement>('#workspaceView');
const dropzone = $<HTMLLabelElement>('#dropzone');
const imageDropzone = $<HTMLLabelElement>('#imageDropzone');
const fileLabel = $<HTMLSpanElement>('#fileLabel');
const imageFileLabel = $<HTMLSpanElement>('#imageFileLabel');
const fileList = $<HTMLDivElement>('#fileList');
const imageFileList = $<HTMLDivElement>('#imageFileList');
const videoInput = $<HTMLInputElement>('#videoInput');
const imageInput = $<HTMLInputElement>('#imageInput');
const recordScreenBtn = $<HTMLButtonElement>('#recordScreenBtn');
const stopRecordBtn = $<HTMLButtonElement>('#stopRecordBtn');
const extractBtn = $<HTMLButtonElement>('#extractBtn');
const batchZipBtn = $<HTMLButtonElement>('#batchZipBtn');
const downloadFramesZipBtn = $<HTMLButtonElement>('#downloadFramesZipBtn');
const imagePptBtn = $<HTMLButtonElement>('#imagePptBtn');
const imageWorkspaceBtn = $<HTMLButtonElement>('#imageWorkspaceBtn');
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
const resultDock = $<HTMLElement>('#resultDock');
const resultBadge = $<HTMLElement>('#resultBadge');
const resultTitle = $<HTMLElement>('#resultTitle');
const resultSubtitle = $<HTMLElement>('#resultSubtitle');
const sideDownloadPdfBtn = $<HTMLButtonElement>('#sideDownloadPdfBtn');
const sideDownloadPptxBtn = $<HTMLButtonElement>('#sideDownloadPptxBtn');
const sideDownloadFramesBtn = $<HTMLButtonElement>('#sideDownloadFramesBtn');
const downloadTranscriptBtn = $<HTMLButtonElement>('#downloadTranscriptBtn');
const downloadSummaryBtn = $<HTMLButtonElement>('#downloadSummaryBtn');
const exportHint = $<HTMLElement>('#exportHint');
const homeStatus = $<HTMLDivElement>('#homeStatus');
const imageStatus = $<HTMLDivElement>('#imageStatus');
const statusEl = $<HTMLDivElement>('#status');
const progressPanel = $<HTMLDivElement>('#progressPanel');
const progressText = $<HTMLSpanElement>('#progressText');
const progressPercent = $<HTMLElement>('#progressPercent');
const progressFill = $<HTMLDivElement>('#progressFill');
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
let currentFileIndex = -1;
let selectedFile: File | null = null;
const fileStates = new Map<string, FileJobState>();
let slides: Slide[] = [];
let videoMeta: VideoMeta | null = null;
let workspaceMode: WorkspaceMode = 'video';
let timelineTime = 0;
let cropTargetSlideId: number | null = null;
let activeSlideId: number | null = null;
let activeTextBoxId: string | null = null;
let isDraggingTimeline = false;
let extractionTimelineMax = 0;
let lastTimelinePaint = 0;
let isExtracting = false;
let isBatchProcessing = false;
let isTranscribing = false;
let isSummarizing = false;
let isRecording = false;
let mediaRecorder: MediaRecorder | null = null;
let recordingStream: MediaStream | null = null;
let recordedChunks: Blob[] = [];
let currentRecordingMimeType = 'video/webm';

videoInput.addEventListener('change', () => addFiles(Array.from(videoInput.files ?? [])));
imageInput.addEventListener('change', () => addImageFiles(Array.from(imageInput.files ?? [])));
recordScreenBtn.addEventListener('click', () => startScreenRecording());
stopRecordBtn.addEventListener('click', () => stopScreenRecording());
extractBtn.addEventListener('click', () => processCurrentFile());
batchZipBtn.addEventListener('click', () => batchExtractAndDownloadZip());
downloadFramesZipBtn.addEventListener('click', () => downloadProcessedFramesZip());
imagePptBtn.addEventListener('click', () => downloadImagesAsPptx());
imageWorkspaceBtn.addEventListener('click', () => openImagesInWorkspace());
transcriptEl.addEventListener('input', () => { persistWorkspaceToState(); updateActionState(); });
summaryEl.addEventListener('input', () => persistWorkspaceToState());

doneBtn.addEventListener('click', () => {
  persistWorkspaceToState({ markProcessed: slides.length > 0 });
  workspaceView.hidden = true;
  homeView.hidden = false;
  hideProgress();
  renderFileList();
  setHomeStatus(workspaceMode === 'image' ? '图片 PPT 工作台已关闭，可继续上传图片或视频。' : selectedFile ? `当前视频：${selectedFile.name}` : '等待上传视频。');
});

toggleSideBtn.addEventListener('click', () => {
  workspaceView.classList.toggle('side-collapsed');
  toggleSideBtn.textContent = workspaceView.classList.contains('side-collapsed') ? '⇥ 展开左栏' : '⇤ 收起左栏';
});

selectAllBox.addEventListener('change', () => setAllSlidesSelected(selectAllBox.checked));
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

timelineRail.addEventListener('pointerdown', (event) => {
  if (!videoMeta || isExtracting || isBatchProcessing) return;
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

document.addEventListener('keydown', async (event) => {
  const target = event.target as HTMLElement | null;
  const isTyping = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
  if (isTyping || workspaceView.hidden || event.key.toLowerCase() !== 'c') return;
  event.preventDefault();
  await captureManualFrameAt(timelineTime);
});

cropApplyBtn.addEventListener('click', async (event) => {
  event.preventDefault();
  await applyCrop();
});

function isBusy(): boolean {
  return isExtracting || isBatchProcessing || isTranscribing || isSummarizing || isRecording;
}

function addFiles(files: File[], selectAdded = false): void {
  const validFiles = files.filter(isSupportedMediaFile);
  if (validFiles.length === 0) {
    setHomeStatus('没有检测到可处理的视频/音频文件。');
    return;
  }

  const existingKeys = new Set(selectedFiles.map(fileKey));
  let firstAddedIndex = -1;
  for (const file of validFiles) {
    const key = fileKey(file);
    if (existingKeys.has(key)) continue;
    selectedFiles.push(file);
    existingKeys.add(key);
    ensureState(file);
    if (firstAddedIndex < 0) firstAddedIndex = selectedFiles.length - 1;
  }

  if (currentFileIndex < 0 && selectedFiles.length > 0) chooseFile(0);
  else if (selectAdded && firstAddedIndex >= 0) chooseFile(firstAddedIndex);
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

function chooseFile(index: number): void {
  if (index < 0 || index >= selectedFiles.length) return;
  if (isBusy()) {
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

async function processCurrentFile(): Promise<void> {
  if (!selectedFile || isBusy()) return;
  const file = selectedFile;
  const settings = readSettings();
  setWorkspaceMode('video');
  showWorkspace();
  resetFrameOutputs();

  isExtracting = true;
  setStateStatus(file, 'processing');
  updateActionState();
  renderFileList();

  try {
    setProgress('开始抽帧', 2);
    setStatus(`正在处理：${file.name}。正在抽帧并保守去重，最多并发 ${FRAME_CONCURRENCY} 路解码...`);
    const result = await extractSlidesFromFile(file, settings, {
      onMetadata: (meta) => {
        videoMeta = meta;
        setupTimeline(meta.duration);
      },
      onKeep: (slide) => {
        slides.push(slide);
        appendSlideCard(slide);
        updateSelectionUI();
        updateTimelineMarkers();
      },
      onProgress: ({ completed, total, time, duration, kept }) => {
        setProgress(`抽帧保守去重：${completed} / ${total}，已保留 ${kept} 张`, 3 + Math.round((completed / Math.max(total, 1)) * 70));
        setStatus(`抽帧中：${formatTime(time)} / ${formatTime(duration)}，已保留 ${kept} 张`);
        updateExtractionTimeline(time);
      }
    });
    slides = result.slides;
    videoMeta = result.meta;
    forceTimelineToEnd();
    setProgress('抽帧完成', 100);
    setStatus(`抽帧完成：保留 ${slides.length} 张页面。顶部导出栏可直接下载 PDF、PPTX 或 Frames ZIP。`);
    setStateForFile(file, {
      slides,
      transcript: transcriptEl.value,
      summary: summaryEl.value,
      videoMeta,
      status: 'done',
      processedAt: new Date().toISOString()
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '抽帧失败，请查看控制台。';
    console.error(error);
    setProgress('抽帧失败', 100);
    setStatus(message);
    setStateStatus(file, 'error', message);
  } finally {
    isExtracting = false;
    renderFileList();
    updateActionState();
  }
}

async function batchExtractAndDownloadZip(): Promise<void> {
  if (selectedFiles.length === 0 || isBusy()) return;
  const settings = readSettings();
  const files = selectedFiles.slice();
  const zip = new JSZip();
  isBatchProcessing = true;
  homeView.hidden = false;
  workspaceView.hidden = true;
  updateActionState();
  renderFileList();

  try {
    for (const [index, file] of files.entries()) {
      currentFileIndex = selectedFiles.indexOf(file);
      selectedFile = file;
      setStateStatus(file, 'processing');
      renderFileList();
      setHomeStatus(`批量抽帧 ${index + 1}/${files.length}：${file.name}`);

      const result = await extractSlidesFromFile(file, settings, {
        onMetadata: (meta) => {
          videoMeta = meta;
          setupTimeline(meta.duration);
        },
        onProgress: ({ completed, total, time, duration, kept }) => {
          const filePercent = Math.round((completed / Math.max(total, 1)) * 100);
          setHomeStatus(`批量抽帧 ${index + 1}/${files.length}：${file.name} · ${filePercent}% · ${formatTime(time)} / ${formatTime(duration)} · 保留 ${kept} 张`);
        }
      });

      setStateForFile(file, {
        slides: result.slides,
        transcript: getState(file).transcript,
        summary: getState(file).summary,
        videoMeta: result.meta,
        status: 'done',
        processedAt: new Date().toISOString()
      });
      addSlidesToZip(zip, file, result.slides);
      renderFileList();
      await yieldToBrowser();
    }

    setHomeStatus('正在生成 frames zip...');
    const blob = await zip.generateAsync({ type: 'blob' }, (metadata) => {
      setHomeStatus(`正在生成 frames zip：${Math.round(metadata.percent)}%`);
    });
    downloadBlob(blob, `vid2deck-frames-${timestampForFilename()}.zip`);
    setHomeStatus(`批量完成：已处理 ${files.length} 个视频，并下载 frames zip。`);
  } catch (error) {
    console.error(error);
    setHomeStatus(error instanceof Error ? error.message : '批量抽帧失败。');
  } finally {
    isBatchProcessing = false;
    if (selectedFile) loadStateIntoWorkspace(selectedFile);
    renderFileList();
    updateActionState();
  }
}

async function downloadProcessedFramesZip(): Promise<void> {
  if (isBusy()) return;
  const processed = selectedFiles.filter((file) => getState(file).slides.length > 0);
  if (processed.length === 0) {
    setHomeStatus('还没有已处理的 frames 可以打包。');
    return;
  }
  isBatchProcessing = true;
  updateActionState();
  try {
    const zip = new JSZip();
    processed.forEach((file) => addSlidesToZip(zip, file, getState(file).slides));
    const blob = await zip.generateAsync({ type: 'blob' }, (metadata) => {
      setHomeStatus(`正在打包已处理 frames：${Math.round(metadata.percent)}%`);
    });
    downloadBlob(blob, `vid2deck-processed-frames-${timestampForFilename()}.zip`);
    setHomeStatus(`已下载 ${processed.length} 个已处理视频的 frames zip。`);
  } catch (error) {
    console.error(error);
    setHomeStatus(error instanceof Error ? error.message : 'Frames zip 生成失败。');
  } finally {
    isBatchProcessing = false;
    updateActionState();
  }
}

async function transcribeCurrentFile(): Promise<void> {
  if (!selectedFile || isBusy()) return;
  const file = selectedFile;
  try {
    isTranscribing = true;
    updateActionState();
    transcriptEl.value = '';
    setProgress('准备本地分块转写音频', 0);
    setStatus(`正在本地转写：${file.name}，会按 30 秒一段流式输出。`);
    const transcriptText = await transcribeLocally(file, setStatus);
    setProgress('转写完成', 100);
    setStatus(transcriptText ? '转写完成。' : '未识别到有效语音，你也可以手动粘贴逐字稿。');
    persistWorkspaceToState({ markProcessed: slides.length > 0 });
  } catch (error) {
    console.error(error);
    setProgress('转写失败', 100);
    setStatus(error instanceof Error ? error.message : '转写失败，请查看控制台。');
  } finally {
    isTranscribing = false;
    updateActionState();
  }
}

transcribeBtn.addEventListener('click', () => transcribeCurrentFile());

summarizeBtn.addEventListener('click', async () => {
  const settings = readSettings();
  const transcriptForSummary = transcriptEl.value.trim();
  if (!transcriptForSummary || isBusy()) {
    if (!transcriptForSummary) setStatus('没有逐字稿可总结。');
    return;
  }
  try {
    isSummarizing = true;
    updateActionState();
    setProgress('正在请求 DeepSeek summary', 50, true);
    setStatus('正在请求 DeepSeek summary...');
    summaryEl.value = await summarizeWithApi(settings, transcriptForSummary);
    setProgress('Summary 完成', 100);
    setStatus('Summary 已生成。');
    persistWorkspaceToState({ markProcessed: slides.length > 0 });
  } catch (error) {
    console.error(error);
    setProgress('Summary 失败', 100);
    setStatus(error instanceof Error ? error.message : 'Summary 失败，请查看控制台。');
  } finally {
    isSummarizing = false;
    updateActionState();
  }
});

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
      frames.textContent = '下载 Frames';
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
  imageFileLabel.textContent = selectedImageFiles.length > 0 ? `已选择 ${selectedImageFiles.length} 张图片` : '选择或拖入一组图片页';

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
  setStatus('已回到上次处理结果，可继续勾选、裁剪、删除或补抓 frame。');
}

async function downloadProcessedPdf(index: number): Promise<void> {
  const file = selectedFiles[index];
  if (!file) return;
  const selectedSlides = getState(file).slides.filter((slide) => slide.selected);
  if (selectedSlides.length === 0) {
    setHomeStatus('这个视频还没有可下载的选中 frame。');
    return;
  }
  try {
    setHomeStatus(`正在生成 ${file.name} 的 PDF...`);
    const pdfBlob = await makePdf(selectedSlides);
    downloadBlob(pdfBlob, `${baseName(file.name)}.pdf`);
    setHomeStatus(`已下载 ${file.name} 的 PDF。`);
  } catch (error) {
    console.error(error);
    setHomeStatus(error instanceof Error ? error.message : 'PDF 生成失败。');
  }
}

async function downloadProcessedPptx(index: number): Promise<void> {
  const file = selectedFiles[index];
  if (!file) return;
  const selectedSlides = getState(file).slides.filter((slide) => slide.selected);
  if (selectedSlides.length === 0) {
    setHomeStatus('这个视频还没有可下载的选中页面。');
    return;
  }
  try {
    setHomeStatus(`正在生成 ${file.name} 的 PPTX...`);
    const pptxBlob = await makePptx(selectedSlides);
    downloadBlob(pptxBlob, `${baseName(file.name)}.pptx`);
    setHomeStatus(`已下载 ${file.name} 的 PPTX。`);
  } catch (error) {
    console.error(error);
    setHomeStatus(error instanceof Error ? error.message : 'PPTX 生成失败。');
  }
}

async function downloadSingleFramesZip(index: number): Promise<void> {
  const file = selectedFiles[index];
  if (!file) return;
  const state = getState(file);
  if (state.slides.length === 0) return;
  try {
    const zip = new JSZip();
    addSlidesToZip(zip, file, state.slides);
    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(blob, `${baseName(file.name)}-frames.zip`);
    setHomeStatus(`已下载 ${file.name} 的 frames zip。`);
  } catch (error) {
    console.error(error);
    setHomeStatus(error instanceof Error ? error.message : 'Frames zip 生成失败。');
  }
}

async function downloadImagesAsPptx(): Promise<void> {
  if (selectedImageFiles.length === 0 || isBusy()) return;
  isBatchProcessing = true;
  updateActionState();
  try {
    setImageStatus('正在本地渲染图片页...');
    const imageSlides = await buildSlidesFromImages(selectedImageFiles, (index, total) => {
      setImageStatus(`正在本地渲染图片页：${index} / ${total}`);
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
    updateActionState();
  }
}

async function openImagesInWorkspace(): Promise<void> {
  if (selectedImageFiles.length === 0 || isBusy()) return;
  isBatchProcessing = true;
  updateActionState();
  try {
    setWorkspaceMode('image');
    selectedFile = new File([], `image-deck-${timestampForFilename()}.images`, { type: 'application/x-vid2deck-image-deck' });
    currentFileIndex = -1;
    resetCurrentFileState();
    showWorkspace();
    setProgress('正在本地渲染图片页', 10, true);
    setStatus('正在把图片转换成可编辑 PPT 页面。');
    slides = await buildSlidesFromImages(selectedImageFiles, (index, total) => {
      setProgress(`本地渲染图片页：${index} / ${total}`, 10 + Math.round((index / Math.max(total, 1)) * 80), true);
    });
    videoMeta = null;
    renderSlides();
    if (slides[0]) setPreview(slides[0]);
    setProgress('图片页已准备好', 100);
    setStatus(`已生成 ${slides.length} 张图片页。可在左侧添加文本框，顶部导出栏会输出包含真实文本框的 PPTX。`);
    persistWorkspaceToState({ markProcessed: true });
  } catch (error) {
    console.error(error);
    setStatus(error instanceof Error ? error.message : '图片进入编辑模式失败。');
  } finally {
    isBatchProcessing = false;
    updateActionState();
  }
}

function updateHomeFileStatus(): void {
  fileLabel.textContent = selectedFiles.length > 0 ? `已选择 ${selectedFiles.length} 个文件` : '选择或拖入一个或多个视频文件';
  setHomeStatus(selectedFile ? `当前视频：${selectedFile.name}` : '等待上传视频。');
}

function showWorkspace(): void {
  homeView.hidden = true;
  workspaceView.hidden = false;
  captureTimeline.hidden = workspaceMode !== 'video';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setWorkspaceMode(mode: WorkspaceMode): void {
  workspaceMode = mode;
  workspaceView.classList.toggle('image-mode', mode === 'image');
  captureTimeline.hidden = mode !== 'video';
}

function getState(file: File): FileJobState {
  return ensureState(file);
}

function ensureState(file: File): FileJobState {
  const key = fileKey(file);
  const existing = fileStates.get(key);
  if (existing) return existing;
  const created: FileJobState = { slides: [], transcript: '', summary: '', videoMeta: null, status: 'queued' };
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
    videoMeta: state.videoMeta ? { ...state.videoMeta } : null,
    status: state.status,
    error: state.error,
    processedAt: state.processedAt
  });
}

function persistWorkspaceToState(options: { markProcessed?: boolean } = {}): void {
  if (!selectedFile) return;
  const previous = getState(selectedFile);
  setStateForFile(selectedFile, {
    slides,
    transcript: transcriptEl.value,
    summary: summaryEl.value,
    videoMeta,
    status: slides.length > 0 ? 'done' : previous.status,
    error: previous.error,
    processedAt: options.markProcessed ? new Date().toISOString() : previous.processedAt
  });
}

function loadStateIntoWorkspace(file: File): void {
  const state = getState(file);
  slides = cloneSlides(state.slides);
  videoMeta = state.videoMeta ? { ...state.videoMeta } : null;
  activeSlideId = slides[0]?.id ?? null;
  activeTextBoxId = null;
  timelineTime = slides[0]?.time ?? 0;
  extractionTimelineMax = timelineTime;
  lastTimelinePaint = 0;
  transcriptEl.value = state.transcript;
  summaryEl.value = state.summary;
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
  previewImage.removeAttribute('src');
  previewEmpty.hidden = false;
  timelineMarkers.innerHTML = '';
  updateTimelinePosition();
  hideProgress();
  updateSelectionUI();
}

function resetFrameOutputs(): void {
  slides = [];
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
    onMetadata?: (meta: VideoMeta) => void;
    onKeep?: (slide: Slide) => void;
    onProgress?: (data: { completed: number; total: number; time: number; duration: number; kept: number }) => void;
  } = {}
): Promise<{ slides: Slide[]; meta: VideoMeta }> {
  const url = URL.createObjectURL(file);
  const extractors: FrameExtractor[] = [];
  try {
    const meta = await readVideoMetadata(url);
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
        const index = nextCapture;
        nextCapture += 1;
        const frame = await extractor.capture(index, times[index]);
        captured.set(index, frame);
        completed += 1;
        commitReadyFrames();
        await yieldToBrowser();
      }
    };

    await Promise.all(extractors.map((extractor) => runCapture(extractor)));
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
  let extractor: FrameExtractor | null = null;
  try {
    const requestedTime = Math.min(Math.max(time, 0), Math.max(videoMeta.duration - 0.05, 0));
    setProgress(`正在补抓 ${formatClock(requestedTime)} 的 frame`, 50, true);
    extractor = await createFrameExtractor(url, videoMeta.width, videoMeta.height);
    const frame = await extractor.capture(slides.length, requestedTime);
    const slide: Slide = { id: slides.length + 1, time: frame.time, hash: frame.hash, dataUrl: frame.dataUrl, width: frame.width, height: frame.height, selected: getDefaultNewSlideSelected(), textBoxes: [] };
    slides.push(slide);
    sortAndReindexSlides();
    timelineTime = frame.time;
    updateTimelinePosition();
    renderSlides();
    setPreview(slide);
    setStatus(`已补抓 ${formatClock(frame.time)} 的 frame。`);
    setProgress('补抓完成', 100);
    persistWorkspaceToState({ markProcessed: true });
    renderFileList();
  } catch (error) {
    console.error(error);
    setStatus(error instanceof Error ? error.message : '补抓 frame 失败。');
  } finally {
    extractor?.dispose();
    URL.revokeObjectURL(url);
    updateActionState();
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
    pdf.addImage(slide.dataUrl, 'JPEG', imageX, imageY, drawWidth, drawHeight);
    for (const box of slide.textBoxes ?? []) {
      const [r, g, b] = hexToRgb(normalizeHexColor(box.color));
      const fontSize = Math.max(6, box.fontSize * (drawWidth / 960));
      const x = imageX + (box.x / 100) * drawWidth;
      const y = imageY + (box.y / 100) * drawHeight + fontSize;
      const width = (box.width / 100) * drawWidth;
      pdf.setTextColor(r, g, b);
      pdf.setFontSize(fontSize);
      pdf.setFont('helvetica', box.bold ? 'bold' : 'normal');
      const lines = pdf.splitTextToSize(box.text || ' ', width);
      pdf.text(lines, x, y, { maxWidth: width, align: box.align });
    }
    await yieldToBrowser();
  }
  return pdf.output('blob');
}

async function buildSlidesFromImages(files: File[], onProgress?: (index: number, total: number) => void): Promise<Slide[]> {
  const imageSlides: Slide[] = [];
  for (const [index, file] of files.entries()) {
    onProgress?.(index + 1, files.length);
    imageSlides.push(await imageFileToSlide(file, index));
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

async function downloadSelectedPdf(): Promise<void> {
  const selectedSlides = slides.filter((slide) => slide.selected);
  if (!selectedFile || selectedSlides.length === 0) {
    setStatus('请至少勾选一张 frame。');
    return;
  }
  try {
    setProgress('正在生成选中页面 PDF', 50, true);
    const pdfBlob = await makePdf(selectedSlides);
    downloadBlob(pdfBlob, `${baseName(selectedFile.name)}.pdf`);
    setProgress('PDF 已生成', 100);
    setStatus(`已下载 ${selectedSlides.length} 张选中页面的 PDF。`);
  } catch (error) {
    console.error(error);
    setStatus(error instanceof Error ? error.message : 'PDF 生成失败。');
  }
}

async function downloadSelectedPptx(): Promise<void> {
  const selectedSlides = slides.filter((slide) => slide.selected);
  if (!selectedFile || selectedSlides.length === 0) {
    setStatus('请至少勾选一张页面。');
    return;
  }
  try {
    setProgress('正在生成选中页面 PPTX', 50, true);
    const pptxBlob = await makePptx(selectedSlides);
    downloadBlob(pptxBlob, `${baseName(selectedFile.name)}.pptx`);
    setProgress('PPTX 已生成', 100);
    setStatus(`已下载 ${selectedSlides.length} 张选中页面的 PPTX。`);
  } catch (error) {
    console.error(error);
    setStatus(error instanceof Error ? error.message : 'PPTX 生成失败。');
  }
}

async function downloadSelectedFramesZip(): Promise<void> {
  const selectedSlides = slides.filter((slide) => slide.selected);
  if (!selectedFile || selectedSlides.length === 0) {
    setStatus('请至少勾选一张页面。');
    return;
  }
  try {
    setProgress('正在生成选中页面 Frames ZIP', 50, true);
    const zip = new JSZip();
    addSlidesToZip(zip, selectedFile, selectedSlides);
    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(blob, `${baseName(selectedFile.name)}-selected-frames.zip`);
    setProgress('Frames ZIP 已生成', 100);
    setStatus(`已下载 ${selectedSlides.length} 张选中页面的 Frames ZIP。`);
  } catch (error) {
    console.error(error);
    setStatus(error instanceof Error ? error.message : 'Frames ZIP 生成失败。');
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
  <Application>Vid2PPT Deck</Application>
  <PresentationFormat>Widescreen</PresentationFormat>
  <Slides>${slideCount}</Slides>
</Properties>`;
}

function pptxCoreXml(): string {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Vid2PPT Deck Export</dc:title>
  <dc:creator>Vid2PPT Deck</dc:creator>
  <cp:lastModifiedBy>Vid2PPT Deck</cp:lastModifiedBy>
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
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Vid2PPT Deck">
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
    onProgress('加载本地 ASR 模型：Xenova/whisper-tiny...');
    setProgress('加载本地转写模型', 5, true);
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

function appendSlideCard(slide: Slide): void {
  const card = document.createElement('figure');
  card.className = 'slide-card';
  if (slide.id === activeSlideId) card.classList.add('is-active');
  card.dataset.slideId = String(slide.id);
  const caption = workspaceMode === 'image' ? `#${slide.id} · 图片页` : `#${slide.id} · ${formatTime(slide.time)}`;
  card.innerHTML = `
    <label class="slide-select"><input class="frame-checkbox" type="checkbox" /><span>选入导出</span></label>
    <div class="frame-tools">
      <button class="add-text-box" title="添加可编辑文本框" type="button">T</button>
      <button class="crop-frame" title="裁剪" type="button">⌗</button>
      <button class="delete-frame" title="删除" type="button">🗑</button>
    </div>
    <div class="slide-thumb">
      <img src="${slide.dataUrl}" alt="Slide ${slide.id}" />
      <div class="text-box-layer"></div>
    </div>
    <figcaption>${caption}</figcaption>
  `;
  const img = card.querySelector<HTMLImageElement>('img');
  img?.addEventListener('click', () => setPreview(slide));
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
    event.stopPropagation();
    setPreview(slide);
    addTextBoxToActiveSlide();
  });
  slidesEl.appendChild(card);
  refreshSlideTextLayer(slide);
  if (!activeSlideId && slide.id === 1) setPreview(slide);
}

function renderSlides(): void {
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
  addTextBoxBtn.disabled = !hasSlide || isBusy();
  deleteTextBoxBtn.disabled = !hasBox || isBusy();
  [textBoxContent, textBoxX, textBoxY, textBoxWidth, textBoxHeight, textBoxFontSize, textBoxColor, textBoxBold, textBoxAlign].forEach((control) => {
    control.disabled = !hasBox || isBusy();
  });
  textLayerHint.textContent = hasBox
    ? `正在编辑第 ${slide?.id ?? '-'} 页的文本框。可拖动缩略图上的文本框调整位置。`
    : hasSlide
      ? `当前选中第 ${slide?.id ?? '-'} 页；添加文本框后导出 PPTX 即为真实文本对象。`
      : '选择一页后添加文本框；导出 PPTX 时会变成真实 PowerPoint 文本对象。';

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
  slides = slides.filter((slide) => slide.id !== id);
  if (activeSlideId === id) {
    activeSlideId = null;
    activeTextBoxId = null;
  }
  sortAndReindexSlides();
  if (!activeSlideId) activeSlideId = slides[0]?.id ?? null;
  renderSlides();
  if (slides[0]) setPreview(slides[0]);
  else {
    previewImage.removeAttribute('src');
    previewEmpty.hidden = false;
  }
  setStatus(workspaceMode === 'image' ? '已删除图片页。' : '已删除 frame。');
  persistWorkspaceToState({ markProcessed: slides.length > 0 });
  renderFileList();
}

function sortAndReindexSlides(): void {
  slides.sort((a, b) => a.time - b.time);
  slides.forEach((slide, index) => { slide.id = index + 1; });
}

function openCropDialog(slide: Slide): void {
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
  if (!slide) return;
  const left = clamp(Number(cropLeft.value || 0), 0, 99) / 100;
  const top = clamp(Number(cropTop.value || 0), 0, 99) / 100;
  const widthPct = clamp(Number(cropWidth.value || 100), 1, 100) / 100;
  const heightPct = clamp(Number(cropHeight.value || 100), 1, 100) / 100;
  const img = await loadImage(slide.dataUrl);
  const sx = Math.floor(img.naturalWidth * left);
  const sy = Math.floor(img.naturalHeight * top);
  const sw = Math.max(1, Math.min(Math.floor(img.naturalWidth * widthPct), img.naturalWidth - sx));
  const sh = Math.max(1, Math.min(Math.floor(img.naturalHeight * heightPct), img.naturalHeight - sy));
  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  slide.dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  slide.width = sw;
  slide.height = sh;
  slide.hash = visualHash(ctx, sw, sh);
  cropDialog.close();
  renderSlides();
  setPreview(slide);
  setStatus('已裁剪 frame。');
  persistWorkspaceToState({ markProcessed: slides.length > 0 });
  renderFileList();
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
  const selectedCount = slides.filter((slide) => slide.selected).length;
  extractBtn.disabled = !hasVideoFile || busy;
  batchZipBtn.disabled = selectedFiles.length === 0 || busy;
  downloadFramesZipBtn.disabled = busy || selectedFiles.every((file) => getState(file).slides.length === 0);
  imagePptBtn.disabled = selectedImageFiles.length === 0 || busy;
  imageWorkspaceBtn.disabled = selectedImageFiles.length === 0 || busy;
  transcribeBtn.disabled = !hasVideoFile || busy || imageMode;
  downloadPdfBtn.disabled = selectedCount === 0 || busy;
  downloadPptxBtn.disabled = selectedCount === 0 || busy;
  dockDownloadPdfBtn.disabled = selectedCount === 0 || busy;
  dockDownloadPptxBtn.disabled = selectedCount === 0 || busy;
  dockDownloadFramesBtn.disabled = selectedCount === 0 || busy;
  sideDownloadPdfBtn.disabled = selectedCount === 0 || busy;
  sideDownloadPptxBtn.disabled = selectedCount === 0 || busy;
  sideDownloadFramesBtn.disabled = selectedCount === 0 || busy;
  downloadTranscriptBtn.disabled = !transcriptEl.value.trim() || isTranscribing || imageMode;
  summarizeBtn.disabled = !transcriptEl.value.trim() || busy || imageMode;
  downloadSummaryBtn.disabled = !summaryEl.value.trim() || isSummarizing || imageMode;
  videoInput.disabled = busy;
  imageInput.disabled = busy;
  recordScreenBtn.disabled = busy;
  stopRecordBtn.hidden = !isRecording;
  updateSelectionUI();
}

function updateSelectionUI(): void {
  const selectedCount = slides.filter((slide) => slide.selected).length;
  selectCount.textContent = `${selectedCount}/${slides.length}`;
  exportHint.textContent = slides.length > 0
    ? `已选 ${selectedCount} / ${slides.length} 张。默认全选；取消勾选可排除页面。`
    : '抽帧完成后，也可以从这里下载选中页面。';
  selectAllBox.checked = slides.length > 0 && selectedCount === slides.length;
  selectAllBox.indeterminate = selectedCount > 0 && selectedCount < slides.length;
  updateResultDock(selectedCount);
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
    resultTitle.textContent = hasSlides ? `已生成 ${slides.length} 页，继续处理中` : '正在生成页面';
    resultSubtitle.textContent = '处理完成后，立即下载按钮会自动可用。';
    return;
  }

  if (!hasSlides) {
    resultBadge.textContent = '等待处理';
    resultTitle.textContent = '等待生成页面';
    resultSubtitle.textContent = '上传并处理视频后，下载入口会固定显示在这里。';
    return;
  }

  if (selectedCount === 0) {
    resultBadge.textContent = '需要选择';
    resultTitle.textContent = `已生成 ${slides.length} 页`;
    resultSubtitle.textContent = '请至少勾选 1 页，之后即可下载 PDF、PPTX 或 Frames ZIP。';
    return;
  }

  resultBadge.textContent = '可以导出';
  resultTitle.textContent = `已生成 ${slides.length} 页，已选 ${selectedCount} 页`;
  resultSubtitle.textContent = '默认全选。取消勾选会从导出文件中排除对应页面。';
}

function setAllSlidesSelected(selected: boolean): void {
  slides.forEach((slide) => { slide.selected = selected; });
  slidesEl.querySelectorAll<HTMLInputElement>('.frame-checkbox').forEach((box) => { box.checked = selected; });
  persistWorkspaceToState({ markProcessed: slides.length > 0 });
  renderFileList();
  updateActionState();
}

function getDefaultNewSlideSelected(): boolean {
  if (slides.length === 0) return true;
  return selectAllBox.checked;
}

async function startScreenRecording(): Promise<void> {
  if (!navigator.mediaDevices?.getDisplayMedia || typeof MediaRecorder === 'undefined') {
    setHomeStatus('当前浏览器不支持屏幕录制。请使用最新版 Chrome / Edge / Safari。');
    return;
  }
  try {
    recordedChunks = [];
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
    setHomeStatus('正在录制屏幕。完成后点击“停止录制并加入队列”。');
  } catch (error) {
    console.error(error);
    cleanupRecording();
    setHomeStatus(error instanceof Error ? `屏幕录制未开始：${error.message}` : '屏幕录制未开始。');
  } finally {
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
  setHomeStatus(`录制完成，已加入队列并切换到：${file.name}`);
  updateActionState();
}

function cleanupRecording(): void {
  recordingStream?.getTracks().forEach((track) => track.stop());
  recordingStream = null;
  mediaRecorder = null;
  recordedChunks = [];
  isRecording = false;
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

async function summarizeWithApi(settings: Settings, transcript: string): Promise<string> {
  if (!settings.authCode) throw new Error('请先填写访问码，也就是 Vercel 环境变量 AUTH_CODE。');
  const response = await fetch(settings.summaryApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Access-Code': settings.authCode },
    body: JSON.stringify({ transcript })
  });
  if (!response.ok) throw new Error(`Summary API 请求失败：${response.status} ${await response.text()}`);
  const data = await response.json() as { summary?: string };
  return data.summary ?? '';
}

function readSettings(): Settings {
  return {
    sampleEvery: Math.max(0.5, Number($<HTMLInputElement>('#sampleEvery').value || 1)),
    duplicateThreshold: Number($<HTMLInputElement>('#duplicateThreshold').value || 4),
    minGap: Math.max(0, Number($<HTMLInputElement>('#minGap').value || 3)),
    summaryApiUrl: $<HTMLInputElement>('#summaryApiUrl').value.trim(),
    authCode: $<HTMLInputElement>('#authCode').value
  };
}

function setProgress(label: string, percent?: number, indeterminate = false): void {
  progressPanel.hidden = false;
  progressText.textContent = label;
  progressFill.classList.toggle('is-indeterminate', indeterminate);
  if (typeof percent === 'number' && Number.isFinite(percent)) {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    progressFill.style.width = `${clamped}%`;
    progressPercent.textContent = indeterminate ? `${clamped}% · 处理中` : `${clamped}%`;
  } else {
    progressFill.style.width = '100%';
    progressPercent.textContent = '处理中';
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
