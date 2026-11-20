import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { stampLines } from '../stamps.ts';

function sink() {
  let text = '';
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      text += chunk.toString('utf8');
      done();
    },
  });
  return { stream, text: () => text };
}

test('stamps: every line starts with an ISO-8601 time, also lines written in pieces or several at once', () => {
  const { stream, text } = sink();
  let t = Date.parse('2026-11-20T10:00:00.000Z');
  stampLines(stream, () => new Date((t += 1000)));
  stream.write('one\n');
  stream.write('two, ');
  stream.write('continued\nthree\nfour');
  stream.write(Buffer.from(' ends\n'));
  assert.equal(
    text(),
    '2026-11-20T10:00:01.000Z one\n' +
      '2026-11-20T10:00:02.000Z two, continued\n' +
      '2026-11-20T10:00:03.000Z three\n' +
      '2026-11-20T10:00:03.000Z four ends\n',
  );
});

test('stamps: a character split across buffers stays whole, and callbacks still fire', async () => {
  const { stream, text } = sink();
  stampLines(stream, () => new Date('2026-11-20T10:00:00.000Z'));
  const bytes = Buffer.from('ü\n');
  stream.write(bytes.subarray(0, 1));
  await new Promise<void>((done) => stream.write(bytes.subarray(1), () => done()));
  assert.equal(text(), '2026-11-20T10:00:00.000Z ü\n');
});

test('stamps: a terminal is left alone', () => {
  const { stream, text } = sink();
  stampLines(Object.assign(stream, { isTTY: true }));
  stream.write('plain\n');
  assert.equal(text(), 'plain\n');
});
