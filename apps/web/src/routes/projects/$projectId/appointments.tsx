import { createFileRoute } from "@tanstack/react-router";
import { AppointmentsTab } from "../../../components/appointments";
import { ProjectSectionPage } from "../../../components/project-sections";

export const Route = createFileRoute("/projects/$projectId/appointments")({
  component: Appointments,
});

function Appointments() {
  const { projectId } = Route.useParams();
  return (
    <ProjectSectionPage section="appointments" projectId={projectId}>
      {(taTg) => <AppointmentsTab projectId={projectId} taTg={taTg} />}
    </ProjectSectionPage>
  );
}
