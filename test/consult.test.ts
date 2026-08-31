import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsultService } from '../src/core/consult.ts';
import { loadConfig } from '../src/core/config.ts';

function project(config: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'claudex-consult-'));
  mkdirSync(join(root, '.claudex'), { recursive: true });
  writeFileSync(join(root, '.claudex', 'config.json'), JSON.stringify(config));
  return root;
}

test('a denied review never runs the verify command', async () => {
  // The verify command is a full test suite. Running it only to then refuse the
  // consult wastes more of the user's time than the consult would have taken.
  const root = project({ policy: 'off' });
  const sentinel = join(root, 'verify-ran');
  writeFileSync(join(root, '.claudex', 'config.json'), JSON.stringify({
    policy: 'off',
    verifyCommand: `touch ${JSON.stringify(sentinel)}`,
  }));

  const service = new ConsultService(loadConfig(root));
  const res = await service.review(null);

  assert.ok(res.denied, 'expected a budget denial');
  assert.equal(res.verdict.verdict, 'unknown', 'a denial is never an approval');
  assert.ok(!existsSync(sentinel), 'verify must not run when the consult is refused');
});

test('a denied consult never spawns the peer and never approves', async () => {
  const service = new ConsultService(loadConfig(project({ policy: 'off' })));
  const started = Date.now();
  const res = await service.ask('anything', null);
  assert.ok(Date.now() - started < 2000, 'a denial must be immediate');
  assert.equal(res.ok, false);
  assert.equal(res.denied?.reason, 'policy-off');
  assert.equal(res.threadId, null);
});

test('a spent session reports zero remaining rather than a negative number', async () => {
  const service = new ConsultService(loadConfig(project({ budget: { maxPerSession: 1 } })));
  service.governor.reserve();
  const res = await service.ask('anything', null);
  assert.equal(res.denied?.reason, 'session-limit');
  assert.equal(res.budgetRemaining, 0);
});
