import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs } from '../src/adapters/codex.ts';
import { buildClaudeArgs } from '../src/adapters/claude.ts';

const base = {
  prompt: 'x',
  cwd: '/tmp/repo',
  mode: 'read' as const,
  kind: 'ask' as const,
  timeoutMs: 1000,
};

test('a fresh consult passes the sandbox and working directory as flags', () => {
  const args = buildArgs(base);
  assert.deepEqual(args.slice(0, 5), ['exec', '-s', 'read-only', '-C', '/tmp/repo']);
});

test('a resumed consult never passes -s or -C, which codex exec resume rejects', () => {
  // Verified against codex 0.151: `codex exec resume ... -s read-only` fails with
  // "unexpected argument '-s' found". The sandbox has to be a config override,
  // or a consult the caller asked to be read-only runs unsandboxed.
  const args = buildArgs({ ...base, threadId: 'abc-123' });
  assert.ok(!args.includes('-s'), 'resume must not pass -s');
  assert.ok(!args.includes('-C'), 'resume must not pass -C');
  assert.ok(!args.includes('--sandbox'));
  const i = args.indexOf('-c');
  assert.ok(i > 0, 'resume must restate the sandbox as a config override');
  assert.equal(args[i + 1], 'sandbox_mode=read-only');
  assert.equal(args[1], 'resume');
  assert.equal(args[2], 'abc-123');
});

test('every mode maps to a real codex sandbox, on both the fresh and resume paths', () => {
  for (const [mode, expected] of [
    ['read', 'read-only'],
    ['write', 'workspace-write'],
    ['full', 'danger-full-access'],
  ] as const) {
    assert.ok(buildArgs({ ...base, mode }).includes(expected));
    const resumed = buildArgs({ ...base, mode, threadId: 't' });
    assert.ok(resumed.includes(`sandbox_mode=${expected}`));
  }
});

test('the prompt never appears in argv', () => {
  // Linux caps one argv entry at 128 KiB; a prompt carrying a diff exceeds it.
  const big = 'y'.repeat(200_000);
  const args = buildArgs({ ...base, prompt: big });
  assert.ok(!args.some((a) => a.includes('yyyy')), 'prompt must go over stdin');
  assert.equal(args.at(-1), '-', 'trailing - makes codex read stdin');
});

test('a positive timeout is required, because it is the only way to reclaim a wedged peer', async () => {
  const { runCodex } = await import('../src/adapters/codex.ts');
  await assert.rejects(() => runCodex({ ...base, timeoutMs: 0 }), /timeoutMs must be positive/);
  await assert.rejects(() => runCodex({ ...base, timeoutMs: -1 }), /timeoutMs must be positive/);
});

test('claude stream-json is always paired with --verbose, which it requires', () => {
  const args = buildClaudeArgs({ ...base, mode: 'read' });
  const i = args.indexOf('--output-format');
  assert.equal(args[i + 1], 'stream-json');
  assert.ok(args.includes('--verbose'), 'stream-json refuses to run without --verbose');
});

test('claude read mode does not get an edit-capable permission mode', () => {
  const args = buildClaudeArgs({ ...base, mode: 'read' });
  const i = args.indexOf('--permission-mode');
  assert.equal(args[i + 1], 'plan');
  assert.equal(buildClaudeArgs({ ...base, mode: 'write' })[i + 1], 'acceptEdits');
});
