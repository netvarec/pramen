// `slots.pageHeader`: a list screen's header as the Graphic Standard draws it.
//
// GS's `BrandPageHeader`: the screen's name in muted grey over its state ("Media / 3 files"),
// 30/32px medium, and on the right a mint `CtaPill` carrying the screen's real primary action.
// The pill's sentence ("Let's create something new") is GS's voice; the button inside it is the
// EDITOR's, passed in as `children` with its own handler, ref, label and disabled state, so the
// theme restyles the action without re-implementing it. An earlier stylesheet-only attempt
// rewrote the action's label with pseudo-elements and ended up saying "New template" over an
// upload; owning the component is what ends that.
//
// Media is the one screen whose action is not one button. The editor hands it a hidden
// `<input type="file">` and the button that clicks it, and GS puts uploads behind the pill's
// create hub (the pill expands into a panel explaining what will happen). Detected by that
// input rather than by the screen's name: the name is translated and a deployment may rename
// it, the input is what makes it an upload.
//
// Not sticky, unlike the editor's own header: GS's header scrolls with the page.

import { BrandPageHeader, Button, CtaPill } from "@podoba/react";
import { useI18n } from "@pramen/cms-editor/i18n";
import type { PageHeaderProps } from "@pramen/cms-editor/slots";
import { Children, cloneElement, createContext, isValidElement, useContext, type ReactElement, type ReactNode } from "react";
import { copy } from "./copy";

/** GS `CtaPillAction`: a 40px hit target, 12px horizontal padding, 13/16 regular type, dark
 * ink on the mint pill. Put on the editor's own `Button`s, and on the dashboard's. */
export const HERO_ACTION =
  "h-10 bg-surface-inverted px-3 font-normal leading-4 tracking-[0] text-fg-inverted hover:bg-surface-inverted/90 data-[pressed]:bg-surface-inverted";

/** The screen's column: the editor's own gutter and width, so the header lines up with the list
 * under it on every deployment that re-proportions the editor (see `app.css`). */
const COLUMN = "gs-page-header mx-auto w-full max-w-[var(--pramen-content-max)] px-[var(--pramen-gutter)]";

/**
 * Whether a header may dock its CTA to the bottom of a phone's screen (podoba's default).
 *
 * One docked CTA per screen: the dashboard renders the editor's pooled page list under its own
 * header on a one-content-type deployment, and two fixed docks would sit on top of each other.
 * The dashboard turns docking off for the list it hosts; everywhere else it stays on.
 */
export const PageHeaderDock = createContext(true);

function isFileInput(node: ReactNode): boolean {
  return isValidElement<{ type?: string }>(node) && node.type === "input" && node.props.type === "file";
}

/** The editor's podoba `Button`s get the pill's action style; anything else (the file input)
 * is passed through untouched, and every child is rendered. */
function asPillActions(children: ReactNode): ReactNode {
  return Children.map(children, (child) =>
    isValidElement<{ className?: string }>(child) && child.type === Button
      ? cloneElement(child as ReactElement<{ className?: string }>, { className: `${child.props.className ?? ""} ${HERO_ACTION}` })
      : child,
  );
}

function Greeting({ lead, em }: { lead: string; em: string }) {
  return (
    <>
      <span className="text-fg-muted">{lead}</span>
      <br />
      {em}
    </>
  );
}

export function PageHeader({ lead, em, children }: PageHeaderProps) {
  const { t } = useI18n();
  const docked = useContext(PageHeaderDock);
  const items = Children.toArray(children);
  const inputs = items.filter(isFileInput);

  if (inputs.length > 0) {
    const actions = asPillActions(items.filter((child) => !isFileInput(child)));
    return (
      <div className={`${COLUMN} pb-6`}>
        {/* Outside the header, and always mounted: the upload button inside the hub holds a ref
            to this input, and the hub unmounts its content when it closes. */}
        {inputs}
        <BrandPageHeader
          className="mb-0"
          mobileCtaDocked={docked}
          greeting={<Greeting lead={lead} em={em} />}
          ctaLabel={copy.t("media.hubOpen")}
          closeLabel={copy.t("media.hubClose")}
          cta={({ expanded, controls, toggle }) => (
            <CtaPill lead={copy.t("cta.media.lead")} emphasis={copy.t("cta.media.emphasis")} tail={copy.t("cta.media.tail")}>
              <Button className={HERO_ACTION} onPress={toggle} aria-expanded={expanded} aria-controls={controls}>
                {copy.t("media.hubOpen")}
              </Button>
            </CtaPill>
          )}
          createHub={
            <div className="flex flex-col gap-3 p-5 pr-14 text-fg-on-brand">
              <h2 className="text-heading4">{copy.t("media.hubTitle")}</h2>
              <p className="text-small">{copy.t("media.hubBody")}</p>
              <div>{actions}</div>
            </div>
          }
        />
      </div>
    );
  }

  // The sentence on the pill follows the screen. Users is compared by the editor's own word for
  // it, which is exactly what the editor passes as `lead` there; anything else gets the generic
  // "create something new", which is true of every other list with an action.
  const users = lead === t("users.lead");
  const pill = users
    ? { lead: copy.t("cta.users.lead"), emphasis: copy.t("cta.users.emphasis"), tail: copy.t("cta.users.tail") }
    : { lead: copy.t("cta.lead"), emphasis: copy.t("cta.emphasis"), tail: copy.t("cta.tail") };
  return (
    <div className={`${COLUMN} pb-6`}>
      <BrandPageHeader
        className="mb-0"
        mobileCtaDocked={docked}
        greeting={<Greeting lead={lead} em={em} />}
        cta={
          items.length > 0 ? (
            <CtaPill {...pill}>
              {asPillActions(children)}
            </CtaPill>
          ) : undefined
        }
      />
    </div>
  );
}
