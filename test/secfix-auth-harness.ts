// Shared harness for the test/secfix-auth-*.test.ts regression tests: the @pramen/auth handlers
// driven directly against a real system Db over bun:sqlite, which behaves like D1 (every
// statement autocommits, `transaction()` is a pass-through), so check-then-act races and
// interrupted multi-statement handlers reproduce exactly as they would on the D1 store.
//
// `beforeExec` lets a test run something between two statements of a handler (a concurrent
// changeEmail landing mid-verifyEmail) or cut the handler off at one (an invocation canceled
// by a client disconnect).

import { Database } from "bun:sqlite";
import { defineSchema } from "../packages/server/src/sdk/schema";
import { compileAcl } from "../packages/server/src/runtime/acl";
import { Db } from "../packages/server/src/runtime/db";
import { migrate } from "../packages/server/src/runtime/migrate";
import type { Driver } from "../packages/server/src/runtime/driver";
import { bunSqliteDriver } from "./sqlite-driver";
import type { HandlerContext } from "@pramen/server";
import { authSchema, emailTokenSchema, magicLinkSchema } from "../packages/auth/src/index";

export const SECRET = "secfix-auth-test-secret-long-enough";

export interface Sent {
  kind: string;
  email: string;
  token: string;
}

export interface Enqueued {
  kind: string;
  payload: unknown;
}

export interface KvPut {
  key: string;
  value: string;
  expirationTtl?: number;
}

type TaskMap = Record<string, (ctx: HandlerContext, payload: never, meta: { id: string; attempts: number }) => unknown>;

/** Build a `sendEmail` that records into `sent` under `kind`. */
export const recorder = (sent: Sent[], kind: string) => (_c: HandlerContext, a: { email: string; token: string }) => void sent.push({ kind, ...a });

export async function harness(tasks: TaskMap = {}, schemaExtra: Record<string, unknown> = {}) {
  const schema = defineSchema({ ...authSchema, ...emailTokenSchema, ...magicLinkSchema, ...(schemaExtra as object) });
  const base = bunSqliteDriver(new Database(":memory:"));
  let beforeExec: ((sql: string, params: unknown[]) => void | Promise<void>) | null = null;
  const driver: Driver = {
    ...base,
    async exec(sql, params) {
      if (beforeExec) await beforeExec(sql, params);
      return base.exec(sql, params);
    },
  };
  await migrate(base, schema);
  const db = new Db(driver, { acl: compileAcl([]), identity: null, schema, system: true }, schema);
  const kvStore = new Map<string, string>();
  const kvPuts: KvPut[] = [];
  const kv = {
    get: async (k: string) => kvStore.get(k) ?? null,
    put: async (k: string, v: string, o?: { expirationTtl?: number }) => {
      kvStore.set(k, v);
      kvPuts.push({ key: k, value: v, expirationTtl: o?.expirationTtl });
    },
    delete: async (k: string) => void kvStore.delete(k),
  };
  const enqueued: Enqueued[] = [];
  const now = () => Math.floor(Date.now() / 1000);
  /** A handler ctx. `identity` gets the `iat` the Worker carries unless the test sets one. */
  const ctx = (
    identity: Record<string, unknown> | null = null,
    o: { store?: "do" | "d1"; env?: Record<string, unknown>; drain?: boolean } = {},
  ): never =>
    ({
      db,
      kv,
      store: o.store ?? "do",
      env: { AUTH_SECRET: SECRET, ...o.env },
      identity: identity && { iat: now(), ...identity },
      tasks: {
        enqueue: async (t: Enqueued) => {
          enqueued.push(t);
          if (o.drain !== false && tasks[t.kind]) await tasks[t.kind]!(ctx(), t.payload as never, { id: t.kind, attempts: 1 });
        },
      },
    }) as never;
  const run = <T = Record<string, unknown>>(h: unknown, c: never, input: unknown = {}) =>
    Promise.resolve().then(() => (h as { run: (c: never, i: unknown) => unknown }).run(c, input)) as Promise<T>;
  const raw = async (username: string, table = "auth_users") =>
    (await base.exec(`SELECT * FROM "${table}" WHERE username = ?`, [username]))[0] as Record<string, unknown> | undefined;
  return {
    driver: base,
    db,
    kv,
    kvPuts,
    enqueued,
    ctx,
    run,
    raw,
    setBeforeExec: (fn: typeof beforeExec) => void (beforeExec = fn),
  };
}

/** The claims of a session token (no verification: the handler under test minted it). */
export function claims(token: unknown): Record<string, unknown> {
  const body = String(token).split(".")[1]!;
  return JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
}
