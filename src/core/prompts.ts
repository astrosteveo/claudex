import type { Mode, ReviewVerdict } from './types.ts';

/**
 * All agent-facing wording lives here. Prompt changes belong in this file, not
 * inline at call sites — the exact framing is load-bearing and gets tuned.
 */

/**
 * Appended to every peer answer handed back to Claude.
 *
 * This footer is the whole point of the tool. An agent that defers to its peer
 * has bought nothing: the value is that the reviewer has no sunk cost in the
 * approach it is checking, and that only pays off if the caller weighs the
 * answer instead of adopting it.
 */
export const PEER_FOOTER = `
---
This is Codex's independent opinion, formed without your reasoning. Treat it as an
argument to evaluate, not a verdict to comply with. It may be wrong: it has less
context than you do about what the user asked for. Where you disagree, say so and
explain why rather than silently switching approach.`;

const READ_ONLY_NOTE = `You are running read-only: inspect the repository freely, but do not modify files.`;
const WRITE_NOTE = `You may edit files in the workspace. Make the smallest change that does the job, and report exactly what you changed.`;

export function modeNote(mode: Mode): string {
  return mode === 'read' ? READ_ONLY_NOTE : WRITE_NOTE;
}

export function askPrompt(question: string, mode: Mode, context?: string | null): string {
  return [
    `You are being consulted by another AI coding agent (Claude Code) working in this repository.`,
    `It wants an independent second opinion, specifically because you did not write the code in question and have no stake in the approach.`,
    modeNote(mode),
    ``,
    `Read the relevant code yourself — do not assume what you were told is complete or accurate.`,
    `Be direct and concrete. Cite file:line. If you think the premise of the question is wrong, say that first.`,
    `If you genuinely do not know, say so rather than guessing plausibly.`,
    context ? `\nContext from the caller:\n${context}` : ``,
    ``,
    `Question:`,
    question,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

/**
 * Passed to `codex exec --output-schema`, which feeds OpenAI structured outputs
 * in strict mode. Strict mode requires EVERY key in `properties` to appear in
 * `required` — an optional field has to be expressed as a nullable type instead,
 * or the request fails with a 400 before the model ever runs.
 */
export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: {
      type: 'string',
      enum: ['approve', 'changes-requested'],
      description: 'approve only if you would merge this as-is',
    },
    summary: { type: 'string', description: 'One or two sentences on the overall state of the change.' },
    findings: {
      type: 'array',
      description: 'Concrete defects, most severe first. Empty if there are none.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'nit'] },
          file: { type: 'string' },
          line: { type: ['integer', 'null'], description: 'Line number, or null if it is not line-specific.' },
          issue: { type: 'string', description: 'What is wrong.' },
          why: { type: 'string', description: 'Concrete inputs or state that make it go wrong.' },
        },
        required: ['severity', 'file', 'line', 'issue', 'why'],
      },
    },
  },
  required: ['verdict', 'summary', 'findings'],
} as const;

export function reviewPrompt(target: string, mode: Mode, evidence?: string | null): string {
  return [
    `You are reviewing code written by a different AI coding agent (Claude Code). It is asking you specifically because you have no sunk cost in its approach.`,
    modeNote(mode),
    ``,
    `Review target: ${target}`,
    ``,
    `Read the actual code in this repository before judging it. Look for defects that would bite in production:`,
    `correctness under edge cases and concurrency, error paths that swallow failures, resource leaks,`,
    `security issues, and behaviour that contradicts what the surrounding code promises.`,
    ``,
    `Report only defects you can point at, each with concrete inputs or state that trigger it.`,
    `Do not pad the list with style preferences. An empty findings list is a valid and useful answer.`,
    `Approve only if you would merge this as-is.`,
    evidence ? `\nTest evidence, run on the host by the caller (trust this over your own run):\n${evidence}` : ``,
  ]
    .filter(Boolean)
    .join('\n');
}

export function debatePrompt(question: string, mode: Mode): string {
  return [
    `Answer the following independently. Another agent is answering the same question separately;`,
    `you will see its answer afterwards and get a chance to critique it. Do not hedge toward a consensus you cannot see yet.`,
    modeNote(mode),
    ``,
    question,
  ].join('\n');
}

export function critiquePrompt(question: string, otherAnswer: string): string {
  return [
    `You answered this question:`,
    question,
    ``,
    `Another agent answered it differently. Its answer:`,
    `---`,
    otherAnswer,
    `---`,
    ``,
    `Where is it wrong, and where is it right and you were wrong? Be specific and concede what deserves conceding.`,
    `Do not restate your original answer. If you now think it was wrong, say that plainly.`,
  ].join('\n');
}

export function implementPrompt(plan: string, mode: Mode): string {
  return [
    `Implement the following plan in this repository.`,
    modeNote(mode),
    `Make the change, then report exactly which files you touched and what you did.`,
    `If the plan is wrong or cannot be implemented as written, stop and say why rather than improvising something different.`,
    ``,
    `Plan:`,
    plan,
  ].join('\n');
}

/**
 * Reads a verdict out of a peer reply.
 *
 * `--output-schema` normally makes this trivial, but the schema is honoured by
 * the model, not enforced by the CLI, so the prose path has to work too. An
 * unparseable verdict is `unknown` — never `approve`. Failing open here would
 * end a review loop early on broken code, which is the exact failure the review
 * exists to prevent.
 */
export function parseVerdict(raw: string): ReviewVerdict {
  const trimmed = raw.trim();

  const jsonText = extractJson(trimmed);
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText) as {
        verdict?: unknown;
        findings?: unknown;
        summary?: unknown;
      };
      if (parsed.verdict === 'approve' || parsed.verdict === 'changes-requested') {
        const findings = Array.isArray(parsed.findings)
          ? parsed.findings.map((f) => (typeof f === 'string' ? f : formatFinding(f)))
          : [];
        return { verdict: parsed.verdict, findings };
      }
    } catch {
      // fall through to prose
    }
  }

  const lowered = trimmed.toLowerCase();
  const requested = /\bchanges[-\s]requested\b/.test(lowered);
  const approved = /\bapprove(d)?\b/.test(lowered);
  // "changes-requested" contains no "approve", but a reply can mention both.
  // When both appear, the safe reading is the one that keeps the loop going.
  if (requested) return { verdict: 'changes-requested', findings: [] };
  if (approved) return { verdict: 'approve', findings: [] };
  return { verdict: 'unknown', findings: [] };
}

function formatFinding(f: unknown): string {
  if (f === null || typeof f !== 'object') return String(f);
  const o = f as Record<string, unknown>;
  const loc = [o['file'], o['line']].filter(Boolean).join(':');
  const sev = o['severity'] ? `[${String(o['severity'])}] ` : '';
  return `${sev}${loc ? loc + ' — ' : ''}${String(o['issue'] ?? '')}${o['why'] ? ` (${String(o['why'])})` : ''}`;
}

/** Pulls a JSON object out of a reply that may be fenced or prefaced. */
function extractJson(text: string): string | null {
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  if (fence?.[1]) return fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return null;
}
