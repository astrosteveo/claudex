import { runDoctor, worstStatus } from '../core/doctor.ts';
import { loadConfig } from '../core/config.ts';
import { SYMBOL, bold, dim, print } from './output.ts';

function fmt(v: number): string {
  return v === -1 ? 'unlimited' : String(v);
}

export async function doctorCommand(): Promise<number> {
  const checks = await runDoctor();
  print(bold('claudex doctor'));
  print();
  for (const c of checks) {
    print(`  ${SYMBOL[c.status]} ${c.name.padEnd(18)} ${c.detail}`);
    if (c.fix && c.status !== 'ok') print(`    ${dim('-> ' + c.fix)}`);
  }

  const config = loadConfig();
  print();
  print(bold('configuration'));
  print(`  project        ${config.projectRoot}`);
  print(`  policy         ${config.policy}`);
  print(`  default mode   ${config.defaultMode}`);
  print(`  model          ${config.model ?? dim('(codex default)')}`);
  print(`  verify command ${config.verifyCommand ?? dim('(none - reviews get no test evidence)')}`);
  print(
    `  budget         ${fmt(config.budget.maxPerSession)} consults, ${fmt(config.budget.maxTokens)} tokens, ` +
      `${config.budget.timeoutMs / 1000}s per call`,
  );

  const worst = worstStatus(checks);
  print();
  if (worst === 'fail') {
    print('claudex cannot run until the failures above are fixed.');
    return 1;
  }
  print(worst === 'warn' ? 'Usable, with the warnings above.' : 'Ready.');
  return 0;
}
