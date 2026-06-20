import { getCollection } from "pletivo/content";
import type { CollectionEntry } from "pletivo/content";
import Layout from "../components/Layout";
import StoreWizard from "../islands/StoreWizard";

const byOrder = (a: CollectionEntry, b: CollectionEntry) =>
  (a.data.order as number) - (b.data.order as number);

export default async function ChooseStore() {
  const docs = (await getCollection("docs")).sort(byOrder);
  return (
    <Layout title="Choose a store" nav={docs} current="__wizard">
      <article class="doc">
        <h1>Choose your store</h1>
        <p class="lede">
          pramen runs the same schema, handlers, and ACL over different stores — that's the Driver seam. Answer a couple
          of questions about your use-case and we'll point you at the right one.
        </p>
        <StoreWizard client="load" />
      </article>
    </Layout>
  );
}
