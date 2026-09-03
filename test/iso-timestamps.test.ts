// `isoTimestampBackfill()` — rewriting timestamps written before `expr.now()` emitted ISO.
//
// The reason this migration exists at all is that `migrate()` does the WRONG half of the
// job on its own, correctly: a DEFAULT change is a modifier change, so it rebuilds the
// table — and a rebuild copies existing values through untouched. New rows get the new
// shape, old rows keep the old one, in the same column.
//
// That is worse than either format alone, and the failure is narrow enough to be worth
// pinning down: both forms open with `YYYY-MM-DD`, so values on DIFFERENT dates still order
// correctly. It is the SAME date that breaks — index 10 is ` ` (0x20) in the space form and
// `T` (0x54) in ISO, so a same-day space-form value always sorts below a same-day ISO one
// whatever the time-of-day. The deploy window is therefore its own blast radius: the rows
// written either side of the change are exactly the same-day pairs that invert.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Entity, defineSchema, defaultTo, expr, ISO_NOW_SQL, type FieldBuilders } from "../packages/server/src/sdk/schema";
import { isoTimestampBackfill, timestampColumns, LEGACY_NOW_SQL } from "../packages/server/src/sdk/iso-timestamps";
import { migrate } from "../packages/server/src/runtime/migrate";
import { bunSqliteDriver } from "./sqlite-driver";
import type { Driver } from "../packages/server/src/runtime/driver";
import type { MigrationContext } from "../packages/server/src/sdk/handlers";

let t!: FieldBuilders;
Entity((b) => ((t = b), { id: b.textId() }));

const SPACE = "2026-06-22 21:33:07";
const ISO = "2026-09-03T21:33:07.222Z";

const schema = defineSchema({
  events: Entity((b) => ({ id: b.textId(), at: defaultTo(b.text(), expr.now()), note: b.text() })),
  // No expr default — the case an app has to name, because there is nothing on the column
  // to find. `cms_pages.publishedAt` is the real instance of this.
  posts: Entity((b) => ({ id: b.textId(), publishedAt: b.text() })),
});

/** A `MigrationContext` over a real SQLite driver. `db` is unused by this migration (it is
 * a bulk `driver.exec` by design), so it is not stubbed with something that would pretend
 * to work. */
function ctxFor(driver: Driver): MigrationContext {
  return {
    driver,
    schema,
    partition: "default",
    get db(): never {
      throw new Error("isoTimestampBackfill must not go row-by-row through ctx.db");
    },
  } as unknown as MigrationContext;
}

async function seeded(): Promise<{ db: Database; driver: Driver }> {
  const db = new Database(":memory:");
  const driver = bunSqliteDriver(db);
  await migrate(driver, schema);
  return { db, driver };
}

describe("why the backfill is needed", () => {
  test("on the SAME date the separator decides, so a same-day pair inverts", () => {
    // 23:00 in the old shape against 01:00 in the new, on one day.
    expect("2026-09-03 23:00:00" < "2026-09-03T01:00:00.000Z").toBe(true);
  });

  test("…but across dates the date prefix still wins, which is why this hides", () => {
    // Most rows keep ordering correctly, so the column looks fine until someone reads a
    // single day's worth of it.
    expect("2026-06-22 21:33:07" < "2020-01-01T00:00:00.000Z").toBe(false);
  });

  test("a `lte: $now()` boundary lets a row dated today through early", () => {
    // `$now()` is ISO. A space-form value dated today is below it whatever the time, so a
    // row scheduled for later today reads as already past — for the rest of the day.
    const nowIso = "2026-09-03T09:00:00.000Z";
    const scheduledForLaterToday = "2026-09-03 23:00:00";
    expect(scheduledForLaterToday <= nowIso).toBe(true);
  });
});

describe("which columns it touches", () => {
  test("every expr.now() column in the partition, found from the schema", () => {
    expect(timestampColumns(schema)).toEqual(new Map([["events", ["at"]]]));
  });

  test("a column with the LEGACY default is recognized too", () => {
    // A store written by an older build has `datetime('now')` in its own DDL. The scan does
    // not depend on `migrate()` having already rebuilt the table.
    const legacy = defineSchema({ events: Entity((b) => ({ id: b.textId(), at: defaultTo(b.text(), expr.raw(LEGACY_NOW_SQL)) })) });
    expect(timestampColumns(legacy).get("events")).toEqual(["at"]);
  });

  test("extra columns are added, and a stale entry is ignored rather than fatal", () => {
    // The list is a hand-written constant an app keeps across schema changes; failing a
    // whole boot over an entry that no longer names a column is the worse outcome.
    const cols = timestampColumns(schema, "default", { posts: ["publishedAt"], gone: ["x"], events: ["nope"] });
    expect(cols.get("posts")).toEqual(["publishedAt"]);
    expect(cols.get("events")).toEqual(["at"]);
    expect(cols.has("gone")).toBe(false);
  });

  test("an extra column already found by the schema is not listed twice", () => {
    expect(timestampColumns(schema, "default", { events: ["at"] }).get("events")).toEqual(["at"]);
  });
});

describe("the rewrite", () => {
  test("space-form values become ISO; ISO values and NULLs are left alone", async () => {
    const { db, driver } = await seeded();
    db.run("INSERT INTO events (id, at, note) VALUES ('a', ?, 'old')", [SPACE]);
    db.run("INSERT INTO events (id, at, note) VALUES ('b', ?, 'new')", [ISO]);
    db.run("INSERT INTO events (id, at, note) VALUES ('c', NULL, 'never')");

    await isoTimestampBackfill().up(ctxFor(driver));

    const rows = db.query("SELECT id, at FROM events ORDER BY id").all() as { id: string; at: string | null }[];
    expect(rows[0]!.at).toBe("2026-06-22T21:33:07.000Z");
    expect(rows[1]!.at).toBe(ISO); // untouched
    expect(rows[2]!.at).toBeNull();
  });

  test("the converted value is the same instant", async () => {
    const { db, driver } = await seeded();
    db.run("INSERT INTO events (id, at) VALUES ('a', ?)", [SPACE]);
    await isoTimestampBackfill().up(ctxFor(driver));
    const { at } = db.query("SELECT at FROM events WHERE id = 'a'").get() as { at: string };
    // The space form is UTC with no zone marker, so reading it as UTC is the only correct
    // reading — and it is what SQLite's own `datetime('now')` meant by it.
    expect(Date.parse(at)).toBe(Date.parse(`${SPACE.replace(" ", "T")}Z`));
  });

  test("ordering is restored for the same-day rows the change straddles", async () => {
    const { db, driver } = await seeded();
    // One day, either side of a deploy: 23:00 written by the old build, 01:00 by the new.
    db.run("INSERT INTO events (id, at) VALUES ('late', '2026-09-03 23:00:00')");
    db.run("INSERT INTO events (id, at) VALUES ('early', '2026-09-03T01:00:00.000Z')");

    const wrong = db.query("SELECT id FROM events ORDER BY at DESC").all() as { id: string }[];
    expect(wrong[0]!.id).toBe("early"); // 01:00 above 23:00 — the bug

    await isoTimestampBackfill().up(ctxFor(driver));
    const after = db.query("SELECT id FROM events ORDER BY at DESC").all() as { id: string }[];
    expect(after[0]!.id).toBe("late"); // 23:00 above 01:00, as it should have been
  });

  test("a second run cannot corrupt what the first converted", async () => {
    // Not required (a data migration is recorded once and need not be idempotent), but this
    // one runs over columns the app also writes, so it is idempotent BY SHAPE: the WHERE
    // matches only the space form, and what it writes is not the space form.
    const { db, driver } = await seeded();
    db.run("INSERT INTO events (id, at) VALUES ('a', ?)", [SPACE]);
    await isoTimestampBackfill().up(ctxFor(driver));
    const once = (db.query("SELECT at FROM events WHERE id = 'a'").get() as { at: string }).at;
    await isoTimestampBackfill().up(ctxFor(driver));
    expect((db.query("SELECT at FROM events WHERE id = 'a'").get() as { at: string }).at).toBe(once);
  });

  test("a value in some third format is left alone rather than guessed at", async () => {
    const { db, driver } = await seeded();
    db.run("INSERT INTO events (id, at) VALUES ('a', '22/06/2026 21:33')");
    db.run("INSERT INTO events (id, at) VALUES ('b', '2026-06-22')");
    await isoTimestampBackfill().up(ctxFor(driver));
    const rows = db.query("SELECT id, at FROM events ORDER BY id").all() as { id: string; at: string }[];
    expect(rows[0]!.at).toBe("22/06/2026 21:33");
    expect(rows[1]!.at).toBe("2026-06-22");
  });

  test("named extra columns are rewritten too", async () => {
    const { db, driver } = await seeded();
    db.run("INSERT INTO posts (id, publishedAt) VALUES ('p', ?)", [SPACE]);
    await isoTimestampBackfill({ extraColumns: { posts: ["publishedAt"] } }).up(ctxFor(driver));
    expect((db.query("SELECT publishedAt FROM posts WHERE id = 'p'").get() as { publishedAt: string }).publishedAt).toBe("2026-06-22T21:33:07.000Z");
  });

  test("without naming it, a column with no expr default is NOT touched", async () => {
    const { db, driver } = await seeded();
    db.run("INSERT INTO posts (id, publishedAt) VALUES ('p', ?)", [SPACE]);
    await isoTimestampBackfill().up(ctxFor(driver));
    expect((db.query("SELECT publishedAt FROM posts WHERE id = 'p'").get() as { publishedAt: string }).publishedAt).toBe(SPACE);
  });

  test("a fresh store pays nothing — every UPDATE matches no rows", async () => {
    const { db, driver } = await seeded();
    db.run("INSERT INTO events (id) VALUES ('a')"); // DB fills `at` with the new default
    const before = (db.query("SELECT at FROM events WHERE id = 'a'").get() as { at: string }).at;
    expect(before).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    await isoTimestampBackfill().up(ctxFor(driver));
    expect((db.query("SELECT at FROM events WHERE id = 'a'").get() as { at: string }).at).toBe(before);
  });
});

describe("the migration's own shape", () => {
  test("it has a stable default ledger id — that is what makes it run once", () => {
    expect(isoTimestampBackfill().id).toBe("pramen:iso-timestamps");
    expect(isoTimestampBackfill({ id: "custom" }).id).toBe("custom");
  });

  test("it is per-partition, because a partition-DO only sees its own tables", () => {
    expect(isoTimestampBackfill().partition).toBe("default");
    expect(isoTimestampBackfill({ partition: "audit" }).partition).toBe("audit");
  });

  test("expr.now() and the scan agree on the SQL", () => {
    expect(expr.now().sql).toBe(ISO_NOW_SQL);
  });
});
