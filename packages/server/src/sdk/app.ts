// createApp — binds the handler factories to a concrete schema so `ctx.db` is
// fully typed (table names, where columns/values, row results, insert shapes).
//
//   const schema = defineSchema({ notes: Entity(t => ({ ... })) });
//   const { query, mutation } = createApp(schema);
//   const listNotes = query((ctx) => ctx.db.find({ from: "notes" })); // typed!

import type { Handler, HandlerContext, HandlerOpts } from "./handlers";
import type { SchemaDef } from "./schema";

export function createApp<S extends SchemaDef>(schema: S) {
  type Ctx = HandlerContext<S>;

  const query = <I = unknown, O = unknown>(
    run: (ctx: Ctx, input: I) => O | Promise<O>,
    opts?: HandlerOpts<I>,
  ): Handler<I, O> => ({ kind: "query", run: run as Handler<I, O>["run"], input: opts?.input, partition: opts?.partition });

  const mutation = <I = unknown, O = unknown>(
    run: (ctx: Ctx, input: I) => O | Promise<O>,
    opts?: HandlerOpts<I>,
  ): Handler<I, O> => ({ kind: "mutation", run: run as Handler<I, O>["run"], input: opts?.input, partition: opts?.partition });

  return { schema, query, mutation };
}
