import { jsPDF } from 'jspdf';
import './style.css';

type Slide = { id: number; time: number; hash: bigint; dataUrl: string; width: number; height: number };
type Settings = { sampleEvery: number; duplicateThreshold: number; minGap: number; summaryApiUrl: string; authCode: string };
type WorkerResult =
  | { type: 'ready' }
  | { type: 'model-progress'; status: string; progress?: number }
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id?: number; error: string };

const VISUAL_HASH_BITS = 320;

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app');

app.innerHTML = `
  <section class="hero">
    <div>
      <p class="eyebrow">Vid2Deck</p>
      <h1>上传视频，生成去重后的 PPT PDF、逐字稿和 summary</h1>
      <p class="subhead">视频抽帧、相似页去重、PDF 导出和转写默认都在浏览器本地完成；summary 通过 Vercel 后端安全读取 DeepSeek key。</p>
    </div>
  </section>

  <section class="panel">
    <label class="dropzone" id="dropzone" for="videoInput">
      <input id="videoInput" type="file" accept="video/*,audio/*,.mkv,.mov,.mp4,.webm,.avi,.m4v" />
      <span id="fileLabel">选择或拖入视频文件</span>
      <small>拖到这里松手即可上传；视频处理仍然在浏览器本地完成。</small>
    </label>

    <div class="grid">
      <label>抽帧间隔（秒）<input id="sampleEvery" type="number" min="0.5" step="0.5" value="1" /></label>
      <label>去重阈值（越大越容易合并）<input id="duplicateThreshold" type="number" min="1" max="20" step="0.5" value="4" /></label>
      <label>同页合并窗口（秒）<input id="minGap" type="number" min="0" step="0.5" value="3" /></label>
      <label>Summary API URL<input id="summaryApiUrl" type="url" value="https://vid2deck.vercel.app/api/summarize-simple" /></label>
      <label>访问码<input id="authCode" type="password" placeholder="填 Vercel 的 AUTH_CODE" autocomplete="current-password" /></label>
    </div>

    <div class="hint">抽帧现在使用保守去重：默认更倾向于保留新画面，避免漏掉关键 slide；逐字稿会自动分块、本地识别并流式输出。</div>

    <div class="actions">
      <button id="processBtn" disabled>开始生成</button>
      <button id="downloadPdfBtn" disabled>下载 PDF</button>
      <button id="downloadTranscriptBtn" disabled>下载逐字稿</button>
      <button id="downloadSummaryBtn" disabled>下载 Summary</button>
    </div>

    <div class="progress-panel" id="progressPanel" hidden>
      <div class="progress-meta"><span id="progressText">准备开始</span><strong id="progressPercent">0%</strong></div>
      <div class="progress-track" aria-label="处理进度"><div class="progress-fill" id="progressFill"></div></div>
    </div>

    <div class="status" id="status">等待上传视频。</div>
  </section>

  <section class="results">
    <article><h2>去重后的页面</h2><div id="slides" class="slides"></div></article>
    <article><h2>逐字稿</h2><textarea id="transcript" placeholder="转写结果会分段出现在这里。"></textarea></article>
    <article><h2>Summary</h2><textarea id="summary" placeholder="summary 会出现在这里。"></textarea></article>
  </section>
`;

const $ = <T extends Element>(selector: string) => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing ${selector}`);
  return el;
};

const dropzone = $<HTMLLabelElement>('#dropzone');
const fileLabel = $<HTMLSpanElement>('#fileLabel');
const videoInput = $<HTMLInputElement>('#videoInput');
const processBtn = $<HTMLButtonElement>('#processBtn');
const downloadPdfBtn = $<HTMLButtonElement>('#downloadPdfBtn');
const downloadTranscriptBtn = $<HTMLButtonElement>('#downloadTranscriptBtn');
const downloadSummaryBtn = $<HTMLButtonElement>('#downloadSummaryBtn');
const statusEl = $<HTMLDivElement>('#status');
const progressPanel = $<HTMLDivElement>('#progressPanel');
const progressText = $<HTMLSpanElement>('#progressText');
const progressPercent = $<HTMLElement>('#progressPercent');
const progressFill = $<HTMLDivElement>('#progressFill');
const slidesEl = $<HTMLDivElement>('#slides');
const transcriptEl = $<HTMLTextAreaElement>('#transcript');
const summaryEl = $<HTMLTextAreaElement>('#summary');

let selectedFile: File | null = null;
let slides: Slide[] = [];
let pdfBlob: Blob | null = null;

videoInput.addEventListener('change', () => selectFile(videoInput.files?.[0] ?? null));
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
  selectFile(event.dataTransfer?.files?.[0] ?? null);
});

processBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  const settings = readSettings();
  resetOutputs();

  try {
    setBusy(true);
    setProgress('开始处理视频', 2);
    setStatus('正在抽帧并保守去重...');
    slides = await extractUniqueSlides(selectedFile, settings, setStatus);
    renderSlides(slides);

    setProgress('正在生成 PDF', 58);
    pdfBlob = await makePdf(slides);
    downloadPdfBtn.disabled = false;

    setProgress('准备本地分块转写音频', 62);
    setStatus('正在本地转写音频，会按 30 秒一段流式输出。');
    const transcriptText = await transcribeLocally(selectedFile, setStatus);
    downloadTranscriptBtn.disabled = !transcriptText;

    const transcriptForSummary = transcriptEl.value.trim();
    if (settings.summaryApiUrl && transcriptForSummary) {
      setProgress('正在请求 DeepSeek summary', 94, true);
      setStatus('正在请求 DeepSeek summary...');
      const summaryText = await summarizeWithApi(settings, transcriptForSummary);
      summaryEl.value = summaryText;
      downloadSummaryBtn.disabled = !summaryText;
    } else {
      summaryEl.value = '未配置 Summary API URL，或没有逐字稿可总结。';
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

downloadPdfBtn.addEventListener('click', () => { if (pdfBlob) downloadBlob(pdfBlob, 'vid2deck-slides.pdf'); });
downloadTranscriptBtn.addEventListener('click', () => downloadBlob(new Blob([transcriptEl.value], { type: 'text/plain;charset=utf-8' }), 'vid2deck-transcript.txt'));
downloadSummaryBtn.addEventListener('click', () => downloadBlob(new Blob([summaryEl.value], { type: 'text/markdown;charset=utf-8' }), 'vid2deck-summary.md'));

function selectFile(file: File | null): void {
  selectedFile = file;
  processBtn.disabled = !file;
  fileLabel.textContent = file ? `已选择：${file.name}` : '选择或拖入视频文件';
  setStatus(file ? `已选择：${file.name}` : '等待上传视频。');
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

async function extractUniqueSlides(file: File, settings: Settings, onProgress: (message: string) => void): Promise<Slide[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.preload = 'metadata';
  video.playsInline = true;

  try {
    await waitForEvent(video, 'loadedmetadata');
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('无法读取视频时长。请尝试转成 H.264 mp4 或 WebM 后再上传。');

    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('浏览器不支持 Canvas。');
    canvas.width = width;
    canvas.height = height;

    const kept: Slide[] = [];
    for (let t = 0; t < video.duration; t += settings.sampleEvery) {
      const framePercent = Math.min(55, Math.round((t / video.duration) * 55));
      setProgress(`抽帧保守去重：${formatTime(t)} / ${formatTime(video.duration)}`, Math.max(3, framePercent));
      onProgress(`抽帧中：${formatTime(t)} / ${formatTime(video.duration)}，已保留 ${kept.length} 张`);
      await seekVideo(video, Math.min(t, video.duration - 0.05));
      ctx.drawImage(video, 0, 0, width, height);
      const hash = visualHash(ctx, width, height);
      const nearDuplicate = kept.some((slide) => isDuplicateSlide(slide, hash, t, settings));
      if (!nearDuplicate) kept.push({ id: kept.length + 1, time: t, hash, dataUrl: canvas.toDataURL('image/jpeg', 0.9), width, height });
      await yieldToBrowser();
    }

    setProgress('抽帧去重完成', 56);
    return kept;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function isDuplicateSlide(slide: Slide, currentHash: bigint, currentTime: number, settings: Settings): boolean {
  const distancePercent = normalizedHashDistance(slide.hash, currentHash);
  const closeInTime = Math.abs(slide.time - currentTime) < settings.minGap;
  const threshold = closeInTime ? settings.duplicateThreshold * 1.15 : settings.duplicateThreshold;
  return distancePercent <= threshold;
}

function visualHash(ctx: CanvasRenderingContext2D, width: number, height: number): bigint {
  const brightnessHash = averageHashBits(ctx, width, height, 8);
  const edgeHash = differenceHashBits(ctx, width, height, 17, 16);
  return brightnessHash | (edgeHash << 64n);
}

function averageHashBits(ctx: CanvasRenderingContext2D, width: number, height: number, size: number): bigint {
  const grays = grayscaleThumbnail(ctx, width, height, size, size);
  const avg = grays.reduce((sum, value) => sum + value, 0) / grays.length;
  return grays.reduce((hash, value, index) => value >= avg ? hash | (1n << BigInt(index)) : hash, 0n);
}

function differenceHashBits(ctx: CanvasRenderingContext2D, width: number, height: number, hashWidth: number, hashHeight: number): bigint {
  const grays = grayscaleThumbnail(ctx, width, height, hashWidth, hashHeight);
  let hash = 0n;
  let bit = 0n;
  for (let y = 0; y < hashHeight; y += 1) {
    for (let x = 0; x < hashWidth - 1; x += 1) {
      const left = grays[y * hashWidth + x];
      const right = grays[y * hashWidth + x + 1];
      if (left >= right) hash |= 1n << bit;
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
  for (const [index, slide] of items.entries()) {
    if (index > 0) pdf.addPage();
    const ratio = Math.min(pageWidth / slide.width, pageHeight / slide.height);
    const drawWidth = slide.width * ratio;
    const drawHeight = slide.height * ratio;
    pdf.addImage(slide.dataUrl, 'JPEG', (pageWidth - drawWidth) / 2, (pageHeight - drawHeight) / 2, drawWidth, drawHeight);
  }
  return pdf.output('blob');
}

async function transcribeLocally(file: File, onProgress: (message: string) => void): Promise<string> {
  transcriptEl.value = '';
  const worker = new Worker(new URL('./transcribeWorker.ts', import.meta.url), { type: 'module' });

  try {
    const audio = await decodeToMono16k(file, onProgress);
    const chunkSeconds = 30;
    const sampleRate = 16000;
    const chunkSize = chunkSeconds * sampleRate;
    const totalChunks = Math.ceil(audio.length / chunkSize);
    let lastText = '';

    onProgress('加载本地 ASR 模型：Xenova/whisper-tiny...');
    setProgress('加载本地转写模型', 64, true);
    await loadTranscriptionWorker(worker);

    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * chunkSize;
      const end = Math.min(audio.length, start + chunkSize);
      const chunk = audio.slice(start, end);
      const startSec = start / sampleRate;
      const endSec = end / sampleRate;
      const basePercent = 66 + Math.round((index / Math.max(totalChunks, 1)) * 24);

      setProgress(`转写中：第 ${index + 1} / ${totalChunks} 段，${formatClock(startSec)} - ${formatClock(endSec)}`, basePercent, true);
      onProgress(`转写中：第 ${index + 1} / ${totalChunks} 段，${formatClock(startSec)} - ${formatClock(endSec)}`);

      if (rms(chunk) < 0.0035) {
        appendTranscript(`[${formatClock(startSec)} - ${formatClock(endSec)}] （静音或无明显语音，已跳过）`);
        await yieldToBrowser();
        continue;
      }

      const rawText = await transcribeChunk(worker, index, chunk);
      const cleanedText = cleanTranscriptText(rawText);
      if (cleanedText && !isNearDuplicate(cleanedText, lastText)) {
        appendTranscript(`[${formatClock(startSec)} - ${formatClock(endSec)}] ${cleanedText}`);
        lastText = cleanedText;
      }
      await yieldToBrowser();
    }

    setProgress('转写完成', 92);
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
  setProgress('正在解码音频', 60, true);
  const audioContext = new AudioContext();
  const audioBuffer = await audioContext.decodeAudioData(await file.arrayBuffer());
  await audioContext.close().catch(() => undefined);

  const channelCount = audioBuffer.numberOfChannels;
  const mono = new Float32Array(audioBuffer.length);
  for (let channel = 0; channel < channelCount; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) mono[i] += data[i] / channelCount;
  }

  if (audioBuffer.sampleRate === 16000) return mono;

  onProgress('正在重采样音频到 16kHz...');
  setProgress('正在重采样音频到 16kHz', 62, true);
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
      if (event.data.type === 'ready') {
        cleanup();
        resolve();
      } else if (event.data.type === 'error') {
        cleanup();
        reject(new Error(event.data.error));
      } else if (event.data.type === 'model-progress') {
        const pct = typeof event.data.progress === 'number' ? Math.round(event.data.progress) : undefined;
        const overall = typeof pct === 'number' ? 64 + Math.round(pct * 0.02) : undefined;
        setProgress(`加载转写模型：${event.data.status}`, overall, typeof overall !== 'number');
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error('转写 Worker 加载失败。'));
    };
    const cleanup = () => {
      worker.removeEventListener('message', onMessage as EventListener);
      worker.removeEventListener('error', onError);
    };
    worker.addEventListener('message', onMessage as EventListener);
    worker.addEventListener('error', onError);
    worker.postMessage({ type: 'load' });
  });
}

function transcribeChunk(worker: Worker, id: number, audio: Float32Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<WorkerResult>) => {
      if (event.data.type === 'result' && event.data.id === id) {
        cleanup();
        resolve(event.data.text);
      } else if (event.data.type === 'error' && event.data.id === id) {
        cleanup();
        reject(new Error(event.data.error));
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error('转写 Worker 运行失败。'));
    };
    const cleanup = () => {
      worker.removeEventListener('message', onMessage as EventListener);
      worker.removeEventListener('error', onError);
    };
    worker.addEventListener('message', onMessage as EventListener);
    worker.addEventListener('error', onError);
    worker.postMessage({ type: 'transcribe', id, audio }, [audio.buffer as ArrayBuffer]);
  });
}

function appendTranscript(line: string): void {
  transcriptEl.value = `${transcriptEl.value}${transcriptEl.value ? '\n' : ''}${line}`;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function rms(audio: Float32Array): number {
  let sum = 0;
  for (const value of audio) sum += value * value;
  return Math.sqrt(sum / Math.max(audio.length, 1));
}

function cleanTranscriptText(text: string): string {
  return text
    .replace(/([\s\S]{2,24})\1{2,}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

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

function setStatus(message: string): void { statusEl.textContent = message; }

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
    const cleanup = () => {
      target.removeEventListener(eventName, onSuccess);
      target.removeEventListener('error', onError);
    };
    const onSuccess = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('视频读取失败。浏览器可能不支持该编码。')); };
    target.addEventListener(eventName, onSuccess, { once: true });
    target.addEventListener('error', onError, { once: true });
  });
}

function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    const onSeeked = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('视频 seek 失败。')); };
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

function formatClock(seconds: number): string {
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600).toString().padStart(2, '0');
  const minutes = Math.floor((total % 3600) / 60).toString().padStart(2, '0');
  const secs = (total % 60).toString().padStart(2, '0');
  return `${hours}:${minutes}:${secs}`;
}

function yieldToBrowser(): Promise<void> { return new Promise((resolve) => setTimeout(resolve, 0)); }
