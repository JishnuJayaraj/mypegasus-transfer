import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ApiProblemError } from "@transfer/api-client";
import { Button, InlineNotification, Select, SelectItem, Stack } from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { projectConfigQuery, projectQuery, regionsQuery, useApi } from "../api";

/**
 * The project's region as one line of text ("Region: Niederlassung Nord (NORD)"), for the page
 * header's metadata (Q126: everyone who sees the project sees its region). A component of its own,
 * so the regions arriving re-render only this text, never the page and its open tab.
 */
export function RegionText({ projectId }: { projectId: string }) {
  return <>{useRegionText(projectId)}</>;
}

function useRegionText(projectId: string): string | undefined {
  const { t } = useTranslation();
  const api = useApi();
  const { data: project } = useSuspenseQuery(projectQuery(api, projectId));
  const regions = useQuery(regionsQuery(api));
  if (!project.regionId) return t("projectRegion.none");
  const current = regions.data?.find((region) => region.id === project.regionId);
  return current
    ? t("projectRegion.current", { region: `${current.name} (${current.code})` })
    : undefined;
}

/**
 * Changing the project's region (Q126), in "Einrichtung": by the PL while draft and by a global
 * admin at any time, as `capabilities.setProjectRegion` says; nothing for anyone else, who sees
 * the region in the page header. The API's refusal stays the enforcement.
 */
export function ProjectRegion({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const { data: project } = useSuspenseQuery(projectQuery(api, projectId));
  const { data: config } = useSuspenseQuery(projectConfigQuery(api, projectId));
  const regions = useQuery(regionsQuery(api));
  const [regionId, setRegionId] = useState(project.regionId ?? "");
  const [refusal, setRefusal] = useState<string>();

  const change = useMutation({
    mutationFn: async () => {
      await api.PATCH("/api/v1/projects/{projectId}", {
        params: { path: { projectId } },
        body: { regionId },
      });
    },
    onSuccess: async () => {
      setRefusal(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectQuery(api, projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: ["projects"], exact: true }),
      ]);
    },
    onError: (error) =>
      setRefusal(
        error instanceof ApiProblemError ? (error.problem.errors?.[0]?.code ?? "failed") : "failed",
      ),
  });

  if (!config.capabilities.setProjectRegion) return null;
  return (
    <Stack gap={5} className="tp-form">
      <Select
        id="project-region-change"
        labelText={t("projectForm.region")}
        value={regionId}
        onChange={(event) => setRegionId(event.target.value)}
      >
        {!project.regionId && <SelectItem value="" text={t("projectForm.chooseRegion")} />}
        {(regions.data ?? []).map((region) => (
          <SelectItem key={region.id} value={region.id} text={`${region.name} (${region.code})`} />
        ))}
      </Select>
      {refusal && (
        <InlineNotification
          kind="error"
          title={t(`projectRegion.errors.${refusal}`, {
            defaultValue: t("projectRegion.errors.failed"),
          })}
          onClose={() => setRefusal(undefined)}
        />
      )}
      <div>
        <Button
          kind="secondary"
          disabled={!regionId || regionId === project.regionId || change.isPending}
          onClick={() => change.mutate()}
        >
          {t("projectRegion.save")}
        </Button>
      </div>
    </Stack>
  );
}
