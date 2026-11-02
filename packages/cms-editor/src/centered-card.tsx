// The card the editor shows on its own, with no chrome around it: the Setup screen and the
// unsupported-browser notice. One definition, so the two screens a signed-out reader can land
// on stay the same shape.

import type { ReactNode } from "react";

export function CenteredCard({ children, role }: { children: ReactNode; role?: "alert" }) {
  return (
    <div className="mx-auto mt-[14vh] w-full max-w-[520px] px-6">
      <div role={role} className="rounded-panel border border-border bg-surface-card px-10 py-8 shadow-[0_24px_60px_rgba(30,20,10,0.08)]">
        {children}
      </div>
    </div>
  );
}
