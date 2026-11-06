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
// WebVTT. Dropped on import: the header text, NOTE/STYLE/REGION blocks, cue identifiers and cue
// settings (position, align, ...). Cue text keeps its tags (<i>, <c.class>, <v Name>, <ruby>) verbatim.
const TIME = '((?:\\d{2,}:)?\\d{2}:\\d{2}\\.\\d{3})';
const TIMING = new RegExp(`^${TIME}[ \\t]+-->[ \\t]+${TIME}(?:[ \\t].*)?$`);
function parseTime(value) {
  const [seconds, millis] = value.split('.');
  const parts = seconds.split(':').map(BigInt);
  const [hours, minutes, secs] = parts.length === 3 ? parts : [0n, ...parts];
  if (minutes > 59n || secs > 59n) return null;
  return ((hours * 60n + minutes) * 60n + secs) * 1000n + BigInt(millis);
}
function read(input) {
  const [header, ...rest] = blocks(input);
  if (header.line !== 1 || !/^WEBVTT(?:[ \t].*)?$/.test(header.lines[0])) reject('invalid_input', { line: 1 });
  const cues = [];
  for (const block of rest) {
    if (/^(?:NOTE|STYLE|REGION)(?:[ \t]|$)/.test(block.lines[0])) continue;
    const at = block.lines[0].includes('-->') ? 0 : block.lines[1]?.includes('-->') ? 1 : 0;
    const line = block.line + at;
    const match = TIMING.exec(block.lines[at] ?? '');
    const start = match && parseTime(match[1]), end = match && parseTime(match[2]);
    if (start === null || end === null || !match) reject('invalid_input', { line });
    const text = block.lines.slice(at + 1);
    if (!text.length || text.some((entry) => entry.includes('-->'))) reject('invalid_input', { line: line + 1 });
    cues.push({ start, end, text: text.join('\n'), line });
  }
  return cues;
}
const stamp = (millis) => `${pad(millis / 3600000n, 2)}:${pad((millis / 60000n) % 60n, 2)}:${pad((millis / 1000n) % 60n, 2)}.${pad(millis % 1000n, 3)}`;
function write(cues) {
  for (const cue of cues) if (/\n\n|-->/.test(cue.text) || cue.text.startsWith('\n') || cue.text.endsWith('\n')) reject('invalid_input', { item: cue.item });
  return 'WEBVTT\n\n' + cues.map((cue) => `${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}`).join('\n\n') + '\n';
}
export default formatPlugin({ prefix: 'vtt', unit: 1n, filename: 'subtitles.vtt', mediaType: 'text/vtt', read, write });
