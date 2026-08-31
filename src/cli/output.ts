const ESC = '\u001b[';
const useColor = process.stdout.isTTY === true && !process.env['NO_COLOR'];
const wrap =
  (code: string) =>
  (s: string): string =>
    useColor ? `${ESC}${code}m${s}${ESC}0m` : s;

export const bold = wrap('1');
export const dim = wrap('2');
export const green = wrap('32');
export const yellow = wrap('33');
export const red = wrap('31');
export const cyan = wrap('36');

export const SYMBOL = { ok: green('✓'), warn: yellow('!'), fail: red('✗') } as const;

export function print(s = ''): void {
  process.stdout.write(s + '\n');
}

export function fail(message: string): never {
  process.stderr.write(red('error: ') + message + '\n');
  process.exit(1);
}
