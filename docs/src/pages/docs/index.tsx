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
        <ul class="doc-index">
          {docs.map((doc) => (
            <li>
              <a href={`/docs/${doc.id}`}>{doc.data.title as string}</a>
              <p>{doc.data.summary as string}</p>
            </li>
          ))}
        </ul>
      </article>
    </Layout>
  );
}
