import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import runSubrip from '../../plugins/format/subrip/handler.js';

import runAudit from '../../plugins/audit/foundation-policy/handler.js';

const audit = join('plugins', 'audit', 'foundation-policy');

test('SRT package preserves exact millisecond timestamps', async () => {
  const run = runSubrip;
  const result = await run({ sourceLanguage: 'en', target: 'media-subtitle', file: {
    filename: 'sample.srt', mediaType: 'application/x-subrip',
    data: { encoding: 'text', content: '1\n00:59:59,499 --> 01:00:01,000\nHello\n' },
  } });
  assert.equal(result.artifact.track.subtitles[0].startTime, String(3_599_499n * 254016000n));
  const exported = await run({ language: 'de', artifact: result.artifact });
  assert.equal(exported.artifact.data.content, '1\n00:59:59,499 --> 01:00:01,000\nHello\n\n');
});

test('synthetic policy resolves and marks video-only checks na for localization', async () => {
  const run = runAudit;
  const policy = readFileSync(join(audit, 'policy.json'), 'utf8');
  const host = { data: { read: async (path) => {
    assert.deepEqual(path, { path: 'policy.json' });
    return { content: policy };
  } } };
  const resolved = await run({ requestKind: 'resolve-policy', profileId: 'foundation-fixture' }, host);
  assert.equal(resolved.status, 'ok');
  assert.equal(resolved.artifact.policy.profileId, 'foundation-fixture');
  const report = await run({ requestKind: 'evaluate-audit', profileId: 'foundation-fixture',
    facts: { scope: 'localization-units', locale: 'de', units: [{
      id: 'u1', key: 'hello', documentId: 'd1', sourceLength: 5, targetLength: 0,
      hasTarget: false, reviewed: false, approved: false,
    }] },
  }, host);
  assert.equal(report.artifact.report.failCount, 1);
  assert.equal(report.artifact.report.checklist[1].status, 'na');
});
