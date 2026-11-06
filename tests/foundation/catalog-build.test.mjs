import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { build, DEVELOPMENT_KEY } from '../../tools/build-development.mjs';
import { crc32, zip } from '../../tools/zip.mjs';

const options = { baseUrl: 'https://example.invalid/development/', sequence: 1,
  issuedAt: '2026-10-23T00:00:00Z', expiresAt: '2026-10-24T00:00:00Z' };
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function temporary(run) {
  const root = mkdtempSync(join(tmpdir(), 'plugin-build-'));
  try { return run(root); } finally {
    const exact = resolve(root);
    assert.ok(exact.startsWith(resolve(tmpdir()) + sep) && basename(exact).startsWith('plugin-build-'));
    assert.ok(lstatSync(exact).isDirectory());
    rmSync(exact, { recursive: true });
  }
}
function inventory(path, prefix = '') {
  return readdirSync(path).sort().flatMap((name) => {
    const item = join(path, name), relative = prefix + name;
    return lstatSync(item).isDirectory() ? inventory(item, relative + '/') : [[relative, readFileSync(item)]];
  });
}

test('development build is byte deterministic, covers every file and signs exact domain-separated bytes', () => temporary((root) => {
  const first = join(root, 'one'), second = join(root, 'two');
  const proof = build({ ...options, output: first });
  assert.equal(proof.publisherKey, DEVELOPMENT_KEY);
  assert.equal(proof.archiveCount, 9);
  assert.deepEqual(build({ ...options, output: second }), proof);
  assert.deepEqual(inventory(first), inventory(second));
  const body = readFileSync(join(first, 'catalog/internal/catalog.json'));
  const signature = readFileSync(join(first, 'catalog/internal/catalog.json.sig'));
  assert.equal(signature.length, 64);
  const publicKey = createPublicKey({ key: Buffer.from('302a300506032b6570032100' + DEVELOPMENT_KEY.slice(8), 'hex'), format: 'der', type: 'spki' });
  assert.ok(verify(null, Buffer.concat([Buffer.from('catalog-signature-v1\0'), body]), publicKey, signature));
  assert.equal(verify(null, body, publicKey, signature), false);
  const altered = Buffer.from(body); altered[altered.length - 1] ^= 1;
  assert.equal(verify(null, Buffer.concat([Buffer.from('catalog-signature-v1\0'), altered]), publicKey, signature), false);
  const catalog = JSON.parse(body);
  assert.equal(sha(body), proof.catalogSha256);
  assert.equal(catalog.channel, 'internal');
  for (const record of catalog.plugins) {
    const archive = readFileSync(join(first, 'archives', record.manifest.id + '-' + record.manifest.version + '.zip'));
    assert.equal(sha(archive), record.archive.sha256);
    assert.equal(archive.length, record.archive.length);
    const end = archive.subarray(-22);
    assert.equal(end.readUInt32LE(), 0x06054b50);
    assert.equal(end.readUInt16LE(10), record.files.length);
    let offset = 0;
    for (const file of record.files) {
      assert.equal(archive.readUInt32LE(offset), 0x04034b50);
      const length = archive.readUInt32LE(offset + 18), nameLength = archive.readUInt16LE(offset + 26);
      const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString();
      const bytes = archive.subarray(offset + 30 + nameLength, offset + 30 + nameLength + length);
      assert.equal(name, file.path); assert.equal(bytes.length, file.length); assert.equal(sha(bytes), file.sha256);
      offset += 30 + nameLength + length;
    }
    assert.equal(offset, end.readUInt32LE(16));
  }
}));

test('hostile build metadata and existing output never overwrite a prior directory', () => temporary((root) => {
  for (const changed of [{ sequence: 0 }, { sequence: 1.5 }, { sequence: 9007199254740992 },
    { channel: 'unknown' }, { source: '../escape' }, { issuedAt: '2026-02-30T00:00:00Z' },
    { expiresAt: options.issuedAt }, { expiresAt: '2027-10-23T00:00:00Z' },
    { baseUrl: 'http://example.invalid/' }, { baseUrl: 'https://user@example.invalid/' },
    { baseUrl: 'https://example.invalid/#fragment' }, { baseUrl: 'https://example.invalid/no-slash' }]) {
    assert.throws(() => build({ ...options, ...changed, output: join(root, 'invalid') }));
  }
  const output = join(root, 'existing');
  build({ ...options, output });
  const before = inventory(output);
  assert.throws(() => build({ ...options, output }));
  assert.deepEqual(inventory(output), before);
}));

test('ZIP32 uses the independently fixed CRC vector and rejects oversized/count inputs', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const bytes = zip([{ path: 'fixture.txt', bytes: Buffer.from('123456789') }]);
  assert.equal(bytes.readUInt32LE(14), 0xcbf43926);
  assert.throws(() => zip([]));
  assert.throws(() => zip(new Array(4097).fill({ path: 'x', bytes: Buffer.alloc(0) })));
  assert.throws(() => zip([{ path: 'x'.repeat(257), bytes: Buffer.alloc(0) }]));
});
