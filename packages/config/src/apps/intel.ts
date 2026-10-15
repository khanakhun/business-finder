import { z } from 'zod';
import { coreEnv } from '../fragments/core.ts';
import { intelEnv as intelClientEnv } from '../fragments/intel.ts';
import { s3Env } from '../fragments/s3.ts';
import { booleanFlag, port } from '../schema.ts';

/**
 * services/intel (Python) reads these through pydantic-settings (services/intel/app/settings.py, BF-008).
 * Declared here so every variable has one documented source of truth; a Python test fails if the settings
 * model and `.env.example` (generated from this schema) disagree.
 */
export const intelServiceEnv = z.object({
  NODE_ENV: coreEnv.shape.NODE_ENV,
  LOG_LEVEL: coreEnv.shape.LOG_LEVEL,
  APP_VERSION: coreEnv.shape.APP_VERSION,
  OTEL_EXPORTER_OTLP_ENDPOINT: coreEnv.shape.OTEL_EXPORTER_OTLP_ENDPOINT,
  INTEL_SHARED_SECRET: intelClientEnv.shape.INTEL_SHARED_SECRET,
  ...s3Env.shape,
  INTEL_HOST: z
    .string()
    .min(1)
    .default('127.0.0.1')
    .describe('Interface services/intel binds to (0.0.0.0 inside its container).'),
  INTEL_PORT: port(8000).describe('HTTP port of services/intel. Set by infra:up from BF_PORT_OFFSET.'),
  INTEL_WORKERS: z.coerce
    .number()
    .int()
    .min(1)
    .max(32)
    .default(1)
    .describe('Uvicorn worker processes. Prefer more replicas: metrics and the nonce cache are per process.'),
  INTEL_CPU_WORKERS: z.coerce
    .number()
    .int()
    .min(1)
    .max(64)
    .optional()
    .describe('Process-pool size for CPU-bound work (default: CPU count).'),
  INTEL_MAX_REQUEST_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(1_048_576)
    .describe('Largest request body accepted on /v1, checked before authentication (bytes).'),
  INTEL_FETCH_TIMEOUT_SECONDS: z.coerce
    .number()
    .positive()
    .max(300)
    .default(20)
    .describe('Total time budget of one safe_fetch call, redirects included.'),
  INTEL_FETCH_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10_485_760)
    .describe('Largest response body safe_fetch accepts after decompression (bytes).'),
  OPEN_DATA_CACHE_DIR: z
    .string()
    .min(1)
    .default('.cache/open-data')
    .describe('Local directory for regional open-data extracts (BF-019), relative to services/intel.'),
  OPEN_DATA_OBJECT_CACHE: booleanFlag(false).describe(
    'Also keep regional extracts in the artifacts bucket (open-data/…), shared by intel replicas.',
  ),
  OPEN_DATA_EXTENSION_DIR: z
    .string()
    .min(1)
    .optional()
    .describe('DuckDB extension directory (the image pre-installs httpfs there); DuckDB default when unset.'),
  OPEN_DATA_CACHE_MAX_MB: z.coerce
    .number()
    .int()
    .min(100)
    .max(1_000_000)
    .default(5_120)
    .describe('Size cap of the local extract cache (least recently used extracts are evicted).'),
  OPEN_DATA_QUERY_TIMEOUT_SECONDS: z.coerce
    .number()
    .positive()
    .max(600)
    .default(120)
    .describe('Time budget of one open-data query (a first extract downloads from the dataset bucket).'),
  OPEN_DATA_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(MB|GB)$/)
    .default('1GB')
    .describe('DuckDB memory limit per open-data query.'),
  OVERTURE_RELEASE: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}\.\d{1,3}$/)
    .optional()
    .describe('Pinned Overture release (e.g. 2026-09-23.1); the latest from the STAC catalog when unset.'),
  OVERTURE_STAC_URL: z
    .url()
    .default('https://stac.overturemaps.org/catalog.json')
    .describe('Overture STAC root (its `latest` key names the current release).'),
  OVERTURE_SOURCE_URL: z
    .string()
    .min(1)
    .default('s3://overturemaps-us-west-2/release/{release}/theme=places/type=place/*.parquet')
    .describe('Overture places parquet glob ({release} is substituted). Anonymous S3, us-west-2.'),
  FOURSQUARE_RELEASE: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .default('2026-09-15')
    .describe('Foursquare OS Places release directory (dt=…) on Hugging Face.'),
  FOURSQUARE_SOURCE_URL: z
    .string()
    .min(1)
    .default('hf://datasets/foursquare/fsq-os-places/release/dt={release}/places/parquet/*.parquet')
    .describe(
      'Foursquare OS Places parquet glob ({release} substituted); gated, needs a Hugging Face token.',
    ),
});
export type IntelServiceEnv = z.output<typeof intelServiceEnv>;
