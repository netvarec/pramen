// The SECOND chrome: the Graphic Standard bar — brand left, tabs right, avatar at the end.
//
// This is podoba's own `Topbar`, which is that bar extracted from the Graphic Standard apps,
// used the way those apps use it: `Topbar.Brand` on the left, a `Topbar.Nav` pushed right by
// its own `ml-auto`, `Topbar.NavLink` tabs inside it, a dropdown among them where a flat
// list would not fit, and the account menu as a bare avatar circle at the right end. The
// height (77px), the tab metrics, the hairline under the bar and the air below it are the gs
// values, not new ones — see `CHROME_METRICS` in `chrome.ts`.
//
// Opt in with `layout: "topbar"`. The SIDEBAR remains the default and remains the right
// answer for a big admin; this is for the deployment that sits inside a product already
// wearing this bar (a vertical rail under a horizontal one reads as two apps stacked), or
// whose nav genuinely fits a row.
//
// The one thing that is NOT a straight port is what happens past six destinations, because
// that is exactly where the row failed the first time round: a dozen entries at 1280px was a
// dense unlabelled ribbon over a horizontal scroller, which is what the sidebar replaced. So
// the bar renders the FIRST nav section as tabs and folds each later section into a dropdown
// (`topbarNav`), which is a shape the gs bar already has — its app switcher is a dropdown in
// the same nav — rather than a scroller nobody discovers.
//
// Below `md` the whole nav moves into a dialog behind a hamburger, which is what gs does
// too. A DIALOG here and a disclosure in the sidebar, for a reason and not by accident: the
// bar has no column under it to put a disclosure in, and podoba's `Dialog` is React Aria's,
// so the focus trap, the restore and Esc are the design system's rather than three more
// hand-rolled handlers.

import { Button, Dialog, DialogTrigger, Topbar, UserMenu, UserMenuItem } from "@podoba/react";
import type { ReactNode } from "react";
import { BELOW_CHROME_PAD } from "./chrome";
import { AccountMenu, NavIconSlot, type ChromeProps, type NavRoute } from "./chrome-shared";
import { BRAND } from "./brand";
import { GroupFoldedIcon as CrumbSeparatorIcon, GroupOpenIcon, MenuToggleIcon } from "./icons";
import { topbarNav, type ExtraNavLink, type NavEntry, type NavSection } from "./nav";

export function TopbarChrome({
  sections,
  labelled,
  active,
  crumb,
  me,
  theme,
  onTheme,
  onSettings,
  onSignOut,
  onHome,
  onGo,
  sameTab,
  confirmNavigation,
  children,
}: ChromeProps) {
  const { tabs, menus } = topbarNav(sections);

  return (
    // Page-level surface so the whole viewport flips under `[data-theme="dark"]` — otherwise
    // the body stays white in dark mode. The DOCUMENT stays the scroller (gs's `AppShell`
    // scrolls an inner column instead): the screen header's condense-on-scroll reads
    // `window.scrollY`, the page editor's three sticky levels are offset from the viewport,
    // and every in-page anchor assumes it. A sticky bar over a document scroller is the same
    // bar to look at, and the one that does not silently break four screens.
    <div className="min-h-screen bg-surface text-fg">
      {/* `h-[77px]` is gs's own override of podoba's 56px default. The bottom rule comes from
          `Topbar` itself; unlike the sidebar's app bar this chrome HAS one, because there is
          no second ground (the rail's `surface-card`) doing the separating. `bg-surface`
          keeps content from scrolling through while pinned. */}
      <Topbar className="sticky top-0 z-30 h-[77px] bg-surface px-7">
        {/* NOT `shrink-0`. podoba's base sets `min-w-0` on this slot precisely so it can give
            width back, and the crumb below is the reason: a long page title sized the brand
            block to max-content, `Topbar.Nav` was then the only sibling left to shrink, and
            the tabs plus the avatar — the only route to theme, Settings and sign-out —
            collapsed behind the in-nav scroller this chrome exists to avoid. The wordmark
            itself keeps `shrink-0`, so shrinkage lands on the crumb, which truncates. */}
        <Topbar.Brand>
          {/* The wordmark is the way back to the top of the admin, as it is on every other
              site — a `button` (not an `<a>`) so the SPA router handles it. */}
          <button
            type="button"
            onClick={onHome}
            aria-label={`${BRAND.spoken} — home`}
            className="flex shrink-0 items-baseline gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:bg-surface-muted"
          >
            <span className="font-semibold text-fg">{BRAND.name}</span>
            {BRAND.suffix ? <span className="text-caption font-normal text-fg-subtle">{BRAND.suffix}</span> : null}
          </button>
          {/* Only the DETAIL crumb, and only beside the brand.
              The sidebar's app bar carries a two-part trail because its rail is a column of
              a dozen rows and "which section" is worth restating. Here the lit TAB already
              says it, and repeating it would be the same word twice on one 77px line. What
              the tab cannot say is which record is open — a page editor has no screen header
              at all, so without this the bar names the section and nothing else.
              In the brand slot rather than a second row: a row that appears only on detail
              screens changes the chrome's height, which every sticky offset below is
              measured against. */}
          {crumb ? (
            // Capped, shrinkable, and gone below `lg`. Three rules for one line of text,
            // because it shares a 77px bar with the nav and it is the half that can be
            // spared: flex shrinkage is proportional to base size, so an unbounded crumb
            // takes width off the tabs before it truncates at all; 320px is where it stops
            // costing them any; and between `md` and `lg` even that much is enough to push
            // the last two tabs behind the nav's own scroller. Nothing is lost when it
            // goes — every screen that publishes a crumb also names the record on the screen
            // (the collection editor's "← Lectures / Edit lecture", the page editor's own
            // toolbar). The nav is the thing that cannot be recovered from elsewhere.
            <nav aria-label="Breadcrumb" className="hidden min-w-0 max-w-[320px] items-center gap-1.5 lg:flex">
              <CrumbSeparatorIcon aria-hidden="true" className="h-3 w-3 shrink-0 text-fg-subtle" />
              <span aria-current="page" className="min-w-0 truncate font-normal text-fg-muted">
                {crumb}
              </span>
            </nav>
          ) : null}
        </Topbar.Brand>

        {/* `hidden md:flex`: below the breakpoint the bar keeps only the brand and the
            hamburger, exactly as gs's does. */}
        <Topbar.Nav aria-label="Primary" className="hidden md:flex">
          {tabs.map((entry) => (
            <TopbarEntry key={entry.key} entry={entry} active={active} onGo={onGo} sameTab={sameTab} confirm={confirmNavigation} />
          ))}
          {menus.map((section) => (
            // A menu always has a name on its trigger: `topbarNav` folds nothing when there
            // is a single section, which is the only case `navSectionsAreLabelled` calls
            // unlabelled.
            <SectionMenu key={section.id} section={section} active={active} onGo={onGo} sameTab={sameTab} confirm={confirmNavigation} />
          ))}
        </Topbar.Nav>

        {/* gs's account cluster: a bare avatar circle, no name beside it. The theme, Settings
            and the way out live inside it, as they do in the sidebar.

            `Topbar.Actions`, not one more child of `Topbar.Nav` — which is where the gs app
            puts it, and is a `<nav aria-label="Primary">` landmark, so "Account — <user>"
            was announced as a primary navigation destination. podoba ships this slot for
            exactly that reason and the sidebar already keeps the account menu outside its
            own nav. `ml-3` overrides the slot's `ml-auto`: two auto margins would SPLIT the
            free space and float the cluster away from the tabs it sits beside. */}
        <Topbar.Actions className="ml-3 hidden shrink-0 md:flex">
          <AccountMenu me={me} theme={theme} compact onTheme={onTheme} onSettings={onSettings} onSignOut={onSignOut} />
        </Topbar.Actions>

        {/* The small-viewport nav. Everything at once in a dialog rather than the dropdowns
            the bar uses: on a phone there is no width to save, and a menu inside a menu is a
            second layer of popover to escape from. */}
        <div className="ml-auto md:hidden">
          <DialogTrigger>
            <Button variant="ghost" size="sm" aria-label="Show navigation" className="rounded-md px-2 py-2 text-fg-muted">
              <MenuToggleIcon className="h-4 w-4" />
            </Button>
            <Dialog title="Navigation" closeLabel="Close" size="sm">
              {({ close }) => (
                <div className="flex flex-col gap-4">
                  {sections.map((section) => (
                    <div key={section.id} className="flex flex-col gap-px">
                      {labelled ? (
                        <div className="px-2 py-1 text-caption font-medium text-fg-subtle">{section.label}</div>
                      ) : null}
                      {section.entries.map((entry) =>
                        entry.kind === "route" ? (
                          <button
                            key={entry.key}
                            type="button"
                            {...(active === entry.key ? { "aria-current": "page" as const } : {})}
                            className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-compact leading-4 transition-colors hover:bg-surface-muted ${
                              active === entry.key ? "bg-surface-muted font-medium text-fg" : "text-fg-muted"
                            }`}
                            // Navigate FIRST, dismiss only if it went: `onGo` runs the
                            // unsaved-changes guard, and closing ahead of it left someone
                            // who answered "stay" on the dirty screen with the nav gone.
                            onClick={() => { if (onGo(entry)) close(); }}
                          >
                            <NavIconSlot icon={entry.icon} />
                            <span className="min-w-0 truncate">{entry.label}</span>
                          </button>
                        ) : (
                          <HostLink
                            key={entry.key}
                            link={entry.link}
                            sameTab={sameTab(entry.link)}
                            confirm={confirmNavigation}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-compact leading-4 text-fg-muted no-underline transition-colors hover:bg-surface-muted hover:text-fg"
                          >
                            <NavIconSlot icon={entry.icon} />
                            <span className="min-w-0 truncate">{entry.link.label}</span>
                          </HostLink>
                        ),
                      )}
                    </div>
                  ))}
                  {/* Settings NAVIGATES, so it has to take the dialog with it — this chrome
                      stays mounted across a route change, so the modal (focus trap and
                      scroll lock included) would otherwise be left sitting over the screen
                      it just opened. Same "only if it went" rule as the rows above. Theme
                      changes nothing about where you are, and sign-out unmounts the router
                      and this dialog with it. */}
                  <div className="flex items-center border-t border-border pt-4">
                    <AccountMenu
                      me={me}
                      theme={theme}
                      onTheme={onTheme}
                      onSettings={() => { if (onSettings()) close(); }}
                      onSignOut={onSignOut}
                    />
                  </div>
                </div>
              )}
            </Dialog>
          </DialogTrigger>
        </div>
      </Topbar>

      {/* The air gs leaves between its bar and the first section. It belongs to the column
          rather than to `page-header.tsx` so that it applies to every screen — including the
          ones with no screen header at all — and so that it SCROLLS AWAY instead of staying
          pinned above a stuck header. */}
      <div className={BELOW_CHROME_PAD}>{children}</div>
    </div>
  );
}

/** One flat tab — a route the bar navigates, or a host link it follows. */
function TopbarEntry({
  entry,
  active,
  onGo,
  sameTab,
  confirm,
}: {
  entry: NavEntry;
  active: string;
  onGo: (entry: NavRoute) => void;
  sameTab: (link: ExtraNavLink) => boolean;
  confirm: () => boolean;
}) {
  if (entry.kind === "link") {
    return (
      <Topbar.NavLink asChild>
        <HostLink link={entry.link} sameTab={sameTab(entry.link)} confirm={confirm}>
          {entry.link.label}
        </HostLink>
      </Topbar.NavLink>
    );
  }
  // `asChild` over a `<button>`, not an `<a href>`: these are SPA destinations reached
  // through the router, and every one of them goes through the unsaved-changes guard first.
  // `aria-current` alongside the tint, because the tab's only "you are here" cue is a
  // background — invisible to a screen reader and marginal for anyone who cannot see it.
  return (
    <Topbar.NavLink asChild active={active === entry.key}>
      <button type="button" onClick={() => onGo(entry)} {...(active === entry.key ? { "aria-current": "page" as const } : {})}>
        {entry.label}
      </button>
    </Topbar.NavLink>
  );
}

/**
 * One folded section — a dropdown trigger in the bar, its entries inside.
 *
 * podoba's `UserMenu` (React Aria's `Menu`) rather than a hand-rolled popover, and the same
 * component gs uses for the app switcher in this same nav. It takes no `className`, so the
 * tab metrics are applied to its trigger through an arbitrary variant on the wrapper — which
 * is how gs adjusts the same trigger in its own topbar. Without it a menu among the tabs is
 * a 36px pill next to 28px rects.
 */
function SectionMenu({
  section,
  active,
  onGo,
  sameTab,
  confirm,
}: {
  section: NavSection;
  active: string;
  onGo: (entry: NavRoute) => void;
  sameTab: (link: ExtraNavLink) => boolean;
  confirm: () => boolean;
}) {
  const label = section.label;
  const holdsActive = section.entries.some((e) => e.key === active);
  const byKey = new Map(section.entries.map((e) => [e.key, e]));
  return (
    <span
      className={
        // Match `Topbar.NavLink`: 13px, normal weight, the same 13/6 padding and `rounded-sm`
        // corners, and the same muted fill when the section holds the lit entry.
        "shrink-0 [&>button]:h-auto [&>button]:rounded-sm [&>button]:px-[13px] [&>button]:py-[6px] [&>button]:text-compact [&>button]:font-normal [&>button]:leading-4 " +
        (holdsActive ? "[&>button]:bg-surface-muted [&>button]:text-fg" : "")
      }
    >
      <UserMenu
        triggerLabel={label}
        trigger={
          <span className="flex items-center gap-1 whitespace-nowrap">
            {label}
            <GroupOpenIcon aria-hidden="true" className="h-3 w-3 shrink-0" />
          </span>
        }
        onAction={(key) => {
          const entry = byKey.get(String(key));
          if (!entry) return;
          // A route is navigated (guarded upstream). A host link that opens a NEW tab is a
          // real `<a href target="_blank">` below, so RAC's own link handling has already
          // done the work and there is nothing to do here — doing it again would open two
          // tabs. Only the same-tab link is driven from here: it unloads THIS document, so
          // it has to consult the unsaved-changes guard, and an anchor inside a RAC menu
          // gives no click to cancel.
          if (entry.kind === "route") onGo(entry);
          else if (sameTab(entry.link) && confirm()) location.assign(entry.link.href);
        }}
      >
        {section.entries.map((entry) => {
          const isActive = entry.key === active;
          const linkProps =
            entry.kind === "link" && !sameTab(entry.link)
              ? { href: entry.link.href, target: "_blank" as const, rel: "noopener noreferrer" }
              : {};
          return (
            <UserMenuItem
              key={entry.key}
              id={entry.key}
              className={`gap-2.5 text-compact no-underline ${isActive ? "bg-surface-muted font-medium text-fg" : ""}`}
              {...linkProps}
            >
              <NavIconSlot icon={entry.icon} />
              {entry.kind === "route" ? entry.label : entry.link.label}
            </UserMenuItem>
          );
        })}
      </UserMenu>
    </span>
  );
}

/** One host-configured link to a companion tool.
 *
 * `rel="noreferrer"` is on BOTH branches. `noopener` is genuinely moot in the same tab (no
 * new browsing context is created, so there is no `window.opener` to sever) but `noreferrer`
 * is not: without it a click from `/__admin/pages/<id>` hands that full url to the
 * destination as `Referer`, and `_self` is honoured for cross-origin destinations.
 */
function HostLink({
  link,
  sameTab,
  confirm,
  className,
  children,
}: {
  link: ExtraNavLink;
  sameTab: boolean;
  confirm: () => boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={link.href}
      rel={sameTab ? "noreferrer" : "noopener noreferrer"}
      // Only the same-tab case unloads this document, so only it consults the guard.
      onClick={sameTab ? (e) => { if (!confirm()) e.preventDefault(); } : undefined}
      {...(sameTab ? {} : { target: "_blank" })}
      {...(className ? { className } : {})}
      title={link.label}
    >
      {children}
    </a>
  );
}
