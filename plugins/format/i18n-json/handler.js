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
// i18n JSON: one language per file, flat or nested objects of strings. A nested path joins with a dot to
// form the key; the path itself is kept in the unit reference, so export rebuilds the same nesting and a
// flat key that contains dots stays flat. ICU MessageFormat and {{mustache}} arguments are protected:
// every brace group, balanced to its close, is one code whose id and label are the group itself.
// A plural or select block is therefore one opaque code, not translatable text. Numbers, booleans, null
// and arrays are refused as unsupported. Import yields source strings only (no targets); export writes
// the source strings when the language is the source language, otherwise the targets, omitting a key
// that has no target.
const VERSION = 'i18n-json';
function tokens(text, location) {
  const out = [];
  let from = 0;
  for (let at = text.indexOf('{'); at >= 0; at = text.indexOf('{', from)) {
    let depth = 0, end = at;
    for (; end < text.length; end++) {
      if (text[end] === '{') depth++;
      else if (text[end] === '}' && --depth === 0) break;
    }
    if (end === text.length) reject('invalid_input', location);
    if (at > from) out.push({ kind: 'text', text: text.slice(from, at) });
    out.push({ kind: 'code', id: text.slice(at, end + 1), label: text.slice(at, end + 1) });
    from = end + 1;
  }
  if (from < text.length) out.push({ kind: 'text', text: text.slice(from) });
  return out;
}
function read(text, request) {
  let root;
  try { root = JSON.parse(text); } catch { reject('invalid_input'); }
  const leaves = [];
  const walk = (value, path) => {
    if (typeof value === 'string') { leaves.push([path, value]); return; }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) reject('unsupported_input');
    if (path.length > 32) reject('invalid_input');
    for (const key of Object.keys(value)) walk(value[key], [...path, key]);
  };
  if (root === null || typeof root !== 'object' || Array.isArray(root)) reject('unsupported_input');
  walk(root, []);
  if (!leaves.length) reject('empty_input');
  const ids = new Set();
  const units = leaves.map(([path, value], index) => {
    const key = path.join('.');
    const id = `document-1.${encodeId(key)}`;
    if (!key || id.length > 128 || ids.has(id)) reject('invalid_input', { item: index + 1 });
    ids.add(id);
    const markup = tokens(value, { item: index + 1 });
    return { id, key, documentId: 'document-1', source: value, sourceMarkup: markup.some((token) => token.kind === 'code') ? markup : [],
      targets: [], context: '', notes: [], reference: { version: VERSION, documentId: 'document-1', fileId: '', unitId: JSON.stringify(path), segmentId: '' } };
  });
  const { filename } = request.file;
  return { sourceLanguage: request.sourceLanguage, targetLanguages: [],
    documents: [{ id: 'document-1', name: filename.trim() || 'document-1', original: filename, dataType: 'json', fileId: '' }], units };
}
function write(track, language) {
  const root = Object.create(null);
  track.units.forEach((unit, index) => {
    let value = unit.source;
    if (!sameLanguage(language, track.sourceLanguage)) {
      const target = unit.targets.find((entry) => sameLanguage(entry.language, language));
      if (!target) return;
      value = target.markup?.length ? target.markup.map((token) => (token.kind === 'text' ? token.text : token.id)).join('') : target.text;
    }
    let path = [unit.key];
    if (unit.reference?.version === VERSION) {
      try { path = JSON.parse(unit.reference.unitId); } catch { reject('invalid_input', { item: index + 1 }); }
    }
    let node = root;
    path.slice(0, -1).forEach((step) => {
      if (!Object.hasOwn(node, step)) node[step] = Object.create(null);
      if (typeof node[step] === 'string') reject('invalid_input', { item: index + 1 });
      node = node[step];
    });
    const last = path[path.length - 1];
    if (Object.hasOwn(node, last)) reject('invalid_input', { item: index + 1 });
    node[last] = value;
  });
  return { filename: 'translations.json', mediaType: 'application/json', content: JSON.stringify(root, null, 2) + '\n' };
}
export default tabularPlugin({ read, write });
