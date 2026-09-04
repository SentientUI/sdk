import type { ActionFunctionArgs } from "@remix-run/node";
import { Prisma } from "@prisma/client";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
    const { payload, session, topic, shop } = await authenticate.webhook(request);
    console.log(`Received ${topic} webhook for ${shop}`);

    // Shape check at the webhook boundary, same policy as forward.ts. This was
    // `payload.current as string[]` — an unchecked cast — so a reshaped field
    // in a newer payload version TypeError'd into a 500 and 48h of retries
    // that could never succeed. Malformed → ack and log; the next OAuth round
    // trip rewrites the scope anyway.
    const current = (payload as { current?: unknown }).current;
    if (!Array.isArray(current) || !current.every((s) => typeof s === "string")) {
        console.error(`[sentient] ignoring ${topic} for ${shop}: payload.current is not a string array`);
        return new Response();
    }
    if (session) {
        try {
            await db.session.update({
                where: {
                    id: session.id
                },
                data: {
                    scope: current.toString(),
                },
            });
        } catch (err) {
            // A concurrent app/uninstalled deletes the Session row between
            // authenticate.webhook loading it and this update (P2025). The
            // scope of a gone install is moot — ack rather than 500 into
            // retries against a row that will never come back.
            if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025")) throw err;
            console.log(`[sentient] session for ${shop} deleted before ${topic} landed — uninstalled concurrently`);
        }
    }
    return new Response();
};
