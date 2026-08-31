import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, parseTimeout, findProjectRoot, POLICY_BUDGETS } from '../src/core/config.ts';

function fixture(config: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'claudex-test-'));
  mkdirSync(join(root, '.claudex'), { recursive: true });
  writeFileSync(join(root, '.claudex', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return root;
}

test('a non-positive timeout falls back instead of disabling the kill timer', () => {
  // A falsy timeout silently disables the only thing that reclaims a wedged peer.
  assert.equal(parseTimeout(0, 5000), 5000);
  assert.equal(parseTimeout(-1, 5000), 5000);
  assert.equal(parseTimeout('nonsense', 5000), 5000);
  assert.equal(parseTimeout(undefined, 5000), 5000);
  assert.equal(parseTimeout(1234, 5000), 1234);
});

test('a malformed config falls back to defaults rather than throwing', () => {
  // A broken config must not take the MCP server down.
  const root = fixture('{ not json at all');
  const c = loadConfig(root);
  assert.equal(c.policy, 'on-request');
  assert.equal(c.budget.maxPerSession, POLICY_BUDGETS['on-request'].maxPerSession);
});

test('an unknown policy name is ignored rather than trusted', () => {
  const root = fixture({ policy: 'unlimited-please' });
  assert.equal(loadConfig(root).policy, 'on-request');
});

test('a policy sets its own budget, and explicit budget keys still win', () => {
  const off = loadConfig(fixture({ policy: 'off' }));
  assert.equal(off.budget.maxPerSession, 0);

  const tuned = loadConfig(fixture({ policy: 'assisted', budget: { maxPerSession: 2 } }));
  assert.equal(tuned.budget.maxPerSession, 2);
  assert.equal(tuned.budget.cooldownMs, POLICY_BUDGETS.assisted.cooldownMs);
});

test('the environment overrides project config for a single run', () => {
  const root = fixture({ policy: 'off' });
  process.env['CLAUDEX_POLICY'] = 'aggressive';
  try {
    assert.equal(loadConfig(root).policy, 'aggressive');
  } finally {
    delete process.env['CLAUDEX_POLICY'];
  }
});

test('a zero timeout in config cannot disable the kill timer', () => {
  const root = fixture({ budget: { timeoutMs: 0 } });
  assert.ok(loadConfig(root).budget.timeoutMs > 0);
});

test('default mode is read unless explicitly widened', () => {
  assert.equal(loadConfig(fixture({})).defaultMode, 'read');
  assert.equal(loadConfig(fixture({ defaultMode: 'write' })).defaultMode, 'write');
  assert.equal(loadConfig(fixture({ defaultMode: 'nonsense' })).defaultMode, 'read');
});

test('a .claudex directory marks the project root over an enclosing repo', () => {
  const root = fixture({});
  const nested = join(root, 'a', 'b');
  mkdirSync(nested, { recursive: true });
  assert.equal(findProjectRoot(nested), root);
});

test('a review gets more time than a question, because it is more work', async () => {
  const { KIND_TIMEOUT_MULTIPLIER } = await import('../src/core/config.ts');
  assert.equal(KIND_TIMEOUT_MULTIPLIER.ask, 1);
  assert.ok(KIND_TIMEOUT_MULTIPLIER.review > KIND_TIMEOUT_MULTIPLIER.ask);
  assert.ok(KIND_TIMEOUT_MULTIPLIER.solve > KIND_TIMEOUT_MULTIPLIER.ask);
  // Every kind must have a positive multiplier: a zero would silently disable
  // the only thing that reclaims a wedged peer.
  for (const [kind, m] of Object.entries(KIND_TIMEOUT_MULTIPLIER)) {
    assert.ok(m > 0, `${kind} multiplier must be positive`);
  }
});
