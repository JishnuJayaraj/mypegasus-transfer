import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createLink,
  createRootRouteWithContext,
  Outlet,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import type { CurrentStaffUser } from "@transfer/domain";
import {
  AppShell,
  Button,
  Folder,
  HeaderPanelAction,
  InlineNotification,
  Location,
  Logout,
  SideNavGroup,
  SideNavLink,
  TaskApproved,
  ToastProvider,
  UserAvatar,
  UserMultiple,
  WarningAlt,
} from "@transfer/ui";
import { useTranslation } from "react-i18next";
import { meQuery, useApi } from "../api";
import { DevUserSwitcher } from "../components/dev-user-switcher";
import { usePageTitle } from "../page-title";
import type { RouterContext } from "../router";

const NavLink = createLink(SideNavLink);
/** The active route's link gets Carbon's indicator; the router adds `aria-current="page"`. */
const active = { activeProps: { isActive: true } } as const;

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
        menuLabel={t("app.menu")}
        actions={user && <UserMenu user={user} />}
        nav={user && <Navigation user={user} />}
      >
        <Outlet />
      </AppShell>
    </ToastProvider>
  );
}

/** The side navigation: "Arbeit" for everyone, "Verwaltung" only with an administrative role. */
function Navigation({ user }: { user: CurrentStaffUser }) {
  const { t } = useTranslation();
  const has = (test: (grant: CurrentStaffUser["orgRoles"][number]) => boolean) =>
    user.orgRoles.some(test);
  // The global admin's administration (Q126); the API refuses everyone else.
  const admin = has((grant) => grant.role === "admin");
  // The regional view (Q57): the regional admins and the admin; counts only.
  const escalations = has(
    (grant) =>
      grant.role === "regional_admin" || (grant.role === "admin" && grant.regionId === null),
  );
  // The queue "Freigaben" (Q80): the regional operations managers.
  const reviews = has((grant) => grant.role === "regional_operations_manager");

  return (
    <>
      <SideNavGroup label={t("app.navGroups.work")}>
        <NavLink to="/projects" renderIcon={Folder} {...active}>
          {t("projects.title")}
        </NavLink>
        {reviews && (
          <NavLink to="/reviews" renderIcon={TaskApproved} {...active}>
            {t("reviews.title")}
          </NavLink>
        )}
      </SideNavGroup>
      {(admin || escalations) && (
        <SideNavGroup label={t("app.navGroups.admin")}>
          {admin && (
            <>
              <NavLink to="/admin/staff" renderIcon={UserMultiple} {...active}>
                {t("adminStaff.title")}
              </NavLink>
              <NavLink to="/admin/regions" renderIcon={Location} {...active}>
                {t("adminRegions.title")}
              </NavLink>
            </>
          )}
          {escalations && (
            <NavLink to="/admin/escalations" renderIcon={WarningAlt} {...active}>
              {t("escalations.title")}
            </NavLink>
          )}
        </SideNavGroup>
      )}
    </>
  );
}

/**
 * The user menu: who is logged in with which organisation roles (project roles differ per
 * project), "Abmelden" and, only where the dev routes answer, the dev user switcher.
 */
function UserMenu({ user }: { user: CurrentStaffUser }) {
  const { t } = useTranslation();
  const roles = [...new Set(user.orgRoles.map((grant) => grant.role))].map((role) =>
    t(`session.roles.${role}`),
  );
  return (
    <HeaderPanelAction
      label={t("session.userMenu", { name: user.displayName })}
      icon={<UserAvatar size={20} />}
    >
      {(close) => (
        <>
          <div>
            <p className="tp-user-name">{user.displayName}</p>
            <p className="tp-user-roles">
              {roles.length > 0 ? roles.join(", ") : t("session.projectRoles")}
            </p>
          </div>
          <LogoutButton />
          <DevUserSwitcher activeUserId={user.id} onSwitched={close} />
        </>
      )}
    </HeaderPanelAction>
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
    <Button kind="secondary" size="md" renderIcon={Logout} onClick={() => void logout()}>
      {t("session.logout")}
    </Button>
  );
}

function NotFound() {
  const { t } = useTranslation();
  usePageTitle(t("app.notFoundTitle"));
  return <InlineNotification kind="warning" title={t("app.notFound")} hideCloseButton />;
}
