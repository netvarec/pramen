// Unit tests for the signed capability tokens behind signed file urls and page-preview
// links (packages/server/src/runtime/token.ts). Pure WebCrypto — no server boot.

import { expect, test } from "bun:test";
import { signToken, verifyToken, isUsableSecret, resolveSecret, MIN_TOKEN_SECRET_LEN } from "@pramen/server";

const SECRET = "a-strong-enough-secret-value";
const future = () => Math.floor(Date.now() / 1000) + 600;

test("a token round-trips through sign + verify", async () => {
  const payload = { t: "acme", p: "page-1", exp: future() };
  const verified = await verifyToken<typeof payload>(await signToken(payload, SECRET), SECRET);
  expect(verified).toEqual(payload);
});

test("a token signed with another secret does not verify", async () => {
  const raw = await signToken({ t: "acme", p: "page-1", exp: future() }, SECRET);
  expect(await verifyToken(raw, "a-different-strong-secret!!")).toBeNull();
});

test("tampering with the payload invalidates the signature", async () => {
  const raw = await signToken({ t: "acme", p: "page-1", exp: future() }, SECRET);
  const [data, sig] = raw.split(".");
  // Re-encode the payload with a different page id, keeping the original signature.
  const forged = btoa(JSON.stringify({ t: "acme", p: "page-2", exp: future() }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  expect(data).not.toBe(forged);
  expect(await verifyToken(`${forged}.${sig}`, SECRET)).toBeNull();
});

test("an expired token does not verify", async () => {
  const raw = await signToken({ p: "page-1", exp: Math.floor(Date.now() / 1000) - 1 }, SECRET);
  expect(await verifyToken(raw, SECRET)).toBeNull();
});

test("a payload with no expiry does not verify", async () => {
  // Hand-rolled, because signToken's type requires `exp` — this is the forged case.
  const data = btoa(JSON.stringify({ p: "page-1" })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  let bin = "";
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  expect(await verifyToken(`${data}.${b64}`, SECRET)).toBeNull();
});

test("malformed input never throws, it just fails to verify", async () => {
  for (const bad of ["", ".", "no-dot", "a.b", "!!!.???"]) {
    expect(await verifyToken(bad, SECRET)).toBeNull();
  }
});

test("a payload survives non-ASCII content", async () => {
  const payload = { fn: "přehled — návrh.pdf", exp: future() };
  const verified = await verifyToken<typeof payload>(await signToken(payload, SECRET), SECRET);
  expect(verified?.fn).toBe("přehled — návrh.pdf");
});

test("isUsableSecret rejects absent and weak secrets", () => {
  expect(MIN_TOKEN_SECRET_LEN).toBe(16);
  expect(isUsableSecret(SECRET)).toBe(true);
  expect(isUsableSecret("x".repeat(MIN_TOKEN_SECRET_LEN))).toBe(true);
  for (const bad of ["", "short", "x".repeat(MIN_TOKEN_SECRET_LEN - 1), undefined, null, 12345]) {
    expect(isUsableSecret(bad)).toBe(false);
  }
});

test("resolveSecret takes the first usable name in preference order", () => {
  const names = ["PREVIEW_SECRET", "FILES_SECRET", "AUTH_SECRET"];
  expect(resolveSecret({ PREVIEW_SECRET: SECRET, AUTH_SECRET: "other-strong-secret-value" }, names)).toBe(SECRET);
  // A present-but-too-weak value is SKIPPED, not accepted — it would be forgeable.
  expect(resolveSecret({ PREVIEW_SECRET: "weak", FILES_SECRET: SECRET }, names)).toBe(SECRET);
  expect(resolveSecret({ AUTH_SECRET: SECRET }, names)).toBe(SECRET);
  expect(resolveSecret({}, names)).toBeUndefined();
  expect(resolveSecret({ PREVIEW_SECRET: "weak" }, names)).toBeUndefined();
});
