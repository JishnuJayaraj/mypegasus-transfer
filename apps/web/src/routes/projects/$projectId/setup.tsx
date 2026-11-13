import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  Add,
  Button,
  ButtonSet,
  formatDate,
  formatTimestamp,
  Section,
  SectionCard,
  SimpleTable,
  Stack,
  StatusTag,
  StepList,
  Tag,
  type Step,
  type StepState,
  useToast,
} from "@transfer/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  entryWavesQuery,
  projectConfigQuery,
  projectDsvTemplateQuery,
  projectQuery,
  settlementDatesQuery,
  useApi,
} from "../../../api";
import { AgenturSettings } from "../../../components/agentur-settings";
import { ActivationOutcome, AgenturStep } from "../../../components/project-setup";
import { DsvTemplateStep } from "../../../components/dsv-template";
import { EntryWaveForm } from "../../../components/entry-wave-form";
import { ImportSection } from "../../../components/import-section";
import { Kug200aHeader } from "../../../components/kug200a-header";
import { ProjectActivationAction } from "../../../components/project-activation";
import { ProjectRegion } from "../../../components/project-region";
import { ProjectSectionPage } from "../../../components/project-sections";
import { SettlementDatesStep } from "../../../components/settlement-dates";

export const Route = createFileRoute("/projects/$projectId/setup")({ component: Setup });

function Setup() {
  const { projectId } = Route.useParams();
  return (
    <ProjectSectionPage section="setup" projectId={projectId}>
      {(taTg) => <ProjectSetupTab projectId={projectId} taTg={taTg} />}
    </ProjectSectionPage>
  );
}

const setupSteps = ["project", "agentur", "waves", "import", "dsv", "settlement"] as const;
type SetupStepId = (typeof setupSteps)[number];

/** The old anchors stay links to their step or card (ui-patterns.md, setup pages). */
const stepAnchor: Record<SetupStepId, string> = {
  project: "setup-project",
  agentur: "setup-agentur",
  waves: "setup-waves",
  import: "project-import",
  dsv: "setup-dsv",
  settlement: "setup-settlement",
};
const anchorStep = Object.fromEntries(setupSteps.map((id) => [stepAnchor[id], id])) as Record<
  string,
  SetupStepId
>;
const advancedAnchor = "setup-kug200a";
/** Each activation blocker points to the one step that resolves it. */
const blockerStep = {
  project_activation_blocked: "agentur",
  no_entry_wave_with_latest_entry_date: "waves",
} as const satisfies Record<components["schemas"]["ProjectActivationBlocker"], SetupStepId>;

function isSetupStep(id: string): id is SetupStepId {
  return (setupSteps as readonly string[]).includes(id);
}

const settlementFields = ["kugFinalSettlementDate", "measure110SettlementDate"] as const;

const forbidden = (error: unknown) => error instanceof ApiProblemError && error.status === 403;

/** A step whose id is one of the setup's, so selection and step states stay typed. */
type SetupStep = Step & { id: SetupStepId };

/**
 * "Einrichtung" as a step list (ui-patterns.md, setup pages): the setup's steps at the start with
 * their state and one line of status from what the page already loads; the selected step beside
 * them (below, under 66rem). The header names what blocks activation, each blocker with the step
 * that resolves it, and offers the page's one primary action: activation once nothing blocks it,
 * else the next blocked step. The rarely used Kug 200a header and the Agentur-scoped settings sit
 * under "Erweitert". The steps stay mounted so a draft survives a look at another step (C4).
 */
function ProjectSetupTab({ projectId, taTg }: { projectId: string; taTg: boolean }) {
  if (!taTg) return <SetupBody projectId={projectId} taTg={false} waves={[]} />;
  return <SetupWithWaves projectId={projectId} />;
}

function SetupWithWaves({ projectId }: { projectId: string }) {
  const { data: waves } = useSuspenseQuery(entryWavesQuery(useApi(), projectId));
  return <SetupBody projectId={projectId} taTg waves={waves} />;
}

function SetupBody({
  projectId,
  taTg,
  waves,
}: {
  projectId: string;
  taTg: boolean;
  waves: components["schemas"]["EntryWave"][];
}) {
  const { t } = useTranslation();
  const api = useApi();
  const hash = useRouterState({ select: (state) => state.location.hash });
  const { data: project } = useSuspenseQuery(projectQuery(api, projectId));
  const { data: config } = useSuspenseQuery(projectConfigQuery(api, projectId));
  // The step states read what the page already shows; the steps themselves load the same keys.
  const dsv = useQuery({ ...projectDsvTemplateQuery(api, projectId), enabled: taTg });
  const settlement = useQuery({ ...settlementDatesQuery(api, projectId), enabled: taTg });
  // The activation's outcome belongs to the header, which outlives the activation action.
  const [warnings, setWarnings] = useState<components["schemas"]["ConfigBlocker"][]>();
  const [refusal, setRefusal] = useState<string>();
  // The Import step's refusal lives here: it must outlive the wizard when a 403 withdraws the
  // import capability, which would otherwise remove the step and the message with it.
  const [importRefusal, setImportRefusal] = useState<string>();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selected, setSelected] = useState<SetupStepId | null>(null);
  // The address is read once per change, while rendering: an old anchor opens its step or card.
  const [lastHash, setLastHash] = useState<string>();
  if (hash !== lastHash) {
    setLastHash(hash);
    const anchored = anchorStep[hash];
    if (anchored) setSelected(anchored);
    if (hash === advancedAnchor) setAdvancedOpen(true);
  }

  const projectAgentur = config.pins.find((pin) => pin.agenturKey === config.projectAgenturKey);
  const participantCount = waves.reduce((sum, wave) => sum + wave.participations, 0);
  const dsvCurrent = dsv.data?.versions.find((entry) => entry.version === dsv.data?.version);

  const projectState: SetupStep = {
    id: "project",
    title: t("setup.progress.project"),
    state: "done",
    status: t(
      project.status === "active" ? "setup.progress.activeSince" : "setup.progress.draftSince",
      {
        date: formatTimestamp(project.activatedAt ?? project.createdAt).split(",")[0] ?? "",
      },
    ),
    children: (
      <div id={stepAnchor.project}>
        <ProjectStep projectId={projectId} project={project} />
      </div>
    ),
  };
  const agenturState: StepState = config.activationBlockers.includes("project_activation_blocked")
    ? "blocked"
    : projectAgentur
      ? "done"
      : "open";
  const agenturStep: SetupStep = {
    id: "agentur",
    title: t("setup.progress.agentur"),
    state: agenturState,
    status: projectAgentur
      ? t("setup.progress.agenturDone", {
          label: projectAgentur.label.de,
          version: projectAgentur.version,
        })
      : t("setup.progress.agenturMissing"),
    children: (
      <div id={stepAnchor.agentur}>
        <AgenturStep projectId={projectId} />
      </div>
    ),
  };
  const wavesBlocked = config.activationBlockers.includes("no_entry_wave_with_latest_entry_date");
  const wavesState: StepState = !taTg
    ? "done"
    : wavesBlocked
      ? "blocked"
      : waves.length === 0
        ? "open"
        : "done";
  const wavesStep: SetupStep = {
    id: "waves",
    title: t("setup.progress.waves"),
    state: wavesState,
    status: !taTg
      ? t("setup.progress.notRequired")
      : wavesBlocked
        ? t("setup.progress.wavesNoLatest")
        : waves.length === 0
          ? t("setup.progress.wavesNone")
          : t("setup.progress.waves", { count: waves.length }),
    children: (
      <div id={stepAnchor.waves}>
        {taTg ? <EntryWaves projectId={projectId} /> : <p>{t("waveForm.errors.not_ta_tg")}</p>}
      </div>
    ),
  };
  const importStep: SetupStep = {
    id: "import",
    title: t("setup.progress.import"),
    state: taTg && participantCount > 0 ? "done" : "open",
    // The participation count comes from the waves the page already loads; `ta_only` has none.
    status: taTg
      ? participantCount > 0
        ? t("setup.progress.participants", { count: participantCount })
        : t("setup.progress.noParticipants")
      : t("setup.progress.importOpen"),
    children: (
      <div id={stepAnchor.import}>
        <ImportSection projectId={projectId} refusal={importRefusal} onRefusal={setImportRefusal} />
      </div>
    ),
  };
  const dsvStep: SetupStep = {
    id: "dsv",
    title: t("setup.progress.dsv"),
    state: dsv.data?.version ? "done" : "open",
    status: forbidden(dsv.error)
      ? t("dsvTemplate.forbidden")
      : dsv.data
        ? dsv.data.version
          ? dsvCurrent && !dsvCurrent.approvedForLive
            ? t("setup.progress.dsvSample", { version: dsv.data.version })
            : t("setup.progress.dsvVersion", { version: dsv.data.version })
          : t("setup.progress.dsvNone")
        : undefined,
    children: (
      <div id={stepAnchor.dsv}>
        <DsvTemplateStep projectId={projectId} />
      </div>
    ),
  };
  const settlementRequired = settlement.data
    ? settlementFields.filter((field) => settlement.data.required[field])
    : [];
  const settlementMissing = settlement.data
    ? settlementRequired.filter((field) => !settlement.data[field])
    : [];
  const settlementOpen =
    !settlement.data || settlementMissing.length > 0 || settlement.data.required.fundingUnknown;
  const settlementStep: SetupStep = {
    id: "settlement",
    title: t("setup.progress.settlement"),
    state: settlementOpen ? "open" : "done",
    status: settlementOpen
      ? t("setup.progress.settlementOpen")
      : settlementRequired.length === 0
        ? t("setup.progress.notRequired")
        : t("setup.progress.settlementDone"),
    children: (
      <div id={stepAnchor.settlement}>
        <SettlementDatesStep projectId={projectId} />
      </div>
    ),
  };

  const steps = [
    projectState,
    agenturStep,
    wavesStep,
    ...(config.capabilities.importParticipations || importRefusal ? [importStep] : []),
    ...(taTg ? [dsvStep] : []),
    ...(taTg && !forbidden(settlement.error) ? [settlementStep] : []),
  ];
  // The page opens on the first step that needs work, not on the first done one.
  const currentStep =
    steps.find((step) => step.state === "blocked") ??
    steps.find((step) => step.state === "open") ??
    steps[0];
  // A hidden step (no import capability, DSV 403) is never shown: the page falls back to the
  // current one.
  const shown =
    selected && steps.some((step) => step.id === selected) ? selected : (currentStep?.id ?? null);

  // The router's scroll runs once the anchor's step is rendered (its state is set above).
  useEffect(() => {
    if (!hash) return;
    const frame = () => document.getElementById(hash)?.scrollIntoView?.({ block: "start" });
    const requested =
      typeof requestAnimationFrame === "function" ? requestAnimationFrame(frame) : (frame(), 0);
    return () => {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(requested);
    };
  }, [hash]);

  const select = (id: string) => {
    if (isSetupStep(id)) setSelected(id);
  };
  const titleOf = (id: SetupStepId) => steps.find((step) => step.id === id)?.title ?? "";
  const settingsCount = config.override.agenturSettings.length;
  const approved = config.override.relaxations.length;
  const openRequests = config.relaxationRequests.length;

  return (
    <Stack gap={6}>
      <SetupHeader
        project={project}
        config={config}
        selected={shown}
        titleOf={titleOf}
        onSelect={select}
        warnings={warnings}
        refusal={refusal}
        onWarnings={setWarnings}
        onRefusal={setRefusal}
      />
      <StepList
        label={t("setup.progress.label")}
        steps={steps}
        selected={shown}
        onSelect={select}
        keepMounted
      />
      <SectionCard
        title={t("setup.advanced.title")}
        summary={t("setup.advanced.summary", {
          settings: settingsCount,
          approved,
          open: openRequests,
        })}
        open={advancedOpen}
        onToggle={setAdvancedOpen}
        id={advancedAnchor}
      >
        <Stack gap={6}>
          {taTg && (
            <Section level={3} title={t("kug200aHeader.title")}>
              <Kug200aHeader projectId={projectId} />
            </Section>
          )}
          <AgenturSettings projectId={projectId} />
        </Stack>
      </SectionCard>
    </Stack>
  );
}

/** The page header: how the setup stands, what blocks activation, and the one primary action. */
function SetupHeader({
  project,
  config,
  selected,
  titleOf,
  onSelect,
  warnings,
  refusal,
  onWarnings,
  onRefusal,
}: {
  project: components["schemas"]["Project"];
  config: components["schemas"]["ProjectConfig"];
  selected: SetupStepId | null;
  titleOf: (id: SetupStepId) => string;
  onSelect: (id: string) => void;
  warnings?: components["schemas"]["ConfigBlocker"][];
  refusal?: string;
  onWarnings: (warnings: components["schemas"]["ConfigBlocker"][] | undefined) => void;
  onRefusal: (message: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const blockers = config.activationBlockers;
  const target = blockers.length > 0 ? blockerStep[blockers[0]!] : undefined;
  const ready = blockers.length === 0 && config.capabilities.activateProject;
  return (
    <Stack gap={4}>
      <Stack orientation="horizontal" gap={3}>
        <StatusTag family="project" code={project.status} />
        {blockers.length > 0 ? (
          <Tag type="warm-gray" size="sm">
            {t("setup.progress.blockers", { count: blockers.length })}
          </Tag>
        ) : (
          ready && (
            <Tag type="green" size="sm">
              {t("setup.progress.ready")}
            </Tag>
          )
        )}
      </Stack>
      {blockers.length > 0 && (
        <div>
          <p>{t("setup.activate.blocked")}</p>
          <ul>
            {blockers.map((code) => (
              <li key={code}>
                {t(`setup.activation.${code}`)}{" "}
                <Button kind="tertiary" size="sm" onClick={() => onSelect(blockerStep[code])}>
                  {t("setup.progress.goTo", { step: titleOf(blockerStep[code]) })}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {blockers.length === 0 && <p>{t("setup.noBlockers")}</p>}
      {ready ? (
        <div>
          <ProjectActivationAction
            projectId={project.id}
            onActivated={(found) => {
              onRefusal(undefined);
              onWarnings(found.length > 0 ? found : undefined);
            }}
            onRefused={onRefusal}
          />
          <p>{t("setup.activate.hint")}</p>
        </div>
      ) : (
        <ButtonSet>
          {config.capabilities.activateProject && (
            // A blocked action keeps its prerequisite beside it (ui-patterns.md, principle 3).
            <Button disabled>{t("setup.activate.action")}</Button>
          )}
          {target !== undefined && target !== selected && (
            <Button kind="tertiary" onClick={() => onSelect(target)}>
              {t("setup.progress.next", { step: titleOf(target) })}
            </Button>
          )}
        </ButtonSet>
      )}
      <ActivationOutcome
        config={config}
        warnings={warnings}
        refusal={refusal}
        onCloseWarnings={() => onWarnings(undefined)}
        onCloseRefusal={() => onRefusal(undefined)}
      />
    </Stack>
  );
}

/** The project itself: what it is, where it belongs and who may change the region. */
function ProjectStep({
  projectId,
  project,
}: {
  projectId: string;
  project: components["schemas"]["Project"];
}) {
  const { t } = useTranslation();
  return (
    <Stack gap={5}>
      <p>
        {`${t("projectDetail.customer", { customer: project.customerName })} · ${t(`projects.types.${project.type}`)}`}
      </p>
      <p>
        {project.status === "active" && project.activatedAt
          ? t("setup.activeSince", { at: formatTimestamp(project.activatedAt) })
          : t("setup.draft")}
      </p>
      <ProjectRegion projectId={projectId} />
    </Stack>
  );
}

const columns = [
  "code",
  "name",
  "signingDeadline",
  "defaultTgStart",
  "defaultTgEnd",
  "latestEntryDate",
  "participations",
  "actions",
] as const;

/** The waves (Eintrittswellen) and one form for a new or the chosen wave. */
function EntryWaves({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const api = useApi();
  const query = entryWavesQuery(api, projectId);
  const { data: waves } = useSuspenseQuery(query);
  // "new", a wave's id, or no form.
  const [editing, setEditing] = useState<string | null>(null);

  const rows = waves.map((wave) => ({
    id: wave.id,
    code: wave.code,
    name: wave.name,
    signingDeadline: formatDate(wave.signingDeadline),
    defaultTgStart: formatDate(wave.defaultTgStart),
    defaultTgEnd: formatDate(wave.defaultTgEnd),
    latestEntryDate: formatDate(wave.latestEntryDate),
    participations: String(wave.participations),
    actions: (
      <Button kind="ghost" size="sm" onClick={() => setEditing(wave.id)}>
        {t("projectDetail.edit", { code: wave.code })}
      </Button>
    ),
  }));

  return (
    <Stack gap={5}>
      <SimpleTable
        title={t("projectDetail.waves")}
        hideTitle
        columns={columns.map((key) => ({ key, header: t(`projectDetail.columns.${key}`) }))}
        rows={rows}
        emptyState={t("projectDetail.wavesEmpty")}
        footer={
          editing === null && (
            <Button renderIcon={Add} onClick={() => setEditing("new")}>
              {t("projectDetail.addWave")}
            </Button>
          )
        }
      />
      {editing !== null && (
        <EntryWaveForm
          key={editing}
          projectId={projectId}
          wave={waves.find((wave) => wave.id === editing)}
          onCancel={() => setEditing(null)}
          onSaved={async (wave) => {
            // A wave's latest entry date changes the activation blockers (Q77).
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: query.queryKey }),
              queryClient.invalidateQueries({
                queryKey: projectConfigQuery(api, projectId).queryKey,
              }),
            ]);
            showToast({ title: t("projectDetail.waveSaved"), subtitle: wave.code });
            setEditing(null);
          }}
        />
      )}
    </Stack>
  );
}
