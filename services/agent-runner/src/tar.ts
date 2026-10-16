import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

// The workspace bundle (BF-040's deterministic ustar + zstd), read safely (BF-043): regular files and directories
// only — links, devices and FIFOs are refused, as are absolute paths and `..` — and bounded in size.

const BLOCK = 512;

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleError';
  }
}

export interface BundleEntry {
  readonly path: string;
  readonly type: 'file' | 'directory';
  readonly data: Buffer;
}

function text(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return (end === -1 ? raw : raw.subarray(0, end)).toString('utf8');
}

/** The entries of a ustar archive; throws `BundleError` on anything but plain files and directories. */
export function readTar(archive: Buffer): BundleEntry[] {
  if (archive.length === 0 || archive.length % BLOCK !== 0)
    throw new BundleError('Corrupt bundle (not a tar archive).');
  const entries: BundleEntry[] = [];
  let offset = 0;
  let ended = false;
  while (offset + BLOCK <= archive.length) {
    const block = archive.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) {
      ended = true;
      break;
    }
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (block[i] as number);
    if (sum !== Number.parseInt(text(block, 148, 8).trim(), 8))
      throw new BundleError('Corrupt bundle (checksum).');
    const name = text(block, 0, 100);
    const prefix = text(block, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(text(block, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(block[156] as number);
    if (!Number.isFinite(size) || size < 0) throw new BundleError(`Corrupt bundle (size of ${path}).`);
    if (type !== '0' && type !== '\0' && type !== '5')
      throw new BundleError(
        `The bundle holds ${path}, which is not a plain file or directory (links are refused).`,
      );
    const data = archive.subarray(offset + BLOCK, offset + BLOCK + size);
    if (data.length !== size) throw new BundleError(`Truncated bundle at ${path}.`);
    entries.push({ path, type: type === '5' ? 'directory' : 'file', data: Buffer.from(data) });
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  if (!ended) throw new BundleError('Corrupt bundle (no end of archive).');
  return entries;
}

/** A path inside `root`, or a `BundleError`. */
export function safeTarget(root: string, path: string): string {
  if (!path || path.includes('\0') || isAbsolute(path) || /^[a-zA-Z]:/.test(path))
    throw new BundleError(`Refused path in the bundle: ${JSON.stringify(path)}.`);
  const target = normalize(join(root, path));
  const rel = relative(root, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new BundleError(`Refused path in the bundle: ${JSON.stringify(path)} leaves the workspace.`);
  return target;
}

/** Decompresses (bounded) and extracts a bundle into `root`; returns the number of files written. */
export async function extractBundle(bundle: Buffer, root: string, maxBytes: number): Promise<number> {
  let archive: Buffer;
  try {
    archive = zstdDecompressSync(bundle, { maxOutputLength: maxBytes });
  } catch (error) {
    throw new BundleError(
      `The bundle is not valid tar.zst within ${maxBytes} bytes: ${(error as Error).message}`,
    );
  }
  let files = 0;
  for (const entry of readTar(archive)) {
    const target = safeTarget(root, entry.path);
    if (entry.type === 'directory') {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    // Never executable, never through a link: `wx` refuses an existing path (a duplicate or a planted link).
    await writeFile(target, entry.data, { mode: 0o644, flag: 'wx' });
    files++;
  }
  return files;
}

const octal = (value: number, length: number) => `${value.toString(8).padStart(length - 1, '0')}\0`;

/** A ustar + zstd bundle of files (tests and the smoke run; the API builds its own the same way). */
export function packBundle(files: ReadonlyMap<string, string | Buffer>): Buffer {
  const parts: Buffer[] = [];
  for (const path of [...files.keys()].sort()) {
    const body = Buffer.from(files.get(path) as string | Buffer);
    const block = Buffer.alloc(BLOCK);
    let name = path;
    let prefix = '';
    if (Buffer.byteLength(path) > 100) {
      const cut = path.lastIndexOf('/', 155);
      prefix = path.slice(0, cut);
      name = path.slice(cut + 1);
    }
    block.write(name, 0);
    block.write(octal(0o644, 8), 100);
    block.write(octal(0, 8), 108);
    block.write(octal(0, 8), 116);
    block.write(octal(body.length, 12), 124);
    block.write(octal(0, 12), 136);
    block.fill(0x20, 148, 156);
    block.write('0', 156);
    block.write('ustar\0', 257);
    block.write('00', 263);
    block.write(prefix, 345);
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    parts.push(block, body, Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return zstdCompressSync(Buffer.concat(parts));
}
