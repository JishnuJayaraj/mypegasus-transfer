import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createLink,
  createRootRouteWithContext,
  Outlet,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { AppShell, Button, InlineNotification, SideNavLink, ToastProvider } from "@transfer/ui";
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
  const onLogin = useRouterState({ select: (s) => s.location.pathname === "/login" });
  const me = useQuery({ ...meQuery(useApi()), enabled: !onLogin });
  const user = onLogin ? undefined : me.data;

  return (
    <ToastProvider closeLabel={t("app.closeNotification")}>
      <AppShell
        productName={t("app.name")}
        skipToContentLabel={t("app.skipToContent")}
        navLabel={t("app.navigation")}
        headerInfo={user?.displayName}
        actions={
          user && (
            <>
              <DevUserSwitcher activeUserId={user.id} />
              <LogoutButton />
            </>
          )
        }
        nav={user && <NavLink to="/projects">{t("projects.title")}</NavLink>}
      >
        <Outlet />
      </AppShell>
    </ToastProvider>
  );
}

/** "Abmelden": ends the session in the store, forgets what was loaded, shows the login page. */
function LogoutButton() {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const router = useRouter();

  async function logout() {
    await api.POST("/api/v1/auth/logout", { body: {} });
    router.options.context.session.end();
    queryClient.clear();
    await router.navigate({ to: "/login" });
  }

  return (
    <Button kind="ghost" className="tp-header-action" onClick={() => void logout()}>
      {t("session.logout")}
    </Button>
  );
}

function NotFound() {
  const { t } = useTranslation();
  return <InlineNotification kind="warning" title={t("app.notFound")} hideCloseButton />;
}
