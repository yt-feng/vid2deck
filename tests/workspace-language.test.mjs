import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const dictionary = JSON.parse(readFileSync(resolve(root, 'src/workspaceEnglish.json'), 'utf8'));
const chinese = /[\u3400-\u9fff]/;
const mainText = readFileSync(resolve(root, 'src/main.ts'), 'utf8');
const mainAst = ts.createSourceFile('main.ts', mainText, ts.ScriptTarget.Latest, true);

function languageContext(language = 'en') {
  const context = createContext({
    exports: {}, console,
    window: { Vid2PPTLocale: { current: language } },
    require: (name) => { assert.equal(name, './workspaceEnglish.json'); return dictionary; }
  });
  runInContext(ts.transpileModule(readFileSync(resolve(root, 'src/workspaceI18n.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText, context);
  return context;
}

function templateSkeleton(node) {
  return ts.isTemplateExpression(node)
    ? node.head.text + node.templateSpans.map((span, index) => `{{${index}}}` + span.literal.text).join('')
    : node.text;
}

test('every authored workspace and landing phrase is explicitly localized before interpolation', () => {
  const en = languageContext().exports;
  let literals = 0;
  for (const path of ['src/main.ts', 'src/landing.ts', 'src/videoNotes.ts']) {
    const ast = ts.createSourceFile(path, readFileSync(resolve(root, path), 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isStringLiteral(node) && chinese.test(node.text)) {
        assert.ok(ts.isCallExpression(node.parent) && node.parent.expression.getText(ast) === 'ui', `Unlocalized string: ${node.text}`);
        en.translateWorkspaceSource(node.text);
        literals++;
      } else if (ts.isNoSubstitutionTemplateLiteral(node) && chinese.test(node.text)
        || ts.isTemplateExpression(node) && chinese.test(node.head.text + node.templateSpans.map((span) => span.literal.text).join(''))) {
        assert.ok(ts.isTaggedTemplateExpression(node.parent) && node.parent.tag.getText(ast) === 'ui', `Unlocalized template: ${node.getText(ast).slice(0, 100)}`);
        en.translateWorkspaceSource(templateSkeleton(node));
        literals++;
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  assert.ok(literals > 420, `Expected complete feature inventory, got ${literals}`);
  assert.deepEqual([...en.missingWorkspaceTranslations], []);
});

test('the English and Chinese workspaces share identical DOM and all feature controls', () => {
  const statement = mainAst.statements.find((node) => ts.isExpressionStatement(node)
    && ts.isBinaryExpression(node.expression) && node.expression.left.getText(mainAst) === 'app.innerHTML');
  const template = statement.expression.right.template;
  const skeleton = templateSkeleton(template);
  const en = languageContext().exports.translateWorkspaceSource(skeleton);
  const zh = languageContext('zh-CN').exports.translateWorkspaceSource(skeleton);
  assert.equal(zh, skeleton);
  const shape = (html) => [...html.matchAll(/<[^>]*>/g)].map((match) => match[0]
    .replace(/\b(aria-label|alt|title|placeholder)="[^"]*"/g, '$1="COPY"'));
  assert.deepEqual(shape(en), shape(zh));
  for (const id of ['sourceLocalTab', 'sourceUrlTab', 'sourceRecordTab', 'batchZipBtn', 'downloadFramesZipBtn',
    'runOcrBtn', 'transcribeBtn', 'summarizeBtn', 'generateNotesBtn', 'readNotesViewBtn', 'editPagesViewBtn',
    'saveVideoNoteBtn', 'copyVideoNoteBtn', 'saveVideoMarkdownBtn', 'cropDialog', 'textBoxContent', 'imagePptBtn',
    'imageWorkspaceBtn', 'notebookMaskPdfBtn', 'settingsDialog', 'authForm', 'timelineRail', 'reextractBtn', 'undoEditBtn']) {
    assert.match(en, new RegExp(`id="${id}"`), `${id} must exist in both languages`);
  }
  assert.match(en, /Record screen/);
  assert.match(en, /Transcript and notes/);
  assert.match(en, /OCR and text boxes/);
  assert.match(en, /Clean NotebookLM footer marks/);
  assert.ok(!chinese.test(en.replaceAll('日本語', '')), 'English system UI must not contain Chinese');
});

test('template localization preserves filenames, usernames and recognized or generated text exactly', () => {
  const context = languageContext();
  context.filename = '课程视频.mp4 {{0}}';
  context.user = '用户工作台';
  context.content = '全选\n提炼 AI 要点\n本地文件';
  const result = runInContext('exports.ui`当前视频：${filename}`', context);
  assert.equal(result, 'Current video: 课程视频.mp4 {{0}}');
  assert.equal(runInContext('exports.ui`账号：${user}`', context), 'Account: 用户工作台');
  assert.equal(runInContext('exports.ui`<article>${content}</article><button>全选</button>`', context), '<article>全选\n提炼 AI 要点\n本地文件</article><button>Select all</button>');
  assert.equal(runInContext('exports.ui`${content}`', context), context.content);
});

test('dynamic card tools, progress, limits, dialogs and errors have complete English copy', () => {
  const context = languageContext();
  assert.equal(runInContext('exports.ui`第 ${3} 页 · 图片页`', context), 'Page 3 · Image');
  assert.equal(runInContext('exports.ui`扫描 ${"00:30"} / ${"01:00"} · 找到 ${4} 页`', context), 'Scanning 00:30 / 01:00 · Found 4 frames');
  assert.equal(runInContext('exports.ui`文字识别完成：已为 ${2} 页生成 ${8} 个可编辑文本框。`', context), 'Text recognition complete: 8 editable text boxes created across 2 pages.');
  assert.equal(runInContext('exports.ui`<button title="裁剪" aria-label="裁剪第 ${5} 页">⌗</button>`', context), '<button title="Crop" aria-label="Crop page 5">⌗</button>');
  assert.equal(context.exports.ui('停止录制并加入队列'), 'Stop and add to queue');
  assert.equal(context.exports.ui('删除文本框'), 'Delete text box');
  assert.equal(context.exports.ui('应用裁剪'), 'Apply crop');
  assert.equal(context.exports.ui('准备开始'), 'Ready to start');
  assert.equal(context.exports.ui('复制 Markdown'), 'Copy Markdown');
  assert.equal(context.exports.ui('免费版'), 'Free');
  assert.equal(context.exports.ui('请选择 PDF 文件。'), 'Please choose a PDF file.');
});

test('fresh English output defaults to English and saved output preferences remain authoritative', () => {
  const constantNames = ['OUTPUT_LANGUAGE_LABELS', 'DEFAULT_USER_PREFERENCES', 'PREFERENCES_STORAGE_PREFIX'];
  const constants = mainAst.statements.filter((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((declaration) => constantNames.includes(declaration.name.getText(mainAst))))
    .map((node) => node.getText(mainAst)).join('\n');
  const functions = mainAst.statements.filter((node) => ts.isFunctionDeclaration(node)
    && ['preferencesStorageKey', 'loadUserPreferences', 'isOutputLanguage'].includes(node.name?.text))
    .map((node) => node.getText(mainAst)).join('\n');
  for (const [language, expected] of [['en', 'en'], ['zh-CN', 'zh-CN'], ['fr', 'en']]) {
    const context = languageContext(language);
    Object.assign(context, { ui: context.exports.ui, workspaceLanguage: context.exports.workspaceLanguage,
      authSession: null, localStorage: { getItem: () => null } });
    runInContext(ts.transpileModule(`${constants}\n${functions}`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
    assert.equal(runInContext('loadUserPreferences().outputLanguage', context), expected);
    context.localStorage.getItem = () => JSON.stringify({ outputLanguage: 'ja' });
    assert.equal(runInContext('loadUserPreferences().outputLanguage', context), 'ja');
  }
});

test('auth API failures, summary limits, media errors and worker feedback use English system messages', () => {
  const en = languageContext().exports;
  assert.equal(en.serviceMessage('用户名或密码有误，请核对后重试。'), 'Incorrect username or password. Check your details and try again.');
  assert.equal(en.serviceMessage('验证码有误或已过期，请重新填写。'), 'The verification answer is incorrect or expired. Please try again.');
  assert.equal(en.serviceMessage('免费摘要与笔记次数已用完：本月 10/10 次。请在定价页开通或升级后继续。'), 'Your free summaries and notes are used up: 10/10 this month. Choose or upgrade a plan to continue.');
  assert.equal(en.serviceMessage('视频文件超过 180 MB，请选择较短视频或裁剪后的文件。'), 'The video exceeds 180 MB. Choose a shorter or trimmed file.');
  assert.equal(en.serviceMessage('语音识别模型尚未就绪，请重试转写。'), 'The speech model is not ready yet. Please try transcription again.');
  assert.equal(en.serviceMessage('progress'), 'Downloading model');
  assert.equal(en.serviceMessage('未收录的服务端异常'), 'The request could not be completed. Please try again or contact support.');
  assert.equal(languageContext('zh-CN').exports.serviceMessage('验证码有误或已过期，请重新填写。'), '验证码有误或已过期，请重新填写。');
  // Exercise the actual application API error path with its real helper.
  const functions = mainAst.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'readResponseError').map((node) => node.getText(mainAst)).join('\n');
  const context = languageContext();
  Object.assign(context, { serviceMessage: en.serviceMessage, ui: en.ui });
  runInContext(ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
  context.response = { headers: { get: () => 'application/json' }, json: async () => ({ detail: 'YouTube 当前要求登录或真人验证，请稍后重试。' }) };
  return runInContext('readResponseError(response)', context).then((message) => assert.match(message, /YouTube requires sign-in or human verification/));
});

test('translation dictionary preserves placeholders and marketing FAQ contains only product questions', () => {
  for (const [source, english] of Object.entries(dictionary)) {
    assert.deepEqual([...source.matchAll(/\{\{\d+\}\}/g)].map((match) => match[0]).sort(), [...english.matchAll(/\{\{\d+\}\}/g)].map((match) => match[0]).sort(), source);
    assert.ok(english.trim());
  }
  const landing = readFileSync(resolve(root, 'src/landing.ts'), 'utf8');
  assert.equal((landing.match(/<details>/g) ?? []).length, 2);
  assert.ok(!/本地视频会上传|在浏览器中读取、抽帧/.test(landing));
  assert.ok(!/文件留在本机。|录屏在本机处理|在你的设备上处理/.test(mainText));
});
