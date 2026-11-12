import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { projectQuery, useApi } from "../../../api";
import { AgenturTab } from "../../../components/agentur-tab";
import { ProjectDashboard } from "../../../components/project-dashboard";
import { ProjectSectionPage } from "../../../components/project-sections";

export const Route = createFileRoute("/projects/$projectId/agentur")({ component: Agentur });

/** The Kug 200b batches; a `ta_only` project has no such section and shows the overview here. */
function Agentur() {
  const { projectId } = Route.useParams();
  const { data: project } = useSuspenseQuery(projectQuery(useApi(), projectId));
  const taTg = project.type === "ta_tg";
  return (
    <ProjectSectionPage section={taTg ? "agentur" : "overview"} projectId={projectId}>
      {() =>
        taTg ? (
          <AgenturTab projectId={projectId} />
        ) : (
          <ProjectDashboard projectId={projectId} taTg={false} />
        )
      }
    </ProjectSectionPage>
  );
}
