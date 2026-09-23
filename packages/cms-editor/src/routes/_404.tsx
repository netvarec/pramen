// Fallback for an unmatched path.

import { createPage, useNavigate } from "@buzola/router";
import { Button } from "@podoba/react";
import { CONTENT } from "../chrome";
import { useI18n } from "../i18n";

export default createPage().render(function NotFound() {
  const navigate = useNavigate();
  const { t } = useI18n();
  return (
    <div className={`${CONTENT} pt-8`}>
      <h1 className="m-0 text-[56px] font-normal leading-[1.05] tracking-[-0.01em] max-[820px]:text-[40px]">
        <span className="block text-fg-subtle">{t("notFound.eyebrow")}</span>
        <span className="block text-fg">{t("notFound.title")}</span>
      </h1>
      <div className="mt-4 flex items-center gap-2">
        <p className="text-fg-subtle">{t("notFound.body")}</p>
        <Button variant="ghost" size="sm" onPress={() => navigate("home")}>{t("notFound.back")}</Button>
      </div>
    </div>
  );
});
