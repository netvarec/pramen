// Dynamic resolver smoke test. Run against `wrangler dev` (default port 8799):
//   bun run scripts/resolver-smoke.ts [port]
//
// The `member` role's read policy is a resolve() that consults the DB (in SYSTEM
// mode) per request: you may read all notes only after authoring one, else none.
// This proves resolvers run per request, can read the DB without recursing, and
// flip access based on live state.

import { token } from "./jwt";

const port = process.argv[2] ?? "8799";
const base = `http://localhost:${port}`;
const TENANT = "resolver-demo";

const TOKENS: Record<string, string> = {
  admin: await token("admin", ["admin"]),
  mia: await token("mia", ["member"]),
};

const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ok: ${msg}`);
};

async function post(name: string, input: unknown, role?: keyof typeof TOKENS): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-mrak-tenant": TENANT };
  if (role) headers.authorization = `Bearer ${TOKENS[role]}`;
  const r = await fetch(`${base}/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(input ?? {}) });
  return { status: r.status, body: await r.json() };
}

// An admin note exists that mia does not own.
const adminNote = await post("createNote", { title: "admin-only", body: "x" }, "admin");
assert(adminNote.body.ok, "admin seeded a note");

// Before mia authors anything, the resolver denies her read.
const before = await post("listNotes", {}, "mia");
assert(before.status === 403, "member read denied before authoring (resolver -> deny)");

// mia authors a note (member has a static create grant).
const miaNote = await post("createNote", { title: "mia-first", body: "y" }, "mia");
assert(miaNote.body.ok && miaNote.body.result.ownerId === "mia", "member can create; ownerId stamped");

// Now the same resolver grants full read — including notes she does not own.
const after = await post("listNotes", {}, "mia");
assert(after.status === 200, "member read allowed after authoring (resolver -> allow)");
const owners = new Set(after.body.result.map((n: any) => n.ownerId));
assert(owners.has("admin") && owners.has("mia"), "resolver allow() grants read across all owners");

console.log("\nALL RESOLVER CHECKS PASSED");
process.exit(0);
