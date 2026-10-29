import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { WorklistFilter } from "@transfer/domain";
import {
  Add,
  Button,
  formatDate,
  PageHeader,
  SimpleTable,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
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
} from "../../api";
import { EntryWaveForm } from "../../components/entry-wave-form";
import { AgenturSettings } from "../../components/agentur-settings";
import { AgenturTab } from "../../components/agentur-tab";
import { ImportSection } from "../../components/import-section";
import { Participants } from "../../components/participants";
import { ProjectDashboard } from "../../components/project-dashboard";
import { AppointmentsTab } from "../../components/appointments";
import { ProjectRegion } from "../../components/project-region";
import { ProjectSetup } from "../../components/project-setup";
import { ProjectTeam } from "../../components/team";
import { RouteError } from "../../components/route-error";

/**
 * The tabs: "Übersicht" (no `tab`), "Teilnehmende", "Termine", "Einrichtung", "Team" and, in a
 * `ta_tg` project, "Agentur" (the Kug 200b batches, last so the others keep their place).
 */
const tabs = [undefined, "participants", "appointments", "setup", "team", "agentur"] as const;
type ProjectTab = Exclude<(typeof tabs)[number], undefined>;
export type ProjectSearch = WorklistFilter & { tab?: ProjectTab };

/**
 * The tab and the work list's code filters (data-protection.md, the work list): an unknown tab,
 * key or value is dropped, so a stale link still opens. Never a name or a search term.
 */
function projectSearch(search: Record<string, unknown>): ProjectSearch {
  const tab = tabs.find((value) => value !== undefined && value === search.tab);
  const filter = Object.fromEntries(
    Object.entries(WorklistFilter.shape).flatMap(([key, schema]) => {
      const parsed = schema.safeParse(search[key]);
      return parsed.success && parsed.data !== undefined ? [[key, parsed.data]] : [];
    }),
  ) as WorklistFilter;
  return { ...filter, ...(tab && { tab }) };
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
  const { tab, ...filter } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: project } = useSuspenseQuery(projectQuery(useApi(), projectId));
  const taTg = project.type === "ta_tg";
  return (
    <>
      <PageHeader title={project.name} />
      <p>
        {[
          project.customerName,
          t(`projects.types.${project.type}`),
          t(`projects.statuses.${project.status}`),
        ].join(" · ")}
      </p>
      <ProjectRegion projectId={projectId} />
      <Tabs
        selectedIndex={tabs.indexOf(tab)}
        onChange={({ selectedIndex }) => {
          const next = tabs[selectedIndex];
          void navigate({ search: next ? { tab: next } : {} });
        }}
      >
        <TabList aria-label={t("projectDetail.tabs")}>
          <Tab>{t("projectDetail.overview")}</Tab>
          <Tab>{t("projectDetail.participants")}</Tab>
          <Tab>{t("projectDetail.appointments")}</Tab>
          <Tab>{t("projectDetail.setup")}</Tab>
          <Tab>{t("team.title")}</Tab>
          {taTg && <Tab>{t("projectDetail.agentur")}</Tab>}
        </TabList>
        {/* Each tab loads its data only when shown. */}
        <TabPanels>
          <TabPanel>
            {tab === undefined && <ProjectDashboard projectId={projectId} taTg={taTg} />}
          </TabPanel>
          <TabPanel>
            {tab === "participants" && (
              <Participants
                projectId={projectId}
                taTg={taTg}
                filter={filter}
                onFilterChange={(next) =>
                  void navigate({ search: { ...next, tab: "participants" }, replace: true })
                }
              />
            )}
          </TabPanel>
          <TabPanel>
            {tab === "appointments" && <AppointmentsTab projectId={projectId} taTg={taTg} />}
          </TabPanel>
          <TabPanel>
            {tab === "setup" && (
              <>
                <ProjectSetup projectId={projectId} />
                <AgenturSettings projectId={projectId} />
                {taTg ? (
                  <EntryWaves projectId={projectId} />
                ) : (
                  <p>{t("waveForm.errors.not_ta_tg")}</p>
                )}
                <ImportSection projectId={projectId} />
              </>
            )}
          </TabPanel>
          <TabPanel>{tab === "team" && <ProjectTeam projectId={projectId} />}</TabPanel>
          {taTg && <TabPanel>{tab === "agentur" && <AgenturTab projectId={projectId} />}</TabPanel>}
        </TabPanels>
      </Tabs>
    </>
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
    <>
      <SimpleTable
        title={t("projectDetail.waves")}
        columns={columns.map((key) => ({ key, header: t(`projectDetail.columns.${key}`) }))}
        rows={rows}
        emptyState={t("projectDetail.wavesEmpty")}
      />
      {editing === null ? (
        <Button className="tp-load-more" renderIcon={Add} onClick={() => setEditing("new")}>
          {t("projectDetail.addWave")}
        </Button>
      ) : (
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
    </>
  );
}
