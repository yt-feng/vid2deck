import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/landing.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('landing.ts', source, ts.ScriptTarget.Latest, true);
const navigate = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'navigateToSection');
assert.ok(navigate, 'test must execute the real navigation function');
const javascript = ts.transpileModule(navigate.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
}).outputText;

function navigation() {
  const body = { dataset: { entry: 'start' } };
  const workspace = { hidden: false };
  const events = [];
  const targets = new Map(['start', 'more-tools', 'faq', 'how-it-works', 'use-cases', 'account'].map((id) => [id, {
    hasAttribute: () => false,
    setAttribute: (name, value) => events.push(['attribute', id, name, value]),
    focus: () => events.push(['focus', id]),
    scrollIntoView: () => events.push(['scroll', id, body.dataset.entry])
  }]));
  const context = createContext({
    document: {
      body,
      getElementById: (id) => targets.get(id) ?? null,
      querySelector: (selector) => {
        if (selector === '#workspaceView') return workspace;
        if (selector === '#doneBtn') return { click: () => {
          // Returning from the workspace deliberately selects focused import.
          // The destination route must override this when opening other sections.
          body.dataset.entry = 'start';
          workspace.hidden = true;
          events.push(['closed']);
        } };
        if (selector === '#openLoginBtn') return { click: () => {
          body.dataset.entry = 'account';
          events.push(['login']);
        } };
        throw new Error(`Unexpected selector: ${selector}`);
      }
    },
    requestAnimationFrame: (callback) => callback(),
    closeNavigation: () => events.push(['menu-closed']),
    navLinks: { querySelectorAll: () => [] },
    window: { matchMedia: () => ({ matches: false }) }
  });
  runInContext(javascript, context);
  return { context, body, workspace, events };
}

for (const hash of ['#more-tools', '#faq', '#how-it-works', '#use-cases']) {
  test(`leaving an open workspace for ${hash} reveals and focuses the requested section`, () => {
    const app = navigation();
    app.context.navigateToSection(hash);
    assert.equal(app.workspace.hidden, true);
    assert.equal(app.body.dataset.entry, 'explore');
    assert.deepEqual(app.events.find((event) => event[0] === 'scroll'), ['scroll', hash.slice(1), 'explore']);
    assert.ok(app.events.some((event) => event[0] === 'focus' && event[1] === hash.slice(1)));
    assert.equal(app.events.filter((event) => event[0] === 'closed').length, 1);
  });
}

test('returning from a workspace to #start keeps focused import visible', () => {
  const app = navigation();
  app.context.navigateToSection('#start');
  assert.equal(app.workspace.hidden, true);
  assert.equal(app.body.dataset.entry, 'start');
  assert.deepEqual(app.events.find((event) => event[0] === 'scroll'), ['scroll', 'start', 'start']);
});

test('account navigation preserves the account panel mode and its own focus handling', () => {
  const app = navigation();
  app.context.navigateToSection('#account');
  assert.equal(app.workspace.hidden, true);
  assert.equal(app.body.dataset.entry, 'account');
  assert.deepEqual(app.events.find((event) => event[0] === 'scroll'), ['scroll', 'account', 'account']);
  assert.ok(app.events.some((event) => event[0] === 'login'));
  assert.equal(app.events.some((event) => event[0] === 'focus'), false, 'the login handler owns account focus');
});
