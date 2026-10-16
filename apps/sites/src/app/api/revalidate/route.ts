import { sitesEnvironment } from '@/lib/env.ts';
import { REVALIDATE_PATH, revalidate, revalidateNonces } from '@/lib/revalidate.ts';
import { invalidateTenants } from '@/lib/tenant.ts';

const nonces = revalidateNonces();

/** The API's signed revalidation (BF-035): drops the cached tenants of the given tags. */
export async function POST(request: Request): Promise<Response> {
  const result = await revalidate(
    {
      authorization: request.headers.get('authorization'),
      path: REVALIDATE_PATH,
      body: await request.text(),
    },
    { secret: sitesEnvironment().SITES_REVALIDATE_SECRET, nonces, invalidate: invalidateTenants },
  );
  return Response.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
}
