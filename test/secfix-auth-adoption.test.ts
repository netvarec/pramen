// Security regressions: who may take an existing row by proving an email address.
//
// - pramen/auth:signup-username-squats-magic-link-email-identity: an anonymous password signup
//   with username = the victim's address was adopted by the victim's later magic-link sign-in,
//   invite or email-keyed OIDC sign-in, so attacker and victim shared one identity.
// - pramen/auth/oidc-upsert:insert-email-unique-conflict-lockout: another row's UNVERIFIED claim
//   on the address made the owner's first OIDC sign-in fail on the unique column.
// - pramen/auth/oidc-upsert:sub-mode-marks-unverified-email-verified: `accountKey: "sub"` stored
//   the IdP's unverified email AND stamped it verified.

import { afterEach, describe, expect, test } from "bun:test";
import { authHandlers, createMagicLinkAuth, createPasswordReset, userHandlers } from "../packages/auth/src/index";
import { createOidcAuth, oidcHandlers, OIDC_UPSERT_HANDLER } from "../packages/auth/src/oidc";
import { claims, harness, recorder, type Sent } from "./secfix-auth-harness";

const VICTIM = "victim@corp.test";
const admin = { userId: "admin", roles: ["admin"] };

async function setup() {
  const sent: Sent[] = [];
  const magic = createMagicLinkAuth({ sendEmail: recorder(sent, "magic"), resendCooldownSeconds: 0 });
  const reset = createPasswordReset({ sendEmail: recorder(sent, "reset"), resendCooldownSeconds: 0 });
  const h = await harness({ ...magic.tasks, ...reset.tasks });
  const magicLogin = async (email: string) => {
    await h.run(magic.handlers.requestMagicLink, h.ctx(), { email });
    return h.run<{ token: string; user: { username: string } }>(magic.handlers.loginWithMagicLink, h.ctx(), { token: sent.at(-1)!.token });
  };
  return { h, sent, magic, reset, magicLogin };
}

describe("a password signup named after someone else's address is never adopted", () => {
  test("magic link: the victim's sign-in is refused, the squatter's password keeps only its own row", async () => {
    const { h, magicLogin } = await setup();
    const squat = await h.run<{ token: string }>(authHandlers.signup, h.ctx(), { username: VICTIM, password: "attackerpw1" });
    await expect(magicLogin(VICTIM)).rejects.toThrow(/without having confirmed it/);
    // Nothing about the row changed hands: no roles, no verified email written onto it.
    const row = await h.raw(VICTIM);
    expect(row?.email).toBeNull();
    expect(row?.emailVerified).toBeNull();
    expect(claims(squat.token).sub).toBe(VICTIM);
  });

  test("invite: refused, so an admin cannot grant the squatter roles through it", async () => {
    const { h, magic } = await setup();
    await h.run(authHandlers.signup, h.ctx(), { username: VICTIM, password: "attackerpw1" });
    await expect(h.run(magic.handlers.inviteUser, h.ctx(admin), { email: VICTIM, roles: ["editor"] })).rejects.toThrow(/delete it before inviting/);
    expect(JSON.parse(String((await h.raw(VICTIM))?.roles))).toEqual(["user"]);
  });

  test("OIDC (email-keyed): the upsert refuses and writes nothing", async () => {
    const { h } = await setup();
    await h.run(authHandlers.signup, h.ctx(), { username: VICTIM, password: "attackerpw1" });
    const res = await h.run(oidcHandlers[OIDC_UPSERT_HANDLER], h.ctx(), {
      table: "auth_users", username: VICTIM, email: VICTIM, emailVerified: true, emailKeyed: true, roles: ["admin"], defaultRoles: ["user"], profile: null,
    });
    expect(res).toMatchObject({ refused: "account_unverified" });
    expect(JSON.parse(String((await h.raw(VICTIM))?.roles))).toEqual(["user"]);
  });

  test("a password row that PROVED the address (email = username, verified) is still adopted", async () => {
    const { h, magicLogin } = await setup();
    await h.run(authHandlers.signup, h.ctx(), { username: VICTIM, password: "ownerpw123", email: VICTIM });
    await h.driver.exec("UPDATE auth_users SET emailVerified = ? WHERE username = ?", [Date.now(), VICTIM]);
    expect((await magicLogin(VICTIM)).user.username).toBe(VICTIM);
  });

  test("a magic-link user who later sets a password can still sign in by magic link", async () => {
    // The first sign-in records the proven address on the row, which is what keeps the row
    // adoptable once it has a password.
    const { h, magicLogin } = await setup();
    await magicLogin(VICTIM);
    const row = await h.raw(VICTIM);
    expect(row?.email).toBe(VICTIM);
    expect(row?.emailVerified).not.toBeNull();
    await h.run(userHandlers.changePassword, h.ctx({ userId: VICTIM }), { currentPassword: "", newPassword: "ownerpw123" });
    expect((await magicLogin(VICTIM)).user.username).toBe(VICTIM);
  });

  test("the owner reclaims a squat whose contact email is theirs by resetting the password", async () => {
    const { h, sent, reset, magicLogin } = await setup();
    await h.run(authHandlers.signup, h.ctx(), { username: VICTIM, password: "attackerpw1", email: VICTIM });
    await h.run(reset.handlers.requestPasswordReset, h.ctx(), { email: VICTIM });
    await h.run(reset.handlers.resetPassword, h.ctx(), { token: sent.at(-1)!.token, newPassword: "ownerpw123" });
    // The squatter's password is gone and the reset proved the address, so the row is now the owner's.
    await expect(h.run(authHandlers.login, h.ctx(), { username: VICTIM, password: "attackerpw1" })).rejects.toThrow(/invalid username or password/);
    expect((await magicLogin(VICTIM)).user.username).toBe(VICTIM);
  });
});

describe("the OIDC first-login insert", () => {
  const upsertNew = (h: Awaited<ReturnType<typeof harness>>, over: Record<string, unknown> = {}) =>
    h.run(oidcHandlers[OIDC_UPSERT_HANDLER], h.ctx(), {
      table: "auth_users", username: VICTIM, email: VICTIM, emailVerified: true, emailKeyed: true, roles: null, defaultRoles: ["user"], profile: null, ...over,
    });

  test("another row's UNVERIFIED claim on the address no longer locks the owner out", async () => {
    const { h } = await setup();
    await h.run(authHandlers.signup, h.ctx(), { username: "mallory", password: "attackerpw1", email: VICTIM });
    expect(await upsertNew(h)).toMatchObject({ roles: ["user"], active: true });
    expect((await h.raw(VICTIM))?.email).toBe(VICTIM);
    expect((await h.raw("mallory"))?.email).toBeNull();
  });

  test("a row that VERIFIED the address keeps it; the new row is stored without one", async () => {
    const { h } = await setup();
    await h.run(authHandlers.signup, h.ctx(), { username: "bob", password: "bobpassword", email: VICTIM });
    await h.driver.exec("UPDATE auth_users SET emailVerified = 1 WHERE username = 'bob'", []);
    expect(await upsertNew(h)).toMatchObject({ active: true });
    expect((await h.raw(VICTIM))?.email).toBeNull();
    expect((await h.raw("bob"))?.email).toBe(VICTIM);
  });

  test("an email the provider did not verify is never stamped verified", async () => {
    const { h } = await setup();
    await upsertNew(h, { username: "https://idp#1", emailVerified: false, emailKeyed: false });
    const row = await h.raw("https://idp#1");
    expect(row?.email).toBeNull();
    expect(row?.emailVerified).toBeNull();
  });
});

// The callback end to end, against a fake provider (as in oidc.test.ts), with a privileged call
// that runs the REAL upsert handler on the harness Db.
describe("the OIDC callback", () => {
  const ISSUER = "https://idp.example.com";
  const CLIENT_ID = "pramen-app";
  const b64url = (b: ArrayBuffer | Uint8Array) =>
    btoa(String.fromCharCode(...(b instanceof Uint8Array ? b : new Uint8Array(b)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const original = globalThis.fetch;
  afterEach(() => void (globalThis.fetch = original));

  async function signIn(
    claimsOver: Record<string, unknown>,
    oidcOver: Record<string, unknown> = {},
    store: "do" | "d1" = "do",
    seed?: (h: Awaited<ReturnType<typeof harness>>) => Promise<unknown>,
  ) {
    const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    const asked = { nonce: "" };
    const idToken = async () => {
      const now = Math.floor(Date.now() / 1000);
      const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
      const data = `${enc({ alg: "RS256", typ: "JWT", kid: "k1" })}.${enc({ iss: ISSUER, aud: CLIENT_ID, exp: now + 300, iat: now, nonce: asked.nonce, ...claimsOver })}`;
      return `${data}.${b64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(data)))}`;
    };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/.well-known/openid-configuration")) return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` });
      if (url.endsWith("/jwks")) return Response.json({ keys: [{ ...jwk, kid: "k1", alg: "RS256", use: "sig" }] });
      if (url.endsWith("/token")) return Response.json({ id_token: await idToken() });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    const kvMap = new Map<string, string>();
    const KV = {
      get: async (k: string, type?: string) => { const v = kvMap.get(k) ?? null; return v !== null && type === "json" ? JSON.parse(v) : v; },
      put: async (k: string, v: string) => void kvMap.set(k, v),
      delete: async (k: string) => void kvMap.delete(k),
    };
    const env = { KV, AUTH_SECRET: "a-sufficiently-long-test-secret" } as never;
    const { h } = await setup();
    await seed?.(h);
    const [start, callback] = createOidcAuth({
      issuer: ISSUER, clientId: CLIENT_ID, redirectUri: "https://app.example.com/auth/oidc/callback", successRedirect: "https://app.example.com/in", ...oidcOver,
    }).routes;
    const started = await start!.handler(new Request("https://app.example.com/auth/oidc/start"), env, {} as never);
    const loc = new URL(started.headers.get("location")!);
    asked.nonce = loc.searchParams.get("nonce")!;
    const routeCtx = {
      callPrivileged: async (o: { name: string; input: unknown }) => {
        try {
          return Response.json({ ok: true, result: await h.run(oidcHandlers[o.name], h.ctx({ roles: ["__oidc_system"] }, { store }), o.input) });
        } catch (err) {
          return Response.json({ ok: false, error: String(err) });
        }
      },
    } as never;
    const res = await callback!.handler(
      new Request(`https://app.example.com/auth/oidc/callback?state=${loc.searchParams.get("state")}&code=c`, { headers: { cookie: (started.headers.get("set-cookie") ?? "").split(";")[0]! } }),
      env,
      routeCtx,
    );
    return { h, res };
  }

  test("sub mode does not store the provider's unverified email", async () => {
    const { h, res } = await signIn({ sub: "s-1", email: VICTIM, email_verified: false }, { accountKey: "sub" });
    expect(res.status).toBe(302);
    const row = await h.raw(`${ISSUER}#s-1`);
    expect(row?.email).toBeNull();
    expect(row?.emailVerified).toBeNull();
  });

  test("a squatted address answers account_conflict instead of signing the owner into it", async () => {
    const { h, res } = await signIn({ sub: "s-2", email: VICTIM, email_verified: true }, {}, "do", (h) =>
      h.run(authHandlers.signup, h.ctx(), { username: VICTIM, password: "attackerpw1" }),
    );
    expect(res.status).toBe(409);
    expect(res.headers.get("location")).toBeNull();
    expect(JSON.parse(String((await h.raw(VICTIM))?.roles))).toEqual(["user"]);
  });

  test("a first sign-in whose address another row claimed unverified completes", async () => {
    const { h, res } = await signIn({ sub: "s-4", email: VICTIM, email_verified: true }, {}, "do", (h) =>
      h.run(authHandlers.signup, h.ctx(), { username: "mallory", password: "attackerpw1", email: VICTIM }),
    );
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).hash).toStartWith("#token=");
    expect((await h.raw(VICTIM))?.email).toBe(VICTIM);
  });

  test("the session names the store the upsert ran on", async () => {
    const { res } = await signIn({ sub: "s-3", email: "d1user@acme.test", email_verified: true }, {}, "d1");
    const token = decodeURIComponent(new URL(res.headers.get("location")!).hash.replace("#token=", ""));
    expect(claims(token)).toMatchObject({ sub: "d1user@acme.test", store: "d1" });
  });
});
