// A tiny static file server for the rendered fixtures and the gallery (no dependency): `tsx src/cli/serve.ts <dir>
// [port]`. Local tests only; it serves files under the directory and nothing else.
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

export function serve(root: string, port: number) {
  const base = resolve(root);
  const server = createServer((request, response) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }
    let file = normalize(join(base, path));
    if (file !== base && !file.startsWith(base + sep)) {
      response.writeHead(403).end();
      return;
    }
    try {
      if (statSync(file).isDirectory()) file = join(file, 'index.html');
      statSync(file);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    response.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    createReadStream(file).pipe(response);
  });
  server.listen(port, '127.0.0.1');
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir = 'dist', port = '4410'] = process.argv.slice(2);
  serve(dir, Number(port));
  console.log(`Serving ${dir} on http://127.0.0.1:${port}`);
}
