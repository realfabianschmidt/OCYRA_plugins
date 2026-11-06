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
// ASS and SSA. Kept: Start, End, Text. Dropped on import: every other Dialogue column (layer, style,
// speaker name, margins, effect), Comment lines and all sections other than [Events] (script info,
// styles, fonts, graphics). Override tags such as {\an8} or {\i1} stay in the text verbatim, and
// \N is the line break. Export writes one Default style.
const TIME = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/;
function read(input) {
  const lines = input.split('\n');
  let inEvents = false, columns = null;
  const cues = [];
  lines.forEach((text, index) => {
    const line = index + 1;
    if (/^\[.*\]\s*$/.test(text)) { inEvents = /^\[events\]\s*$/i.test(text); return; }
    if (!inEvents) return;
    const format = /^Format:\s*(.*)$/i.exec(text);
    if (format) { columns = format[1].split(',').map((name) => name.trim().toLowerCase()); return; }
    const dialogue = /^Dialogue:\s?(.*)$/i.exec(text);
    if (!dialogue) return;
    const at = (name) => columns?.indexOf(name) ?? -1;
    if (!columns || at('start') < 0 || at('end') < 0 || at('text') !== columns.length - 1) reject('invalid_input', { line });
    const fields = dialogue[1].split(','), last = columns.length - 1;
    if (fields.length < columns.length) reject('invalid_input', { line });
    const [start, end] = ['start', 'end'].map((name) => {
      const match = TIME.exec(fields[at(name)].trim());
      if (!match) reject('invalid_input', { line });
      const [h, m, s, cs] = match.slice(1).map(BigInt);
      if (m > 59n || s > 59n) reject('invalid_input', { line });
      return ((h * 60n + m) * 60n + s) * 100n + cs;
    });
    const body = [...fields.slice(last)].join(',').replace(/\\N/g, '\n');
    if (!body) reject('invalid_input', { line });
    cues.push({ start, end, text: body, line });
  });
  if (columns === null) reject('invalid_input', { line: 1 });
  return cues;
}
const stamp = (cs) => `${cs / 360000n}:${pad((cs / 6000n) % 60n, 2)}:${pad((cs / 100n) % 60n, 2)}.${pad(cs % 100n, 2)}`;
const HEADER = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
function write(cues) {
  return HEADER + cues.map((cue) => `Dialogue: 0,${stamp(cue.start)},${stamp(cue.end)},Default,,0,0,0,,${cue.text.replace(/\n/g, '\\N')}`).join('\n') + '\n';
}
export default formatPlugin({ prefix: 'ass', unit: 10n, filename: 'subtitles.ass', mediaType: 'text/x-ssa', read, write });
