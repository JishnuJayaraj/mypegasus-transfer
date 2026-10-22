import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createLink } from "@tanstack/react-router";
import { ApiProblemError, type components } from "@transfer/api-client";
import type { WorklistFilter } from "@transfer/domain";
import { formatDate, Link, SimpleTable } from "@transfer/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { dashboardQuery, entryWavesQuery, useApi } from "../api";
import type de from "../locales/de/translation.json";
import { useCountLabel, type LabelledGroup } from "./worklist-labels";

const RouterLink = createLink(Link);

type Count = components["schemas"]["DashboardCount"];
type TileKey = keyof typeof de.dashboard.tiles;

/** A count as a link to "Teilnehmende" with the same filter (data-protection.md, the dashboard). */
function CountLink({
  projectId,
  filter,
  children,
}: {
  projectId: string;
  filter: WorklistFilter;
  children: ReactNode;
}) {
  return (
    <RouterLink
      to="/projects/$projectId"
      params={{ projectId }}
      search={{ ...filter, tab: "participants" }}
    >
      {children}
    </RouterLink>
  );
}

/**
 * "Übersicht" (Slice 5, the PL dashboard): tiles and tables of exact counts of distinct
 * participations in the viewer's scope. Every number opens the work list with its filter, so the
 * list shows exactly the counted rows. Tables and tiles only: the CSP forbids a chart's inline
 * styles.
 */
export function ProjectDashboard({ projectId, taTg }: { projectId: string; taTg: boolean }) {
  const { t } = useTranslation();
  const query = useQuery(dashboardQuery(useApi(), projectId));
  if (query.error instanceof ApiProblemError && query.error.status === 403) {
    return <p role="alert">{t("dashboard.forbidden")}</p>;
  }
  if (query.error instanceof ApiProblemError && query.error.status === 422) {
    return <p role="alert">{t("worklist.tooLarge")}</p>;
  }
  if (query.isError) return <p role="alert">{t("dashboard.failed")}</p>;
  if (!query.data) return <p aria-live="polite">{t("worklist.loading")}</p>;
  const { counts, scope } = query.data;
  return (
    <section aria-labelledby="project-dashboard" className="tp-section">
      <h2 id="project-dashboard">{t("dashboard.title")}</h2>
      {scope === "assigned" && <p>{t("dashboard.scopeAssigned")}</p>}
      <ul className="tp-tiles">
        {counts.tiles.map(({ key, count, filter }) => (
          <li key={key}>
            <CountLink projectId={projectId} filter={filter}>
              <strong>{count}</strong> {t(`dashboard.tiles.${key as TileKey}`)}
            </CountLink>
          </li>
        ))}
      </ul>
      <CountTable projectId={projectId} group="statuses" counts={counts.statuses} />
      <CountTable
        projectId={projectId}
        group="profilingStatuses"
        counts={counts.profilingStatuses}
      />
      {taTg && (
        <>
          <CountTable projectId={projectId} group="dsvStatuses" counts={counts.dsvStatuses} />
          <Waves projectId={projectId} counts={counts.waves} />
        </>
      )}
      <Deadlines projectId={projectId} counts={counts.deadlines} />
      <CountTable projectId={projectId} group="flags" counts={counts.flags} />
      <CountTable projectId={projectId} group="activation" counts={counts.activation} />
      <CountTable projectId={projectId} group="notice" counts={counts.notice} />
      <CountTable projectId={projectId} group="portal" counts={counts.portal} />
    </section>
  );
}

function CountTable({
  projectId,
  group,
  counts,
}: {
  projectId: string;
  group: LabelledGroup;
  counts: Count[];
}) {
  const { t } = useTranslation();
  const label = useCountLabel();
  return (
    <SimpleTable
      title={t(`dashboard.groups.${group}`)}
      columns={[
        { key: "label", header: t("dashboard.columns.label") },
        { key: "count", header: t("dashboard.columns.count") },
      ]}
      rows={counts.map(({ key, count, filter }) => ({
        id: key,
        label: label(group, key),
        count: (
          <CountLink projectId={projectId} filter={filter}>
            {count}
          </CountLink>
        ),
      }))}
      emptyState={t("dashboard.noFlags")}
    />
  );
}

/** "Nach Welle": each wave with its next dates, and "Ohne Welle". */
function Waves({ projectId, counts }: { projectId: string; counts: Count[] }) {
  const { t } = useTranslation();
  const { data: waves } = useSuspenseQuery(entryWavesQuery(useApi(), projectId));
  return (
    <SimpleTable
      title={t("dashboard.groups.waves")}
      columns={[
        { key: "label", header: t("dashboard.columns.label") },
        { key: "signingDeadline", header: t("dashboard.columns.signingDeadline") },
        { key: "defaultTgStart", header: t("dashboard.columns.defaultTgStart") },
        { key: "latestEntryDate", header: t("dashboard.columns.latestEntryDate") },
        { key: "count", header: t("dashboard.columns.count") },
      ]}
      rows={counts.map(({ key, count, filter }) => {
        const wave = waves.find((w) => w.id === key);
        return {
          id: key,
          label: wave ? `${wave.code} – ${wave.name}` : t("dashboard.noWave"),
          signingDeadline: formatDate(wave?.signingDeadline),
          defaultTgStart: formatDate(wave?.defaultTgStart),
          latestEntryDate: formatDate(wave?.latestEntryDate),
          count: (
            <CountLink projectId={projectId} filter={filter}>
              {count}
            </CountLink>
          ),
        };
      })}
      emptyState=""
    />
  );
}

/** "Fristen": each kind with its upcoming and overdue counts. */
function Deadlines({ projectId, counts }: { projectId: string; counts: Count[] }) {
  const { t } = useTranslation();
  const kinds = [...new Set(counts.map((c) => c.filter.deadlineKind!))];
  const cell = (kind: string, state: "upcoming" | "overdue") => {
    const found = counts.find((c) => c.key === `${kind}:${state}`)!;
    return (
      <CountLink projectId={projectId} filter={found.filter}>
        {found.count}
      </CountLink>
    );
  };
  return (
    <SimpleTable
      title={t("dashboard.groups.deadlines")}
      columns={[
        { key: "kind", header: t("dashboard.columns.kind") },
        { key: "upcoming", header: t("dashboard.columns.upcoming") },
        { key: "overdue", header: t("dashboard.columns.overdue") },
      ]}
      rows={kinds.map((kind) => ({
        id: kind,
        kind: t(`worklist.deadlineKinds.${kind}`),
        upcoming: cell(kind, "upcoming"),
        overdue: cell(kind, "overdue"),
      }))}
      emptyState=""
    />
  );
}
