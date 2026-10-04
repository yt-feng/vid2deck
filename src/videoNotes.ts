import { ui, workspaceLanguage } from './workspaceI18n';

export type VideoNoteFrame = {
  id: number;
  time: number;
  dataUrl: string;
  selected: boolean;
  textBoxes?: { text: string }[];
};

export type VideoNoteInput = {
  title: string;
  duration: number;
  frames: VideoNoteFrame[];
  summary: string;
  notes: string;
  isDemo: boolean;
};

const PRODUCT_URL = 'https://vid2ppt.com/';
const DEMO_NOTICE = ui('内置示例 · 使用专门编写的演示内容，供体验阅读与导出。');
const VISUAL_ONLY_NOTICE = ui('这份笔记收录了你选中的关键画面，尚未包含语音摘要。生成逐字稿后，可以继续补充内容要点。');

export function formatNoteTime(seconds: number): string {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainder = value % 60;
  const pair = (part: number) => String(part).padStart(2, '0');
  return hours > 0 ? `${pair(hours)}:${pair(minutes)}:${pair(remainder)}` : `${pair(minutes)}:${pair(remainder)}`;
}

function sourceName(input: VideoNoteInput): string {
  return input.title.trim() || ui('未命名视频');
}

function noteTitle(input: VideoNoteInput): string {
  return ui`${sourceName(input).replace(/\.(mp4|mov|m4v|webm|mkv|avi|mp3|m4a|wav|aac|ogg)$/i, '')} · 视频笔记`;
}

function selectedFrames(input: VideoNoteInput): VideoNoteFrame[] {
  // Keep the user's current page order, including deliberate manual reordering.
  return input.frames.filter((frame) => frame.selected);
}

function frameText(frame: VideoNoteFrame): string {
  return (frame.textBoxes ?? []).map((box) => box.text.trim()).filter(Boolean).join('\n\n');
}

function contentNote(input: VideoNoteInput): { label: string; text: string } | null {
  if (input.notes.trim()) return { label: ui('内容笔记'), text: input.notes.trim() };
  if (input.summary.trim()) return { label: ui('内容摘要'), text: input.summary.trim() };
  return null;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeMarkdown(value: string): string {
  return escapeHtml(value).replace(/([\\`*_{}\[\]()#+\-.!|])/g, '\\$1');
}

function safeMarkdownContent(value: string): string {
  // Preserve headings and lists but keep HTML, links and embedded images inert.
  return escapeHtml(value).replace(/\[/g, '&#91;').replace(/\]/g, '&#93;');
}

function renderInline(value: string): string {
  return value.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part) => {
    if (part.startsWith('**') && part.endsWith('**')) return `<strong>${escapeHtml(part.slice(2, -2))}</strong>`;
    if (part.startsWith('`') && part.endsWith('`')) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
    return escapeHtml(part);
  }).join('');
}

function renderNoteContent(value: string): string {
  const result: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  const closeList = () => {
    if (list) result.push(`</${list}>`);
    list = null;
  };
  for (const rawLine of value.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line) { closeList(); continue; }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    const unordered = line.match(/^[-*+]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (heading) {
      closeList();
      const level = Math.min(4, heading[1].length + 1);
      result.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
    } else if (unordered || ordered) {
      const type = ordered ? 'ol' : 'ul';
      if (list !== type) { closeList(); list = type; result.push(`<${type}>`); }
      result.push(`<li>${renderInline((ordered ?? unordered)![1])}</li>`);
    } else {
      closeList();
      const quote = line.match(/^>\s?(.*)$/);
      result.push(quote ? `<blockquote>${renderInline(quote[1])}</blockquote>` : `<p>${renderInline(line)}</p>`);
    }
  }
  closeList();
  return result.join('\n');
}

function safeFrameImage(dataUrl: string): string | null {
  return /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/]+={0,2}$/i.test(dataUrl) ? dataUrl : null;
}

export function buildVideoNoteMarkdown(input: VideoNoteInput): string {
  const frames = selectedFrames(input);
  const content = contentNote(input);
  const lines = [
    `# ${escapeMarkdown(noteTitle(input)).replace(/\r?\n/g, ' ')}`,
    '',
    ui`来源：${escapeMarkdown(sourceName(input)).replace(/\r?\n/g, ' ')}`,
    ...(Number.isFinite(input.duration) && input.duration > 0 ? [ui`原视频时长：${formatNoteTime(input.duration)}`] : []),
    ui`选中画面：${frames.length} 页`,
    '',
  ];
  if (input.isDemo) lines.push(`> ${DEMO_NOTICE}`, '');
  if (content) lines.push(`## ${content.label}`, '', safeMarkdownContent(content.text), '');
  else lines.push(VISUAL_ONLY_NOTICE, '');
  lines.push(ui('## 关键画面索引'), '', ui('时间对应原视频；画面按你整理的顺序排列。完整画面保存在 HTML 图文笔记中。'), '');
  if (!frames.length) lines.push(ui('未选择关键画面。'), '');
  frames.forEach((frame, index) => {
    lines.push(`### ${index + 1}. ${formatNoteTime(frame.time)}`, '');
    const text = frameText(frame);
    if (text) lines.push(ui('画面文字（识别 / 编辑）：'), '', escapeMarkdown(text), '');
  });
  lines.push('---', '', ui`由 [Vid2PPT](${PRODUCT_URL}) 整理 · 把视频里的重点，变成可回看的笔记。`, '');
  return lines.join('\n');
}

export function buildVideoNoteHtml(input: VideoNoteInput): string {
  const frames = selectedFrames(input);
  const content = contentNote(input);
  const title = escapeHtml(noteTitle(input));
  const duration = Number.isFinite(input.duration) && input.duration > 0 ? ui`<span>原视频 ${formatNoteTime(input.duration)}</span>` : '';
  const figures = frames.map((frame, index) => {
    const image = safeFrameImage(frame.dataUrl);
    const text = frameText(frame);
    return ui`<figure>
      <figcaption><span class="frame-number">${String(index + 1).padStart(2, '0')}</span><span>原视频 ${formatNoteTime(frame.time)}</span></figcaption>
      ${image ? ui`<img src="${image}" alt="选中画面 ${index + 1}，原视频 ${formatNoteTime(frame.time)}" />` : ui('<p class="muted">此画面未包含可导出的图片。</p>')}
      ${text ? ui`<div class="frame-text"><small>画面文字（识别 / 编辑）</small><p>${escapeHtml(text).replace(/\n/g, '<br />')}</p></div>` : ''}
    </figure>`;
  }).join('\n');
  return ui`<!doctype html>
<html lang="${workspaceLanguage()}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <title>${title}</title>
  <style>
    :root{font-family:Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#1c2c38;background:#edf1ee;font-synthesis:none}
    *{box-sizing:border-box}body{margin:0;padding:40px 20px}main{max-width:880px;margin:auto;background:#fff;padding:52px 60px;border:1px solid #dce4df;border-radius:18px}
    .eyebrow{font-size:12px;letter-spacing:.12em;font-weight:750;color:#28744d}h1{font-size:36px;line-height:1.3;letter-spacing:-.025em;margin:14px 0 20px;overflow-wrap:anywhere}
    .source{font-size:14px;color:#5c6a62;overflow-wrap:anywhere}.metadata{display:flex;flex-wrap:wrap;gap:10px 20px;margin:12px 0 28px;color:#617267;font-size:13px}.notice{padding:14px 18px;background:#f0f6f1;border-radius:10px;font-size:14px;line-height:1.7}
    section{margin-top:36px}h2{font-size:24px;line-height:1.4;margin:30px 0 14px}h3{font-size:20px;margin:26px 0 12px}h4{font-size:18px}p,li,blockquote{font-size:16px;line-height:1.85;overflow-wrap:anywhere}p{margin:10px 0}li{margin:5px 0}ul,ol{padding-left:24px}blockquote{margin:18px 0;padding:10px 18px;border-left:3px solid #89b698;background:#f7faf7}
    .section-heading{display:flex;align-items:baseline;justify-content:space-between;gap:16px;border-top:1px solid #dce4df;padding-top:24px}.section-heading h2{margin:0}.muted{color:#66776b;font-size:13px}code{padding:2px 5px;border-radius:4px;background:#f0f3f1;font-size:.9em}
    figure{margin:22px 0 30px;border:1px solid #dce4df;border-radius:10px;overflow:hidden}figure img{display:block;width:100%;height:auto}figcaption{display:flex;align-items:center;gap:12px;padding:12px 16px;background:#f7f9f7;color:#52675b;font-size:13px}.frame-number{font-weight:750;color:#28744d}.frame-text{padding:16px 20px;border-top:1px solid #e5eae6}.frame-text small{color:#64766a}.frame-text p{white-space:normal;font-size:14px}figure>.muted{padding:16px}
    footer{border-top:1px solid #dce4df;margin-top:40px;padding-top:24px;color:#64766a;font-size:13px;line-height:1.8}footer a{color:#28744d;font-weight:750;text-decoration:none}
    @media(max-width:640px){body{padding:0;background:#fff}main{padding:30px 20px;border:0;border-radius:0}h1{font-size:29px}.section-heading{display:block}}
    @media print{body{padding:0;background:#fff}main{max-width:none;padding:0;border:0; border-radius:0}figure{break-inside:avoid}h2,h3,h4{break-after:avoid}footer{margin-top:24px}a{color:inherit}}
  </style>
</head>
<body><main>
  <header><div class="eyebrow">VID2PPT · VIDEO NOTES</div><h1>${title}</h1><p class="source">来源：${escapeHtml(sourceName(input))}</p><div class="metadata">${duration}<span>选中画面 ${frames.length} 页</span></div>${input.isDemo ? `<p class="notice">${DEMO_NOTICE}</p>` : ''}</header>
  ${content ? `<section class="content-note" aria-label="${content.label}">${renderNoteContent(content.text)}</section>` : `<p class="notice">${VISUAL_ONLY_NOTICE}</p>`}
  <section aria-label="关键画面"><div class="section-heading"><h2>关键画面</h2><span class="muted">保留原视频时间，方便回看</span></div><p class="muted">画面按你整理的顺序排列，供对照原视频；未自动匹配到上文段落。</p>${frames.length ? figures : ui('<p class="muted">未选择关键画面。</p>')}</section>
  <footer>由 <a href="${PRODUCT_URL}" target="_blank" rel="noopener noreferrer">Vid2PPT</a> 整理<br />把视频里的重点，变成可回看的笔记。</footer>
</main></body>
</html>`;
}
