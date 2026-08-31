import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderSkill } from '../src/cli/skill.ts';
import { loadConfig, DEFAULT_POLICY } from '../src/core/config.ts';

const root = resolve(import.meta.dirname, '..');
const readJson = (p: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(root, p), 'utf8')) as Record<string, unknown>;

test('the checked-in skill matches what renderSkill produces', () => {
  // skills/claudex/SKILL.md is a generated artifact that is committed, so it
  // can drift from renderSkill() with nothing to notice. It ships in the npm
  // package and in the plugin, which means the drift reaches users as guidance
  // that no longer describes the budget they will actually hit.
  const generated = renderSkill({ ...loadConfig(root), policy: DEFAULT_POLICY });
  const onDisk = readFileSync(resolve(root, 'skills/claudex/SKILL.md'), 'utf8');
  assert.equal(
    onDisk,
    generated,
    'skills/claudex/SKILL.md is stale — regenerate it rather than editing it by hand',
  );
});

test('the plugin pins the version of the package actually being published', () => {
  // The plugin fetches the MCP server over npx at a pinned version. Bumping
  // package.json without bumping the pin ships a plugin that installs the
  // previous release, which looks like the new code simply not taking effect.
  const pkg = readJson('package.json');
  const plugin = readJson('.claude-plugin/plugin.json');

  assert.equal(plugin['version'], pkg['version'], 'plugin.json version must track package.json');

  const servers = plugin['mcpServers'] as Record<string, { args?: string[] }>;
  const args = servers['claudex']?.args ?? [];
  const spec = args.find((a) => a.includes('@') && !a.startsWith('-'));
  assert.equal(
    spec,
    `${String(pkg['name'])}@${String(pkg['version'])}`,
    'the npx spec in plugin.json must name the published package and version',
  );
});

test('every path the package claims to ship is actually present', () => {
  // A `files` entry that no longer exists is not an error at publish time —
  // npm just ships less than intended, and the gap only shows up as a broken
  // install for somebody else.
  const pkg = readJson('package.json');
  for (const entry of pkg['files'] as string[]) {
    const target = resolve(root, entry.replace(/\/$/, ''));
    assert.doesNotThrow(() => statSync(target), `${entry} is listed in package.json files but missing`);
  }
});

test('both declared bins point at real build outputs', () => {
  const pkg = readJson('package.json');
  for (const [name, path] of Object.entries(pkg['bin'] as Record<string, string>)) {
    const built = readFileSync(resolve(root, path), 'utf8');
    assert.match(built.slice(0, 40), /^#!/, `${name} must keep its shebang to be executable`);
  }
});

test('the version reported at runtime is the version being published', async () => {
  // It was hardcoded in two constants a release bump did not touch, so the
  // published 0.1.1 introduced itself as 0.1.0 — in `--version` and, worse, in
  // the MCP handshake, which is where you look to confirm a host picked up new
  // code at all.
  const { VERSION } = await import('../src/core/version.ts');
  const pkg = readJson('package.json');
  assert.equal(VERSION, pkg['version']);
  assert.doesNotMatch(VERSION, /unknown/, 'version lookup fell through to its fallback');
});

test('no source file hardcodes a version string', async () => {
  const { readdirSync } = await import('node:fs');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(resolve(dir, e.name)) : e.name.endsWith('.ts') ? [resolve(dir, e.name)] : [],
    );
  const offenders = walk(resolve(root, 'src'))
    .filter((f) => !f.endsWith('version.ts'))
    .filter((f) => /['"]\d+\.\d+\.\d+['"]/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, [], 'import VERSION from core/version.ts instead of hardcoding');
});
