import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateOpenApi, OPENAPI_FILE } from './openapi.ts';

// Runs with no env and no infrastructure, like `pnpm api:openapi` in CI.
describe('OpenAPI document', async () => {
  const json = await generateOpenApi();
  const document = JSON.parse(json);

  it('is OpenAPI 3.1 with the system routes and shared components', () => {
    expect(document.openapi).toBe('3.1.0');
    expect(document.paths['/v1/system/info'].get).toMatchObject({
      operationId: 'getSystemInfo',
      tags: ['system'],
      responses: {
        200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/SystemInfo' } } } },
        500: {
          content: {
            'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
          },
        },
      },
    });
    expect(Object.keys(document.components.schemas)).toEqual(
      expect.arrayContaining(['ProblemDetails', 'SystemInfo']),
    );
  });

  it('keeps operational endpoints out of the public API', () => {
    expect(
      Object.keys(document.paths).filter((p) => p.startsWith('/health') || p.startsWith('/metrics')),
    ).toEqual([]);
  });

  it('matches the committed packages/api-client/openapi.json (run `pnpm api:openapi`)', () => {
    expect(readFileSync(OPENAPI_FILE, 'utf8')).toBe(json);
  });
});
