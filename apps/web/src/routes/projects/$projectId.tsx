import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
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
import { ImportSection } from "../../components/import-section";
import { Participants } from "../../components/participants";
import { ProjectRegion } from "../../components/project-region";
import { ProjectSetup } from "../../components/project-setup";
import { ProjectTeam } from "../../components/team";
import { RouteError } from "../../components/route-error";

export const Route = createFileRoute("/projects/$projectId")({
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
  const { data: project } = useSuspenseQuery(projectQuery(useApi(), projectId));
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
      <Tabs>
        <TabList aria-label={t("projectDetail.tabs")}>
          <Tab>{t("projectDetail.overview")}</Tab>
          <Tab>{t("team.title")}</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
            <ProjectSetup projectId={projectId} />
            <AgenturSettings projectId={projectId} />
            {project.type === "ta_tg" ? (
              <EntryWaves projectId={projectId} />
            ) : (
              <p>{t("waveForm.errors.not_ta_tg")}</p>
            )}
            <ImportSection projectId={projectId} />
            <Participants projectId={projectId} />
          </TabPanel>
          <TabPanel>
            <ProjectTeam projectId={projectId} />
          </TabPanel>
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
