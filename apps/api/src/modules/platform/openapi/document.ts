import { sortKeys } from '@bf/contracts/registry';
import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { componentSchemas } from './schema-registry.ts';

/** OpenAPI 3.1 document: routes from Nest metadata, schemas from Zod (JSON Schema 2020-12 is native in 3.1). */
export function buildOpenApiDocument(app: INestApplication, version: string): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Business Finder API')
    .setDescription('REST API (/v1). Errors are RFC 9457 problem+json; see docs/conventions/api.md.')
    .setVersion(version)
    // Session cookie set by Better Auth (/api/auth/*), or an organization API key.
    .addCookieAuth('bf.session_token', { type: 'apiKey', in: 'cookie' }, 'session')
    .addBearerAuth({ type: 'http', scheme: 'bearer', description: 'Organization API key (bf_…)' }, 'apiKey')
    .addSecurityRequirements('session')
    .addSecurityRequirements('apiKey')
    .build();
  const document = SwaggerModule.createDocument(app, config, {
    operationIdFactory: (controllerKey, methodKey) =>
      `${controllerKey.replace(/Controller$/, '')}_${methodKey}`,
  });
  document.openapi = '3.1.0';
  document.components = {
    ...document.components,
    schemas: { ...document.components?.schemas, ...componentSchemas() },
  };
  return sortKeys(document) as OpenAPIObject;
}
