// Readiness for the container healthcheck and the deploy gate (BF-025): the server is up and rendering. The API's
// own readiness covers the database and Valkey.
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
}
