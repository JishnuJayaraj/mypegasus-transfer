import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  AgenturSettingSource,
  AsuChannel,
  Kug200bBatchChannel,
  Tl407SubmissionChannel,
  type SetAgenturSettingInput,
} from "@transfer/domain";
import {
  Button,
  ButtonSet,
  DateField,
  Form,
  formatDate,
  InlineNotification,
  parseDisplayDate,
  Select,
  SelectItem,
  SimpleTable,
  Stack,
  TextInput,
  useToast,
} from "@transfer/ui";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { meQuery, projectConfigQuery, useApi } from "../api";

type ProjectConfig = components["schemas"]["ProjectConfig"];
type Scoped = ProjectConfig["override"]["agenturSettings"][number];
type Field = "agenturKey" | "settings" | "source" | "confirmedOn";

/** Every Agentur-scoped setting (`step.key`) with its choices; `number` for a day count. */
const choices = {
  "asu_registration.defaultChannel": AsuChannel.options,
  "asu_registration.batchSubmissionChannel": Kug200bBatchChannel.options,
  "agentur_submission.submissionChannel": Tl407SubmissionChannel.options,
  "agentur_submission.originalRequired": ["true", "false"],
  "agentur_submission.leadTimeDays": "number",
  "agentur_submission.rejectsOutdatedFormVersions": ["true", "false"],
} as const;
type SettingPath = keyof typeof choices;
const paths = Object.keys(choices) as SettingPath[];
type Value = Exclude<(typeof choices)[SettingPath], "number">[number];
const FIELDS: readonly string[] = ["agenturKey", "settings", "source", "confirmedOn"];

const valueAt = (settings: Scoped["settings"], path: string) => {
  const [step, key] = path.split(".") as [string, string];
  return (settings as Record<string, Record<string, unknown> | undefined>)[step]?.[key];
};

/**
 * The Konfiguration section (Slice 2 plan 5.9, 5.13): the override's Agentur-scoped settings with
 * source, confirmer and date (round 8, Q93). Changing them follows the server's
 * `changeOverride` capability (round 26); the API's checks stay the enforcement.
 */
export function AgenturSettings({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const query = projectConfigQuery(api, projectId);
  const { data: config } = useSuspenseQuery(query);
  const me = useQuery(meQuery(api)).data;
  // "new", an Agentur key, or no form.
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<"conflict" | "forbidden" | "failed">();
  const may = config.capabilities.changeOverride;
  const labelOf = (key: string) =>
    config.pins.find((pin) => pin.agenturKey === key)?.label.de ?? key;
  const display = (value: unknown) =>
    typeof value === "number" ? String(value) : t(`overrides.values.${String(value) as Value}`);

  const remove = useMutation({
    mutationFn: async (agenturKey: string) => {
      const { data } = await api.DELETE(
        "/api/v1/projects/{projectId}/config/agentur-settings/{agenturKey}",
        {
          params: {
            path: { projectId, agenturKey },
            query: { expectedVersion: config.override.version },
          },
        },
      );
      if (!data) throw new Error("Setting was not removed");
      return data;
    },
    onSuccess: (next, agenturKey) => {
      setError(undefined);
      queryClient.setQueryData(query.queryKey, next);
      showToast({ title: t("overrides.removed"), subtitle: labelOf(agenturKey) });
    },
    onError: async (failure) => {
      const status = failure instanceof ApiProblemError ? failure.status : undefined;
      setError(status === 409 ? "conflict" : status === 403 ? "forbidden" : "failed");
      if (status === 409) await queryClient.invalidateQueries({ queryKey: query.queryKey });
    },
  });

  const rows = config.override.agenturSettings.map((scoped) => ({
    id: scoped.agenturKey,
    agentur: labelOf(scoped.agenturKey),
    settings: paths
      .filter((path) => valueAt(scoped.settings, path) !== undefined)
      .map(
        (path) => `${t(`overrides.settings.${path}`)}: ${display(valueAt(scoped.settings, path))}`,
      )
      .join("; "),
    source: t(`overrides.sources.${scoped.source}`),
    // No staff directory before Slice 3 (Q109): the viewer's own name, else a staff id prefix.
    confirmedBy:
      scoped.confirmedBy === me?.id
        ? me.displayName
        : t("overrides.otherStaff", { id: scoped.confirmedBy.slice(0, 8) }),
    confirmedOn: formatDate(scoped.confirmedOn),
    actions: may && (
      <ButtonSet>
        <Button kind="ghost" size="sm" onClick={() => setEditing(scoped.agenturKey)}>
          {t("overrides.edit", { agentur: labelOf(scoped.agenturKey) })}
        </Button>
        <Button
          kind="danger--ghost"
          size="sm"
          disabled={remove.isPending}
          onClick={() => remove.mutate(scoped.agenturKey)}
        >
          {t("overrides.remove", { agentur: labelOf(scoped.agenturKey) })}
        </Button>
      </ButtonSet>
    ),
  }));
  const columns = [
    "agentur",
    "settings",
    "source",
    "confirmedBy",
    "confirmedOn",
    "actions",
  ] as const;

  return (
    <section aria-labelledby="project-overrides" className="tp-section">
      <h2 id="project-overrides">{t("overrides.title")}</h2>
      <p>{t("overrides.version", { version: config.override.version })}</p>
      {error && (
        <InlineNotification kind="error" title={t(`overrides.errors.${error}`)} hideCloseButton />
      )}
      <SimpleTable
        title={t("overrides.tableTitle")}
        columns={(may ? columns : columns.slice(0, -1)).map((key) => ({
          key,
          header: t(`overrides.columns.${key}`),
        }))}
        rows={rows}
        emptyState={t("overrides.empty")}
      />
      {may &&
        (editing === null ? (
          <Button className="tp-load-more" onClick={() => setEditing("new")}>
            {t("overrides.add")}
          </Button>
        ) : (
          <AgenturSettingForm
            key={editing}
            projectId={projectId}
            config={config}
            scoped={config.override.agenturSettings.find((s) => s.agenturKey === editing)}
            onDone={() => setEditing(null)}
          />
        ))}
    </section>
  );
}

/** One form to set an Agentur's scoped setting: a pinned Agentur or a typed key (round 8). */
function AgenturSettingForm(props: {
  projectId: string;
  config: ProjectConfig;
  scoped: Scoped | undefined;
  onDone: () => void;
}) {
  const { projectId, config, scoped, onDone } = props;
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const query = projectConfigQuery(api, projectId);
  const pinned = config.pins.map((pin) => pin.agenturKey);
  const [choice, setChoice] = useState(scoped?.agenturKey ?? pinned[0] ?? "");
  const [typedKey, setTypedKey] = useState("");
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      paths.map((path) => [path, String(valueAt(scoped?.settings ?? {}, path) ?? "")]),
    ),
  );
  const [source, setSource] = useState<string>(scoped?.source ?? "");
  const [confirmedOn, setConfirmedOn] = useState(formatDate(scoped?.confirmedOn));
  const [errors, setErrors] = useState<Partial<Record<Field, string[]>>>({});
  const [formError, setFormError] = useState<string>();
  const agenturKey = choice === "" ? typedKey.trim() : choice;
  const message = (code: string) =>
    t(`overrides.errors.${code}`, { defaultValue: t("overrides.errors.invalid") });

  const save = useMutation({
    mutationFn: async (body: SetAgenturSettingInput) => {
      const { data } = await api.PUT(
        "/api/v1/projects/{projectId}/config/agentur-settings/{agenturKey}",
        { params: { path: { projectId, agenturKey } }, body },
      );
      if (!data) throw new Error("Setting was not saved");
      return data;
    },
    onSuccess: (next) => {
      queryClient.setQueryData(query.queryKey, next);
      showToast({ title: t("overrides.saved"), subtitle: agenturKey });
      onDone();
    },
    onError: async (failure) => {
      const problem = failure instanceof ApiProblemError ? failure : undefined;
      const fieldErrors: Partial<Record<Field, string[]>> = {};
      let whole =
        problem?.status === 403 ? "forbidden" : problem?.status === 409 ? "conflict" : undefined;
      for (const item of problem && [400, 422].includes(problem.status)
        ? (problem.problem.errors ?? [])
        : []) {
        const field = item.parameter ?? item.pointer?.split("/")[1];
        if (field && FIELDS.includes(field)) (fieldErrors[field as Field] ??= []).push(item.code);
        else whole ??= item.code;
      }
      setErrors(fieldErrors);
      setFormError(whole ?? (Object.keys(fieldErrors).length ? undefined : "failed"));
      if (whole === "conflict") await queryClient.invalidateQueries({ queryKey: query.queryKey });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const settings: Record<string, Record<string, unknown>> = {};
    const fieldErrors: Partial<Record<Field, string[]>> = {};
    for (const path of paths) {
      const text = values[path]!;
      if (text === "") continue;
      const [step, key] = path.split(".") as [string, string];
      const number = Number(text);
      if (choices[path] === "number" && !(Number.isInteger(number) && number >= 0)) {
        fieldErrors.settings = ["invalid_number"];
      }
      (settings[step] ??= {})[key] =
        choices[path] === "number"
          ? number
          : text === "true"
            ? true
            : text === "false"
              ? false
              : text;
    }
    const date = parseDisplayDate(confirmedOn);
    if (!date.ok || !date.value) fieldErrors.confirmedOn = ["invalid_date"];
    setErrors(fieldErrors);
    setFormError(undefined);
    if (Object.keys(fieldErrors).length || !date.ok || !date.value) return;
    save.mutate({
      expectedVersion: config.override.version,
      settings,
      source: source as SetAgenturSettingInput["source"],
      confirmedOn: date.value,
    });
  }

  const invalid = (field: Field) =>
    errors[field] && {
      invalid: true,
      invalidText: errors[field].map((code) => <span key={code}>{message(code)} </span>),
    };

  return (
    <Form className="tp-form" onSubmit={submit} noValidate>
      <Stack gap={5}>
        <h3>
          {scoped ? t("overrides.editTitle", { agentur: scoped.agenturKey }) : t("overrides.add")}
        </h3>
        {formError && (
          <InlineNotification kind="error" title={message(formError)} hideCloseButton />
        )}
        {!scoped && (
          <Select
            id="override-agentur"
            labelText={t("overrides.agentur")}
            value={choice}
            onChange={(event) => setChoice(event.target.value)}
            {...invalid("agenturKey")}
          >
            {pinned.map((key) => (
              <SelectItem
                key={key}
                value={key}
                text={config.pins.find((p) => p.agenturKey === key)!.label.de}
              />
            ))}
            <SelectItem value="" text={t("overrides.otherAgentur")} />
          </Select>
        )}
        {!scoped && choice === "" && (
          <TextInput
            id="override-agentur-key"
            labelText={t("overrides.agenturKey")}
            helperText={t("overrides.agenturKeyHint")}
            value={typedKey}
            onChange={(event) => setTypedKey(event.target.value)}
            {...invalid("agenturKey")}
          />
        )}
        {errors.settings && (
          <InlineNotification
            kind="error"
            title={errors.settings.map(message).join(" ")}
            hideCloseButton
          />
        )}
        {paths.map((path) => {
          const id = `override-${path.replace(".", "-")}`;
          const label = t(`overrides.settings.${path}`);
          const set = (value: string) => setValues({ ...values, [path]: value });
          const options = choices[path];
          return options === "number" ? (
            <TextInput
              key={path}
              id={id}
              labelText={label}
              inputMode="numeric"
              value={values[path]}
              onChange={(event) => set(event.target.value)}
            />
          ) : (
            <Select
              key={path}
              id={id}
              labelText={label}
              value={values[path]}
              onChange={(event) => set(event.target.value)}
            >
              <SelectItem value="" text={t("overrides.notSet")} />
              {options.map((value) => (
                <SelectItem key={value} value={value} text={t(`overrides.values.${value}`)} />
              ))}
            </Select>
          );
        })}
        <Select
          id="override-source"
          labelText={t("overrides.columns.source")}
          value={source}
          onChange={(event) => setSource(event.target.value)}
          {...invalid("source")}
        >
          <SelectItem value="" text={t("overrides.chooseSource")} />
          {AgenturSettingSource.options.map((value) => (
            <SelectItem key={value} value={value} text={t(`overrides.sources.${value}`)} />
          ))}
        </Select>
        <DateField
          id="override-confirmed-on"
          labelText={t("overrides.columns.confirmedOn")}
          defaultValue={confirmedOn}
          onChange={setConfirmedOn}
          invalidText={invalid("confirmedOn")?.invalidText}
        />
        <ButtonSet>
          <Button kind="secondary" onClick={onDone}>
            {t("overrides.cancel")}
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {t("overrides.submit")}
          </Button>
        </ButtonSet>
      </Stack>
    </Form>
  );
}
