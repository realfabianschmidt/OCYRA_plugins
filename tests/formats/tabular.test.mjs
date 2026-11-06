import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import xliff from '../../plugins/format/xliff/handler.js';
import csv from '../../plugins/format/csv/handler.js';
import i18n from '../../plugins/format/i18n-json/handler.js';

const read = (path) => readFileSync(new URL(`../fixtures/${path}`, import.meta.url), 'utf8');
const request = (content, name = 'file', data = { encoding: 'text', content }) => ({ target: 'document-tabular', sourceLanguage: 'en',
  file: { filename: name, mediaType: 'application/octet-stream', data } });
const fail = (code, location) => ({ status: 'error', error: { code, ...(location ? { location } : {}) } });
const exportOf = (run, track, language) => run({ language, artifact: { target: 'document-tabular', track } });

// ---------------------------------------------------------------- XLIFF

for (const [name, language] of [['messages-1.2', 'de'], ['slides-2.1', 'fr']]) {
  test(`xliff ${name}: GP03 input imports to the fixed artifact and exports to the fixed file`, async () => {
    const imported = await xliff(request(read(`xliff/${name}.xlf`), `${name}.xlf`));
    assert.deepEqual(imported.artifact, JSON.parse(read(`xliff/${name}.import.json`)));
    const exported = await exportOf(xliff, imported.artifact.track, language);
    assert.equal(exported.artifact.data.content, read(`xliff/${name}.export.xlf`));
    assert.deepEqual((await xliff(request(exported.artifact.data.content))).artifact, imported.artifact);
  });
}
test('xliff: the GP03 placeholders and states are kept, closing D02 and D03', async () => {
  const { track } = (await xliff(request(read('xliff/messages-1.2.xlf')))).artifact;
  const unit = track.units[0];
  assert.equal(unit.source, 'Welcome {name}');
  assert.deepEqual(unit.sourceMarkup[1], { kind: 'code', id: '<x id="name"/>', label: '{name}' });
  assert.deepEqual(unit.targets[0].markup, unit.sourceMarkup.map((t) => (t.kind === 'text' ? { ...t, text: 'Willkommen ' } : t)));
  assert.deepEqual(track.units.map((u) => u.targets[0].reviewState), ['translated', 'translated', 'translated', 'translated', 'translated', 'translated', 'rejected']);
  assert.equal(track.roundtripFile, null);
});
test('xliff: a scripted edit changes only the edited targets and the state, and keeps every code', async () => {
  const { track } = (await xliff(request(read('xliff/slides-2.1.xlf')))).artifact;
  track.units[1].targets[0] = { ...track.units[1].targets[0], text: 'Edited translation for unit two.', markup: [] };
  track.units[2].targets[0].reviewState = 'final';
  const content = (await exportOf(xliff, track, 'fr')).artifact.data.content;
  assert.match(content, /<segment id="s2" state="translated">\n\s+<source>Open the project\.<\/source>\n\s+<target>Edited translation for unit two\.<\/target>/);
  assert.match(content, /<segment id="s3" state="final">/);
  assert.match(content, /<source>Hello <ph id="name"\/><\/source>\n\s+<target>Bonjour <ph id="name"\/><\/target>/);
});

const wrap12 = (units, attributes = 'source-language="en" target-language="de"') =>
  `<?xml version="1.0"?><xliff version="1.2"><file original="f" datatype="plaintext" ${attributes}><body>${units}</body></file></xliff>`;
test('xliff 1.2: paired g, bpt/ept with content, mrk and entities survive exactly', async () => {
  const unit = '<trans-unit id="a/b c" maxwidth="12"><source>A <g id="1" ctype="bold">b &amp; <x id="2"/></g> <bpt id="3">&lt;i&gt;</bpt>i<ept id="3">&lt;/i&gt;</ept> <mrk mtype="term">t</mrk>&#x41;<![CDATA[<raw>]]></source>'
    + '<target state="signed-off">Ä <g id="1" ctype="bold">b &amp; <x id="2"/></g></target></trans-unit>';
  const imported = await xliff(request(wrap12(unit)));
  const [one] = imported.artifact.track.units;
  assert.equal(one.id, 'document-1.a_2f_b_20_c');
  assert.equal(one.maxLength, 12);
  assert.equal(one.source, 'A <1>b & {2}</1> {3}i{3} <mrk>t</mrk>A<raw>');
  assert.equal(one.targets[0].reviewState, 'reviewed');
  const exported = (await exportOf(xliff, imported.artifact.track, 'de')).artifact.data.content;
  assert.ok(exported.includes('<source>A <g id="1" ctype="bold">b &amp; <x id="2"/></g> <bpt id="3">&lt;i&gt;</bpt>i<ept id="3">&lt;/i&gt;</ept> <mrk mtype="term">t</mrk>A&lt;raw&gt;</source>'), exported);
  assert.ok(exported.includes('<trans-unit id="a/b c" resname="a/b c" maxwidth="12">') && exported.includes('state="signed-off"'));
});
test('xliff: every mapped state round trips, others are refused as unsupported', async () => {
  for (const [state, expected, written] of [['new', 'new', 'new'], ['needs-translation', 'new', 'new'], ['translated', 'translated', 'translated'],
    ['signed-off', 'reviewed', 'signed-off'], ['final', 'final', 'final'], ['needs-review-translation', 'rejected', 'needs-review-translation']]) {
    const { artifact } = await xliff(request(wrap12(`<trans-unit id="1"><source>s</source><target state="${state}">t</target></trans-unit>`)));
    assert.equal(artifact.track.units[0].targets[0].reviewState, expected);
    assert.ok((await exportOf(xliff, artifact.track, 'de')).artifact.data.content.includes(`<target state="${written}">`));
  }
  assert.equal((await xliff(request(wrap12('<trans-unit id="1"><source>s</source><target state="needs-l10n">t</target></trans-unit>')))).error.code, 'unsupported_input');
  const modern = (state) => `<xliff version="2.0" srcLang="en" trgLang="fr"><file id="f"><unit id="u"><segment state="${state}"><source>s</source><target>t</target></segment></unit></file></xliff>`;
  for (const [state, expected] of [['initial', 'new'], ['translated', 'translated'], ['reviewed', 'reviewed'], ['final', 'final']]) {
    const { artifact } = await xliff(request(modern(state)));
    assert.equal(artifact.track.units[0].targets[0].reviewState, expected);
    assert.ok((await exportOf(xliff, artifact.track, 'fr')).artifact.data.content.includes(`state="${state}"`));
  }
  assert.equal((await xliff(request(modern('bogus')))).error.code, 'unsupported_input');
});
test('xliff 2.x: several segments become several units and notes stay with the first', async () => {
  const content = '<xliff version="2.1" srcLang="en" trgLang="fr"><file id="f"><unit id="u"><notes><note>n</note></notes>'
    + '<segment id="a"><source>One.</source><target>Un.</target></segment><ignorable><source> </source></ignorable>'
    + '<segment id="b"><source><pc id="1">Two</pc>.</source><target><pc id="1">Deux</pc>.</target></segment></unit></file></xliff>';
  const { track } = (await xliff(request(content))).artifact;
  assert.deepEqual(track.units.map((u) => [u.id, u.notes, u.reference.segmentId]), [['document-1.u.a', ['n'], 'a'], ['document-1.u.b', [], 'b']]);
  assert.equal(track.units[1].source, '<1>Two</1>.');
  const exported = (await exportOf(xliff, track, 'fr')).artifact.data.content;
  assert.equal(exported.match(/<unit /g).length, 1);
  assert.ok(exported.includes('<target><pc id="1">Deux</pc>.</target>'));
});
test('xliff: malformed, unsupported and hostile files are refused with codes and locations', async () => {
  const cases = [
    [read('xliff/malformed.xlf'), 'invalid_input', { line: 4, column: 1 }],
    ['<xliff version="1.2"><file source-language="en"><body></file></xliff>', 'invalid_input'],
    ['<xliff version="1.2"></xliff><xliff/>', 'invalid_input'],
    ['<xliff version="1.2"><file source-language="en"><body><trans-unit id="1"><source>&bogus;</source></trans-unit></body></file></xliff>', 'invalid_input'],
    ['<xliff version="1.2"><file source-language="en"><body><trans-unit id="1"><source>&#99999999999;</source></trans-unit></body></file></xliff>', 'invalid_input'],
    [wrap12('<trans-unit><source>x</source></trans-unit>'), 'invalid_input'],
    [wrap12('<trans-unit id="1"><target>x</target></trans-unit>'), 'invalid_input'],
    [wrap12('<trans-unit id="1"><source>x</source></trans-unit><trans-unit id="1"><source>y</source></trans-unit>'), 'invalid_input'],
    [wrap12('<trans-unit id="1"><source>x</source><target>t <x id="new"/></target></trans-unit>'), 'invalid_input'],
    [wrap12('<trans-unit id="1"><source>x</source></trans-unit>', 'target-language="de"'), 'invalid_input'],
    [wrap12('<trans-unit id="1"><source>x</source><target>t</target></trans-unit>', 'source-language="en"'), 'invalid_input'],
    ['<xliff version="1.2"><file source-language="en" source-language="de"><body/></file></xliff>', 'invalid_input'],
    ['<xliff><file/></xliff>', 'invalid_input'],
    ['<xliff version="1.2"/>', 'invalid_input'],
    ['<root version="1.2"/>', 'invalid_input'],
    ['<xliff version="1.1"><file/></xliff>', 'unsupported_version'],
    ['<xliff version="2.2"><file/></xliff>', 'unsupported_version'],
    ['<?xml version="1.0" encoding="ISO-8859-1"?><xliff version="1.2"/>', 'unsupported_input'],
    ['<!DOCTYPE xliff [<!ENTITY a "b">]><xliff version="1.2"/>', 'unsupported_input'],
    ['not xml at all', 'invalid_input'],
  ];
  for (const [content, code, location] of cases) {
    const result = await xliff(request(content));
    assert.equal(result.error?.code, code, content);
    if (location) assert.deepEqual(result, fail(code, location));
    else if (code === 'invalid_input') assert.ok(Number.isInteger(result.error.location?.line) || result.error.location === undefined, content);
  }
  assert.deepEqual(await xliff(request('  ')), fail('empty_input'));
  assert.deepEqual(await xliff({ ...request('x'), target: 'media-subtitle' }), fail('unsupported_input'));
  assert.deepEqual(await xliff({ operation: 'import' }), fail('invalid_input'));
});
test('xliff: truncations and single-byte mutations never throw or escape the envelope', async () => {
  const content = read('xliff/slides-2.1.xlf');
  for (let at = 0; at < content.length; at += 7) {
    for (const input of [content.slice(0, at), content.slice(0, at) + '\0' + content.slice(at + 1), content.slice(0, at) + '&' + content.slice(at + 1)]) {
      const result = await xliff(request(input));
      assert.ok(result.status === 'ok' || ['invalid_input', 'empty_input', 'unsupported_input', 'unsupported_version'].includes(result.error.code));
    }
  }
});
test('xliff: UTF-16 bytes with a BOM import and codes from other formats export as plain text', async () => {
  const text = wrap12('<trans-unit id="1"><source>ä</source></trans-unit>');
  const bytes = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]);
  const { artifact } = await xliff(request('', 'f.xlf', { encoding: 'base64', bytes_base64: bytes.toString('base64') }));
  assert.equal(artifact.track.units[0].source, 'ä');
  const track = { ...artifact.track, units: [{ ...artifact.track.units[0], reference: null, source: 'Hi {name}',
    sourceMarkup: [{ kind: 'text', text: 'Hi ' }, { kind: 'code', id: '{name}', label: '{name}' }] }] };
  assert.ok((await exportOf(xliff, track, 'en')).artifact.data.content.includes('<source>Hi {name}</source>'));
  assert.ok((await exportOf(xliff, track, 'de')).artifact.data.content.includes('target-language="de"'));
});

// ---------------------------------------------------------------- CSV

test('csv: semicolon file with quotes, embedded newlines and a missing target imports exactly', async () => {
  const { artifact } = await csv(request(read('tabular/sample.csv'), 'sample.csv'));
  const { track } = artifact;
  assert.deepEqual([track.sourceLanguage, track.targetLanguages, track.roundtripFile], ['en', ['de', 'fr-CA'], null]);
  assert.deepEqual(track.documents, [{ id: 'document-1', name: 'sample.csv', original: 'sample.csv', dataType: 'csv', fileId: '' }]);
  assert.deepEqual(track.units.map((u) => [u.id, u.key, u.source, u.context, u.notes, u.targets.map((t) => [t.language, t.text])]), [
    ['document-1.welcome', 'welcome', 'Hello; "world"', 'Home page', ['first', 'second'], [['de', 'Hallo, "Welt"']]],
    ['document-1.empty', 'empty', 'Save', '', [], [['fr-CA', 'Enregistrer']]],
  ]);
  const exported = (await exportOf(csv, track, 'de')).artifact;
  assert.equal(exported.data.content, 'key,source,context,notes,de,fr-CA\r\nwelcome,"Hello; ""world""",Home page,"first\nsecond","Hallo, ""Welt""",\r\nempty,Save,,,,Enregistrer\r\n');
  assert.deepEqual((await csv(request(exported.data.content, 'sample.csv'))).artifact, artifact);
});
test('csv: tab and comma delimiters, CRLF, BOM and UTF-16 are handled; ambiguity is refused', async () => {
  const tab = 'key\tsource\tde\r\nk\tA, B\tC\r\n';
  assert.equal((await csv(request(tab))).artifact.track.units[0].source, 'A, B');
  const bom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('key,source\nk,Ä\n')]);
  assert.equal((await csv(request('', 'f', { encoding: 'base64', bytes_base64: bom.toString('base64') }))).artifact.track.units[0].source, 'Ä');
  const wide = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('key,source\nk,Ä\n', 'utf16le')]);
  assert.equal((await csv(request('', 'f', { encoding: 'base64', bytes_base64: wide.toString('base64') }))).artifact.track.units[0].source, 'Ä');
  assert.deepEqual(await csv(request('key,source;de\nk,a;b\n')), fail('unsupported_input', { line: 1 }));
  const latin1 = Buffer.from([0x6B, 0x65, 0x79, 0x2C, 0x73, 0x0A, 0x6B, 0x2C, 0xE4]);
  assert.deepEqual(await csv(request('', 'f', { encoding: 'base64', bytes_base64: latin1.toString('base64') })), fail('unsupported_input'));
});
test('csv: malformed files are refused with one-based lines', async () => {
  for (const [content, code, line] of [
    ['key,source\nk\n', 'invalid_input', 2],
    ['key,source\nk,"open\n', 'invalid_input', 2],
    ['key,source\nk,a"b\n', 'invalid_input', 2],
    ['key,source\nk,"a"b\n', 'invalid_input', 2],
    ['key,source\n,x\n', 'invalid_input', 2],
    ['key,source\nk,x\nk,y\n', 'invalid_input', 3],
    ['source,de\nx,y\n', 'invalid_input', 1],
    ['key,source,not a tag\nk,x,y\n', 'invalid_input', 1],
    ['key,source,en\nk,x,y\n', 'invalid_input', 1],
    ['key\nk\n', 'invalid_input', 1],
  ]) assert.deepEqual(await csv(request(content)), fail(code, { line }), content);
  assert.deepEqual(await csv(request('key,source\n')), fail('empty_input'));
  assert.deepEqual(await csv(request('x', 'f', { encoding: 'base64', bytes_base64: '!!' })), fail('invalid_input'));
});

// ---------------------------------------------------------------- i18n JSON

test('i18n json: nested and flat keys keep their shape, ICU arguments are protected codes', async () => {
  const { artifact } = await i18n(request(read('tabular/sample.json'), 'en.json'));
  const { track } = artifact;
  assert.deepEqual(track.units.map((u) => u.key), ['welcome', 'nav.home', 'nav.deep.a.b', 'a.b', 'mustache']);
  assert.deepEqual(track.units[0].sourceMarkup.filter((t) => t.kind === 'code').map((t) => t.id),
    ['{name}', '{count, plural, one {# message} other {# messages}}']);
  assert.equal(track.units[0].source, 'Hello {name}, you have {count, plural, one {# message} other {# messages}}');
  assert.deepEqual(track.units[4].sourceMarkup, [{ kind: 'text', text: 'Hi ' }, { kind: 'code', id: '{{user}}', label: '{{user}}' }]);
  assert.deepEqual(track.units[1].reference, { version: 'i18n-json', documentId: 'document-1', fileId: '', unitId: '["nav","home"]', segmentId: '' });
  const same = await exportOf(i18n, track, 'en');
  assert.deepEqual(JSON.parse(same.artifact.data.content), JSON.parse(read('tabular/sample.json')));
  assert.deepEqual(Object.keys(JSON.parse(same.artifact.data.content)), ['welcome', 'nav', 'a.b', 'mustache']);
  const german = structuredClone(track);
  german.targetLanguages = ['de'];
  german.units[0].targets = [{ language: 'de', text: 'Hallo {name}', reviewState: 'translated', provenanceReference: null,
    markup: [{ kind: 'text', text: 'Hallo ' }, german.units[0].sourceMarkup[1]] }];
  german.units[1].targets = [{ language: 'de', text: 'Start', reviewState: 'final', provenanceReference: null, markup: [] }];
  assert.deepEqual(JSON.parse((await exportOf(i18n, german, 'de')).artifact.data.content), { welcome: 'Hallo {name}', nav: { home: 'Start' } });
});
test('i18n json: unsupported values, unbalanced braces and clashing keys are coded', async () => {
  for (const [content, code, location] of [
    ['{"a": 1}', 'unsupported_input'], ['{"a": null}', 'unsupported_input'], ['{"a": ["x"]}', 'unsupported_input'], ['["x"]', 'unsupported_input'],
    ['{"a": "{open"}', 'invalid_input', { item: 1 }], ['{"a": "x", "b": "{{y}"}', 'invalid_input', { item: 2 }],
    ['{"a": ', 'invalid_input'], ['{}', 'empty_input'], ['{"": "x"}', 'invalid_input', { item: 1 }],
    ['{"a.b": "x", "a": {"b": "y"}}', 'invalid_input', { item: 2 }],
  ]) assert.deepEqual(await i18n(request(content)), fail(code, location), content);
  const { track } = (await i18n(request('{"a": {"b": "x"}}'))).artifact;
  const clash = { ...track, units: [track.units[0], { ...track.units[0], id: 'x', reference: { ...track.units[0].reference, unitId: '["a"]' } }] };
  assert.deepEqual(await exportOf(i18n, clash, 'en'), fail('invalid_input', { item: 2 }));
  assert.equal((await i18n(request('{"__proto__": {"x": "y"}}'))).status, 'ok');
});
test('tabular exports are refused for the wrong target or a malformed language', async () => {
  for (const run of [xliff, csv, i18n]) {
    assert.deepEqual(await run({ language: 'en', artifact: { target: 'media-subtitle', track: {} } }), fail('unsupported_input'));
    assert.deepEqual(await run({ language: 'not a tag', artifact: { target: 'document-tabular', track: {} } }), fail('invalid_input'));
  }
});
