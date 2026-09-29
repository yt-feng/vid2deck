import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { constants as vmConstants, createContext, runInContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import JSZip from 'jszip';
import { jsPDF } from 'jspdf';
import { loadConfigFromFile } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const mainText = readFileSync(resolve(root, 'src/main.ts'), 'utf8');
const mainAst = ts.createSourceFile('main.ts', mainText, ts.ScriptTarget.ES2020, true);
const functionSource = mainAst.statements.filter(ts.isFunctionDeclaration)
  .filter((node) => node.name?.text !== 'transcribeLocally') // Browser worker creation is an I/O boundary.
  .map((node) => node.getText(mainAst)).join('\n');
const constantNames = new Set(['VISUAL_HASH_BITS', 'FRAME_CONCURRENCY', 'PPTX_SLIDE_WIDTH_EMU', 'PPTX_SLIDE_HEIGHT_EMU']);
const constantSource = mainAst.statements.filter((node) => ts.isVariableStatement(node)
  && node.declarationList.declarations.some((decl) => constantNames.has(decl.name.getText(mainAst))))
  .map((node) => node.getText(mainAst)).join('\n');
const coreJavaScript = ts.transpileModule(`${constantSource}\n${functionSource}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
}).outputText;

// Run the actual application function declarations. Only browser I/O is replaced;
// there is no copied implementation of conversion, packaging, or job orchestration.
function workspace(overrides = {}) {
  const noOp = () => {};
  const context = createContext({
    Blob, File, URL, AbortController, DOMException, Uint8Array, ArrayBuffer, setTimeout, clearTimeout, JSZip, jsPDF, Error,
    console: { ...console, error: noOp },
    selectedFile: { name: 'lecture.mp4', type: 'video/mp4' }, currentFileIndex: 0,
    selectedFiles: [], selectedImageFiles: [], slides: [], videoMeta: null,
    transcriptEl: { value: 'Original transcript' },
    summaryEl: { value: '' }, illustratedNotesMarkdown: '',
    homeView: {}, workspaceView: {}, workspaceMode: 'video',
    isDemoProject: false, undoSnapshot: null, activeSlideId: null, activeTextBoxId: null,
    isExtracting: false, isBatchProcessing: false, isUrlDownloading: false,
    isTranscribing: false, isSummarizing: false, isGeneratingNotes: false,
    isOcrRunning: false, isPdfMasking: false, isRecording: false, isPreparingRecording: false,
    isTipCheckoutOpening: false, isAuthBusy: false, isExporting: false,
    ...overrides
  });
  runInContext(coreJavaScript, context, { importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  context.sourceFunctions = runInContext('({ scheduleDraftSave, persistWorkspaceToState, loadStateIntoWorkspace })', context);
  Object.assign(context, {
    updateActionState: noOp, renderFileList: noOp, renderImageFileList: noOp,
    renderSlides: noOp, setProgress: noOp, setStatus: noOp, setHomeStatus: noOp,
    setImageStatus: noOp, persistWorkspaceToState: noOp, loadStateIntoWorkspace: noOp,
    setPreview: noOp, setupTimeline: noOp, recordUsage: async () => {},
    yieldToBrowser: async () => {}, scheduleDraftSave: noOp, hideProgress: noOp,
    ...overrides
  });
  return context;
}

function mainListener(app, selector, eventName = 'click') {
  const statement = mainAst.statements.find((node) => node.getText(mainAst).startsWith('$')
    && node.getText(mainAst).includes(`('${selector}').addEventListener('${eventName}'`));
  assert.ok(statement, `missing actual ${selector} listener`);
  let handler;
  app.$ = () => ({ addEventListener: (_, callback) => { handler = callback; } });
  runInContext(ts.transpileModule(statement.getText(mainAst), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, app);
  return handler;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const pixelPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const box = { id: 'editable', text: '中文 & <editable>\nSecond line', x: 10, y: 15, width: 60, height: 20, fontSize: 24, color: '#163a5f', bold: true, align: 'left' };
function slide(id, time = id) {
  return { id, time, hash: BigInt(id), dataUrl: pixelPng, width: 1600, height: 900, selected: true, textBoxes: [{ ...box, text: `${id}: ${box.text}` }] };
}

test('parallel extraction commits chronological frames and removes duplicate imagery', async () => {
  const captures = [];
  const disposed = [];
  const kept = [];
  const revoked = [];
  let extractorNumber = 0;
  const hashes = [0n, 0n, (1n << 320n) - 1n, (1n << 160n) - 1n];
  const app = workspace({
    URL: { createObjectURL: () => 'blob:local-video', revokeObjectURL: (url) => revoked.push(url) },
    readVideoMetadata: async () => ({ duration: 4, width: 1600, height: 900 }),
    createFrameExtractor: async () => {
      const worker = extractorNumber++;
      return {
        capture: async (index, time) => {
          await new Promise((done) => setTimeout(done, index === 0 ? 25 : 1));
          captures.push(index);
          return { index, time, hash: hashes[index], dataUrl: pixelPng, width: 1600, height: 900 };
        },
        dispose: () => disposed.push(worker)
      };
    }
  });
  const result = await app.extractSlidesFromFile({}, { sampleEvery: 1, minGap: 1, duplicateThreshold: 5 }, { onKeep: (frame) => kept.push(frame.time) });
  assert.notEqual(captures[0], 0, 'fixture must actually finish frames out of order');
  assert.deepEqual(kept, [0, 2, 3]);
  assert.deepEqual(Array.from(result.slides, (frame) => frame.time), [0, 2, 3]);
  assert.ok(result.slides.every((frame) => frame.selected));
  assert.equal(disposed.length, 3);
  assert.deepEqual(revoked, ['blob:local-video']);
});

test('extraction releases already-created decoders and source URL when setup fails', async () => {
  let created = 0;
  let disposed = 0;
  let revoked = false;
  const app = workspace({
    URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL: () => { revoked = true; } },
    readVideoMetadata: async () => ({ duration: 4, width: 1600, height: 900 }),
    createFrameExtractor: async () => {
      if (++created === 3) throw new Error('unsupported codec');
      return { dispose: () => { disposed += 1; } };
    }
  });
  await assert.rejects(app.extractSlidesFromFile({}, { sampleEvery: 1 }), /unsupported codec/);
  assert.equal(disposed, 2);
  assert.equal(revoked, true);
});

test('cancelled extraction retains completed pages and waits for all decoders before releasing them', async () => {
  const controller = new AbortController();
  const frames = [];
  let activeCaptures = 0;
  let disposed = 0;
  let cleanedWhileCapturing = false;
  const app = workspace({
    URL: { createObjectURL: () => 'blob:cancel', revokeObjectURL: () => {} },
    readVideoMetadata: async () => ({ duration: 10, width: 1600, height: 900 }),
    createFrameExtractor: async () => ({
      capture: async (index, time) => {
        activeCaptures += 1;
        await new Promise((done) => setTimeout(done, index === 0 ? 1 : 15));
        activeCaptures -= 1;
        return { ...slide(index + 1, time), index };
      },
      dispose: () => { disposed += 1; if (activeCaptures > 0) cleanedWhileCapturing = true; }
    })
  });
  await assert.rejects(app.extractSlidesFromFile({}, { sampleEvery: 1, minGap: 1, duplicateThreshold: 0 }, {
    signal: controller.signal, onKeep: (frame) => { frames.push(frame); controller.abort(); }
  }), { name: 'AbortError' });
  assert.equal(frames.length, 1);
  assert.equal(disposed, 3);
  assert.equal(cleanedWhileCapturing, false);
  assert.equal(activeCaptures, 0);
});

test('failed re-extraction restores edited page content/order and does not charge usage', async () => {
  const originals = [slide(8), { ...slide(2), selected: false }];
  const states = new Map();
  let charged = 0;
  const app = workspace({
    slides: originals,
    $: () => ({}), setWorkspaceMode: () => {}, showWorkspace: () => {},
    ensureUsageCapacity: async () => true, ensureVideoDurationAllowed: async () => true,
    readSettings: () => ({}), setStateStatus: () => {},
    setStateForFile: (file, state) => states.set(file, state),
    appendSlideCard: () => {}, updateSelectionUI: () => {}, updateTimelineMarkers: () => {},
    extractSlidesFromFile: async (_file, _settings, hooks) => { hooks.onKeep(slide(99)); throw new Error('codec stopped'); },
    recordUsage: async () => { charged += 1; }
  });
  app.resetFrameOutputs = () => { app.slides = []; };
  app.loadStateIntoWorkspace = (file) => { app.slides = app.cloneSlides(states.get(file).slides); };
  assert.equal(await app.processCurrentFile(), false);
  assert.deepEqual(Array.from(app.slides, (frame) => frame.id), [8, 2]);
  assert.equal(app.slides[1].selected, false);
  assert.equal(app.slides[0].textBoxes[0].text, originals[0].textBoxes[0].text);
  assert.equal(charged, 0);
  assert.equal(app.isBusy(), false);
});

test('audio sources open transcription controls without starting video extraction or conversion quota checks', async () => {
  for (const file of [
    new File(['audio'], 'recording', { type: 'audio/mpeg' }),
    new File(['audio'], 'recording.MP3', { type: '' })
  ]) {
    const notes = { open: false };
    const importPanel = { hidden: false };
    const importButton = { setAttribute: (name, value) => { assert.equal(name, 'aria-expanded'); assert.equal(value, 'false'); } };
    const expanded = [];
    let opened = false;
    let status = '';
    const app = workspace({
      selectedFile: file,
      showWorkspace: () => { opened = true; },
      workspaceView: { classList: { remove: (name) => expanded.push(name) } },
      $: (selector) => {
        const controls = { '.notes-disclosure': notes, '#workspaceImport': importPanel, '#toggleImportBtn': importButton };
        assert.ok(selector in controls);
        return controls[selector];
      },
      toggleSideBtn: { setAttribute: (name, value) => { assert.equal(name, 'aria-expanded'); assert.equal(value, 'true'); } },
      ensureUsageCapacity: async () => assert.fail('audio must not consume video conversion quota'),
      extractSlidesFromFile: async () => assert.fail('audio must not enter frame extraction'),
      setStatus: (message) => { status = message; }
    });
    assert.equal(await app.processCurrentFile(), false);
    assert.equal(opened, true);
    assert.equal(notes.open, true);
    assert.equal(importPanel.hidden, true);
    assert.deepEqual(expanded, ['side-collapsed']);
    assert.match(status, /音频文件.*转写/);
    assert.equal(app.isBusy(), false);
  }
});

test('export locks repeated clicks and freezes selected pages and filename before async packaging', async () => {
  const packaging = deferred();
  let calls = 0;
  let packaged;
  let downloaded;
  const app = workspace({
    slides: [slide(3), { ...slide(2), selected: false }, slide(1)],
    makePptx: (items) => { calls += 1; packaged = items; return packaging.promise; },
    downloadBlob: (_blob, name) => { downloaded = name; }
  });
  const task = app.exportSelected('pptx');
  assert.equal(app.isBusy(), true);
  await app.exportSelected('pptx');
  assert.equal(calls, 1);
  app.selectedFile = { name: 'different.mp4' };
  app.slides[0].textBoxes[0].text = 'changed during export';
  assert.deepEqual(Array.from(packaged, (frame) => frame.id), [3, 1]);
  assert.notEqual(packaged[0].textBoxes[0].text, 'changed during export');
  packaging.resolve(new Blob(['fixture']));
  await task;
  assert.equal(downloaded, 'lecture.pptx');
  assert.equal(app.isBusy(), false);
});

test('delete keeps manual order and stable IDs; the actual undo control restores the edit', () => {
  const app = workspace({ slides: [slide(8), slide(2), slide(5)], activeSlideId: 2 });
  app.deleteSlide(2);
  assert.deepEqual(Array.from(app.slides, (frame) => frame.id), [8, 5]);
  assert.equal(app.activeSlideId, 5);
  mainListener(app, '#undoEditBtn')();
  assert.deepEqual(Array.from(app.slides, (frame) => frame.id), [8, 2, 5]);
  assert.equal(app.activeSlideId, 2);
  app.moveSlideByStep(5, -1);
  assert.deepEqual(Array.from(app.slides, (frame) => frame.id), [8, 5, 2]);
  mainListener(app, '#undoEditBtn')();
  assert.deepEqual(Array.from(app.slides, (frame) => frame.id), [8, 2, 5]);
});

test('pending draft captures the original task even when another file or demo opens before debounce', async () => {
  const callbacks = [];
  const stored = [];
  const file = new File(['video'], 'original.mp4', { type: 'video/mp4' });
  const app = workspace({
    selectedFile: file, slides: [slide(3), slide(1)],
    draftRevision: 0, savedDraftRevision: 0, draftTimer: 0, draftWrites: Promise.resolve(),
    $: () => ({}), window: { clearTimeout: () => {}, setTimeout: (callback) => { callbacks.push(callback); return 1; } },
    writeDraft: async (draft) => { stored.push(draft); }
  });
  app.scheduleDraftSave = app.sourceFunctions.scheduleDraftSave;
  app.scheduleDraftSave();
  app.selectedFile = new File([], 'demo.mp4');
  app.slides = [];
  app.isDemoProject = true;
  callbacks[0]();
  await app.draftWrites;
  assert.equal(stored[0].file, file);
  assert.deepEqual(Array.from(stored[0].state.slides, (frame) => frame.id), [3, 1]);
  assert.equal(app.savedDraftRevision, app.draftRevision);
});

test('closing demo restores the original image task, mode, and edited page order', () => {
  const file = new File([], 'images.images');
  const original = { slides: [slide(7), slide(1)], transcript: '', summary: '', illustratedNotes: '', videoMeta: null, status: 'done' };
  const states = new Map();
  const app = workspace({
    isDemoProject: true, selectedFile: new File([], 'demo.mp4'), workspaceMode: 'video',
    demoSnapshot: { file, mode: 'image', state: original, index: -1 }, demoRestoreFileIndex: -1,
    setStateForFile: (target, state) => states.set(target, state)
  });
  app.loadStateIntoWorkspace = (target) => { app.slides = states.get(target).slides; };
  app.setWorkspaceMode = (mode) => { app.workspaceMode = mode; };
  app.restoreWorkspaceAfterDemo();
  assert.equal(app.selectedFile, file);
  assert.equal(app.workspaceMode, 'image');
  assert.equal(app.isDemoProject, false);
  assert.deepEqual(Array.from(app.slides, (frame) => frame.id), [7, 1]);
});

test('PPTX package preserves supplied page order, editable Unicode, media and relationships', async () => {
  const app = workspace();
  const output = await app.makePptx([slide(3), slide(1)]);
  const archive = await JSZip.loadAsync(await output.arrayBuffer());
  const first = await archive.file('ppt/slides/slide1.xml').async('string');
  const second = await archive.file('ppt/slides/slide2.xml').async('string');
  assert.match(first, /3: 中文 &amp; &lt;editable&gt;/);
  assert.match(second, /1: 中文 &amp; &lt;editable&gt;/);
  assert.match(first, /txBox="1"/);
  assert.match(first, /<a:t>Second line<\/a:t>/);
  assert.equal(archive.file('ppt/slides/slide3.xml'), null);
  const firstRels = await archive.file('ppt/slides/_rels/slide1.xml.rels').async('string');
  assert.match(firstRels, /Target="\.\.\/media\/image1.png"/);
  assert.match(await archive.file('[Content_Types].xml').async('string'), /Extension="png" ContentType="image\/png"/);
  const media = await archive.file('ppt/media/image1.png').async('uint8array');
  assert.deepEqual(Array.from(media.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.match(await archive.file('ppt/presentation.xml').async('string'), /<p:sldSz cx="12192000" cy="6858000"/);
});

test('PDF produces one page per supplied slide and rejects empty export', async () => {
  const app = workspace();
  const output = await app.makePdf([{ ...slide(3), textBoxes: [] }, { ...slide(1), textBoxes: [] }]);
  const pdf = await output.text();
  assert.match(pdf, /^%PDF-/);
  assert.match(pdf, /\/Count 2\b/);
  await assert.rejects(app.makePdf([]), /没有可导出的页面/);
  await assert.rejects(app.makePptx([]), /没有可导出的页面/);
});

const pdfTextContext = createContext({ exports: {} });
runInContext(ts.transpileModule(readFileSync(resolve(root, 'src/pdfTextLayer.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
}).outputText, pdfTextContext);

function textCanvas() {
  return {
    draws: [], rects: [], images: [], font: '', fillStyle: '', textAlign: '',
    save() {}, restore() {}, beginPath() {}, clip() {},
    measureText(text) { return { width: Array.from(text).length * 10 }; },
    rect(...args) { this.rects.push(args); },
    drawImage(...args) { this.images.push(args); },
    fillText(text, x, y) { this.draws.push({ text, x, y, font: this.font, color: this.fillStyle, align: this.textAlign }); }
  };
}

test('PDF text renderer wraps Chinese without spaces and honors paragraph breaks and alignment', () => {
  const ctx = textCanvas();
  assert.deepEqual(Array.from(pdfTextContext.exports.wrapCanvasText(ctx, '视频重点摘要\nHello world', 60)), ['视频重点摘要', 'Hello', 'world']);
  assert.deepEqual(Array.from(pdfTextContext.exports.wrapCanvasText(ctx, '视频重点摘要', 30)), ['视频重', '点摘要']);
  pdfTextContext.exports.paintPdfTextBoxes(ctx, 960, 540, [{ ...box, text: '中文摘要', align: 'center' }]);
  assert.deepEqual(ctx.rects[0], [96, 81, 576, 108]);
  assert.equal(ctx.draws[0].text, '中文摘要');
  assert.equal(ctx.draws[0].x, 384);
  assert.equal(ctx.draws[0].y, 81);
  assert.equal(ctx.draws[0].align, 'center');
  assert.match(ctx.draws[0].font, /^700 24px/);
  assert.match(ctx.draws[0].font, /PingFang SC/);
  assert.equal(ctx.draws[0].color, '#163a5f');
});

test('PDF composites Unicode text before embedding and leaves image-only pages unaltered', async () => {
  const ctx = textCanvas();
  let created = 0;
  const app = workspace({
    document: {
      fonts: { ready: Promise.resolve() },
      createElement: (name) => {
        assert.equal(name, 'canvas');
        created += 1;
        return { width: 0, height: 0, getContext: () => ctx, toDataURL: () => pixelPng };
      }
    },
    loadImage: async () => ({ naturalWidth: 1600, naturalHeight: 900 }),
    paintPdfTextBoxes: pdfTextContext.exports.paintPdfTextBoxes
  });
  const result = await app.makePdf([slide(3), { ...slide(1), textBoxes: [] }]);
  assert.equal(created, 1);
  assert.equal(ctx.images.length, 1);
  assert.ok(ctx.draws.some((draw) => draw.text.includes('中文 & <editable>')));
  assert.match(await result.text(), /\/Count 2\b/);
});

test('transcription locks before metadata awaits, rejects duplicate start, and unlocks after quota refusal', async () => {
  const metadata = deferred();
  let reads = 0;
  const app = workspace({
    readFileVideoMetadata: () => { reads += 1; return metadata.promise; },
    ensureUsageCapacity: async () => false
  });
  const task = app.transcribeCurrentFile();
  assert.equal(app.isBusy(), true);
  assert.equal(await app.transcribeCurrentFile(), false);
  assert.equal(reads, 1);
  metadata.resolve({ duration: 120 });
  assert.equal(await task, false);
  assert.equal(app.isBusy(), false);
  assert.equal(app.transcriptEl.value, 'Original transcript');
});

test('transcription keeps the previous transcript if decoder/model processing fails', async () => {
  const app = workspace({
    videoMeta: { duration: 120 }, ensureUsageCapacity: async () => true,
    transcribeLocally: async () => { throw new Error('model unavailable'); }
  });
  assert.equal(await app.transcribeCurrentFile(), false);
  assert.equal(app.transcriptEl.value, 'Original transcript');
  assert.equal(app.isBusy(), false);
});

for (const [method, inputs] of [
  ['runOcrForSelectedSlides', { slides: [slide(1)], getActiveSlide: () => null }],
  ['openImagesInWorkspace', { selectedImageFiles: [{ name: 'page.png' }] }],
  ['batchExtractAndDownloadZip', { selectedFiles: [{ name: 'lecture.mp4' }], currentLimits: () => ({ batch_processing: true }) }],
  ['generateSummary', {}],
  ['generateIllustratedNotes', { authSession: { token: 'fixture', user: { username: 'fixture' } } }]
]) {
  test(`${method} locks before quota checks and always unlocks after refusal`, async () => {
    const capacity = deferred();
    let checks = 0;
    const app = workspace({ ...inputs, ensureUsageCapacity: () => { checks += 1; return capacity.promise; } });
    const task = app[method]();
    assert.equal(app.isBusy(), true);
    await app[method]();
    assert.equal(checks, 1);
    capacity.resolve(false);
    await task;
    assert.equal(app.isBusy(), false);
  });
}

test('recording chooser prevents duplicate starts, releases its lock when cancelled, and can be reopened', async () => {
  const requests = [deferred(), deferred()];
  let chooserCount = 0;
  let status = '';
  const app = workspace({
    navigator: { mediaDevices: { getDisplayMedia: () => requests[chooserCount++].promise } },
    MediaRecorder: class {}, getSupportedRecordingMimeType: () => '',
    recordingStream: null, mediaRecorder: null, recordedChunks: [], recordingCompletionMode: 'queue',
    setStatus: (message) => { status = message; }
  });
  const first = app.startScreenRecording('extract');
  assert.equal(app.isPreparingRecording, true);
  assert.equal(app.isBusy(), true);
  await app.startScreenRecording('extract');
  assert.equal(chooserCount, 1);
  requests[0].reject(new DOMException('User cancelled', 'NotAllowedError'));
  await first;
  assert.equal(app.isPreparingRecording, false);
  assert.equal(app.isRecording, false);
  assert.equal(app.isBusy(), false);
  assert.match(status, /已取消录屏/);
  const second = app.startScreenRecording('extract');
  assert.equal(chooserCount, 2);
  requests[1].reject(new DOMException('User cancelled again', 'NotAllowedError'));
  await second;
  assert.equal(app.isBusy(), false);
});

test('partial OCR failure restores existing text boxes on every selected page', async () => {
  const original = slide(1);
  const originalText = original.textBoxes[0].text;
  const app = workspace({
    slides: [original], getActiveSlide: () => null,
    ensureUsageCapacity: async () => true,
    recognizeSlidesToTextBoxes: async (targets) => {
      targets[0].textBoxes = [{ ...box, text: 'partial replacement' }];
      throw new Error('OCR connection unavailable');
    }
  });
  await app.runOcrForSelectedSlides();
  assert.equal(original.textBoxes[0].text, originalText);
  assert.equal(app.isBusy(), false);
});

test('batch skips an invalid video, exports successful files, and charges only completed conversions', async () => {
  const files = ['first.mp4', 'invalid.mp4', 'last.mp4'].map((name) => ({ name }));
  const states = new Map(files.map((file) => [file, { slides: [], transcript: '', summary: '', illustratedNotes: '' }]));
  const completed = [];
  const charges = [];
  let download;
  let finalStatus = '';
  const app = workspace({
    selectedFile: files[0], selectedFiles: files,
    currentLimits: () => ({ batch_processing: true }),
    ensureUsageCapacity: async () => true,
    ensureVideoDurationAllowed: async (file, report) => {
      if (file === files[1]) { report('unsupported media'); return false; }
      return true;
    },
    readSettings: () => ({ sampleEvery: 1, minGap: 1, duplicateThreshold: 5 }),
    setStateStatus: (file, status, error) => Object.assign(states.get(file), { status, error }),
    setStateForFile: (file, state) => states.set(file, state),
    getState: (file) => states.get(file),
    extractSlidesFromFile: async (file) => { completed.push(file.name); return { slides: [slide(1)], meta: { duration: 30 } }; },
    downloadBlob: (blob) => { download = blob; },
    recordUsage: async (...args) => { charges.push(args); },
    setHomeStatus: (message) => { finalStatus = message; }
  });
  await app.batchExtractAndDownloadZip();
  assert.deepEqual(completed, ['first.mp4', 'last.mp4']);
  assert.equal(states.get(files[1]).status, 'error');
  assert.equal(states.get(files[1]).error, 'unsupported media');
  assert.equal(charges.length, 1);
  assert.equal(charges[0][1], 2);
  const zip = await JSZip.loadAsync(await download.arrayBuffer());
  assert.equal(Object.keys(zip.files).filter((name) => name.endsWith('.jpg')).length, 2);
  assert.match(finalStatus, /2 个视频/);
  assert.match(finalStatus, /1 个未完成/);
  assert.equal(app.isBusy(), false);
});

const cropContext = createContext({ exports: {}, Error });
runInContext(ts.transpileModule(readFileSync(resolve(root, 'src/cropGeometry.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
}).outputText, cropContext);

test('crop aligns retained text, clips intersecting boxes, removes outside boxes, and preserves the source', () => {
  const original = [
    { ...box, x: 30, y: 20, width: 20, height: 20, fontSize: 16 },
    { ...box, id: 'partial', x: 10, y: 0, width: 30, height: 30, fontSize: 16 },
    { ...box, id: 'outside', x: 80, y: 80, width: 10, height: 10, fontSize: 16 }
  ];
  const snapshot = structuredClone(original);
  const result = cropContext.exports.cropTextBoxes(original, { x: 0.2, y: 0.1, width: 0.4, height: 0.5 });
  assert.equal(result.length, 2);
  assert.deepEqual([result[0].x, result[0].y, result[0].width, result[0].height, result[0].fontSize], [25, 20, 50, 40, 40]);
  assert.deepEqual([result[1].x, result[1].y, result[1].width, result[1].height], [0, 0, 50, 40]);
  assert.equal(result[0].text, box.text);
  assert.equal(result[0].id, box.id);
  assert.deepEqual(original, snapshot);
  assert.throws(() => cropContext.exports.cropTextBoxes(original, { x: 0, y: 0, width: 0, height: 1 }), /有效/);
});

test('all directory pages resolve to their own source content and canonical URLs', async () => {
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(root, 'vite.config.ts'));
  const plugin = loaded.config.plugins.find((entry) => entry?.name === 'directory-index-pages');
  let middleware;
  plugin.configureServer({ config: { publicDir: resolve(root, 'public') }, middlewares: { use: (handler) => { middleware = handler; } } });
  function request(url, method = 'GET') {
    const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
    let passed = false;
    middleware({ url, method }, response, (error) => { if (error) throw error; passed = true; });
    return { ...response, passed };
  }
  for (const page of ['admin', 'sponsor', 'pricing', 'privacy', 'refund', 'terms-and-conditions', 'contact', 'one-time-pass']) {
    const response = request(`/${page}/`);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, readFileSync(resolve(root, `public/${page}/index.html`), 'utf8'));
    assert.equal(request(`/${page}/`, 'HEAD').body, undefined);
    const redirect = request(`/${page}?from=workspace`);
    assert.equal(redirect.statusCode, 302);
    assert.equal(redirect.headers.Location, `/${page}/?from=workspace`);
  }
  assert.equal(request('/api/auth', 'POST').passed, true);
  assert.equal(request('/unknown-page/').passed, true);
  assert.equal(request('/privacy/', 'POST').passed, true);
  plugin.configurePreviewServer({ config: { root, build: { outDir: 'public' } }, middlewares: { use: (handler) => { middleware = handler; } } });
  assert.equal(request('/contact/').body, readFileSync(resolve(root, 'public/contact/index.html'), 'utf8'));
  assert.equal(request('/contact?subject=Help').headers.Location, '/contact/?subject=Help');
});
