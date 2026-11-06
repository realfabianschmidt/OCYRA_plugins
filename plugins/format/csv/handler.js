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
// CSV (RFC 4180). Columns, by header name: key and source (required), context and notes (optional, one
// note per line), and one column per target language named by its language tag. The delimiter is the
// one of , ; or tab that the header row uses; a header that uses two equally often is refused as
// ambiguous. Input is UTF-8 (BOM allowed) or UTF-16 with a BOM; a file in any other encoding is refused.
// Export writes UTF-8 without a BOM, the comma delimiter, CRLF rows, and every target language column.
// CSV has no review state: a filled target reads as translated, and the state is not written back.
function records(text) {
  const header = text.split('\n', 1)[0];
  const counts = [',', ';', '\t'].map((delimiter) => {
    let quoted = false, count = 0;
    for (const c of header) { if (c === '"') quoted = !quoted; else if (!quoted && c === delimiter) count++; }
    return count;
  });
  const best = Math.max(...counts);
  if (!best) reject('invalid_input', { line: 1 });
  if (counts.filter((count) => count === best).length > 1) reject('unsupported_input', { line: 1 });
  const delimiter = [',', ';', '\t'][counts.indexOf(best)];
  const rows = [];
  let row = [], field = '', quoted = false, opened = false, line = 1, rowLine = 1, quoteLine = 1;
  const endField = () => { row.push(field); field = ''; opened = false; };
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0] !== '') rows.push({ cells: row, line: rowLine });
    row = [];
    rowLine = line + 1;
  };
  for (let at = 0; at < text.length; at++) {
    const c = text[at];
    if (quoted) {
      if (c === '"' && text[at + 1] === '"') { field += '"'; at++; } else if (c === '"') quoted = false; else { if (c === '\n') line++; field += c; }
    } else if (c === '"') {
      if (field !== '' || opened) reject('invalid_input', { line });
      quoted = opened = true;
      quoteLine = line;
    } else if (c === delimiter) endField();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[at + 1] === '\n') at++;
      endRow();
      line++;
    } else if (opened) reject('invalid_input', { line });
    else field += c;
  }
  if (quoted) reject('invalid_input', { line: quoteLine });
  if (field !== '' || row.length) endRow();
  return rows;
}
const FIXED = ['key', 'source', 'context', 'notes'];
function read(text, request) {
  const [header, ...rows] = records(text);
  const names = header.cells.map((name) => name.trim());
  const lower = names.map((name) => name.toLowerCase());
  const column = (name) => lower.indexOf(name);
  const languages = names.filter((name, index) => !FIXED.includes(lower[index]));
  const where = (name) => names.indexOf(name);
  if (column('key') < 0 || column('source') < 0 || new Set(lower).size !== lower.length
      || languages.some((name) => !LANGUAGE.test(name) || sameLanguage(name, request.sourceLanguage))) reject('invalid_input', { line: 1 });
  const ids = new Set();
  const units = rows.map((row) => {
    if (row.cells.length !== names.length) reject('invalid_input', { line: row.line });
    const cell = (name) => row.cells[column(name)] ?? '';
    const key = cell('key');
    const id = `document-1.${encodeId(key)}`;
    if (!key.trim() || id.length > 128 || ids.has(id)) reject('invalid_input', { line: row.line });
    ids.add(id);
    const notes = cell('notes').split('\n').filter((note) => note.trim());
    return { id, key, documentId: 'document-1', source: cell('source'), sourceMarkup: [],
      targets: languages.filter((name) => row.cells[where(name)].trim()).map((name) => ({ language: name, text: row.cells[where(name)],
        reviewState: 'translated', provenanceReference: null, markup: [] })),
      context: cell('context'), notes, reference: null };
  });
  if (!units.length) reject('empty_input');
  const { filename } = request.file;
  return { sourceLanguage: request.sourceLanguage, targetLanguages: languages,
    documents: [{ id: 'document-1', name: filename.trim() || 'document-1', original: filename, dataType: 'csv', fileId: '' }], units };
}
const cell = (value) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
function write(track) {
  const rows = [[...FIXED, ...track.targetLanguages], ...track.units.map((unit) => [unit.key, unit.source, unit.context, unit.notes.join('\n'),
    ...track.targetLanguages.map((language) => unit.targets.find((target) => sameLanguage(target.language, language))?.text ?? '')])];
  return { filename: 'translations.csv', mediaType: 'text/csv', content: rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n' };
}
export default tabularPlugin({ read, write });
