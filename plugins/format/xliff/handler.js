// API v1: explicit results, no ambient or host access.
// ---- shared tabular prelude (identical in every tabular package; a test enforces it) ----
class Rejection extends Error {
  constructor(code, location) {
    super();
    this.result = { status: 'error', error: { code, ...(location ? { location } : {}) } };
  }
}
function reject(code = 'invalid_input', location) { throw new Rejection(code, location); }
function shape(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
const LANGUAGE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const sameLanguage = (a, b) => a.toLowerCase() === b.toLowerCase();
// Ids in the project are [A-Za-z0-9._-] only: every other character becomes _<hex>_, so the map is injective.
const encodeId = (raw) => raw.replace(/[^A-Za-z0-9.-]/gu, (c) => `_${c.codePointAt(0).toString(16)}_`);
const markupText = (tokens) => tokens.map((token) => (token.kind === 'text' ? token.text : token.label)).join('');
function utf8(bytes, start) {
  let out = '';
  for (let at = start; at < bytes.length;) {
    const lead = bytes[at++];
    if (lead < 0x80) { out += String.fromCharCode(lead); continue; }
    const extra = lead >= 0xF0 ? 3 : lead >= 0xE0 ? 2 : 1;
    let point = lead & (0x3F >> extra);
    for (let k = 0; k < extra; k++) {
      const next = bytes[at++];
      if ((next & 0xC0) !== 0x80) reject('unsupported_input');
      point = (point << 6) | (next & 0x3F);
    }
    if (lead < 0xC2 || lead > 0xF4 || point < [0, 0x80, 0x800, 0x10000][extra] || point > 0x10FFFF
        || (point >= 0xD800 && point < 0xE000)) reject('unsupported_input');
    out += String.fromCodePoint(point);
  }
  return out;
}
function utf16(bytes, littleEndian) {
  if (bytes.length % 2) reject('unsupported_input');
  let out = '';
  for (let at = 2; at < bytes.length; at += 2) {
    out += String.fromCharCode(littleEndian ? bytes[at] | (bytes[at + 1] << 8) : (bytes[at] << 8) | bytes[at + 1]);
  }
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)) reject('unsupported_input');
  return out;
}
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64(value) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) reject();
  const bytes = [];
  let bits = 0, count = 0;
  for (const c of value.replace(/=+$/, '')) {
    bits = ((bits << 6) | BASE64.indexOf(c)) & 0xFFFF;
    count += 6;
    if (count >= 8) { count -= 8; bytes.push((bits >> count) & 0xFF); }
  }
  return bytes;
}
// Text is taken as given. Bytes are UTF-8 (strict, BOM allowed) or UTF-16 with a BOM; nothing else is guessed.
function fileText(data) {
  if (data.encoding === 'text' && shape(data, ['encoding', 'content']) && typeof data.content === 'string') return data.content.replace(/^﻿/, '');
  if (data.encoding !== 'base64' || !shape(data, ['encoding', 'bytes_base64']) || typeof data.bytes_base64 !== 'string') reject('unsupported_input');
  const bytes = base64(data.bytes_base64);
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return utf16(bytes, true);
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return utf16(bytes, false);
  return utf8(bytes, bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF ? 3 : 0);
}
// `read(text, request)` returns { sourceLanguage, targetLanguages, documents, units }; `write(track, language)`
// returns { filename, mediaType, content }.
function tabularPlugin({ read, write }) {
  function importFile(request) {
    if (request.target !== 'document-tabular') reject('unsupported_input');
    const { file } = request;
    if (!shape(file, ['filename', 'mediaType', 'data']) || typeof file.filename !== 'string'
        || typeof file.mediaType !== 'string' || !LANGUAGE.test(request.sourceLanguage)) reject();
    const text = fileText(file.data);
    if (!text.trim()) reject('empty_input');
    return { target: 'document-tabular', track: { ...read(text, request), roundtripFile: null } };
  }
  function exportTrack(request) {
    const { artifact, language } = request;
    if (!LANGUAGE.test(language) || !shape(artifact, ['target', 'track'])) reject();
    if (artifact.target !== 'document-tabular') reject('unsupported_input');
    const { filename, mediaType, content } = write(artifact.track, language);
    return { filename, mediaType, data: { encoding: 'text', content } };
  }
  return async function run(request) {
    try {
      const artifact = shape(request, ['target', 'file', 'sourceLanguage']) ? importFile(request)
        : shape(request, ['language', 'artifact']) ? exportTrack(request) : reject();
      return { status: 'ok', artifact };
    } catch (error) {
      if (error instanceof Rejection) return error.result;
      throw error;
    }
  };
}
// ---- end of shared prelude ----
// XLIFF 1.2 and 2.0/2.1. Inline codes: every inline element is a code token whose id is the element
// itself in canonical form (double-quoted attributes, escaped text), so an export rebuilds it exactly.
// Paired containers (1.2 g, mrk; 2.x pc, mrk) become an opening and a closing code around their text;
// every other inline element (x, ph, bpt, ept, sc, ec, ...) is one code with its content. A code's label
// is `{id}` (or `<id>` and `</id>` for a pair). Target states map one to one onto the review states:
//   1.2: new, needs-translation (read only) <-> new; translated; signed-off <-> reviewed; final;
//        needs-review-translation <-> rejected
//   2.x: initial <-> new; translated; reviewed; final; rejected is written as translated with
//        subState="ocyra:rejected"; the 1.2 value needs-review-translation is read as rejected too.
// Dropped, because the contract has nowhere to keep it: groups, ignorable, seg-source, alt-trans,
// context-group, approved, every attribute not named here and any extension element. A target without
// a state reads as translated in 1.2 and as initial in 2.x. Several segments in one 2.x unit become
// several units; the unit notes stay with the first. Source and target text is exact: no trimming.
const STATE_12 = { new: 'new', 'needs-translation': 'new', translated: 'translated', 'signed-off': 'reviewed', final: 'final', 'needs-review-translation': 'rejected' };
const STATE_2 = { initial: 'new', translated: 'translated', reviewed: 'reviewed', final: 'final', 'needs-review-translation': 'rejected' };
const WRITE_12 = { new: 'new', translated: 'translated', reviewed: 'signed-off', final: 'final', rejected: 'needs-review-translation' };
const WRITE_2 = { new: 'initial', translated: 'translated', reviewed: 'reviewed', final: 'final', rejected: 'translated' };
const CONTAINERS_12 = new Set(['g', 'mrk']);
const CONTAINERS_2 = new Set(['pc', 'mrk']);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const NAME = '[^\\s/>=<"\'&!?]+';
const OPEN = new RegExp(`<(${NAME})((?:\\s+${NAME}\\s*=\\s*(?:"[^"<]*"|'[^'<]*'))*)\\s*(/?)>`, 'y');
const CLOSE = new RegExp(`</(${NAME})\\s*>`, 'y');
const ATTRIBUTE = new RegExp(`(${NAME})\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'g');
const legal = (point) => point === 9 || point === 10 || point === 13 || (point >= 0x20 && point <= 0xD7FF)
  || (point >= 0xE000 && point <= 0xFFFD) || (point >= 0x10000 && point <= 0x10FFFF);

// A strict, small XML reader: one root, matching tags, known entities, no DOCTYPE (so no entity expansion).
function parseXml(source) {
  let at = 0, lineAt = 0, line = 1;
  const where = (offset) => { // offsets only grow while parsing, so lines are counted incrementally
    for (; lineAt < offset; lineAt++) if (source[lineAt] === '\n') line++;
    return line;
  };
  const fail = (offset = at) => {
    const before = source.slice(0, offset);
    reject('invalid_input', { line: before.split('\n').length, column: offset - before.lastIndexOf('\n') });
  };
  const decode = (raw, offset) => raw.replace(/&(?:(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z]+);)?/g, (match, body) => {
    if (!body) fail(offset);
    if (body[0] !== '#') return ENTITIES[body] ?? fail(offset);
    const point = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return legal(point) ? String.fromCodePoint(point) : fail(offset);
  });
  if (source.startsWith('<?xml')) {
    const end = source.indexOf('?>');
    if (end < 0) fail();
    const encoding = /encoding\s*=\s*["']([^"']+)["']/.exec(source.slice(0, end));
    if (encoding && !/^utf-(8|16)$/i.test(encoding[1])) reject('unsupported_input');
    at = end + 2;
  }
  const document = { name: '', attrs: [], children: [] };
  const stack = [document];
  const add = (text) => {
    const parent = stack[stack.length - 1], last = parent.children[parent.children.length - 1];
    if (text && typeof last === 'string') parent.children[parent.children.length - 1] = last + text; else if (text) parent.children.push(text);
  };
  while (at < source.length) {
    if (source[at] !== '<') {
      const end = source.indexOf('<', at) < 0 ? source.length : source.indexOf('<', at);
      const raw = source.slice(at, end);
      if (stack.length === 1) { if (raw.trim()) fail(); } else add(decode(raw, at));
      at = end;
    } else if (source.startsWith('<!--', at)) {
      const end = source.indexOf('-->', at + 4);
      if (end < 0) fail();
      at = end + 3;
    } else if (source.startsWith('<![CDATA[', at)) {
      const end = source.indexOf(']]>', at);
      if (end < 0 || stack.length === 1) fail();
      add(source.slice(at + 9, end));
      at = end + 3;
    } else if (source.startsWith('<?', at)) {
      const end = source.indexOf('?>', at);
      if (end < 0) fail();
      at = end + 2;
    } else if (source.startsWith('<!', at)) {
      reject('unsupported_input', { line: where(at) });
    } else if (source.startsWith('</', at)) {
      CLOSE.lastIndex = at;
      const match = CLOSE.exec(source);
      if (!match || stack.length === 1 || stack[stack.length - 1].name !== match[1]) fail();
      stack.pop();
      at = CLOSE.lastIndex;
    } else {
      OPEN.lastIndex = at;
      const match = OPEN.exec(source);
      const parent = stack[stack.length - 1];
      if (!match || (stack.length === 1 && parent.children.length) || stack.length > 200) fail();
      const attrs = [];
      for (const [, name, double, single] of match[2].matchAll(ATTRIBUTE)) {
        if (attrs.some(([known]) => known === name)) fail();
        attrs.push([name, decode(double ?? single, at)]);
      }
      const element = { name: match[1], attrs, children: [], line: where(at) };
      parent.children.push(element);
      if (!match[3]) stack.push(element);
      at = OPEN.lastIndex;
    }
  }
  if (stack.length > 1 || !document.children.length) fail(source.length);
  return document.children[0];
}
const kids = (element, name) => element.children.filter((child) => typeof child !== 'string' && child.name === name);
const attr = (element, name) => element.attrs.find(([key]) => key === name)?.[1];
const textOf = (element) => element.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const start = (element) => `<${element.name}${element.attrs.map(([key, value]) => ` ${key}="${escape(value).replace(/"/g, '&quot;')}"`).join('')}`;
const serialize = (element) => (element.children.length
  ? `${start(element)}>${element.children.map((child) => (typeof child === 'string' ? escape(child) : serialize(child))).join('')}</${element.name}>`
  : `${start(element)}/>`);

function tokens(element, containers) {
  const out = [];
  const text = (value) => {
    const last = out[out.length - 1];
    if (last?.kind === 'text') last.text += value; else out.push({ kind: 'text', text: value });
  };
  const walk = (parent) => {
    for (const child of parent.children) {
      if (typeof child === 'string') { text(child); continue; }
      const ref = attr(child, 'id') ?? child.name;
      if (containers.has(child.name)) {
        out.push({ kind: 'code', id: `${start(child)}>`, label: `<${ref}>` });
        walk(child);
        out.push({ kind: 'code', id: `</${child.name}>`, label: `</${ref}>` });
      } else out.push({ kind: 'code', id: serialize(child), label: `{${ref}}` });
    }
  };
  walk(element);
  return out;
}
const codeKey = (token) => `${token.id}\0${token.label}`;

function read(input) {
  const root = parseXml(input);
  const version = attr(root, 'version');
  if (root.name !== 'xliff' || version === undefined) reject('invalid_input', { line: root.line });
  const modern = /^2\.[01]$/.test(version);
  if (version !== '1.2' && !modern) reject('unsupported_version', { line: root.line });
  const containers = modern ? CONTAINERS_2 : CONTAINERS_12;
  const files = kids(root, 'file');
  if (!files.length) reject('invalid_input', { line: root.line });
  const documents = [], units = [], targetLanguages = [], ids = new Set();
  let sourceLanguage = null;
  files.forEach((file, index) => {
    const documentId = `document-${index + 1}`;
    const source = attr(modern ? root : file, modern ? 'srcLang' : 'source-language');
    const target = attr(modern ? root : file, modern ? 'trgLang' : 'target-language');
    if (!source || !LANGUAGE.test(source) || (target !== undefined && !LANGUAGE.test(target))) reject('invalid_input', { line: file.line });
    if (sourceLanguage !== null && !sameLanguage(sourceLanguage, source)) reject('unsupported_input', { line: file.line });
    sourceLanguage = source;
    if (target && !targetLanguages.some((known) => sameLanguage(known, target))) targetLanguages.push(target);
    const fileId = modern ? (attr(file, 'id') ?? reject('invalid_input', { line: file.line })) : '';
    const original = attr(file, 'original') ?? '';
    documents.push({ id: documentId, name: original.trim() || documentId, original, dataType: attr(file, 'datatype') ?? '', fileId });
    const entries = [];
    const collect = (parent) => {
      for (const child of parent.children) {
        if (typeof child === 'string') continue;
        if (child.name === (modern ? 'unit' : 'trans-unit')) entries.push(child);
        else if (child.name === 'group') collect(child);
      }
    };
    collect(modern ? file : (kids(file, 'body')[0] ?? reject('invalid_input', { line: file.line })));
    for (const entry of entries) {
      const unitId = attr(entry, 'id') ?? reject('invalid_input', { line: entry.line });
      const notes = (modern ? kids(entry, 'notes').flatMap((group) => kids(group, 'note')) : kids(entry, 'note'))
        .map(textOf).filter((note) => note.trim());
      const segments = modern ? kids(entry, 'segment') : [entry];
      if (!segments.length) reject('invalid_input', { line: entry.line });
      segments.forEach((segment, position) => {
        const item = units.length + 1;
        const sourceElement = kids(segment, 'source')[0] ?? reject('invalid_input', { line: segment.line });
        const sourceMarkup = tokens(sourceElement, containers);
        const hasCodes = sourceMarkup.some((token) => token.kind === 'code');
        const targetElement = kids(segment, 'target')[0];
        const targets = [];
        if (targetElement && textOf(targetElement).trim()) {
          if (!target) reject('invalid_input', { line: targetElement.line });
          const markup = tokens(targetElement, containers);
          const known = new Set(sourceMarkup.filter((token) => token.kind === 'code').map(codeKey));
          if (markup.some((token) => token.kind === 'code' && !known.has(codeKey(token)))) reject('invalid_input', { line: targetElement.line });
          const label = modern ? (attr(segment, 'state') ?? attr(targetElement, 'state')) : attr(targetElement, 'state');
          const state = modern && attr(segment, 'subState') === 'ocyra:rejected' ? 'rejected'
            : (modern ? STATE_2 : STATE_12)[label ?? (modern ? 'initial' : 'translated')];
          if (!state) reject('unsupported_input', { line: targetElement.line });
          targets.push({ language: target, text: markupText(markup), reviewState: state, provenanceReference: null,
            markup: markup.some((token) => token.kind === 'code') ? markup : [] });
        }
        const segmentId = modern ? (attr(segment, 'id') ?? '') : '';
        let id = `${documentId}.${encodeId(unitId)}${segments.length > 1 ? `.${encodeId(segmentId || String(position + 1))}` : ''}`;
        if (id.length > 128) id = `${documentId}.n${item}`;
        if (ids.has(id)) reject('invalid_input', { line: segment.line });
        ids.add(id);
        const maxwidth = modern ? undefined : attr(entry, 'maxwidth');
        units.push({ id, key: attr(entry, modern ? 'name' : 'resname') ?? unitId, documentId, source: markupText(sourceMarkup),
          sourceMarkup: hasCodes ? sourceMarkup : [], targets, context: position === 0 ? (notes[0] ?? '') : '',
          notes: position === 0 ? notes : [],
          reference: { version, documentId, fileId, unitId, segmentId },
          ...(/^[1-9]\d{0,8}$/.test(maxwidth ?? '') ? { maxLength: Number(maxwidth) } : {}) });
      });
    }
  });
  return { sourceLanguage, targetLanguages, documents, units };
}

// A code is written back as the element it came from. One that did not come from XLIFF (a project
// imported from another format) has no element to rebuild, so its label is written as plain text.
const wellFormed = (id) => {
  try { parseXml(id); return true; } catch (error) {
    if (error instanceof Rejection) return /^<\/?[A-Za-z_][\w:.-]*(?:\s+[\w:.-]+="[^"<]*")*\s*>$/.test(id);
    throw error;
  }
};
const render = (text, markup) => (markup?.length
  ? markup.map((token) => (token.kind === 'text' ? escape(token.text) : wellFormed(token.id) ? token.id : escape(token.label))).join('')
  : escape(text));
const quoted = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function write(track, language) {
  const version = track.units.find((unit) => unit.reference)?.reference.version ?? '1.2';
  const modern = /^2\.[01]$/.test(version);
  const translated = !sameLanguage(language, track.sourceLanguage);
  const stateOf = (target) => (modern ? WRITE_2 : WRITE_12)[target.reviewState];
  const file = (document) => {
    const own = track.units.filter((unit) => unit.documentId === document.id);
    const rows = [];
    let open;
    for (const unit of own) {
      const target = translated ? unit.targets.find((entry) => sameLanguage(entry.language, language)) : undefined;
      const sourceXml = `<source>${render(unit.source, unit.sourceMarkup)}</source>`;
      if (!modern) {
        const maxwidth = unit.maxLength === undefined ? '' : ` maxwidth="${unit.maxLength}"`;
        rows.push(`      <trans-unit id="${quoted(unit.reference?.unitId ?? unit.key)}" resname="${quoted(unit.key)}"${maxwidth}>`, `        ${sourceXml}`);
        if (target) rows.push(`        <target state="${stateOf(target)}">${render(target.text, target.markup)}</target>`);
        rows.push(...unit.notes.map((note) => `        <note>${escape(note)}</note>`), '      </trans-unit>');
        continue;
      }
      const unitId = unit.reference?.unitId ?? unit.key;
      if (open !== unitId) {
        if (open !== undefined) rows.push('    </unit>');
        rows.push(`    <unit id="${quoted(unitId)}" name="${quoted(unit.key)}">`);
        if (unit.notes.length) rows.push(`      <notes>${unit.notes.map((note) => `<note>${escape(note)}</note>`).join('')}</notes>`);
        open = unitId;
      }
      const segmentId = unit.reference?.segmentId ? ` id="${quoted(unit.reference.segmentId)}"` : '';
      const state = target ? ` state="${stateOf(target)}"${target.reviewState === 'rejected' ? ' subState="ocyra:rejected"' : ''}` : '';
      rows.push(`      <segment${segmentId}${state}>`, `        ${sourceXml}`);
      if (target) rows.push(`        <target>${render(target.text, target.markup)}</target>`);
      rows.push('      </segment>');
    }
    if (open !== undefined) rows.push('    </unit>');
    if (modern) return [`  <file id="${quoted(document.fileId || document.id)}" original="${quoted(document.original)}">`, ...rows, '  </file>'];
    return [`  <file original="${quoted(document.original)}" source-language="${track.sourceLanguage}"${translated ? ` target-language="${language}"` : ''} datatype="${quoted(document.dataType || 'plaintext')}">`,
      '    <body>', ...rows, '    </body>', '  </file>'];
  };
  const namespace = modern ? 'urn:oasis:names:tc:xliff:document:2.0' : 'urn:oasis:names:tc:xliff:document:1.2';
  const languages = modern ? ` srcLang="${track.sourceLanguage}"${translated ? ` trgLang="${language}"` : ''}` : '';
  const content = ['<?xml version="1.0" encoding="UTF-8"?>', `<xliff version="${version}" xmlns="${namespace}"${languages}>`,
    ...track.documents.flatMap(file), '</xliff>', ''].join('\n');
  return { filename: 'translations.xlf', mediaType: 'application/xliff+xml', content };
}
export default tabularPlugin({ read, write });
