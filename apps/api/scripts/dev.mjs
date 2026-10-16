#!/usr/bin/env node
// pnpm --filter @bf/api dev — HTTP API and worker together, in watch mode, with prefixed output.
import { spawn } from 'node:child_process';

const NODE_ARGS = [
  '--import',
  '@swc-node/register/esm-register',
  '--import',
  './src/instrumentation.ts',
  '--watch',
];
const processes = [
  ['api', 'src/main.ts', '\x1b[36m'],
  ['worker', 'src/worker.ts', '\x1b[35m'],
].map(([name, entry, color]) => {
  const child = spawn(process.execPath, [...NODE_ARGS, entry], { stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `${color}[${name}]\x1b[0m `;
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) process.stdout.write(`${prefix}${line}\n`);
    });
  }
  child.on('exit', (code) => {
    process.stdout.write(`${prefix}exited with ${code}\n`);
    stopAll();
  });
  return child;
});

let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const child of processes) if (child.exitCode === null) child.kill('SIGTERM');
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stopAll);
