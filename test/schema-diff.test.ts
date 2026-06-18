// Unit test for the schema diff that powers `mrak schema diff`: additive changes
// are `safe` (applied by migrate()); drops / type changes are `unsafe`.

import { describe, expect, test } from "bun:test";
import { diffSchemaShape, schemaShape, type SchemaShape } from "../src/runtime/schema-diff";
import { Entity, defineSchema } from "../src/sdk/schema";

describe("diffSchemaShape", () => {
  const v1: SchemaShape = { notes: { id: "integer", title: "text" } };

  test("no changes", () => {
    expect(diffSchemaShape(v1, v1)).toEqual([]);
  });

  test("added table and column are safe", () => {
    const v2: SchemaShape = { notes: { id: "integer", title: "text", body: "text" }, tags: { id: "integer" } };
    const changes = diffSchemaShape(v1, v2);
    expect(changes).toContainEqual({ kind: "add-column", table: "notes", column: "body", safe: true });
    expect(changes).toContainEqual({ kind: "add-table", table: "tags", safe: true });
    expect(changes.every((c) => c.safe)).toBe(true);
  });

  test("dropped column / table and type change are unsafe", () => {
    const v2: SchemaShape = { notes: { id: "text" } }; // title dropped, id type changed, no tags…
    const prev: SchemaShape = { notes: { id: "integer", title: "text" }, tags: { id: "integer" } };
    const changes = diffSchemaShape(prev, v2);
    expect(changes).toContainEqual({ kind: "change-type", table: "notes", column: "id", detail: "integer → text", safe: false });
    expect(changes).toContainEqual({ kind: "drop-column", table: "notes", column: "title", safe: false });
    expect(changes).toContainEqual({ kind: "drop-table", table: "tags", safe: false });
    expect(changes.some((c) => c.safe)).toBe(false);
  });

  test("schemaShape reads field types from a real schema", () => {
    const schema = defineSchema({ notes: Entity((t) => ({ id: t.id(), title: t.text(), views: t.int() })) });
    expect(schemaShape(schema)).toEqual({ notes: { id: "integer", title: "text", views: "integer" } });
  });
});
