// Unit test for the schema diff that powers `pramen schema diff`. The diff REPORTS
// changes; the boot migrator only applies additive ones (and destructive ones under
// PRAMEN_ALLOW_DESTRUCTIVE). Each change carries `destructive` (rebuilds/may lose data)
// and `appliesOnBoot` (whether boot migration enacts it at all — false for modifier
// changes on an existing column and for partition moves).

import { describe, expect, test } from "bun:test";
import { diffSchemaShape, schemaShape, type SchemaShape } from "../packages/server/src/runtime/schema-diff";
import { Entity, defineSchema, notNull, unique, defaultTo } from "../packages/server/src/sdk/schema";

const shape = (cols: SchemaShape[string]["columns"], partition = "default"): SchemaShape[string] => ({
  partition,
  columns: cols,
});

describe("diffSchemaShape", () => {
  const v1: SchemaShape = { notes: shape({ id: { type: "integer" }, title: { type: "text" } }) };

  test("no changes", () => {
    expect(diffSchemaShape(v1, v1)).toEqual([]);
  });

  test("added table and column are non-destructive and apply on boot", () => {
    const v2: SchemaShape = {
      notes: shape({ id: { type: "integer" }, title: { type: "text" }, body: { type: "text" } }),
      tags: shape({ id: { type: "integer" } }),
    };
    const changes = diffSchemaShape(v1, v2);
    expect(changes).toContainEqual({
      kind: "add-column",
      table: "notes",
      column: "body",
      destructive: false,
      appliesOnBoot: true,
    });
    expect(changes).toContainEqual({ kind: "add-table", table: "tags", destructive: false, appliesOnBoot: true });
    expect(changes.every((c) => !c.destructive && c.appliesOnBoot)).toBe(true);
  });

  test("dropped column / table and type change are destructive", () => {
    const v2: SchemaShape = { notes: shape({ id: { type: "text" } }) }; // title dropped, id type changed
    const prev: SchemaShape = {
      notes: shape({ id: { type: "integer" }, title: { type: "text" } }),
      tags: shape({ id: { type: "integer" } }),
    };
    const changes = diffSchemaShape(prev, v2);
    expect(changes).toContainEqual({
      kind: "change-type",
      table: "notes",
      column: "id",
      detail: "integer → text",
      destructive: true,
      appliesOnBoot: true,
    });
    expect(changes).toContainEqual({
      kind: "drop-column",
      table: "notes",
      column: "title",
      destructive: true,
      appliesOnBoot: true,
    });
    expect(changes).toContainEqual({ kind: "drop-table", table: "tags", destructive: true, appliesOnBoot: true });
    expect(changes.every((c) => c.destructive)).toBe(true);
  });

  test("a modifier change on an existing column is reported but NOT applied on boot", () => {
    const prev: SchemaShape = { notes: shape({ id: { type: "integer" }, code: { type: "text" } }) };
    const next: SchemaShape = {
      notes: shape({ id: { type: "integer" }, code: { type: "text", notNull: true, unique: true } }),
    };
    const changes = diffSchemaShape(prev, next);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: "change-column",
      table: "notes",
      column: "code",
      destructive: false,
      appliesOnBoot: false,
    });
    expect(changes[0]!.detail).toContain("notNull");
    expect(changes[0]!.detail).toContain("unique");
  });

  test("a partition move is reported and flagged as NOT applied on boot", () => {
    const prev: SchemaShape = { audit: shape({ id: { type: "integer" } }, "default") };
    const next: SchemaShape = { audit: shape({ id: { type: "integer" } }, "logs") };
    const changes = diffSchemaShape(prev, next);
    expect(changes).toContainEqual({
      kind: "move-partition",
      table: "audit",
      detail: "default → logs",
      destructive: false,
      appliesOnBoot: false,
    });
  });

  test("schemaShape captures type, modifiers, default and partition from a real schema", () => {
    const schema = defineSchema({
      notes: Entity((t) => ({
        id: t.id(),
        code: unique(notNull(t.text())),
        status: defaultTo(t.text(), "pending"),
      })),
    });
    expect(schemaShape(schema)).toEqual({
      notes: {
        partition: "default",
        columns: {
          id: { type: "integer", primaryKey: true, notNull: true },
          code: { type: "text", notNull: true, unique: true },
          status: { type: "text", default: '"pending"' },
        },
      },
    });
  });
});
