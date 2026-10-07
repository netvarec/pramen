// The users table every factory in this package reads and writes. One module so the name is
// validated, quoted and stamped on sessions the same way everywhere: before it existed only
// `createAuthHandlers` quoted the name, so a table named after a keyword (`group`) worked for
// signup/login and broke `listUsers`, `changePassword` and `resetPassword`.

import type { HandlerContext } from "@pramen/server";

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

/** Validate and quote a users table name. It is app config, never request input, but it is
 * interpolated into SQL, so it is constrained rather than trusted by convention. */
export function usersTable(name: string = DEFAULT_USERS_TABLE): UsersTable {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`@pramen/auth: invalid table name ${JSON.stringify(name)}`);
  return { name, sql: `"${name}"` };
}

/** The claims to add to a session minted from `table`. */
export function tableClaim(table: UsersTable): { [USERS_TABLE_CLAIM]?: string } {
  return table.name === DEFAULT_USERS_TABLE ? {} : { [USERS_TABLE_CLAIM]: table.name };
}

/** Whether the caller's session was minted from `table`.
 *
 * The JWT `sub` is a bare username, so without this a session from one table would be honored
 * by another table's handlers: `refreshSession` over `members` would re-read `members.ada` and
 * mint `auth_users.ada` a token with `members.ada`'s roles. A token with no claim is from
 * `auth_users` (or an external IdP, whose users are not rows in a custom table either). */
export function sessionIsFrom(ctx: HandlerContext, table: UsersTable): boolean {
  const claimed = ctx.identity?.[USERS_TABLE_CLAIM];
  return (typeof claimed === "string" ? claimed : DEFAULT_USERS_TABLE) === table.name;
}
