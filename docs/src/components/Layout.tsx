import type { CollectionEntry } from "pletivo/content";

// Shared page shell: a sidebar listing every doc (sorted by `order`) and the
// rendered content in the main column.
export default function Layout(props: {
  title: string;
  nav: CollectionEntry[];
  current?: string;
  children?: unknown;
}) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title} — mrak</title>
        <link rel="stylesheet" href="/style.css" />
      </head>
      <body>
        <header class="site-header">
          <a class="brand" href="/">mrak</a>
          <span class="tagline">reactive backend runtime for TypeScript on Cloudflare</span>
        </header>
        <div class="layout">
          <aside class="sidebar">
            <nav>
              {props.nav.map((entry) => (
                <a
                  class={entry.id === props.current ? "nav-link active" : "nav-link"}
                  href={`/docs/${entry.id}`}
                >
                  {entry.data.title as string}
                </a>
              ))}
            </nav>
          </aside>
          <main class="content">{props.children}</main>
        </div>
      </body>
    </html>
  );
}
