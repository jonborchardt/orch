/** Human vs JSON rendering. Handlers return plain data; this decides how it is printed. */
import { OrchError } from '../core/errors.ts';

export function print(data: unknown, json: boolean): void {
  console.log(json ? JSON.stringify(data, null, 2) : human(data));
}

export function printError(err: unknown, json: boolean): number {
  const code = err instanceof OrchError ? err.exitCode : 1;
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : 'Error';
  console.error(
    json
      ? JSON.stringify({ error: { type: name, message, exitCode: code } })
      : `${name}: ${message}`,
  );
  return code;
}

/** Key/value lines; arrays of objects become one line per item; nested objects indent. */
export function human(data: unknown, indent = ''): string {
  if (Array.isArray(data)) {
    if (data.length === 0) return `${indent}(none)`;
    return data.map((item) => human(item, indent)).join(data.some(isObject) ? '\n\n' : '\n');
  }
  if (isObject(data)) {
    const width = Math.max(...Object.keys(data).map((k) => k.length));
    return Object.entries(data)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => {
        if (isObject(v) || (Array.isArray(v) && v.some(isObject))) {
          return `${indent}${k}:\n${human(v, indent + '  ')}`;
        }
        const val = Array.isArray(v) ? (v.length ? v.join(', ') : '(none)') : String(v);
        return `${indent}${k.padEnd(width)}  ${val}`;
      })
      .join('\n');
  }
  return `${indent}${String(data)}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
