// The account cluster: the avatar at the end of the chrome and the menu it opens.
//
// A SLOT (`slots.account`, contract `AccountMenuProps` in `slots.ts`). Both chromes render it,
// so a deployment that sits inside a product with an account menu of its own (the Graphic
// Standard apps open an account dialog from the avatar) can put that menu here and have the
// editor's avatar behave like the rest of the product. A replacement owns the session's way to
// the theme, Settings and sign-out, which is why those arrive as props rather than being
// rendered around it.
//
// podoba's `UserMenu` (a React Aria `Menu`), so the popover, roving focus, typeahead and
// dismissal are the design system's rather than three more hand-rolled handlers.

import { Avatar, UserMenu, UserMenuItem } from "@podoba/react";
import { NavIconSlot } from "./chrome-shared";
import { useI18n } from "./i18n";
import { DarkThemeIcon, LightThemeIcon, SettingsIcon, SignOutIcon } from "./icons";
import type { AccountMenuProps } from "./slots";

/**
 * `compact` drops the name beside the avatar, which is the Graphic Standard bar's own shape: a
 * bare avatar circle at the right end of the nav. The sidebar's app bar has the width to name
 * the session, and does.
 */
export function AccountMenu({ me, theme, compact, items, onTheme, onSettings, onSignOut }: AccountMenuProps) {
  // Looked up by id rather than switched on, because the rows are data: the built-in keys can
  // never collide with them (`extra:` prefix), and nothing here changes when a deployment adds
  // one.
  const { t } = useI18n();
  const byId = new Map(items.map((item) => [item.id, item]));
  // The provider's display name when there is one (parsed where `me` arrived, see
  // `parseAccountProfile`); otherwise the server-resolved identity, which is a username or an
  // email. Falling back to "account" keeps the avatar's initials from reading as "?" in the
  // window between boot and the `me` call landing.
  const who = me?.profile?.name ?? me?.userId ?? t("account.fallbackName");
  const picture = me?.profile?.picture;
  return (
    <UserMenu
      triggerLabel={t("account.trigger", { who })}
      trigger={
        <>
          <Avatar name={who} src={picture} size="sm" ring={false} />
          {compact ? null : <span className="max-w-[180px] truncate text-compact text-fg-muted max-[560px]:hidden">{who}</span>}
        </>
      }
      onAction={(key) => {
        if (key === "theme") onTheme();
        else if (key === "settings") onSettings();
        else if (key === "signout") onSignOut();
        else byId.get(String(key))?.onSelect();
      }}
    >
      <UserMenuItem id="theme" className="gap-2.5">
        {theme === "dark" ? <LightThemeIcon className="h-[15px] w-[15px]" /> : <DarkThemeIcon className="h-[15px] w-[15px]" />}
        {theme === "dark" ? t("theme.light") : t("theme.dark")}
      </UserMenuItem>
      {items.map((item) => (
        <UserMenuItem key={item.id} id={item.id} className="gap-2.5">
          {/* An empty 15px box when there is no glyph, so the label still lines up with the
              built-in rows' labels. */}
          {item.icon ? <NavIconSlot icon={{ kind: "glyph", name: item.icon }} /> : <span aria-hidden="true" className="h-[15px] w-[15px] shrink-0" />}
          {item.label}
        </UserMenuItem>
      ))}
      <UserMenuItem id="settings" className="gap-2.5">
        <SettingsIcon className="h-[15px] w-[15px]" />
        {t("account.settings")}
      </UserMenuItem>
      <UserMenuItem id="signout" className="gap-2.5">
        <SignOutIcon className="h-[15px] w-[15px]" />
        {t("account.signOut")}
      </UserMenuItem>
    </UserMenu>
  );
}
