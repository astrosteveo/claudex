import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import { loadConfig } from '../core/config.ts';
import { runDoctor, worstStatus } from '../core/doctor.ts';
import { renderSkill } from './skill.ts';
import { PACKAGE_NAME, VERSION } from '../core/version.ts';
import { SYMBOL, bold, dim, print } from './output.ts';

const execFileAsync = promisify(execFile);

/** Absolute path to the bundled MCP entrypoint, resolved from this file so the
 *  registration keeps working from a global install, npx, or a local checkout. */
function mcpEntrypoint(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, 'mcp-server.js');
}

/**
 * How to spawn the MCP server, recorded in the host's config for good.
 *
 * The trap is that *every* absolute path available here is version- or
 * cache-scoped. `process.execPath` is `…/nvm/versions/node/v26.7.0/bin/node`,
 * and so is the resolved `claudex-mcp` shim beside it — reinstalling globals on
 * a new Node and removing the old one breaks both identically. An `npx` run
 * resolves the shim inside `~/.npm/_npx/<hash>/`, which npm prunes on its own
 * schedule. Recording any of those produces a server that stops connecting
 * later, with nothing in the failure naming Node or npm as the cause.
 *
 * So: prefer the bare command name and let PATH resolve it at spawn time, which
 * is the only form that survives a Node upgrade that carries globals across.
 * An npx cache path cannot be made durable that way — nothing puts it on PATH
 * afterwards — so that case records the npx invocation itself, matching what
 * the plugin does. A dev checkout has no shim at all and falls back to the
 * explicit pair, which is correct there: it should track the working tree.
 */
function serverCommand(): { command: string; args: string[]; via: string } {
  const shim = whichShim();

  if (shim === null) {
    const entry = mcpEntrypoint();
    return { command: process.execPath, args: [entry], via: `this checkout (${entry})` };
  }

  if (isNpxCache(shim)) {
    const spec = `${PACKAGE_NAME}@${VERSION}`;
    return {
      command: 'npx',
      args: ['-y', '-p', spec, 'claudex-mcp'],
      via: `npx ${spec} (an npx cache path would be pruned)`,
    };
  }

  return { command: BIN_NAME, args: [], via: `${BIN_NAME} resolved from PATH at launch` };
}

const BIN_NAME = 'claudex-mcp';

function isNpxCache(path: string): boolean {
  return path.split(sep).includes('_npx');
}

/**
 * Locates the `claudex-mcp` shim, but only accepts one that resolves to *this*
 * build's MCP entrypoint. Comparing directories is not enough: `claudex-mcp`
 * and `claudex` live in the same directory and resolve into the same `dist/`,
 * so a directory match would happily accept a shim pointing at `cli.js` and
 * register the ordinary CLI as an MCP server — which then never speaks the
 * protocol and simply fails to connect.
 */
function whichShim(): string | null {
  const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', [BIN_NAME], {
    encoding: 'utf8',
  });
  if (found.status !== 0) return null;
  const path = found.stdout.split('\n')[0]?.trim();
  if (!path) return null;
  try {
    return realpathSync(path) === realpathSync(mcpEntrypoint()) ? path : null;
  } catch {
    return null;
  }
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

  const server = serverCommand();
  const args = ['mcp', 'add', '--scope', opts.scope, 'claudex', '--', server.command, ...server.args];

  try {
    // `claude mcp add` errors when the name already exists; removing first makes
    // install idempotent, which matters because people re-run it after upgrades.
    await execFileAsync('claude', ['mcp', 'remove', '--scope', opts.scope, 'claudex'], { timeout: 30_000 }).catch(
      () => undefined,
    );
    const { stdout, stderr } = await execFileAsync('claude', args, { timeout: 60_000 });
    print(`  ${SYMBOL.ok} registered MCP server "claudex" at ${opts.scope} scope`);
    print(dim(`    via ${server.via}`));
    const detail = (stdout + stderr).trim();
    if (detail) print(dim(`    ${detail.split('\n')[0]}`));
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    print(`  ${SYMBOL.fail} could not register with Claude Code: ${(e.stderr ?? e.message ?? '').trim()}`);
    print();
    print('Register it by hand with:');
    print(dim(`  claude mcp add --scope ${opts.scope} claudex -- ${server.command} ${server.args.join(' ')}`));
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
