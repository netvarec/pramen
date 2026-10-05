// `slots.account`: the avatar at the right end of the bar, as the Graphic Standard apps draw it.
//
// GS puts a bare avatar there, at podoba's default size and with its ring, showing the person's
// own picture. The editor's default is a smaller ring-less circle with initials, because pramen
// on its own has no picture to show. With an OIDC sign-in from GS it does (`profile.picture`,
// see `mapProfile` in `@pramen/auth`), so the theme shows it the way GS does.
//
// What opens from it stays the editor's: the theme, the deployment's rows, Settings and
// sign-out. GS's own account dialog switches between GS apps, which is a product's menu, not a
// theme's; a deployment inside GS that wants it fills this slot with its own module.

import { Avatar, UserMenu, UserMenuItem } from "@podoba/react";
import { useI18n } from "@pramen/cms-editor/i18n";
import type { AccountMenuProps } from "@pramen/cms-editor/slots";

export function AccountMenu({ me, theme, compact, items, onTheme, onSettings, onSignOut }: AccountMenuProps) {
  const { t } = useI18n();
  const byId = new Map(items.map((item) => [item.id, item]));
  // `profile` is parsed where `me` arrives (`parseAccountProfile` in the editor): `name` is a
  // non-empty string and `picture` an https URL, or absent.
  const who = me?.profile?.name ?? me?.userId ?? t("account.fallbackName");
  const picture = me?.profile?.picture;
  return (
    <UserMenu
      triggerLabel={t("account.trigger", { who })}
      trigger={
        <>
          <Avatar name={who} src={picture} />
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
      <UserMenuItem id="theme">{theme === "dark" ? t("theme.light") : t("theme.dark")}</UserMenuItem>
      {items.map((item) => (
        <UserMenuItem key={item.id} id={item.id}>
          {item.label}
        </UserMenuItem>
      ))}
      <UserMenuItem id="settings">{t("account.settings")}</UserMenuItem>
      <UserMenuItem id="signout">{t("account.signOut")}</UserMenuItem>
    </UserMenu>
  );
}
