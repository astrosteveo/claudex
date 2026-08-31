import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Budget, ClaudexConfig, ConsultKind, Mode, Policy } from './types.ts';

export const POLICIES: readonly Policy[] = ['off', 'on-request', 'assisted', 'aggressive'] as const;
export const MODES: readonly Mode[] = ['read', 'write', 'full'] as const;

/** Per-policy budget defaults. A stranger's first run should not quietly burn
 *  their Codex quota, so even `aggressive` is bounded. */
export const POLICY_BUDGETS: Record<Policy, Budget> = {
  off: { maxPerSession: 0, cooldownMs: 0, timeoutMs: 300_000, maxWallClockMs: 0, maxTokens: 0 },
  'on-request': { maxPerSession: 12, cooldownMs: 0, timeoutMs: 300_000, maxWallClockMs: 1_800_000, maxTokens: 400_000 },
  assisted: { maxPerSession: 25, cooldownMs: 10_000, timeoutMs: 300_000, maxWallClockMs: 3_600_000, maxTokens: 900_000 },
  aggressive: { maxPerSession: 60, cooldownMs: 0, timeoutMs: 600_000, maxWallClockMs: 7_200_000, maxTokens: -1 },
};

export const DEFAULT_POLICY: Policy = 'on-request';

/** Sandbox flags per mode, kept as data rather than inlined in the adapter.
 *  Both CLIs move their flag surface between releases; retargeting a mode
 *  should not mean editing adapter code. */
export const CODEX_SANDBOX: Record<Mode, string> = {
  read: 'read-only',
  write: 'workspace-write',
  full: 'danger-full-access',
};

/**
 * Per-kind multiplier on the base timeout.
 *
 * A review is not a slower question, it is a different amount of work: Codex
 * reads the whole target, runs its own checks, and writes structured findings.
 * Observed on this repo, a three-file review overshoots a 300s budget while an
 * `ask` finishes in under 30s. One flat timeout either cuts reviews off or
 * lets a wedged question hang for a quarter of an hour.
 */
export const KIND_TIMEOUT_MULTIPLIER: Record<ConsultKind, number> = {
  ask: 1,
  reply: 1,
  debate: 1.5,
  review: 3,
  solve: 3,
};

export const CONFIG_DIRNAME = '.claudex';
export const CONFIG_FILENAME = 'config.json';

export function userConfigPath(): string {
  return join(homedir(), CONFIG_DIRNAME, CONFIG_FILENAME);
}

export function projectConfigPath(root: string): string {
  return join(root, CONFIG_DIRNAME, CONFIG_FILENAME);
}

/** Walk up for a project root. A `.claudex/` beats a `.git/` so an explicitly
 *  configured subproject wins over the enclosing repo. */
export function findProjectRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  let gitRoot: string | null = null;
  for (;;) {
    if (existsSync(join(dir, CONFIG_DIRNAME))) return dir;
    if (gitRoot === null && existsSync(join(dir, '.git'))) gitRoot = dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return gitRoot ?? resolve(start);
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    // A malformed config must not take the MCP server down; defaults are safe.
    return null;
  }
}

export function isPolicy(v: unknown): v is Policy {
  return typeof v === 'string' && (POLICIES as readonly string[]).includes(v);
}

export function isMode(v: unknown): v is Mode {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v);
}

/** A falsy timeout silently disables the kill timer, which is the only thing
 *  that reclaims a wedged peer CLI. Reject anything non-positive. */
export function parseTimeout(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function parseLimit(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i < -1 ? fallback : i;
}

function mergeBudget(base: Budget, raw: unknown): Budget {
  if (raw === null || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  return {
    maxPerSession: parseLimit(r['maxPerSession'], base.maxPerSession),
    cooldownMs: parseLimit(r['cooldownMs'], base.cooldownMs),
    timeoutMs: parseTimeout(r['timeoutMs'], base.timeoutMs),
    maxWallClockMs: parseLimit(r['maxWallClockMs'], base.maxWallClockMs),
    maxTokens: parseLimit(r['maxTokens'], base.maxTokens),
  };
}

/** Layers, lowest to highest: policy defaults < user config < project config
 *  < environment. Project beats user so a repo can tighten spend for everyone
 *  working in it; env beats both so a single run can be steered without edits. */
export function loadConfig(cwd: string = process.cwd()): ClaudexConfig {
  const projectRoot = findProjectRoot(cwd);
  const user = readJson(userConfigPath()) ?? {};
  const project = readJson(projectConfigPath(projectRoot)) ?? {};

  const envPolicy = process.env['CLAUDEX_POLICY'];
  const policy: Policy = isPolicy(envPolicy)
    ? envPolicy
    : isPolicy(project['policy'])
      ? project['policy']
      : isPolicy(user['policy'])
        ? user['policy']
        : DEFAULT_POLICY;

  let budget = POLICY_BUDGETS[policy];
  budget = mergeBudget(budget, user['budget']);
  budget = mergeBudget(budget, project['budget']);
  if (process.env['CLAUDEX_TIMEOUT_MS']) {
    budget = { ...budget, timeoutMs: parseTimeout(process.env['CLAUDEX_TIMEOUT_MS'], budget.timeoutMs) };
  }
  if (process.env['CLAUDEX_MAX_PER_SESSION']) {
    budget = { ...budget, maxPerSession: parseLimit(process.env['CLAUDEX_MAX_PER_SESSION'], budget.maxPerSession) };
  }

  const rawMode = process.env['CLAUDEX_MODE'] ?? project['defaultMode'] ?? user['defaultMode'];
  const defaultMode: Mode = isMode(rawMode) ? rawMode : 'read';

  const model =
    process.env['CLAUDEX_MODEL'] ??
    (typeof project['model'] === 'string' ? project['model'] : null) ??
    (typeof user['model'] === 'string' ? user['model'] : null);

  const verifyCommand =
    (typeof project['verifyCommand'] === 'string' ? project['verifyCommand'] : null) ??
    (typeof user['verifyCommand'] === 'string' ? user['verifyCommand'] : null);

  return { policy, budget, defaultMode, model: model ?? null, verifyCommand, projectRoot };
}
