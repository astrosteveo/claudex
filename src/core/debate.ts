import { runClaude } from '../adapters/claude.ts';
import { ConsultService } from './consult.ts';
import { Transcript } from './transcript.ts';
import { critiquePrompt, debatePrompt } from './prompts.ts';
import type { ClaudexConfig } from './types.ts';

export interface DebateOptions {
  question: string;
  rounds: number;
  onEvent?: (phase: string, detail: string) => void;
}

export interface DebateResult {
  ok: boolean;
  transcriptPath: string;
  claudeAnswer: string;
  codexAnswer: string;
  critiques: { by: 'claude' | 'codex'; text: string }[];
}

/**
 * Both agents answer independently, then critique each other.
 *
 * The independence of the first round is the whole design: each answer is
 * written without sight of the other, so agreement afterwards is evidence
 * rather than an artifact of one having anchored the other.
 */
export async function debate(
  config: ClaudexConfig,
  service: ConsultService,
  opts: DebateOptions,
): Promise<DebateResult> {
  const transcript = new Transcript(config.projectRoot, 'debate');
  const emit = opts.onEvent ?? ((): void => {});

  emit('open', 'both agents answering independently');
  const [claudeOpen, codexOpen] = await Promise.all([
    runClaude({
      prompt: debatePrompt(opts.question, 'read'),
      cwd: config.projectRoot,
      mode: 'read',
      kind: 'debate',
      timeoutMs: config.budget.timeoutMs,
      model: null,
    }),
    service.debateOpen(opts.question),
  ]);

  transcript.write('claude-answer', claudeOpen.content);
  transcript.write('codex-answer', codexOpen.content);

  if (codexOpen.denied) {
    return {
      ok: false,
      transcriptPath: transcript.path,
      claudeAnswer: claudeOpen.content,
      codexAnswer: codexOpen.denied.message,
      critiques: [],
    };
  }

  const critiques: { by: 'claude' | 'codex'; text: string }[] = [];
  let claudeSession = claudeOpen.threadId;
  let codexThread = codexOpen.threadId;
  let claudeText = claudeOpen.content;
  let codexText = codexOpen.content;

  for (let round = 1; round <= opts.rounds; round += 1) {
    emit('critique', `round ${round}/${opts.rounds}`);

    const [claudeCritique, codexCritique] = await Promise.all([
      runClaude({
        prompt: critiquePrompt(opts.question, codexText),
        cwd: config.projectRoot,
        mode: 'read',
        kind: 'debate',
        timeoutMs: config.budget.timeoutMs,
        model: null,
        sessionId: claudeSession,
      }),
      codexThread
        ? service.debateCritique(codexThread, opts.question, claudeText)
        : service.debateOpen(`${opts.question}\n\nAnother agent answered:\n${claudeText}\n\nCritique it.`),
    ]);

    claudeSession = claudeCritique.threadId;
    codexThread = codexCritique.threadId;
    claudeText = claudeCritique.content;
    codexText = codexCritique.content;

    transcript.write(`round${round}-claude-critique`, claudeText);
    transcript.write(`round${round}-codex-critique`, codexText);
    critiques.push({ by: 'claude', text: claudeText }, { by: 'codex', text: codexText });

    if (codexCritique.denied) break;
  }

  return {
    ok: true,
    transcriptPath: transcript.path,
    claudeAnswer: claudeOpen.content,
    codexAnswer: codexOpen.content,
    critiques,
  };
}
