import db from "../db.server";

// Liveness/readiness probe for the Fly health check.
//
// There was none, so a wedged process (event loop blocked, Prisma client dead,
// database unreachable) stayed in rotation serving errors until someone
// noticed. The DB round trip is the part that matters: this app's whole job is
// reading per-shop keys, and a process that cannot do that is not healthy
// however well it answers HTTP. It is also what gates a rolling deploy now that
// more than one machine runs.
export const loader = async () => {
  try {
    await db.$queryRaw`SELECT 1`;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch {
    return new Response(JSON.stringify({ ok: false }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
};
