import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Button, HeaderGlobalAction, HeaderPanel, UserAvatar } from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { staffUsersQuery, useApi } from "../api";

/**
 * Dev stub login (ADR-0007): pick one of the synthetic staff users. Only rendered when the
 * dev routes answer, i.e. with AUTH_MODE=dev.
 */
export function DevUserSwitcher({ activeUserId }: { activeUserId: string | undefined }) {
  const { t } = useTranslation();
  const api = useApi();
  const users = useQuery(staffUsersQuery(api));
  const queryClient = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  if (!users.data) return null;

  async function choose(staffUserId: string) {
    await api.POST("/api/v1/dev/session", { body: { staffUserId } });
    setOpen(false);
    await queryClient.invalidateQueries();
    await router.invalidate();
  }

  return (
    <>
      <HeaderGlobalAction
        aria-label={t("session.switcher")}
        aria-expanded={open}
        isActive={open}
        tooltipAlignment="end"
        onClick={() => setOpen(!open)}
      >
        <UserAvatar size={20} />
      </HeaderGlobalAction>
      <HeaderPanel expanded={open} onHeaderPanelFocus={() => {}}>
        <ul className="tp-user-list" aria-label={t("session.switcher")}>
          {users.data.map((user) => (
            <li key={user.id}>
              <Button
                kind="ghost"
                aria-current={user.id === activeUserId}
                onClick={() => void choose(user.id)}
              >
                {`${user.displayName} · ${t(`session.roles.${user.role}`)}`}
              </Button>
            </li>
          ))}
        </ul>
      </HeaderPanel>
    </>
  );
}
