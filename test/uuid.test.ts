// Unit tests for the `uuid` field type: the isValidUuid validator, the builder +
// primaryKey()/generated() modifiers, the generated()-on-non-uuid guard, and the
// TEXT storage mapping. Auto-generation + write-validation through Db are exercised
// end-to-end by test/suites/uuid.ts.

import { describe, expect, test } from "bun:test";
import { Entity, primaryKey, generated, unique, type FieldBuilders, type FieldDef } from "../packages/server/src/sdk/schema";
import { isValidUuid } from "../packages/server/src/sdk/uuid";
import { sqlType } from "../packages/server/src/runtime/ddl";

// The field builders are only handed to the Entity callback; capture them once so the
// tests can call t.uuid()/t.text() directly.
let t!: FieldBuilders;
Entity((b) => ((t = b), { id: b.textId() }));

describe("isValidUuid", () => {
  test("accepts a canonical uuid (any version)", () => {
    expect(isValidUuid("9f1c2e3a-4b5d-4e6f-8a9b-0c1d2e3f4a5b")).toBe(true);
    expect(isValidUuid(crypto.randomUUID())).toBe(true);
    expect(isValidUuid("0190d4e2-7c1a-7c2b-9c3d-4e5f60718293")).toBe(true); // v7-shaped
  });
  test("rejects malformed / non-string", () => {
    expect(isValidUuid("not-a-uuid")).toBe(false);
    expect(isValidUuid("9f1c2e3a4b5d4e6f8a9b0c1d2e3f4a5b")).toBe(false); // no dashes
    expect(isValidUuid("")).toBe(false);
    expect(isValidUuid(123)).toBe(false);
    expect(isValidUuid(null)).toBe(false);
  });
});

describe("uuid builder + modifiers", () => {
  test("t.uuid() is a uuid column", () => {
    expect(t.uuid()).toEqual({ type: "uuid" });
  });
  test("generated() marks a uuid column generated", () => {
    expect(generated(t.uuid())).toEqual({ type: "uuid", generated: true });
  });
  test("primaryKey() implies notNull and composes with generated()", () => {
    expect(primaryKey(generated(t.uuid()))).toEqual({
      type: "uuid",
      generated: true,
      primaryKey: true,
      notNull: true,
    });
  });
  test("unique() composes with a uuid column", () => {
    expect(unique(t.uuid())).toEqual({ type: "uuid", unique: true });
  });
  test("generated() is rejected on a non-uuid column", () => {
    expect(() => generated(t.text())).toThrow(/only valid on a uuid column/);
    expect(() => generated(t.int())).toThrow(/got 'integer'/);
  });
  test("a uuid PK entity carries the field shape", () => {
    const e = Entity((b) => ({ id: primaryKey(generated(b.uuid())) }));
    const id = e.fields.id as FieldDef;
    expect(id.type).toBe("uuid");
    expect(id.primaryKey).toBe(true);
    expect(id.generated).toBe(true);
  });
});

describe("uuid storage", () => {
  test("a uuid column is stored as TEXT", () => {
    expect(sqlType({ type: "uuid" })).toBe("TEXT");
    expect(sqlType({ type: "uuid", primaryKey: true, notNull: true })).toBe("TEXT");
  });
});
