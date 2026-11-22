/**
 * A minimal POSIX ustar writer and reader for `orch backup` (Node has no built-in tar). Writes
 * regular files only; reads every entry and reports its type so the caller can refuse links and
 * devices. Pure: buffers in, buffers out.
 */
import { ValidationError } from './errors.ts';

const BLOCK = 512;

export interface TarEntry {
  path: string;
  /** ustar typeflag: '0' regular file, '5' directory, '1'/'2' links, others devices or fifos. */
  type: string;
  data: Buffer;
}

function octal(header: Buffer, offset: number, width: number, value: number): void {
  header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width, 'ascii');
}

/** Split a path into ustar's prefix (155 bytes) and name (100 bytes); overlong paths fail. */
function splitName(path: string): { prefix: string; name: string } {
  if (Buffer.byteLength(path) <= 100) return { prefix: '', name: path };
  for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name !== '') {
      return { prefix, name };
    }
  }
  throw new ValidationError(`Path too long for a backup archive (ustar limit): ${path}`);
}

function header(path: string, size: number, mtime: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  const { prefix, name } = splitName(path);
  h.write(name, 0, 100, 'utf8');
  octal(h, 100, 8, 0o644);
  octal(h, 108, 8, 0);
  octal(h, 116, 8, 0);
  octal(h, 124, 12, size);
  octal(h, 136, 12, mtime);
  h.fill(' ', 148, 156); // checksum is computed with its own field as spaces
  h.write('0', 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

/** A tar of regular files, in the given order, ending with two zero blocks. */
export function encodeTar(files: readonly { path: string; data: Buffer }[], mtime = 0): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    parts.push(header(f.path, f.data.length, mtime), f.data);
    const pad = (BLOCK - (f.data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

function field(h: Buffer, offset: number, width: number): string {
  const raw = h.subarray(offset, offset + width);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? width : end).toString('utf8');
}

/** Every entry of a ustar archive. A bad checksum, size, or truncation fails. */
export function decodeTar(buf: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let at = 0;
  for (;;) {
    if (at + BLOCK > buf.length) throw new ValidationError('Archive is truncated (no end marker).');
    const h = buf.subarray(at, at + BLOCK);
    if (h.every((b) => b === 0)) return out;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : (h[i] ?? 0);
    const recorded = parseInt(field(h, 148, 8).trim(), 8);
    if (recorded !== sum)
      throw new ValidationError(`Archive header checksum mismatch at byte ${String(at)}.`);
    const sizeText = field(h, 124, 12).trim();
    const size = sizeText === '' ? 0 : parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || size < 0 || !/^[0-7]*$/.test(sizeText)) {
      throw new ValidationError(`Archive entry has an invalid size at byte ${String(at)}.`);
    }
    const name = field(h, 0, 100);
    const prefix = field(h, 345, 155);
    const type = field(h, 156, 1) || '0';
    const start = at + BLOCK;
    if (start + size > buf.length) throw new ValidationError('Archive is truncated.');
    out.push({
      path: prefix ? `${prefix}/${name}` : name,
      type,
      data: Buffer.from(buf.subarray(start, start + size)),
    });
    at = start + Math.ceil(size / BLOCK) * BLOCK;
  }
}
