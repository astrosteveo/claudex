import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIRNAME } from './config.ts';
import type { ConsultKind, Mode } from './types.ts';
import type { SessionUsage } from './budget.ts';

export interface ConsultRecord {
  ts: number;
  sessionId: string;
  kind: ConsultKind;
  mode: Mode;
  ok: boolean;
  denied: string | null;
  partial: string | null;
  durationMs: number;
  threadId: string | null;
  promptChars: number;
  answerChars: number;
}

/**
 * Every write here is fail-soft by contract. A broken log must never turn a
 * finished peer answer into an error — the log exists to explain spend after
 * the fact, and nothing downstream reads it synchronously.
 */
export class ConsultLog {
  readonly #dir: string;

  constructor(projectRoot: string) {
    this.#dir = join(projectRoot, CONFIG_DIRNAME);
  }

  #ensure(): boolean {
    try {
      mkdirSync(this.#dir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  append(record: ConsultRecord): void {
    try {
      if (!this.#ensure()) return;
      appendFileSync(join(this.#dir, 'consults.jsonl'), JSON.stringify(record) + '\n', 'utf8');
    } catch {
      /* fail-soft, by contract */
    }
  }

  /** Mirrors in-memory usage to disk so `claudex status` can see a live session.
   *  The in-memory copy stays authoritative; this is observability only. */
  writeUsage(usage: SessionUsage): void {
    try {
      if (!this.#ensure()) return;
      mkdirSync(join(this.#dir, 'sessions'), { recursive: true });
      writeFileSync(join(this.#dir, 'sessions', `${usage.sessionId}.json`), JSON.stringify(usage, null, 2), 'utf8');
    } catch {
      /* fail-soft, by contract */
    }
  }

  read(limit = 50): ConsultRecord[] {
    try {
      const path = join(this.#dir, 'consults.jsonl');
      if (!existsSync(path)) return [];
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
      const out: ConsultRecord[] = [];
      for (const line of lines.slice(-limit)) {
        try {
          out.push(JSON.parse(line) as ConsultRecord);
        } catch {
          // One corrupt line must not hide the rest of the history.
        }
      }
      return out;
    } catch {
      return [];
    }
  }
}
