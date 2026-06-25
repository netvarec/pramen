// The entire server entry for a pramen project: hand your app to createPramen and
// re-export the pair. oblaka.ts points `main` here; wrangler binds PramenDO by name.
// This is exactly what `pramen init` scaffolds.

import { createPramen } from "@pramen/server/worker";
import { app } from "./app";

const pramen = createPramen(app);

// `scheduled` drains the D1-store task outbox on a Cron Trigger (the DO store
// self-drains via an alarm and needs no cron). `queue` is the Cloudflare Queues
// consumer entry — it routes a batch to the matching `app.queues` handler.
export default { fetch: pramen.fetch, scheduled: pramen.scheduled, queue: pramen.queue };
export const PramenDO = pramen.PramenDO;
