import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const context = createContext({ exports: {} });
runInContext(ts.transpileModule(readFileSync(new URL('../src/journey.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
}).outputText, context);
const { getJourneyStage } = context.exports;
const task = (overrides = {}) => ({
  hasSource: false, busy: false, frameCount: 0, selectedCount: 0,
  reviewed: false, exported: false, ...overrides
});

test('a first task advances only after source, frames, review and actual export are available', () => {
  const current = task();
  assert.equal(getJourneyStage(current), 'source');
  current.hasSource = true;
  assert.equal(getJourneyStage(current), 'extract');
  current.busy = true;
  assert.equal(getJourneyStage(current), 'extract');
  current.frameCount = current.selectedCount = 3;
  assert.equal(getJourneyStage(current), 'extract', 'streaming frames do not imply extraction completed');
  current.busy = false;
  assert.equal(getJourneyStage(current), 'review', 'automatically selected frames are not an acknowledgement');
  current.reviewed = true;
  assert.equal(getJourneyStage(current), 'export');
  current.exported = true;
  assert.equal(getJourneyStage(current), 'done');
});

test('processing takes priority over retained results and prior completion flags', () => {
  for (const hasSource of [false, true]) {
    for (const frameCount of [0, 3]) {
      for (const reviewed of [false, true]) {
        for (const exported of [false, true]) {
          assert.equal(getJourneyStage(task({
            hasSource, busy: true, frameCount, selectedCount: frameCount, reviewed, exported
          })), 'extract');
        }
      }
    }
  }
});

test('removing every selected frame requires review even after a previous export', () => {
  const current = task({ hasSource: true, frameCount: 3, selectedCount: 3, reviewed: true, exported: true });
  assert.equal(getJourneyStage(current), 'done');
  current.selectedCount = 0;
  assert.equal(getJourneyStage(current), 'review');
  current.exported = false; // The integration clears completion when content changes.
  current.selectedCount = 2;
  assert.equal(getJourneyStage(current), 'export');
  current.frameCount = current.selectedCount = 0;
  assert.equal(getJourneyStage(current), 'extract');
});

test('sample and restored frames can be reviewed and exported without the source video', () => {
  const sample = task({ frameCount: 3, selectedCount: 2 });
  assert.equal(getJourneyStage(sample), 'review');
  assert.equal(getJourneyStage({ ...sample, reviewed: true }), 'export');
  assert.equal(getJourneyStage({ ...sample, exported: true }), 'done', 'direct export needs no forced walkthrough');
});

test('stale review and export flags cannot complete a missing or malformed result', () => {
  for (const frameCount of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    for (const hasSource of [false, true]) {
      assert.equal(getJourneyStage(task({
        hasSource, frameCount, selectedCount: 1, reviewed: true, exported: true
      })), hasSource ? 'extract' : 'source');
    }
  }
  for (const selectedCount of [0, -1, 1.5, 4, NaN, Infinity]) {
    assert.equal(getJourneyStage(task({
      frameCount: 3, selectedCount, reviewed: true, exported: true
    })), 'review');
  }
});

test('stage derivation does not mutate task state', () => {
  const current = Object.freeze(task({ frameCount: 5, selectedCount: 2, reviewed: true }));
  assert.equal(getJourneyStage(current), 'export');
  assert.deepEqual(current, task({ frameCount: 5, selectedCount: 2, reviewed: true }));
});
