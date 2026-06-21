// The entire server entry for a pramen project: hand your app to createPramen and
// re-export the pair. oblaka.ts points `main` here; wrangler binds PramenDO by name.
// This is exactly what `pramen init` scaffolds.

import { createPramen } from "@pramen/server/worker";
import { app } from "./app";

const pramen = createPramen(app);

export default { fetch: pramen.fetch };
export const PramenDO = pramen.PramenDO;
