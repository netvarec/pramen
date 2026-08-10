// PBKDF2 iteration count vs workerd's hard cap.
//
// Regression test for a bug that reached production: @pramen/auth hashed at 600k
// iterations (OWASP guidance), but workerd refuses anything above 100k and throws
// rather than clamping:
//
//   NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
//   supported (requested 600000).
//
// Every signup and login 500'd on a real Cloudflare deployment. It survived the whole
// test suite because Bun — which runs these tests, and which lopata runs workers on —
// has no such cap. That is the trap: the runtime we TEST on is more permissive than
// the runtime we DEPLOY to, so a green suite proved nothing here.
//
// Which is why the central assertion below is about the number in the stored hash
// rather than about behaviour: behaviour under Bun cannot distinguish 100k from 600k,
// but the recorded count can, and that is exactly what workerd rejects.

import { describe, expect, test } from "bun:test";
import { hashPassword, verifyPassword } from "../packages/auth/src/index";

/** workerd's documented ceiling. Deliberately duplicated rather than imported: this is
 * the external constraint the implementation must satisfy, so importing the value it
 * was derived from would make the test pass by construction. */
const WORKERD_MAX_PBKDF2_ITERATIONS = 100_000;

const iterationsOf = (stored: string) => Number(stored.split("$")[2]);

describe("PBKDF2 iterations stay within workerd's cap", () => {
  test("a new hash records a count workerd will accept", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored.startsWith("pbkdf2$sha256$")).toBe(true);
    expect(iterationsOf(stored)).toBeLessThanOrEqual(WORKERD_MAX_PBKDF2_ITERATIONS);
  });

  test("round-trips", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("Correct horse battery staple", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  test("every hash gets a fresh salt", async () => {
    const [a, b] = await Promise.all([hashPassword("same"), hashPassword("same")]);
    expect(a).not.toBe(b);
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });

  // The count is read back from the stored string, so hashes written under an older
  // (or future) count keep verifying. This is what makes lowering the constant safe.
  test("verifies a hash stored with a different iteration count", async () => {
    const salt = new Uint8Array(16).fill(7);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("hunter2"), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 50_000, hash: "SHA-256" }, key, 256);
    const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
    const stored = `pbkdf2$sha256$50000$${b64(salt)}$${b64(new Uint8Array(bits))}`;

    expect(await verifyPassword("hunter2", stored)).toBe(true);
    expect(await verifyPassword("hunter3", stored)).toBe(false);
  });

  // A row written at 600k (by pramen <= 0.0.43, or by a Bun/Node deployment sharing a
  // database with a Worker) is unverifiable on Workers. Bun happily computes it, so
  // this asserts the diagnosis rather than the throw — on workerd the same call raises
  // NotSupportedError and deriveBits() rewrites it into an actionable message.
  test("an over-cap stored hash is still parsed, and is what the error path targets", async () => {
    const salt = new Uint8Array(16).fill(3);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("legacy"), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 600_000, hash: "SHA-256" }, key, 256);
    const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
    const stored = `pbkdf2$sha256$600000$${b64(salt)}$${b64(new Uint8Array(bits))}`;

    expect(iterationsOf(stored)).toBeGreaterThan(WORKERD_MAX_PBKDF2_ITERATIONS);
    // Under Bun this verifies; under workerd it throws the message from deriveBits().
    expect(await verifyPassword("legacy", stored)).toBe(true);
  });
});
