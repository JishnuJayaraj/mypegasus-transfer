import { useSuspenseQuery } from "@tanstack/react-query";
import { SectionHeading } from "@transfer/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { projectQuery, useApi } from "../api";
import { usePageTitle } from "../page-title";

/**
 * A project's sections, each a route of its own (ui-patterns.md, navigation): Übersicht,
 * Teilnehmende, Termine, Agentur (`ta_tg` only, the Kug 200b batches), Einrichtung, Team. Everyone
 * who opens the project sees them; what a section shows is decided by its capabilities.
 */
export const sections = [
  "overview",
  "participants",
  "appointments",
  "agentur",
  "setup",
  "team",
] as const;
export type ProjectSection = (typeof sections)[number];

export const sectionRoute = {
  overview: "/projects/$projectId/overview",
  participants: "/projects/$projectId/participants",
  appointments: "/projects/$projectId/appointments",
  agentur: "/projects/$projectId/agentur",
  setup: "/projects/$projectId/setup",
  team: "/projects/$projectId/team",
} as const satisfies Record<ProjectSection, string>;

export const sectionLabelKey = {
  overview: "projectDetail.overview",
  participants: "projectDetail.participants",
  appointments: "projectDetail.appointments",
  agentur: "projectDetail.agentur",
  setup: "projectDetail.setup",
  team: "team.title",
} as const satisfies Record<ProjectSection, string>;

export function projectSections(taTg: boolean): ProjectSection[] {
  return sections.filter((section) => section !== "agentur" || taTg);
}

/** The section of an old `?tab=` address; an unknown or missing value is the overview. */
export function sectionOfTab(tab: unknown): ProjectSection {
  return sections.find((section) => section === tab) ?? "overview";
}

/**
 * A section's page: its name as the heading under the project's header and in the document title
 * (never personal data, data-protection.md, page titles), then its content with the project's type.
 */
export function ProjectSectionPage({
  section,
  projectId,
  children,
}: {
  section: ProjectSection;
  projectId: string;
  children: (taTg: boolean) => ReactNode;
}) {
  const { t } = useTranslation();
  const { data: project } = useSuspenseQuery(projectQuery(useApi(), projectId));
  const label = t(sectionLabelKey[section]);
  usePageTitle(label, project.name);
  return (
    <>
      <SectionHeading>{label}</SectionHeading>
      {children(project.type === "ta_tg")}
    </>
  );
}
