import { z } from 'zod';
import { IsoDateTimeSchema } from './time.ts';

// Shapes of services/intel endpoints (ADR-0002). Exported to JSON Schema and generated into Pydantic models
// (`pnpm contracts:py`), so the TypeScript caller and the Python service cannot drift.

/** `POST /v1/echo` on services/intel: proves signing and the contracts codegen path end to end (BF-008). */
export const EchoRequestSchema = z.object({
  message: z.string().min(1).max(2_000).describe('Text echoed back unchanged.'),
});
export type EchoRequest = z.infer<typeof EchoRequestSchema>;

export const EchoResponseSchema = z.object({
  message: z.string().describe('The request message.'),
  receivedAt: IsoDateTimeSchema.describe('When the service handled the request (UTC).'),
});
export type EchoResponse = z.infer<typeof EchoResponseSchema>;
