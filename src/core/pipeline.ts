import { runClaude } from '../adapters/claude.ts';
import { ConsultService } from './consult.ts';
import { Transcript } from './transcript.ts';
import { formatEvidence, runVerify } from './verify.ts';
import { parseVerdict, reviewPrompt } from './prompts.ts';
import type { ClaudexConfig } from './types.ts';

export interface SolveOptions {
  task: string;
  rounds: number;
  apply: boolean;
  onEvent?: (phase: string, detail: string) => void;
}

export interface SolveResult {
  ok: boolean;
  /** Set when --apply was omitted: the plan is the whole deliverable. */
  planOnly?: boolean;
  plan?: string;
  rounds: number;
  verdict: 'approve' | 'changes-requested' | 'unknown';
  transcriptPath: string;
  summary: string;
}

const PLAN_PROMPT = (task: string): string =>
  [
    'Write an implementation plan for the following task in this repository.',
    'Another agent will implement it exactly as written, so be specific about files, functions, and behaviour.',
    'Do not write the code. Do not modify any files. Output the plan only.',
    'If the task is ambiguous in a way that changes the design, state the assumption you are making.',
    '',
    'Task:',
    task,
  ].join('\n');

/**
 * plan -> implement -> verify -> review -> fix.
 *
 * Claude leads (plans and reviews); Codex implements. The split is the point:
 * the agent reviewing the code is not the agent that wrote it, so it has no
 * sunk cost in the approach it is checking.
 */
export async function solve(config: ClaudexConfig, service: ConsultService, opts: SolveOptions): Promise<SolveResult> {
  const transcript = new Transcript(config.projectRoot, 'solve');
  const emit = opts.onEvent ?? ((): void => {});

  emit('plan', 'Claude is planning');
  const plan = await runClaude({
    prompt: PLAN_PROMPT(opts.task),
    cwd: config.projectRoot,
    mode: 'read',
    kind: 'solve',
    timeoutMs: config.budget.timeoutMs,
    model: null,
  });
  transcript.write('plan', plan.content);
  if (!plan.ok) {
    return {
      ok: false,
      rounds: 0,
      verdict: 'unknown',
      transcriptPath: transcript.path,
      summary: `Planning failed: ${plan.content || plan.stderr}`,
    };
  }

  // Without --apply the peer runs read-only, so it cannot make the change the
  // reviewer is then asked to look for. The loop cannot converge: every round
  // reviews an unchanged tree, returns changes-requested, and spends another
  // Codex consult plus another Claude session plus another full verify run
  // until the budget is gone. Observed doing exactly that. Stop at the plan,
  // which is the only useful output this mode can produce.
  if (!opts.apply) {
    return {
      ok: true,
      planOnly: true,
      plan: plan.content,
      rounds: 0,
      verdict: 'unknown',
      transcriptPath: transcript.path,
      summary: 'Plan only — re-run with --apply to let Codex implement it and have Claude review the result.',
    };
  }

  let instruction = plan.content;
  let verdict: 'approve' | 'changes-requested' | 'unknown' = 'unknown';
  let round = 0;
  let reviewSessionId: string | null = null;

  while (round < opts.rounds) {
    round += 1;

    emit('implement', `Codex implementing (round ${round}/${opts.rounds})`);
    const impl = await service.implement(instruction, { mode: opts.apply ? 'write' : 'read' });
    transcript.write(`round${round}-implement`, impl.content);
    if (impl.denied) {
      return {
        ok: false,
        rounds: round,
        verdict: 'unknown',
        transcriptPath: transcript.path,
        summary: `Stopped: ${impl.denied.message}`,
      };
    }

    // Verification runs here, on the host, and its result is handed to the
    // reviewer. A sandboxed peer's own account of a test run is not evidence.
    emit('verify', config.verifyCommand ? `running ${config.verifyCommand}` : 'no verify command configured');
    const verify = await runVerify(config.verifyCommand, config.projectRoot);
    if (verify.ran) transcript.write(`round${round}-verify`, `${verify.passed ? 'PASS' : 'FAIL'}\n\n${verify.output}`);

    emit('review', `Claude reviewing (round ${round}/${opts.rounds})`);
    const review = await runClaude({
      prompt: reviewPrompt(
        `the change just made for this task: ${opts.task}`,
        'read',
        formatEvidence(verify),
      ) + '\n\nEnd your reply with a line reading exactly `VERDICT: approve` or `VERDICT: changes-requested`.',
      cwd: config.projectRoot,
      mode: 'read',
      kind: 'solve',
      timeoutMs: config.budget.timeoutMs,
      model: null,
      sessionId: reviewSessionId,
    });
    reviewSessionId = review.threadId;
    transcript.write(`round${round}-review`, review.content);

    verdict = parseVerdict(review.content).verdict;
    emit('verdict', verdict);

    if (verdict === 'approve' && (!verify.ran || verify.passed)) {
      return {
        ok: true,
        rounds: round,
        verdict,
        transcriptPath: transcript.path,
        summary: `Approved after ${round} round${round === 1 ? '' : 's'}.`,
      };
    }

    instruction = [
      'Your previous change was reviewed and is not accepted yet. Address the following, and nothing else.',
      '',
      review.content,
      verify.ran && !verify.passed ? `\nThe test suite is failing on the host:\n${verify.output}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  return {
    ok: false,
    rounds: round,
    verdict,
    transcriptPath: transcript.path,
    summary: `Ran out of rounds after ${round} with verdict "${verdict}". See the transcript.`,
  };
}
