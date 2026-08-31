import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, PEER_FOOTER, askPrompt } from '../src/core/prompts.ts';

test('an unparseable verdict is unknown, never approve', () => {
  assert.equal(parseVerdict('').verdict, 'unknown');
  assert.equal(parseVerdict('the code looks fine to me I guess').verdict, 'unknown');
  assert.equal(parseVerdict('{"broken json').verdict, 'unknown');
});

test('a reply mentioning both outcomes resolves to changes-requested', () => {
  // Failing open here would end a review loop early on broken code.
  const raw = 'I would normally approve this, but changes-requested: the lock is not released.';
  assert.equal(parseVerdict(raw).verdict, 'changes-requested');
});

test('structured output is read out of a fenced block', () => {
  const raw = ['Here is my review.', '```json', '{"verdict":"approve","summary":"fine","findings":[]}', '```'].join('\n');
  const v = parseVerdict(raw);
  assert.equal(v.verdict, 'approve');
  assert.deepEqual(v.findings, []);
});

test('object findings are flattened to readable lines', () => {
  const raw = JSON.stringify({
    verdict: 'changes-requested',
    summary: 'no',
    findings: [{ severity: 'critical', file: 'a.ts', line: 41, issue: 'lost update', why: 'two writers race' }],
  });
  const v = parseVerdict(raw);
  assert.equal(v.verdict, 'changes-requested');
  assert.match(v.findings[0]!, /critical/);
  assert.match(v.findings[0]!, /a\.ts:41/);
  assert.match(v.findings[0]!, /lost update/);
});

test('a bare approve is honoured', () => {
  assert.equal(parseVerdict('VERDICT: approve').verdict, 'approve');
});

test('the peer footer tells the caller not to defer', () => {
  // An agent that adopts its peer's answer wholesale has bought nothing.
  assert.match(PEER_FOOTER, /evaluate, not a verdict/);
  assert.match(PEER_FOOTER, /may be wrong/);
});

test('read mode tells the peer not to modify anything', () => {
  assert.match(askPrompt('q', 'read'), /do not modify files/i);
  assert.doesNotMatch(askPrompt('q', 'write'), /do not modify files/i);
});
