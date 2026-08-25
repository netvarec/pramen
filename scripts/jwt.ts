// Mint HS256 JWTs for the smoke tests. Delegates to @pramen/server's signer so the repo
// has ONE implementation — the tests, the `pramen` bin and the `pramen-cms` bin all share
// it. The explicit DEV_SECRET argument preserves this helper's deliberate behaviour of
// always using the wrangler dev secret, ignoring any AUTH_SECRET in the environment.

import { signDevToken, DEV_SECRET } from "@pramen/server/dev";

export { DEV_SECRET };

export const sign = (payload: Record<string, unknown>, secret = DEV_SECRET): Promise<string> => signDevToken(payload, secret);

/** A signed token for the given subject and roles, plus any extra claims
 * (e.g. `{ tenants: ["acme"] }` for tenant authorization). */
export const token = (sub: string, roles: string[], extra: Record<string, unknown> = {}): Promise<string> =>
  sign({ sub, roles, ...extra });
