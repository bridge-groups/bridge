import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../core/version.ts';

const CLI = fileURLToPath(new URL('../cli.ts', import.meta.url));

function bridge(...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('cli: version and --version print the version', () => {
  for (const args of [['version'], ['--version'], ['-v']]) {
    assert.deepEqual(bridge(...args), { code: 0, out: `${VERSION}\n`, err: '' }, args.join(' '));
  }
});

test('cli: help and --help print the help', () => {
  for (const args of [['help'], ['--help'], ['-h'], []]) {
    const r = bridge(...args);
    assert.equal(r.code, 0, args.join(' '));
    assert.match(r.out, /^bridge — /, args.join(' '));
    assert.equal(r.err, '', args.join(' '));
  }
});

test('cli: an unknown option is one line naming it, not a stack trace', () => {
  const r = bridge('--nope');
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.equal(r.err, `Unknown option '--nope'. Run "bridge --help" for the commands and options.\n`);
});
