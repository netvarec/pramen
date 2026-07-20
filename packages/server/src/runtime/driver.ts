// Driver + Dialect — the substrate seam. pramen's ACL, read-engine, repository, and
// migrator are written against these two interfaces, so the same data layer runs
// over any SQL backend:
//
//   - Driver  : how to execute SQL and run a transaction (async). One per backend
//               (DO SQLite, D1, Hyperdrive→Postgres, …).
//   - Dialect : how a backend spells SQL (identifier quoting, bind placeholders,
//               RETURNING support, value encoding). One per SQL flavor.
//
// This makes "Worker + D1" or "Worker + Hyperdrive/Postgres" a matter of plugging
// in a Driver, rather than rewriting the engine. Live queries remain a DO-only
// capability (they need a single writer + a stateful socket host).

export type Row = Record<string, unknown>;

export interface Dialect {
  /** Render an identifier (table/column), quoting as the backend requires. */
  id(name: string): string;
  /** Bind placeholder for the `n`-th parameter (1-based): `?` (SQLite/MySQL) or `$n` (Postgres). */
  placeholder(n: number): string;
  /** Whether INSERT/UPDATE/DELETE ... RETURNING is supported (SQLite/Postgres yes; MySQL no). */
  readonly returning: boolean;
  /** Coerce a JS value for binding (e.g. boolean → 0/1 on SQLite). */
  encode(v: unknown): unknown;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Column/table names come from developer schema keys (and validated `where` keys),
// never raw user input — but we still guard the identifier shape before interpolating.
function checkIdent(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`invalid identifier: ${name}`);
  return name;
}

/** Render an identifier as a standard double-quoted name (`"order"`), guarding its
 * shape first. SQLite (DO SQLite + D1) and Postgres all accept double-quoted
 * identifiers, so a column/table named after a reserved word (`order`, `group`, …)
 * is safe and case is preserved. The single source of truth for both dialects and
 * the DDL generator — keep every emitted identifier going through this. */
export function quoteIdent(name: string): string {
  return `"${checkIdent(name)}"`;
}

/** SQLite (DO SQLite and D1 both speak this). Double-quoted identifiers (so reserved
 * words like `order` work), `?` placeholders, booleans stored as INTEGER 0/1,
 * RETURNING supported. */
export const sqliteDialect: Dialect = {
  id: quoteIdent,
  placeholder: () => "?",
  returning: true,
  encode: (v) => (typeof v === "boolean" ? (v ? 1 : 0) : v),
};

/** Postgres (e.g. over Hyperdrive). Double-quoted identifiers preserve case (so
 * `ownerId` doesn't fold to `ownerid`), `$n` placeholders, native booleans,
 * RETURNING supported. */
export const postgresDialect: Dialect = {
  id: quoteIdent,
  placeholder: (n) => `$${n}`,
  returning: true,
  encode: (v) => v, // the pg driver handles type encoding
};

export interface Driver {
  readonly dialect: Dialect;
  /** Run a parameterized statement and return the result rows (empty for writes
   * without RETURNING). Params are already dialect-encoded by the caller. */
  exec(sql: string, params: unknown[]): Promise<Row[]>;
  /** Run `fn` inside a transaction: commit on resolve, roll back on throw. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  /** Run a fixed sequence of write statements ATOMICALLY with FK checks deferred to the
   * end — for a table rebuild that involves foreign keys (drop + recreate would trip an
   * immediate FK check). Optional: absent on a driver whose migrate already runs inside a
   * transaction (the DO), where the migrator falls back to sequential exec. Provided by the
   * D1 driver (no interactive transactions — uses db.batch(), itself atomic). */
  batch?(statements: ReadonlyArray<{ sql: string; params: unknown[] }>): Promise<void>;
}

/** DO SQLite — the in-process store. `SqlStorage` is synchronous; we wrap it as an
 * async Driver. Transactions use the DO's atomic `transaction()`. */
export class DoSqliteDriver implements Driver {
  readonly dialect = sqliteDialect;
  constructor(private readonly storage: DurableObjectStorage) {}

  async exec(sql: string, params: unknown[]): Promise<Row[]> {
    return this.storage.sql.exec(sql, ...params).toArray() as Row[];
  }

  transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.storage.transaction(fn);
  }
}

/** How a D1Driver's session is anchored (passed to `db.withSession`):
 *   - `"first-primary"`       — first query hits the primary (current data), the rest
 *                               read replicas consistent with the session bookmark. Use
 *                               for a MUTATION (reads must see current data; writes go
 *                               to primary anyway).
 *   - `"first-unconstrained"` — first query may hit the nearest replica. Use for a QUERY.
 *   - a bookmark string       — anchor at a prior write's bookmark for read-your-writes
 *                               (the client carries it forward via a header).
 * A bookmark always wins over a constraint when one is supplied. */
export type D1SessionStart = "first-primary" | "first-unconstrained" | (string & {});

/** D1 — SQLite over RPC. Async by nature.
 *
 * Read replicas (Sessions API): every D1Driver opens ONE `db.withSession(start)` and
 * runs all `exec` through it. Writes in a session always land on the primary; the
 * `start` only chooses where the FIRST read may begin. The session maintains a
 * bookmark (`getBookmark()`) so later reads are sequentially consistent with earlier
 * writes — read-your-writes when the bookmark is threaded across requests.
 *
 * ATOMICITY LIMIT (intentional): D1 has NO interactive transactions — a session can't
 * read mid-`batch()`, and pramen mutations interleave reads + writes + RETURNING +
 * trigger-into-outbox inside one `transaction()`. So `transaction(fn) = fn()`: each
 * statement auto-commits on its own, and a multi-statement mutation does NOT roll back
 * on throw the way it does on a DO. Single-statement mutations are atomic; anything
 * multi-statement is not. Use the DO store when you need atomic mutations. */
export class D1Driver implements Driver {
  readonly dialect = sqliteDialect;
  private readonly session: D1DatabaseSession;
  constructor(db: D1Database, opts?: { start?: D1SessionStart }) {
    this.session = db.withSession(opts?.start ?? "first-unconstrained");
  }

  async exec(sql: string, params: unknown[]): Promise<Row[]> {
    const stmt = params.length ? this.session.prepare(sql).bind(...params) : this.session.prepare(sql);
    const { results } = await stmt.all<Row>();
    return results ?? [];
  }

  /** The session's latest bookmark (null before any query). Threaded back to the client
   * via the `x-pramen-d1-bookmark` response header so a subsequent request can anchor a
   * fresh session at it and read its own writes. */
  getBookmark(): string | null {
    return this.session.getBookmark();
  }

  // D1 has no interactive/atomic transactions — see the class doc. Run `fn` as-is.
  transaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  /** D1's one atomic primitive: `session.batch()` runs the statements in a single
   * transaction (rolled back as a unit on failure). Prepend `defer_foreign_keys` so a
   * table rebuild's transient FK violations are checked only at the batch's commit. */
  async batch(statements: ReadonlyArray<{ sql: string; params: unknown[] }>): Promise<void> {
    const prepared = [
      this.session.prepare("PRAGMA defer_foreign_keys = ON"),
      ...statements.map((s) => (s.params.length ? this.session.prepare(s.sql).bind(...s.params) : this.session.prepare(s.sql))),
    ];
    await this.session.batch(prepared);
  }
}
