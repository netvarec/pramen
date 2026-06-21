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
  const real = await fetch(`${base}/rpc/listNotes`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pramen-tenant": TENANT, origin: "https://example.com", authorization: `Bearer ${admin}` },
    body: "{}",
  });
  assert(
    real.headers.get("access-control-allow-origin") === "*",
    "extras: the actual RPC response carries the CORS header",
  );
}
