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
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { entryWavesQuery, participantsQuery, participationQuery, useApi } from "../api";
import type de from "../locales/de/translation.json";

type Detail = components["schemas"]["ParticipationDetail"];
type ErrorCode = keyof typeof de.participant.waveErrors;

/**
 * The PL's wave choice on a participant's page (Slice 2 plan, "Planned in PR 2h", R33): offered
 * while the API's capability says so; otherwise the API's reason it is closed. The API decides
 * again on submit; a refusal shows its code's message.
 */
export function EntryWaveChoice({ detail, projectId }: { detail: Detail; projectId: string }) {
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
        queryClient.invalidateQueries({ queryKey: participantsQuery(api, projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: entryWavesQuery(api, projectId).queryKey }),
      ]);
      showToast({ title: t("participant.waveAssigned"), subtitle: updated.entryWave?.code });
      setWaveId("");
      setError(undefined);
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

  // The server says why the choice is closed, the missing permission first (R31).
  const refusal = detail.refusals.assignEntryWave;
  if (!detail.capabilities.assignEntryWave) {
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
        <Button type="submit" disabled={!waveId || assign.isPending}>
          {t("participant.assignWave")}
        </Button>
      </Stack>
    </Form>
  );
}
