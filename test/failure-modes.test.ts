import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodex } from '../src/adapters/codex.ts';
import { ConsultService } from '../src/core/consult.ts';
import { loadConfig } from '../src/core/config.ts';

function project(config: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'claudex-fail-'));
  mkdirSync(join(root, '.claudex'), { recursive: true });
  writeFileSync(join(root, '.claudex', 'config.json'), JSON.stringify(config));
  return root;
}

test('an already-aborted signal stops the peer from ever being spawned', async () => {
  // addEventListener does not replay an abort that fired before registration.
  // A consult cancelled during target discovery or host verification would
  // otherwise run to completion, and in write mode keep editing files.
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  const res = await runCodex({
    prompt: 'this must never reach codex',
    cwd: tmpdir(),
    mode: 'read',
    kind: 'ask',
    timeoutMs: 60_000,
    signal: controller.signal,
  });
  assert.ok(Date.now() - started < 2000, 'a pre-aborted run must return immediately');
  assert.equal(res.ok, false);
  assert.equal(res.content, '');
  assert.match(res.stderr, /aborted/);
});

test('a peer that ignores SIGTERM is still killed', async () => {
  // Node sets child.killed when a signal is *sent*, not when the process dies.
  // Gating escalation on `killed` means SIGKILL never fires and the await on
  // close hangs for as long as the peer feels like living.
  const root = mkdtempSync(join(tmpdir(), 'claudex-sigterm-'));
  const fake = join(root, 'codex');
  writeFileSync(
    fake,
    ['#!/usr/bin/env node', "process.on('SIGTERM', () => {});", 'setInterval(() => {}, 1000);'].join('\n'),
  );
  chmodSync(fake, 0o755);
  const prevPath = process.env['PATH'];
  process.env['PATH'] = `${root}:${prevPath ?? ''}`;
  try {
    const started = Date.now();
    const res = await runCodex({
      prompt: 'x',
      cwd: root,
      mode: 'read',
      kind: 'ask',
      timeoutMs: 1000,
    });
    const elapsed = Date.now() - started;
    assert.equal(res.partial, 'timeout');
    // 1s timeout + 2s escalation, with headroom. Without SIGKILL this hangs.
    assert.ok(elapsed < 10_000, `expected the peer to be killed, took ${elapsed}ms`);
  } finally {
    process.env['PATH'] = prevPath;
  }
});

test('a run that emits text and then fails is never returned as a clean answer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claudex-partial-'));
  mkdirSync(join(root, '.claudex'), { recursive: true });
  writeFileSync(join(root, '.claudex', 'config.json'), '{}');
  const fake = join(root, 'codex');
  writeFileSync(
    fake,
    [
      '#!/usr/bin/env node',
      'process.stdin.resume();',
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'t1'}) + '\\n');",
      "  process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'looks fine to me'}}) + '\\n');",
      '  process.exit(3);',
      '});',
    ].join('\n'),
  );
  chmodSync(fake, 0o755);
  const prevPath = process.env['PATH'];
  process.env['PATH'] = `${root}:${prevPath ?? ''}`;
  try {
    const service = new ConsultService(loadConfig(root));
    const res = await service.ask('anything', null);
    assert.equal(res.ok, false);
    assert.match(res.content, /FAILED/, 'salvaged output must be marked as unfinished');
    assert.doesNotMatch(res.content, /evaluate, not a verdict/, 'a failure must not get the peer footer');
  } finally {
    process.env['PATH'] = prevPath;
  }
});

test('a timed-out review never yields a verdict, even if one is salvageable', async () => {
  // Under --output-schema the peer's intermediate progress messages are
  // schema-shaped too, so a run that times out mid-review can leave a stray
  // {"verdict":"approve"} in the salvaged text. Reading it would approve code
  // the reviewer never finished looking at.
  const root = mkdtempSync(join(tmpdir(), 'claudex-verdict-'));
  mkdirSync(join(root, '.claudex'), { recursive: true });
  writeFileSync(join(root, '.claudex', 'config.json'), JSON.stringify({ budget: { timeoutMs: 1000 } }));
  const fake = join(root, 'codex');
  writeFileSync(
    fake,
    [
      '#!/usr/bin/env node',
      'process.stdin.resume();',
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'t1'}) + '\\n');",
      '  const msg = JSON.stringify({verdict:"approve",summary:"partway through",findings:[]});',
      "  process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:msg}}) + '\\n');",
      '  setInterval(() => {}, 1000);',  // then hang until the kill timer fires
      '});',
    ].join('\n'),
  );
  chmodSync(fake, 0o755);
  const prevPath = process.env['PATH'];
  process.env['PATH'] = `${root}:${prevPath ?? ''}`;
  try {
    const service = new ConsultService(loadConfig(root));
    const res = await service.review('anything');
    assert.equal(res.partial, 'timeout');
    assert.equal(res.verdict.verdict, 'unknown', 'an incomplete review must never approve');
    assert.match(res.content, /INCOMPLETE/);
  } finally {
    process.env['PATH'] = prevPath;
  }
});

test('concurrent reviews cannot both run the host verify command on one budget slot', async () => {
  // The window is between check() and the reservation: with one slot free and
  // none used, two reviews starting together both pass a mere check, and both
  // launch the host verify command — a full test suite, possibly stateful —
  // before either is told the budget only ever allowed one.
  const root = mkdtempSync(join(tmpdir(), 'claudex-race-'));
  mkdirSync(join(root, '.claudex'), { recursive: true });
  const marker = join(root, 'verify-runs');
  writeFileSync(
    join(root, '.claudex', 'config.json'),
    JSON.stringify({ budget: { maxPerSession: 1, timeoutMs: 5000 }, verifyCommand: `echo x >> ${marker}` }),
  );

  const fake = join(root, 'codex');
  writeFileSync(
    fake,
    [
      '#!/usr/bin/env node',
      'process.stdin.resume();',
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'t1'}) + '\\n');",
      '  const msg = JSON.stringify({verdict:"approve",summary:"ok",findings:[]});',
      "  process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:msg}}) + '\\n');",
      '  process.exit(0);',
      '});',
    ].join('\n'),
  );
  chmodSync(fake, 0o755);

  const prevPath = process.env['PATH'];
  process.env['PATH'] = `${root}:${prevPath ?? ''}`;
  try {
    const service = new ConsultService(loadConfig(root));
    const [a, b] = await Promise.all([service.review(null), service.review(null)]);

    const denials = [a, b].filter((r) => r.denied).length;
    assert.equal(denials, 1, 'exactly one of two concurrent reviews must be denied');

    const runs = existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').length : 0;
    assert.equal(runs, 1, `verify must run once for one budget slot, ran ${runs} times`);
  } finally {
    process.env['PATH'] = prevPath;
  }
});
