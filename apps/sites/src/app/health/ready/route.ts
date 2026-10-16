import { databaseReady } from '@/lib/tenant.ts';

/** The renderer can serve: its read-only database answers (the container's health check). */
export async function GET(): Promise<Response> {
  const ready = await databaseReady();
  return Response.json(
    { status: ready ? 'ok' : 'unavailable' },
    {
      status: ready ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}
