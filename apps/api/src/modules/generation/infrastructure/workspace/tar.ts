import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

// A deterministic tar (ustar) of a generation workspace (BF-040): files in sorted path order, a fixed mtime, owner
// and mode, so the same files always give the same bytes (and bundle hash). Compressed with zstd (Node's zlib).

const BLOCK = 512;
const encoder = new TextEncoder();

function field(target: Buffer, offset: number, length: number, value: string) {
  const bytes = encoder.encode(value);
  if (bytes.length > length) throw new Error(`tar field too long: ${value}`);
  target.set(bytes, offset);
}

const octal = (value: number, length: number) => `${value.toString(8).padStart(length - 1, '0')}\0`;

function header(path: string, size: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  const bytes = encoder.encode(path);
  // ustar: names up to 100 bytes, or a prefix (≤ 155) + name (≤ 100) split at a slash.
  let name = path;
  let prefix = '';
  if (bytes.length > 100) {
    const cut = path.lastIndexOf('/', 155);
    if (cut <= 0 || encoder.encode(path.slice(cut + 1)).length > 100)
      throw new Error(`tar path too long: ${path}`);
    prefix = path.slice(0, cut);
    name = path.slice(cut + 1);
  }
  field(block, 0, 100, name);
  field(block, 100, 8, octal(0o644, 8));
  field(block, 108, 8, octal(0, 8));
  field(block, 116, 8, octal(0, 8));
  field(block, 124, 12, octal(size, 12));
  field(block, 136, 12, octal(0, 12));
  block.fill(0x20, 148, 156); // checksum computed over spaces
  field(block, 156, 1, '0');
  field(block, 257, 6, 'ustar\0');
  field(block, 263, 2, '00');
  field(block, 345, 155, prefix);
  let sum = 0;
  for (const byte of block) sum += byte;
  field(block, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return block;
}

export function tar(files: ReadonlyMap<string, Buffer | string>): Buffer {
  const parts: Buffer[] = [];
  for (const path of [...files.keys()].sort()) {
    if (path.startsWith('/') || path.split('/').includes('..')) throw new Error(`unsafe tar path: ${path}`);
    const content = files.get(path) as Buffer | string;
    const body = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    parts.push(header(path, body.length), body);
    const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/** The files of a tar this module wrote (tests and tooling). */
export function untar(archive: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + BLOCK <= archive.length) {
    const block = archive.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    const text = (start: number, length: number) =>
      block
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '');
    const name = text(0, 100);
    const prefix = text(345, 155);
    const size = Number.parseInt(text(124, 12).trim(), 8);
    const path = prefix ? `${prefix}/${name}` : name;
    files.set(path, Buffer.from(archive.subarray(offset + BLOCK, offset + BLOCK + size)));
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}

export const packBundle = (files: ReadonlyMap<string, Buffer | string>): Buffer =>
  zstdCompressSync(tar(files));
export const unpackBundle = (bundle: Buffer): Map<string, Buffer> => untar(zstdDecompressSync(bundle));
