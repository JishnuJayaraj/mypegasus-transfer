import { useQuery, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, createLink } from "@tanstack/react-router";
import {
  Add,
  Button,
  EmptyState,
  formatTimestamp,
  Link,
  PageHeader,
  SimpleTable,
  StatusTag,
} from "@transfer/ui";
import { useTranslation } from "react-i18next";
import { meQuery, projectsQuery, useApi } from "../../api";
import { RouteError } from "../../components/route-error";
import { usePageTitle } from "../../page-title";

const ButtonLink = createLink(Button);
const RouterLink = createLink(Link);

export const Route = createFileRoute("/projects/")({
  loader: ({ context }) => context.queryClient.ensureInfiniteQueryData(projectsQuery(context.api)),
  component: ProjectsPage,
  errorComponent: RouteError,
});

function ProjectsPage() {
  const { t } = useTranslation();
  usePageTitle(t("projects.title"));
  const api = useApi();
  const { data, hasNextPage, fetchNextPage, isFetchingNextPage } = useSuspenseInfiniteQuery(
    projectsQuery(api),
  );
  // Only accounts the global admin allowed to create projects see the action (Q126).
  const mayCreate = useQuery(meQuery(api)).data?.mayCreateProjects === true;
  const rows = data.pages
    .flatMap((page) => page.items)
    .map((project) => ({
      id: project.id,
      name: (
        <RouterLink to="/projects/$projectId" params={{ projectId: project.id }}>
          {project.name}
        </RouterLink>
      ),
      customerName: project.customerName,
      type: t(`projects.types.${project.type}`),
      status: <StatusTag family="project" code={project.status} />,
      createdAt: formatTimestamp(project.createdAt),
    }));
  const columns = (["name", "customerName", "type", "status", "createdAt"] as const).map((key) => ({
    key,
    header: t(`projects.columns.${key}`),
  }));

  return (
    <>
      <PageHeader
        title={t("projects.title")}
        primaryAction={
          mayCreate && (
            <ButtonLink to="/projects/new" renderIcon={Add}>
              {t("projects.new")}
            </ButtonLink>
          )
        }
      />
      {/* "Projekte" once: the page's h1 names the table (ui-patterns.md, principle 6). */}
      <SimpleTable
        title={t("projects.title")}
        hideTitle
        columns={columns}
        rows={rows}
        emptyState={
          <EmptyState
            variant="noData"
            title={t("projects.emptyTitle")}
            description={mayCreate ? t("projects.emptyMayCreate") : t("projects.emptyOthers")}
          />
        }
        footer={
          hasNextPage && (
            <Button
              kind="tertiary"
              disabled={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              {t("projects.loadMore")}
            </Button>
          )
        }
      />
    </>
  );
}
