import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import helmet from 'helmet';
import type { AppEnv } from './modules/platform/config/app-env.ts';

/** HTTP-level setup shared by main.ts, openapi.ts and tests, so they all see the same routes. */
export function configureHttp(app: INestApplication, env: AppEnv): void {
  app.setGlobalPrefix('v1', {
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
      { path: 'metrics', method: RequestMethod.GET },
    ],
  });
  app.use(helmet());
  app.enableCors({ origin: [env.APP_URL], credentials: true });
}
