import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  Button,
  ComboBox,
  Form,
  formatTimestamp,
  InlineNotification,
  Stack,
  useToast,
} from "@transfer/ui";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { worklistQuery, participationQuery, useApi } from "../api";
import type de from "../locales/de/translation.json";

type Detail = components["schemas"]["ParticipationDetail"];
type Choice = Detail["placementAgenturChoices"][number];
type ErrorCode = keyof typeof de.participant.placementAgentur.errors;

/** The template key format (`AgenturKey`); the API checks it again. */
const keyFormat = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** An Agentur as shown: its German label and its key. */
const choiceText = (choice: Choice) => `${choice.label.de} (${choice.agenturKey})`;
const ChoiceOption = (choice: Choice) => <span>{choiceText(choice)}</span>;

/**
 * The placement Agentur of a participant (Q139; regional-variation.md, "Placement Agentur"): the
 * current key and whether its Agentur submission is blocked, and for the PL and back office
 * (`capabilities.setPlacementAgentur`) a combobox of the catalog's and the project's Agenturen
 * that also takes a free key. An unpinned catalog Agentur is pinned at its latest version by the
 * API; the helper text says which version applies before the user confirms.
 */
export function PlacementAgentur({ detail, projectId }: { detail: Detail; projectId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [key, setKey] = useState("");
  const [error, setError] = useState<string>();
  const choices = detail.placementAgenturChoices;
  const current = detail.placementAgenturKey;

  const save = useMutation({
    mutationFn: async (agenturKey: string) => {
      const { data } = await api.PUT("/api/v1/participations/{participationId}/placement-agentur", {
        params: { path: { participationId: detail.id } },
        body: { agenturKey },
      });
      if (!data) throw new Error("Placement Agentur was not set");
      return data;
    },
    onSuccess: async (updated) => {
      queryClient.setQueryData(participationQuery(api, detail.id).queryKey, updated);
      await queryClient.invalidateQueries({ queryKey: worklistQuery(api, projectId).queryKey });
      showToast({
        title: t("participant.placementAgentur.saved"),
        subtitle: updated.placementAgenturKey ?? undefined,
      });
      setKey("");
      setError(undefined);
    },
    onError: async (failure) => {
      const problem = failure instanceof ApiProblemError ? failure : undefined;
      setError(
        problem?.status === 403 ? "forbidden" : (problem?.problem.errors?.[0]?.code ?? "failed"),
      );
      await queryClient.invalidateQueries({
        queryKey: participationQuery(api, detail.id).queryKey,
      });
    },
  });

  const labelOf = (agenturKey: string) => {
    const choice = choices.find((c) => c.agenturKey === agenturKey);
    return choice ? choiceText(choice) : agenturKey;
  };
  const chosen = choices.find((c) => c.agenturKey === key);
  const valid = keyFormat.test(key);
  const helper = !valid
    ? undefined
    : chosen?.pinnedVersion
      ? t("participant.placementAgentur.pinned", { version: chosen.pinnedVersion })
      : chosen?.latestVersion
        ? t("participant.placementAgentur.willPin", { version: chosen.latestVersion })
        : t("participant.placementAgentur.noTemplate");

  function message(code: string) {
    return t(`participant.placementAgentur.errors.${code as ErrorCode}`, {
      defaultValue: t("participant.placementAgentur.errors.failed"),
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (valid) save.mutate(key);
  }

  const blocked = detail.submissionBlockers.some((b) => b.code === "agentur_submission_blocked");
  return (
    <section className="tp-section" aria-label={t("participant.placementAgentur.title")}>
      <h2>{t("participant.placementAgentur.title")}</h2>
      <dl className="tp-facts">
        <div>
          <dt>{t("participant.placementAgentur.current")}</dt>
          <dd>{current ? labelOf(current) : t("participant.placementAgentur.none")}</dd>
        </div>
        {detail.placementAgenturSetAt && (
          <div>
            <dt>{t("participant.placementAgentur.setAt")}</dt>
            <dd>{formatTimestamp(detail.placementAgenturSetAt)}</dd>
          </div>
        )}
      </dl>
      {blocked && <p>{t("participant.placementAgentur.submissionBlocked")}</p>}
      {detail.capabilities.setPlacementAgentur && (
        <Form className="tp-form" onSubmit={submit} noValidate>
          <Stack gap={5}>
            {error && <InlineNotification kind="error" title={message(error)} hideCloseButton />}
            <ComboBox<Choice>
              id="participant-placement-agentur"
              titleText={t(
                current
                  ? "participant.placementAgentur.change"
                  : "participant.placementAgentur.choose",
              )}
              placeholder={t("participant.placementAgentur.placeholder")}
              items={choices.filter((c) => c.agenturKey !== current)}
              itemToString={(item) => item?.agenturKey ?? ""}
              itemToElement={ChoiceOption}
              allowCustomValue
              onChange={({ selectedItem, inputValue }) =>
                setKey(selectedItem?.agenturKey ?? inputValue?.trim() ?? "")
              }
              onInputChange={(text) => setKey(text.trim())}
              helperText={helper}
              invalid={key !== "" && !valid}
              invalidText={t("participant.placementAgentur.invalidKey")}
            />
            <Button type="submit" disabled={!valid || save.isPending}>
              {t("participant.placementAgentur.save")}
            </Button>
          </Stack>
        </Form>
      )}
    </section>
  );
}
