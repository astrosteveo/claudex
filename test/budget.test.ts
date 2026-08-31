import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetGovernor, newUsage } from '../src/core/budget.ts';
import type { Budget } from '../src/core/types.ts';

const base: Budget = {
  maxPerSession: 3,
  cooldownMs: 0,
  timeoutMs: 1000,
  maxWallClockMs: -1,
  maxTokens: -1,
};

test('a reservation is taken before the peer runs, so parallel calls cannot all pass', () => {
  const g = new BudgetGovernor(base, newUsage('s'));
  // Three callers reserve without any of them settling — the shape of several
  // MCP tool calls arriving in one turn.
  assert.equal(g.reserve(), null);
  assert.equal(g.reserve(), null);
  assert.equal(g.reserve(), null);
  const fourth = g.reserve();
  assert.equal(fourth?.reason, 'session-limit');
  assert.equal(g.snapshot.consults, 3);
});

test('a released reservation frees the slot', () => {
  const g = new BudgetGovernor({ ...base, maxPerSession: 1 }, newUsage('s'));
  assert.equal(g.reserve(), null);
  assert.equal(g.reserve()?.reason, 'session-limit');
  g.release();
  assert.equal(g.reserve(), null);
});

test('policy-off denies with its own reason, not a session limit', () => {
  const g = new BudgetGovernor({ ...base, maxPerSession: 0 }, newUsage('s'));
  const d = g.reserve();
  assert.equal(d?.reason, 'policy-off');
  assert.match(d!.message, /Do not retry/);
});

test('cooldown reports how long is left and clears when it elapses', () => {
  let now = 1_000_000;
  const g = new BudgetGovernor({ ...base, maxPerSession: -1, cooldownMs: 10_000 }, newUsage('s'), () => now);
  assert.equal(g.reserve(), null);
  now += 3_000;
  const d = g.reserve();
  assert.equal(d?.reason, 'cooldown');
  assert.equal(d?.retryAfterMs, 7_000);
  now += 8_000;
  assert.equal(g.reserve(), null);
});

test('wall clock and token caps deny once exceeded', () => {
  const g = new BudgetGovernor({ ...base, maxPerSession: -1, maxWallClockMs: 5_000 }, newUsage('s'));
  assert.equal(g.reserve(), null);
  g.settle('ask', 6_000);
  assert.equal(g.reserve()?.reason, 'wall-clock');

  const t = new BudgetGovernor({ ...base, maxPerSession: -1, maxTokens: 100 }, newUsage('s'));
  assert.equal(t.reserve(), null);
  t.settle('ask', 10, 150);
  assert.equal(t.reserve()?.reason, 'token-budget');
});

test('a failed peer still costs its wall clock', () => {
  const g = new BudgetGovernor({ ...base, maxPerSession: -1 }, newUsage('s'));
  g.reserve();
  g.settle('review', 45_000, 0);
  assert.equal(g.snapshot.wallClockMs, 45_000);
  assert.equal(g.snapshot.byKind['review'], 1);
});

test('unlimited sessions report Infinity remaining', () => {
  const g = new BudgetGovernor({ ...base, maxPerSession: -1 }, newUsage('s'));
  assert.equal(g.remaining(), Infinity);
});
