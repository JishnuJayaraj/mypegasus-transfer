import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { InlineNotification, Select, SelectItem, Stack } from "@transfer/ui";
import { useTranslation } from "react-i18next";
import { languages } from "../i18n";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const { t, i18n } = useTranslation();
  return (
    <Stack gap={6}>
      <Select
        id="portal-language"
        labelText={t("language.label")}
        value={i18n.resolvedLanguage}
        onChange={(event) => void i18n.changeLanguage(event.target.value)}
        inline
      >
        {Object.entries(languages).map(([code, name]) => (
          <SelectItem key={code} value={code} text={name} lang={code} />
        ))}
      </Select>
      <h1>{t("home.title")}</h1>
      <p>{t("home.intro")}</p>
      <ApiStatus />
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
