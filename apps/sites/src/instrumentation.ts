import type { Instrumentation } from 'next';
import { errorFields, log } from './lib/log.ts';

/** Every server error as one structured line (host, path without query, the digest the visitor's error page shows). */
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  const host = Array.isArray(request.headers.host) ? request.headers.host[0] : request.headers.host;
  log('error', 'request failed', {
    host,
    // The path only: a query can carry an e-mail's signed outreach reference (`?r=`), never logged.
    path: request.path.split('?')[0],
    method: request.method,
    route: context.routePath,
    digest: (error as { digest?: string }).digest,
    ...errorFields(error),
  });
};
