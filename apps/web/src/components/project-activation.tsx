import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import { Button, useToast } from "@transfer/ui";
import { useTranslation } from "react-i18next";
import { projectConfigQuery, projectQuery, useApi } from "../api";

type ProjectConfig = components["schemas"]["ProjectConfig"];
type Blocker = components["schemas"]["ConfigBlocker"];
type ActivationBlocker = components["schemas"]["ProjectActivationBlocker"];

const activationBlockers: readonly string[] = [
  "project_activation_blocked",
  "no_entry_wave_with_latest_entry_date",
] satisfies ActivationBlocker[];
/** A refusal by a blocker reads as in the blocker list (one message per blocker). */
const isBlocker = (code: string | undefined): code is ActivationBlocker =>
  code !== undefined && activationBlockers.includes(code);

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
 * The page's one primary action once nothing blocks activation: it activates the draft project
 * (Slice 2 plan 5.5, 5.13), shown only with the server's `capabilities.activateProject` (round
 * 26): the PL, while draft. The API's 403 and 422 stay the enforcement. Its outcome goes to the
 * setup header, which outlives this button and shows the refusal, the warnings and the blockers.
 */
export function ProjectActivationAction(props: {
  projectId: string;
  /** Receives the warnings of the activation. */
  onActivated: (warnings: Blocker[]) => void;
  /** Receives the refusal as a message. */
  onRefused: (message: string) => void;
}) {
  const { projectId, onActivated, onRefused } = props;
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();

  // The project, the project list and the configuration, after a success or any refusal: a
  // refusal may mean that the blockers changed or that the project is active already.
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: projectQuery(api, projectId).queryKey }),
      queryClient.invalidateQueries({ queryKey: ["projects"], exact: true }),
      queryClient.invalidateQueries({ queryKey: projectConfigQuery(api, projectId).queryKey }),
    ]);

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
      showToast({ title: t("setup.activate.done") });
      onActivated(activation.warnings);
      await refresh();
    },
    onError: async (failure) => {
      const problem = failure instanceof ApiProblemError ? failure : undefined;
      const code = problem?.status === 403 ? "forbidden" : problem?.problem.errors?.[0]?.code;
      onRefused(
        isBlocker(code)
          ? t(`setup.activation.${code}`)
          : t(`setup.activate.errors.${code ?? "failed"}`, {
              defaultValue: t("setup.activate.errors.failed"),
            }),
      );
      await refresh();
    },
  });

  return (
    <Button disabled={activate.isPending} onClick={() => activate.mutate()}>
      {t("setup.activate.action")}
    </Button>
  );
}
