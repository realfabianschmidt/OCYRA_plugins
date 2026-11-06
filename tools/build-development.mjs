import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { zip } from './zip.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = ['subrip', 'webvtt', 'ass', 'sbv', 'sami', 'xliff', 'csv', 'i18n-json']
  .map((name) => `plugins/format/${name}`).concat('plugins/audit/foundation-policy');
const DOMAIN = Buffer.from('catalog-signature-v1\0');
export const DEVELOPMENT_KEY = 'ed25519:d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const token = (value) => typeof value === 'string' && value.length <= 128 && /^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$/i.test(value);

const git = (args, limit = 2 * 1024 * 1024) => execFileSync('git', args, { cwd: ROOT, maxBuffer: limit });
function packageFiles(directory) {
  const prefix = directory + '/';
  const entries = git(['ls-tree', '-r', '-l', '-z', 'HEAD', '--', directory]).toString('utf8').split('\0').filter(Boolean);
  if (!entries.length || entries.length > 4096) throw new Error('package count');
  let total = 0;
  const seen = new Set();
  return entries.map((entry) => {
    const split = entry.indexOf('\t'), [mode, kind, object, size] = entry.slice(0, split).trim().split(/\s+/);
    const full = entry.slice(split + 1), path = full.slice(prefix.length), length = Number(size);
    if (split < 0 || !full.startsWith(prefix) || !['100644', '100755'].includes(mode) || kind !== 'blob' ||
        !/^[a-f0-9]{40,64}$/.test(object) || !Number.isSafeInteger(length) || length < 0 || length > 32 * 1024 * 1024 ||
        path.length > 256 || !path.split('/').every(token) || (total += length) > 64 * 1024 * 1024 ||
        seen.has(path.toLowerCase())) throw new Error('package path/type/size');
    seen.add(path.toLowerCase());
    const bytes = git(['cat-file', 'blob', object], 32 * 1024 * 1024 + 1);
    if (bytes.length !== length) throw new Error('blob length');
    return { path, bytes };
  }).sort((a, b) => a.path < b.path ? -1 : 1);
}

function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)) throw new Error('UTC instant');
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value.replace('Z', '.000Z')) throw new Error('UTC date');
  return millis;
}

export function build({ output, baseUrl, sequence, issuedAt, expiresAt, channel = 'internal', source = 'first-party' }) {
  if (!output || !['stable', 'beta', 'internal'].includes(channel) || !token(source)) throw new Error('build identity');
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('sequence');
  const issued = instant(issuedAt), expires = instant(expiresAt);
  if (expires <= issued || expires - issued > 90 * 86400000) throw new Error('expiry');
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.hash || base.search || !base.pathname.endsWith('/')) throw new Error('archive base');
  // Refuse an existing output; never overwrite an unrelated directory or its contents.
  const out = resolve(output);
  mkdirSync(out);
  mkdirSync(join(out, 'archives'));
  if (git(['status', '--porcelain', '--untracked-files=all', '--', ...PACKAGES]).length) throw new Error('commit package changes before building');
  const sourceCommit = git(['rev-parse', 'HEAD']).toString('ascii').trim();
  const records = PACKAGES.map((relative) => {
    const files = packageFiles(relative);
    const manifestFile = files.find((file) => file.path === 'manifest.json');
    if (!manifestFile || manifestFile.bytes.length > 65536) throw new Error('manifest');
    const manifest = JSON.parse(manifestFile.bytes.toString('utf8'));
    if (!token(manifest.id) || typeof manifest.version !== 'string' || !/^[0-9A-Za-z.+-]{1,128}$/.test(manifest.version) ||
        manifest.plugin_api_version !== 1 || manifest.runtime?.mode !== 'quickjs') throw new Error('v1 package');
    const archive = zip(files), name = manifest.id + '-' + manifest.version + '.zip';
    writeFileSync(join(out, 'archives', name), archive, { flag: 'wx' });
    return { manifest, archive: { url: new URL('archives/' + name, base).href, sha256: sha(archive), length: archive.length },
      files: files.map(({ path, bytes }) => ({ path, sha256: sha(bytes), length: bytes.length })) };
  }).sort((a, b) => a.manifest.id < b.manifest.id ? -1 : 1);
  if (new Set(records.map((record) => record.manifest.id)).size !== records.length) throw new Error('duplicate identity');
  const catalog = { schema_version: 1, source, channel, sequence, issued_at: issuedAt, expires_at: expiresAt,
    plugins: records, dependencies: [] };
  const bytes = Buffer.from(JSON.stringify(catalog) + '\n');
  if (bytes.length > 8 * 1024 * 1024) throw new Error('catalog size');
  // RFC 8032 test 1 PUBLIC seed, development fixtures only. Never an operational signer.
  const seed = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
  const key = createPrivateKey({ key: Buffer.from('302e020100300506032b657004220420' + seed, 'hex'), format: 'der', type: 'pkcs8' });
  const signature = sign(null, Buffer.concat([DOMAIN, bytes]), key);
  const directory = join(out, 'catalog', channel);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'catalog.json'), bytes, { flag: 'wx' });
  writeFileSync(join(directory, 'catalog.json.sig'), signature, { flag: 'wx' });
  return { sourceCommit, catalogSha256: sha(bytes), publisherKey: DEVELOPMENT_KEY, channel, archiveCount: records.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    out: { type: 'string' }, 'base-url': { type: 'string' }, sequence: { type: 'string' },
    'issued-at': { type: 'string' }, 'expires-at': { type: 'string' }, channel: { type: 'string' }, source: { type: 'string' },
  } });
  if (!/^[1-9][0-9]*$/.test(values.sequence ?? '')) throw new Error('integer sequence required');
  const result = build({ output: values.out, baseUrl: values['base-url'], sequence: Number(values.sequence),
    issuedAt: values['issued-at'], expiresAt: values['expires-at'], channel: values.channel, source: values.source });
  process.stdout.write(JSON.stringify(result) + '\n');
}
