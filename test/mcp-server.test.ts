import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ENTRY = resolve(import.meta.dirname, '..', 'dist', 'mcp-server.js');

/**
 * These spawn the built server as a real subprocess over real pipes, because
 * the bugs worth catching here are in the stdio lifecycle, not the handlers.
 */
class Client {
  #child: ChildProcessWithoutNullStreams;
  #buffer = '';
  #pending = new Map<number, (msg: Record<string, unknown>) => void>();
  #id = 0;
  exited: Promise<number | null>;

  constructor(cwd: string, env: Record<string, string> = {}) {
    this.#child = spawn(process.execPath, [ENTRY], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk: string) => {
      this.#buffer += chunk;
      let nl: number;
      while ((nl = this.#buffer.indexOf('\n')) >= 0) {
        const line = this.#buffer.slice(0, nl).trim();
        this.#buffer = this.#buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          const id = msg['id'];
          if (typeof id === 'number') this.#pending.get(id)?.(msg);
        } catch {
          /* ignore */
        }
      }
    });
    this.exited = new Promise((r) => this.#child.once('close', (code) => r(code)));
  }

  send(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = ++this.#id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`timed out waiting for ${method}`)), 30_000);
      this.#pending.set(id, (msg) => {
        clearTimeout(timer);
        res(msg);
      });
      this.#child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method: string): void {
    this.#child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  }

  async handshake(): Promise<void> {
    await this.send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'claudex-test', version: '0' },
    });
    this.notify('notifications/initialized');
  }

  closeStdin(): void {
    this.#child.stdin.end();
  }

  kill(): void {
    this.#child.kill('SIGKILL');
  }
}

function project(config: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'claudex-mcp-'));
  mkdirSync(join(root, '.claudex'), { recursive: true });
  writeFileSync(join(root, '.claudex', 'config.json'), JSON.stringify(config));
  return root;
}

function text(res: Record<string, unknown>): string {
  const result = res['result'] as { content?: { text?: string }[] } | undefined;
  return result?.content?.[0]?.text ?? '';
}

test('the server exposes exactly the documented tool surface', async () => {
  const c = new Client(project({}));
  await c.handshake();
  const res = await c.send('tools/list', {});
  const tools = (res['result'] as { tools: { name: string }[] }).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    'ask_codex',
    'codex_budget',
    'codex_debate',
    'codex_delegate',
    'codex_reply',
    'codex_review',
  ]);
  c.closeStdin();
  await c.exited;
});

test('policy "off" denies without ever spawning codex, and says not to retry', async () => {
  const root = project({ policy: 'off' });
  const c = new Client(root);
  await c.handshake();
  const started = Date.now();
  const res = await c.send('tools/call', { name: 'ask_codex', arguments: { question: 'anything' } });
  // A spawn would take seconds; a refusal is immediate.
  assert.ok(Date.now() - started < 5000, 'denial must not invoke the peer');
  const body = text(res);
  assert.match(body, /disabled/i);
  assert.match(body, /Do not retry/);
  // A denial is a normal outcome the model reasons about, not a protocol error.
  assert.equal(res['error'], undefined);
  c.closeStdin();
  await c.exited;
});

test('a denial is still recorded, so spend reporting shows refusals', async () => {
  const root = project({ policy: 'off' });
  const c = new Client(root);
  await c.handshake();
  await c.send('tools/call', { name: 'ask_codex', arguments: { question: 'anything' } });
  c.closeStdin();
  await c.exited;
  assert.ok(existsSync(join(root, '.claudex', 'consults.jsonl')));
});

test('codex_budget answers without invoking the peer', async () => {
  const c = new Client(project({ policy: 'assisted', budget: { maxPerSession: 7 } }));
  await c.handshake();
  const res = await c.send('tools/call', { name: 'codex_budget', arguments: {} });
  const body = text(res);
  assert.match(body, /policy: assisted/);
  assert.match(body, /consults: 0 \/ 7/);
  c.closeStdin();
  await c.exited;
});

test('the server exits cleanly on stdin EOF rather than being killed', async () => {
  const c = new Client(project({}));
  await c.handshake();
  await c.send('tools/call', { name: 'codex_budget', arguments: {} });
  c.closeStdin();
  const code = await c.exited;
  assert.equal(code, 0);
});

test('an invalid argument is rejected by schema validation, not by spawning codex', async () => {
  const c = new Client(project({}));
  await c.handshake();
  const started = Date.now();
  const res = await c.send('tools/call', { name: 'ask_codex', arguments: { question: '' } });
  assert.ok(Date.now() - started < 5000);
  const isError = (res['result'] as { isError?: boolean } | undefined)?.isError;
  assert.ok(isError === true || res['error'] !== undefined, 'empty question must not reach the peer');
  c.closeStdin();
  await c.exited;
});
