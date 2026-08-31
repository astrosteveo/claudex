import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Injected by tsup at build time (see tsup.config.ts). Declared, not imported,
 * so the identifier simply does not exist when Node runs the sources directly
 * under type stripping — which is what the `typeof` guard below relies on.
 */
declare const __CLAUDEX_VERSION__: string | undefined;
declare const __CLAUDEX_NAME__: string | undefined;

/**
 * The version was previously hardcoded in two places that a release bump did
 * not touch, so the published 0.1.1 reported itself as 0.1.0 — including in the
 * MCP handshake, which is the first thing you check when a host seems to be
 * running stale code. package.json is the only source now.
 */
function fromPackageJson<K extends 'version' | 'name'>(key: K, fallback: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
      const value = pkg[key];
      if (typeof value === 'string') return value;
    } catch {
      /* keep walking up */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fallback;
}

export const VERSION: string =
  typeof __CLAUDEX_VERSION__ === 'string' ? __CLAUDEX_VERSION__ : fromPackageJson('version', '0.0.0-unknown');

export const PACKAGE_NAME: string =
  typeof __CLAUDEX_NAME__ === 'string' ? __CLAUDEX_NAME__ : fromPackageJson('name', 'claudex');
