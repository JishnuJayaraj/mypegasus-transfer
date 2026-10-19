import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { type components } from "@transfer/api-client";
import { Button, InlineNotification, useToast } from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  entryWavesQuery,
  participantsQuery,
  projectConfigQuery,
  projectQuery,
  useApi,
} from "../api";
import { ImportWizard } from "./import-wizard";

type Result = components["schemas"]["ImportResult"];

/**
 * The Import section (Slice 2 plan 5.13). The wizard appears only with the server's
 * `capabilities.importParticipations` (round 26); the API's 403 stays the enforcement. This
 * component outlives the wizard, so a refusal stays visible after the wizard went away (round 29)
 * and every refusal reads the configuration, the project and the participations again.
 */
export function ImportSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const { data: config } = useSuspenseQuery(projectConfigQuery(api, projectId));
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState<Result | null>(null);
  // A new key starts a fresh wizard.
  const [round, setRound] = useState(0);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: projectConfigQuery(api, projectId).queryKey }),
      queryClient.invalidateQueries({ queryKey: projectQuery(api, projectId).queryKey }),
      queryClient.invalidateQueries({ queryKey: participantsQuery(api, projectId).queryKey }),
      queryClient.invalidateQueries({ queryKey: entryWavesQuery(api, projectId).queryKey }),
    ]);

  const refused = (codes: string[]) => {
    const code = codes[0] ?? "failed";
    setRefusal(t(`import.issues.${code as "failed"}`, { defaultValue: t("import.issues.failed") }));
    void refresh();
  };

  return (
    <section aria-labelledby="project-import" className="tp-section">
      <h2 id="project-import">{t("import.title")}</h2>
      {refusal && (
        <InlineNotification
          kind="error"
          title={t("import.refused")}
          subtitle={refusal}
          onClose={() => setRefusal(null)}
        />
      )}
      {done ? (
        <>
          <InlineNotification
            kind="success"
            title={t("import.done.title")}
            subtitle={t("import.done.text", { ...done })}
            hideCloseButton
          />
          <Button
            kind="tertiary"
            onClick={() => {
              setDone(null);
              setRound(round + 1);
            }}
          >
            {t("import.done.again")}
          </Button>
        </>
      ) : (
        config.capabilities.importParticipations && (
          <ImportWizard
            key={round}
            projectId={projectId}
            onRefused={refused}
            onDone={(result) => {
              setRefusal(null);
              setDone(result);
              showToast({ title: t("import.done.toast") });
              void refresh();
            }}
          />
        )
      )}
    </section>
  );
}
