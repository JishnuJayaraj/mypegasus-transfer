import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createLink } from "@tanstack/react-router";
import { ApiProblemError, type components } from "@transfer/api-client";
import type { WorklistFilter } from "@transfer/domain";
import {
  Button,
  Card,
  ChevronDown,
  ChevronUp,
  CountTile,
  EmptyState,
  formatDate,
  Grid,
  Link,
  Section,
  Stack,
  TilesSkeleton,
  useMediaQuery,
  type StatusTone,
} from "@transfer/ui";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { dashboardQuery, entryWavesQuery, useApi } from "../api";
import { useViewerRoles } from "./viewer-roles";
import { useCountLabel, type LabelledGroup } from "./worklist-labels";
import { tileLabelKey } from "./worklist-views";

const RouterLink = createLink(Link);

type Count = components["schemas"]["DashboardCount"];
type Counts = components["schemas"]["ProjectDashboard"]["counts"];

/** "Alle Kennzahlen" is open by default from the preferred layout's width (D10: 1280px). */
const PREFERRED_QUERY = "(min-width: 80rem)";

/** The search of a count's link: the work list with the same filter. */
const listSearch = (filter: WorklistFilter) => ({ ...filter, tab: "participants" as const });

/** A count as a link to "Teilnehmende" with the same filter (data-protection.md, the dashboard). */
function CountLink({
  projectId,
  filter,
  className,
  children,
}: {
  projectId: string;
  filter: WorklistFilter;
  className?: string;
  children: ReactNode;
}) {
  return (
    <RouterLink
      to="/projects/$projectId"
      params={{ projectId }}
      search={listSearch(filter)}
      className={className}
    >
      {children}
    </RouterLink>
  );
}

/**
 * The featured "Heute zu tun" tiles (the plan of Slice 6b, 6b-4): the three views everyone works
 * from, and "Termine zu klären" for the PL (the only resolver, data-protection.md, appointments),
 * else "Hinweise". Each tile's label is its quick view's (worklist-views.ts), so they can't drift.
 */
export function featuredTiles(projectLead: boolean): { key: string; tone: StatusTone }[] {
  return [
    { key: "deadline_overdue", tone: "danger" },
    { key: "deadline_upcoming", tone: "warning" },
    { key: "open_actions", tone: "warning" },
    projectLead
      ? { key: "appointments_to_resolve", tone: "warning" }
      : { key: "flags", tone: "warning" },
  ];
}

/**
 * "Übersicht" (Slice 5, the PL dashboard; ui-patterns.md, dashboard) in three layers: "Heute zu
 * tun" (the featured tiles, then every other open-work count), "Verlauf" (the lifecycle funnel as
 * bars) and "Alle Kennzahlen" (every other group, collapsed below the preferred width). The
 * counts are exact counts of distinct participations in the viewer's scope; every number opens the
 * work list with its filter, so the list shows exactly the counted rows. The bars' widths go
 * through React's style prop (the CSSOM), which the CSP allows (app.ts); no chart library.
 */
export function ProjectDashboard({ projectId, taTg }: { projectId: string; taTg: boolean }) {
  const { t } = useTranslation();
  const query = useQuery(dashboardQuery(useApi(), projectId));
  if (query.error instanceof ApiProblemError && query.error.status === 403) {
    return (
      <EmptyState
        variant="forbidden"
        title={t("dashboard.forbidden")}
        description={t("dashboard.forbiddenWho")}
      />
    );
  }
  if (query.error instanceof ApiProblemError && query.error.status === 422) {
    return <EmptyState variant="error" title={t("worklist.tooLarge")} />;
  }
  if (query.isError) {
    return (
      <EmptyState
        variant="error"
        title={t("dashboard.failed")}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return <TilesSkeleton label={t("dashboard.loading")} />;
  const { counts, scope } = query.data;
  return (
    <Stack gap={7}>
      {scope === "assigned" && <p>{t("dashboard.scopeAssigned")}</p>}
      <Today projectId={projectId} tiles={counts.tiles} />
      <Progress projectId={projectId} counts={counts} taTg={taTg} />
      <AllFigures projectId={projectId} counts={counts} taTg={taTg} />
    </Stack>
  );
}

/** Layer 1: "Heute zu tun". */
function Today({ projectId, tiles }: { projectId: string; tiles: Count[] }) {
  const { t } = useTranslation();
  const { projectLead } = useViewerRoles(projectId);
  const featured = featuredTiles(projectLead);
  const byKey = new Map(tiles.map((tile) => [tile.key, tile]));
  const shown = featured.flatMap(({ key, tone }) => {
    const tile = byKey.get(key);
    return tile ? [{ ...tile, tone }] : [];
  });
  // Every other open-work count stays one click away; "Teilnehmende" is the funnel's total.
  const others = tiles.filter(
    (tile) => tile.key !== "participations" && !featured.some(({ key }) => key === tile.key),
  );
  const nothing = shown.every((tile) => tile.count === 0);
  const moreId = useId();
  return (
    <Section title={t("dashboard.today")}>
      <Stack gap={5}>
        <ul className="tp-count-tiles">
          {shown.map(({ key, count, filter, tone }) => (
            <li key={key}>
              <CountTile
                count={count}
                label={t(tileLabelKey(key))}
                tone={tone}
                renderLink={({ className, children }) => (
                  <CountLink projectId={projectId} filter={filter} className={className}>
                    {children}
                  </CountLink>
                )}
              />
            </li>
          ))}
        </ul>
        {/* Never "Alles erledigt": these views don't count every kind of open work (a BA
            reporting task, Agentur items, flags), so a true all-clear isn't offered. */}
        {nothing && <p>{t("dashboard.nothingInViews")}</p>}
        <section aria-labelledby={moreId}>
          <h3 id={moreId}>{t("dashboard.moreWork")}</h3>
          <ul className="tp-count-links">
            {others.map(({ key, count, filter }) => (
              <li key={key}>
                <CountLink projectId={projectId} filter={filter}>
                  {count} {t(tileLabelKey(key))}
                </CountLink>
              </li>
            ))}
          </ul>
        </section>
      </Stack>
    </Section>
  );
}

/** Layer 2: "Verlauf", the main status and (ta_tg) the DSV track as bars of the total. */
function Progress({
  projectId,
  counts,
  taTg,
}: {
  projectId: string;
  counts: Counts;
  taTg: boolean;
}) {
  const { t } = useTranslation();
  const total = counts.tiles.find((tile) => tile.key === "participations");
  return (
    <Section
      title={t("dashboard.progress")}
      description={
        total && (
          <CountLink projectId={projectId} filter={total.filter}>
            {total.count} {t(tileLabelKey(total.key))}
          </CountLink>
        )
      }
    >
      <Grid columns={2}>
        <Card title={t("dashboard.groups.statuses")} level={3}>
          <CountTable
            projectId={projectId}
            group="statuses"
            counts={counts.statuses}
            total={total?.count}
          />
        </Card>
        {taTg && (
          <Card title={t("dashboard.groups.dsvStatuses")} level={3}>
            <CountTable
              projectId={projectId}
              group="dsvStatuses"
              counts={counts.dsvStatuses}
              total={total?.count}
            />
          </Card>
        )}
      </Grid>
    </Section>
  );
}

/** Layer 3: "Alle Kennzahlen", open from 1280px, collapsed below (the viewer can toggle it). */
function AllFigures({
  projectId,
  counts,
  taTg,
}: {
  projectId: string;
  counts: Counts;
  taTg: boolean;
}) {
  const { t } = useTranslation();
  const preferred = useMediaQuery(PREFERRED_QUERY);
  // The viewer's own choice wins over the width, in component state only.
  const [chosen, setChosen] = useState<boolean>();
  const open = chosen ?? preferred;
  const bodyId = useId();
  const group = (key: LabelledGroup, values: Count[]) => (
    <Card key={key} title={t(`dashboard.groups.${key}`)} level={3}>
      <CountTable projectId={projectId} group={key} counts={values} />
    </Card>
  );
  return (
    <Section
      title={t("dashboard.all")}
      actions={
        <Button
          kind="ghost"
          size="sm"
          renderIcon={open ? ChevronUp : ChevronDown}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setChosen(!open)}
        >
          {open ? t("dashboard.hideAll") : t("dashboard.showAll")}
        </Button>
      }
    >
      <div id={bodyId} hidden={!open}>
        {open && (
          <Grid columns={3}>
            {group("profilingStatuses", counts.profilingStatuses)}
            {taTg && (
              <Card title={t("dashboard.groups.waves")} level={3}>
                <Waves projectId={projectId} counts={counts.waves} />
              </Card>
            )}
            <Card title={t("dashboard.groups.deadlines")} level={3}>
              <Deadlines projectId={projectId} counts={counts.deadlines} />
            </Card>
            {group("flags", counts.flags)}
            {group("appointments", counts.appointments)}
            {group("agentur", counts.agentur)}
            {group("activation", counts.activation)}
            {group("notice", counts.notice)}
            {group("portal", counts.portal)}
          </Grid>
        )}
      </div>
    </Section>
  );
}

/** A compact table of counts, named by its group; with `total`, each row also has its bar. */
function CountTable({
  projectId,
  group,
  counts,
  total,
}: {
  projectId: string;
  group: LabelledGroup;
  counts: Count[];
  total?: number;
}) {
  const { t } = useTranslation();
  const label = useCountLabel();
  if (counts.length === 0) return <p>{t("dashboard.noFlags")}</p>;
  return (
    <table className="tp-count-table" aria-label={t(`dashboard.groups.${group}`)}>
      <thead>
        <tr>
          <th scope="col">{t("dashboard.columns.label")}</th>
          <th scope="col" className="tp-count-table-number">
            {t("dashboard.columns.count")}
          </th>
        </tr>
      </thead>
      <tbody>
        {counts.map(({ key, count, filter }) => (
          <tr key={key}>
            <td>
              {label(group, key)}
              {total !== undefined && <Bar count={count} total={total} />}
            </td>
            <td className="tp-count-table-number">
              <CountLink projectId={projectId} filter={filter}>
                {count}
              </CountLink>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A bar of `count` out of `total`; decorative, since the number beside it is the text. */
function Bar({ count, total }: { count: number; total: number }) {
  const share = total > 0 ? Math.min(100, (count / total) * 100) : 0;
  return (
    <span className="tp-bar" aria-hidden="true">
      <span className="tp-bar-fill" style={{ inlineSize: `${share}%` }} />
    </span>
  );
}

/** "Nach Welle": each wave with its next dates, and "Ohne Welle". */
function Waves({ projectId, counts }: { projectId: string; counts: Count[] }) {
  const { t } = useTranslation();
  const { data: waves } = useSuspenseQuery(entryWavesQuery(useApi(), projectId));
  return (
    <table className="tp-count-table" aria-label={t("dashboard.groups.waves")}>
      <thead>
        <tr>
          <th scope="col">{t("dashboard.columns.label")}</th>
          <th scope="col" className="tp-count-table-number">
            {t("dashboard.columns.count")}
          </th>
        </tr>
      </thead>
      <tbody>
        {counts.map(({ key, count, filter }) => {
          const wave = waves.find((w) => w.id === key);
          return (
            <tr key={key}>
              <td>
                {wave ? `${wave.code} – ${wave.name}` : t("dashboard.noWave")}
                {wave && (
                  <span className="tp-count-table-detail">
                    {t("dashboard.waveDates", {
                      signingDeadline: formatDate(wave.signingDeadline),
                      defaultTgStart: formatDate(wave.defaultTgStart),
                      latestEntryDate: formatDate(wave.latestEntryDate),
                    })}
                  </span>
                )}
              </td>
              <td className="tp-count-table-number">
                <CountLink projectId={projectId} filter={filter}>
                  {count}
                </CountLink>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** "Fristen": each kind with its upcoming and overdue counts. */
function Deadlines({ projectId, counts }: { projectId: string; counts: Count[] }) {
  const { t } = useTranslation();
  const kinds = [...new Set(counts.map((c) => c.filter.deadlineKind!))];
  const cell = (kind: string, state: "upcoming" | "overdue") => {
    const found = counts.find((c) => c.key === `${kind}:${state}`)!;
    return (
      <td className="tp-count-table-number">
        <CountLink projectId={projectId} filter={found.filter}>
          {found.count}
        </CountLink>
      </td>
    );
  };
  return (
    <table className="tp-count-table" aria-label={t("dashboard.groups.deadlines")}>
      <thead>
        <tr>
          <th scope="col">{t("dashboard.columns.kind")}</th>
          <th scope="col" className="tp-count-table-number">
            {t("dashboard.columns.upcoming")}
          </th>
          <th scope="col" className="tp-count-table-number">
            {t("dashboard.columns.overdue")}
          </th>
        </tr>
      </thead>
      <tbody>
        {kinds.map((kind) => (
          <tr key={kind}>
            <td>{t(`worklist.deadlineKinds.${kind}`)}</td>
            {cell(kind, "upcoming")}
            {cell(kind, "overdue")}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
