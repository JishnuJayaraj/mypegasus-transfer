import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { InlineNotification, PortalShell } from "@transfer/ui";
import { useTranslation } from "react-i18next";
import type { RouterContext } from "../router";

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFound,
});

function RootLayout() {
  const { t } = useTranslation();
  return (
    <PortalShell
      productName={t("app.name")}
      skipToContentLabel={t("app.skipToContent")}
      homeHref={import.meta.env.BASE_URL}
    >
      <Outlet />
    </PortalShell>
  );
}

function NotFound() {
  const { t } = useTranslation();
  return <InlineNotification kind="warning" title={t("app.notFound")} hideCloseButton />;
}
