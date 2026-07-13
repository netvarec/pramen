// Coverage for the gaps surfaced by a real migration: a `t.json()` column (codec
// round-trip), handler access to the Worker/DO env via `ctx.env`, and CORS on
// /rpc (preflight + actual response) when CORS_ORIGINS is set.

import { assert, http, token } from "../lib";

export async function runExtras(base: string): Promise<void> {
  const TENANT = "extras";
  const call = http(base, TENANT);
  const admin = await token("admin", ["admin"]);

  // --- t.json(): an object round-trips through the TEXT column as a parsed value ---
  const meta = { tags: ["a", "b"], pinned: true, rank: 3, nested: { k: "v" } };
  const created = await call("createNote", { title: "j", body: "b", meta }, admin);
  assert(created.body.ok, "extras: created a note with a json column");
  assert(
    JSON.stringify(created.body.result.meta) === JSON.stringify(meta),
    "extras: json column round-trips on the insert echo",
  );
  const fetched = await call("getNote", { id: created.body.result.id }, admin);
  assert(
    fetched.body.result?.meta?.nested?.k === "v" && Array.isArray(fetched.body.result.meta.tags),
    "extras: json column decodes to an object on read",
  );

  // --- ctx.env: handlers can see env vars/bindings (without leaking the value) ---
  const env = await call("envCheck", {}, admin);
  assert(env.body.ok && env.body.result.hasAuthSecret === true, "extras: ctx.env exposes AUTH_SECRET to handlers");
  assert(env.body.result.hasKvBinding === true, "extras: ctx.env exposes the KV binding to handlers");

  // --- CORS (CORS_ORIGINS=* in local vars): preflight + actual response ---
  const preflight = await fetch(`${base}/rpc/listNotes`, {
    method: "OPTIONS",
    headers: { origin: "https://example.com", "access-control-request-method": "POST" },
  });
  assert(preflight.status === 204, "extras: CORS preflight returns 204");
  assert(
    preflight.headers.get("access-control-allow-origin") === "*",
    "extras: preflight allows the cross-origin caller",
  );
  assert(
    preflight.headers.get("access-control-max-age") === "7200",
    "extras: preflight is cacheable (Max-Age) so RPCs don't re-preflight",
  );
  const real = await fetch(`${base}/rpc/listNotes`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pramen-tenant": TENANT, origin: "https://example.com", authorization: `Bearer ${admin}` },
    body: "{}",
  });
  assert(
    real.headers.get("access-control-allow-origin") === "*",
    "extras: the actual RPC response carries the CORS header",
  );

  // --- P7 anonymous role + P9 capability read (on the default `main` tenant, which
  // anonymous callers may reach; the `anonymous` ACL role gates the data) ---
  const main = http(base, "main"); // post(name, input, bearer?) — omit bearer = anonymous

  // anonymous can create a signup (public write), but can't read notes
  const anonNote = await main("listNotes", {});
  assert(anonNote.status === 403, "extras: anonymous still can't read notes (deny-by-default)");
  const cap = "cap-code-7a9f";
  const made = await main("createSignup", { email: "guest@example.com", code: cap });
  assert(made.body.ok, "extras: anonymous can create a signup (anonymous role, public write)");

  // capability read: only by presenting the exact code; no code / wrong code -> nothing
  const byCode = await main("getSignupByCode", { code: cap });
  assert(byCode.body.result?.email === "guest@example.com", "extras: capability read returns the row for the right code");
  // DEFAULT: status wasn't supplied on insert, so the DB filled it
  assert(byCode.body.result?.status === "pending", "extras: column DEFAULT is applied on insert (t.default)");
  // UNIQUE: a second signup with the same code is rejected by the unique index
  const dup = await main("createSignup", { email: "dup@example.com", code: cap });
  assert(dup.body.ok === false, "extras: UNIQUE constraint rejects a duplicate code (t.unique)");
  const wrong = await main("getSignupByCode", { code: "not-the-code" });
  assert(wrong.body.ok && wrong.body.result === null, "extras: capability read returns nothing for a wrong code");
  const noCode = await main("getSignupByCode", {});
  assert(noCode.body.ok && noCode.body.result === null, "extras: capability read can't enumerate (no code -> nothing)");

  // --- P4 public pre-auth route + privileged forward (no JWT, no tenant header) ---
  const hookCode = "cap-route-3c2e";
  const hook = await fetch(`${base}/hooks/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "hook@example.com", code: hookCode }),
  });
  const hookBody = (await hook.json().catch(() => ({}))) as any;
  assert(hook.status === 200 && hookBody.ok, "extras: public route runs pre-auth (no token) and forwards a privileged mutation");
  const fromHook = await main("getSignupByCode", { code: hookCode });
  assert(fromHook.body.result?.email === "hook@example.com", "extras: the webhook-forwarded signup landed in the DO");

  // --- P6: mutation echoes are field-ACL-safe (no leak) and never collapse to {} ---
  const P6 = "p6";
  const p6 = http(base, P6);
  const T6 = {
    alice: await token("alice", ["author"], { tenants: [P6] }),
    tina: await token("tina", ["teammate"], { tenants: [P6] }),
    m1: await token("m1", ["member"], { tenants: [P6] }),
  };

  // alice (author) writes a note with a body tina cannot read
  const aNote = await p6("createNote", { title: "p6", body: "alice-secret" }, T6.alice);
  const noteId = aNote.body.result.id;

  // tina (teammate) may edit any title but can't read body on another's note — the
  // update echo must include the written title but NOT leak body
  const edited = await p6("updateNote", { id: noteId, title: "p6-edited" }, T6.tina);
  assert(edited.body.result?.title === "p6-edited", "P6: update echo returns the written field");
  assert(edited.body.result && !("body" in edited.body.result), "P6: update echo does not leak an unreadable field (body)");

  // m1 (member) has NO read access until it has authored a note, yet its first
  // create must still echo a useful row (generated id + written fields), not {}
  const mNote = await p6("createNote", { title: "m1-first", body: "x" }, T6.m1);
  assert(typeof mNote.body.result?.id === "number", "P6: write-only create still echoes the generated id (not {})");
  assert(mNote.body.result?.title === "m1-first", "P6: write-only create echoes the fields it wrote");
}
