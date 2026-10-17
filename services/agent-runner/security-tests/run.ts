// The sandbox security suite (BF-043): what a run must NOT be able to do, checked against real containers with the
// Docker provider's settings. Needs the runner and egress proxy images (`pnpm runner:build`, `pnpm egress:build`).
// Usage: node services/agent-runner/security-tests/run.ts [runner-image] [egress-image]
import { spawnSync } from 'node:child_process';

const runner = process.argv[2] ?? process.env.RUNNER_IMAGE ?? 'bf-agent-runner:dev';
const egress = process.argv[3] ?? process.env.EGRESS_IMAGE ?? 'bf-egress-proxy:dev';
const socketProxy = 'wollomatic/socket-proxy:1.13.1';
const suffix = `${process.pid}`;
const sandboxNet = `bf-sec-sandbox-${suffix}`;
const apiNet = `bf-sec-api-${suffix}`;

const HARDENED = [
  '--read-only',
  '--user',
  '10001:10001',
  '--tmpfs',
  '/workspace:rw,nosuid,nodev,noexec,size=64m,uid=10001,gid=10001,mode=0700',
  '--tmpfs',
  '/tmp:rw,nosuid,nodev,noexec,size=32m',
  '--tmpfs',
  '/home/agent:rw,nosuid,nodev,noexec,size=32m,uid=10001,gid=10001,mode=0700',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges:true',
  '--pids-limit',
  '128',
  '--memory',
  '512m',
  '--memory-swap',
  '512m',
  '--label',
  'bf.sandbox=security-test',
];

const docker = (args: string[], input?: string) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', input, timeout: 120_000 });
  return { code: result.status ?? 1, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
};
/** A shell command inside a hardened runner container (entrypoint replaced). */
const inSandbox = (script: string, network = 'none') =>
  docker(['run', '--rm', ...HARDENED, '--network', network, '--entrypoint', 'sh', runner, '-c', script]);

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail.slice(0, 300)}` : ''}`);
  if (!ok) failed++;
};

// 1. Identity, filesystem, capabilities.
let r = inSandbox('id -u');
check('runs as uid 10001 (not root)', r.out === '10001', r.out);
r = inSandbox('touch /etc/x 2>&1; touch /usr/local/bin/x 2>&1; echo done');
check(
  'the root filesystem is read-only',
  /Read-only file system/.test(r.out) && !/^done$/m.test(r.out.split('\n')[0] ?? ''),
  r.out,
);
r = inSandbox(
  'printf "#!/bin/sh\\necho pwned\\n" > /workspace/x.sh && chmod +x /workspace/x.sh && /workspace/x.sh',
);
check('the workspace is noexec', r.code !== 0 && !r.out.includes('pwned'), r.out);
r = inSandbox("grep -E '^Cap(Eff|Prm|Bnd):' /proc/self/status");
check(
  'no capabilities (effective, permitted, bounding)',
  /CapEff:\s*0+\b/.test(r.out) && /CapBnd:\s*0+\b/.test(r.out),
  r.out,
);
r = inSandbox('grep NoNewPrivs /proc/self/status');
check('no new privileges', /NoNewPrivs:\s*1/.test(r.out), r.out);
r = inSandbox('ls -l /var/run/docker.sock 2>&1; ls /dev');
check(
  'no Docker socket, no devices beyond the defaults',
  !/srw/.test(r.out) && !/docker\.sock$/m.test(r.out),
  r.out,
);
r = inSandbox('for i in $(seq 1 200); do sleep 5 & done 2>&1; echo spawned');
check(
  'the process limit holds (fork bomb stopped)',
  /Resource temporarily unavailable|can.t fork|Cannot fork/i.test(r.out),
  r.out,
);

// 2. Network: none by default; on the sandbox network only the egress proxy, which refuses non-allowlisted hosts.
r = inSandbox(
  "node -e \"fetch('https://example.com').then(()=>console.log('reached'),e=>console.log('blocked',e.cause?.code))\"",
);
check('no network without a sandbox network', r.out.includes('blocked'), r.out);
docker(['network', 'create', '--internal', sandboxNet]);
docker(['network', 'create', apiNet]);
try {
  docker([
    'run',
    '-d',
    '--name',
    `bf-sec-egress-${suffix}`,
    '--network',
    sandboxNet,
    '--network-alias',
    'egress-proxy',
    '--read-only',
    '--cap-drop',
    'ALL',
    egress,
  ]);
  docker(['network', 'connect', apiNet, `bf-sec-egress-${suffix}`]);
  const viaProxy = (url: string) =>
    inSandbox(
      `HTTPS_PROXY=http://egress-proxy:4750 NODE_USE_ENV_PROXY=1 node -e "fetch('${url}').then(r=>console.log('status',r.status),e=>console.log('blocked',e.cause?.code??e.message))"`,
      sandboxNet,
    );
  r = inSandbox(
    "node -e \"fetch('https://example.com').then(()=>console.log('reached'),e=>console.log('blocked'))\"",
    sandboxNet,
  );
  check('the sandbox network has no direct route out', r.out.includes('blocked'), r.out);
  r = viaProxy('https://example.com');
  check('the egress proxy refuses a host off the allowlist', r.out.includes('blocked'), r.out);
  r = viaProxy('https://169.254.169.254/latest/meta-data/');
  check('the egress proxy refuses IP literals (cloud metadata)', r.out.includes('blocked'), r.out);
  r = viaProxy('https://api.anthropic.com/');
  check(
    'the egress proxy lets an allowlisted model API through (any HTTP answer)',
    /^status \d{3}$/m.test(r.out),
    r.out,
  );
  const logs = docker(['logs', `bf-sec-egress-${suffix}`]);
  check('refusals are logged by the proxy', /egress denied/.test(logs.out), logs.out);
} finally {
  docker(['rm', '-f', `bf-sec-egress-${suffix}`]);
}

// 3. The Docker socket proxy allows the sandbox calls only.
try {
  docker([
    'run',
    '-d',
    '--name',
    `bf-sec-socket-${suffix}`,
    '--network',
    apiNet,
    '--network-alias',
    'docker-socket-proxy',
    '--user',
    '0:0',
    '--read-only',
    '--cap-drop',
    'ALL',
    '-v',
    '/var/run/docker.sock:/var/run/docker.sock:ro',
    socketProxy,
    '-listenip=0.0.0.0',
    '-allowfrom=0.0.0.0/0',
    '-allowGET=^/(v1\\.[0-9]+/)?(_ping|version|containers/json|containers/[a-zA-Z0-9_.-]+/json|images/.+/json)$',
    '-allowPOST=^/(v1\\.[0-9]+/)?containers/(create|[a-zA-Z0-9_.-]+/(attach|start|wait|kill))$',
    '-allowDELETE=^/(v1\\.[0-9]+/)?containers/[a-zA-Z0-9_.-]+$',
  ]);
  const status = (method: string, path: string) =>
    inSandbox(
      `node -e "fetch('http://docker-socket-proxy:2375${path}',{method:'${method}'}).then(r=>console.log(r.status),e=>console.log('error',e.cause?.code))"`,
      apiNet,
    ).out;
  spawnSync('sleep', ['1']);
  check('socket proxy: container listing allowed', status('GET', '/v1.43/containers/json') === '200');
  check('socket proxy: daemon info refused', status('GET', '/v1.43/info') === '403');
  check('socket proxy: volume creation refused', status('POST', '/v1.43/volumes/create') === '403');
  check('socket proxy: exec refused', status('POST', '/v1.43/containers/x/exec') === '403');
  check(
    'socket proxy: image pull refused',
    status('POST', '/v1.43/images/create?fromImage=alpine') === '403',
  );
} finally {
  docker(['rm', '-f', `bf-sec-socket-${suffix}`]);
  docker(['network', 'rm', sandboxNet]);
  docker(['network', 'rm', apiNet]);
}

if (failed) {
  console.error(`sandbox security: ${failed} check(s) FAILED`);
  process.exit(1);
}
console.log('sandbox security: all checks passed');
