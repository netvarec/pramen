// The LOCAL server entry: the example app plus the dev-account seed (`devUserBootstrap`).
// `oblaka.ts` points the `local` env's `main` here and every other env at `worker.ts`, so
// the seed (a known username with a known password, holding admin) is never registered by
// the code a deploy ships, whatever vars that deploy carries.

import { createPramen } from "@pramen/server/worker";
import { app, devUserBootstrap } from "./app";

const pramen = createPramen({ ...app, bootstrap: [...app.bootstrap, devUserBootstrap] });

export default { fetch: pramen.fetch, scheduled: pramen.scheduled, queue: pramen.queue };
export const PramenDO = pramen.PramenDO;
