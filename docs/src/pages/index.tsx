import { getCollection } from "pletivo/content";
import type { CollectionEntry } from "pletivo/content";
import Layout from "../components/Layout";

const byOrder = (a: CollectionEntry, b: CollectionEntry) =>
  (a.data.order as number) - (b.data.order as number);

export default async function Home() {
  const docs = (await getCollection("docs")).sort(byOrder);
  const first = docs[0];
  return (
    <Layout title="pramen" nav={docs}>
      <article class="doc hero">
        <h1>pramen</h1>
        <p class="lede">
          A reactive backend runtime for TypeScript on Cloudflare. Define a schema and handlers; get a complete backend
          deployed as a Worker + per-tenant Durable Object — with row- and cell-level ACL, live queries, and typed
          end-to-end clients.
        </p>
        <p class="hero-ctas">
          {first && (
            <a class="cta" href={`/docs/${first.id}`}>
              Read the docs →
            </a>
          )}
          <a class="cta cta-ghost" href="/choose-store">
            🧭 Choose a store
          </a>
        </p>
      </article>
    </Layout>
  );
}
