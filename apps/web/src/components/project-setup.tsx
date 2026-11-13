import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  Button,
  ButtonSet,
  formatTimestamp,
  InlineNotification,
  Select,
  SelectItem,
  SimpleTable,
  Stack,
  useToast,
} from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { projectConfigQuery, templateCatalogQuery, useApi } from "../api";
import { useSubmissionText } from "./project-activation";
import { TemplateMigration } from "./template-migration";

type CatalogEntry = components["schemas"]["TemplateCatalogEntry"];
type Blocker = components["schemas"]["ConfigBlocker"];

const columns = ["label", "agenturKey", "version", "sha256Prefix", "pinnedAt", "role"] as const;
type Notice = { kind: "success" | "error"; text: string };

/**
 * The step "Agentur" of the setup (ui-patterns.md, setup pages): the Project Agentur, the pinned
 * templates, their migration and the Agentur-specific settings. The pin form follows the server's
 * capabilities for this project (regional-variation.md, template versions), never catalog access:
 * only its PL pins, and the Project Agentur is chosen only while draft. A pin with newer catalog
 * versions is migrated with review when the server says so (`capabilities.migrateTemplate`, the
 * pin's `migrationTargets`). The API's 403 stays the enforcement. The step's status names the
 * Project Agentur; the activation blockers are in the page's header, the submission blockers
 * here, next to the template they belong to.
 */
export function AgenturStep({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const { data: config } = useSuspenseQuery(projectConfigQuery(api, projectId));
  const { capabilities } = config;
  const catalog = useQuery({ ...templateCatalogQuery(api), enabled: capabilities.pinTemplate });
  const projectAgentur = config.pins.find((pin) => pin.agenturKey === config.projectAgenturKey);
  const submission = useSubmissionText(config);
  // The Agentur being migrated, and the migration's outcome, kept here because the migration
  // unmounts once its pin has no newer version (round 29).
  const [migrating, setMigrating] = useState<string>();
  const [migration, setMigration] = useState<Notice>();
  const migratable = config.pins.filter(
    (pin) => capabilities.migrateTemplate && pin.migrationTargets.length > 0,
  );
  const submissionBlockers = config.agenturen.flatMap(({ blockers }) => blockers);

  const rows = config.pins.map((pin) => ({
    id: pin.agenturKey,
    label: pin.label.de,
    agenturKey: pin.agenturKey,
    version: String(pin.version),
    sha256Prefix: pin.sha256Prefix,
    pinnedAt: formatTimestamp(pin.pinnedAt),
    role: pin === projectAgentur ? t("setup.projectAgenturRole") : t("setup.furtherAgenturRole"),
    actions: migratable.includes(pin) && (
      <Button
        kind="ghost"
        size="sm"
        onClick={() => {
          setMigration(undefined);
          setMigrating(pin.agenturKey);
        }}
      >
        {t("setup.migrate", { agentur: pin.label.de })}
      </Button>
    ),
  }));
  const migratingPin = migratable.find((pin) => pin.agenturKey === migrating);

  return (
    <Stack gap={5}>
      <p>
        {projectAgentur
          ? t("setup.projectAgentur", {
              label: projectAgentur.label.de,
              version: projectAgentur.version,
            })
          : t("setup.noProjectAgentur")}
      </p>
      {submissionBlockers.length > 0 && (
        <div>
          <p>{t("setup.submissionBlockers")}</p>
          <ul>
            {submissionBlockers.map((blocker) => (
              <li key={submission(blocker)}>{submission(blocker)}</li>
            ))}
          </ul>
        </div>
      )}
      <SimpleTable
        title={t("setup.pins")}
        columns={[...columns, ...(migratable.length ? (["actions"] as const) : [])].map((key) => ({
          key,
          header: t(`setup.columns.${key}`),
        }))}
        rows={rows}
        emptyState={t("setup.pinsEmpty")}
      />
      {migration && (
        <InlineNotification
          kind={migration.kind}
          title={migration.text}
          onClose={() => setMigration(undefined)}
        />
      )}
      {migratingPin && (
        <TemplateMigration
          key={migratingPin.agenturKey}
          projectId={projectId}
          pin={migratingPin}
          onDone={(notice) => {
            setMigrating(undefined);
            setMigration(notice);
          }}
          onCancel={() => setMigrating(undefined)}
        />
      )}
      {capabilities.pinTemplate && catalog.data && (
        <PinForm
          projectId={projectId}
          catalog={catalog.data}
          setsProjectAgentur={capabilities.setProjectAgentur}
        />
      )}
    </Stack>
  );
}

/** The activation's outcome, shown beside the setup header's action and outliving the step. */
export function ActivationOutcome({
  config,
  warnings,
  refusal,
  onCloseWarnings,
  onCloseRefusal,
}: {
  config: components["schemas"]["ProjectConfig"];
  warnings?: Blocker[];
  refusal?: string;
  onCloseWarnings: () => void;
  onCloseRefusal: () => void;
}) {
  const { t } = useTranslation();
  const submission = useSubmissionText(config);
  return (
    <>
      {refusal && <InlineNotification kind="error" title={refusal} onClose={onCloseRefusal} />}
      {warnings && (
        <InlineNotification
          kind="warning"
          title={t("setup.activate.warnings")}
          subtitle={warnings.map(submission).join(" · ")}
          onClose={onCloseWarnings}
        />
      )}
    </>
  );
}

/** Chooses an Agentur and version from the catalog (the latest preselected, R12). */
function PinForm(props: {
  projectId: string;
  catalog: CatalogEntry[];
  /** Offers "Als Projekt-Agentur festlegen" (draft only, R1). */
  setsProjectAgentur: boolean;
}) {
  const { projectId, catalog, setsProjectAgentur } = props;
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const keys = [...new Set(catalog.map((entry) => entry.agenturKey))];
  const versionsOf = (key: string) =>
    catalog
      .filter((entry) => entry.agenturKey === key)
      .map((entry) => entry.version)
      .toReversed();
  const [agenturKey, setAgenturKey] = useState(keys[0] ?? "");
  const [version, setVersion] = useState(versionsOf(keys[0] ?? "")[0]);
  const [error, setError] = useState<string>();

  const pin = useMutation({
    mutationFn: async (projectAgentur: boolean) => {
      const { data } = await api.POST("/api/v1/projects/{projectId}/config/pins", {
        params: { path: { projectId } },
        body: { agenturKey, version, projectAgentur },
      });
      if (!data) throw new Error("Template was not pinned");
      return data;
    },
    onSuccess: async (config) => {
      setError(undefined);
      queryClient.setQueryData(projectConfigQuery(api, projectId).queryKey, config);
      await queryClient.invalidateQueries({ queryKey: ["projects", projectId], exact: true });
      showToast({ title: t("setup.pinned"), subtitle: `${agenturKey} · ${version}` });
    },
    onError: (failure) => {
      const problem = failure instanceof ApiProblemError ? failure : undefined;
      const code = problem?.status === 403 ? "forbidden" : problem?.problem.errors?.[0]?.code;
      setError(t(`setup.errors.${code ?? "failed"}`, { defaultValue: t("setup.errors.failed") }));
    },
  });

  return (
    <Stack gap={5}>
      <h3>{t("setup.pinTitle")}</h3>
      {error && <InlineNotification kind="error" title={error} hideCloseButton />}
      <Select
        id="pin-agentur"
        labelText={t("setup.agentur")}
        value={agenturKey}
        onChange={(event) => {
          setAgenturKey(event.target.value);
          setVersion(versionsOf(event.target.value)[0]);
        }}
      >
        {keys.map((key) => (
          <SelectItem
            key={key}
            value={key}
            text={catalog.find((entry) => entry.agenturKey === key)!.label.de}
          />
        ))}
      </Select>
      <Select
        id="pin-version"
        labelText={t("setup.version")}
        helperText={t("setup.versionHint")}
        value={String(version)}
        onChange={(event) => setVersion(Number(event.target.value))}
      >
        {versionsOf(agenturKey).map((v, index) => (
          <SelectItem
            key={v}
            value={String(v)}
            text={index === 0 ? t("setup.latestVersion", { version: v }) : String(v)}
          />
        ))}
      </Select>
      <ButtonSet>
        <Button kind="tertiary" disabled={pin.isPending} onClick={() => pin.mutate(false)}>
          {t("setup.pinFurther")}
        </Button>
        {setsProjectAgentur && (
          <Button kind="tertiary" disabled={pin.isPending} onClick={() => pin.mutate(true)}>
            {t("setup.pinProjectAgentur")}
          </Button>
        )}
      </ButtonSet>
    </Stack>
  );
}
