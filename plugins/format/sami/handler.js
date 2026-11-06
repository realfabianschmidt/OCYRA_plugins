// API v1: exact integer ticks, explicit results, no ambient or host access.
// ---- shared subtitle prelude (identical in every subtitle package; a test enforces it) ----
const TICKS_PER_MILLISECOND = 254016000n;
const MAX_TICK = 170141183460469231731687303715884105727n;
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
function blocks(input) {
  const out = [];
  let current = null;
  input.split('\n').forEach((text, index) => {
    if (text === '') { current = null; return; }
    if (!current) { current = { line: index + 1, lines: [] }; out.push(current); }
    current.lines.push(text);
  });
  return out;
}
const pad = (value, width) => String(value).padStart(width, '0');
// Times are whole counts of `unit` milliseconds. A tick that is not a whole count is refused, never rounded.
function toTicks(count, unit, line) {
  const ticks = count * unit * TICKS_PER_MILLISECOND;
  if (ticks > MAX_TICK) reject('invalid_input', { line });
  return String(ticks);
}
function toCount(value, unit, item) {
  if (typeof value !== 'string' || value.length > 39 || !/^(0|[1-9]\d*)$/.test(value)) reject('invalid_input', { item });
  const ticks = BigInt(value);
  if (ticks > MAX_TICK || ticks % (unit * TICKS_PER_MILLISECOND) !== 0n) reject('invalid_input', { item });
  return ticks / (unit * TICKS_PER_MILLISECOND);
}
// `read(text)` returns cues { start, end, text, line } in `unit` counts; `write(cues)` returns the file text.
function formatPlugin({ prefix, unit, filename, mediaType, read, write }) {
  function importFile(request) {
    if (request.target !== 'media-subtitle') reject('unsupported_input');
    const { file } = request;
    if (!shape(file, ['filename', 'mediaType', 'data']) || typeof file.filename !== 'string'
        || typeof file.mediaType !== 'string') reject();
    if (file.data?.encoding !== 'text') reject('unsupported_input');
    if (!shape(file.data, ['encoding', 'content']) || typeof file.data.content !== 'string') reject();
    const input = file.data.content.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    if (!input.trim()) reject('empty_input');
    const cues = read(input);
    if (!cues.length) reject('empty_input');
    const subtitles = cues.map((cue, index) => {
      if (cue.end <= cue.start) reject('invalid_input', { line: cue.line });
      return { id: `${prefix}-${index + 1}`, startTime: toTicks(cue.start, unit, cue.line),
        endTime: toTicks(cue.end, unit, cue.line), text: cue.text };
    });
    return { target: 'media-subtitle', track: { subtitles } };
  }
  function exportTrack(request) {
    if (typeof request.language !== 'string' || !request.language) reject();
    const { artifact } = request;
    if (!shape(artifact, ['target', 'track']) || artifact.target !== 'media-subtitle') reject('unsupported_input');
    if (!shape(artifact.track, ['subtitles']) || !Array.isArray(artifact.track.subtitles)) reject();
    if (!artifact.track.subtitles.length) reject('empty_input');
    const ids = new Set();
    const cues = artifact.track.subtitles.map((cue, index) => {
      const item = index + 1;
      if (!shape(cue, ['id', 'startTime', 'endTime', 'text']) || typeof cue.id !== 'string' || !cue.id
          || ids.has(cue.id) || typeof cue.text !== 'string' || !cue.text) reject('invalid_input', { item });
      ids.add(cue.id);
      const start = toCount(cue.startTime, unit, item), end = toCount(cue.endTime, unit, item);
      if (end <= start) reject('invalid_input', { item });
      return { start, end, text: cue.text, item };
    });
    return { filename, mediaType, data: { encoding: 'text', content: write(cues, request.language) } };
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
// SAMI. Kept: SYNC start times and the text of the P element; <br> is a line break and other inline
// tags (<i>, <b>, <font>) stay in the text verbatim. SAMI has no end time: a cue ends at the next SYNC,
// so a file whose last text SYNC is not closed by an empty one is refused. Dropped on import: the
// STYLE block, P class (language and style references) and everything outside SYNC. A SYNC with more
// than one P (several languages) is refused as unsupported. Export writes one class named after the
// language and refuses cues that overlap or share a start.
function lineAt(input, offset) { return input.slice(0, offset).split('\n').length; }
function read(input) {
  if (!/<sami[\s>]/i.test(input)) reject('invalid_input', { line: 1 });
  const syncs = [];
  const pattern = /<sync\b([^>]*)>([\s\S]*?)(?=<sync\b|<\/body>|<\/sami>|$)/gi;
  for (let found = pattern.exec(input); found; found = pattern.exec(input)) {
    const line = lineAt(input, found.index);
    const start = /\bstart\s*=\s*["']?(\d+)["']?/i.exec(found[1]);
    if (!start) reject('invalid_input', { line });
    const paragraphs = found[2].replace(/<\/sync>/gi, '').split(/<p\b[^>]*>/i).slice(1);
    if (!paragraphs.length) reject('invalid_input', { line });
    if (paragraphs.length > 1) reject('unsupported_input', { line });
    const text = paragraphs[0].replace(/<\/p>[\s\S]*$/i, '').replace(/\s+/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n').split('\n').map((entry) => entry.trim()).join('\n').trim();
    syncs.push({ start: BigInt(start[1]), text: text === '&nbsp;' ? '' : text, line });
  }
  if (!syncs.length) reject('invalid_input', { line: 1 });
  const cues = [];
  syncs.forEach((sync, index) => {
    const next = syncs[index + 1];
    if (next && next.start <= sync.start) reject('invalid_input', { line: next.line });
    if (!sync.text) return;
    if (!next) reject('invalid_input', { line: sync.line });
    cues.push({ start: sync.start, end: next.start, text: sync.text, line: sync.line });
  });
  return cues;
}
function write(cues, language) {
  const name = language.replace(/[^A-Za-z0-9]/g, '').toUpperCase() + 'CC';
  let previous = null;
  const syncs = cues.map((cue) => {
    if (previous && cue.start < previous.end) reject('invalid_input', { item: cue.item });
    const closed = previous && previous.end !== cue.start ? `<SYNC Start=${previous.end}><P Class=${name}>&nbsp;\n` : '';
    previous = cue;
    return `${closed}<SYNC Start=${cue.start}><P Class=${name}>${cue.text.replace(/\n/g, '<br>')}\n`;
  });
  return `<SAMI>
<HEAD>
<STYLE TYPE="text/css">
<!--
P { text-align:center; }
.${name} { Name:${language}; lang:${language}; SAMIType:CC; }
-->
</STYLE>
</HEAD>
<BODY>
${syncs.join('')}<SYNC Start=${previous.end}><P Class=${name}>&nbsp;
</BODY>
</SAMI>
`;
}
export default formatPlugin({ prefix: 'sami', unit: 1n, filename: 'subtitles.smi', mediaType: 'application/x-sami', read, write });
