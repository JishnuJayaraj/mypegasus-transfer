import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, createLink } from "@tanstack/react-router";
import { AssistedModeHow } from "@transfer/domain";
import { SelfServiceWizard } from "@transfer/self-service-ui";
import { InlineNotification, Link, Stack } from "@transfer/ui";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  participationDocumentsQuery,
  participationQuery,
  participationSelfServiceQuery,
  useApi,
} from "../../api";
import { AssistedBanner, assistedSource } from "../../components/assisted-mode";

const RouterLink = createLink(Link);

type Search = { assistedModeId: string; how?: AssistedModeHow; step?: string };

export const Route = createFileRoute(
  "/projects/$projectId_/participations/$participationId_/assisted",
)({
  validateSearch: (search: Record<string, unknown>): Search => ({
    assistedModeId: typeof search.assistedModeId === "string" ? search.assistedModeId : "",
    ...(AssistedModeHow.safeParse(search.how).success && { how: search.how as AssistedModeHow }),
    ...(typeof search.step === "string" && { step: search.step }),
  }),
  loader: ({ context: { api, queryClient }, params: { participationId } }) =>
    queryClient.ensureQueryData(participationQuery(api, participationId)),
  component: AssistedPage,
});

/**
 * The participant's wizard in assisted mode (ADR-0007, assisted mode): the banner says for whom
 * and ends it; the step is in the URL, so a reload stays on its page while the mode lives.
 */
function AssistedPage() {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const { projectId, participationId } = Route.useParams();
  const { assistedModeId, how, step } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: detail } = useSuspenseQuery(participationQuery(api, participationId));
  const source = useMemo(
    () => assistedSource(api, participationId, assistedModeId),
    [api, participationId, assistedModeId],
  );
  const name = [detail.person.firstName, detail.person.lastName].filter(Boolean).join(" ");
  const back = (
    <RouterLink
      to="/projects/$projectId/participations/$participationId"
      params={{ projectId, participationId }}
      search={{ tab: "self-service" }}
    >
      {t("participant.assisted.back")}
    </RouterLink>
  );

  async function end() {
    const { response } = await api.DELETE(
      "/api/v1/participations/{participationId}/assisted-mode",
      { params: { path: { participationId } } },
    );
    if (!response.ok) throw new Error("Ending assisted mode failed");
    queryClient.removeQueries({ queryKey: source.queryKey });
    queryClient.removeQueries({ queryKey: source.documents.queryKey });
    await queryClient.invalidateQueries({
      queryKey: participationSelfServiceQuery(api, participationId).queryKey,
    });
    await queryClient.invalidateQueries({
      queryKey: participationDocumentsQuery(api, participationId).queryKey,
    });
    await navigate({
      to: "/projects/$projectId/participations/$participationId",
      params: { projectId, participationId },
      search: { tab: "self-service" },
    });
  }

  return (
    <Stack gap={6}>
      <AssistedBanner name={name} how={how} onEnd={end} />
      <div className="tp-assisted-wizard">
        <SelfServiceWizard
          source={source}
          step={step}
          onStep={(next) => void navigate({ search: (prev) => ({ ...prev, step: next }) })}
          expired={
            <Stack gap={5}>
              <InlineNotification
                kind="info"
                title={t("participant.assisted.ended")}
                hideCloseButton
                lowContrast
              />
              {back}
            </Stack>
          }
        />
      </div>
    </Stack>
  );
}
