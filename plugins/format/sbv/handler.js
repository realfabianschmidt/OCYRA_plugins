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
// SBV (YouTube). Timing blocks only; there is no style data. Lines are joined with LF on export.
const TIMING = /^(\d+):(\d{2}):(\d{2})\.(\d{3}),(\d+):(\d{2}):(\d{2})\.(\d{3})$/;
function read(input) {
  return blocks(input).map((block) => {
    const match = TIMING.exec(block.lines[0]);
    if (!match) reject('invalid_input', { line: block.line });
    const [a, b, c, d, e, f, g, h] = match.slice(1).map(BigInt);
    if (b > 59n || c > 59n || f > 59n || g > 59n) reject('invalid_input', { line: block.line });
    if (block.lines.length < 2) reject('invalid_input', { line: block.line + 1 });
    return { start: ((a * 60n + b) * 60n + c) * 1000n + d, end: ((e * 60n + f) * 60n + g) * 1000n + h,
      text: block.lines.slice(1).join('\n'), line: block.line };
  });
}
const stamp = (millis) => `${millis / 3600000n}:${pad((millis / 60000n) % 60n, 2)}:${pad((millis / 1000n) % 60n, 2)}.${pad(millis % 1000n, 3)}`;
function write(cues) {
  for (const cue of cues) if (/\n\n/.test(cue.text) || cue.text.startsWith('\n') || cue.text.endsWith('\n')) reject('invalid_input', { item: cue.item });
  return cues.map((cue) => `${stamp(cue.start)},${stamp(cue.end)}\n${cue.text}`).join('\n\n') + '\n';
}
export default formatPlugin({ prefix: 'sbv', unit: 1n, filename: 'subtitles.sbv', mediaType: 'text/x-sbv', read, write });
