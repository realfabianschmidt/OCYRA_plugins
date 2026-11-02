// API v1: exact integer ticks, explicit results, no ambient or host access.
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
function parseTime(value, line) {
  const match = /^(\d{2,24}):(\d{2}):(\d{2}),(\d{3})$/.exec(value);
  if (!match) reject('invalid_input', { line });
  const [, hours, minutes, seconds, millis] = match;
  if (Number(minutes) > 59 || Number(seconds) > 59) reject('invalid_input', { line });
  const valueMs = ((BigInt(hours) * 60n + BigInt(minutes)) * 60n + BigInt(seconds)) * 1000n + BigInt(millis);
  if (valueMs * TICKS_PER_MILLISECOND > MAX_TICK) reject('invalid_input', { line });
  return valueMs;
}
function tick(value, item) {
  if (typeof value !== 'string' || value.length > 39 || !/^(0|[1-9]\d*)$/.test(value)) reject('invalid_input', { item });
  const parsed = BigInt(value);
  if (parsed > MAX_TICK || parsed % TICKS_PER_MILLISECOND !== 0n) reject('invalid_input', { item });
  return parsed;
}
function formatTime(value) {
  const millis = value / TICKS_PER_MILLISECOND;
  return `${String(millis / 3600000n).padStart(2, '0')}:${String((millis / 60000n) % 60n).padStart(2, '0')}:${String((millis / 1000n) % 60n).padStart(2, '0')},${String(millis % 1000n).padStart(3, '0')}`;
}
function importFile(request) {
  if (request.target !== 'media-subtitle') reject('unsupported_input');
  // The Rust host validates BCP 47; the package requires the confirmed bounded tag too.
  if (typeof request.sourceLanguage !== 'string' || !request.sourceLanguage
      || request.sourceLanguage.length > 255 || !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(request.sourceLanguage)) reject();
  const { file } = request;
  if (!shape(file, ['filename', 'mediaType', 'data']) || typeof file.filename !== 'string'
      || file.mediaType !== 'application/x-subrip') reject();
  if (file.data?.encoding !== 'text') reject('unsupported_input');
  if (!shape(file.data, ['encoding', 'content']) || typeof file.data.content !== 'string') reject();
  const input = file.data.content.replace(/\r\n/g, '\n');
  if (!input.trim()) reject('empty_input');
  const lines = input.split('\n');
  const subtitles = [];
  let cursor = 0;
  while (cursor < lines.length) {
    if (lines[cursor] === '') { cursor++; continue; }
    const header = cursor;
    if (lines[cursor++] !== String(subtitles.length + 1)) reject('invalid_input', { line: header + 1 });
    const stamp = /^(\S+) --> (\S+)$/.exec(lines[cursor++] ?? '');
    if (!stamp) reject('invalid_input', { line: header + 2 });
    const start = parseTime(stamp[1], header + 2);
    const end = parseTime(stamp[2], header + 2);
    if (end <= start) reject('invalid_input', { line: header + 2 });
    const text = [];
    while (cursor < lines.length && lines[cursor] !== '') {
      if (/^\d+$/.test(lines[cursor]) && lines[cursor + 1]?.includes('-->')) reject('invalid_input', { line: cursor + 1 });
      text.push(lines[cursor++]);
    }
    if (!text.length) reject('invalid_input', { line: header + 3 });
    subtitles.push({ id: `srt-${subtitles.length + 1}-${start}-${end}`,
      startTime: String(start * TICKS_PER_MILLISECOND), endTime: String(end * TICKS_PER_MILLISECOND), text: text.join('\n') });
  }
  return { target: 'media-subtitle', track: { subtitles } };
}
function exportTrack(request) {
  if (typeof request.language !== 'string' || !request.language) reject();
  const { artifact } = request;
  if (!shape(artifact, ['target', 'track']) || artifact.target !== 'media-subtitle') reject('unsupported_input');
  if (!shape(artifact.track, ['subtitles']) || !Array.isArray(artifact.track.subtitles)) reject();
  if (!artifact.track.subtitles.length) reject('empty_input');
  const ids = new Set();
  const content = artifact.track.subtitles.map((cue, index) => {
    const item = index + 1;
    if (!shape(cue, ['id', 'startTime', 'endTime', 'text']) || typeof cue.id !== 'string' || !cue.id
        || ids.has(cue.id) || typeof cue.text !== 'string' || !cue.text) reject('invalid_input', { item });
    ids.add(cue.id);
    const start = tick(cue.startTime, item);
    const end = tick(cue.endTime, item);
    if (end <= start) reject('invalid_input', { item });
    return `${item}\n${formatTime(start)} --> ${formatTime(end)}\n${cue.text}`;
  }).join('\n\n') + '\n\n';
  return { filename: 'subtitles.srt', mediaType: 'application/x-subrip', data: { encoding: 'text', content } };
}
export default async function run(request) {
  try {
    const artifact = shape(request, ['target', 'file', 'sourceLanguage']) ? importFile(request)
      : shape(request, ['language', 'artifact']) ? exportTrack(request) : reject();
    return { status: 'ok', artifact };
  } catch (error) {
    if (error instanceof Rejection) return error.result;
    throw error;
  }
}
