import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseEnv } from 'node:util';
import {
  BASE_PORTS,
  computePorts,
  DEFAULT_SERVICES,
  derivedEnv,
  MAX_OFFSET,
  PROFILE_SERVICES,
  parseOffset,
  parseProjectName,
  portsFor,
  servicesFor,
  toDotenv,
} from './stack.mjs';

describe('parseOffset', () => {
  it('defaults to 0', () => {
    assert.equal(parseOffset(undefined), 0);
    assert.equal(parseOffset(''), 0);
  });

  it('accepts multiples of 10 up to the maximum', () => {
    for (let o = 0; o <= MAX_OFFSET; o += 10) assert.equal(parseOffset(String(o)), o);
  });

  it('rejects anything else', () => {
    for (const bad of ['5', '-10', '80', '1e1x', 'abc', '10.5']) {
      assert.throws(() => parseOffset(bad), /BF_PORT_OFFSET/, bad);
    }
  });
});

describe('parseProjectName', () => {
  it('defaults to bf', () => assert.equal(parseProjectName(undefined), 'bf'));
  it('accepts compose-safe names', () => assert.equal(parseProjectName('bf_033-a'), 'bf_033-a'));
  it('rejects names compose would refuse', () => {
    for (const bad of ['BF', '-bf', 'bf 2', 'bf.2'])
      assert.throws(() => parseProjectName(bad), /COMPOSE_PROJECT_NAME/);
  });
});

describe('computePorts', () => {
  it('returns the base ports at offset 0', () => {
    assert.deepEqual(computePorts(0), BASE_PORTS);
  });

  it('shifts every port by the offset', () => {
    const ports = computePorts(10);
    assert.equal(ports.BF_PG_PORT, 5442);
    assert.equal(ports.WEB_PORT, 3010);
    assert.equal(ports.SITES_PORT, 3110);
    assert.equal(ports.API_PORT, 4010);
  });

  it('never assigns the same port twice across any two stacks', () => {
    const owner = new Map();
    for (let offset = 0; offset <= MAX_OFFSET; offset += 10) {
      for (const [key, port] of Object.entries(computePorts(offset))) {
        assert.ok(!owner.has(port), `port ${port} used by ${owner.get(port)} and ${key}@${offset}`);
        owner.set(port, `${key}@${offset}`);
      }
    }
  });
});

describe('servicesFor / portsFor', () => {
  it('starts the default services without profiles', () => {
    assert.deepEqual(servicesFor([]), DEFAULT_SERVICES);
  });

  it('adds profile services', () => {
    assert.deepEqual(servicesFor(['apps']).slice(-1), ['intel']);
    assert.deepEqual(servicesFor(['sites']).slice(-1), ['sites']);
    const services = servicesFor(['scraper', 'observability']);
    assert.ok(services.includes('gmaps-scraper'));
    assert.ok(services.includes('jaeger'));
    assert.ok(!services.includes('reacher'));
  });

  it('rejects unknown profiles', () => {
    assert.throws(() => servicesFor(['nope']), /Unknown profile "nope"/);
  });

  it('only checks ports of services that will start', () => {
    const keys = portsFor(servicesFor([]), computePorts(0)).map((p) => p.key);
    assert.ok(keys.includes('BF_PG_PORT'));
    assert.ok(!keys.includes('BF_SCRAPER_PORT'));
    assert.ok(!keys.includes('WEB_PORT'), 'app ports are not bound by compose');
  });
});

describe('derivedEnv', () => {
  it('points sandboxes at the stack network and the egress proxy with the generation profile (BF-043)', () => {
    const plain = derivedEnv({ ports: computePorts(0), env: {}, projectName: 'bf', offset: 0 });
    assert.equal(plain.SANDBOX_NETWORK, undefined);
    const withGeneration = derivedEnv({
      ports: computePorts(0),
      env: {},
      projectName: 'bf_x',
      offset: 0,
      profiles: ['generation'],
    });
    assert.equal(withGeneration.SANDBOX_NETWORK, 'bf_x-sandbox');
    assert.equal(withGeneration.SANDBOX_EGRESS_PROXY_URL, 'http://egress-proxy:4750');
  });

  const env = derivedEnv({ ports: computePorts(20), env: {}, projectName: 'bf_x', offset: 20 });

  it('builds connection URLs from the offset ports', () => {
    assert.equal(env.DATABASE_URL, 'postgres://bf:bf_local_only@127.0.0.1:5452/bf');
    assert.equal(env.VALKEY_URL, 'redis://127.0.0.1:6399');
    assert.equal(env.S3_ENDPOINT, 'http://127.0.0.1:9020');
    assert.equal(env.SMTP_URL, 'smtp://127.0.0.1:1045');
    assert.equal(env.API_URL, 'http://localhost:4020');
    assert.equal(env.SITES_INTERNAL_URL, 'http://127.0.0.1:3120');
  });

  it('exports app ports and the project identity', () => {
    assert.equal(env.WEB_PORT, '3020');
    assert.equal(env.INTEL_PORT, '8020');
    assert.equal(env.COMPOSE_PROJECT_NAME, 'bf_x');
    assert.equal(env.BF_PORT_OFFSET, '20');
  });

  it('points apps at the OTLP collector only when the observability profile runs', () => {
    assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
    const withCollector = derivedEnv({
      ports: computePorts(20),
      env: {},
      projectName: 'bf',
      offset: 20,
      profiles: ['observability'],
    });
    assert.equal(withCollector.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://127.0.0.1:4338');
  });

  it('URL-encodes credentials', () => {
    const custom = derivedEnv({
      ports: computePorts(0),
      env: { POSTGRES_PASSWORD: 'p@ss/w:rd', POSTGRES_USER: 'u', POSTGRES_DB: 'd' },
      projectName: 'bf',
      offset: 0,
    });
    assert.equal(custom.DATABASE_URL, 'postgres://u:p%40ss%2Fw%3Ard@127.0.0.1:5432/d');
  });
});

describe('toDotenv', () => {
  it('round-trips through Node’s dotenv parser, including values that need quoting', () => {
    const vars = {
      A: 'plain',
      B: 'has space',
      C: 'quote"s',
      D: "it's",
      F: `both ' and "`,
      G: 'postgres://u:p%40@h:1/d',
      E: '',
    };
    assert.deepEqual({ ...parseEnv(toDotenv(vars, 'generated\nby test')) }, vars);
  });

  it('rejects values dotenv cannot represent', () => {
    assert.throws(() => toDotenv({ X: `' " \`` }), /X contains/);
    assert.throws(() => toDotenv({ X: 'a\nb' }), /X contains/);
  });

  it('prefixes the header as comments', () => {
    assert.match(toDotenv({ A: '1' }, 'line one\nline two'), /^# line one\n# line two\nA=1\n$/);
  });
});

describe('contract with @bf/config', async () => {
  // Node strips types from these .ts files (they are outside node_modules).
  const { GENERATED_BY_INFRA } = await import('../../packages/config/src/cli/render.ts');
  const { APP_SCHEMAS } = await import('../../packages/config/src/registry.ts');
  const declared = new Set(Object.values(APP_SCHEMAS).flatMap((schema) => Object.keys(schema.shape)));
  const generated = derivedEnv({
    ports: computePorts(0),
    env: {},
    projectName: 'bf',
    offset: 0,
    profiles: Object.keys(PROFILE_SERVICES),
  });
  // Read only by scripts/infra.mjs and docker compose, never by apps.
  const infraOnly = (name) => /^BF_/.test(name) || name === 'COMPOSE_PROJECT_NAME';

  it('every app variable written to .env.generated is declared in an app schema', () => {
    const undeclared = Object.keys(generated).filter((name) => !infraOnly(name) && !declared.has(name));
    assert.deepEqual(undeclared, []);
  });

  it('GENERATED_BY_INFRA lists exactly what infra:up writes', () => {
    const appVars = Object.keys(generated).filter((name) => !infraOnly(name));
    assert.deepEqual(new Set(appVars), GENERATED_BY_INFRA);
  });
});
