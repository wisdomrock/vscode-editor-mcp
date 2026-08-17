let failures = 0;
let total = 0;

export function check(name: string, cond: boolean, extra = ''): void {
  total++;
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
}

export function eq<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** A measurement worth printing that is not a pass/fail guarantee. */
export function note(name: string, detail: string): void {
  console.log(`note  ${name} — ${detail}`);
}

export async function section(name: string, fn: () => Promise<void> | void): Promise<void> {
  console.log(`\n── ${name}`);
  try {
    await fn();
  } catch (err) {
    check(`${name} threw`, false, err instanceof Error ? err.message : String(err));
  }
}

export function report(): never {
  console.log(
    failures === 0 ? `\nAll ${total} checks passed.` : `\n${failures} of ${total} check(s) FAILED.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}
