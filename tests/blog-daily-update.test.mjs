import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

test('daily blog updater validates an approved item without writing in dry-run mode', () => {
  const output = execFileSync(process.execPath, ['scripts/blog-daily-update.mjs', '--date', '2026-09-30', '--dry-run'], { encoding: 'utf8' });
  assert.match(output, /would publish meeting-video-notes/);
});

test('daily blog updater stays quiet when the queue has no due item', () => {
  const output = execFileSync(process.execPath, ['scripts/blog-daily-update.mjs', '--date', '2026-09-29', '--dry-run'], { encoding: 'utf8' });
  assert.match(output, /no approved article due/);
});
