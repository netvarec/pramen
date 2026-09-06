// The blast radius of a panel.
//
// A panel is a project's own component rendering inside THIS app's React tree, which is the
// whole point of it — and the cost of that is that a throw in its render is a throw in ours.
// React's answer to an uncaught render error is to unmount the entire root, so without a
// boundary one bad panel does not break a screen, it blanks the admin: no sidebar, no way to
// navigate off the route that is failing, and a reload lands straight back on it because the
// URL is a real route.
//
// So the panel route wraps it. The chrome survives, the reader is told which panel failed and
// with what, and every other section stays one click away.
//
// A CLASS, because `componentDidCatch`/`getDerivedStateFromError` have no hook equivalent —
// there is still no way to catch a render error from a function component. Its own module so
// the decision is testable without dragging in the router and the design system.

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /** Named in the message — a deployment with three panels needs to know which one. */
  slug: string;
  children: ReactNode;
}

interface State {
  /** The failure's message, or `null` while the panel is fine. */
  failure: string | null;
}

/** What a caught error reads as. A named function because it is the one piece of judgement
 * here: an error with no message (a thrown string, a thrown object) must still produce
 * something a reader can act on, and `String(undefined)` is not it. */
export function panelFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() === "" ? "threw a value with no message" : message;
}

export class PanelBoundary extends Component<Props, State> {
  override state: State = { failure: null };

  static getDerivedStateFromError(error: unknown): State {
    return { failure: panelFailureMessage(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The rendered message names the panel and the error; the console gets the component
    // stack, which is the half a developer needs and a reader cannot use.
    console.error(`pramen/cms-editor: panel '${this.props.slug}' failed to render`, error, info.componentStack);
  }

  override componentDidUpdate(prev: Props): void {
    // Navigating to a different panel must clear the failure — the route keys on the slug so
    // this rarely fires, but a boundary that latched would turn one panel's bug into every
    // panel's bug for the rest of the session.
    if (prev.slug !== this.props.slug && this.state.failure !== null) this.setState({ failure: null });
  }

  override render(): ReactNode {
    if (this.state.failure === null) return this.props.children;
    return (
      <div role="alert" className="rounded-panel border border-border bg-surface-card px-6 py-5 text-sm text-fg-muted">
        <p className="mb-1 text-fg">The <strong>{this.props.slug}</strong> panel failed to render.</p>
        <p className="font-mono text-caption">{this.state.failure}</p>
      </div>
    );
  }
}
