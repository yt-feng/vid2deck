import { jsPDF } from 'jspdf';
import './style.css';

type Slide = {
  id: number;
  time: number;
  hash: bigint;
  dataUrl: string;
  width: number;
  height: number;
};

type Settings = {
  sampleEvery: number;
  duplicateThreshold: number;
  minGap: number;
  summaryApiUrl: string;
};

type TransformerPipeline = (input: unknown, options?: Record<string, unknown>) => Promise<unknown>;

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('Missing #app');
}

app.innerHTML = `
  <section class="hero">
    <div>
      <p class="eyebrow">Vid2Deck</p>
      <h1>上传视频，生成去重后的 PPT PDF、逐字稿和 summary</h1>
      <p class="subhead">视频抽帧、相似页去重和 PDF 导出默认都在浏览器本地完成；summary 通过你自己的后端安全读取 DEEPSEEK_API_KEY。</p>
    </div>
  </section>

  <section class="panel">
    <label class="dropzone" id="dropzone" for="videoInput">
      <input id="videoInput" type="file" accept="video/*,audio/*,.mkv,.mov,.mp4,.webm,.avi,.m4v" />
      <span id="fileLabel">选择或拖入视频文件</span>
      <small>拖到这里松手即可上传；浏览器能解码的格式可直接处理，特殊编码建议走后端 ffmpeg。</small>
    </label>

    <div class="grid">
      <label>抽帧间隔（秒）<input id="sampleEvery" type="number" min="0.5" step="0.5" value="2" /></label>
      <label>去重阈值（越大越宽松）<input id="duplicateThreshold" type="number" min="0" max="64" value="8" /></label>
      <label>保留页最小间隔（秒）<input id="minGap" type="number" min="0" step="0.5" value="3" /></label>
      <label>Summary API URL<input id="summaryApiUrl" type="url" placeholder="https://your-api.example.com/api/summarize" /></label>
    </div>

    <div class="actions">
      <button id="processBtn" disabled>开始生成</button>
      <button id="downloadPdfBtn" disabled>下载 PDF</button>
      <button id="downloadTranscriptBtn" disabled>下载逐字稿</button>
      <button id="downloadSummaryBtn" disabled>下载 Summary</button>
    </div>

    <div class="progress-panel" id="progressPanel" hidden>
      <div class="progress-meta">
        <span id="progressText">准备开始</span>
        <strong id="progressPercent">0%</strong>
      </div>
      <div class="progress-track" aria-label="处理进度">
        <div class="progress-fill" id="progressFill"></div>
      </div>
    </div>

    <div class="status" id="status">等待上传视频。</div>
  </section>

  <section class="results">
    <article>
      <h2>去重后的页面</h2>
      <div id="slides" class="slides"></div>
    </article>
    <article>
      <h2>逐字稿</h2>
      <textarea id="transcript" placeholder="转写结果会出现在这里，也可以手动粘贴/编辑后再生成 summary。"></textarea>
    </article>
    <article>
      <h2>Summary</h2>
      <textarea id="summary" placeholder="summary 会出现在这里。"></textarea>
    </article>
  </section>
`;

const dropzone = document.querySelector<HTMLLabelElement>('#dropzone')!;
const fileLabel = document.querySelector<HTMLSpanElement>('#fileLabel')!;
const videoInput = document.querySelector<HTMLInputElement>('#videoInput')!;
const processBtn = document.querySelector<HTMLButtonElement>('#processBtn')!;
const downloadPdfBtn = document.querySelector<HTMLButtonElement>('#downloadPdfBtn')!;
const downloadTranscriptBtn = document.querySelector<HTMLButtonElement>('#downloadTranscriptBtn')!;
const downloadSummaryBtn = document.querySelector<HTMLButtonElement>('#downloadSummaryBtn')!;
const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const progressPanel = document.querySelector<HTMLDivElement>('#progressPanel')!;
const progressText = document.querySelector<HTMLSpanElement>('#progressText')!;
const progressPercent = document.querySelector<HTMLElement>('#progressPercent')!;
const progressFill = document.querySelector<HTMLDivElement>('#progressFill')!;
const slidesEl = document.querySelector<HTMLDivElement>('#slides')!;
const transcriptEl = document.querySelector<HTMLTextAreaElement>('#transcript')!;
const summaryEl = document.querySelector<HTMLTextAreaElement>('#summary')!;

let selectedFile: File | null = null;
let slides: Slide[] = [];
let pdfBlob: Blob | null = null;
let transcriptText = '';
let summaryText = '';

videoInput.addEventListener('change', () => {
  selectFile(videoInput.files?.[0] ?? null);
});

for (const eventName of ['dragenter', 'dragover']) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    dropzone.classList.add('is-dragover');
  });
}

for (const eventName of ['dragleave', 'dragend']) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    dropzone.classList.remove('is-dragover');
  });
}

dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  event.stopPropagation();
  dropzone.classList.remove('is-dragover');
  selectFile(event.dataTransfer?.files?.[0] ?? null);
});

processBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  const settings = readSettings();
  resetOutputs();

  try {
    setBusy(true);
    setProgress('开始处理视频', 2);
    setStatus('正在抽帧并去重...');
    slides = await extractUniqueSlides(selectedFile, settings, setStatus);
    renderSlides(slides);
    setProgress('正在生成 PDF', 58);
    pdfBlob = await makePdf(slides);
    downloadPdfBtn.disabled = !pdfBlob;

    setProgress('准备本地转写音频', 62);
    setStatus('正在本地转写音频...首次加载模型会比较慢。');
    transcriptText = await transcribeLocally(selectedFile, setStatus);
    transcriptEl.value = transcriptText || '未生成逐字稿。可在这里手动粘贴文字后再生成 summary。';
    downloadTranscriptBtn.disabled = !transcriptText;

    const transcriptForSummary = transcriptEl.value.trim();
    if (settings.summaryApiUrl && transcriptForSummary) {
      setProgress('正在请求 DeepSeek summary API', 94, true);
      setStatus('正在请求 DeepSeek summary API...');
      summaryText = await summarizeWithApi(settings.summaryApiUrl, transcriptForSummary);
      summaryEl.value = summaryText;
      downloadSummaryBtn.disabled = !summaryText;
    } else {
      summaryEl.value = '未配置 Summary API URL。部署 server/ 里的后端后，把 /api/summarize 地址填到上方即可使用 DeepSeek 生成 summary。';
    }

    setProgress('全部完成', 100);
    setStatus(`完成：保留 ${slides.length} 张页面。`);
  } catch (error) {
    console.error(error);
    setProgress('处理失败', 100);
    setStatus(error instanceof Error ? error.message : '处理失败，请查看控制台。');
  } finally {
    setBusy(false);
  }
});

downloadPdfBtn.addEventListener('click', () => {
  if (pdfBlob) downloadBlob(pdfBlob, 'vid2deck-slides.pdf');
});

downloadTranscriptBtn.addEventListener('click', () => {
  downloadBlob(new Blob([transcriptEl.value], { type: 'text/plain;charset=utf-8' }), 'vid2deck-transcript.txt');
});

downloadSummaryBtn.addEventListener('click', () => {
  downloadBlob(new Blob([summaryEl.value], { type: 'text/markdown;charset=utf-8' }), 'vid2deck-summary.md');
});

function selectFile(file: File | null): void {
  selectedFile = file;
  processBtn.disabled = !selectedFile;
  fileLabel.textContent = selectedFile ? `已选择：${selectedFile.name}` : '选择或拖入视频文件';
  statusEl.textContent = selectedFile ? `已选择：${selectedFile.name}` : '等待上传视频。';
}

function readSettings(): Settings {
  return {
    sampleEvery: Math.max(0.5, Number((document.querySelector<HTMLInputElement>('#sampleEvery')!).value || 2)),
    duplicateThreshold: Number((document.querySelector<HTMLInputElement>('#duplicateThreshold')!).value || 8),
    minGap: Math.max(0, Number((document.querySelector<HTMLInputElement>('#minGap')!).value || 3)),
    summaryApiUrl: (document.querySelector<HTMLInputElement>('#summaryApiUrl')!).value.trim()
  };
}

async function extractUniqueSlides(file: File, settings: Settings, onProgress: (message: string) => void): Promise<Slide[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.preload = 'metadata';
  video.playsInline = true;

  try {
    await waitForEvent(video, 'loadedmetadata');
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error('无法读取视频时长。请尝试转成 H.264 mp4 或 WebM 后再上传。');
    }

    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('浏览器不支持 Canvas。');
    canvas.width = width;
    canvas.height = height;

    const kept: Slide[] = [];
    let id = 1;

    for (let t = 0; t < video.duration; t += settings.sampleEvery) {
      const framePercent = Math.min(55, Math.round((t / video.duration) * 55));
      setProgress(`抽帧去重：${formatTime(t)} / ${formatTime(video.duration)}`, Math.max(3, framePercent));
      onProgress(`抽帧中：${formatTime(t)} / ${formatTime(video.duration)}，已保留 ${kept.length} 张`);
      await seekVideo(video, Math.min(t, video.duration - 0.05));
      ctx.drawImage(video, 0, 0, width, height);
      const hash = averageHash(ctx, width, height);
      const nearDuplicate = kept.some((slide) => {
        const tooCloseInTime = Math.abs(slide.time - t) < settings.minGap;
        return tooCloseInTime || hammingDistance(slide.hash, hash) <= settings.duplicateThreshold;
      });
      if (!nearDuplicate) {
        kept.push({
          id: id++,
          time: t,
          hash,
          dataUrl: canvas.toDataURL('image/jpeg', 0.9),
          width,
          height
        });
      }
      await yieldToBrowser();
    }

    setProgress('抽帧去重完成', 56);
    return kept;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function averageHash(ctx: CanvasRenderingContext2D, width: number, height: number): bigint {
  const size = 8;
  const tmp = document.createElement('canvas');
  const tctx = tmp.getContext('2d', { willReadFrequently: true });
  if (!tctx) return 0n;
  tmp.width = size;
  tmp.height = size;
  tctx.drawImage(ctx.canvas, 0, 0, width, height, 0, 0, size, size);
  const data = tctx.getImageData(0, 0, size, size).data;
  const grays: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    grays.push(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
  }
  const avg = grays.reduce((sum, value) => sum + value, 0) / grays.length;
  return grays.reduce((hash, value, index) => value >= avg ? hash | (1n << BigInt(index)) : hash, 0n);
}

function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

async function makePdf(items: Slide[]): Promise<Blob> {
  if (items.length === 0) throw new Error('没有可导出的页面。');
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();

  items.forEach((slide, index) => {
    if (index > 0) pdf.addPage();
    const ratio = Math.min(pageWidth / slide.width, pageHeight / slide.height);
    const drawWidth = slide.width * ratio;
    const drawHeight = slide.height * ratio;
    const x = (pageWidth - drawWidth) / 2;
    const y = (pageHeight - drawHeight) / 2;
    pdf.addImage(slide.dataUrl, 'JPEG', x, y, drawWidth, drawHeight);
  });

  return pdf.output('blob');
}

async function transcribeLocally(file: File, onProgress: (message: string) => void): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    onProgress('加载本地 ASR 模型：Xenova/whisper-tiny...');
    setProgress('加载本地转写模型', 64, true);
    const mod = await import('@xenova/transformers');
    const pipelineFactory = (mod as unknown as { pipeline: (task: string, model?: string, options?: Record<string, unknown>) => Promise<TransformerPipeline> }).pipeline;
    const transcriber = await pipelineFactory('automatic-speech-recognition', 'Xenova/whisper-tiny', {
      progress_callback: (progress: { status?: string; file?: string; progress?: number }) => {
        if (progress.status) {
          const pct = typeof progress.progress === 'number' ? Math.round(progress.progress) : undefined;
          const overall = typeof pct === 'number' ? 64 + Math.round(pct * 0.18) : undefined;
          setProgress(`加载转写模型：${progress.status}`, overall, typeof overall !== 'number');
          const pctText = typeof pct === 'number' ? ` ${pct}%` : '';
          onProgress(`模型加载：${progress.status}${pctText}`);
        }
      }
    });

    onProgress('正在转写音频...');
    setProgress('正在转写音频，长视频可能需要几分钟', 85, true);
    const result = await transcriber(objectUrl, {
      chunk_length_s: 30,
      stride_length_s: 5,
      language: 'chinese',
      task: 'transcribe'
    }) as { text?: string } | Array<{ text?: string }>;

    setProgress('转写完成', 92);
    if (Array.isArray(result)) {
      return result.map((item) => item.text ?? '').join('\n').trim();
    }
    return (result.text ?? '').trim();
  } catch (error) {
    console.warn(error);
    return '';
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function summarizeWithApi(apiUrl: string, transcript: string): Promise<string> {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript })
  });
  if (!response.ok) {
    throw new Error(`Summary API 请求失败：${response.status}`);
  }
  const data = await response.json() as { summary?: string };
  return data.summary ?? '';
}

function renderSlides(items: Slide[]): void {
  slidesEl.innerHTML = '';
  for (const slide of items) {
    const card = document.createElement('figure');
    card.innerHTML = `<img src="${slide.dataUrl}" alt="Slide ${slide.id}" /><figcaption>#${slide.id} · ${formatTime(slide.time)}</figcaption>`;
    slidesEl.appendChild(card);
  }
}

function resetOutputs(): void {
  slides = [];
  pdfBlob = null;
  transcriptText = '';
  summaryText = '';
  slidesEl.innerHTML = '';
  transcriptEl.value = '';
  summaryEl.value = '';
  downloadPdfBtn.disabled = true;
  downloadTranscriptBtn.disabled = true;
  downloadSummaryBtn.disabled = true;
  hideProgress();
}

function setBusy(isBusy: boolean): void {
  processBtn.disabled = isBusy || !selectedFile;
  videoInput.disabled = isBusy;
}

function setStatus(message: string): void {
  statusEl.textContent = message;
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

function waitForEvent(target: EventTarget, eventName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSuccess = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('视频读取失败。浏览器可能不支持该编码。'));
    };
    const cleanup = () => {
      target.removeEventListener(eventName, onSuccess);
      target.removeEventListener('error', onError);
    };
    target.addEventListener(eventName, onSuccess, { once: true });
    target.addEventListener('error', onError, { once: true });
  });
}

function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('视频 seek 失败。'));
    };
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.currentTime = time;
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

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${secs}`;
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
