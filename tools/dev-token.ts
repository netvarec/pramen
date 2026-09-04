// A dev bearer token for the example CMS editor.
//
//   bun tools/dev-token.ts            # admin+editor, valid 24h
//   bun tools/dev-token.ts reviewer   # any roles, space- or comma-separated
//
// The example app deliberately seeds no user — `signup` hands out the `user` role, which the
// CMS handlers do not accept, so there is nothing to log in AS on a fresh store. The editor's
// Setup screen asks for a token and nothing else, and the worker verifies it with plain HS256
// against AUTH_SECRET. So the honest dev answer is to mint one rather than to add a seeded
// account nobody wants in a store they might deploy.
//
// LOCAL ONLY. `dev-secret-change-me` is the value in `wrangler.jsonc` for `bun run dev`; a
// real deployment sets AUTH_SECRET with `wrangler secret put`, and a token signed with this
// one is worthless against it. Do not paste the output anywhere but a local Setup screen.

const SECRET = process.env.AUTH_SECRET ?? "dev-secret-change-me";
const TTL_SECONDS = 24 * 60 * 60;

const roles = (process.argv.slice(2).join(" ").split(/[\s,]+/).filter(Boolean));

/** The two objects a JWT is made of. Named rather than `unknown`, because they are both
 * written right here — there is no external input in this script to parse. */
interface JwtHeader {
  alg: "HS256";
  typ: "JWT";
}
interface JwtClaims {
  /** The JWT subject — what the ACL sees as `$identity("userId")`. */
  sub: string;
  /** What `cmsPolicies()` and every `auth:` gate match on. */
  roles: string[];
  /** Epoch seconds; the worker refuses an expired token. */
  exp: number;
}

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encode = (part: JwtHeader | JwtClaims): string => b64url(new TextEncoder().encode(JSON.stringify(part)));

// `admin` also opens /admin and the Users screen.
const payload: JwtClaims = {
  sub: "dev",
  roles: roles.length > 0 ? roles : ["admin", "editor"],
  exp: Math.floor(Date.now() / 1000) + TTL_SECONDS,
};
const signingInput = `${encode({ alg: "HS256", typ: "JWT" } satisfies JwtHeader)}.${encode(payload)}`;

const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput)));

console.log(`${signingInput}.${b64url(signature)}`);
console.error(`\nroles: ${payload.roles.join(", ")} · expires ${new Date(payload.exp * 1000).toISOString()}\npaste into the Setup screen at http://localhost:4321/__admin\n`);
