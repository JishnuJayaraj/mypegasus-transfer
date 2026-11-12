import { createFileRoute } from "@tanstack/react-router";
import { WorklistFilter } from "@transfer/domain";
import { Participants } from "../../../components/participants";
import { ProjectSectionPage } from "../../../components/project-sections";
import { parseSortCode } from "../../../components/worklist-state";

export type WorklistSearch = WorklistFilter & { sort?: string };

/**
 * The work list's code filters and its sort (data-protection.md, the work list): an unknown key
 * or value is dropped, so a stale link still opens. Never a name or a search term.
 */
function worklistSearch(search: Record<string, unknown>): WorklistSearch {
  const filter = Object.fromEntries(
    Object.entries(WorklistFilter.shape).flatMap(([key, schema]) => {
      const parsed = schema.safeParse(search[key]);
      return parsed.success && parsed.data !== undefined ? [[key, parsed.data]] : [];
    }),
  ) as WorklistFilter;
  const sort = parseSortCode(search.sort);
  return { ...filter, ...(sort && { sort }) };
}

export const Route = createFileRoute("/projects/$projectId/participants")({
  validateSearch: worklistSearch,
  component: WorkList,
});

function WorkList() {
  const { projectId } = Route.useParams();
  const { sort, ...filter } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ProjectSectionPage section="participants" projectId={projectId}>
      {(taTg) => (
        <Participants
          projectId={projectId}
          taTg={taTg}
          filter={filter}
          sort={sort}
          onChange={(next) =>
            void navigate({
              search: { ...next.filter, ...(next.sort && { sort: next.sort }) },
              replace: true,
            })
          }
        />
      )}
    </ProjectSectionPage>
  );
}
