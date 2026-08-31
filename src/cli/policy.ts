import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  POLICIES,
  POLICY_BUDGETS,
  isPolicy,
  isMode,
  loadConfig,
  projectConfigPath,
  userConfigPath,
  findProjectRoot,
} from '../core/config.ts';
import { bold, dim, fail, print } from './output.ts';

function readRaw(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeRaw(path: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function targetPath(global: boolean): string {
  return global ? userConfigPath() : projectConfigPath(findProjectRoot());
}

export function policyCommand(argv: string[]): number {
  const global = argv.includes('--global');
  const args = argv.filter((a) => a !== '--global');
  const sub = args[0];

  if (!sub || sub === 'show') {
    const c = loadConfig();
    print(bold('claudex policy'));
    print(`  policy         ${c.policy}`);
    print(`  default mode   ${c.defaultMode}`);
    print(`  max consults   ${c.budget.maxPerSession === -1 ? 'unlimited' : c.budget.maxPerSession}`);
    print(`  max tokens     ${c.budget.maxTokens === -1 ? 'unlimited' : c.budget.maxTokens}`);
    print(`  cooldown       ${c.budget.cooldownMs / 1000}s`);
    print(`  timeout        ${c.budget.timeoutMs / 1000}s`);
    print();
    print(dim(`  project config: ${projectConfigPath(c.projectRoot)}`));
    print(dim(`  user config:    ${userConfigPath()}`));
    return 0;
  }

  if (sub === 'set') {
    const value = args[1];
    if (!isPolicy(value)) fail(`policy must be one of: ${POLICIES.join(', ')}`);
    const path = targetPath(global);
    const data = readRaw(path);
    data['policy'] = value;
    writeRaw(path, data);
    const b = POLICY_BUDGETS[value];
    print(`policy set to ${bold(value)} in ${path}`);
    print(
      dim(
        `  ${b.maxPerSession === 0 ? 'consultation disabled' : `${b.maxPerSession === -1 ? 'unlimited' : b.maxPerSession} consults/session`}` +
          `${b.cooldownMs ? `, ${b.cooldownMs / 1000}s cooldown` : ''}`,
      ),
    );
    print(dim('  Restart any running Claude Code session to pick this up.'));
    return 0;
  }

  if (sub === 'budget') {
    const path = targetPath(global);
    const data = readRaw(path);
    const budget = (data['budget'] as Record<string, unknown> | undefined) ?? {};
    let touched = false;
    const numeric: Record<string, string> = {
      '--max-per-session': 'maxPerSession',
      '--max-tokens': 'maxTokens',
      '--cooldown-ms': 'cooldownMs',
      '--timeout-ms': 'timeoutMs',
      '--max-wall-clock-ms': 'maxWallClockMs',
    };
    for (let i = 1; i < args.length; i += 1) {
      const flag = args[i];
      const key = flag ? numeric[flag] : undefined;
      if (!key) continue;
      const raw = args[i + 1];
      const n = Number(raw);
      if (!Number.isFinite(n)) fail(`${flag} needs a number (use -1 for unlimited)`);
      budget[key] = Math.floor(n);
      touched = true;
      i += 1;
    }
    if (!touched) fail(`nothing to set. Options: ${Object.keys(numeric).join(', ')}`);
    data['budget'] = budget;
    writeRaw(path, data);
    print(`budget updated in ${path}`);
    print(dim('  Restart any running Claude Code session to pick this up.'));
    return 0;
  }

  if (sub === 'mode') {
    const value = args[1];
    if (!isMode(value)) fail('mode must be one of: read, write, full');
    const path = targetPath(global);
    const data = readRaw(path);
    data['defaultMode'] = value;
    writeRaw(path, data);
    print(`default mode set to ${bold(value)} in ${path}`);
    return 0;
  }

  if (sub === 'verify') {
    const value = args.slice(1).join(' ');
    if (!value) fail('usage: claudex policy verify "<command>"');
    const path = targetPath(global);
    const data = readRaw(path);
    data['verifyCommand'] = value;
    writeRaw(path, data);
    print(`verify command set in ${path}`);
    print(dim('  Reviews will now carry a real host-side test result as evidence.'));
    return 0;
  }

  fail(`unknown policy subcommand: ${sub}`);
}
