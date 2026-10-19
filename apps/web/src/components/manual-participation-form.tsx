import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { createLink } from "@tanstack/react-router";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  Button,
  Checkbox,
  Form,
  InlineNotification,
  Link,
  Select,
  SelectItem,
  Stack,
  TextInput,
} from "@transfer/ui";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { entryWavesQuery, projectQuery, useApi } from "../api";
import type de from "../locales/de/translation.json";

type Detail = components["schemas"]["ParticipationDetail"];
type Field = keyof typeof de.manual.fields;
type IssueCode = keyof typeof de.manual.issues;

const RouterLink = createLink(Link);
const fields = [
  "personnelNumber",
  "lastName",
  "firstName",
  "birthDate",
  "oldEmploymentEndDate",
  "addressStreet",
  "addressPostalCode",
  "addressCity",
  "phone",
  "mobile",
  "privateEmail",
  "workEmail",
] as const satisfies readonly Field[];
const dateFields = new Set<Field>(["birthDate", "oldEmploymentEndDate"]);

type Refusal = {
  /** Codes by field; the address as a unit is shown at the street. */
  fields: Partial<Record<Field, string[]>>;
  /** Codes of the whole form (warnings to confirm, a possible duplicate, a failure). */
  form: string[];
  /** The participation that already has the Personalnummer. */
  existing?: string;
};

/**
 * Adding one person by hand (Slice 2 plan, "Planned in PR 2h", R32): the import's targets as one
 * form, checked by the API with the import's rules. A warning or a possible duplicate comes back
 * as a refusal the PL answers in the same form (a checkbox each), so nothing is created without
 * that explicit word; an existing Personalnummer links to that person. The country is Germany,
 * the only one the MVP accepts (round 32).
 */
export function ManualParticipationForm(props: {
  projectId: string;
  onCancel: () => void;
  onCreated: (detail: Detail) => void;
}) {
  const { projectId } = props;
  const { t } = useTranslation();
  const api = useApi();
  const { data: project } = useSuspenseQuery(projectQuery(api, projectId));
  const [values, setValues] = useState<Partial<Record<Field, string>>>({});
  const [waveId, setWaveId] = useState("");
  const [confirmWarnings, setConfirmWarnings] = useState(false);
  const [createDespiteDuplicate, setCreateDespiteDuplicate] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const message = (code: string) =>
    t(`manual.issues.${code as IssueCode}`, { defaultValue: t("manual.issues.failed") });

  const create = useMutation({
    mutationFn: async () => {
      const entered = Object.fromEntries(
        Object.entries(values).filter(([, value]) => value?.trim()),
      );
      const { data } = await api.POST("/api/v1/projects/{projectId}/participations", {
        params: { path: { projectId } },
        body: {
          values: entered,
          ...(waveId && { waveId }),
          confirmWarnings,
          createDespiteDuplicate,
        },
      });
      if (!data) throw new Error("Participation was not created");
      return data;
    },
    onSuccess: props.onCreated,
    onError: (error) => {
      const problem = error instanceof ApiProblemError ? error : undefined;
      const next: Refusal = { fields: {}, form: [] };
      if (problem?.status === 403) next.form.push("forbidden");
      for (const item of problem?.status === 422 ? (problem.problem.errors ?? []) : []) {
        const [, root, target] = item.pointer?.split("/") ?? [];
        const field = (target === "address" ? "addressStreet" : target) as Field | undefined;
        if (root === "values" && field && (fields as readonly string[]).includes(field)) {
          (next.fields[field] ??= []).push(item.code);
        } else {
          next.form.push(item.code);
        }
      }
      if (problem?.problem.participationId) next.existing = problem.problem.participationId;
      if (next.form.length === 0 && Object.keys(next.fields).length === 0) next.form.push("failed");
      setRefusal(next);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }

  const asked = (code: string) => refusal?.form.includes(code) ?? false;
  const invalid = (field: Field) => {
    const codes = refusal?.fields[field];
    if (!codes) return {};
    return {
      invalid: true,
      invalidText: codes.map((code) => <span key={code}>{message(code)} </span>),
    };
  };
  const formCodes = (refusal?.form ?? []).filter(
    (code) => code !== "warnings_unconfirmed" && code !== "possible_duplicate",
  );

  return (
    <Form className="tp-form" onSubmit={submit} noValidate>
      <Stack gap={5}>
        <h3>{t("manual.title")}</h3>
        <p>{t("manual.intro")}</p>
        {formCodes.map((code) => (
          <InlineNotification key={code} kind="error" title={message(code)} hideCloseButton />
        ))}
        {refusal?.existing && (
          <p>
            <RouterLink
              to="/projects/$projectId/participations/$participationId"
              params={{ projectId, participationId: refusal.existing }}
            >
              {t("manual.openExisting")}
            </RouterLink>
          </p>
        )}
        {fields.map((field) => (
          <TextInput
            key={field}
            id={`manual-${field}`}
            labelText={t(`manual.fields.${field}`)}
            helperText={dateFields.has(field) ? t("manual.dateHint") : undefined}
            value={values[field] ?? ""}
            onChange={(event) => setValues({ ...values, [field]: event.target.value })}
            {...invalid(field)}
          />
        ))}
        <p>{t("manual.country")}</p>
        {project.type === "ta_tg" && (
          <ManualWaveSelect projectId={projectId} value={waveId} onChange={setWaveId} />
        )}
        {(asked("warnings_unconfirmed") || confirmWarnings) && (
          <Checkbox
            id="manual-confirm-warnings"
            labelText={t("manual.confirmWarnings")}
            checked={confirmWarnings}
            onChange={(_, { checked }) => setConfirmWarnings(checked)}
          />
        )}
        {(asked("possible_duplicate") || createDespiteDuplicate) && (
          <Checkbox
            id="manual-create-despite-duplicate"
            labelText={t("manual.createDespiteDuplicate")}
            checked={createDespiteDuplicate}
            onChange={(_, { checked }) => setCreateDespiteDuplicate(checked)}
          />
        )}
        <div>
          <Button kind="secondary" onClick={props.onCancel}>
            {t("manual.cancel")}
          </Button>
          <Button type="submit" disabled={create.isPending}>
            {t("manual.submit")}
          </Button>
        </div>
      </Stack>
    </Form>
  );
}

function ManualWaveSelect(props: {
  projectId: string;
  value: string;
  onChange: (waveId: string) => void;
}) {
  const { t } = useTranslation();
  const { data: waves } = useSuspenseQuery(entryWavesQuery(useApi(), props.projectId));
  return (
    <Select
      id="manual-wave"
      labelText={t("manual.wave")}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    >
      <SelectItem value="" text={t("manual.waveNone")} />
      {waves.map((wave) => (
        <SelectItem key={wave.id} value={wave.id} text={`${wave.code} – ${wave.name}`} />
      ))}
    </Select>
  );
}
