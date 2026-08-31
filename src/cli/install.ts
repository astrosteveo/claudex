import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from '../core/config.ts';
import { runDoctor, worstStatus } from '../core/doctor.ts';
import { renderSkill } from './skill.ts';
import { SYMBOL, bold, dim, print } from './output.ts';

const execFileAsync = promisify(execFile);

/** Absolute path to the bundled MCP entrypoint, resolved from this file so the
 *  registration keeps working from a global install, npx, or a local checkout. */
function mcpEntrypoint(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, 'mcp-server.js');
}

export interface InstallOptions {
  scope: 'user' | 'project' | 'local';
  skill: boolean;
  force: boolean;
}

export async function installCommand(opts: InstallOptions): Promise<number> {
  print(bold('claudex install'));
  print();

  const checks = await runDoctor();
  const blocking = checks.filter((c) => c.status === 'fail');
  for (const c of checks) {
    if (c.status !== 'ok') print(`  ${SYMBOL[c.status]} ${c.name}: ${c.detail}`);
  }
  if (blocking.length > 0 && !opts.force) {
    print();
    print('Refusing to install with failing checks. Run `claudex doctor`, or pass --force.');
    return 1;
  }

  const entry = mcpEntrypoint();
  const args = ['mcp', 'add', '--scope', opts.scope, 'claudex', '--', process.execPath, entry];

  try {
    // `claude mcp add` errors when the name already exists; removing first makes
    // install idempotent, which matters because people re-run it after upgrades.
    await execFileAsync('claude', ['mcp', 'remove', '--scope', opts.scope, 'claudex'], { timeout: 30_000 }).catch(
      () => undefined,
    );
    const { stdout, stderr } = await execFileAsync('claude', args, { timeout: 60_000 });
    print(`  ${SYMBOL.ok} registered MCP server "claudex" at ${opts.scope} scope`);
    const detail = (stdout + stderr).trim();
    if (detail) print(dim(`    ${detail.split('\n')[0]}`));
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    print(`  ${SYMBOL.fail} could not register with Claude Code: ${(e.stderr ?? e.message ?? '').trim()}`);
    print();
    print('Register it by hand with:');
    print(dim(`  claude mcp add --scope ${opts.scope} claudex -- ${process.execPath} ${entry}`));
    return 1;
  }

  if (opts.skill) {
    const config = loadConfig();
    const skillDir = join(homedir(), '.claude', 'skills', 'claudex');
    try {
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), renderSkill(config), 'utf8');
      print(`  ${SYMBOL.ok} wrote consultation guidance to ${join(skillDir, 'SKILL.md')}`);
      print(dim(`    generated for policy "${config.policy}" — re-run after \`claudex policy set\``));
    } catch (err) {
      print(`  ${SYMBOL.warn} could not write the skill: ${(err as Error).message}`);
    }
  }

  print();
  print('Restart any running Claude Code session to pick up the new server.');
  print(dim(`Policy is "${loadConfig().policy}". Change it with \`claudex policy set <policy>\`.`));
  return worstStatus(checks) === 'fail' ? 1 : 0;
}

export async function uninstallCommand(scope: 'user' | 'project' | 'local'): Promise<number> {
  try {
    await execFileAsync('claude', ['mcp', 'remove', '--scope', scope, 'claudex'], { timeout: 30_000 });
    print(`removed MCP server "claudex" from ${scope} scope`);
    return 0;
  } catch (err) {
    print(`could not remove: ${(err as Error).message}`);
    return 1;
  }
}
