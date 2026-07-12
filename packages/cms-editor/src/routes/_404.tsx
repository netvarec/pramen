// Fallback for an unmatched path.

import { createPage, useNavigate } from "@buzola/router";
import { Button } from "@podoba/react";

export default createPage().render(function NotFound() {
  const navigate = useNavigate();
  return (
    <div className="mx-auto max-w-[1200px] px-7 pt-8">
      <h1 className="m-0 text-[56px] font-normal leading-[1.05] tracking-[-0.01em] max-[820px]:text-[40px]">
        <span className="block text-fg-subtle">Not found</span>
        <span className="block text-fg">Nothing lives here</span>
      </h1>
      <div className="mt-4 flex items-center gap-2">
        <p className="text-fg-subtle">That page doesn&apos;t exist.</p>
        <Button variant="ghost" size="sm" onPress={() => navigate("home")}>← back to pages</Button>
      </div>
    </div>
  );
});
