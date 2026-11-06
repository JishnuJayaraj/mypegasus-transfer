import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { ApiProblemError } from "@transfer/api-client";
import { Button, InlineNotification } from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { staffUsersQuery, useApi } from "../api";

/**
 * Dev stub login (ADR-0007, AUTH_MODE=dev): the synthetic staff users; choosing one starts a
 * session in the store like an OIDC login. Only rendered when the dev routes answer.
 */
export function DevUserList({
  activeUserId,
  onLoggedIn,
}: {
  activeUserId?: string | undefined;
  onLoggedIn: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const users = useQuery(staffUsersQuery(api));
  const [refused, setRefused] = useState(false);

  if (!users.data) return null;

  async function choose(staffUserId: string) {
    try {
      await api.POST("/api/v1/dev/session", { body: { staffUserId } });
    } catch (error) {
      if (!(error instanceof ApiProblemError) || error.status !== 422) throw error;
      setRefused(true);
      return;
    }
    await onLoggedIn();
  }

  return (
    <>
      {refused && (
        <InlineNotification
          kind="error"
          title={t("session.noAccess")}
          subtitle={t("session.errors.account_deactivated")}
          hideCloseButton
        />
      )}
      <ul className="tp-user-list" aria-label={t("session.switcher")}>
        {users.data.map((user) => (
          <li key={user.id}>
            <Button
              kind="ghost"
              aria-current={user.id === activeUserId}
              onClick={() => void choose(user.id)}
            >
              {user.role
                ? `${user.displayName} · ${t(`session.roles.${user.role}`)}`
                : user.displayName}
            </Button>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * The user menu's dev switcher: change the user without logging out first. Renders nothing
 * unless the dev routes answer (AUTH_MODE=dev), so it never shows with OIDC.
 */
export function DevUserSwitcher({
  activeUserId,
  onSwitched,
}: {
  activeUserId: string | undefined;
  /** After the switch, e.g. to close the user menu. */
  onSwitched: () => void;
}) {
  const { t } = useTranslation();
  const users = useQuery({ ...staffUsersQuery(useApi()), retry: false });
  const queryClient = useQueryClient();
  const router = useRouter();

  if (!users.data) return null;

  return (
    <div>
      <p className="tp-user-roles">{t("session.switcher")}</p>
      <DevUserList
        activeUserId={activeUserId}
        onLoggedIn={async () => {
          onSwitched();
          await queryClient.invalidateQueries();
          await router.invalidate();
        }}
      />
    </div>
  );
}
