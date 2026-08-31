import { loadConfig } from '../core/config.ts';
import { ConsultLog } from '../core/log.ts';
import { bold, dim, green, red, yellow, print } from './output.ts';

function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

export function statusCommand(): number {
  const config = loadConfig();
  const log = new ConsultLog(config.projectRoot);
  const records = log.read(500);

  print(bold('claudex status'));
  print(`  project  ${config.projectRoot}`);
  print(`  policy   ${config.policy}`);
  print();

  if (records.length === 0) {
    print(dim('  No Codex consults recorded for this project yet.'));
    return 0;
  }

  const denied = records.filter((r) => r.denied !== null).length;
  const failed = records.filter((r) => !r.ok && r.denied === null).length;
  const totalMs = records.reduce((a, r) => a + r.durationMs, 0);
  const byKind = new Map<string, number>();
  for (const r of records) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);

  print(bold('  lifetime'));
  print(`    consults   ${records.length} (${[...byKind].map(([k, n]) => `${k} ${n}`).join(', ')})`);
  print(`    denied     ${denied}`);
  print(`    failed     ${failed}`);
  print(`    peer time  ${Math.round(totalMs / 1000)}s`);
  print();

  print(bold('  recent'));
  for (const r of records.slice(-10).reverse()) {
    const mark = r.denied ? yellow('denied') : r.ok ? green('ok') : red('failed');
    const extra = r.denied ? ` (${r.denied})` : r.partial ? ` (${r.partial})` : '';
    print(`    ${ago(r.ts).padEnd(9)} ${r.kind.padEnd(8)} ${mark}${extra} ${dim(`${Math.round(r.durationMs / 1000)}s`)}`);
  }
  return 0;
}

export function logCommand(limit: number): number {
  const config = loadConfig();
  const records = new ConsultLog(config.projectRoot).read(limit);
  if (records.length === 0) {
    print(dim('no consults recorded'));
    return 0;
  }
  for (const r of records) {
    print(JSON.stringify(r));
  }
  return 0;
}
