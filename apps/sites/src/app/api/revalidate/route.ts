import { readCappedText } from '@/lib/capped-body.ts';
import { sitesEnvironment } from '@/lib/env.ts';
import { REVALIDATE_PATH, revalidate, revalidateNonces } from '@/lib/revalidate.ts';
import { invalidateTenants } from '@/lib/tenant.ts';

// DECISION(BF-036): replays are refused per process; with several renderer replicas, a captured call could be
// replayed once to another replica within the skew window, whose only effect is a cache reload.
const nonces = revalidateNonces();
/** The API sends at most 20 tags: a few hundred bytes. */
const MAX_BODY_BYTES = 8 * 1024;
const AUTHORIZATION = /^Bearer \d{1,12}\.[A-Za-z0-9_-]{16,64}\.[0-9a-f]{64}$/;
const noStore = { 'Cache-Control': 'no-store' };

/** The API's signed revalidation (BF-035): drops the cached tenants of the given tags. */
export async function POST(request: Request): Promise<Response> {
  const authorization = request.headers.get('authorization');
  // Nothing is read before the request looks signed, and never more than a small body.
  if (!authorization || !AUTHORIZATION.test(authorization))
    return Response.json({ error: 'unauthorized' }, { status: 401, headers: noStore });
  const body = await readCappedText(request, MAX_BODY_BYTES);
  if (body === undefined) return Response.json({ error: 'too large' }, { status: 413, headers: noStore });
  const result = await revalidate(
    { authorization, path: REVALIDATE_PATH, body },
    { secret: sitesEnvironment().SITES_REVALIDATE_SECRET, nonces, invalidate: invalidateTenants },
  );
  return Response.json(result.body, { status: result.status, headers: noStore });
}
