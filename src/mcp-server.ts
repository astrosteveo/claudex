import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './core/config.ts';
import { ConsultService, type ConsultResponse } from './core/consult.ts';
import { VERSION } from './core/version.ts';
import type { Mode } from './core/types.ts';

const config = loadConfig(process.cwd());
const service = new ConsultService(config);

const modeSchema = z
  .enum(['read', 'write', 'full'])
  .optional()
  .describe(
    'Sandbox Codex runs under. "read" (default) lets it inspect the repo but not change it. ' +
      'Use "write" only when you are deliberately delegating an edit.',
  );

interface ToolExtra {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification: (n: unknown) => Promise<void>;
}

/** Progress notifications are only legal for callers that sent a progressToken —
 *  the spec forbids unsolicited ones, and some clients error on them. */
function progressReporter(extra: ToolExtra): ((note: string) => void) | undefined {
  const token = extra._meta?.progressToken;
  if (token === undefined) return undefined;
  let n = 0;
  return (note: string) => {
    void extra.sendNotification({
      method: 'notifications/progress',
      params: { progressToken: token, progress: ++n, message: note },
    }).catch(() => {
      /* a dropped progress note must never fail the call */
    });
  };
}

function render(res: ConsultResponse, extra?: string): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  const parts: string[] = [];
  if (extra) parts.push(extra);
  parts.push(res.content);

  if (res.denied) {
    // A denial is a normal, reasoned-about outcome, not a protocol error. The
    // model needs to read it and adapt, not retry it as a transient failure.
    return { content: [{ type: 'text', text: parts.join('\n\n') }] };
  }

  const budget =
    res.budgetRemaining === 'unlimited'
      ? ''
      : `\n\n[claudex: ${res.budgetRemaining} Codex consult${res.budgetRemaining === 1 ? '' : 's'} left this session]`;
  if (res.threadId) {
    parts.push(
      `[thread: ${res.threadId} — pass this to codex_reply to keep arguing without re-paying for the context]`,
    );
  }
  // Deliberately never isError: a failed or refused consult is information the
  // model should read and act on, not a tool fault it should retry.
  return { content: [{ type: 'text', text: parts.join('\n\n') + budget }] };
}

const server = new McpServer(
  { name: 'claudex', version: VERSION, title: 'Codex peer' },
  { capabilities: { tools: {} } },
);

server.registerTool(
  'ask_codex',
  {
    title: 'Ask Codex',
    description:
      'Get an independent second opinion from Codex on a question about this repository. ' +
      'Codex reads the code itself — do not paste large excerpts at it. ' +
      'Worth spending when: two designs have real tradeoffs the code does not settle, a debugging ' +
      'investigation has competing root causes, or a fix has already failed once. ' +
      'Not worth spending on routine edits, facts you can check yourself, or confirming what you already concluded.',
    inputSchema: {
      question: z.string().min(1).describe('One narrow question. Include the competing hypotheses or the concrete risk.'),
      context: z.string().optional().describe('What you have already tried or ruled out, so Codex does not repeat it.'),
      mode: modeSchema,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ question, context, mode }, extra) => {
    const res = await service.ask(question, context ?? null, {
      mode: mode as Mode | undefined,
      signal: extra.signal,
      onProgress: progressReporter(extra as unknown as ToolExtra),
    });
    return render(res);
  },
);

server.registerTool(
  'codex_review',
  {
    title: 'Codex review',
    description:
      'Have Codex adversarially review code — by default the uncommitted changes. ' +
      'Its value is that it did not write the code and has no stake in the approach. ' +
      'Use before finalizing substantial work touching security, concurrency, persistence, migrations, ' +
      'public APIs, or changes spanning many files.',
    inputSchema: {
      target: z
        .string()
        .optional()
        .describe('What to review, e.g. "src/auth/*.ts" or "the last 3 commits". Defaults to uncommitted changes.'),
      mode: modeSchema,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ target, mode }, extra) => {
    const res = await service.review(target ?? null, {
      mode: mode as Mode | undefined,
      signal: extra.signal,
      onProgress: progressReporter(extra as unknown as ToolExtra),
    });
    const header =
      res.ok && res.verdict.verdict !== 'unknown'
        ? `Verdict: ${res.verdict.verdict.toUpperCase()}`
        : res.ok
          ? 'Verdict: UNKNOWN (Codex did not state one clearly — treat as changes-requested)'
          : undefined;
    return render(res, header);
  },
);

server.registerTool(
  'codex_reply',
  {
    title: 'Reply to Codex',
    description:
      'Continue an existing Codex thread using the thread id from a previous answer. ' +
      'Pushing back is the intended use: if you think Codex is wrong, say why and make it defend the claim. ' +
      'Much cheaper than a fresh consult, since the thread keeps its context.',
    inputSchema: {
      thread_id: z.string().min(1).describe('Thread id from a previous claudex answer.'),
      message: z.string().min(1).describe('Your reply. Disagreement with reasoning beats a request to elaborate.'),
      mode: modeSchema,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ thread_id, message, mode }, extra) => {
    const res = await service.reply(thread_id, message, {
      mode: mode as Mode | undefined,
      signal: extra.signal,
      onProgress: progressReporter(extra as unknown as ToolExtra),
    });
    return render(res);
  },
);

server.registerTool(
  'codex_delegate',
  {
    title: 'Delegate to Codex',
    description:
      'Hand Codex a well-scoped implementation task to carry out in the working tree while you do something else. ' +
      'Codex runs in write mode and edits files. Review its work yourself before accepting it — ' +
      'you are still responsible for what lands.',
    inputSchema: {
      plan: z
        .string()
        .min(1)
        .describe('A specific, self-contained task. Vague plans come back as improvised changes you did not want.'),
      mode: z.enum(['write', 'full']).optional().describe('Defaults to "write" (workspace-writable sandbox).'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async ({ plan, mode }, extra) => {
    const res = await service.implement(plan, {
      mode: (mode ?? 'write') as Mode,
      signal: extra.signal,
      onProgress: progressReporter(extra as unknown as ToolExtra),
    });
    return render(res);
  },
);

server.registerTool(
  'codex_debate',
  {
    title: 'Debate with Codex',
    description:
      'Two-round disagreement on a hard question. Call it once with just the question to get Codex\'s ' +
      'independent answer — form your own answer first, without reading its reply. Then call again with ' +
      'thread_id and my_answer to have Codex critique yours. Use when a decision is genuinely contested.',
    inputSchema: {
      question: z.string().min(1).describe('The contested question.'),
      thread_id: z.string().optional().describe('Second round only: the thread id from the first call.'),
      my_answer: z.string().optional().describe('Second round only: your own answer, for Codex to attack.'),
      mode: modeSchema,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ question, thread_id, my_answer, mode }, extra) => {
    const opts = {
      mode: mode as Mode | undefined,
      signal: extra.signal,
      onProgress: progressReporter(extra as unknown as ToolExtra),
    };
    if (thread_id && my_answer) {
      const res = await service.debateCritique(thread_id, question, my_answer, opts);
      return render(res, 'Codex critiquing your answer:');
    }
    const res = await service.debateOpen(question, opts);
    return render(
      res,
      "Codex's independent answer. Compare it against the answer you formed yourself; " +
        'call codex_debate again with thread_id and my_answer to have it attack yours.',
    );
  },
);

server.registerTool(
  'codex_budget',
  {
    title: 'Codex budget',
    description:
      'Check how much Codex consultation is left this session. Free — it does not invoke Codex. ' +
      'Use it to decide whether a consult is worth spending here.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  () => {
    const u = service.usage;
    const b = config.budget;
    const fmt = (v: number): string => (v === -1 ? 'unlimited' : String(v));
    return {
      content: [
        {
          type: 'text' as const,
          text: [
            `policy: ${config.policy}`,
            `consults: ${u.consults} / ${fmt(b.maxPerSession)}`,
            `tokens: ${u.tokens} / ${fmt(b.maxTokens)}`,
            `peer wall clock: ${Math.round(u.wallClockMs / 1000)}s / ${b.maxWallClockMs === -1 ? 'unlimited' : `${Math.round(b.maxWallClockMs / 1000)}s`}`,
            `default mode: ${config.defaultMode}`,
            `project: ${config.projectRoot}`,
          ].join('\n'),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

/**
 * stdout to a pipe is asynchronous, so `process.exit()` drops anything still
 * past the pipe buffer (~128 KiB) — which is exactly where a long peer answer
 * sits. On stdin EOF we let the event loop drain naturally instead.
 */
process.stdin.on('end', () => {
  void server.close();
});
