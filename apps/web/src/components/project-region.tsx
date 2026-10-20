import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ApiProblemError } from "@transfer/api-client";
import { Button, InlineNotification, Select, SelectItem } from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { projectConfigQuery, projectQuery, regionsQuery, useApi } from "../api";

/**
 * The project's region (Q126): shown to everyone who sees the project; changed by the PL while
 * draft and by a global admin at any time, as `capabilities.setProjectRegion` says.
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
  const current = regions.data?.find((region) => region.id === project.regionId);

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

  return (
    <div className="tp-bulk-actions">
      {config.capabilities.setProjectRegion ? (
        <>
          <Select
            id="project-region-change"
            labelText={t("projectForm.region")}
            value={regionId}
            onChange={(event) => setRegionId(event.target.value)}
          >
            {!project.regionId && <SelectItem value="" text={t("projectForm.chooseRegion")} />}
            {(regions.data ?? []).map((region) => (
              <SelectItem
                key={region.id}
                value={region.id}
                text={`${region.name} (${region.code})`}
              />
            ))}
          </Select>
          <Button
            kind="secondary"
            disabled={!regionId || regionId === project.regionId || change.isPending}
            onClick={() => change.mutate()}
          >
            {t("projectRegion.save")}
          </Button>
        </>
      ) : (
        <p>
          {current
            ? t("projectRegion.current", { region: `${current.name} (${current.code})` })
            : t("projectRegion.none")}
        </p>
      )}
      {refusal && (
        <InlineNotification
          kind="error"
          title={t(`projectRegion.errors.${refusal}`, {
            defaultValue: t("projectRegion.errors.failed"),
          })}
          onClose={() => setRefusal(undefined)}
        />
      )}
    </div>
  );
}
