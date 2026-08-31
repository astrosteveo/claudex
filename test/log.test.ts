import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsultLog } from '../src/core/log.ts';
import { newUsage } from '../src/core/budget.ts';

const record = {
  ts: Date.now(),
  sessionId: 's',
  kind: 'ask' as const,
  mode: 'read' as const,
  ok: true,
  denied: null,
  partial: null,
  durationMs: 10,
  threadId: 't',
  promptChars: 5,
  answerChars: 5,
};

test('a round trip preserves records', () => {
  const root = mkdtempSync(join(tmpdir(), 'claudex-log-'));
  const log = new ConsultLog(root);
  log.append(record);
  log.append({ ...record, kind: 'review' });
  const read = log.read();
  assert.equal(read.length, 2);
  assert.equal(read[1]?.kind, 'review');
});

test('a corrupt line does not hide the rest of the history', () => {
  const root = mkdtempSync(join(tmpdir(), 'claudex-log-'));
  mkdirSync(join(root, '.claudex'), { recursive: true });
  writeFileSync(join(root, '.claudex', 'consults.jsonl'), `{"broken\n${JSON.stringify(record)}\n`);
  assert.equal(new ConsultLog(root).read().length, 1);
});

test('reading a project that has never consulted returns empty, not an error', () => {
  const root = mkdtempSync(join(tmpdir(), 'claudex-log-'));
  assert.deepEqual(new ConsultLog(root).read(), []);
});

test('an unwritable log directory never throws', () => {
  // Logging is best-effort by contract: a broken log must never turn a finished
  // peer answer into an error.
  const root = mkdtempSync(join(tmpdir(), 'claudex-log-'));
  chmodSync(root, 0o500);
  try {
    const log = new ConsultLog(root);
    assert.doesNotThrow(() => log.append(record));
    assert.doesNotThrow(() => log.writeUsage(newUsage('s')));
    assert.doesNotThrow(() => log.read());
  } finally {
    chmodSync(root, 0o700);
  }
});
