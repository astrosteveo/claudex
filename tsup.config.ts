import { defineConfig } from 'tsup';

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
});
