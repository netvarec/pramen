// Unit test for validateSchema — the static schema invariants enforced before
// migrate (relation targets exist, no relation crosses a partition boundary).

import { describe, expect, test } from "bun:test";
import { Entity, defineSchema, validateSchema } from "../packages/server/src/sdk/schema";

describe("validateSchema", () => {
  test("same-partition relations validate clean", () => {
    const schema = defineSchema({
      users: Entity((t) => ({ id: t.id(), name: t.text() })),
      notes: Entity(
        (t) => ({ id: t.id(), authorId: t.int() }),
        (r) => ({ author: r.belongsTo("users", "authorId") }),
      ),
    });
    expect(() => validateSchema(schema)).not.toThrow();
  });

  test("relations across explicit non-default partitions validate clean when matched", () => {
    const schema = defineSchema({
      auditLog: Entity((t) => ({ id: t.id(), event: t.text() }), undefined, { partition: "audit" }),
      auditMeta: Entity(
        (t) => ({ id: t.id(), logId: t.int() }),
        (r) => ({ log: r.belongsTo("auditLog", "logId") }),
        { partition: "audit" },
      ),
    });
    expect(() => validateSchema(schema)).not.toThrow();
  });

  test("a cross-partition relation throws, naming the relation + both partitions + target", () => {
    const schema = defineSchema({
      users: Entity((t) => ({ id: t.id(), name: t.text() }), undefined, { partition: "audit" }),
      notes: Entity(
        (t) => ({ id: t.id(), authorId: t.int() }),
        (r) => ({ author: r.belongsTo("users", "authorId") }),
      ),
    });
    expect(() => validateSchema(schema)).toThrow(
      "relation 'notes.author' crosses a partition boundary: 'notes' is in partition " +
        "'default' but target 'users' is in 'audit'. Relations cannot cross partitions — " +
        "put both entities in the same partition or drop the relation.",
    );
  });

  test("a relation to a non-existent target throws", () => {
    const schema = defineSchema({
      notes: Entity(
        (t) => ({ id: t.id(), authorId: t.int() }),
        (r) => ({ author: r.belongsTo("nope", "authorId") }),
      ),
    });
    expect(() => validateSchema(schema)).toThrow(
      "relation 'notes.author' targets unknown entity 'nope' — " +
        "no such entity in the schema. Check the relation target name.",
    );
  });

  test("relationless / single-partition schema validates clean", () => {
    const schema = defineSchema({
      notes: Entity((t) => ({ id: t.id(), title: t.text() })),
      tags: Entity((t) => ({ id: t.id() })),
    });
    expect(() => validateSchema(schema)).not.toThrow();
  });
});
