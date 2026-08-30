// D1 has NO interactive transactions: `D1Driver.transaction(fn)` runs `fn` as-is, so a
// mutation that throws midway keeps whatever it already wrote. That is a documented,
// deliberate limit — but it used to be documented only in a source comment, and in
// production a partially-applied mutation looks exactly like an ordinary 500.
//
// These pin the write counter that lets the Worker say so out loud.

import { describe, expect, test } from "bun:test";
import { D1Driver } from "../packages/server/src/runtime/driver";

/** A fake D1 session — enough to count what the driver sends. */
function fakeD1(onExec?: (sql: string) => void) {
  const session = {
    prepare(sql: string) {
      const stmt = {
        bind: () => stmt,
        all: async () => {
          onExec?.(sql);
          return { results: [] };
        },
      };
      return stmt;
    },
    getBookmark: () => null,
    batch: async () => {},
  };
  return { withSession: () => session } as unknown as D1Database;
}

describe("D1Driver write accounting", () => {
  test("a read-only session reports no writes", async () => {
    const d = new D1Driver(fakeD1());
    await d.exec("SELECT * FROM notes WHERE id = ?", ["x"]);
    await d.exec("  select count(*) from notes", []);
    expect(d.writtenCount()).toBe(0);
  });

  test("every statement shape that mutates is counted", async () => {
    const d = new D1Driver(fakeD1());
    for (const sql of [
      "INSERT INTO notes (id) VALUES (?)",
      "update notes set title = ?",
      "DELETE FROM notes WHERE id = ?",
      "REPLACE INTO notes (id) VALUES (?)",
      "  \n  CREATE TABLE x (id TEXT)",
      "DROP TABLE x",
      "ALTER TABLE notes ADD COLUMN body TEXT",
    ]) {
      await d.exec(sql, []);
    }
    expect(d.writtenCount()).toBe(7);
  });

  // The count is what distinguishes "the request failed" from "the request failed and left
  // half a mutation behind" — the only signal available, since there is nothing to roll back.
  test("a mutation that throws midway still reports what it committed", async () => {
    const d = new D1Driver(
      fakeD1((sql) => {
        if (sql.startsWith("DELETE")) throw new Error("boom");
      }),
    );
    await d.exec("INSERT INTO notes (id) VALUES (?)", ["a"]);
    await expect(d.exec("DELETE FROM notes WHERE id = ?", ["a"])).rejects.toThrow("boom");
    expect(d.writtenCount()).toBe(2); // counted before the statement ran — the insert DID commit
  });

  // `transaction` is a pass-through by design; pinning it stops someone "fixing" it into a
  // shape that silently swallows the limitation.
  test("transaction() is a pass-through, and a throw inside it does NOT roll back", async () => {
    const d = new D1Driver(fakeD1());
    await expect(
      d.transaction(async () => {
        await d.exec("INSERT INTO notes (id) VALUES (?)", ["a"]);
        throw new Error("mutation failed");
      }),
    ).rejects.toThrow("mutation failed");
    expect(d.writtenCount()).toBe(1); // the insert stands
  });
});
