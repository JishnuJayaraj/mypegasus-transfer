import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ApiProblemError } from "@transfer/api-client";
import type { PortalMe } from "@transfer/domain";
import { Button, InlineNotification, Stack, formatTimestamp } from "@transfer/ui";
import { useTranslation } from "react-i18next";
import { LanguageSelect } from "../components/language";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const { t } = useTranslation();
  const { api } = Route.useRouteContext();
  // The logged-in participant, or null without a live session (an idle or expired one too).
  const me = useQuery({
    queryKey: ["portal-me"],
    queryFn: async () => {
      try {
        const { data } = await api.GET("/api/v1/portal/me");
        if (!data) throw new Error("No portal data");
        return data;
      } catch (error) {
        if (error instanceof ApiProblemError && error.status === 401) return null;
        throw error;
      }
    },
  });
  return (
    <Stack gap={6}>
      <LanguageSelect id="portal-language" />
      {me.data ? (
        <Participant me={me.data} />
      ) : (
        <>
          <h1>{t("home.title")}</h1>
          <p>{t("home.intro")}</p>
          {!me.isPending && (
            <Stack gap={3}>
              <Link to="/login">{t("home.login")}</Link>
              <Link to="/activate">{t("home.activate")}</Link>
            </Stack>
          )}
        </>
      )}
      <ApiStatus />
    </Stack>
  );
}

/** Greeting, the participant's own channels (masked) and their pages (ADR-0007). */
function Participant({ me }: { me: PortalMe }) {
  const { t } = useTranslation();
  const { api } = Route.useRouteContext();
  const queryClient = useQueryClient();
  return (
    <Stack gap={5}>
      <h1>{t("home.greeting", { name: me.firstName })}</h1>
      <h2>{t("home.channels")}</h2>
      <ul className="tp-list">
        {me.channels.map((channel) => (
          <li key={channel.id}>
            {t(channel.kind === "email" ? "home.channelEmail" : "home.channelSms", {
              address: channel.maskedAddress,
              at: formatTimestamp(channel.verifiedAt),
            })}
          </li>
        ))}
      </ul>
      <Stack gap={3}>
        <Link to="/self-service">{t("home.selfService")}</Link>
        <Link to="/consents">{t("home.consents")}</Link>
        <Link to="/channels">{t("home.manageChannels")}</Link>
      </Stack>
      <Button
        kind="secondary"
        onClick={async () => {
          await api.POST("/api/v1/portal/logout", { body: {} });
          // Nothing of the participant stays in the cache after logout.
          queryClient.removeQueries({ queryKey: ["portal-self-service"] });
          queryClient.removeQueries({ queryKey: ["portal-consents"] });
          queryClient.removeQueries({ queryKey: ["portal-documents"] });
          queryClient.setQueryData(["portal-me"], null);
        }}
      >
        {t("home.logout")}
      </Button>
    </Stack>
  );
}

/** The API status from GET /api/v1/health, through the typed client (no participant data). */
function ApiStatus() {
  const { t } = useTranslation();
  const { api } = Route.useRouteContext();
  const health = useQuery({
    queryKey: ["health"],
    queryFn: async () => {
      const { data } = await api.GET("/api/v1/health");
      if (!data) throw new Error("No health data");
      return data;
    },
  });

  if (health.isPending) {
    return (
      <InlineNotification kind="info" title={t("status.checking")} hideCloseButton lowContrast />
    );
  }
  if (health.isError) {
    return (
      <InlineNotification
        kind="error"
        title={t("status.unavailable")}
        hideCloseButton
        lowContrast
      />
    );
  }
  return (
    <InlineNotification
      kind="success"
      title={t("status.ok", { version: health.data.version })}
      hideCloseButton
      lowContrast
    />
  );
}
