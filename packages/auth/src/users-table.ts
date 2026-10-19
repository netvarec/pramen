// The users table every factory in this package reads and writes. One module so the name is
// validated, quoted and stamped on sessions the same way everywhere: before it existed only
// `createAuthHandlers` quoted the name, so a table named after a keyword (`group`) worked for
// signup/login and broke `listUsers`, `changePassword` and `resetPassword`.

import type { HandlerContext, Row, SchemaDef } from "@pramen/server";

export const DEFAULT_USERS_TABLE = "auth_users";

/** The custom claim naming the table a session was minted from. Absent on a session from
 * `auth_users`, so every token minted before the claim existed keeps meaning what it meant. */
export const USERS_TABLE_CLAIM = "usersTable";

export interface UsersTable {
  /** The bare name, for the ORM (`ctx.db.update(name, ...)`) and ACL policies. */
  name: string;
  /** The quoted identifier, for raw `ctx.db.exec` SQL. */
  sql: string;
}

/** Every column the handlers in this package read or write on a users table: the
 * `authSchema.auth_users` shape. A custom table may add columns, never drop one of these. */
export const USERS_TABLE_COLUMNS = ["username", "passwordHash", "roles", "email", "emailVerified", "active", "createdAt", "credentialsChangedAt", "profile"] as const;

/** Throw at construction when `schema` declares `table` without a column the handlers need.
 * Without it the gap surfaced as a SQL error halfway through a handler: `deleteUser` had
 * already deactivated the row when the tombstone write failed on a missing column. */
export function assertUsersTableShape(schema: SchemaDef, table: string): void {
  const entity = schema[table];
  if (!entity) throw new Error(`@pramen/auth: users table '${table}' is not in the schema`);
  const missing = USERS_TABLE_COLUMNS.filter((c) => !(c in entity.fields));
  if (missing.length > 0) {
    throw new Error(`@pramen/auth: users table '${table}' lacks ${missing.join(", ")} (it must have the authSchema.auth_users shape; extra columns are fine)`);
  }
}

/** Validate and quote a users table name. It is app config, never request input, but it is
 * interpolated into SQL, so it is constrained rather than trusted by convention. */
export function usersTable(name: string = DEFAULT_USERS_TABLE): UsersTable {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`@pramen/auth: invalid table name ${JSON.stringify(name)}`);
  return { name, sql: `"${name}"` };
}

/** The custom claim naming the STORE a session was minted from. Absent on a session from the
 * Durable Object store, so every token minted before the claim existed keeps meaning what it
 * meant. Each store has its own users table and the Worker signs both stores' sessions with the
 * same AUTH_SECRET, so without it a username signed up on D1 was honored as the same-named
 * account on the DO (and the reverse): `refreshSession` there reissued THAT account's roles. */
export const STORE_CLAIM = "store";
const DEFAULT_STORE = "do";

type SessionClaims = { [USERS_TABLE_CLAIM]?: string; [STORE_CLAIM]?: string };

/** The claims to add to a session minted from `table` on `store` (the handler's `ctx.store`). */
export function tableClaim(table: UsersTable, store: string | undefined): SessionClaims {
  const out: SessionClaims = {};
  if (table.name !== DEFAULT_USERS_TABLE) out[USERS_TABLE_CLAIM] = table.name;
  if (store !== undefined && store !== DEFAULT_STORE) out[STORE_CLAIM] = store;
  return out;
}

/** Whether the caller's session was minted from `table`, on the store serving this request.
 *
 * The JWT `sub` is a bare username, so without this a session from one table would be honored
 * by another table's handlers: `refreshSession` over `members` would re-read `members.ada` and
 * mint `auth_users.ada` a token with `members.ada`'s roles. The same holds across stores. A token
 * with neither claim is from `auth_users` on the DO store (or an external IdP, whose users are
 * not rows in a custom table either). */
export function sessionIsFrom(ctx: HandlerContext, table: UsersTable): boolean {
  const claimed = ctx.identity?.[USERS_TABLE_CLAIM];
  const store = ctx.identity?.[STORE_CLAIM];
  return (
    (typeof claimed === "string" ? claimed : DEFAULT_USERS_TABLE) === table.name &&
    (typeof store === "string" ? store : DEFAULT_STORE) === (ctx.store ?? DEFAULT_STORE)
  );
}

/** Whether a sign-in that has just PROVEN control of `address` (a magic link, an invite, an
 * email-keyed OIDC login) may take the existing row whose username is that address.
 *
 * Signup lets anyone create a row under any username with a password of their choosing, so a
 * row named `victim@corp.test` proves nothing about who made it. Adopting it would share one
 * identity (one JWT `sub`) between the address owner and whoever set that password: the squatter
 * keeps logging in with it and inherits every role the row is granted later. So a row with a
 * password is adopted only when it has itself proven the address (`email` equal to it, and
 * verified). A passwordless row was only ever created by one of the email-proven doors. */
export function adoptableBy(row: Row, address: string): boolean {
  if (String(row.passwordHash ?? "") === "") return true;
  return row.email === address && row.emailVerified != null;
}
