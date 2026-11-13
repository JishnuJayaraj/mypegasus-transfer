import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiProblemError } from "@transfer/api-client";
import { ActionButton, InlineNotification, Loading, Select, SelectItem, Stack } from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { projectDsvTemplateQuery, useApi } from "../api";

/**
 * "DSV-Vorlage" on "Einrichtung" (ADR-0009, the DSV template): the project's pinned
 * DSV template version, chosen by the PL while no DSV of the project was generated and fixed from
 * the first generation. A version not approved for live use is a synthetic sample, said so next
 * to it. Back office reads it; others are told who may.
 */
export function DsvTemplateStep({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const query = useQuery(projectDsvTemplateQuery(api, projectId));
  const [chosen, setChosen] = useState<string>();
  const [outcome, setOutcome] = useState<{ kind: "success" | "error"; text: string }>();
  const pin = useMutation({
    mutationFn: async (version: string) => {
      const { error } = await api.PUT("/api/v1/projects/{projectId}/dsv-template", {
        params: { path: { projectId } },
        body: { version: version as `v${number}` },
      });
      if (error) throw error;
    },
    onSuccess: async () => {
      setChosen(undefined);
      setOutcome({ kind: "success", text: t("dsvTemplate.pinned") });
      await queryClient.invalidateQueries({ queryKey: ["projects", projectId, "dsv-template"] });
    },
    onError: (error) => {
      const code = error instanceof ApiProblemError ? error.problem.errors?.[0]?.code : undefined;
      const known = code && t(`dsvTemplate.codes.${code}` as never, { defaultValue: "" });
      setOutcome({ kind: "error", text: known || t("dsvTemplate.failed") });
    },
  });

  const body = () => {
    if (query.isPending) return <Loading label={t("dsvTemplate.loading")} />;
    if (query.isError) {
      const forbidden = query.error instanceof ApiProblemError && query.error.status === 403;
      return <p>{t(forbidden ? "dsvTemplate.forbidden" : "dsvTemplate.failed")}</p>;
    }
    const view = query.data;
    const label = (version: string, approved: boolean) =>
      approved ? version : t("dsvTemplate.sample", { version });
    const current = view.versions.find((entry) => entry.version === view.version);
    const selected = chosen ?? view.version ?? "";
    return (
      <Stack gap={5}>
        <p>
          {view.version
            ? t(view.fixed ? "dsvTemplate.fixed" : "dsvTemplate.current", {
                version: label(view.version, current?.approvedForLive ?? false),
              })
            : t("dsvTemplate.none")}
        </p>
        {outcome && (
          <InlineNotification
            kind={outcome.kind}
            role={outcome.kind === "error" ? "alert" : "status"}
            title={outcome.text}
            onClose={() => setOutcome(undefined)}
            lowContrast
          />
        )}
        {view.capabilities.pin && (
          <>
            <Select
              id={`dsv-template-${projectId}`}
              labelText={t("dsvTemplate.version")}
              value={selected}
              onChange={(event) => setChosen(event.target.value)}
            >
              {view.version === null && <SelectItem value="" text={t("dsvTemplate.choose")} />}
              {view.versions.map((entry) => (
                <SelectItem
                  key={entry.version}
                  value={entry.version}
                  text={label(entry.version, entry.approvedForLive)}
                />
              ))}
            </Select>
            <div>
              <ActionButton
                size="md"
                disabled={pin.isPending}
                unavailableReason={
                  selected === "" || selected === view.version ? t("dsvTemplate.chooseFirst") : null
                }
                onClick={() => pin.mutate(selected)}
              >
                {t("dsvTemplate.pin")}
              </ActionButton>
            </div>
          </>
        )}
        <p className="tp-hint">{t("dsvTemplate.hint")}</p>
      </Stack>
    );
  };

  return body();
}
