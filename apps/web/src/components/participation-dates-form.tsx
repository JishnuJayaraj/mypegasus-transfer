import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  Button,
  Checkbox,
  formatDate,
  Form,
  InlineNotification,
  parseDisplayDate,
  Select,
  SelectItem,
  Stack,
  TextInput,
  useToast,
} from "@transfer/ui";
import { useLayoutEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { worklistQuery, participationQuery, useApi } from "../api";
import type de from "../locales/de/translation.json";

type Detail = components["schemas"]["ParticipationDetail"];
type Code = keyof typeof de.participant.dates.errors;
type Field = "tgStart" | "tgEnd" | "fullyExecutedOn" | "amendment";
type Confirmation = "originalInspected" | "allPartiesSigned" | "retrievable";
const confirmations: Confirmation[] = ["originalInspected", "allPartiesSigned", "retrievable"];

/**
 * The PL's change of the contractual TG dates on a participant's page (process-and-lifecycle.md,
 * Dates and "DSV amendment"), in a side panel: offered with the API's capability (the card shows
 * the API's reason otherwise, ui-patterns.md C1). An empty date returns to the wave's. Once the
 * DSV is signed the form asks for the fully executed amendment: the date the last party signed,
 * the original location, an optional document number and the PL's three confirmations, never
 * free text. The API decides; every refusal shows at its field and keeps the input (C4). The panel
 * closes it; the form has no "Abbrechen" of its own.
 */
export function ParticipationDatesForm({
  detail,
  onDirtyChange,
  onSaved,
}: {
  detail: Detail;
  /** Whether the input differs from what was saved (C4). */
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const signed = detail.dsvStatus === "dsv_signed";
  const [saved] = useState(() => ({
    tgStart: formatDate(detail.dates.tgStart),
    tgEnd: formatDate(detail.dates.tgEnd),
    fullyExecutedOn: "",
    documentReference: "",
  }));
  const [text, setText] = useState(saved);
  const [confirmed, setConfirmed] = useState<Record<Confirmation, boolean>>({
    originalInspected: false,
    allPartiesSigned: false,
    retrievable: false,
  });
  const dirty =
    (Object.keys(saved) as (keyof typeof saved)[]).some((key) => text[key] !== saved[key]) ||
    Object.values(confirmed).some(Boolean);
  // A layout effect, so an Escape right after typing already asks (ui-patterns.md, side panel).
  useLayoutEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  const [errors, setErrors] = useState<Partial<Record<Field | "form", string[]>>>({});
  const message = (code: string) =>
    t(`participant.dates.errors.${code as Code}`, {
      defaultValue: t("participant.dates.errors.failed"),
    });

  const save = useMutation({
    mutationFn: async (body: components["schemas"]["ParticipationDatesInput"]) => {
      const { data } = await api.PUT("/api/v1/participations/{participationId}/dates", {
        params: { path: { participationId: detail.id } },
        body,
      });
      if (!data) throw new Error("Dates were not saved");
      return data;
    },
    onSuccess: async (updated) => {
      queryClient.setQueryData(participationQuery(api, detail.id).queryKey, updated);
      await queryClient.invalidateQueries({
        queryKey: worklistQuery(api, detail.projectId).queryKey,
      });
      showToast({ title: t("participant.dates.saved") });
      onDirtyChange?.(false);
      onSaved?.();
    },
    onError: async (error) => {
      const problem = error instanceof ApiProblemError ? error : undefined;
      const next: Partial<Record<Field | "form", string[]>> = {};
      if (problem?.status === 403) next.form = ["forbidden"];
      else if (problem?.status === 409) next.form = ["stale"];
      for (const item of problem?.status === 422 ? (problem.problem.errors ?? []) : []) {
        const field = item.pointer?.split("/")[1] as Field | undefined;
        (next[field && ["tgStart", "tgEnd", "amendment"].includes(field) ? field : "form"] ??=
          []).push(item.code);
      }
      if (Object.keys(next).length === 0) next.form = ["failed"];
      setErrors(next);
      // A refusal reads the participation again, so the form decides on current facts.
      await queryClient.invalidateQueries({
        queryKey: participationQuery(api, detail.id).queryKey,
      });
    },
  });

  // A refusal on submit may close the capability while the panel is open: the API's reason.
  if (!detail.capabilities.setParticipationDates) {
    const refusal = detail.refusals.setParticipationDates;
    return (
      <>
        {errors.form?.map((code) => (
          <InlineNotification key={code} kind="error" title={message(code)} hideCloseButton />
        ))}
        {refusal && <p>{t(`participant.dates.refusals.${refusal}`)}</p>}
      </>
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const next: Partial<Record<Field, string[]>> = {};
    const date = (field: "tgStart" | "tgEnd" | "fullyExecutedOn", required = false) => {
      const parsed = parseDisplayDate(text[field]);
      if (!parsed.ok || (required && !parsed.value)) next[field] = ["invalid_date"];
      return parsed.ok ? (parsed.value ?? null) : null;
    };
    const tgStart = date("tgStart");
    const tgEnd = date("tgEnd");
    const fullyExecutedOn = signed ? date("fullyExecutedOn", true) : null;
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    save.mutate({
      tgStart,
      tgEnd,
      expectedVersion: detail.statusVersion,
      ...(signed && {
        amendment: {
          fullyExecutedOn: fullyExecutedOn!,
          originalLocation: "paper_personnel_file",
          ...(text.documentReference.trim() && {
            documentReference: text.documentReference.trim(),
          }),
          ...confirmed,
        },
      }),
    });
  }

  const invalid = (field: Field) => {
    const codes = errors[field];
    if (!codes) return {};
    return {
      invalid: true,
      invalidText: codes.map((code) => <span key={code}>{message(code)} </span>),
    };
  };
  const set = (field: keyof typeof text) => (value: string) => setText({ ...text, [field]: value });

  return (
    <Form className="tp-form" onSubmit={submit} noValidate>
      <Stack gap={5}>
        <p>{t("participant.dates.intro")}</p>
        {[...(errors.form ?? []), ...(errors.amendment ?? [])].map((code) => (
          <InlineNotification key={code} kind="error" title={message(code)} hideCloseButton />
        ))}
        <TextInput
          id="dates-tg-start"
          labelText={t("participant.dates.tgStart")}
          helperText={t("participant.dates.emptyIsWave")}
          value={text.tgStart}
          onChange={(event) => set("tgStart")(event.target.value)}
          {...invalid("tgStart")}
        />
        <TextInput
          id="dates-tg-end"
          labelText={t("participant.dates.tgEnd")}
          helperText={t("participant.dates.emptyIsWave")}
          value={text.tgEnd}
          onChange={(event) => set("tgEnd")(event.target.value)}
          {...invalid("tgEnd")}
        />
        {signed && (
          <fieldset className="tp-fieldset">
            <legend>{t("participant.dates.amendment")}</legend>
            <p>{t("participant.dates.amendmentIntro")}</p>
            <TextInput
              id="dates-fully-executed-on"
              labelText={t("participant.dates.fullyExecutedOn")}
              helperText={t("participant.dates.dateHint")}
              value={text.fullyExecutedOn}
              onChange={(event) => set("fullyExecutedOn")(event.target.value)}
              {...invalid("fullyExecutedOn")}
            />
            <Select
              id="dates-original-location"
              labelText={t("participant.dates.originalLocation")}
              value="paper_personnel_file"
              onChange={() => undefined}
            >
              <SelectItem
                value="paper_personnel_file"
                text={t("participant.dates.locations.paper_personnel_file")}
              />
            </Select>
            <TextInput
              id="dates-document-reference"
              labelText={t("participant.dates.documentReference")}
              helperText={t("participant.dates.documentReferenceHint")}
              value={text.documentReference}
              onChange={(event) => set("documentReference")(event.target.value)}
            />
            {confirmations.map((key) => (
              <Checkbox
                key={key}
                id={`dates-${key}`}
                labelText={t(`participant.dates.confirmations.${key}`)}
                checked={confirmed[key]}
                onChange={(_, { checked }) => setConfirmed({ ...confirmed, [key]: checked })}
              />
            ))}
          </fieldset>
        )}
        <div>
          <Button type="submit" disabled={save.isPending}>
            {t("participant.dates.save")}
          </Button>
        </div>
      </Stack>
    </Form>
  );
}
