import { useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  ActionButton,
  InlineNotification,
  RadioButton,
  RadioButtonGroup,
  SidePanel,
  Stack,
} from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "../api";
import { usePanelNavigationGuard } from "./panel-guard";

type Detail = components["schemas"]["ParticipationDetail"];
type Target = components["schemas"]["ContactStatusTarget"];

/** The refusal codes the dialog explains; anything else is a generic failure. */
const known = new Set(["stale", "before_cutoff", "no_edge", "project_not_active", "forbidden"]);

function refusalOf(problem: unknown): string {
  if (!(problem instanceof ApiProblemError)) return "failed";
  if (problem.status === 409) return "stale";
  if (problem.status === 403) return "forbidden";
  const code = problem.problem.errors?.[0]?.code;
  return code && known.has(code) ? code : "failed";
}

/**
 * "Kontaktstatus" (process-and-lifecycle.md, the manual contact statuses; Q215): only the targets
 * the capability allows now, nothing preset; the status version read when the dialog opened
 * (ui-patterns.md, C4), so a change meanwhile is a 409.
 */
export function ContactStatusDialog({ detail, onClose }: { detail: Detail; onClose: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const cache = useQueryClient();
  const [version] = useState(detail.statusVersion);
  const [targets] = useState(detail.capabilities.contactStatus);
  const [to, setTo] = useState<Target | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = to !== "";
  const navigation = usePanelNavigationGuard(dirty);
  async function save() {
    if (to === "") return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.POST("/api/v1/participations/{participationId}/contact-status", {
        params: { path: { participationId: detail.id } },
        body: { to, statusVersion: version },
      });
      if (result.error) setError("failed");
      else onClose();
    } catch (problem) {
      setError(refusalOf(problem));
    } finally {
      setBusy(false);
      await cache.invalidateQueries({ queryKey: ["participations", detail.id] });
      await cache.invalidateQueries({ queryKey: ["projects", detail.projectId] });
    }
  }
  return (
    <SidePanel
      open
      title={t("participant.contactStatus.title")}
      dirty={dirty}
      onClose={onClose}
      pendingNavigation={navigation}
    >
      <Stack gap={4}>
        {error && (
          <InlineNotification
            kind="error"
            title={t(`participant.contactStatus.errors.${error as "failed"}`)}
            lowContrast
          />
        )}
        <p>
          {t("participant.contactStatus.current", {
            status: t(`participants.statuses.${detail.status}`),
          })}
        </p>
        <RadioButtonGroup
          name="contact-status"
          legendText={t("participant.contactStatus.to")}
          orientation="vertical"
          valueSelected={to}
          onChange={(value) => setTo(value as Target)}
        >
          {targets.map((target) => (
            <RadioButton
              key={target}
              id={`contact-status-${target}`}
              value={target}
              labelText={t(`participants.statuses.${target}`)}
            />
          ))}
        </RadioButtonGroup>
        <ActionButton
          disabled={busy}
          unavailableReason={to === "" ? t("participant.contactStatus.choose") : null}
          onClick={() => void save()}
        >
          {t("participant.contactStatus.save")}
        </ActionButton>
      </Stack>
    </SidePanel>
  );
}
