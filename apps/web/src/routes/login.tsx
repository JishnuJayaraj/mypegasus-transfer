import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ApiProblemError } from "@transfer/api-client";
import { safeReturnPath } from "@transfer/domain";
import { Button, InlineNotification, Loading, PageHeader, Stack } from "@transfer/ui";
import { useTranslation } from "react-i18next";
import { staffUsersQuery, useApi } from "../api";
import { DevUserList } from "../components/dev-user-switcher";

// The staff login page (Slice 3 plan, Web; flow 1). With AUTH_MODE=oidc: "Anmelden" goes to the
// identity provider through `GET /api/v1/auth/login`, which comes back here with `error` when it
// refuses. With AUTH_MODE=dev (the dev routes answer): the user switcher.

const loginErrors = [
  "unknown_account",
  "account_deactivated",
  "identity_mismatch",
  "login_failed",
] as const;
type LoginError = (typeof loginErrors)[number];

export interface LoginSearch {
  returnTo?: string;
  reason?: "expired";
  error?: LoginError;
}

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    ...(typeof search.returnTo === "string" && { returnTo: search.returnTo }),
    ...(search.reason === "expired" && { reason: "expired" as const }),
    ...(typeof search.error === "string" && {
      error: loginErrors.includes(search.error as LoginError)
        ? (search.error as LoginError)
        : "login_failed",
    }),
  }),
  component: LoginPage,
});

function LoginPage() {
  const { t } = useTranslation();
  const { returnTo, reason, error } = Route.useSearch();
  const devUsers = useQuery({ ...staffUsersQuery(useApi()), retry: false });
  const queryClient = useQueryClient();
  const router = useRouter();
  const target = safeReturnPath(returnTo);
  // Dev routes are mounted only with AUTH_MODE=dev; their 404 means OIDC.
  const oidc = devUsers.error instanceof ApiProblemError && devUsers.error.status === 404;

  return (
    <div className="tp-login">
      <PageHeader title={t("session.login.title")} />
      <Stack gap={5}>
        {reason === "expired" && !error && (
          <InlineNotification
            kind="info"
            title={t("session.expired")}
            subtitle={t("session.expiredDetail")}
            hideCloseButton
          />
        )}
        {error && (
          <InlineNotification
            kind="error"
            title={t(error === "login_failed" ? "session.loginFailed" : "session.noAccess")}
            subtitle={t(`session.errors.${error}`)}
            hideCloseButton
          />
        )}
        {devUsers.isPending && <Loading withOverlay={false} small />}
        {devUsers.data && (
          <>
            <p>{t("session.login.dev")}</p>
            <DevUserList
              onLoggedIn={async () => {
                await queryClient.invalidateQueries();
                router.history.push(target);
              }}
            />
          </>
        )}
        {oidc && (
          <>
            <p>{t("session.login.oidc")}</p>
            <div>
              <Button href={`/api/v1/auth/login?returnTo=${encodeURIComponent(target)}`}>
                {t("session.login.submit")}
              </Button>
            </div>
          </>
        )}
        {devUsers.isError && !oidc && (
          <InlineNotification kind="error" title={t("app.error")} hideCloseButton />
        )}
      </Stack>
    </div>
  );
}
