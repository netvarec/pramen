import { BuzolaProvider, Router, createBrowserNavigationAdapter } from "@buzola/router";
import { StrictMode, useRef } from "react";
import { createRoot } from "react-dom/client";
import { pageRegistry, routes } from "virtual:buzola/routes";
import { AppProvider } from "./app-context";
import { DOCUMENT_TITLE } from "./brand";
import { isWithinBasePath, readBasePath, scopeToBasePath } from "./mount";

// Styling is podoba: the compiled Tailwind (podoba preset, with @podoba/tokens' variables
// and the web font inlined) is a single stylesheet the SHELL links — see scripts/build.ts
// for what is built, and @pramen/cms-astro for the shell that serves it.

// The shell's <title> is written before the app boots, so on a deployment that has
// configured a wordmark it can only be the default. Re-apply the configured one here; the
// server-rendered tag stays the pre-hydration fallback.
//
// `DOCUMENT_TITLE`, not `${BRAND.title} editor`: appending a fixed English noun to the one
// string this feature exists to hand over would put a foreign word in a rebranded client's
// tab, and `suffix: null` ("just our name") could never drop it.
document.title = DOCUMENT_TITLE;

const el = document.getElementById("app");
const basePath = readBasePath(el);

// The prefix and the URL the shell was served at come from the same place, so a mismatch
// means the shell and the route that rendered it have drifted. Worth one line: the symptom
// is otherwise a silent 404 on the host site for every click in the topbar, with an empty
// console — buzola's own "no route matched" warning is dead here, because `_404.tsx`'s
// catch-all guarantees a match.
if (!isWithinBasePath(location.pathname, basePath)) {
  console.warn(`pramen/cms-editor: mounted for "${basePath}" but served at "${location.pathname}" — navigation will leave the editor.`);
}

/** The router, built lazily so it exists only once there is a session to route.
 *
 * `AppProvider` renders the Setup screen (or hands off to sign-in) WITHOUT its children
 * when there is no valid session, and `createBrowserNavigationAdapter()` throws outright on
 * a browser with no Navigation API. Constructing at module scope would turn that into a
 * blank page before `createRoot` ever ran; here it stays what it was — the Setup screen,
 * where a first admin can still paste a JWT.
 */
function EditorRouter({ basePath }: { basePath: string }) {
  const router = useRef<Router | null>(null);
  router.current ??= new Router({
    routes,
    // Scoped, so a co-hosted editor intercepts navigation within its own mount only.
    adapter: scopeToBasePath(createBrowserNavigationAdapter(), basePath),
    pageRegistry,
    basePath,
  });
  return <BuzolaProvider router={router.current} />;
}

if (el)
  createRoot(el).render(
    <StrictMode>
      <AppProvider>
        <EditorRouter basePath={basePath} />
      </AppProvider>
    </StrictMode>,
  );
