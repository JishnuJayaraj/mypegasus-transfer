import type { ErrorComponentProps } from "@tanstack/react-router";
import { ApiProblemError } from "@transfer/api-client";
import { InlineNotification } from "@transfer/ui";
import { useTranslation } from "react-i18next";

/** Route error: a 401 is on its way to the login page (router.tsx); anything else is generic. */
export function RouteError({ error }: ErrorComponentProps) {
  const { t } = useTranslation();
  if (error instanceof ApiProblemError && error.status === 401) return null;
  return <InlineNotification kind="error" title={t("app.error")} hideCloseButton />;
}
