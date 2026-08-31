import { loadConfig } from './core/config.ts';
import { ConsultService } from './core/consult.ts';
import { solve } from './core/pipeline.ts';
import { debate } from './core/debate.ts';
import { doctorCommand } from './cli/doctor.ts';
import { installCommand, uninstallCommand } from './cli/install.ts';
import { policyCommand } from './cli/policy.ts';
import { logCommand, statusCommand } from './cli/status.ts';
import { bold, cyan, dim, fail, print } from './cli/output.ts';
import { VERSION } from './core/version.ts';
import type { Mode } from './core/types.ts';


const HELP = `${bold('claudex')} — a governed second opinion from Codex, inside Claude Code

${bold('Usage')}
  claudex <command> [options]

${bold('Setup')}
  doctor                     Check both CLIs are installed, authenticated and behaving as assumed
  install [--scope <s>]      Register the MCP server with Claude Code (scope: user|project|local)
                             --no-skill  skip writing the consultation guidance skill
                             --force     install despite failing checks
                             --pinned    record a version-pinned npx invocation
                                         instead of resolving from PATH at launch
  uninstall [--scope <s>]    Remove the MCP server registration

${bold('Governing spend')}
  policy                     Show the active policy and budget
  policy set <policy>        off | on-request | assisted | aggressive
  policy mode <mode>         read | write | full  (default sandbox for consults)
  policy verify "<cmd>"      Command run on the host to give reviewers real test evidence
  policy budget [flags]      --max-per-session --max-tokens --cooldown-ms --timeout-ms
                             Add --global to write user-level config instead of project-level.
  status                     What Codex has cost this project
  log [-n <count>]           Raw consult records as JSONL

${bold('Running a consult from the shell')}
  ask "<question>"           One-shot question to Codex
  review [target]            Adversarial review, defaulting to uncommitted changes
  solve "<task>" [--apply]   Claude plans and reviews, Codex implements, host verifies, loop
                             --rounds <n>  review rounds (default 3)
  debate "<question>"        Both agents answer independently, then critique
                             --rounds <n>  critique rounds (default 1)

${dim('Everything above is also available to Claude Code itself as MCP tools once installed.')}
`;

function flag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function value(argv: string[], name: string, fallback: string | null = null): string | null {
  const i = argv.indexOf(name);
  if (i < 0 || i + 1 >= argv.length) return fallback;
  return argv[i + 1] ?? fallback;
}

function positional(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith('--')) {
      // Skip the value of flags that take one.
      if (['--scope', '--rounds', '--mode', '-n'].includes(a)) i += 1;
      continue;
    }
    out.push(a);
  }
  return out;
}

function parseScope(argv: string[]): 'user' | 'project' | 'local' {
  const s = value(argv, '--scope', 'user');
  if (s === 'user' || s === 'project' || s === 'local') return s;
  fail('--scope must be one of: user, project, local');
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    print(HELP);
    return 0;
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    print(VERSION);
    return 0;
  }

  const rest = argv.slice(1);

  switch (command) {
    case 'doctor':
      return doctorCommand();

    case 'install':
      return installCommand({
        scope: parseScope(rest),
        skill: !flag(rest, '--no-skill'),
        force: flag(rest, '--force'),
        pinned: flag(rest, '--pinned'),
      });

    case 'uninstall':
      return uninstallCommand(parseScope(rest));

    case 'policy':
      return policyCommand(rest);

    case 'status':
      return statusCommand();

    case 'log':
      return logCommand(Number(value(rest, '-n', '50')) || 50);

    case 'ask': {
      const question = positional(rest).join(' ');
      if (!question) fail('usage: claudex ask "<question>"');
      const config = loadConfig();
      const service = new ConsultService(config);
      const mode = value(rest, '--mode') as Mode | null;
      process.stderr.write(dim('asking codex…\n'));
      const res = await service.ask(question, null, mode ? { mode } : {});
      print(res.content);
      return res.ok ? 0 : 1;
    }

    case 'review': {
      const target = positional(rest).join(' ') || null;
      const config = loadConfig();
      const service = new ConsultService(config);
      process.stderr.write(dim('codex reviewing…\n'));
      const res = await service.review(target);
      if (res.verdict.verdict !== 'unknown') print(bold(`Verdict: ${res.verdict.verdict}`));
      print(res.content);
      return res.verdict.verdict === 'approve' ? 0 : 1;
    }

    case 'solve': {
      const task = positional(rest).join(' ');
      if (!task) fail('usage: claudex solve "<task>" [--apply] [--rounds <n>]');
      const config = loadConfig();
      const service = new ConsultService(config);
      const rounds = Number(value(rest, '--rounds', '3')) || 3;
      const res = await solve(config, service, {
        task,
        rounds,
        apply: flag(rest, '--apply'),
        onEvent: (phase, detail) => process.stderr.write(`${cyan(phase.padEnd(10))} ${detail}\n`),
      });
      print();
      if (res.planOnly) {
        print(bold('Plan'));
        print(res.plan ?? '');
        print();
        print(res.summary);
        print(dim(`transcript: ${res.transcriptPath}`));
        return 0;
      }
      print(res.ok ? bold('Approved.') : bold('Not approved.'));
      print(res.summary);
      print(dim(`transcript: ${res.transcriptPath}`));
      return res.ok ? 0 : 1;
    }

    case 'debate': {
      const question = positional(rest).join(' ');
      if (!question) fail('usage: claudex debate "<question>" [--rounds <n>]');
      const config = loadConfig();
      const service = new ConsultService(config);
      const rounds = Number(value(rest, '--rounds', '1')) || 1;
      const res = await debate(config, service, {
        question,
        rounds,
        onEvent: (phase, detail) => process.stderr.write(`${cyan(phase.padEnd(10))} ${detail}\n`),
      });
      print();
      print(bold('Claude:'));
      print(res.claudeAnswer);
      print();
      print(bold('Codex:'));
      print(res.codexAnswer);
      for (const c of res.critiques) {
        print();
        print(bold(`${c.by} critique:`));
        print(c.text);
      }
      print();
      print(dim(`transcript: ${res.transcriptPath}`));
      return res.ok ? 0 : 1;
    }

    default:
      fail(`unknown command: ${command}\nRun \`claudex help\`.`);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    fail((err as Error).message ?? String(err));
  });
