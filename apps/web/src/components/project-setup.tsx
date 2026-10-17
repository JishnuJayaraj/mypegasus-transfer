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

type ProjectConfig = components["schemas"]["ProjectConfig"];
type CatalogEntry = components["schemas"]["TemplateCatalogEntry"];
type Blocker = components["schemas"]["ConfigBlocker"];

const columns = ["label", "agenturKey", "version", "sha256Prefix", "pinnedAt", "role"] as const;

/**
 * The setup section of the project page (Slice 2 plan 5.13): the Project Agentur, the pinned
 * templates and what blocks the project. The pin form follows the server's capabilities for this
 * project (round 26), never catalog access: only its PL pins, and the Project Agentur is chosen
 * only while draft. The API's 403 stays the enforcement.
 */
export function ProjectSetup({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const { data: config } = useSuspenseQuery(projectConfigQuery(api, projectId));
  const { capabilities } = config;
  const catalog = useQuery({ ...templateCatalogQuery(api), enabled: capabilities.pinTemplate });
  const projectAgentur = config.pins.find((pin) => pin.agenturKey === config.projectAgenturKey);

  const rows = config.pins.map((pin) => ({
    id: pin.agenturKey,
    label: pin.label.de,
    agenturKey: pin.agenturKey,
    version: String(pin.version),
    sha256Prefix: pin.sha256Prefix,
    pinnedAt: formatTimestamp(pin.pinnedAt),
    role: pin === projectAgentur ? t("setup.projectAgenturRole") : t("setup.furtherAgenturRole"),
  }));

  return (
    <section aria-labelledby="project-setup" className="tp-section">
      <h2 id="project-setup">{t("setup.title")}</h2>
      <p>
        {projectAgentur
          ? t("setup.projectAgentur", {
              label: projectAgentur.label.de,
              version: projectAgentur.version,
            })
          : t("setup.noProjectAgentur")}
      </p>
      <SimpleTable
        title={t("setup.pins")}
        columns={columns.map((key) => ({ key, header: t(`setup.columns.${key}`) }))}
        rows={rows}
        emptyState={t("setup.pinsEmpty")}
      />
      <Blockers config={config} />
      {capabilities.pinTemplate && catalog.data && (
        <PinForm
          projectId={projectId}
          catalog={catalog.data}
          setsProjectAgentur={capabilities.setProjectAgentur}
        />
      )}
    </section>
  );
}

/** The activation blockers and, per pinned Agentur, its step-scoped submission blockers. */
function Blockers({ config }: { config: ProjectConfig }) {
  const { t } = useTranslation();
  const labelOf = (key: string | null) =>
    config.pins.find((pin) => pin.agenturKey === key)?.label.de ?? key ?? "";
  const submission = (blocker: Blocker) =>
    blocker.code === "agentur_submission_blocked"
      ? t("setup.submissionBlocked", {
          agentur: labelOf(blocker.agenturKey),
          step: t(`setup.steps.${blocker.step}`),
          missing: blocker.missing
            .map((key) => t(`setup.settings.${key}`, { defaultValue: key }))
            .join(", "),
        })
      : t("setup.activation.project_activation_blocked");
  const items = [
    ...config.activationBlockers.map((code) => t(`setup.activation.${code}`)),
    ...config.agenturen.flatMap(({ blockers }) => blockers.map(submission)),
  ];
  return (
    <>
      <h3>{t("setup.blockers")}</h3>
      {items.length ? (
        <ul className="tp-list">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p>{t("setup.noBlockers")}</p>
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
    <Stack gap={5} className="tp-form">
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
        <Button kind="secondary" disabled={pin.isPending} onClick={() => pin.mutate(false)}>
          {t("setup.pinFurther")}
        </Button>
        {setsProjectAgentur && (
          <Button disabled={pin.isPending} onClick={() => pin.mutate(true)}>
            {t("setup.pinProjectAgentur")}
          </Button>
        )}
      </ButtonSet>
    </Stack>
  );
}
