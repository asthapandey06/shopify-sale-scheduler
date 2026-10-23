import prisma from "../db.server";

/** Liveness/readiness probe for the host. Reveals nothing beyond up/down. */
export const loader = async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
};
