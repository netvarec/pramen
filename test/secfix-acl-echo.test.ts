// A write echo (the row `insert`/`update` return) never reveals more than a read of that
// row would. The echo used to add the caller's readable FIELDS whenever the read scope was
// allowed at all, without asking whether the read scope's `where` admits the written row,
// so a caller who may update (or create) rows it cannot read got every readable column of
// such a row back. Dummy data, in-memory bun:sqlite.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Entity, defineSchema } from "../packages/server/src/sdk/schema";
import { $identity, allow, policy, role } from "../packages/server/src/sdk/acl";
import { compileAcl } from "../packages/server/src/runtime/acl";
import { Db } from "../packages/server/src/runtime/db";
import { migrate } from "../packages/server/src/runtime/migrate";
import { bunSqliteDriver } from "./sqlite-driver";

const schema = defineSchema({
  teams: Entity((t) => ({ id: t.id(), owner: t.text() })),
  docs: Entity(
    (t) => ({
      id: t.id(),
      title: t.text(),
      secret: t.text(),
      ownerId: t.text(),
      teamId: t.int(),
      status: { ...t.text(), default: "draft" },
    }),
    (r) => ({ team: r.belongsTo("teams", "teamId") }),
  ),
});

async function setup(readWhere: Record<string, unknown>) {
  const driver = bunSqliteDriver(new Database(":memory:"));
  await migrate(driver, schema);
  const sys = new Db(driver, { acl: compileAcl([]), identity: null, schema, system: true }, schema) as any;
  const mineTeam = (await sys.insert("teams", { owner: "u1" })).id;
  const otherTeam = (await sys.insert("teams", { owner: "u2" })).id;
  const mine = await sys.insert("docs", { title: "mine", secret: "s-mine", ownerId: "u1", teamId: mineTeam });
  const theirs = await sys.insert("docs", { title: "theirs", secret: "s-theirs", ownerId: "u2", teamId: otherTeam });
  const roles = [
    role("w", [
      policy("w:teams", "teams", "read", allow()),
      // Writes reach every row; reads only the caller's own.
      policy("w:read", "docs", "read", { where: readWhere }),
      policy("w:update", "docs", "update", allow()),
      policy("w:create", "docs", "create", allow()),
    ]),
  ];
  const db = new Db(driver, { acl: compileAcl(roles), identity: { userId: "u1", roles: ["w"] }, schema }, schema) as any;
  return { sys, db, mine, theirs, mineTeam, otherTeam };
}

const own = { ownerId: $identity("userId") };
const ownTeam = { team: { owner: $identity("userId") } };

describe("the write echo honors the read scope's where", () => {
  for (const [label, where] of [["single-table where", own], ["relation-traversing where", ownTeam]] as const) {
    describe(label, () => {
      test("update of a row the caller can't read echoes only the PK and the written columns", async () => {
        const s = await setup(where);
        expect(await s.db.find({ from: "docs", where: { id: s.theirs.id } })).toEqual([]);
        const echo = await s.db.update("docs", s.theirs.id, { title: "renamed" });
        expect(echo).toEqual({ id: s.theirs.id, title: "renamed" });
        // The write itself went through: this is about what comes back, not the write.
        expect((await s.sys.find({ from: "docs", where: { id: s.theirs.id } }))[0].title).toBe("renamed");
      });

      test("update of a readable row still echoes every readable column", async () => {
        const s = await setup(where);
        const echo = await s.db.update("docs", s.mine.id, { title: "renamed" });
        expect(echo).toMatchObject({ id: s.mine.id, title: "renamed", secret: "s-mine", ownerId: "u1", status: "draft" });
      });

      test("insert of a row outside the read scope echoes no defaulted or unwritten column", async () => {
        const s = await setup(where);
        const echo = await s.db.insert("docs", { title: "t", secret: "x", ownerId: "u2", teamId: s.otherTeam });
        expect(Object.keys(echo).sort()).toEqual(["id", "ownerId", "secret", "teamId", "title"]);
        expect(echo.status).toBeUndefined();
      });

      test("insert of a row inside the read scope echoes the defaulted column too", async () => {
        const s = await setup(where);
        const echo = await s.db.insert("docs", { title: "t", secret: "x", ownerId: "u1", teamId: s.mineTeam });
        expect(echo.status).toBe("draft");
      });
    });
  }

  test("the echo is judged on the POST-image: moving a row out of the read scope narrows it", async () => {
    const s = await setup(own);
    const echo = await s.db.update("docs", s.mine.id, { ownerId: "u2" });
    expect(echo).toEqual({ id: s.mine.id, ownerId: "u2" });
  });
});
