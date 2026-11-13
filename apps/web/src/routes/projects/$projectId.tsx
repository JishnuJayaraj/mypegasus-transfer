import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, createLink, Outlet, useRouterState } from "@tanstack/react-router";
import {
  Add,
  Button,
  InlineNotification,
  Link,
  PageHeader,
  SidePanel,
  Stack,
  StatusTag,
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
import { ManualParticipationForm } from "../../components/manual-participation-form";
import { usePanelNavigationGuard } from "../../components/panel-guard";
import { RegionText } from "../../components/project-region";
import { RouteError } from "../../components/route-error";

const RouterLink = createLink(Link);

/**
 * The project's layout: its header above the section the route names (ui-patterns.md,
 * navigation). The sections are routes of their own; the side navigation lists them.
 */
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
  const navigate = Route.useNavigate();
  const { data: project } = useSuspenseQuery(projectQuery(useApi(), projectId));
  // Manual creation is one import row (process-and-lifecycle.md, import and manual creation):
  // offered with the import's capability, as the page's primary action; the import beside it.
  const { data: config } = useSuspenseQuery(projectConfigQuery(useApi(), projectId));
  const mayImport = config.capabilities.importParticipations;
  // "Einrichtung" carries its own one primary action (the next setup step or activation).
  const onSetup =
    useRouterState({ select: (state) => state.location.pathname }) ===
    `/projects/${projectId}/setup`;
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
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
        metadata={<RegionText projectId={projectId} />}
        primaryAction={
          mayImport &&
          !onSetup && (
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
                    void navigate({
                      to: "/projects/$projectId/setup",
                      params: { projectId },
                      hash: "project-import",
                    }),
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
            void navigate({ to: "/projects/$projectId/participants", params: { projectId } });
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
      <Outlet />
    </>
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
