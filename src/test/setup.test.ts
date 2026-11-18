import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { slackManifest } from '../slack-manifest.ts';

test('slack manifest: the app and its bot are named "Bridge" unless another name is given', () => {
  const manifest = slackManifest();
  assert.match(manifest, /^  name: Bridge$/m);
  assert.match(manifest, /^    display_name: Bridge$/m);
  assert.match(slackManifest('Ops'), /^    display_name: Ops$/m);
});

test('slack manifest: the copy in doc/ matches the generated one', () => {
  const copy = readFileSync(new URL('../../doc/slacks.yaml', import.meta.url), 'utf8');
  assert.equal(copy.trim(), slackManifest().trim());
});
