import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Button,
  Card,
  InlineNotification,
  Loading,
  Logout,
  Stack,
  formatTimestamp,
} from "@transfer/ui";
import { useTranslation } from "react-i18next";
import { meQuery, useLogout } from "../session";

export const Route = createFileRoute("/account")({ component: Account });

/** "Mein Konto": the participant's own channels (masked, ADR-0007) and "Abmelden". */
function Account() {
  const { t } = useTranslation();
  const { api } = Route.useRouteContext();
  const me = useQuery(meQuery(api));
  const logout = useLogout();
  if (me.isPending) return <Loading />;
  if (!me.data) {
    return (
      <Stack gap={5}>
        <h1>{t("account.title")}</h1>
        <InlineNotification kind="warning" title={t("channels.expired")} hideCloseButton />
        <Link to="/login">{t("home.login")}</Link>
      </Stack>
    );
  }
  return (
    <Stack gap={6}>
      <h1>{t("account.title")}</h1>
      <Card
        title={t("home.channels")}
        actions={<Link to="/channels">{t("home.manageChannels")}</Link>}
      >
        <ul className="tp-list">
          {me.data.channels.map((channel) => (
            <li key={channel.id}>
              {t(channel.kind === "email" ? "home.channelEmail" : "home.channelSms", {
                address: channel.maskedAddress,
                at: formatTimestamp(channel.verifiedAt),
              })}
            </li>
          ))}
        </ul>
      </Card>
      <Card title={t("account.session")} description={t("account.sessionText")}>
        <div>
          <Button kind="tertiary" renderIcon={Logout} onClick={() => void logout()}>
            {t("account.logout")}
          </Button>
        </div>
      </Card>
    </Stack>
  );
}
