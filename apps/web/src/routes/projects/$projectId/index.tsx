import { createFileRoute, redirect } from "@tanstack/react-router";
import { sectionOfTab, sectionRoute } from "../../../components/project-sections";

/**
 * `/projects/$projectId` and every old `?tab=` address lead to the section's route, with the work
 * list's codes and the anchor kept (ui-patterns.md, navigation); without a tab, the overview.
 */
export const Route = createFileRoute("/projects/$projectId/")({
  beforeLoad: ({ params, location }) => {
    const { tab, ...search } = location.search as Record<string, unknown>;
    const section = sectionOfTab(tab);
    throw redirect({
      to: sectionRoute[section],
      params,
      // The target validates the codes; only the work list has any.
      search: (section === "participants" ? search : {}) as never,
      hash: location.hash,
      replace: true,
    });
  },
});
