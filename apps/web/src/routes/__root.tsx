import { useQuery } from "@tanstack/react-query";
import { createLink, createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { ApiProblemError } from "@transfer/api-client";
import { AppShell, InlineNotification, SideNavLink, ToastProvider } from "@transfer/ui";
import { useTranslation } from "react-i18next";
import { meQuery, useApi } from "../api";
import { DevUserSwitcher } from "../components/dev-user-switcher";
import type { RouterContext } from "../router";

const NavLink = createLink(SideNavLink);

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFound,
});

function RootLayout() {
  const { t } = useTranslation();
  const me = useQuery(meQuery(useApi()));
  const unauthenticated = me.error instanceof ApiProblemError && me.error.status === 401;

  return (
    <ToastProvider closeLabel={t("app.closeNotification")}>
      <AppShell
        productName={t("app.name")}
        skipToContentLabel={t("app.skipToContent")}
        navLabel={t("app.navigation")}
        headerInfo={unauthenticated ? t("session.chooseUser") : me.data?.displayName}
        actions={<DevUserSwitcher activeUserId={me.data?.id} />}
        nav={<NavLink to="/projects">{t("projects.title")}</NavLink>}
      >
        <Outlet />
      </AppShell>
    </ToastProvider>
  );
}

function NotFound() {
  const { t } = useTranslation();
  return <InlineNotification kind="warning" title={t("app.notFound")} hideCloseButton />;
}
