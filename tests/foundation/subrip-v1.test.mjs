import assert from 'node:assert/strict';
import test from 'node:test';
import run from '../../plugins/format/subrip/handler.js';
const input = (content) => ({ sourceLanguage: 'en', target: 'media-subtitle', file: {
  filename: 'sample.srt', mediaType: 'application/x-subrip', data: { encoding: 'text', content },
} });

test('only the default v1 module entry exists and no global hook is installed', async () => {
  const module = await import('../../plugins/format/subrip/handler.js');
  assert.deepEqual(Object.keys(module), ['default']);
  assert.equal(globalThis.ocyraPlugin, undefined);
  assert.deepEqual(await run({ operation: 'import', file: {} }), { status: 'error', error: { code: 'invalid_input' } });
});
test('malformed timestamps and boundaries return only decided codes and one-based locations', async () => {
  for (const [content, expected] of [
    ['1\n00:00:xx,000 --> 00:00:02,000\ntext\n', { code: 'invalid_input', location: { line: 2 } }],
    ['1\n00:00:00,000 --> 00:00:02,000\ntext\n2\n00:00:03,000 --> 00:00:04,000\nnext', { code: 'invalid_input', location: { line: 4 } }],
    [' \r\n\t', { code: 'empty_input' }],
    ['1\n00:00:02,000 --> 00:00:01,000\ntext', { code: 'invalid_input', location: { line: 2 } }],
    ['1\n00:00:00,000 --> 00:00:60,000\ntext', { code: 'invalid_input', location: { line: 2 } }],
  ]) assert.deepEqual(await run(input(content)), { status: 'error', error: expected });
});
test('overlap and exact whitespace remain valid while integer export never truncates', async () => {
  const imported = await run(input('1\r\n00:00:00,001 --> 00:00:02,000\r\n  exact  \r\n\r\n2\r\n00:00:01,000 --> 00:00:03,001\r\nnext\r\n'));
  assert.equal(imported.status, 'ok');
  assert.equal(imported.artifact.track.subtitles[0].text, '  exact  ');
  const exported = await run({ language: 'de', artifact: imported.artifact });
  assert.equal(exported.artifact.data.content, '1\n00:00:00,001 --> 00:00:02,000\n  exact  \n\n2\n00:00:01,000 --> 00:00:03,001\nnext\n\n');
});
test('ticks beyond JavaScript safe integers roundtrip, invalid precision and huge timestamps are coded', async () => {
  const artifact = { target: 'media-subtitle', track: { subtitles: [{ id: 'cue', text: 'exact',
    startTime: String(36_000_001n * 254016000n), endTime: String(36_000_002n * 254016000n),
  }] } };
  const result = await run({ language: 'fr', artifact });
  assert.match(result.artifact.data.content, /10:00:00,001 --> 10:00:00,002/);
  artifact.track.subtitles[0].startTime = '9007199254740993';
  assert.deepEqual(await run({ language: 'fr', artifact }), { status: 'error', error: { code: 'invalid_input', location: { item: 1 } } });
  assert.equal((await run(input(`1\n${'9'.repeat(25)}:00:00,000 --> 99:00:00,000\ntext`))).error.code, 'invalid_input');
});
test('truncated and deterministically mutated small inputs never throw or emit an alternate envelope', async () => {
  const content = '1\n00:00:00,000 --> 00:00:01,000\nexact\n';
  const cases = [...content].map((_, index) => content.slice(0, index));
  cases.push(...[...content].map((_, index) => content.slice(0, index) + '\0' + content.slice(index + 1)));
  for (const content of cases) {
    const result = await run(input(content));
    assert.ok(result.status === 'ok' || result.status === 'error');
    assert.deepEqual(Object.keys(result).sort(), result.status === 'ok' ? ['artifact', 'status'] : ['error', 'status']);
    if (result.status === 'error') assert.ok(['invalid_input', 'empty_input'].includes(result.error.code));
  }
});


test('confirmed sourceLanguage is required and the import request stays closed', async () => {
  const source = '1\n00:00:00,000 --> 00:00:01,000\nexact\n';
  const request = input(source);
  const expected = await run(request);
  assert.equal(expected.status, 'ok');
  for (const sourceLanguage of ['de', 'fr', 'en-US', 'x-private']) {
    assert.deepEqual(await run({ ...request, sourceLanguage }), expected);
  }
  const missing = { ...request };
  delete missing.sourceLanguage;
  for (const invalid of [missing, ...[null, '', 'en_US', '?', 1, 'x'.repeat(256)].map(sourceLanguage => ({ ...request, sourceLanguage })), { ...request, other: true }]) {
    assert.deepEqual(await run(invalid), { status: 'error', error: { code: 'invalid_input' } });
  }
});
