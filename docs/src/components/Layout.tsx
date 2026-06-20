import type { CollectionEntry } from "pletivo/content";

export interface TocItem {
  depth: number;
  id: string;
  text: string;
}

// Client-side polish (vanilla, runs on every page): copy buttons on code blocks
// and a scroll-spy that highlights the current heading in the "On this page" rail.
const ENHANCE_JS = `
(function () {
  document.querySelectorAll('.doc pre').forEach(function (pre) {
    var code = pre.querySelector('code');
    var btn = document.createElement('button');
    btn.className = 'copy-btn'; btn.type = 'button'; btn.textContent = 'Copy';
    btn.addEventListener('click', function () {
      navigator.clipboard.writeText((code || pre).innerText).then(function () {
        btn.textContent = 'Copied'; btn.classList.add('copied');
        setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
      });
    });
    pre.appendChild(btn);
  });

  var links = {};
  document.querySelectorAll('.toc-link').forEach(function (a) {
    links[a.getAttribute('href').slice(1)] = a;
  });
  var heads = document.querySelectorAll('.doc h2[id], .doc h3[id]');
  if (heads.length && Object.keys(links).length) {
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        Object.keys(links).forEach(function (k) { links[k].classList.remove('active'); });
        var a = links[e.target.id]; if (a) a.classList.add('active');
      });
    }, { rootMargin: '0px 0px -78% 0px', threshold: 0 });
    heads.forEach(function (h) { obs.observe(h); });
  }
})();
`;

// Shared page shell: header, left nav (every doc), main content, and an optional
// right-hand "On this page" rail driven by the page's headings.
export default function Layout(props: {
  title: string;
  nav: CollectionEntry[];
  current?: string;
  toc?: TocItem[];
  children?: unknown;
}) {
  const hasToc = !!props.toc && props.toc.length > 1;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title} — mrak</title>
        <meta name="description" content="mrak — a reactive backend runtime for TypeScript on Cloudflare." />
        <link rel="stylesheet" href="/style.css" />
      </head>
      <body>
        <header class="site-header">
          <a class="brand" href="/">mrak</a>
          <span class="tagline">reactive backend runtime for TypeScript on Cloudflare</span>
        </header>
        <div class={hasToc ? "layout has-toc" : "layout"}>
          <aside class="sidebar">
            <nav>
              <a
                class={props.current === "__wizard" ? "nav-link nav-wizard active" : "nav-link nav-wizard"}
                href="/choose-store"
              >
                🧭 Choose a store
              </a>
              {props.nav.map((entry) => (
                <a class={entry.id === props.current ? "nav-link active" : "nav-link"} href={`/docs/${entry.id}`}>
                  {entry.data.title as string}
                </a>
              ))}
            </nav>
          </aside>
          <main class="content">{props.children}</main>
          {hasToc && (
            <aside class="toc">
              <div class="toc-title">On this page</div>
              <nav class="toc-list">
                {props.toc!.map((h) => (
                  <a class={`toc-link depth-${h.depth}`} href={`#${h.id}`}>
                    {h.text}
                  </a>
                ))}
              </nav>
            </aside>
          )}
        </div>
        <script dangerouslySetInnerHTML={{ __html: ENHANCE_JS }} />
      </body>
    </html>
  );
}
