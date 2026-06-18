// ACL smoke test. Run against `wrangler dev` (default port 8799):
//   bun run scripts/acl-smoke.ts [port]
//
// Part A (HTTP): deny-by-default, row-level read scoping, field projection,
//                owner-scoped update/delete.
// Part B (WS):   live queries are per-identity — a write by another user does
//                not push to a subscriber whose row-scope excludes it.

import { sign, token } from "./jwt";

const port = process.argv[2] ?? "8799";
const base = `http://localhost:${port}`;
const TENANT = "acl-demo";

// Signed JWTs standing in for what an auth service would issue.
const TOKENS: Record<string, string> = {
  admin: await token("admin", ["admin"]),
  alice: await token("alice", ["author"]),
  bob: await token("bob", ["author"]),
  reader: await token("reader-user", ["reader"]),
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

console.log("== Part A: HTTP ACL ==");

// deny-by-default: anonymous is refused.
const anon = await post("listNotes", {}, undefined);
assert(anon.status === 403 && anon.body.ok === false, "anonymous read is denied (403)");

// a token signed with the wrong secret must fail signature verification.
const forged = await sign({ sub: "alice", roles: ["admin"] }, "wrong-secret");
const forgedRes = await fetch(`${base}/rpc/listNotes`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-mrak-tenant": TENANT, authorization: `Bearer ${forged}` },
  body: "{}",
});
assert(forgedRes.status === 403, "forged token (wrong secret) is rejected");

// seed notes owned by different identities
const adminNote = await post("createNote", { title: "by-admin", body: "secret" }, "admin");
const aliceNote = await post("createNote", { title: "by-alice", body: "alice-body" }, "alice");
const bobNote = await post("createNote", { title: "by-bob", body: "bob-body" }, "bob");
assert(adminNote.body.ok && aliceNote.body.ok && bobNote.body.ok, "admin/alice/bob can create");
assert(aliceNote.body.result.ownerId === "alice", "createNote stamps ownerId from identity");

// row-level read scope: author sees only their own
const aliceList = await post("listNotes", {}, "alice");
assert(
  aliceList.body.result.every((n: any) => n.ownerId === "alice"),
  "author read is row-scoped to own notes",
);
assert(
  aliceList.body.result.some((n: any) => n.id === aliceNote.body.result.id),
  "author sees their own note",
);

// admin sees everyone's
const adminList = await post("listNotes", {}, "admin");
const adminOwners = new Set(adminList.body.result.map((n: any) => n.ownerId));
assert(adminOwners.has("alice") && adminOwners.has("bob"), "admin read sees all owners");

// field projection: reader gets no body
const readerList = await post("listNotes", {}, "reader");
assert(readerList.body.result.length > 0, "reader can read notes");
assert(
  readerList.body.result.every((n: any) => !("body" in n) && "title" in n),
  "reader projection drops the body field",
);

// owner-scoped update: alice cannot touch bob's note, but can edit her own
const crossUpdate = await post("updateNote", { id: bobNote.body.result.id, title: "hijacked" }, "alice");
assert(crossUpdate.body.ok && crossUpdate.body.result === null, "alice updating bob's note is a no-op");
const bobAfter = await post("getNote", { id: bobNote.body.result.id }, "admin");
assert(bobAfter.body.result.title === "by-bob", "bob's note is unchanged");

const ownUpdate = await post("updateNote", { id: aliceNote.body.result.id, title: "alice-edited" }, "alice");
assert(ownUpdate.body.result?.title === "alice-edited", "alice can update her own note");

// owner-scoped delete
const crossDelete = await post("deleteNote", { id: bobNote.body.result.id }, "alice");
assert(crossDelete.body.result === false, "alice cannot delete bob's note");
const adminDelete = await post("deleteNote", { id: bobNote.body.result.id }, "admin");
assert(adminDelete.body.result === true, "admin can delete bob's note");

console.log("\n== Part B: per-identity live queries ==");

const inbox: any[] = [];
let notify: (() => void) | null = null;
const ws = new WebSocket(`ws://localhost:${port}/live`, {
  headers: { authorization: `Bearer ${TOKENS.alice}`, "x-mrak-tenant": TENANT },
} as any);
ws.addEventListener("message", (e) => {
  inbox.push(JSON.parse(String(e.data)));
  notify?.();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function next(pred: (m: any) => boolean, label: string): Promise<any> {
  return Promise.race([
    new Promise<any>((resolve) => {
      const scan = () => {
        const i = inbox.findIndex(pred);
        if (i >= 0) {
          notify = null;
          resolve(inbox.splice(i, 1)[0]);
        } else notify = scan;
      };
      scan();
    }),
    new Promise<any>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), 5000)),
  ]);
}
const aliceData = (m: any) => m.type === "data" && m.id === "mine";

await new Promise<void>((res) => ws.addEventListener("open", () => res()));
ws.send(JSON.stringify({ type: "subscribe", id: "mine", name: "listNotes" }));
const init = await next(aliceData, "alice initial");
assert(init.result.every((n: any) => n.ownerId === "alice"), "alice's live sub is row-scoped");
inbox.length = 0;

// bob writes -> alice's scoped subscription must NOT be pushed
await post("createNote", { title: "bob-live", body: "x" }, "bob");
await sleep(500);
assert(!inbox.some(aliceData), "a write by bob does NOT push to alice's scoped subscription");

// alice writes -> she is pushed
await post("createNote", { title: "alice-live", body: "y" }, "alice");
const push = await next(aliceData, "alice push after her own write");
assert(push.result.some((n: any) => n.title === "alice-live"), "alice is pushed her own new note");

ws.close();
console.log("\nALL ACL CHECKS PASSED");
process.exit(0);
