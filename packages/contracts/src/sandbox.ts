import { z } from 'zod';

// Sandboxes (BF-043): how a run is sized and isolated, whatever runs it (the Docker provider today). The failover
// policy (BF-039) reads the typed error codes.

export const EGRESS_PROFILES = ['none', 'models', 'models_assets'] as const;
export const EgressProfileSchema = z.enum(EGRESS_PROFILES);
export type EgressProfile = z.infer<typeof EgressProfileSchema>;

export const SandboxRunSpecSchema = z
  .object({
    /** The runner image, pinned by digest (`ghcr.io/…/agent-runner@sha256:…`). */
    image: z.string().regex(/^[a-z0-9./_:-]+@sha256:[0-9a-f]{64}$|^[a-z0-9./_-]+:[A-Za-z0-9._-]+$/),
    cpus: z.number().positive().max(16),
    memoryMb: z.number().int().min(256).max(32_768),
    pidsLimit: z.number().int().min(64).max(4096),
    tmpfsMb: z.object({
      workspace: z.number().int().min(16).max(8192),
      tmp: z.number().int().min(16).max(4096),
      home: z.number().int().min(16).max(2048),
    }),
    wallTimeSec: z
      .number()
      .int()
      .min(10)
      .max(4 * 3600),
    egressProfile: EgressProfileSchema,
    labels: z.record(z.string().regex(/^bf\.[a-z.]{1,40}$/), z.string().max(200)),
  })
  .meta({ id: 'SandboxRunSpec' });
export type SandboxRunSpec = z.infer<typeof SandboxRunSpecSchema>;

export const SANDBOX_ERROR_CODES = [
  'SANDBOX_OOM',
  'SANDBOX_TIMEOUT',
  'SANDBOX_CRASH',
  'SANDBOX_PROTOCOL_ERROR',
  'SANDBOX_UNAVAILABLE',
] as const;
export type SandboxErrorCode = (typeof SANDBOX_ERROR_CODES)[number];
