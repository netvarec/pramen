// Home route (`/`). Decides where the admin lands and hands that to the home SCREEN, which is a
// slot (`slots.home`, see `home-screen.tsx`): by default it follows the decision (a redirect to
// the first collection or content type) or shows the pooled page list, and a deployment's own
// dashboard gets the same decision to follow or ignore.

import { createPage, useNavigate, useRouter } from "@buzola/router";
import { useApp } from "../app-context";
import { homeLanding, PageList, pagesHidden } from "../components";
import { HomeScreen } from "../home-screen";
import type { EditorPage } from "../slots";

export default createPage()
  .route("/")
  .render(function Home() {
    const { api, setError, collections, adminPages, contentTypes, cms, isAdmin } = useApp();
    const navigate = useNavigate();
    const router = useRouter();

    const landing = homeLanding({ hidePages: pagesHidden(), collections, contentTypes, cms });
    // buzola's `navigate` is typed off the generated page map, and `EditorPage` is the same set
    // written out for the public contract (proved equal in `_layout.tsx`); the cast is the
    // bridge between the two, in one place.
    const go = (page: EditorPage, params?: Record<string, string>, replace = false): void =>
      navigate(page as never, { ...(params ? { params } : {}), replace } as never);

    return (
      <HomeScreen
        api={api}
        basePath={router.basePath}
        contentTypes={contentTypes}
        collections={collections}
        adminPages={adminPages}
        isAdmin={isAdmin}
        cms={cms}
        landing={landing}
        goToLanding={() => {
          // `replace`, so Back from the landing list does not return to a `/` that redirects
          // straight back to it.
          if (landing.kind === "collection") go("collection", { slug: landing.slug }, true);
          else if (landing.kind === "type") go("type", { slug: landing.slug }, true);
        }}
        // Only when the pooled list IS home. Built here rather than by the screen because it is
        // the editor's own component, wired to the editor's own routing; a theme only places it.
        pageList={landing.kind === "pages" ? <PageList api={api} onOpen={(p) => navigate("page", { params: { pageId: p.id } })} onError={setError} /> : null}
        href={(page, params) => router.buildPagePath(page, params)}
        navigate={(page, params) => go(page, params)}
        onError={setError}
      />
    );
  });
