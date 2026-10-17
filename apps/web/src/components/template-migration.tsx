import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  Button,
  ButtonSet,
  InlineNotification,
  RadioButton,
  RadioButtonGroup,
  Select,
  SelectItem,
  Stack,
  useToast,
} from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { projectConfigQuery, projectQuery, useApi } from "../api";
import type { SettingPath, Value } from "./agentur-settings";

type ProjectConfig = components["schemas"]["ProjectConfig"];
type Pin = ProjectConfig["pins"][number];
type Preview = components["schemas"]["TemplateMigrationPreview"];
type Decision = components["schemas"]["MigrateTemplateInput"]["decisions"][string];
type Step = Preview["rules"]["added"][number]["step"];

/**
 * Migrates a pinned template to a newer catalog version (Slice 2 plan 5.8, 5.13; Q36, Q93, R15):
 * the PL chooses the version, sees what it changes and decides keep or remove for every key of the
 * Agentur's scoped setting, then confirms. Shown only with `capabilities.migrateTemplate` and the
 * pin's `migrationTargets` (round 26); the API's checks stay the enforcement. The outcome goes to
 * the parent, which outlives this component (round 29), and every outcome rereads the project,
 * the project list and the configuration.
 */
export function TemplateMigration(props: {
  projectId: string;
  pin: Pin;
  /** Receives the result or the refusal as a message; the parent closes this view. */
  onDone: (message: { kind: "success" | "error"; text: string }) => void;
  onCancel: () => void;
}) {
  const { projectId, pin, onDone, onCancel } = props;
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [version, setVersion] = useState(pin.migrationTargets.at(-1)!);
  const [preview, setPreview] = useState<Preview>();
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const agentur = pin.label.de;
  const path = { projectId, agenturKey: pin.agenturKey };

  const settingText = (key: string) => t(`overrides.settings.${key as SettingPath}`);
  const valueText = (value: Preview["review"][number]["value"]) =>
    value === null
      ? t("migration.notSet")
      : typeof value === "number"
        ? String(value)
        : t(`overrides.values.${String(value) as Value}`);
  const stepText = (step: Step) => t(`relaxations.steps.${step}`);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: projectQuery(api, projectId).queryKey }),
      queryClient.invalidateQueries({ queryKey: ["projects"], exact: true }),
      queryClient.invalidateQueries({ queryKey: projectConfigQuery(api, projectId).queryKey }),
    ]);
  const refused = async (failure: unknown) => {
    const problem = failure instanceof ApiProblemError ? failure : undefined;
    const status = problem?.status;
    const code =
      status === 403
        ? "forbidden"
        : status === 404
          ? "not_found"
          : status === 409
            ? "conflict"
            : problem?.problem.errors?.[0]?.code;
    const text = t(`migration.errors.${code ?? "failed"}`, {
      defaultValue: t("migration.errors.failed"),
    });
    onDone({ kind: "error", text });
    await refresh();
  };

  const show = useMutation({
    mutationFn: async () => {
      const { data } = await api.POST(
        "/api/v1/projects/{projectId}/config/pins/{agenturKey}/migration-preview",
        { params: { path }, body: { version } },
      );
      if (!data) throw new Error("No migration preview");
      return data;
    },
    onSuccess: (data) => {
      setPreview(data);
      setDecisions({});
    },
    onError: refused,
  });

  const confirm = useMutation({
    mutationFn: async (shown: Preview) => {
      const { data } = await api.POST(
        "/api/v1/projects/{projectId}/config/pins/{agenturKey}/migration",
        {
          params: { path },
          body: {
            fromVersion: shown.fromVersion,
            version: shown.version,
            expectedVersion: shown.expectedVersion,
            decisions,
          },
        },
      );
      if (!data) throw new Error("Template was not migrated");
      return data;
    },
    onSuccess: async (config, shown) => {
      queryClient.setQueryData(projectConfigQuery(api, projectId).queryKey, config);
      showToast({ title: t("migration.done") });
      const removed = shown.review.filter(({ key }) => decisions[key] === "remove");
      onDone({
        kind: "success",
        text: removed.length
          ? t("migration.resultRemoved", {
              agentur,
              version: shown.version,
              settings: removed.map(({ key }) => settingText(key)).join(", "),
            })
          : t("migration.result", { agentur, version: shown.version }),
      });
      await refresh();
    },
    onError: refused,
  });

  const changes = preview && [
    ...preview.settings.map(({ key, from, to }) =>
      t("migration.setting", {
        setting: settingText(key),
        from: valueText(from),
        to: valueText(to),
      }),
    ),
    ...(["added", "removed", "changed"] as const).flatMap((kind) => [
      ...preview.rules[kind].map(({ id, step }) =>
        t(`migration.rule.${kind}`, { rule: id, step: stepText(step) }),
      ),
      ...preview.fields[kind].map((field) => t(`migration.field.${kind}`, { field })),
    ]),
  ];
  const decided = preview?.review.every(({ key }) => decisions[key] !== undefined);
  const busy = show.isPending || confirm.isPending;

  return (
    <Stack gap={5} className="tp-form">
      <h3>{t("migration.title", { agentur })}</h3>
      <p>{t("migration.intro", { from: pin.version })}</p>
      <Select
        id="migration-version"
        labelText={t("migration.version")}
        value={String(version)}
        onChange={(event) => {
          setVersion(Number(event.target.value));
          setPreview(undefined);
        }}
      >
        {pin.migrationTargets.map((target) => (
          <SelectItem key={target} value={String(target)} text={String(target)} />
        ))}
      </Select>
      <ButtonSet>
        <Button kind="secondary" onClick={onCancel}>
          {t("migration.cancel")}
        </Button>
        <Button kind="tertiary" disabled={busy} onClick={() => show.mutate()}>
          {t("migration.show")}
        </Button>
      </ButtonSet>
      {preview && changes && (
        <>
          <h4>{t("migration.changesTitle", { version: preview.version })}</h4>
          {changes.length ? (
            <ul className="tp-list">
              {changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          ) : (
            <p>{t("migration.noChanges")}</p>
          )}
          {preview.overrideIssues.length > 0 && (
            <InlineNotification
              kind="error"
              title={t("migration.overrideIssues")}
              hideCloseButton
            />
          )}
          <h4>{t("migration.reviewTitle")}</h4>
          {preview.review.length === 0 && <p>{t("migration.reviewEmpty")}</p>}
          {preview.review.map(({ key, value, from, to }) => (
            <RadioButtonGroup
              key={key}
              name={`migration-${key}`}
              legendText={t("migration.review", {
                setting: settingText(key),
                value: valueText(value),
                from: valueText(from),
                to: valueText(to),
              })}
              valueSelected={decisions[key] ?? ""}
              onChange={(choice) => setDecisions({ ...decisions, [key]: choice as Decision })}
              orientation="vertical"
            >
              <RadioButton
                id={`migration-${key}-keep`}
                value="keep"
                labelText={t("migration.keep")}
              />
              <RadioButton
                id={`migration-${key}-remove`}
                value="remove"
                labelText={t("migration.remove")}
              />
            </RadioButtonGroup>
          ))}
          <div>
            <Button
              disabled={busy || !decided || preview.overrideIssues.length > 0}
              onClick={() => confirm.mutate(preview)}
            >
              {t("migration.confirm")}
            </Button>
          </div>
        </>
      )}
    </Stack>
  );
}
