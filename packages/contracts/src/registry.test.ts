import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { expectedFiles } from './cli/jsonschema.ts';
import { buildJsonSchemas, exportSchema, sortKeys } from './registry.ts';

describe('JSON Schema export', () => {
  it('is deterministic', () => {
    expect(JSON.stringify(buildJsonSchemas('python'))).toBe(JSON.stringify(buildJsonSchemas('python')));
    expect([...expectedFiles().keys()]).toEqual([
      'jsonschema/python/EchoRequest.json',
      'jsonschema/python/EchoResponse.json',
      'jsonschema/python/ImageFetchRequest.json',
      'jsonschema/python/LatLng.json',
      'jsonschema/python/OpenDataPlace.json',
      'jsonschema/python/OpenDataSearchRequest.json',
      'jsonschema/python/OpenDataSearchResponse.json',
      'jsonschema/python/ProblemDetails.json',
      'jsonschema/python/SiteIntel.json',
      'jsonschema/python/SiteIntelRequest.json',
      'error-codes.json',
      'no-solicitation-phrases.json',
    ]);
  });

  it('emits draft 2020-12 documents with $id, title and description', () => {
    expect(buildJsonSchemas('python').LatLng).toMatchInlineSnapshot(`
      {
        "$id": "https://schemas.business-finder.dev/LatLng.json",
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false,
        "description": "WGS84 coordinates in decimal degrees.",
        "properties": {
          "lat": {
            "maximum": 90,
            "minimum": -90,
            "type": "number",
          },
          "lng": {
            "maximum": 180,
            "minimum": -180,
            "type": "number",
          },
        },
        "required": [
          "lat",
          "lng",
        ],
        "title": "LatLng",
        "type": "object",
      }
    `);
  });

  it('sorts keys recursively', () => {
    expect(JSON.stringify(sortKeys({ b: 1, a: [{ d: 1, c: 2 }] }))).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });

  it('rejects bad and duplicate ids', () => {
    expect(() => exportSchema(z.string(), { id: 'lowercase', exportTo: ['python'] })).toThrow(/PascalCase/);
    expect(() => exportSchema(z.string(), { id: 'LatLng', exportTo: ['python'] })).toThrow(/already used/);
  });
});
