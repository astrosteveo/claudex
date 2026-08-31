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

test('the review schema satisfies OpenAI strict structured outputs', async () => {
  // Strict mode requires every key in `properties` to be listed in `required`;
  // an optional field must be a nullable type instead. Getting this wrong fails
  // with a 400 before the model runs at all.
  const { REVIEW_SCHEMA } = await import('../src/core/prompts.ts');
  const walk = (node: Record<string, unknown>, path: string): void => {
    if (node['type'] === 'object' && node['properties']) {
      const props = Object.keys(node['properties'] as Record<string, unknown>);
      const required = (node['required'] as string[] | undefined) ?? [];
      assert.deepEqual(
        props.filter((k) => !required.includes(k)),
        [],
        `${path}: every property must be required`,
      );
      assert.equal(node['additionalProperties'], false, `${path}: additionalProperties must be false`);
      for (const [k, v] of Object.entries(node['properties'] as Record<string, unknown>)) {
        walk(v as Record<string, unknown>, `${path}.${k}`);
      }
    }
    if (node['type'] === 'array' && node['items']) walk(node['items'] as Record<string, unknown>, `${path}[]`);
  };
  walk(REVIEW_SCHEMA as unknown as Record<string, unknown>, 'REVIEW_SCHEMA');
});

test('a nullable line number still renders in a finding', () => {
  const raw = JSON.stringify({
    verdict: 'changes-requested',
    summary: 'no',
    findings: [{ severity: 'major', file: 'a.ts', line: null, issue: 'leak', why: 'never closed' }],
  });
  assert.match(parseVerdict(raw).findings[0]!, /a\.ts — leak/);
});
