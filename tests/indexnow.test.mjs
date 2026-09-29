import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

test('IndexNow notification skips cleanly until a Bing key is configured', () => {
  const output = execFileSync(process.execPath, ['scripts/submit-indexnow.mjs'], {
    encoding: 'utf8',
    env: { ...process.env, INDEXNOW_KEY: '' }
  });
  assert.match(output, /INDEXNOW_KEY is not configured/);
});
