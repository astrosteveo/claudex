import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIRNAME } from './config.ts';

/** Every solve/debate run leaves a full transcript on disk. Best-effort: a
 *  failed write must never take down a run that is otherwise working. */
export class Transcript {
  readonly #dir: string;
  #step = 0;

  constructor(projectRoot: string, kind: string) {
    const runsDir = join(projectRoot, CONFIG_DIRNAME, 'runs');
    let n = 1;
    try {
      mkdirSync(runsDir, { recursive: true });
      const existing = readdirSync(runsDir)
        .map((d) => Number(d.split('-')[0]))
        .filter((x) => Number.isFinite(x));
      n = existing.length ? Math.max(...existing) + 1 : 1;
    } catch {
      /* fall back to run 1 */
    }
    this.#dir = join(runsDir, `${n}-${kind}`);
    try {
      mkdirSync(this.#dir, { recursive: true });
    } catch {
      /* best-effort */
    }
  }

  get path(): string {
    return this.#dir;
  }

  write(name: string, content: string): void {
    this.#step += 1;
    try {
      writeFileSync(join(this.#dir, `${String(this.#step).padStart(2, '0')}-${name}.md`), content, 'utf8');
    } catch {
      /* best-effort */
    }
  }
}
