// Hardening: boundary input validation, safe/typed error envelopes (status +
// code), and that internal details aren't leaked.

import { assert, http, token } from "../lib";

export async function runHardening(base: string): Promise<void> {
  const TENANT = "hardening-demo";
  const post = http(base, TENANT);
  const admin = await token("admin", ["admin"]);

  // input validation: a non-string title is rejected at the boundary.
  const badType = await post("createNote", { title: 123, body: "x" }, admin);
  assert(badType.status === 400 && badType.body.code === "bad_request", "input validator rejects non-string title (400 bad_request)");
  assert(badType.body.error === "title must be a string", "validator message reaches the client");

  // unknown handler -> 400 bad_request.
  const unknown = await post("doesNotExist", {}, admin);
  assert(unknown.status === 400 && unknown.body.code === "bad_request", "unknown handler -> 400 bad_request");

  // denial carries the forbidden code, never an internal message.
  const anon = await post("listNotes", {});
  assert(anon.status === 403 && anon.body.code === "forbidden", "anonymous read -> 403 forbidden");
  assert(typeof anon.body.error === "string" && !anon.body.error.includes("Error:"), "error message is clean (no stack/Error prefix)");

  // a valid request still works.
  const ok = await post("createNote", { title: "fine", body: "y" }, admin);
  assert(ok.body.ok === true, "a valid create still succeeds");
}
