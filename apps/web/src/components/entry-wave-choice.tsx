import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  Button,
  Form,
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
 * while the API's capability says so; otherwise the reason it is closed, where one applies. The
 * API decides again on submit; a refusal shows its code's message.
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

  if (!detail.capabilities.assignEntryWave) {
    const reason =
      detail.dsvStatus !== "not_offered"
        ? "dsv_already_offered"
        : detail.dates.tgStart !== null || detail.dates.tgEnd !== null
          ? "individual_dates_set"
          : undefined;
    return reason ? (
      <p>{t(`participant.waveErrors.${reason}`)}</p>
    ) : (
      error && <InlineNotification kind="error" title={message(error)} hideCloseButton />
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
            <SelectItem key={wave.id} value={wave.id} text={`${wave.code} – ${wave.name}`} />
          ))}
        </Select>
        <Button type="submit" disabled={!waveId || assign.isPending}>
          {t("participant.assignWave")}
        </Button>
      </Stack>
    </Form>
  );
}
