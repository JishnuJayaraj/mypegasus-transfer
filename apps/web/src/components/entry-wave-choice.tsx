import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  Button,
  Form,
  formatDate,
  InlineNotification,
  Select,
  SelectItem,
  Stack,
  useToast,
} from "@transfer/ui";
import { useLayoutEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { entryWavesQuery, worklistQuery, participationQuery, useApi } from "../api";
import type de from "../locales/de/translation.json";

type Detail = components["schemas"]["ParticipationDetail"];
type ErrorCode = keyof typeof de.participant.waveErrors;

/**
 * The PL's wave choice on a participant's page (process-and-lifecycle.md, assigning a wave), in a
 * side panel: offered while the API's capability says so (the card shows the API's reason it is
 * closed, ui-patterns.md C1). The API decides again on submit; a refusal shows its code's message
 * and keeps the panel open with the choice (C4).
 */
export function EntryWaveChoice({
  detail,
  projectId,
  onDirtyChange,
  onSaved,
}: {
  detail: Detail;
  projectId: string;
  /** Whether a wave is chosen and not yet assigned (C4). */
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const waves = useQuery({
    ...entryWavesQuery(api, projectId),
    enabled: detail.capabilities.assignEntryWave,
  });
  const [waveId, setWaveId] = useState("");
  const [error, setError] = useState<string>();
  // A layout effect, so an Escape right after choosing already asks (ui-patterns.md, side panel).
  useLayoutEffect(() => onDirtyChange?.(waveId !== ""), [waveId, onDirtyChange]);

  const assign = useMutation({
    mutationFn: async (chosen: string) => {
      const { data } = await api.PUT("/api/v1/participations/{participationId}/entry-wave", {
        params: { path: { participationId: detail.id } },
        body: { waveId: chosen },
      });
      if (!data) throw new Error("Entry wave was not assigned");
      return data;
    },
    onSuccess: async (updated) => {
      queryClient.setQueryData(participationQuery(api, detail.id).queryKey, updated);
      // The list shows the wave, the wave table its number of participations.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: worklistQuery(api, projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: entryWavesQuery(api, projectId).queryKey }),
      ]);
      showToast({ title: t("participant.waveAssigned"), subtitle: updated.entryWave?.code });
      setWaveId("");
      setError(undefined);
      onSaved?.();
    },
    onError: async (failure) => {
      const problem = failure instanceof ApiProblemError ? failure : undefined;
      setError(
        problem?.status === 403
          ? "forbidden"
          : problem?.status === 409
            ? "stale"
            : (problem?.problem.errors?.[0]?.code ?? "failed"),
      );
      // A refusal reads the participation again, so the page shows current facts (round 29).
      await queryClient.invalidateQueries({
        queryKey: participationQuery(api, detail.id).queryKey,
      });
    },
  });

  // The card says why the choice is closed (the API's reason, C1); a refusal on submit may close
  // it while the panel is open.
  if (!detail.capabilities.assignEntryWave) {
    const refusal = detail.refusals.assignEntryWave;
    return (
      <>
        {error && <InlineNotification kind="error" title={message(error)} hideCloseButton />}
        {refusal && <p>{t(`participant.waveRefusals.${refusal}`)}</p>}
      </>
    );
  }

  function message(code: string) {
    return t(`participant.waveErrors.${code as ErrorCode}`, {
      defaultValue: t("participant.waveErrors.failed"),
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (waveId) assign.mutate(waveId);
  }

  const choices = (waves.data ?? []).filter((wave) => wave.id !== detail.entryWave?.id);
  // Code, name and the four dates, so the PL can compare before assigning (round 33 review).
  const waveLabel = (wave: (typeof choices)[number]) =>
    t("participant.waveOption", {
      code: wave.code,
      name: wave.name,
      signingDeadline: formatDate(wave.signingDeadline) || "—",
      start: formatDate(wave.defaultTgStart) || "—",
      end: formatDate(wave.defaultTgEnd) || "—",
      latestEntry: formatDate(wave.latestEntryDate) || "—",
    });
  return (
    <Form className="tp-form" onSubmit={submit} noValidate>
      <Stack gap={5}>
        {error && <InlineNotification kind="error" title={message(error)} hideCloseButton />}
        <Select
          id="participant-wave"
          labelText={t(detail.entryWave ? "participant.changeWave" : "participant.chooseWave")}
          value={waveId}
          onChange={(event) => setWaveId(event.target.value)}
        >
          <SelectItem value="" text={t("participant.noWaveChosen")} />
          {choices.map((wave) => (
            <SelectItem key={wave.id} value={wave.id} text={waveLabel(wave)} />
          ))}
        </Select>
        <div>
          <Button type="submit" disabled={!waveId || assign.isPending}>
            {t("participant.assignWave")}
          </Button>
        </div>
      </Stack>
    </Form>
  );
}
