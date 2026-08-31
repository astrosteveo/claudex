import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { solve } from '../src/core/pipeline.ts';
import { ConsultService } from '../src/core/consult.ts';
import { loadConfig } from '../src/core/config.ts';
import { runClaude } from '../src/adapters/claude.ts';

/** A stand-in `claude` emitting the stream-json shape the adapter parses. */
function fakeClaude(dir: string, text: string, opts: { markerFile?: string } = {}): void {
  const script = [
    '#!/usr/bin/env node',
    opts.markerFile ? `require('node:fs').appendFileSync(${JSON.stringify(opts.markerFile)}, 'x\\n');` : '',
    'let input = "";',
    'process.stdin.on("data", d => input += d);',
    'process.stdin.on("end", () => {',
    '  const say = o => process.stdout.write(JSON.stringify(o) + "\\n");',
    '  say({ type: "system", subtype: "init", session_id: "sess-1" });',
    `  say({ type: "assistant", session_id: "sess-1", message: { content: [{ type: "text", text: ${JSON.stringify(text)} }] } });`,
    `  say({ type: "result", subtype: "success", session_id: "sess-1", is_error: false, result: ${JSON.stringify(text)} });`,
    '  process.exit(0);',
    '});',
  ].join('\n');
  writeFileSync(join(dir, 'claude'), script);
  chmodSync(join(dir, 'claude'), 0o755);
}

function fakeCodex(dir: string, text: string, markerFile: string): void {
  const script = [
    '#!/usr/bin/env node',
    `require('node:fs').appendFileSync(${JSON.stringify(markerFile)}, 'x\\n');`,
    'process.stdin.resume();',
    'process.stdin.on("end", () => {',
    '  const say = o => process.stdout.write(JSON.stringify(o) + "\\n");',
    '  say({ type: "thread.started", thread_id: "t1" });',
    `  say({ type: "item.completed", item: { type: "agent_message", text: ${JSON.stringify(text)} } });`,
    '  process.exit(0);',
    '});',
  ].join('\n');
  writeFileSync(join(dir, 'codex'), script);
  chmodSync(join(dir, 'codex'), 0o755);
}

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'claudex-pipeline-'));
  mkdirSync(join(root, '.claudex'), { recursive: true });
  writeFileSync(join(root, '.claudex', 'config.json'), JSON.stringify({ budget: { timeoutMs: 10_000 } }));
  return root;
}

test('the claude adapter reads a real stream-json exchange', async () => {
  // buildClaudeArgs was covered; nothing had ever parsed actual output.
  const root = project();
  fakeClaude(root, 'the answer');
  const prev = process.env['PATH'];
  process.env['PATH'] = `${root}:${prev ?? ''}`;
  try {
    const res = await runClaude({ prompt: 'q', cwd: root, mode: 'read', kind: 'ask', timeoutMs: 10_000 });
    assert.equal(res.ok, true);
    assert.equal(res.content, 'the answer');
    assert.equal(res.threadId, 'sess-1', 'session id must be captured for --resume');
    assert.equal(res.partial, null);
  } finally {
    process.env['PATH'] = prev;
  }
});

test('solve without --apply stops at the plan instead of looping to no purpose', async () => {
  // Read-only Codex cannot make the change the reviewer looks for, so every
  // round reviews an unchanged tree and returns changes-requested — spending a
  // Codex consult, a Claude session and a full verify run each time until the
  // budget is gone. Observed doing exactly that before this guard existed.
  const root = project();
  const codexRuns = join(root, 'codex-runs');
  fakeClaude(root, 'PLAN: change the thing');
  fakeCodex(root, 'implemented', codexRuns);
  const prev = process.env['PATH'];
  process.env['PATH'] = `${root}:${prev ?? ''}`;
  try {
    const config = loadConfig(root);
    const res = await solve(config, new ConsultService(config), { task: 't', rounds: 3, apply: false });
    assert.equal(res.planOnly, true);
    assert.equal(res.rounds, 0);
    assert.match(res.plan ?? '', /PLAN/);
    assert.ok(!existsSync(codexRuns), 'the peer must not be invoked at all in plan-only mode');
  } finally {
    process.env['PATH'] = prev;
  }
});

test('solve with --apply runs the loop and writes a transcript of every phase', async () => {
  const root = project();
  const codexRuns = join(root, 'codex-runs');
  // The reviewer approves, so the loop should stop after exactly one round.
  fakeClaude(root, 'VERDICT: approve');
  fakeCodex(root, 'implemented', codexRuns);
  const prev = process.env['PATH'];
  process.env['PATH'] = `${root}:${prev ?? ''}`;
  try {
    const config = loadConfig(root);
    const res = await solve(config, new ConsultService(config), { task: 't', rounds: 3, apply: true });
    assert.equal(res.ok, true);
    assert.equal(res.verdict, 'approve');
    assert.equal(res.rounds, 1, 'an approval must end the loop, not spend the budget');
    assert.equal(readFileSync(codexRuns, 'utf8').trim().split('\n').length, 1, 'one implement call');
  } finally {
    process.env['PATH'] = prev;
  }
});
