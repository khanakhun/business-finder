import type { Instrumentation } from 'next';
import { errorFields, log } from './lib/log.ts';

/** Every server error as one structured line (host, path, the digest the visitor's error page shows). */
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  const host = Array.isArray(request.headers.host) ? request.headers.host[0] : request.headers.host;
  log('error', 'request failed', {
    host,
    path: request.path,
    method: request.method,
    route: context.routePath,
    digest: (error as { digest?: string }).digest,
    ...errorFields(error),
  });
};
