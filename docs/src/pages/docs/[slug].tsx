import { getCollection } from "pletivo/content";
import type { CollectionEntry } from "pletivo/content";
import hljs from "highlight.js";
import Layout, { type TocItem } from "../../components/Layout";

const byOrder = (a: CollectionEntry, b: CollectionEntry) =>
  (a.data.order as number) - (b.data.order as number);

// pletivo emits ```lang blocks as `<pre><code class="language-x">…</code></pre>`
// with `<`/`&` HTML-encoded. Decode, run highlight.js, and re-emit token spans —
// all at build time, so the published HTML is already highlighted (no client JS).
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function highlightCode(html: string): string {
  return html.replace(
    /<pre><code class="language-([\w-]+)">([\s\S]*?)<\/code><\/pre>/g,
    (_full, lang: string, body: string) => {
      const code = decodeEntities(body);
      const out = hljs.getLanguage(lang)
        ? hljs.highlight(code, { language: lang }).value
        : hljs.highlightAuto(code).value;
      return `<pre><code class="hljs language-${lang}">${out}</code></pre>`;
    },
  );
}

// Build the "On this page" rail from the rendered markdown's h2/h3 (pletivo adds
// stable `id`s to headings). Strip any inline tags from the label.
function extractToc(html: string): TocItem[] {
  const toc: TocItem[] = [];
  const re = /<h([23])\s+[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    toc.push({ depth: Number(m[1]), id: m[2]!, text: decodeEntities(m[3]!.replace(/<[^>]+>/g, "")).trim() });
  }
  return toc;
}

export async function getStaticPaths() {
  const docs = (await getCollection("docs")).sort(byOrder);
  return await Promise.all(
    docs.map(async (doc) => {
      const rendered = await doc.render();
      const html = highlightCode(rendered.html);
      return { params: { slug: doc.id }, props: { doc, html, nav: docs, toc: extractToc(html) } };
    }),
  );
}

export default function DocPage(props: { doc: CollectionEntry; html: string; nav: CollectionEntry[]; toc: TocItem[] }) {
  return (
    <Layout title={props.doc.data.title as string} nav={props.nav} current={props.doc.id} toc={props.toc}>
      <article class="doc">
        <h1>{props.doc.data.title as string}</h1>
        <div dangerouslySetInnerHTML={{ __html: props.html }} />
      </article>
    </Layout>
  );
}
