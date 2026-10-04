import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/videoNotes.ts', import.meta.url), 'utf8');
function loadNotes(language) {
  const dictionary = JSON.parse(readFileSync(new URL('../src/workspaceEnglish.json', import.meta.url), 'utf8'));
  const locale = createContext({ exports: {}, console, window: { Vid2PPTLocale: { current: language } },
    require: (name) => { assert.equal(name, './workspaceEnglish.json'); return dictionary; } });
  runInContext(ts.transpileModule(readFileSync(new URL('../src/workspaceI18n.ts', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText, locale);
  const context = createContext({ exports: {}, require: (name) => {
    assert.equal(name, './workspaceI18n'); return locale.exports;
  } });
  runInContext(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
  }).outputText, context);
  return context.exports;
}
const { buildVideoNoteHtml, buildVideoNoteMarkdown, formatNoteTime } = loadNotes('zh-CN');

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const frame = (id, time, selected = true) => ({ id, time, selected, dataUrl: png, textBoxes: [{ text: `frame ${id} text` }] });
const input = (overrides = {}) => ({ title: 'source-lecture.mp4', duration: 3720, frames: [frame(1, 10), frame(2, 80)], summary: '', notes: '', isDemo: false, ...overrides });

test('English export chrome and language preserve Chinese source, authored notes, OCR and frame order', () => {
  const en = loadNotes('en');
  const value = input({ title: '原始课程.mp4', isDemo: true, notes: '# 用户写的标题\n- 登录\n- 本地文件',
    frames: [{ ...frame(3, 120), textBoxes: [{ text: '编辑与笔记 用户原文 {{0}}' }] }, frame(1, 10)] });
  const before = JSON.stringify(value);
  const html = en.buildVideoNoteHtml(value);
  const markdown = en.buildVideoNoteMarkdown(value);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /Key frames/);
  assert.match(html, /Built-in sample/);
  assert.match(markdown, /## Key frame index/);
  assert.match(markdown, /Source: 原始课程(?:\\)?\.mp4/);
  for (const result of [html, markdown]) {
    assert.match(result, /用户写的标题/);
    assert.match(result, /登录/);
    assert.match(result, /本地文件/);
    assert.match(result, /编辑与笔记 用户原文/);
    assert.ok(result.indexOf('02:00') < result.indexOf('00:10'));
    assert.ok(result.includes(png) || result === markdown);
    assert.doesNotMatch(result, /原视频时长|关键画面索引|画面文字（识别/);
  }
  assert.equal(JSON.stringify(value), before);
  assert.match(en.buildVideoNoteHtml(input({ title: '', frames: [] })), /Untitled video/);
  assert.match(en.buildVideoNoteMarkdown(input({ frames: [] })), /No key frames selected/);
});

test('both exports retain only selected frames in the user-arranged order without changing inputs', () => {
  const value = input({ frames: [frame(3, 120), frame(2, 80, false), frame(1, 10)] });
  const before = JSON.stringify(value);
  for (const result of [buildVideoNoteHtml(value), buildVideoNoteMarkdown(value)]) {
    assert.ok(result.indexOf('frame 3 text') < result.indexOf('frame 1 text'));
    assert.doesNotMatch(result, /frame 2 text/);
    assert.match(result, /02:00/);
    assert.match(result, /00:10/);
    assert.match(result, /01:02:00/);
  }
  assert.equal((buildVideoNoteHtml(value).match(/<img /g) ?? []).length, 2);
  assert.equal(JSON.stringify(value), before);
});

test('empty selection stays empty even when unselected frames exist', () => {
  const value = input({ frames: [frame(9, 5, false)] });
  for (const result of [buildVideoNoteHtml(value), buildVideoNoteMarkdown(value)]) {
    assert.match(result, /未选择关键画面/);
    assert.doesNotMatch(result, /frame 9 text/);
    assert.doesNotMatch(result, /<img /);
  }
});

test('existing notes take priority and summary is available when no full notes exist', () => {
  for (const build of [buildVideoNoteHtml, buildVideoNoteMarkdown]) {
    const notes = build(input({ notes: '# 实际观点\n- **关键证据**\n\n来自原文。', summary: '旧摘要不重复' }));
    assert.match(notes, /实际观点/);
    assert.match(notes, /关键证据/);
    assert.doesNotMatch(notes, /旧摘要不重复/);
    assert.doesNotMatch(notes, /尚未包含语音摘要/);
    assert.match(build(input({ notes: '  ', summary: '只有摘要内容' })), /只有摘要内容/);
  }
  const html = buildVideoNoteHtml(input({ notes: '# 实际观点\n- **关键证据**\n- `原文术语`' }));
  assert.match(html, /<h2>实际观点<\/h2>/);
  assert.match(html, /<ul>[\s\S]*<strong>关键证据<\/strong>[\s\S]*<\/ul>/);
  assert.match(html, /<code>原文术语<\/code>/);
});

test('visual-only notes describe available content without inventing insights or time savings', () => {
  for (const result of [buildVideoNoteHtml(input()), buildVideoNoteMarkdown(input())]) {
    assert.match(result, /尚未包含语音摘要/);
    assert.doesNotMatch(result, /核心观点|先记住|节省|阅读耗时/);
  }
});

test('HTML treats title, notes and OCR as inert text and never renders untrusted links', () => {
  const attack = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const value = input({
    title: `${attack}.mp4`,
    notes: `# ${attack}\n[bad](javascript:alert(3))\n**${attack}**`,
    frames: [{ ...frame(1, 10), textBoxes: [{ text: attack }] }]
  });
  const html = buildVideoNoteHtml(value);
  assert.doesNotMatch(html, /<script|<img src=x|href="javascript:|onerror="alert/);
  assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.equal((html.match(/<a /g) ?? []).length, 1, 'only the fixed product link is active');
  assert.equal((html.match(/<img /g) ?? []).length, 1, 'only the selected raster frame becomes an image');
});

test('Markdown keeps raw HTML and untrusted links inert while preserving note headings', () => {
  const markdown = buildVideoNoteMarkdown(input({
    title: 'original\n# injected.mp4',
    notes: '# Real topic\n<img src=x>\n\\[label](javascript:alert(1))\n![image](https://outside.example/image.png)',
    frames: [{ ...frame(1, 4), textBoxes: [{ text: '[OCR](javascript:alert(1))\n# hostile heading' }] }]
  }));
  assert.match(markdown, /# Real topic/);
  assert.match(markdown, /&lt;img src=x&gt;/);
  assert.match(markdown, /&#91;label&#93;/);
  assert.doesNotMatch(markdown, /\n# injected|<img |!\[image\]/);
  assert.match(markdown, /\\\[OCR\\\]/);
  assert.match(markdown, /https:\/\/vid2ppt\.com\//);
});

test('HTML embeds only allowlisted raster data URLs and keeps rejected frame captions', () => {
  const invalid = [
    'https://external.example/track.png',
    'javascript:alert(1)',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'data:text/html;base64,PHNjcmlwdD4=',
    `${png}" onerror="alert(1)`,
    'blob:private-session-frame'
  ];
  const value = input({ frames: invalid.map((dataUrl, index) => ({ ...frame(index, index), dataUrl })) });
  const html = buildVideoNoteHtml(value);
  assert.equal((html.match(/<img /g) ?? []).length, 0);
  assert.equal((html.match(/<figure>/g) ?? []).length, invalid.length);
  assert.doesNotMatch(html, /external\.example|onerror|<script|blob:private-session/);
  const raster = buildVideoNoteHtml(input({ frames: ['png', 'jpeg', 'webp'].map((type, index) => ({ ...frame(index, index), dataUrl: `data:image/${type};base64,AAAA` })) }));
  assert.equal((raster.match(/<img /g) ?? []).length, 3);
});

test('source identity and demo marker survive both export formats', () => {
  for (const build of [buildVideoNoteHtml, buildVideoNoteMarkdown]) {
    const demo = build(input({ title: '原始课程.mov', isDemo: true }));
    assert.match(demo, /原始课程(?:\\)?\.mov/);
    assert.match(demo, /内置示例/);
    assert.match(demo, /使用专门编写的演示内容/);
    assert.doesNotMatch(build(input()), /内置示例/);
  }
});

test('timestamps support long videos and normalize invalid or fractional positions', () => {
  assert.equal(formatNoteTime(9.99), '00:09');
  assert.equal(formatNoteTime(3661), '01:01:01');
  assert.equal(formatNoteTime(-5), '00:00');
  assert.equal(formatNoteTime(Number.NaN), '00:00');
  assert.equal(formatNoteTime(Number.POSITIVE_INFINITY), '00:00');
});
