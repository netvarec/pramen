import { getCollection } from "pletivo/content";
import type { CollectionEntry } from "pletivo/content";
import Layout from "../../components/Layout";

const byOrder = (a: CollectionEntry, b: CollectionEntry) =>
  (a.data.order as number) - (b.data.order as number);

export async function getStaticPaths() {
  const docs = (await getCollection("docs")).sort(byOrder);
  return await Promise.all(
    docs.map(async (doc) => {
      const { html } = await doc.render();
      return { params: { slug: doc.id }, props: { doc, html, nav: docs } };
    }),
  );
}

export default function DocPage(props: { doc: CollectionEntry; html: string; nav: CollectionEntry[] }) {
  return (
    <Layout title={props.doc.data.title as string} nav={props.nav} current={props.doc.id}>
      <article class="doc">
        <h1>{props.doc.data.title as string}</h1>
        <div dangerouslySetInnerHTML={{ __html: props.html }} />
      </article>
    </Layout>
  );
}
