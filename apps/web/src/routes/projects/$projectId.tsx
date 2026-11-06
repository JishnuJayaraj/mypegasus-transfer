import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, createLink } from "@tanstack/react-router";
import { WorklistFilter } from "@transfer/domain";
import {
  Add,
  Button,
  Card,
  formatDate,
  InlineNotification,
  Link,
  PageHeader,
  SidePanel,
  Stack,
  SimpleTable,
  StatusTag,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Tag,
  useToast,
} from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  entryWavesQuery,
  projectConfigQuery,
  projectQuery,
  projectTeamQuery,
  useApi,
  worklistQuery,
} from "../../api";
import { EntryWaveForm } from "../../components/entry-wave-form";
import { AgenturSettings } from "../../components/agentur-settings";
import { AgenturTab } from "../../components/agentur-tab";
import { ImportSection } from "../../components/import-section";
import { Kug200aHeader } from "../../components/kug200a-header";
import { ManualParticipationForm } from "../../components/manual-participation-form";
import { usePanelNavigationGuard } from "../../components/panel-guard";
import { Participants } from "../../components/participants";
import { parseSortCode } from "../../components/worklist-state";
import { ProjectDashboard } from "../../components/project-dashboard";
import { AppointmentsTab } from "../../components/appointments";
import { ProjectRegion, useRegionText } from "../../components/project-region";
import { ProjectSetup } from "../../components/project-setup";
import { ProjectTeam } from "../../components/team";
import { RouteError } from "../../components/route-error";
import { usePageTitle } from "../../page-title";

const RouterLink = createLink(Link);

/** Every tab's search value; "Übersicht" has none. Unknown values are dropped (old links open). */
const tabs = [undefined, "participants", "appointments", "agentur", "setup", "team"] as const;
type ProjectTab = Exclude<(typeof tabs)[number], undefined>;
export type ProjectSearch = WorklistFilter & { tab?: ProjectTab; sort?: string };

/**
 * The tabs a project shows, by how often they are used (the plan of Slice 6b, 6b-4): Übersicht,
 * Teilnehmende, Termine, Agentur (`ta_tg` only, the Kug 200b batches), Einrichtung, Team. The
 * `tab` search value names a tab, never its position, so every existing link keeps working.
 */
export function projectTabs(taTg: boolean): (ProjectTab | undefined)[] {
  return tabs.filter((tab) => tab !== "agentur" || taTg);
}

/**
 * The tab, the work list's code filters and its sort (data-protection.md, the work list): an
 * unknown tab, key or value is dropped, so a stale link still opens. Never a name or a search term.
 */
function projectSearch(search: Record<string, unknown>): ProjectSearch {
  const tab = tabs.find((value) => value !== undefined && value === search.tab);
  const filter = Object.fromEntries(
    Object.entries(WorklistFilter.shape).flatMap(([key, schema]) => {
      const parsed = schema.safeParse(search[key]);
      return parsed.success && parsed.data !== undefined ? [[key, parsed.data]] : [];
    }),
  ) as WorklistFilter;
  const sort = parseSortCode(search.sort);
  return { ...filter, ...(tab && { tab }), ...(sort && { sort }) };
}

export const Route = createFileRoute("/projects/$projectId")({
  validateSearch: projectSearch,
  loader: async ({ context: { api, queryClient }, params: { projectId } }) => {
    const [project] = await Promise.all([
      queryClient.ensureQueryData(projectQuery(api, projectId)),
      queryClient.ensureQueryData(projectConfigQuery(api, projectId)),
      queryClient.ensureQueryData(projectTeamQuery(api, projectId)),
    ]);
    if (project.type === "ta_tg")
      await queryClient.ensureQueryData(entryWavesQuery(api, projectId));
  },
  component: ProjectPage,
  errorComponent: RouteError,
});

function ProjectPage() {
  const { t } = useTranslation();
  const { projectId } = Route.useParams();
  const { tab, sort, ...filter } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: project } = useSuspenseQuery(projectQuery(useApi(), projectId));
  const taTg = project.type === "ta_tg";
  const shownTabs = projectTabs(taTg);
  // A tab the project doesn't have (Agentur in a `ta_only` project) shows the overview.
  const selected = Math.max(0, shownTabs.indexOf(tab));
  const tabLabels = {
    participants: t("projectDetail.participants"),
    appointments: t("projectDetail.appointments"),
    setup: t("projectDetail.setup"),
    team: t("team.title"),
    agentur: t("projectDetail.agentur"),
  } satisfies Record<ProjectTab, string>;
  const label = (value: ProjectTab | undefined) =>
    value ? tabLabels[value] : t("projectDetail.overview");
  usePageTitle(label(shownTabs[selected]), project.name);
  const region = useRegionText(projectId);
  // Manual creation is one import row (process-and-lifecycle.md, import and manual creation):
  // offered with the import's capability, as the page's primary action; the import beside it.
  const { data: config } = useSuspenseQuery(projectConfigQuery(useApi(), projectId));
  const mayImport = config.capabilities.importParticipations;
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const panel = (value: ProjectTab | undefined) => {
    switch (value) {
      case undefined:
        return <ProjectDashboard projectId={projectId} taTg={taTg} />;
      case "participants":
        return (
          <Participants
            projectId={projectId}
            taTg={taTg}
            filter={filter}
            sort={sort}
            onChange={(next) =>
              void navigate({
                search: {
                  ...next.filter,
                  tab: "participants",
                  ...(next.sort && { sort: next.sort }),
                },
                replace: true,
              })
            }
          />
        );
      case "appointments":
        return <AppointmentsTab projectId={projectId} taTg={taTg} />;
      case "agentur":
        return <AgenturTab projectId={projectId} />;
      case "setup":
        return <ProjectSetupTab projectId={projectId} taTg={taTg} />;
      case "team":
        return <ProjectTeam projectId={projectId} />;
    }
  };
  return (
    <>
      <PageHeader
        title={project.name}
        breadcrumbs={[
          // An ancestor, never the current page: active only on exactly /projects.
          <RouterLink key="projects" to="/projects" activeOptions={{ exact: true }}>
            {t("projects.title")}
          </RouterLink>,
        ]}
        tags={
          <>
            <Tag type="outline" size="sm">
              {t("projectDetail.customer", { customer: project.customerName })}
            </Tag>
            <Tag type="outline" size="sm">
              {t(`projects.types.${project.type}`)}
            </Tag>
            <StatusTag family="project" code={project.status} />
          </>
        }
        metadata={region}
        primaryAction={
          mayImport && (
            <Button
              renderIcon={Add}
              onClick={() => {
                setCreated(null);
                setAdding(true);
              }}
            >
              {t("manual.add")}
            </Button>
          )
        }
        menuActions={
          mayImport
            ? [
                {
                  label: t("manual.import"),
                  onClick: () =>
                    void navigate({ search: { tab: "setup" }, hash: "project-import" }),
                },
              ]
            : []
        }
      />
      {mayImport && (
        <AddParticipant
          projectId={projectId}
          open={adding}
          onClose={() => setAdding(false)}
          onCreated={(id) => {
            setAdding(false);
            setCreated(id);
            void navigate({ search: { tab: "participants" } });
          }}
        />
      )}
      {created && (
        <Stack gap={3}>
          <InlineNotification
            kind="success"
            title={t("manual.created")}
            onClose={() => setCreated(null)}
          />
          <p>
            <RouterLink
              to="/projects/$projectId/participations/$participationId"
              params={{ projectId, participationId: created }}
            >
              {t("manual.openCreated")}
            </RouterLink>
          </p>
        </Stack>
      )}
      <Tabs
        selectedIndex={selected}
        onChange={({ selectedIndex }) => {
          const next = shownTabs[selectedIndex];
          void navigate({ search: next ? { tab: next } : {} });
        }}
      >
        <TabList aria-label={t("projectDetail.tabs")}>
          {shownTabs.map((value) => (
            <Tab key={value ?? "overview"}>{label(value)}</Tab>
          ))}
        </TabList>
        {/* Each tab loads its data only when shown; a panel is named by its tab, never by a
            heading of its own (ui-patterns.md, principle 6). */}
        <TabPanels>
          {shownTabs.map((value, index) => (
            <TabPanel key={value ?? "overview"}>{index === selected && panel(value)}</TabPanel>
          ))}
        </TabPanels>
      </Tabs>
    </>
  );
}

/**
 * "Einrichtung" as cards (the plan of Slice 6b, 6b-4): Projekt (status, region change, blockers,
 * activation), Agentur (pins and Agentur-specific settings), Wellen (in `ta_only` only why there
 * are none), Kug 200a-Kopf (`ta_tg`) and Import (`project-import`, the target of "Datei importieren"). An anchor list beside them on
 * wide screens; below 66rem the cards simply follow each other.
 */
function ProjectSetupTab({ projectId, taTg }: { projectId: string; taTg: boolean }) {
  const { t } = useTranslation();
  const anchors = [
    { id: "setup-project", label: t("setup.project") },
    { id: "setup-agentur", label: t("setup.agenturTitle") },
    { id: "setup-waves", label: t("projectDetail.waves") },
    ...(taTg ? [{ id: "setup-kug200a", label: t("kug200aHeader.title") }] : []),
    { id: "project-import", label: t("import.title") },
  ];
  return (
    <div className="tp-anchored">
      <nav className="tp-anchor-list" aria-label={t("setup.onThisPage")}>
        <p className="tp-anchor-list-title" aria-hidden="true">
          {t("setup.onThisPage")}
        </p>
        <ul>
          {anchors.map(({ id, label }) => (
            <li key={id}>
              <RouterLink
                to="/projects/$projectId"
                params={{ projectId }}
                search={{ tab: "setup" }}
                hash={id}
              >
                {label}
              </RouterLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="tp-anchored-content">
        <ProjectSetup
          projectId={projectId}
          region={<ProjectRegion projectId={projectId} />}
          agentur={<AgenturSettings projectId={projectId} />}
        />
        {taTg ? (
          <>
            <EntryWaves projectId={projectId} />
            <Kug200aHeader projectId={projectId} />
          </>
        ) : (
          <Card id="setup-waves" title={t("projectDetail.waves")}>
            <p>{t("waveForm.errors.not_ta_tg")}</p>
          </Card>
        )}
        <ImportSection projectId={projectId} />
      </div>
    </div>
  );
}

/** "Teilnehmende hinzufügen": the manual creation in a side panel (ui-patterns.md, C4). */
function AddParticipant({
  projectId,
  open,
  onClose,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onCreated: (participationId: string) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [dirty, setDirty] = useState(false);
  const pendingNavigation = usePanelNavigationGuard(open && dirty);
  return (
    <SidePanel
      open={open}
      title={t("manual.title")}
      dirty={dirty}
      onClose={() => {
        setDirty(false);
        onClose();
      }}
      pendingNavigation={pendingNavigation}
    >
      <ManualParticipationForm
        projectId={projectId}
        onDirtyChange={setDirty}
        onCreated={async (detail) => {
          setDirty(false);
          onCreated(detail.id);
          showToast({ title: t("manual.created") });
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: worklistQuery(api, projectId).queryKey }),
            queryClient.invalidateQueries({ queryKey: entryWavesQuery(api, projectId).queryKey }),
          ]);
        }}
      />
    </SidePanel>
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
    <Card id="setup-waves" title={t("projectDetail.waves")}>
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
    </Card>
  );
}
