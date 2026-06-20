# pramen docs

Documentation site for pramen, built with [pletivo](https://github.com/contember/pletivo)
(a Bun-powered static site generator). Standalone from the pramen workspace — install
and run from this directory.

```bash
cd docs
bun install
bun run dev     # pletivo dev server (HMR)
bun run build   # static site -> dist/
```

Pages live as markdown in `src/content/docs/*.md` (frontmatter: `title`, `order`,
`summary`). The nav and routing are driven by the `docs` content collection; add a
new `.md` file to add a page.
