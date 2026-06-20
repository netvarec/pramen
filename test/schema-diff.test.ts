// Unit test for the schema diff that powers `mrak schema diff`. Every change is
// auto-applied on boot; the diff flags whether it's `destructive` (drop / type
// change — rebuilds the table, may lose data) or additive (no data loss).

import { describe, expect, test } from "bun:test";
import { diffSchemaShape, schemaShape, type SchemaShape } from "../src/runtime/schema-diff";
import { Entity, defineSchema } from "../src/sdk/schema";

describe("diffSchemaShape", () => {
  const v1: SchemaShape = { notes: { id: "integer", title: "text" } };

  test("no changes", () => {
    expect(diffSchemaShape(v1, v1)).toEqual([]);
  });

  test("added table and column are non-destructive", () => {
    const v2: SchemaShape = { notes: { id: "integer", title: "text", body: "text" }, tags: { id: "integer" } };
    const changes = diffSchemaShape(v1, v2);
    expect(changes).toContainEqual({ kind: "add-column", table: "notes", column: "body", destructive: false });
    expect(changes).toContainEqual({ kind: "add-table", table: "tags", destructive: false });
    expect(changes.every((c) => !c.destructive)).toBe(true);
  });

  test("dropped column / table and type change are destructive", () => {
    const v2: SchemaShape = { notes: { id: "text" } }; // title dropped, id type changed, no tags…
    const prev: SchemaShape = { notes: { id: "integer", title: "text" }, tags: { id: "integer" } };
    const changes = diffSchemaShape(prev, v2);
    expect(changes).toContainEqual({ kind: "change-type", table: "notes", column: "id", detail: "integer → text", destructive: true });
    expect(changes).toContainEqual({ kind: "drop-column", table: "notes", column: "title", destructive: true });
    expect(changes).toContainEqual({ kind: "drop-table", table: "tags", destructive: true });
    expect(changes.every((c) => c.destructive)).toBe(true);
  });

  test("schemaShape reads field types from a real schema", () => {
    const schema = defineSchema({ notes: Entity((t) => ({ id: t.id(), title: t.text(), views: t.int() })) });
    expect(schemaShape(schema)).toEqual({ notes: { id: "integer", title: "text", views: "integer" } });
  });
});
