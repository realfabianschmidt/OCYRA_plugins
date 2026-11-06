import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import run from '../plugins/format/xliff/handler.js';
if (process.argv.length !== 4 || process.argv[2] !== '--reference') throw new Error('Usage: node tests/gp03.mjs --reference <gp03 directory>');
const root = resolve(process.argv[3]);
const text = (...path) => readFileSync(join(root, ...path), 'utf8');
const input = (name) => ({ target: 'document-tabular', sourceLanguage: 'en', file: { filename: name,
  mediaType: 'application/xliff+xml', data: { encoding: 'text', content: text('inputs', name) } } });
const { edit } = await import(pathToFileURL(join(root, 'inputs', 'edit.mjs')).href);
// The 2.x oracle dropped inline placeholders (GP03-D02, D03); v3 keeps them as codes. To compare the rest,
// the codes and the padding around them are removed from both sides.
const plain = (value) => value.replace(/<(?:x|ph) id="[^"]*"\/>/g, '').trim();
const parts = (xml) => ['source', 'target', 'note'].map((tag) => [...xml.matchAll(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 'g'))].map((match) => plain(match[1])));
for (const [name, language] of [['messages-1.2.xlf', 'de'], ['slides-2.1.xlf', 'fr']]) {
  const result = await run(input(name));
  assert.equal(result.status, 'ok', name);
  const { track } = result.artifact;
  const expected = JSON.parse(text('expected', `${name}.import.json`)).data.payload.localizationData;
  assert.deepEqual([track.sourceLanguage, track.targetLanguages], [expected.locales.source, expected.locales.targets]);
  assert.deepEqual(track.units.map((unit) => ({ key: unit.key, source: unit.sourceMarkup.length ? plain(unit.sourceMarkup.map((t) => (t.kind === 'text' ? t.text : '<x id="c"/>')).join('')) : unit.source,
    target: plain(unit.targets[0].markup.length ? unit.targets[0].markup.map((t) => (t.kind === 'text' ? t.text : '<x id="c"/>')).join('') : unit.targets[0].text),
    notes: unit.notes, context: unit.context, unitId: unit.reference.unitId, segmentId: unit.reference.segmentId, fileId: unit.reference.fileId })),
  expected.units.map((unit) => ({ key: unit.key, source: unit.source, target: unit.targets[language], notes: unit.notes, context: unit.context,
    unitId: unit.xliffRef.unitId, segmentId: unit.xliffRef.segmentId, fileId: unit.xliffRef.fileId })));
  // The scripted edit of the reference run: two targets replaced, one unit approved.
  const payload = { localizationData: { units: track.units.map((unit) => ({ targets: { [language]: unit.targets[0].text }, status: '' })),
    locales: { targets: [language] } } };
  edit(payload);
  payload.localizationData.units.forEach((unit, index) => {
    const target = track.units[index].targets[0];
    if (unit.targets[language] !== target.text) { target.text = unit.targets[language]; target.markup = []; }
    if (unit.status === 'approved') target.reviewState = 'final';
  });
  const exported = (await run({ language, artifact: result.artifact })).artifact.data.content;
  assert.deepEqual(parts(exported), parts(text('expected', `${name}.export.xlf`)), name);
  assert.equal((exported.match(/<(?:x|ph) id="/g) ?? []).length, 4, `${name}: placeholders kept`);
  assert.equal((exported.match(/state="final"/g) ?? []).length, 1, `${name}: approved state written`);
}
const malformed = await run(input('malformed.xlf'));
assert.deepEqual(malformed, { status: 'error', error: { code: 'invalid_input', location: { line: 4, column: 1 } } });
console.log('GP03 v1: both inputs import, scripted edit exports with placeholders and states kept, malformed input is coded');
