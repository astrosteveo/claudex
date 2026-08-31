import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };

// Bundled to single files on purpose. These entrypoints are launched by an agent
// CLI, often inside a sandbox, where a transitive dependency that fails to
// resolve takes the whole integration down with no useful error. Bundling makes
// runtime resolution deterministic.
export default defineConfig({
  entry: { cli: 'src/cli.ts', 'mcp-server': 'src/mcp-server.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  bundle: true,
  noExternal: [/.*/],
  splitting: false,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  // Single-sources the version. Without this it lives in a hardcoded constant
  // that a release bump silently leaves stale.
  define: { __CLAUDEX_VERSION__: JSON.stringify(version) },
});
