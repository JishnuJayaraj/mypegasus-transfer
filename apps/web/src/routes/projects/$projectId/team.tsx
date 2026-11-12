import { createFileRoute } from "@tanstack/react-router";
import { ProjectSectionPage } from "../../../components/project-sections";
import { ProjectTeam } from "../../../components/team";

export const Route = createFileRoute("/projects/$projectId/team")({ component: Team });

function Team() {
  const { projectId } = Route.useParams();
  return (
    <ProjectSectionPage section="team" projectId={projectId}>
      {() => <ProjectTeam projectId={projectId} />}
    </ProjectSectionPage>
  );
}
