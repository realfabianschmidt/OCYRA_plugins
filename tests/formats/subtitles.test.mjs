import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vtt from '../../plugins/format/webvtt/handler.js';
import sbv from '../../plugins/format/sbv/handler.js';
import ass from '../../plugins/format/ass/handler.js';
import sami from '../../plugins/format/sami/handler.js';

const MS = 254016000n;
const fixture = (name) => readFileSync(new URL(`../fixtures/subtitles/${name}`, import.meta.url), 'utf8');
const input = (content) => ({ target: 'media-subtitle', sourceLanguage: 'en', file: {
  filename: 'sample', mediaType: 'text/plain', data: { encoding: 'text', content } } });
const cue = (id, startMs, endMs, text) => ({ id, startTime: String(BigInt(startMs) * MS), endTime: String(BigInt(endMs) * MS), text });
const exportOf = (run, subtitles, language = 'en') => run({ language, artifact: { target: 'media-subtitle', track: { subtitles } } });

// Each format: its sample, the exact cues it must import, and what its export must be.
const formats = {
  vtt: { run: vtt, sample: 'sample.vtt', cues: [[1000, 2500, '<v Anna>Hello <i>world</i>'], [3600001, 3601000, 'Second cue\ntwo lines']],
    exported: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n<v Anna>Hello <i>world</i>\n\n01:00:00.001 --> 01:00:01.000\nSecond cue\ntwo lines\n' },
  sbv: { run: sbv, sample: 'sample.sbv', cues: [[1000, 2500, 'Hello <i>world</i>'], [3600001, 3601000, 'Second cue\ntwo lines']],
    exported: '0:00:01.000,0:00:02.500\nHello <i>world</i>\n\n1:00:00.001,1:00:01.000\nSecond cue\ntwo lines\n' },
  ass: { run: ass, sample: 'sample.ass', cues: [[1000, 2500, '{\\an8\\i1}Hello, {\\b1}world{\\b0}\nsecond line'], [3600010, 3601000, 'Second cue']],
    exported: 'Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\an8\\i1}Hello, {\\b1}world{\\b0}\\Nsecond line\nDialogue: 0,1:00:00.01,1:00:01.00,Default,,0,0,0,,Second cue\n' },
  sami: { run: sami, sample: 'sample.smi', cues: [[1000, 2500, 'Hello <i>world</i>\nsecond line'], [3600001, 3601000, 'Second cue']],
    exported: '<SYNC Start=1000><P Class=ENCC>Hello <i>world</i><br>second line\n<SYNC Start=2500><P Class=ENCC>&nbsp;\n<SYNC Start=3600001><P Class=ENCC>Second cue\n<SYNC Start=3601000><P Class=ENCC>&nbsp;\n' },
};

for (const [name, { run, sample, cues, exported }] of Object.entries(formats)) {
  test(`${name}: sample imports to exact ticks and survives a round trip with its tags`, async () => {
    const imported = await run(input(fixture(sample)));
    assert.equal(imported.status, 'ok');
    const expected = cues.map(([start, end, text], index) => cue(`${name === 'vtt' ? 'vtt' : name}-${index + 1}`, start, end, text));
    assert.deepEqual(imported.artifact, { target: 'media-subtitle', track: { subtitles: expected } });
    const file = await run({ language: 'en', artifact: imported.artifact });
    assert.equal(file.status, 'ok');
    assert.ok(file.artifact.data.content.includes(exported), file.artifact.data.content);
    assert.deepEqual((await run(input(file.artifact.data.content))).artifact, imported.artifact);
  });
  test(`${name}: empty input, base64 and foreign requests are coded`, async () => {
    assert.deepEqual(await run(input(' \n')), { status: 'error', error: { code: 'empty_input' } });
    const base64 = input('x'); base64.file.data = { encoding: 'base64', bytes_base64: '' };
    assert.deepEqual(await run(base64), { status: 'error', error: { code: 'unsupported_input' } });
    assert.deepEqual(await run({ target: 'document-tabular', sourceLanguage: 'en', file: input('x').file }), { status: 'error', error: { code: 'unsupported_input' } });
    assert.deepEqual(await run({ operation: 'import' }), { status: 'error', error: { code: 'invalid_input' } });
  });
  test(`${name}: export refuses inexact ticks, empty cues and duplicate ids; truncations never throw`, async () => {
    const good = cue('a', 1000, 2000, 'x');
    assert.equal((await exportOf(run, [{ ...good, startTime: String(1n + 1000n * MS) }])).error.location.item, 1);
    assert.equal((await exportOf(run, [{ ...good, endTime: good.startTime }])).error.code, 'invalid_input');
    assert.equal((await exportOf(run, [good, { ...good }])).error.location.item, 2);
    assert.equal((await exportOf(run, [])).error.code, 'empty_input');
    const text = fixture(sample);
    for (let at = 0; at < text.length; at++) {
      const result = await run(input(text.slice(0, at)));
      assert.ok(result.status === 'ok' || ['invalid_input', 'empty_input', 'unsupported_input'].includes(result.error.code));
    }
  });
  test(`${name}: ticks beyond JavaScript safe integers round trip`, async () => {
    const big = cue('big', 36_000_000_010, 36_000_000_020, 'late');
    const file = await exportOf(run, [big]);
    assert.equal(file.status, 'ok');
    assert.equal((await run(input(file.artifact.data.content))).artifact.track.subtitles[0].startTime, big.startTime);
  });
}

test('webvtt malformed inputs return one-based locations', async () => {
  for (const [content, line] of [
    ['00:00:01.000 --> 00:00:02.000\nx\n', 1],
    ['WEBVTT\n\n00:00:01.000 -> 00:00:02.000\nx\n', 3],
    ['WEBVTT\n\n00:00:03.000 --> 00:00:02.000\nx\n', 3],
    ['WEBVTT\n\n00:00:01.000 --> 00:00:61.000\nx\n', 3],
    ['WEBVTT\n\nid\n00:00:01.000 --> 00:00:02.000\n', 5],
  ]) assert.deepEqual(await vtt(input(content)), { status: 'error', error: { code: 'invalid_input', location: { line } } }, content);
  assert.equal((await vtt(input('WEBVTT\n\nNOTE only\n'))).error.code, 'empty_input');
});
test('sbv malformed inputs return one-based locations', async () => {
  for (const [content, line] of [['0:00:01,000,0:00:02.000\nx\n', 1], ['0:00:01.000,0:00:02.000\n', 2], ['0:00:03.000,0:00:02.000\nx\n', 1], ['0:00:01.000,0:99:02.000\nx\n', 1]])
    assert.deepEqual(await sbv(input(content)), { status: 'error', error: { code: 'invalid_input', location: { line } } }, content);
});
test('ass malformed inputs return one-based locations', async () => {
  const head = '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
  for (const [content, line] of [
    ['[Script Info]\nTitle: x\n', 1],
    ['[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,D,,0,0,0,,x\n', 2],
    [head + 'Dialogue: 0,0:00:01.0,0:00:02.00,D,,0,0,0,,x\n', 3],
    [head + 'Dialogue: 0,0:00:03.00,0:00:02.00,D,,0,0,0,,x\n', 3],
    [head + 'Dialogue: 0,0:00:01.00,0:00:02.00,D,,0,0,0,\n', 3],
  ]) assert.deepEqual(await ass(input(content)), { status: 'error', error: { code: 'invalid_input', location: { line } } }, content);
});
test('ass SSA files with Marked instead of Layer import and centisecond ticks are exact', async () => {
  const result = await ass(input('[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: Marked=0,0:00:00.01,0:00:00.02,D,,0,0,0,,x, y\n'));
  assert.equal(result.artifact.track.subtitles[0].startTime, String(10n * MS));
  assert.equal(result.artifact.track.subtitles[0].text, 'x, y');
});
test('sami refuses an unclosed last cue, several languages, backwards time and a missing start', async () => {
  const wrap = (body) => `<SAMI><BODY>${body}</BODY></SAMI>`;
  for (const [content, code, line] of [
    [wrap('<SYNC Start=1000><P Class=A>x'), 'invalid_input', 1],
    [wrap('<SYNC Start=1000><P Class=A>x<P Class=B>y\n<SYNC Start=2000><P>&nbsp;'), 'unsupported_input', 1],
    [wrap('<SYNC Start=2000><P>&nbsp;\n<SYNC Start=1000><P>x'), 'invalid_input', 2],
    [wrap('<SYNC><P>x'), 'invalid_input', 1],
    ['<html></html>', 'invalid_input', 1],
  ]) assert.deepEqual(await sami(input(content)), { status: 'error', error: { code, location: { line } } }, content);
});
test('sami export refuses overlapping cues', async () => {
  const result = await exportOf(sami, [cue('a', 1000, 3000, 'x'), cue('b', 2000, 4000, 'y')]);
  assert.deepEqual(result, { status: 'error', error: { code: 'invalid_input', location: { item: 2 } } });
});
