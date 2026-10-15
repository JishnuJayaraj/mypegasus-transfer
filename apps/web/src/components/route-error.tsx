import type { ErrorComponentProps } from "@tanstack/react-router";
import { ApiProblemError } from "@transfer/api-client";
import { InlineNotification } from "@transfer/ui";
import { useTranslation } from "react-i18next";

/** Route error: a 401 asks for a dev user; anything else is a generic error. */
export function RouteError({ error }: ErrorComponentProps) {
  const { t } = useTranslation();
  if (error instanceof ApiProblemError && error.status === 401) {
    return <InlineNotification kind="info" title={t("session.chooseUser")} hideCloseButton />;
  }
  return <InlineNotification kind="error" title={t("app.error")} hideCloseButton />;
}
