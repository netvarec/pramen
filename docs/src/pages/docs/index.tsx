import { getCollection } from "pletivo/content";
import type { CollectionEntry } from "pletivo/content";
import Layout from "../../components/Layout";

const byOrder = (a: CollectionEntry, b: CollectionEntry) =>
  (a.data.order as number) - (b.data.order as number);

export default async function DocsIndex() {
  const docs = (await getCollection("docs")).sort(byOrder);
  return (
    <Layout title="Docs" nav={docs}>
      <article class="doc">
        <h1>Documentation</h1>
        <p class="lede" style="color: var(--muted); font-size: 1.1rem;">
          Everything you need to build on pramen — from schema and handlers to ACL, live queries, and deploy.
        </p>
        <ul class="doc-index">
          {docs.map((doc) => (
            <li>
              <a class="card" href={`/docs/${doc.id}`}>
                <span class="t">{doc.data.title as string}</span>
                <p>{doc.data.summary as string}</p>
              </a>
            </li>
          ))}
        </ul>
      </article>
    </Layout>
  );
}
