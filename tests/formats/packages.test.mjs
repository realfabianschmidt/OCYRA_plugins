import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

// Mirrors the Rust PluginManifestV1 rules for a format package. The schema generated from Rust is not
// available to this repository yet; replace this check with it when the app publishes the file.
const KEYS = ['id', 'name', 'version', 'plugin_api_version', 'role', 'runtime', 'entry', 'capabilities', 'limits',
  'description', 'family', 'format', 'binary', 'locales'];
const LIMITS = ['maxBatchItems', 'maxInputBytes', 'maxOutputBytes', 'timeoutMs', 'memoryBytes'];
const root = 'plugins/format';
const packages = readdirSync(root).sort();

test('every format package has a valid v1 manifest, an entry and EN/DE/FR locale bundles', () => {
  assert.ok(packages.length >= 8, packages.join());
  for (const name of packages) {
    const directory = join(root, name);
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    assert.ok(Object.keys(manifest).every((key) => KEYS.includes(key)), name);
    assert.match(manifest.id, /^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$/);
    assert.equal(manifest.id, `format-plugin-${name}`);
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.equal(manifest.plugin_api_version, 1);
    assert.deepEqual([manifest.role, manifest.family, manifest.runtime], ['format', 'format', { mode: 'quickjs' }]);
    assert.deepEqual(manifest.capabilities, []);
    assert.deepEqual(Object.keys(manifest.limits).sort(), [...LIMITS].sort());
    assert.ok(Object.values(manifest.limits).every((value) => Number.isSafeInteger(value) && value > 0));
    assert.ok(existsSync(join(directory, manifest.entry)) && /^[\w.-]+$/.test(manifest.entry));
    const { format } = manifest;
    assert.ok(['media-subtitle', 'document-tabular'].includes(format.target));
    assert.ok(format.directions.length && new Set(format.directions).size === format.directions.length
      && format.directions.every((direction) => ['import', 'export'].includes(direction)));
    assert.ok(format.extensions.length && new Set(format.extensions).size === format.extensions.length
      && format.extensions.every((extension) => /^[a-z0-9]{1,16}$/.test(extension)));
    assert.deepEqual(Object.keys(manifest.locales).sort(), ['de', 'en', 'fr']);
    for (const path of Object.values(manifest.locales)) {
      const bundle = JSON.parse(readFileSync(join(directory, path), 'utf8'));
      assert.deepEqual(Object.keys(bundle).sort(), ['description', 'title']);
      assert.ok(Object.values(bundle).every((value) => typeof value === 'string' && value));
    }
  }
});

// The packages cannot import a shared module, so each carries a copy of its prelude. Keep the copies equal.
test('shared preludes are identical across the packages that carry them', () => {
  for (const [marker, members] of [['subtitle', ['webvtt', 'ass', 'sbv', 'sami']], ['tabular', ['xliff', 'csv', 'i18n-json']]]) {
    const preludes = members.map((name) => {
      const source = readFileSync(join(root, name, 'handler.js'), 'utf8');
      const start = source.indexOf(`// ---- shared ${marker} prelude`), end = source.indexOf('// ---- end of shared prelude ----');
      assert.ok(start >= 0 && end > start, name);
      return source.slice(start, end);
    });
    assert.ok(preludes.every((prelude) => prelude === preludes[0]), marker);
  }
});
