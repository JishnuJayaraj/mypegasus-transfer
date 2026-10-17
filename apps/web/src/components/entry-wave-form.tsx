import { useMutation } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  waveDateFields,
  type CreateEntryWaveInput,
  type WaveField,
  type WaveIssueCode,
} from "@transfer/domain";
import {
  Button,
  ButtonSet,
  DateField,
  Form,
  formatDate,
  InlineNotification,
  parseDisplayDate,
  Stack,
  TextInput,
} from "@transfer/ui";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "../api";

export type EntryWave = components["schemas"]["EntryWave"];
type ErrorCode = WaveIssueCode | "wave_unchanged" | "invalid_date" | "forbidden" | "failed";

const FIELDS: readonly string[] = ["code", "name", ...waveDateFields];
const isField = (value: unknown): value is WaveField => FIELDS.includes(value as string);

interface EntryWaveFormProps {
  projectId: string;
  /** The wave to edit; a new wave without. */
  wave: EntryWave | undefined;
  onSaved: (wave: EntryWave) => Promise<void>;
  onCancel: () => void;
}

/**
 * One form for creating and editing an entry wave (plan 5.6, 5.13). The API checks every rule;
 * each refusal is shown at its field, a refusal of the whole wave above the form.
 */
export function EntryWaveForm({ projectId, wave, onSaved, onCancel }: EntryWaveFormProps) {
  const { t } = useTranslation();
  const api = useApi();
  const [text, setText] = useState<Record<WaveField, string>>(() => ({
    code: wave?.code ?? "",
    name: wave?.name ?? "",
    signingDeadline: formatDate(wave?.signingDeadline),
    defaultTgStart: formatDate(wave?.defaultTgStart),
    defaultTgEnd: formatDate(wave?.defaultTgEnd),
    latestEntryDate: formatDate(wave?.latestEntryDate),
  }));
  const [errors, setErrors] = useState<Partial<Record<WaveField, string>>>({});
  const [formError, setFormError] = useState<string>();
  const message = (code: string) =>
    t(`waveForm.errors.${code as ErrorCode}`, { defaultValue: t("waveForm.errors.invalid") });
  const set = (field: WaveField) => (value: string) => setText({ ...text, [field]: value });

  const save = useMutation({
    mutationFn: async (body: CreateEntryWaveInput) => {
      const path = { projectId, waveId: wave?.id ?? "" };
      const { data } = wave
        ? await api.PATCH("/api/v1/projects/{projectId}/entry-waves/{waveId}", {
            params: { path },
            body,
          })
        : await api.POST("/api/v1/projects/{projectId}/entry-waves", {
            params: { path },
            body,
          });
      if (!data) throw new Error("Entry wave was not saved");
      return data;
    },
    onSuccess: onSaved,
    onError: (error) => {
      const problem = error instanceof ApiProblemError ? error : undefined;
      const fieldErrors: Partial<Record<WaveField, string>> = {};
      let whole = problem?.status === 403 ? "forbidden" : undefined;
      for (const item of problem && [400, 422].includes(problem.status)
        ? (problem.problem.errors ?? [])
        : []) {
        const field = item.pointer?.split("/")[1];
        if (isField(field)) fieldErrors[field] ??= item.code;
        else whole ??= item.code;
      }
      setErrors(fieldErrors);
      setFormError(whole ?? (Object.keys(fieldErrors).length ? undefined : "failed"));
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const fieldErrors: Partial<Record<WaveField, string>> = {};
    const dates: Record<string, string | null> = {};
    for (const field of waveDateFields) {
      const parsed = parseDisplayDate(text[field]);
      if (parsed.ok) dates[field] = parsed.value ?? null;
      else fieldErrors[field] = "invalid_date";
    }
    setErrors(fieldErrors);
    setFormError(undefined);
    if (Object.keys(fieldErrors).length === 0) {
      save.mutate({ code: text.code, name: text.name, ...dates });
    }
  }

  const invalid = (field: WaveField) => {
    const code = errors[field];
    return code === undefined ? {} : { invalid: true, invalidText: message(code) };
  };

  return (
    <Form className="tp-form" onSubmit={submit} noValidate>
      <Stack gap={6}>
        <h2>{wave ? t("waveForm.editTitle", { code: wave.code }) : t("waveForm.createTitle")}</h2>
        {formError && (
          <InlineNotification kind="error" title={message(formError)} hideCloseButton />
        )}
        <TextInput
          id="wave-code"
          labelText={t("waveForm.code")}
          value={text.code}
          onChange={(event) => set("code")(event.target.value)}
          {...invalid("code")}
        />
        <TextInput
          id="wave-name"
          labelText={t("waveForm.name")}
          helperText={t("waveForm.nameHint")}
          value={text.name}
          onChange={(event) => set("name")(event.target.value)}
          {...invalid("name")}
        />
        {waveDateFields.map((field) => (
          <DateField
            key={field}
            id={`wave-${field}`}
            labelText={t(`waveForm.${field}`)}
            defaultValue={text[field]}
            onChange={set(field)}
            invalidText={invalid(field).invalidText}
          />
        ))}
        <ButtonSet>
          <Button kind="secondary" onClick={onCancel}>
            {t("waveForm.cancel")}
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {t("waveForm.submit")}
          </Button>
        </ButtonSet>
      </Stack>
    </Form>
  );
}
