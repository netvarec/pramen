import { defineCollection, glob, z } from "pletivo/content";

// Each doc page carries a title, a sort `order` for the nav, and a short summary.
const docSchema = z.object({
  title: z.string(),
  order: z.number(),
  summary: z.string().default(""),
});

export const collections = {
  docs: defineCollection({
    loader: glob({ base: "src/content/docs" }),
    schema: docSchema,
  }),
};
