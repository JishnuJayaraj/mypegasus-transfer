import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ApiProblemError } from "@transfer/api-client";
import { InlineNotification, Stack, formatTimestamp } from "@transfer/ui";
import { useTranslation } from "react-i18next";

export const Route = createFileRoute("/consents")({ component: Consents });

/**
 * "Einwilligungen": the participant's own consents (data-protection.md, self-service): purpose,
 * text version, given and ended. Revoking the portal contact is removing that channel.
 */
function Consents() {
  const { t } = useTranslation();
  const { api } = Route.useRouteContext();
  const consents = useQuery({
    queryKey: ["portal-consents"],
    queryFn: async () => {
      const { data } = await api.GET("/api/v1/portal/consents");
      if (!data) throw new Error("No portal data");
      return data.consents;
    },
    retry: false,
  });

  if (consents.isPending) return <p>{t("status.checking")}</p>;
  if (consents.isError) {
    const expired = consents.error instanceof ApiProblemError && consents.error.status === 401;
    return (
      <Stack gap={5}>
        <h1>{t("consents.title")}</h1>
        <InlineNotification
          kind={expired ? "warning" : "error"}
          title={t(expired ? "channels.expired" : "consents.failed")}
          hideCloseButton
        />
        {expired && <Link to="/login">{t("home.login")}</Link>}
      </Stack>
    );
  }
  return (
    <Stack gap={6}>
      <h1>{t("consents.title")}</h1>
      <p>{t("consents.intro")}</p>
      {consents.data.length === 0 ? (
        <p>{t("consents.empty")}</p>
      ) : (
        <ul className="tp-overview">
          {consents.data.map((consent) => (
            <li key={consent.id}>
              <Stack gap={2}>
                <h2>{t(`consents.purpose.${consent.purpose}`)}</h2>
                <span>
                  {t("consents.given", {
                    at: formatTimestamp(consent.givenAt),
                    source: t(`consents.source.${consent.source}`),
                  })}
                </span>
                <span>
                  {consent.endedAt
                    ? t("consents.ended", {
                        at: formatTimestamp(consent.endedAt),
                        reason: t(`consents.endReason.${consent.endReason ?? "revoked"}`),
                      })
                    : t("consents.active")}
                </span>
                <span className="tp-hint">
                  {t("consents.version", { version: consent.textVersion })}
                </span>
              </Stack>
            </li>
          ))}
        </ul>
      )}
      <p>{t("consents.portalContact")}</p>
      <Link to="/channels">{t("home.manageChannels")}</Link>
      <Link to="/">{t("activate.done.home")}</Link>
    </Stack>
  );
}
