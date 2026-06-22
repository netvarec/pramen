// Unit test for entity partitions — `Entity(..., { partition })` and the
// partitionOf / partitionsOf / entitiesInPartition helpers that the migrator/admin
// use to group tables per Durable Object class.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PARTITION,
  Entity,
  defineSchema,
  entitiesInPartition,
  partitionOf,
  partitionsOf,
} from "../packages/server/src/sdk/schema";

describe("entity partition", () => {
  test("defaults to \"default\" with no opts", () => {
    const e = Entity((t) => ({ id: t.id(), title: t.text() }));
    expect(e.partition).toBe("default");
    expect(DEFAULT_PARTITION).toBe("default");
  });

  test("relations builder still works and partition stays \"default\"", () => {
    const e = Entity(
      (t) => ({ id: t.id(), authorId: t.int() }),
      (r) => ({ author: r.belongsTo("users", "authorId") }),
    );
    expect(e.partition).toBe("default");
    expect(e.relations.author).toEqual({ kind: "belongsTo", target: "users", column: "authorId" });
  });

  test("opts.partition sets the partition (with relations)", () => {
    const e = Entity(
      (t) => ({ id: t.id(), event: t.text() }),
      (r) => ({}),
      { partition: "audit" },
    );
    expect(e.partition).toBe("audit");
  });

  test("opts.partition sets the partition (without relations)", () => {
    const e = Entity((t) => ({ id: t.id() }), undefined, { partition: "audit" });
    expect(e.partition).toBe("audit");
  });
});

describe("partition helpers", () => {
  const schema = defineSchema({
    notes: Entity((t) => ({ id: t.id(), title: t.text() })),
    tags: Entity((t) => ({ id: t.id() })),
    auditLog: Entity((t) => ({ id: t.id(), event: t.text() }), undefined, { partition: "audit" }),
    metrics: Entity((t) => ({ id: t.id() }), undefined, { partition: "analytics" }),
  });

  test("partitionOf resolves declared and default partitions", () => {
    expect(partitionOf(schema, "notes")).toBe("default");
    expect(partitionOf(schema, "auditLog")).toBe("audit");
    expect(partitionOf(schema, "metrics")).toBe("analytics");
  });

  test("partitionOf falls back to DEFAULT_PARTITION for unknown entity", () => {
    expect(partitionOf(schema, "nope")).toBe(DEFAULT_PARTITION);
  });

  test("partitionsOf returns distinct names in stable first-seen order", () => {
    expect(partitionsOf(schema)).toEqual(["default", "audit", "analytics"]);
  });

  test("entitiesInPartition groups tables by partition", () => {
    expect(entitiesInPartition(schema, "default")).toEqual(["notes", "tags"]);
    expect(entitiesInPartition(schema, "audit")).toEqual(["auditLog"]);
    expect(entitiesInPartition(schema, "analytics")).toEqual(["metrics"]);
    expect(entitiesInPartition(schema, "missing")).toEqual([]);
  });
});
