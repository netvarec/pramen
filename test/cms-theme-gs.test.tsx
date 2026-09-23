// @pramen/cms-theme-gs: the Graphic Standard theme's behaviour, without a browser.
//
// Ported from the deployment the theme was lifted out of (praha-sportovni's
// `src/admin/gs/*.test.ts`), minus what was that project's own: its events panel and its venue
// statistics are now a project-side COMPOSITION over the theme, and the tests for that pattern
// are here too, because "a project can wrap the GS nav and the GS dashboard" is a promise the
// theme makes. The bundle half (every slot lands in a real build against podoba 0.0.42) is in
// `cms-theme-gs-host-build.test.ts`.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { configureI18n } from "@pramen/cms-editor/i18n";
import type { HomeScreenProps, NavContext, NavSection } from "@pramen/cms-editor/slots";
import { buildNav, navSections } from "../packages/cms-editor/src/nav";
import { DEFAULT_CAPABILITIES, type AdminPageMeta, type ContentType, type RpcInput } from "../packages/cms-editor/src/types";
import { EDITOR_SLOTS } from "../packages/cms-editor/src/build-editor";
import { gsEditor, GS_SLOTS, GS_STYLESHEET } from "../packages/cms-theme-gs/src/build";
import { gsAdmin } from "../packages/cms-theme-gs/src/config.js";
import { cs, en } from "../packages/cms-theme-gs/src/copy";
import { allPages, loadCollectionStat, loadContentTypeStat, loadMediaStat } from "../packages/cms-theme-gs/src/dashboard-data";
import { DetailHeader } from "../packages/cms-theme-gs/src/detail-header";
import { createHomeScreen, HomeScreen } from "../packages/cms-theme-gs/src/home";
import { MediaGrid, MediaLibraryEmpty } from "../packages/cms-theme-gs/src/media-grid";
import { composeNav, gsAccountMenu, gsNavHooks, gsTransformNav, navHooks, type NavStep } from "../packages/cms-theme-gs/src/nav";
import { PageHeader } from "../packages/cms-theme-gs/src/page-header";

// The theme's podoba (0.0.42), the one its components import: the repo root has none, and the
// editor pins an older one. `PageHeader` recognises the editor's buttons by identity, so the
// test has to hand it the same `Button`.
const { Button } = (await import(Bun.resolveSync("@podoba/react", resolve(import.meta.dir, "../packages/cms-theme-gs")))) as typeof import("@podoba/react");

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
  configureI18n({ locale: "cs" });
});
afterEach(() => {
  warn.mockRestore();
  configureI18n({});
});

// --- copy ------------------------------------------------------------------------------------

describe("the theme's copy", () => {
  test("Czech has every English key, and English every Czech one", () => {
    expect(Object.keys(cs).sort()).toEqual(Object.keys(en).sort());
  });

  test("every Czech plural covers the categories Czech uses", () => {
    const plurals = Object.entries(cs).filter((entry): entry is [string, { other: string }] => entry[1] instanceof Object);
    expect(plurals.length).toBeGreaterThan(0);
    for (const [key, value] of plurals) expect(Object.keys(value).sort(), key).toEqual(["few", "many", "one", "other"]);
  });

  test("no em dash anywhere, in either language", () => {
    for (const catalog of [en, cs]) {
      for (const value of Object.values(catalog)) {
        expect(JSON.stringify(value)).not.toContain("\u2014");
      }
    }
  });
});

// --- nav -------------------------------------------------------------------------------------

const TYPES: ContentType[] = [
  { id: "t-page", name: "Stránky", slug: "page" },
  { id: "t-akce", name: "Akce", slug: "akce" },
];
const EVENTS_PANEL: AdminPageMeta = { slug: "akce", label: "Akce · sportoviště a časy", kind: "panel" };
const VENUES_PANEL: AdminPageMeta = { slug: "sportoviste", label: "Sportoviště · viditelnost", kind: "panel" };

/** The nav the editor builds for an admin who may author the schema, on a deployment split by
 * content type with two custom panels: the shape the theme was lifted from. */
function builtNav(isAdmin = true, adminPages: AdminPageMeta[] = [EVENTS_PANEL, VENUES_PANEL]): NavSection[] {
  return navSections(
    buildNav({
      collections: [],
      adminPages,
      contentTypes: TYPES,
      cms: { ...DEFAULT_CAPABILITIES, pagesByType: true, canEdit: true },
      hidePages: false,
      splitByType: true,
      isAdmin,
      extraNav: [],
    }),
  );
}
const context = (sections: NavSection[], active = ""): NavContext => ({ sections, active, isAdmin: true, me: null });
const keys = (sections: NavSection[]) => sections.map((s) => s.entries.map((e) => e.key));

describe("gsTransformNav", () => {
  test("drops the schema editor and account settings from the bar, and moves Users into the first group", () => {
    const sections = builtNav();
    const out = gsTransformNav(context(sections, "users"));
    const flat = keys(out.sections).flat();
    expect(flat).not.toContain("types");
    expect(flat).not.toContain("settings");
    // Users closes the first group, after the editorial entries in the editor's own order.
    expect(keys(out.sections)[0]?.at(-1)).toBe("users");
    expect(flat.filter((k) => k === "users")).toHaveLength(1);
    expect(out.active).toBe("users");
  });

  test("drops a group left empty, so the topbar never renders a dead dropdown", () => {
    // "System" held types, users and settings; all three are gone from it.
    const out = gsTransformNav(context(builtNav()));
    expect(out.sections.every((s) => s.entries.length > 0)).toBe(true);
    expect(out.sections.map((s) => s.id)).not.toContain("system");
  });

  test("does not invent Users for a session that is not an admin", () => {
    const flat = keys(gsTransformNav(context(builtNav(false))).sections).flat();
    expect(flat).not.toContain("users");
  });

  test("returns new objects and leaves the editor's nav alone", () => {
    const sections = builtNav();
    const before = JSON.stringify(sections);
    gsTransformNav(context(sections));
    expect(JSON.stringify(sections)).toBe(before);
  });

  test("the slot export is the GS hooks", () => {
    expect(navHooks).toBe(gsNavHooks);
    expect(navHooks.transformNav).toBe(gsTransformNav);
  });
});

describe("the account menu", () => {
  test('offers "Content structure" to the sessions that had the schema entry, in the editor\'s language', () => {
    expect(gsAccountMenu()).toEqual([{ label: "Struktura obsahu", page: "schema", icon: "types", requiresNav: "types" }]);
    configureI18n({ locale: "en" });
    expect(gsAccountMenu()[0]?.label).toBe("Content structure");
    // A getter on the hooks, so the label follows the language configured at render time.
    expect(gsNavHooks.accountMenu?.[0]?.label).toBe("Content structure");
  });
});

describe("composing the GS nav with a project's own step", () => {
  // praha-sportovni's rule, which stays in praha: its events panel replaces the events content
  // type in the nav (with a shorter label), and the type's route lights the panel. Written as a
  // project would write it, and run BEFORE the GS step.
  const events: NavStep = ({ sections, active }) => {
    const panel = sections.some((s) => s.entries.some((e) => e.key === "app:akce"));
    if (!panel) return { sections, active };
    return {
      sections: sections.map((s) => ({
        ...s,
        entries: s.entries
          .filter((e) => e.key !== "type:akce")
          .map((e) => (e.kind === "route" && e.key === "app:akce" ? { ...e, label: "Akce" } : e)),
      })),
      active: active === "type:akce" ? "app:akce" : active,
    };
  };
  const transform = composeNav(events, gsTransformNav);

  test("both steps apply, in order, and the highlight moves with the project's step", () => {
    const out = transform(context(builtNav(), "type:akce"));
    const flat = keys(out.sections).flat();
    expect(flat).not.toContain("type:akce");
    expect(flat).not.toContain("types");
    expect(flat).toContain("app:akce");
    expect(out.active).toBe("app:akce");
    const panel = out.sections.flatMap((s) => s.entries).find((e) => e.key === "app:akce");
    expect(panel?.kind === "route" ? panel.label : null).toBe("Akce");
  });

  test("without the panel the content type stays reachable", () => {
    const flat = keys(transform(context(builtNav(true, []), "type:akce")).sections).flat();
    expect(flat).toContain("type:akce");
  });
});

// --- dashboard data --------------------------------------------------------------------------

function apiWith<T>(fn: (name: string, input?: RpcInput) => Promise<T>) {
  return { call: fn as <R>(name: string, input?: RpcInput) => Promise<R> };
}

describe("dashboard statistics", () => {
  test("content statistics page through the whole list and split published from drafts", async () => {
    const calls: RpcInput[] = [];
    const api = apiWith(async (_name, input) => {
      calls.push(input ?? {});
      const offset = Number(input?.offset ?? 0);
      return offset === 0 ? Array.from({ length: 500 }, (_, i) => ({ status: i % 3 === 0 ? "published" : "draft" })) : [{ status: "published" }];
    });
    const stat = await loadContentTypeStat(api, "article");
    expect(stat).toEqual({ value: 501, label: "záznamů celkem", detail: "Publikováno 168 · v konceptu 333" });
    expect(calls.map((input) => input.offset)).toEqual([0, 500]);
    expect(calls[0]).toMatchObject({ contentType: "article", limit: 500, select: ["status"] });
  });

  test("media statistics use the API's maximum batch and count the final partial page", async () => {
    const offsets: unknown[] = [];
    const api = apiWith(async (_name, input) => {
      offsets.push(input?.offset);
      return Number(input?.offset) === 0 ? Array.from({ length: 200 }, () => ({})) : [{}, {}];
    });
    expect(await loadMediaStat(api)).toEqual({ value: 202, label: "souborů v knihovně", detail: "Obrázky a dokumenty" });
    expect(offsets).toEqual([0, 200]);
  });

  test("collections use collectionList", async () => {
    const api = apiWith(async (name, input) => {
      expect(name).toBe("collectionList");
      expect(input).toMatchObject({ collection: "clubs", limit: 500, offset: 0 });
      return [{ status: "published" }, { status: "draft" }];
    });
    expect(await loadCollectionStat(api, "clubs")).toEqual({ value: 2, label: "záznamy celkem", detail: "Publikováno 1 · v konceptu 1" });
  });

  test("the noun agrees with the number, by the language's plural rules", async () => {
    // The dashboard this came from once said "1 záznamů celkem" and "3 souborů v knihovně":
    // one fixed genitive for every count.
    const pages = (n: number) => apiWith(async () => Array.from({ length: n }, () => ({ status: "published" })));
    expect((await loadContentTypeStat(pages(1), "page")).label).toBe("záznam celkem");
    expect((await loadContentTypeStat(pages(3), "page")).label).toBe("záznamy celkem");
    expect((await loadContentTypeStat(pages(7), "page")).label).toBe("záznamů celkem");
    expect((await loadContentTypeStat(pages(0), "page")).label).toBe("záznamů celkem");
    const media = (n: number) => apiWith(async () => Array.from({ length: n }, () => ({})));
    expect((await loadMediaStat(media(1))).label).toBe("soubor v knihovně");
    expect((await loadMediaStat(media(3))).label).toBe("soubory v knihovně");
    configureI18n({ locale: "en" });
    expect((await loadMediaStat(media(1))).label).toBe("file in the library");
    expect((await loadMediaStat(media(9))).label).toBe("files in the library");
  });

  test("a type's own nouns (`labels.count`) replace the generic ones", async () => {
    const api = apiWith(async () => [{ status: "published" }, { status: "published" }]);
    const labels = { count: { one: "článek", few: "články", many: "článku", other: "článků" } };
    expect((await loadContentTypeStat(api, "article", labels)).label).toBe("články");
  });

  test("allPages stops on the first short page", async () => {
    const seen: number[] = [];
    const rows = await allPages(async (offset, limit) => { seen.push(offset); return offset < 20 ? Array.from({ length: limit }, () => offset) : []; }, 10);
    expect(rows).toHaveLength(20);
    expect(seen).toEqual([0, 10, 20]);
  });
});

// --- components, rendered to markup ----------------------------------------------------------

const NO_FETCH = { call: async () => { throw new Error("SSR must not fetch"); }, resolve: (p: string) => p };

function homeProps(over: Partial<HomeScreenProps> = {}): HomeScreenProps {
  return {
    api: NO_FETCH,
    basePath: "/cms",
    contentTypes: [{ id: "t-akce", slug: "akce", name: "Akce" }],
    collections: [],
    adminPages: [VENUES_PANEL],
    isAdmin: true,
    cms: { ...DEFAULT_CAPABILITIES, pagesByType: true },
    landing: { kind: "type", slug: "akce" },
    goToLanding: () => {},
    pageList: null,
    href: (page, params) => `/cms/${page}${params?.slug ? `/${params.slug}` : ""}`,
    navigate: () => {},
    onError: () => {},
    ...over,
  };
}

describe("HomeScreen", () => {
  test("links every section through the editor's `href`, and only the sections the session has", () => {
    const html = renderToStaticMarkup(<HomeScreen {...homeProps()} />);
    expect(html).toContain('href="/cms/type/akce"');
    expect(html).toContain('href="/cms/admin-page/sportoviste"');
    expect(html).toContain('href="/cms/media"');
    expect(html).not.toContain("/users");
    expect(html).not.toContain("/settings");
    expect(html).toContain("Vítejte zpět");
    expect(html).toContain("Správa obsahu");
  });

  test("an unloaded statistic never claims zero", () => {
    const html = renderToStaticMarkup(<HomeScreen {...homeProps()} />);
    expect(html).toContain("Načítám aktuální čísla…");
    expect(html).not.toContain(">0<");
  });

  test("where the pooled page list is the home screen, it is rendered under the tiles", () => {
    // On a one-content-type deployment the nav's "Pages" entry points at `/`; without this the
    // entry would lead to the dashboard and the list would be one tile-click away at best.
    const list = <p>pooled-page-list</p>;
    expect(renderToStaticMarkup(<HomeScreen {...homeProps({ landing: { kind: "pages" }, pageList: list })} />)).toContain("pooled-page-list");
    expect(renderToStaticMarkup(<HomeScreen {...homeProps({ pageList: list })} />)).not.toContain("pooled-page-list");
  });

  test("a collections-only deployment gets no page-list tiles", () => {
    const html = renderToStaticMarkup(<HomeScreen {...homeProps({ landing: { kind: "collection", slug: "clubs" }, collections: [{ slug: "clubs", label: "Klub", pluralLabel: "Kluby", fields: [] }] })} />);
    expect(html).not.toContain('href="/cms/type/akce"');
    expect(html).toContain('href="/cms/collection/clubs"');
  });

  test("a project composes its own sections and title (praha's events panel replacing the type)", () => {
    const Home = createHomeScreen({
      title: "Praha sportovní",
      sections: (sections, { adminPages }) => {
        const panel = adminPages.some((p) => p.slug === "akce");
        return sections
          .filter((s) => !(panel && s.key === "type:akce"))
          .map((s) => (s.key === "app:akce" ? { ...s, label: "Akce", stat: (api) => loadContentTypeStat(api, "akce") } : s));
      },
    });
    const html = renderToStaticMarkup(<Home {...homeProps({ adminPages: [EVENTS_PANEL, VENUES_PANEL] })} />);
    expect(html).toContain("Praha sportovní");
    expect(html).toContain('href="/cms/admin-page/akce"');
    expect(html).not.toContain('href="/cms/type/akce"');
    // The panel tile got a stat, so it is loading rather than showing its description.
    expect(html.split("Načítám aktuální čísla…").length - 1).toBe(2);
  });
});

describe("PageHeader", () => {
  test("puts the editor's own action in the pill and says the screen's state as given", () => {
    const html = renderToStaticMarkup(<PageHeader lead="Stránky" em="3 stránky"><Button>+ Nová stránka</Button></PageHeader>);
    expect(html).toContain("Stránky");
    expect(html).toContain("3 stránky");
    expect(html).toContain("+ Nová stránka");
    expect(html).toContain("vytvořit");
    // The editor's button, restyled as GS's pill action rather than replaced.
    expect(html).toContain("bg-surface-inverted");
  });

  test("the media header keeps the native upload input and the disabled state", () => {
    const html = renderToStaticMarkup(
      <PageHeader lead="Média" em="Zatím žádné">
        <input type="file" multiple hidden disabled />
        <Button isDisabled>Nahrávám…</Button>
      </PageHeader>,
    );
    expect(html).toContain('type="file"');
    expect(html).toContain('multiple=""');
    expect(html).toContain("disabled");
    expect(html).toContain("Nahrát média");
    expect(html).toContain("Zatím žádné");
  });

  test("Users gets its own sentence, by the editor's word for the screen", () => {
    const html = renderToStaticMarkup(<PageHeader lead="Uživatelé" em="1 účet"><Button>+ Pozvat</Button></PageHeader>);
    expect(html).toContain("kolegy");
  });

  test("a screen without an action has no pill", () => {
    const html = renderToStaticMarkup(<PageHeader lead="Nastavení" em="pramen@local" />);
    expect(html).not.toContain("vytvořit");
  });
});

describe("DetailHeader", () => {
  test("the way back is a real link to the list, above the title", () => {
    const html = renderToStaticMarkup(<DetailHeader title="O nás" parent="Stránky" href="/cms/types/page" onBack={() => {}}><span>/o-nas</span></DetailHeader>);
    expect(html).toContain('href="/cms/types/page"');
    expect(html.indexOf("Stránky")).toBeLessThan(html.indexOf("O nás"));
    expect(html).toContain("/o-nas");
  });
});

describe("media", () => {
  test("the grid renders every tile with its name and size, and a non-image by its extension", () => {
    const tile = { id: "m1", filename: "report.pdf", size: 1024, sizeLabel: "1 KB", ext: "PDF", contentType: "application/pdf", src: null, alt: "", selected: false, onOpen: () => {} };
    const html = renderToStaticMarkup(<MediaGrid label="Knihovna médií" tiles={[tile, { ...tile, id: "m2", filename: "a.png", ext: "PNG", src: "/media/a.png", alt: "A" }]} />);
    expect(html).toContain("report.pdf");
    expect(html).toContain("1 KB");
    expect(html).toContain("PDF");
    expect(html).toContain('src="/media/a.png"');
    expect(html).toContain('loading="lazy"');
  });

  test("the empty library speaks GS's wording", () => {
    expect(renderToStaticMarkup(<MediaLibraryEmpty title="x" description="y" />)).toContain("Vaše knihovna médií je zatím prázdná");
  });
});

// --- build and config ------------------------------------------------------------------------

describe("gsEditor", () => {
  test("fills every slot the editor has, with the theme's own modules", () => {
    expect(Object.keys(GS_SLOTS).sort()).toEqual(Object.keys(EDITOR_SLOTS).sort());
    const { slots, styles } = gsEditor();
    expect(Object.keys(slots).sort()).toEqual(Object.keys(EDITOR_SLOTS).sort());
    for (const file of Object.values(slots)) expect(file).toContain("/cms-theme-gs/src/");
    expect(styles).toBeUndefined();
  });

  test("a project's own module replaces one slot, and `false` gives it back to the editor", () => {
    const { slots } = gsEditor({ slots: { nav: "/project/src/admin/nav.ts", mediaGrid: false } });
    expect(slots.nav).toBe("/project/src/admin/nav.ts");
    expect(slots.mediaGrid).toBeUndefined();
    expect(slots.home).toContain("/cms-theme-gs/src/home.tsx");
  });

  test("refuses a stylesheet that does not import the theme's CSS, since the slots would render unstyled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gs-styles-"));
    try {
      const bad = join(dir, "bad.css");
      await writeFile(bad, `@import "@pramen/cms-editor/app.css";\n`);
      expect(() => gsEditor({ styles: bad })).toThrow(GS_STYLESHEET);
      const good = join(dir, "good.css");
      await writeFile(good, `@import "@pramen/cms-editor/app.css";\n@import "${GS_STYLESHEET}";\n`);
      expect(gsEditor({ styles: good }).styles).toBe(good);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the recommended admin config is the topbar with the search and filter controls off", () => {
    expect(gsAdmin).toEqual({ layout: "topbar", hideControls: ["mediaSearch", "mediaFilters", "relationSearch"] });
  });
});
