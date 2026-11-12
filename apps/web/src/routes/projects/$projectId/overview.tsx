import { createFileRoute } from "@tanstack/react-router";
import { ProjectDashboard } from "../../../components/project-dashboard";
import { ProjectSectionPage } from "../../../components/project-sections";

export const Route = createFileRoute("/projects/$projectId/overview")({ component: Overview });

function Overview() {
  const { projectId } = Route.useParams();
  return (
    <ProjectSectionPage section="overview" projectId={projectId}>
      {(taTg) => <ProjectDashboard projectId={projectId} taTg={taTg} />}
    </ProjectSectionPage>
  );
}
