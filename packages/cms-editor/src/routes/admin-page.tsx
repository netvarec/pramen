// A project's own screen (`/apps/:slug`), rendered inside the editor's own chrome.
//
// Routed BY THE EDITOR, which is the point: an `extraNav` link has to open a new tab,
// because `_404.tsx` registers the catch-all `/:__notFound+` and a same-tab click on an
// unmounted editor lands on the in-app 404. A registered screen has a real route, so it is
// part of the admin rather than a link out of it.
//
// ONE route for two kinds. A Block Kit page (`adminPage()`) is described as JSON by the
// server and rendered here; a panel (`adminPanel()`) is a React component the deployment's
// own bundle registered. They share this route because they share everything a URL and a nav
// entry are made of — the slug space, the role filter, the "Apps" band, the breadcrumb — and
// differ only in where the rendering happens. Splitting them would have meant a second
// route, a second nav band and a slug that could mean two things.

import { createPage, useNavigate, useRouter } from "@buzola/router";
import { useMemo, useSyncExternalStore } from "react";
import { useApp } from "../app-context";
import { AdminPageView } from "../blockkit";
import { Notice } from "../components";
import { PanelBoundary } from "../panel-boundary";
import { getPanel, panelRefusal, panelsSettled, panelsVersion, subscribePanels, type PanelProps } from "../panels";
import { useTheme } from "../theme";
import { adminPageKind } from "../types";
import { Button } from "@podoba/react";

export default createPage()
  .params({ slug: "string" })
  .route("/apps/:slug")
  .render(function AdminPageRoute({ params }) {
    const { api, adminPages, setError } = useApp();
    const navigate = useNavigate();
    const def = adminPages.find((p) => p.slug === params.slug);

    // `listAdminPages` is role-FILTERED server-side, so an absent slug means either "still
    // loading" or "not yours / not registered" — and the two are told apart by whether the
    // list has arrived at all, exactly as the collection route does it.
    if (!def) {
      return (
        <Notice action={adminPages.length > 0 ? <Button variant="ghost" size="sm" onPress={() => navigate("home")}>← Pages</Button> : undefined}>
          {adminPages.length === 0 ? "Loading…" : `Unknown page: ${params.slug}`}
        </Notice>
      );
    }
    if (adminPageKind(def) === "panel") return <PanelRoute slug={def.slug} />;
    // Keyed on the slug so switching between two pages REMOUNTS the view: buzola renders the
    // same component instance across a params-only change, and the blocks, the form values
    // and any toast all belong to one page.
    return <AdminPageView api={api} key={def.slug} slug={def.slug} label={def.label} onError={setError} />;
  });

/**
 * A panel: the component the deployment's own bundle registered for this slug.
 *
 * The registry is external state that changes without React knowing — bundles are imported
 * from `main.tsx` and register whenever they land — so it is read through
 * `useSyncExternalStore` rather than an effect. That is what makes a deep link to a panel
 * work: the route can mount before the bundle has finished loading, and re-renders when it
 * has, instead of deciding once and being wrong forever.
 */
function PanelRoute({ slug }: { slug: string }) {
  const { api, setError } = useApp();
  const theme = useTheme();
  const basePath = useRouter().basePath;
  const version = useSyncExternalStore(subscribePanels, panelsVersion, panelsVersion);
  // `version` is the snapshot, not the value — a stable number is what a store hook needs,
  // and the lookup is what the render actually wants. Depending on it is the point.
  const panel = useMemo(() => getPanel(slug), [slug, version]);

  if (!panel) {
    // Three different situations, and only the first is a spinner.
    //
    // A REFUSAL comes first because it is the one the generic message would actively mislead
    // about: the bundle is listed, it loaded, it ran, and it called `registerPanel` — telling
    // the reader to go and check those four things sends them past the actual answer. The
    // registry already holds a sentence naming the slug and the fix (a contract built against
    // a different editor, a `render` that is not a component), so it is shown verbatim.
    //
    // Otherwise: the server listed this panel (it is in `adminPages`, so the caller may open
    // it), which means the bundle either has not landed yet or landed and never registered
    // this slug. The last is a deployment mistake — a missing `panels` entry, a bundle built
    // without the `registerPanel` call, a slug typo between `app.ts` and the bundle — and it
    // is one nobody can diagnose from a spinner.
    //
    // Read during render, not through a second store: a refusal calls the same `notify` a
    // registration does, so `version` above is already the subscription that brings this
    // component back when one is recorded.
    const refused = panelRefusal(slug);
    return (
      <Notice>
        {refused ??
          (panelsSettled()
            ? `No panel is registered for '${slug}'. Check that this deployment's panel bundle is listed in the admin's \`panels\` config and calls registerPanel({ slug: "${slug}", … }).`
            : "Loading…")}
      </Notice>
    );
  }

  const props: PanelProps = { api, basePath, theme, setError };
  // Keyed on the slug for the same reason a Block Kit page is: buzola keeps one component
  // instance across a params-only change, and a panel's state belongs to its own screen.
  //
  // Wrapped, because this is someone else's component in our tree: React unmounts the whole
  // root on an uncaught render error, so without the boundary one bad panel does not break a
  // screen, it blanks the admin — no sidebar, and no way off the route that is failing.
  return (
    <PanelBoundary key={slug} slug={slug}>
      <panel.render {...props} />
    </PanelBoundary>
  );
}
