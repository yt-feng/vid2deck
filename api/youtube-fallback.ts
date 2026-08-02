import { createHmac } from 'node:crypto';
import { ClientType, Innertube, Platform } from 'youtubei.js';

type RequestPayload = {
  action?: 'video' | 'transcript';
  language?: string;
  rightsConfirmed?: boolean;
  url?: string;
};

type YoutubeFormat = {
  approx_duration_ms?: number;
  bitrate?: number;
  cipher?: string;
  content_length?: number;
  has_audio?: boolean;
  has_video?: boolean;
  height?: number;
  itag: number;
  mime_type?: string;
  quality_label?: string;
  signature_cipher?: string;
  url?: string;
};

type YoutubeInfo = {
  basic_info?: { title?: string };
  captions?: {
    caption_tracks?: Array<{
      base_url?: string;
      language_code?: string;
      name?: { toString?: () => string };
    }>;
  };
  download: (options: Record<string, unknown>) => Promise<ReadableStream<Uint8Array>>;
  streaming_data?: {
    adaptive_formats?: YoutubeFormat[];
    formats?: YoutubeFormat[];
  };
};

type CaptionEvent = {
  dDurationMs?: number;
  segs?: Array<{ utf8?: string }>;
  tStartMs?: number;
};

const MAX_DOWNLOAD_MB = positiveInteger(process.env.VID2PPT_CLOUD_MAX_DOWNLOAD_MB, 180);
const MAX_DOWNLOAD_BYTES = MAX_DOWNLOAD_MB * 1024 * 1024;
const VPS_REDIRECT_TTL_SECONDS = Math.min(
  positiveInteger(process.env.VID2PPT_VPS_REDIRECT_TTL_SECONDS, 300),
  600
);
const YOUTUBE_COOKIE_B64_ENV_NAMES = [
  'YOUTUBE_COOKIES_NETSCAPE_B64',
  'YOUTUBE_COOKIE_NETSCAPE_B64',
  'VID2PPT_YOUTUBE_COOKIES_NETSCAPE_B64'
];
const YOUTUBE_COOKIE_TEXT_ENV_NAMES = [
  'YOUTUBE_COOKIES_NETSCAPE',
  'YOUTUBE_COOKIE_NETSCAPE',
  'VID2PPT_YOUTUBE_COOKIES_NETSCAPE'
];

Platform.shim.eval = async (data: { output: string }, environment: Record<string, unknown> = {}) => {
  const names = Object.keys(environment);
  const values = Object.values(environment);
  return new Function(...names, data.output)(...values);
};

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export function GET(): Response {
  if (!urlImportEnabled()) {
    return jsonResponse({ detail: '在线视频链接下载功能当前未开放，请直接上传视频文件。' }, 410);
  }
  return jsonResponse({ ok: true, route: '/api/youtube-fallback' });
}

export async function POST(request: Request): Promise<Response> {
  if (!urlImportEnabled()) {
    return jsonResponse({ detail: '在线视频链接下载功能当前未开放，请直接上传视频文件。' }, 410);
  }
  try {
    const payload = await request.json() as RequestPayload;
    const videoId = youtubeVideoId(payload.url || '');
    if (!videoId) return jsonResponse({ detail: '请输入有效的 YouTube 视频链接。' }, 400);

    if (payload.action === 'transcript') {
      return await transcriptResponse(videoId, payload.language || '');
    }
    return await videoResponse(videoId);
  } catch (error) {
    console.error('youtube-fallback:', cleanError(error));
    return jsonResponse({ detail: friendlyError(error) }, 400);
  }
}

function urlImportEnabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes((process.env.VID2PPT_URL_IMPORT_ENABLED || '').trim().toLowerCase());
}

async function videoResponse(videoId: string): Promise<Response> {
  const errors: string[] = [];
  try {
    const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const vpsResponse = vpsVideoResponse(canonicalUrl);
    if (vpsResponse) return vpsResponse;
  } catch (error) {
    errors.push(`vps-ytdlp: ${cleanError(error)}`);
  }

  const cookie = youtubeCookieHeader();
  const attempts = [
    { client: ClientType.ANDROID, cookie: '' },
    { client: ClientType.MWEB, cookie: '' },
    ...(cookie ? [
      { client: ClientType.ANDROID, cookie },
      { client: ClientType.MWEB, cookie }
    ] : []),
    { client: ClientType.IOS, cookie: '' }
  ];
  for (const attempt of attempts) {
    try {
      const youtube = await createYoutube(attempt.client, attempt.cookie);
      const info = await youtube.getBasicInfo(videoId) as unknown as YoutubeInfo;
      const format = chooseFrameFormat(info);
      const type = format.has_audio ? 'video+audio' : 'video';
      const source = await info.download({ itag: format.itag, type, format: 'mp4' });
      const stream = await probeStream(source);
      const extension = format.mime_type?.includes('webm') ? 'webm' : 'mp4';
      const filename = safeFilename(`${info.basic_info?.title || videoId}-${videoId}.${extension}`);
      const headers = corsHeaders();
      headers.set('Cache-Control', 'no-store');
      headers.set('Content-Disposition', contentDisposition(filename));
      headers.set('Content-Type', format.mime_type?.split(';')[0] || `video/${extension}`);
      headers.set('X-Filename', asciiFilename(filename));
      headers.set('X-Estimated-Bytes', String(estimatedFormatBytes(format)));
      headers.set('X-YouTube-Engine', 'youtubei');
      if (format.content_length) headers.set('Content-Length', String(format.content_length));
      return new Response(stream, { status: 200, headers });
    } catch (error) {
      errors.push(`${attempt.client}${attempt.cookie ? '+cookie' : ''}: ${cleanError(error)}`);
    }
  }

  console.warn('youtube-video-attempts:', errors.join(' | '));
  const usefulError = errors.find((message) => !/No video format under \d+ MB/i.test(message));
  throw new Error(usefulError || errors.find(Boolean) || 'YouTube did not return a downloadable stream');
}

function vpsVideoResponse(canonicalUrl: string): Response | null {
  const endpoint = (process.env.VID2PPT_VPS_DOWNLOADER_URL || '').trim();
  const token = (process.env.VID2PPT_VPS_DOWNLOADER_TOKEN || '').trim();
  if (!endpoint && !token) return null;
  if (!endpoint || !token) throw new Error('VPS downloader configuration is incomplete');

  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new Error('VPS downloader URL is invalid');
  }
  if (endpointUrl.protocol !== 'https:') throw new Error('VPS downloader URL must use HTTPS');
  const expires = Math.floor(Date.now() / 1000) + VPS_REDIRECT_TTL_SECONDS;
  const message = `v1\n${expires}\n${canonicalUrl}`;
  const signature = createHmac('sha256', token).update(message, 'utf8').digest('hex');
  endpointUrl.searchParams.set('expires', String(expires));
  endpointUrl.searchParams.set('signature', signature);
  const headers = corsHeaders();
  headers.set('Location', endpointUrl.toString());
  headers.set('Cache-Control', 'no-store');
  headers.set('X-YouTube-Engine', 'vps-signed-redirect');
  return new Response(null, { status: 307, headers });
}

async function transcriptResponse(videoId: string, preferredLanguage: string): Promise<Response> {
  const cookies = ['', youtubeCookieHeader()].filter((value, index, values) => value || index === 0 && values.indexOf(value) === index);
  const errors: string[] = [];

  for (const cookie of cookies) {
    try {
      const youtube = await createYoutube(ClientType.WEB, cookie);
      const info = await youtube.getBasicInfo(videoId) as unknown as YoutubeInfo;
      const tracks = info.captions?.caption_tracks || [];
      if (tracks.length === 0) {
        return jsonResponse({ available: false, language: '', transcript: '' });
      }
      const track = tracks.find((item) => languageMatches(item.language_code || '', preferredLanguage)) || tracks[0];
      if (!track?.base_url) return jsonResponse({ available: false, language: '', transcript: '' });
      const captionUrl = new URL(track.base_url);
      captionUrl.searchParams.set('fmt', 'json3');
      const captionResponse = await fetch(captionUrl, { cache: 'no-store' });
      if (!captionResponse.ok) throw new Error(`Caption request failed: ${captionResponse.status}`);
      const data = await captionResponse.json() as { events?: CaptionEvent[] };
      const segments = captionSegments(data.events || []);
      return jsonResponse({
        available: segments.length > 0,
        language: track.language_code || '',
        segments,
        transcript: segments.map((segment) => segment.text).join(' ')
      });
    } catch (error) {
      errors.push(cleanError(error));
    }
  }

  console.warn('youtube-caption:', errors.join(' | '));
  return jsonResponse({ available: false, language: '', transcript: '' });
}

async function createYoutube(clientType: ClientType, cookie = ''): Promise<Innertube> {
  return Innertube.create({
    client_type: clientType,
    cookie: cookie || undefined,
    enable_session_cache: false,
    generate_session_locally: true
  });
}

function chooseFrameFormat(info: YoutubeInfo): YoutubeFormat {
  const formats = [
    ...(info.streaming_data?.formats || []),
    ...(info.streaming_data?.adaptive_formats || [])
  ].filter((format) => {
    const size = estimatedFormatBytes(format);
    return Boolean(
      format.has_video
      && (format.url || format.signature_cipher || format.cipher)
      && (!size || size <= MAX_DOWNLOAD_BYTES)
    );
  });
  formats.sort((left, right) => formatScore(right) - formatScore(left));
  const selected = formats[0];
  if (!selected) throw new Error(`No video format under ${MAX_DOWNLOAD_MB} MB`);
  return selected;
}

function formatScore(format: YoutubeFormat): number {
  const height = Number(format.height || 0);
  const usefulHeight = height > 0 && height <= 720 ? height : height > 720 ? 720 - height : 0;
  return (format.has_audio ? 20_000 : 0)
    + (format.mime_type?.includes('mp4') ? 10_000 : 0)
    + usefulHeight;
}

async function probeStream(source: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
  const reader = source.getReader();
  const first = await reader.read();
  if (first.done || !first.value?.byteLength) {
    await reader.cancel('empty stream').catch(() => undefined);
    throw new Error('YouTube returned an empty media stream');
  }
  let sentFirst = false;
  let received = first.value.byteLength;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentFirst) {
        sentFirst = true;
        controller.enqueue(first.value as Uint8Array);
        return;
      }
      try {
        const chunk = await reader.read();
        if (chunk.done) controller.close();
        else if (chunk.value) {
          received += chunk.value.byteLength;
          if (received > MAX_DOWNLOAD_BYTES) {
            await reader.cancel('download size limit');
            controller.error(new Error(`Video exceeded ${MAX_DOWNLOAD_MB} MB`));
            return;
          }
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    }
  });
}

function estimatedFormatBytes(format: YoutubeFormat): number {
  const exact = Number(format.content_length || 0);
  if (exact > 0) return Math.round(exact);
  const bitrate = Number(format.bitrate || 0);
  const durationMs = Number(format.approx_duration_ms || 0);
  if (bitrate > 0 && durationMs > 0) return Math.round((bitrate * durationMs) / 8000);
  return 0;
}

function captionSegments(events: CaptionEvent[]): Array<{ durationMs: number; startMs: number; text: string }> {
  const output: Array<{ durationMs: number; startMs: number; text: string }> = [];
  for (const event of events) {
    const text = (event.segs || [])
      .map((segment) => segment.utf8 || '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text || text === output[output.length - 1]?.text) continue;
    output.push({
      durationMs: Math.max(0, Number(event.dDurationMs || 0)),
      startMs: Math.max(0, Number(event.tStartMs || 0)),
      text
    });
  }
  return output;
}

function languageMatches(trackLanguage: string, preferredLanguage: string): boolean {
  const normalized = preferredLanguage.toLowerCase();
  if (!normalized) return false;
  if (normalized === 'zh-cn') return trackLanguage.toLowerCase() === 'zh-hans';
  if (normalized === 'zh-tw') return trackLanguage.toLowerCase() === 'zh-hant';
  return trackLanguage.toLowerCase().startsWith(normalized.split('-')[0]);
}

function youtubeVideoId(value: string): string {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    let candidate = '';
    if (host === 'youtu.be') candidate = url.pathname.split('/').filter(Boolean)[0] || '';
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      candidate = url.searchParams.get('v') || '';
      if (!candidate) {
        const parts = url.pathname.split('/').filter(Boolean);
        if (['shorts', 'embed', 'live'].includes(parts[0])) candidate = parts[1] || '';
      }
    }
    return /^[A-Za-z0-9_-]{11}$/.test(candidate) ? candidate : '';
  } catch {
    return '';
  }
}

function youtubeCookieHeader(): string {
  for (const name of YOUTUBE_COOKIE_B64_ENV_NAMES) {
    const value = (process.env[name] || '').trim();
    if (!value) continue;
    try {
      return netscapeCookieHeader(decodeBase64(value));
    } catch {
      continue;
    }
  }
  for (const name of YOUTUBE_COOKIE_TEXT_ENV_NAMES) {
    const value = (process.env[name] || '').trim();
    if (value) return netscapeCookieHeader(value);
  }
  return '';
}

function decodeBase64(value: string): string {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function netscapeCookieHeader(value: string): string {
  const normalized = value.includes('\\n') && !value.includes('\n') ? value.replace(/\\n/g, '\n') : value;
  if (!normalized.includes('\t') && normalized.includes('=')) return normalized.replace(/[\r\n]+/g, '; ');
  return normalized
    .split(/\r?\n/)
    .map((line) => line.startsWith('#HttpOnly_') ? line.slice('#HttpOnly_'.length) : line)
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('\t'))
    .filter((fields) => fields.length >= 7 && fields[0].toLowerCase().includes('youtube.com'))
    .map((fields) => `${fields[5]}=${fields[6]}`)
    .join('; ');
}

function corsHeaders(): Headers {
  return new Headers({
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Origin': process.env.CORS_ORIGINS || '*',
    'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length, X-Estimated-Bytes, X-Filename, X-YouTube-Engine'
  });
}

function jsonResponse(payload: unknown, status = 200): Response {
  const headers = corsHeaders();
  headers.set('Cache-Control', 'no-store');
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(payload), { status, headers });
}

function safeFilename(value: string): string {
  return value
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'youtube-video.mp4';
}

function asciiFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[_\.]+|[_\.]+$/g, '').slice(0, 160) || 'youtube-video.mp4';
}

function contentDisposition(filename: string): string {
  return `attachment; filename="${asciiFilename(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error || '')).replace(/\s+/g, ' ').trim();
}

function friendlyError(error: unknown): string {
  const message = cleanError(error);
  if (/exceeded \d+ MB|larger than max(?:imum)?(?: file)?size|File is larger/i.test(message)) {
    return `视频文件超过 ${MAX_DOWNLOAD_MB} MB，请换短视频或先裁剪。`;
  }
  if (/unavailable|private|login|required/i.test(message)) return '这个 YouTube 视频需要登录或当前不可用。';
  if (/403|forbidden/i.test(message)) return 'YouTube 暂时拒绝了云端视频请求，请稍后重试。';
  return 'YouTube 备用引擎暂时没有返回可处理的视频流，请稍后重试。';
}
