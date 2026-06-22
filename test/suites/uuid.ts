// uuid field type: a generated() uuid PK + a generated() non-PK uuid are minted
// server-side on insert, a caller-supplied uuid is accepted, and a malformed uuid
// is rejected (400) by the write-time validation.

import { assert, http, token } from "../lib";
import { isValidUuid } from "../../packages/server/src/sdk/uuid";

export async function runUuid(base: string): Promise<void> {
  const TENANT = "uuid";
  const call = http(base, TENANT);
  const admin = await token("admin", ["admin"]);

  // --- generation: omit id + traceId, the runtime mints both ---
  const created = await call("logEvent", { kind: "signup" }, admin);
  assert(created.body.ok, "uuid: logEvent created an event");
  const ev = created.body.result;
  assert(isValidUuid(ev.id), "uuid: generated() PK id is a valid uuid");
  assert(isValidUuid(ev.traceId), "uuid: generated() non-PK traceId is a valid uuid");
  assert(ev.id !== ev.traceId, "uuid: the two generated uuids differ");

  // --- round-trip: the generated id reads back unchanged ---
  const listed = await call("listEvents", {}, admin);
  assert(listed.body.ok && Array.isArray(listed.body.result), "uuid: listEvents returns rows");
  const back = listed.body.result.find((r: { id: string }) => r.id === ev.id);
  assert(back && back.kind === "signup", "uuid: the generated id round-trips on read");

  // --- a caller-supplied valid uuid is honored ---
  const mine = crypto.randomUUID();
  const supplied = await call("logEvent", { kind: "login", id: mine }, admin);
  assert(supplied.body.ok && supplied.body.result.id === mine, "uuid: a valid caller-supplied uuid is used as the PK");

  // --- a malformed uuid is rejected at write time (400) ---
  const bad = await call("logEvent", { kind: "bad", id: "not-a-uuid" }, admin);
  assert(!bad.body.ok && bad.status === 400, "uuid: a malformed uuid is rejected (400)");
  assert(/invalid uuid/i.test(bad.body.error ?? ""), "uuid: the rejection names an invalid uuid");
}
