// `slots.home`: the Graphic Standard dashboard at `/`.
//
// GS's brand dashboard: a `BrandPageHeader` greeting ("Welcome back / <title>") whose mint CTA
// expands into a create hub listing the sections the editor can open, and under it a
// `DashboardGrid` of `Tile`s, one per section, each with a live count where there is something
// to count. Twelve columns with 12px gaps, tiles a third wide on a desktop, half on a tablet and
// stacked on a phone; that geometry is podoba's.
//
// The tiles come from what the SESSION can see (content types, collections, custom panels,
// already role-filtered by the server) plus the media library, so the dashboard never offers a
// section the nav would not. It deliberately does not follow `landing`: GS's `/` is the
// dashboard, not a redirect to the first list. Except where the list IS the home screen
// (`landing.kind === "pages"`, a deployment with one content type): there the nav's "Pages"
// entry points at `/`, so the editor's `pageList` is rendered under the tiles, or that entry
// would lead to a dashboard and nowhere else.
//
// COMPOSABLE, because the tiles are where a project's own sections live. `createHomeScreen`
// takes a `sections` transform (rename, hide, reorder, add, give a custom panel a stat) and the
// greeting's second line; the default `HomeScreen` is `createHomeScreen()`. A project wires its
// own slot module:
//
//   // src/admin/home.tsx
//   import { createHomeScreen } from "@pramen/cms-theme-gs/home";
//   export const HomeScreen = createHomeScreen({ title: "Praha sportovní", sections: (sections) => ... });

import { BrandPageHeader, Button, CtaPill, DashboardGrid, DashboardTile, Tile } from "@podoba/react";
import { getI18n, useI18n } from "@pramen/cms-editor/i18n";
import type { HomeScreenProps } from "@pramen/cms-editor/slots";
import { useEffect, useState, type ReactNode } from "react";
import { copy } from "./copy";
import { loadCollectionStat, loadContentTypeStat, loadMediaStat, type DashboardApi, type DashboardStat } from "./dashboard-data";
import { HERO_ACTION, PageHeaderDock } from "./page-header";

/** One section on the dashboard: a tile in the grid and an entry in the create hub. */
export interface DashboardSection {
  /** The nav key of the same destination (`type:<slug>`, `col:<slug>`, `media`, `app:<slug>`),
   * so a project can match a tile with the same key it uses in its nav transform. */
  key: string;
  label: string;
  href: string;
  /** Which of the create hub's two groups it is listed in. */
  group: "content" | "quick";
  /** The line under a tile that has no stat, and under the hub entry. */
  description: string;
  /** The tile's live count. A section without one is navigation-only and shows `description`
   * rather than a number it does not have. */
  stat?: (api: DashboardApi) => Promise<DashboardStat>;
}

export interface HomeScreenOptions {
  /** The greeting's second line, under "Welcome back". The theme's "Content administration"
   * by default; usually the site's name. A function is called on render, so it can translate. */
  title?: string | (() => string);
  /** Rename, hide, reorder or add sections, or give one a stat. Gets the defaults in order
   * (content types, collections, media, custom panels) and the slot's props. */
  sections?: (sections: DashboardSection[], props: HomeScreenProps) => DashboardSection[];
}

/** The sections the dashboard offers by default, for the session in `props`. */
export function defaultSections(props: HomeScreenProps): DashboardSection[] {
  const { href, contentTypes, collections, adminPages, landing, cms } = props;
  // A collections-only deployment (`hidePages`) has no page lists to open; the landing
  // decision is the only place the slot learns that.
  const pages = landing.kind !== "collection" && landing.kind !== "none";
  return [
    ...(pages ? contentTypes ?? [] : []).map((type): DashboardSection => ({
      key: `type:${type.slug}`,
      label: type.name,
      href: href("type", { slug: type.slug }),
      group: "content",
      description: copy.t("home.tile.type"),
      // An older server ignores `contentType` and answers with every page, so without the
      // capability each tile would count the whole site under one type's name.
      stat: cms.pagesByType ? (api) => loadContentTypeStat(api, type.slug, type.labels) : undefined,
    })),
    ...collections.map((collection): DashboardSection => ({
      key: `col:${collection.slug}`,
      label: collection.pluralLabel,
      href: href("collection", { slug: collection.slug }),
      group: "content",
      description: copy.t("home.tile.collection"),
      stat: (api) => loadCollectionStat(api, collection.slug, collection.labels),
    })),
    { key: "media", label: getI18n().t("nav.media"), href: href("media"), group: "quick", description: copy.t("home.tile.media"), stat: loadMediaStat },
    ...adminPages.map((page): DashboardSection => ({
      key: `app:${page.slug}`,
      label: page.label,
      href: href("admin-page", { slug: page.slug }),
      group: "quick",
      description: copy.t("home.tile.app"),
    })),
  ];
}

function StatTile({ api, section }: { api: DashboardApi; section: DashboardSection }) {
  const i18n = useI18n();
  const [stat, setStat] = useState<DashboardStat | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const load = section.stat;
  useEffect(() => {
    if (!load) return;
    let active = true;
    setStat(null);
    setFailed(false);
    load(api).then(
      (value) => { if (active) setStat(value); },
      () => { if (active) setFailed(true); },
    );
    return () => { active = false; };
    // Keyed on the section, not on the loader: `sections` is rebuilt every render, so the
    // function identity changes while what it counts does not. Whether there IS a loader is part
    // of the key, though: a project's section can get its `stat` only once the session's data has
    // arrived (praha counts its events panel with the `akce` type's `labels`, and `contentTypes`
    // is `null` on the first render). Without it that tile would say "loading" forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, section.key, Boolean(load), attempt]);

  let title: ReactNode = section.label;
  let footer: ReactNode = section.description;
  if (load) {
    // An en dash, not "0", until the number is known: an unloaded tile must never claim zero.
    title = stat ? (
      <>
        <span className="text-fg">{i18n.number(stat.value)}</span> <span className="text-fg-muted">{stat.label}</span>
      </>
    ) : (
      "–"
    );
    footer = <span role="status">{failed ? copy.t("home.stat.failed") : stat ? stat.detail : copy.t("home.stat.loading")}</span>;
  }
  return (
    <DashboardTile span={4} className="flex min-h-[240px] flex-col md:h-[320px]">
      <Tile className="flex-1" eyebrow={section.label} title={title} footer={footer} link={<a href={section.href} />} />
      {failed ? (
        <button type="button" className="mt-2 text-small underline" onClick={() => setAttempt((n) => n + 1)}>
          {copy.t("home.stat.retry", { label: section.label })}
        </button>
      ) : null}
    </DashboardTile>
  );
}

function CreateHub({ sections, loading }: { sections: DashboardSection[]; loading: boolean }) {
  const groups = [
    { id: "content", title: copy.t("home.group.content"), items: sections.filter((s) => s.group === "content") },
    { id: "quick", title: copy.t("home.group.quick"), items: sections.filter((s) => s.group === "quick") },
  ].filter((group) => group.items.length > 0);
  return (
    <div className="gs-create-content text-fg-on-brand">
      <h2 className="gs-create-title">
        {copy.t("home.hubTitleLead")} <strong className="font-medium">{copy.t("home.hubTitleEm")}</strong>
      </h2>
      <div className="flex flex-col gap-10 px-4 pb-4">
        {loading ? <p role="status">{copy.t("home.loadingSections")}</p> : null}
        {groups.map((group) => (
          <nav key={group.id} aria-label={group.title}>
            <h3 className="mb-4 text-heading4 font-medium">{group.title}</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {group.items.map((section) => (
                <a
                  key={section.key}
                  href={section.href}
                  className="gs-create-option flex min-h-[200px] flex-col rounded-lg bg-surface-card p-6 text-fg outline-none transition-colors hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-fg-on-brand"
                >
                  <span className="text-heading3 font-medium">{section.label}</span>
                  <span className="mt-3 text-small text-fg-muted">{section.description}</span>
                  <span className="mt-auto flex justify-between pt-8 text-small">
                    {copy.t("home.openSection")} <span aria-hidden="true">↗</span>
                  </span>
                </a>
              ))}
            </div>
          </nav>
        ))}
      </div>
    </div>
  );
}

/** Build a `HomeScreen` for `slots.home` with a project's own sections and title. */
export function createHomeScreen(options: HomeScreenOptions = {}): (props: HomeScreenProps) => ReactNode {
  return function HomeScreen(props: HomeScreenProps) {
    const [open, setOpen] = useState(false);
    const defaults = defaultSections(props);
    const sections = options.sections ? options.sections(defaults, props) : defaults;
    const loading = props.contentTypes === null;
    const title = options.title instanceof Function ? options.title() : options.title ?? copy.t("home.title");
    return (
      <>
        <div className="gs-dashboard mx-auto w-full max-w-[var(--pramen-content-max)] px-[var(--pramen-gutter)] pb-6">
          <BrandPageHeader
            variant="dashboard"
            expanded={open}
            onExpandedChange={setOpen}
            className={`gs-create-header ${open ? "gs-create-header-open" : ""}`}
            greeting={
              <>
                <span className="text-fg-muted">{copy.t("home.welcome")}</span>
                <br />
                {title}
              </>
            }
            closeLabel={copy.t("home.hubClose")}
            ctaLabel={copy.t("home.hubLabel")}
            cta={({ expanded, controls, toggle }) => (
              <div className="gs-create-trigger relative h-full w-full">
                <CtaPill lead={copy.t("home.cta.lead")} emphasis={copy.t("home.cta.emphasis")} tail={copy.t("home.cta.tail")}>
                  <Button className={`${HERO_ACTION} gs-create-button`} onPress={toggle} aria-label={copy.t("home.startLabel")} aria-expanded={expanded} aria-controls={controls}>
                    {copy.t("home.start")}
                  </Button>
                </CtaPill>
              </div>
            )}
            createHub={<CreateHub sections={sections} loading={loading} />}
          />
          {loading ? <p role="status" className="mb-6 text-small text-fg-muted">{copy.t("home.loadingSections")}</p> : null}
          <DashboardGrid>
            {sections.map((section) => <StatTile key={section.key} api={props.api} section={section} />)}
          </DashboardGrid>
        </div>
        {/* Outside the dashboard's column: the list brings its own header and gutter. Its CTA
            stays in its header on a phone, since the dashboard's is the one docked there. */}
        {props.landing.kind === "pages" ? <PageHeaderDock.Provider value={false}>{props.pageList}</PageHeaderDock.Provider> : null}
      </>
    );
  };
}

/** The dashboard as the theme ships it. */
export const HomeScreen = createHomeScreen();
