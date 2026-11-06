import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { meQuery, projectTeamQuery, useApi } from "../api";
import type { ViewerRoles } from "./worklist-views";

/**
 * The viewer's project roles (the team's members): for the work list's quick views and count
 * line, and the dashboard's featured tiles. Display only; the API enforces access.
 */
export function useViewerRoles(projectId: string): ViewerRoles & { assignedOnly: boolean } {
  const api = useApi();
  const { data: me } = useQuery(meQuery(api));
  const { data: team } = useSuspenseQuery(projectTeamQuery(api, projectId));
  return useMemo(() => {
    const roles = team.members.find((member) => member.staffUserId === me?.id)?.roles ?? [];
    const projectLead = roles.includes("project_lead");
    const backOffice = roles.includes("back_office");
    const consultant = roles.includes("consultant");
    return {
      staffUserId: me?.id,
      projectLead,
      backOffice,
      consultant,
      // An assigned consultant's list is their assignments (data-protection.md, the work list).
      assignedOnly: consultant && !projectLead && !backOffice,
    };
  }, [team, me?.id]);
}
