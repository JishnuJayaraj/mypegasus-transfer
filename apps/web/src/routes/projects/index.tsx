import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, createLink } from "@tanstack/react-router";
import { Add, Button, formatTimestamp, Link, PageHeader, SimpleTable } from "@transfer/ui";
import { useTranslation } from "react-i18next";
import { projectsQuery, useApi } from "../../api";
import { RouteError } from "../../components/route-error";

const ButtonLink = createLink(Button);
const RouterLink = createLink(Link);

export const Route = createFileRoute("/projects/")({
  loader: ({ context }) => context.queryClient.ensureInfiniteQueryData(projectsQuery(context.api)),
  component: ProjectsPage,
  errorComponent: RouteError,
});

function ProjectsPage() {
  const { t } = useTranslation();
  const { data, hasNextPage, fetchNextPage, isFetchingNextPage } = useSuspenseInfiniteQuery(
    projectsQuery(useApi()),
  );
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
      status: t(`projects.statuses.${project.status}`),
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
        actions={
          <ButtonLink to="/projects/new" renderIcon={Add}>
            {t("projects.create")}
          </ButtonLink>
        }
      />
      <SimpleTable
        title={t("projects.title")}
        columns={columns}
        rows={rows}
        emptyState={t("projects.empty")}
      />
      {hasNextPage && (
        <Button
          className="tp-load-more"
          kind="tertiary"
          disabled={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
        >
          {t("projects.loadMore")}
        </Button>
      )}
    </>
  );
}
