import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import { Button, InlineNotification, Stack, useToast } from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { projectConfigQuery, projectQuery, useApi } from "../api";

type ProjectConfig = components["schemas"]["ProjectConfig"];
type Blocker = components["schemas"]["ConfigBlocker"];

/** A submission blocker as text: its Agentur and step, and what is missing (Q91, Q92). */
export function useSubmissionText(config: ProjectConfig) {
  const { t } = useTranslation();
  const labelOf = (key: string | null) =>
    config.pins.find((pin) => pin.agenturKey === key)?.label.de ?? key ?? "";
  return (blocker: Blocker) =>
    blocker.code === "agentur_submission_blocked"
      ? t("setup.submissionBlocked", {
          agentur: labelOf(blocker.agenturKey),
          step: t(`setup.steps.${blocker.step}`),
          missing: blocker.missing
            .map((key) => t(`setup.settings.${key}`, { defaultValue: key }))
            .join(", "),
        })
      : t("setup.activation.project_activation_blocked");
}

/**
 * Activates the draft project (Slice 2 plan 5.5, 5.13). Shown only with the server's
 * `capabilities.activateProject` (round 26): the PL, while draft. It names the activation
 * blockers it would hit and is disabled while there are any; the API's 403 and 422 stay the
 * enforcement. Afterwards the Agentur-submission blockers that don't block are shown as warnings.
 */
export function ProjectActivation(props: {
  projectId: string;
  config: ProjectConfig;
  /** Receives the warnings of the activation. */
  onActivated: (warnings: Blocker[]) => void;
}) {
  const { projectId, config, onActivated } = props;
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [error, setError] = useState<string>();
  const blocked = config.activationBlockers.length > 0;

  const activate = useMutation({
    mutationFn: async () => {
      const { data } = await api.POST("/api/v1/projects/{projectId}/activation", {
        params: { path: { projectId } },
        body: {},
      });
      if (!data) throw new Error("Project was not activated");
      return data;
    },
    onSuccess: async (activation) => {
      setError(undefined);
      showToast({ title: t("setup.activate.done") });
      onActivated(activation.warnings);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectQuery(api, projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: ["projects"], exact: true }),
        queryClient.invalidateQueries({ queryKey: projectConfigQuery(api, projectId).queryKey }),
      ]);
    },
    onError: async (failure) => {
      const problem = failure instanceof ApiProblemError ? failure : undefined;
      const code = problem?.status === 403 ? "forbidden" : problem?.problem.errors?.[0]?.code;
      setError(
        t(`setup.activate.errors.${code ?? "failed"}`, {
          defaultValue: t("setup.activate.errors.failed"),
        }),
      );
      // The blockers may have changed meanwhile; show the current ones.
      await queryClient.invalidateQueries({
        queryKey: projectConfigQuery(api, projectId).queryKey,
      });
    },
  });

  return (
    <Stack gap={5} className="tp-form">
      <h3>{t("setup.activate.title")}</h3>
      {error && <InlineNotification kind="error" title={error} hideCloseButton />}
      {blocked ? (
        <>
          <p>{t("setup.activate.blocked")}</p>
          <ul className="tp-list">
            {config.activationBlockers.map((code) => (
              <li key={code}>{t(`setup.activation.${code}`)}</li>
            ))}
          </ul>
        </>
      ) : (
        <p>{t("setup.activate.hint")}</p>
      )}
      <div>
        <Button disabled={blocked || activate.isPending} onClick={() => activate.mutate()}>
          {t("setup.activate.action")}
        </Button>
      </div>
    </Stack>
  );
}
