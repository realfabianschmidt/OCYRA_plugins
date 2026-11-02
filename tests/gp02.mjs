import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import run from '../plugins/format/subrip/handler.js';
if (process.argv.length !== 4 || process.argv[2] !== '--reference') throw new Error('Usage: npm run test:reference -- --reference <gp02 directory>');
const root = resolve(process.argv[3]);
const json = (name) => JSON.parse(readFileSync(join(root, 'expected', name), 'utf8'));
const input = (name) => ({ sourceLanguage: 'en', target: 'media-subtitle', file: { filename: name,
  mediaType: 'application/x-subrip', data: { encoding: 'text', content: readFileSync(join(root, 'inputs', name), 'utf8') } } });
// The frozen 2.x oracle and edit script use millisecond floats. Production code uses BigInt only.
const ticks = (seconds) => String(BigInt(Math.round(seconds * 1000)) * 254016000n);
const result = await run(input('subtitles.srt'));
assert.equal(result.status, 'ok');
const expected = json('subtitles.srt.import.json').data.payload.subtitles.map((cue) => ({
  id: cue.id, text: cue.text, startTime: ticks(cue.startTime), endTime: ticks(cue.endTime),
}));
assert.deepEqual(result.artifact, { target: 'media-subtitle', track: { subtitles: expected } });
const { edit } = await import(pathToFileURL(join(root, 'inputs', 'edit.mjs')).href);
const legacy = { subtitles: result.artifact.track.subtitles.map((cue) => ({ id: cue.id, text: cue.text,
  startTime: Number(BigInt(cue.startTime) / 254016000n) / 1000, endTime: Number(BigInt(cue.endTime) / 254016000n) / 1000 })) };
edit(legacy);
const artifact = { target: 'media-subtitle', track: { subtitles: legacy.subtitles.map((cue) => ({
  id: cue.id, text: cue.text, startTime: ticks(cue.startTime), endTime: ticks(cue.endTime),
})) } };
const exported = await run({ language: 'de', artifact });
assert.equal(exported.status, 'ok');
assert.deepEqual(Buffer.from(exported.artifact.data.content, 'utf8'), readFileSync(join(root, 'expected', 'subtitles.srt.export.srt')));
for (const name of ['bad-timestamp.srt', 'missing-blank-line.srt', 'empty.srt']) {
  const expected = json(`${name}.result.json`);
  assert.equal(expected.rejected, true);
  assert.deepEqual(await run(input(name)), { status: 'error', error: { code: expected.error_class,
    ...(expected.location ? { location: expected.location } : {}) } });
}
console.log('GP02 v1: exact import fields, scripted edit, export bytes and three decided rejections passed');
