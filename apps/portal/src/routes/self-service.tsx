import { createFileRoute, Link } from "@tanstack/react-router";
import type { ApiClient } from "@transfer/api-client";
import {
  SELF_SERVICE_NOTICE_VERSION,
  type PortalSelfService,
  type PortalSelfServiceWrite,
  type PortalSensitiveValues,
} from "@transfer/domain";
import { SelfServiceWizard, type SelfServiceSource } from "@transfer/self-service-ui";
import { InlineNotification, Stack } from "@transfer/ui";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { LanguageSelect } from "../components/language";

export const Route = createFileRoute("/self-service")({
  validateSearch: (search: Record<string, unknown>): { step?: string } =>
    typeof search.step === "string" ? { step: search.step } : {},
  component: SelfService,
});

const noData = () => new Error("No portal data");

/**
 * The participant's own wizard routes (data-protection.md, self-service): the sensitive groups on
 * their logged routes and the session's step-up (ADR-0007, step-up).
 */
function portalSource(api: ApiClient): SelfServiceSource {
  return {
    queryKey: ["portal-self-service"],
    load: async () => {
      const { data } = await api.GET("/api/v1/portal/self-service");
      if (!data) throw noData();
      return data as PortalSelfService;
    },
    acknowledge: async (language) => {
      await api.POST("/api/v1/portal/self-service/notice", {
        body: { version: SELF_SERVICE_NOTICE_VERSION, language },
      });
    },
    save: async (page, body) => {
      const { data } = await api.PUT("/api/v1/portal/self-service/pages/{page}", {
        params: { path: { page } },
        body,
      });
      if (!data) throw noData();
      return data as PortalSelfServiceWrite;
    },
    loadSensitive: async (group) => {
      const { data } = await api.GET("/api/v1/portal/self-service/sensitive/{group}", {
        params: { path: { group } },
      });
      if (!data) throw noData();
      return data as PortalSensitiveValues;
    },
    saveSensitive: async (group, body) => {
      const { data } = await api.PUT("/api/v1/portal/self-service/sensitive/{group}", {
        params: { path: { group } },
        body,
      });
      if (!data) throw noData();
      return data as PortalSelfServiceWrite;
    },
    stepUp: {
      birthDate: async (birthDate) => {
        const { data } = await api.POST("/api/v1/portal/step-up/birth-date", {
          body: { birthDate },
        });
        if (!data) throw noData();
        return data;
      },
      channels: async () => {
        const { data } = await api.GET("/api/v1/portal/channels");
        if (!data) throw noData();
        return data.channels;
      },
      requestCode: async (channelId, language) => {
        await api.POST("/api/v1/portal/step-up/code-request", { body: { channelId, language } });
      },
      verifyCode: async (oneTimeCode) => {
        const { data } = await api.POST("/api/v1/portal/step-up/code", { body: { oneTimeCode } });
        if (!data) throw noData();
        return data;
      },
    },
  };
}

/** "Meine Angaben": the wizard; the step is in the URL, so a reload stays on its page. */
function SelfService() {
  const { t } = useTranslation();
  const { api } = Route.useRouteContext();
  const { step } = Route.useSearch();
  const navigate = Route.useNavigate();
  const source = useMemo(() => portalSource(api), [api]);
  return (
    <Stack gap={6}>
      <LanguageSelect id="self-service-language" />
      <SelfServiceWizard
        source={source}
        step={step}
        onStep={(next) => void navigate({ search: { step: next } })}
        expired={
          <Stack gap={5}>
            <InlineNotification kind="warning" title={t("channels.expired")} hideCloseButton />
            <Link to="/login">{t("home.login")}</Link>
          </Stack>
        }
      />
      <Link to="/">{t("activate.done.home")}</Link>
    </Stack>
  );
}
