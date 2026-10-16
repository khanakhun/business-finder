// Pure helpers for scripts/infra.mjs: port allocation, project naming and derived connection URLs.
// Kept free of I/O so they can be unit-tested (stack.test.mjs).

/** Host ports at BF_PORT_OFFSET=0. Infra ports feed docker-compose.yml; app ports feed `pnpm dev`. */
export const BASE_PORTS = Object.freeze({
  BF_PG_PORT: 5432,
  BF_VALKEY_PORT: 6379,
  BF_S3_PORT: 9000,
  BF_S3_CONSOLE_PORT: 9001,
  BF_SMTP_PORT: 1025,
  BF_MAILPIT_UI_PORT: 8025,
  BF_SCRAPER_PORT: 8080,
  BF_REACHER_PORT: 8081,
  BF_JAEGER_UI_PORT: 16686,
  BF_OTLP_GRPC_PORT: 4317,
  BF_OTLP_HTTP_PORT: 4318,
  WEB_PORT: 3000,
  SITES_PORT: 3100,
  API_PORT: 4000,
  INTEL_PORT: 8000,
  WORKER_METRICS_PORT: 9464,
});

/** Compose services that publish each infra port; app ports have no service. */
export const PORT_SERVICES = Object.freeze({
  BF_PG_PORT: 'postgres',
  BF_VALKEY_PORT: 'valkey',
  BF_S3_PORT: 's3',
  BF_S3_CONSOLE_PORT: 's3',
  BF_SMTP_PORT: 'mailpit',
  BF_MAILPIT_UI_PORT: 'mailpit',
  BF_SCRAPER_PORT: 'gmaps-scraper',
  BF_REACHER_PORT: 'reacher',
  BF_JAEGER_UI_PORT: 'jaeger',
  BF_OTLP_GRPC_PORT: 'otel-collector',
  BF_OTLP_HTTP_PORT: 'otel-collector',
  // Profile `apps` runs services/intel in a container; without it, `pnpm --filter @bf/intel dev` uses the port.
  INTEL_PORT: 'intel',
  // Profile `sites` runs apps/sites' image; without it, `pnpm --filter @bf/sites dev` uses the port.
  SITES_PORT: 'sites',
});

export const DEFAULT_SERVICES = Object.freeze(['postgres', 'valkey', 's3', 's3-init', 'mailpit']);

export const PROFILE_SERVICES = Object.freeze({
  scraper: ['gmaps-scraper'],
  verify: ['reacher'],
  observability: ['otel-collector', 'jaeger'],
  apps: ['intel'],
  sites: ['sites'],
});

export const MAX_OFFSET = 70;

/** Parses BF_PORT_OFFSET: a multiple of 10 in [0, 70], so stacks never share a port. */
export function parseOffset(raw) {
  if (raw === undefined || raw === '') return 0;
  const offset = Number(raw);
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET || offset % 10 !== 0) {
    throw new Error(`BF_PORT_OFFSET must be a multiple of 10 between 0 and ${MAX_OFFSET}, got "${raw}"`);
  }
  return offset;
}

/** Docker Compose project names: lowercase letters, digits, dashes and underscores, starting alphanumeric. */
export function parseProjectName(raw) {
  const name = raw === undefined || raw === '' ? 'bf' : raw;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new Error(`COMPOSE_PROJECT_NAME must match [a-z0-9][a-z0-9_-]* (lowercase), got "${name}"`);
  }
  return name;
}

/** @returns {Record<keyof typeof BASE_PORTS, number>} */
export function computePorts(offset) {
  return Object.fromEntries(Object.entries(BASE_PORTS).map(([key, port]) => [key, port + offset]));
}

/** Services started by `up` for the given profiles (unknown profiles are rejected). */
export function servicesFor(profiles) {
  const services = [...DEFAULT_SERVICES];
  for (const profile of profiles) {
    const extra = PROFILE_SERVICES[profile];
    if (!extra) {
      throw new Error(`Unknown profile "${profile}". Available: ${Object.keys(PROFILE_SERVICES).join(', ')}`);
    }
    services.push(...extra);
  }
  return services;
}

/** Host ports `up` will bind for the given services. */
export function portsFor(services, ports) {
  return Object.entries(PORT_SERVICES)
    .filter(([, service]) => services.includes(service))
    .map(([key, service]) => ({ key, service, port: ports[key] }));
}

/**
 * Connection settings derived from the ports and credentials, written to `.env.generated` and read by
 * `@bf/config` (`loadEnv` gives it precedence over `.env`).
 */
export function derivedEnv({ ports, env, projectName, offset, profiles = [] }) {
  // Fallbacks match the defaults in infra/compose/docker-compose.yml.
  const pgUser = env.POSTGRES_USER || 'bf';
  const pgPassword = env.POSTGRES_PASSWORD || 'bf_local_only';
  const pgDb = env.POSTGRES_DB || 'bf';
  const roPassword = env.BF_SITES_RO_PASSWORD || 'bf_sites_ro_local_only';
  const enc = encodeURIComponent;
  return {
    COMPOSE_PROJECT_NAME: projectName,
    BF_PORT_OFFSET: String(offset),
    ...Object.fromEntries(Object.entries(ports).map(([key, port]) => [key, String(port)])),
    DATABASE_URL: `postgres://${enc(pgUser)}:${enc(pgPassword)}@127.0.0.1:${ports.BF_PG_PORT}/${enc(pgDb)}`,
    SITES_DATABASE_URL: `postgres://bf_sites_ro:${enc(roPassword)}@127.0.0.1:${ports.BF_PG_PORT}/${enc(pgDb)}`,
    VALKEY_URL: `redis://127.0.0.1:${ports.BF_VALKEY_PORT}`,
    S3_ENDPOINT: `http://127.0.0.1:${ports.BF_S3_PORT}`,
    // Credentials of the local S3 container, so apps need no manual setup to reach it.
    S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID || 'bf_local_only',
    S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY || 'bf_local_only_secret',
    SMTP_URL: `smtp://127.0.0.1:${ports.BF_SMTP_PORT}`,
    // Only when the collector runs; otherwise apps would retry exporting to a closed port.
    ...(profiles.includes('observability')
      ? { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${ports.BF_OTLP_HTTP_PORT}` }
      : {}),
    APP_URL: `http://localhost:${ports.WEB_PORT}`,
    API_URL: `http://localhost:${ports.API_PORT}`,
    INTEL_URL: `http://127.0.0.1:${ports.INTEL_PORT}`,
    // The site renderer (BF-036), which the API asks to refresh after publication changes.
    SITES_INTERNAL_URL: `http://127.0.0.1:${ports.SITES_PORT}`,
    NEXT_PUBLIC_APP_URL: `http://localhost:${ports.WEB_PORT}`,
    NEXT_PUBLIC_API_URL: `http://localhost:${ports.API_PORT}`,
    // The site editor's image uploads (presigned PUTs from the browser, BF-037).
    NEXT_PUBLIC_SITES_UPLOADS_URL: `http://127.0.0.1:${ports.BF_S3_PORT}`,
  };
}

/**
 * Serialises env vars as a dotenv file. Dotenv has no escape sequences, so a value is wrapped in the first
 * quote character it does not contain; values that cannot be represented are rejected.
 */
export function toDotenv(vars, header) {
  const lines = header ? header.split('\n').map((line) => `# ${line}`) : [];
  for (const [key, value] of Object.entries(vars)) {
    lines.push(`${key}=${quoteDotenv(key, value)}`);
  }
  return `${lines.join('\n')}\n`;
}

function quoteDotenv(key, value) {
  if (/^[\w.:/@%+-]*$/.test(value)) return value;
  const quote = [`'`, '"', '`'].find((q) => !value.includes(q));
  if (!quote || /[\r\n]/.test(value)) {
    throw new Error(`${key} contains characters that cannot be written to a dotenv file`);
  }
  return `${quote}${value}${quote}`;
}
