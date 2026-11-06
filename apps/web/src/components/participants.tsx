import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import { createLink, useNavigate } from "@tanstack/react-router";
import {
  berlinDate as appointmentDate,
  berlinTime as appointmentTime,
  matchesSearch,
  matchesWorklistFilter,
  mostUrgent,
  openSteps,
  searchKey,
  urgencyOrder,
  type OpenStep,
  type WorklistFilter,
} from "@transfer/domain";
import {
  Button,
  Checkbox,
  DataTable,
  EmptyState,
  Filter,
  formatDate,
  InlineNotification,
  Link,
  RelativeDate,
  Select,
  SelectItem,
  SidePanel,
  Stack,
  StatusTag,
  TableSkeleton,
  TableToolbarSearch,
  Tag,
  useToast,
  type BatchAction,
  type DataColumn,
  type RowAction,
  type TableSort,
} from "@transfer/ui";
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { entryWavesQuery, useApi, worklistQuery } from "../api";
import { ActivationPrintView, NoticePrintView } from "./activation-print-view";
import { BulkInvite } from "./invitations";
import { BulkKug200b } from "./kug200b-bulk";
import { usePanelNavigationGuard } from "./panel-guard";
import { BulkRemind } from "./reminders";
import { useSelfServiceLabel } from "./self-service-tab";
import { useConsultants } from "./team";
import { ActiveFilterTags, BulkWave, WorklistFilterFields } from "./worklist-tools";
import { codeFromSort, sortFromCode, useRemembered, worklistMemory } from "./worklist-state";
import { useViewerRoles } from "./viewer-roles";
import { quickViews, sameFilter } from "./worklist-views";

const RouterLink = createLink(Link);

/** Rows rendered at once; "Weitere anzeigen" adds as many. Filtering covers the whole snapshot. */
const pageSize = 25;

/**
 * The columns (the plan of Slice 6b, D7): six by default, seven in `ta_tg`; the others through the
 * column chooser, in memory only.
 */
const defaultHidden: ReadonlySet<string> = new Set([
  "agentur",
  "portal",
  "reminded",
  "activation",
  "notice",
  "appointment",
]);

type ListItem = components["schemas"]["WorklistItem"];
type CaseItemKind = Exclude<ListItem["caseItems"][number]["kind"], "knowledge_date_missing">;
type ActivationPrintItem = components["schemas"]["BatchActivationCodeResult"]["items"][number];
type PrivacyNoticePrintItem = components["schemas"]["PrivacyNoticeBatchResult"]["items"][number];
type PrintState =
  | { kind: "letter" | "sheet"; items: ActivationPrintItem[] }
  | { kind: "notice"; items: PrivacyNoticePrintItem[] };

/** The batch actions in their order (the plan of Slice 6b, D8). */
const batchKinds = ["assign", "wave", "remind", "invite", "kug200b", "activation"] as const;
type BatchKind = (typeof batchKinds)[number];
/** An open batch action: the rows selected when it was opened, and what opened it. */
type Batch = { kind: BatchKind; items: ListItem[]; trigger: HTMLElement | null };

const berlinTime = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  minute: "2-digit",
});
const berlinDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" });

/** Whether the viewer may apply a batch action to the row (its capabilities, as before). */
const rowMay: Record<BatchKind, (item: ListItem, mayAssign: boolean) => boolean> = {
  assign: (_, mayAssign) => mayAssign,
  wave: (item) => item.capabilities.assignEntryWave,
  // Allowed now, or skipped with a code (data-protection.md, reminders).
  remind: ({ capabilities: { remind } }) => remind.allowed || remind.code !== null,
  // "Zu Termin einladen" (data-protection.md, invitations): the PL and the assigned consultant.
  invite: (item) => item.capabilities.invite.allowed,
  // "Kug 200b erzeugen" (data-protection.md, generated forms): the PL of a ta_tg project.
  kug200b: (item) => item.capabilities.generateKug200b,
  activation: (item) =>
    item.capabilities.issueActivationCode || item.capabilities.providePrivacyNotice,
};

/**
 * "Teilnehmende", the work list (data-protection.md, the work list and the dashboard;
 * ui-patterns.md): the viewer's whole scope as one snapshot, ordered by the next step
 * (process-and-lifecycle.md, the work list's next step and default order) unless a column sort is
 * chosen, filtered by the route's code filters and quick views and searched by name in memory.
 * The search term, the column choice, the rows shown and the scroll position stay in this
 * module's memory for the way back from a participant (C6): never in a request, the URL, a query
 * key or browser storage. A 403 reads as "not allowed", never as an empty list.
 */
export function Participants({
  projectId,
  taTg,
  filter,
  sort,
  onChange,
}: {
  projectId: string;
  taTg: boolean;
  filter: WorklistFilter;
  /** The sort's code in the URL (`sort`), or none: the next step's order. */
  sort: string | undefined;
  onChange: (next: { filter: WorklistFilter; sort: string | undefined }) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const query = useQuery(worklistQuery(api, projectId));
  const { data: waves = noWaves } = useQuery({
    ...entryWavesQuery(api, projectId),
    enabled: taTg,
  });
  const { consultants, mayAssign } = useConsultants(projectId);
  const viewer = useViewerRoles(projectId);
  const [term, setTerm] = useRemembered(projectId, "term");
  const search = useDeferredValue(term);
  const filterKey = JSON.stringify(filter);
  // The selection belongs to one filter; another starts afresh. The search keeps it, so rows can
  // be chosen one search at a time.
  const [selection, setSelection] = useState({ key: filterKey, ids: new Set<string>() });
  const selected = selection.key === filterKey ? selection.ids : noSelection;
  const [print, setPrint] = useState<PrintState | null>(null);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [hiddenColumns, setHiddenColumns] = useRemembered(projectId, "hiddenColumns");
  const [shown, setShown] = useRemembered(projectId, "shown");
  const shownKey = `${filterKey}\u0000${search}\u0000${sort ?? ""}`;
  const limit = shown?.key === shownKey ? shown.limit : pageSize;
  const tableScroll = useRef<HTMLDivElement>(null);

  const snapshot = query.data;
  const items = useMemo(() => snapshot?.items ?? [], [snapshot]);
  // The default order once per snapshot; a filter or a search keeps it.
  const ordered = useMemo(() => urgencyOrder(items), [items]);
  const index = useMemo(
    () =>
      new Map(
        items.map((item) => [
          item.id,
          searchKey([item.personnelNumber, item.lastName, item.firstName].join(" ")),
        ]),
      ),
    [items],
  );
  const matches = useMemo(
    () =>
      ordered.filter(
        (item) => matchesWorklistFilter(item, filter) && matchesSearch(index.get(item.id)!, search),
      ),
    [ordered, filter, index, search],
  );
  const views = useMemo(() => quickViews(viewer), [viewer]);
  // Each quick view's count over the whole snapshot, as its dashboard tile counts.
  const viewCounts = useMemo(
    () =>
      new Map(
        views.map((view) => [
          view.key,
          items.filter((item) => matchesWorklistFilter(item, view.filter)).length,
        ]),
      ),
    [views, items],
  );

  const setSelected = useCallback(
    (ids: Set<string>) => setSelection({ key: filterKey, ids }),
    [filterKey],
  );
  const today = snapshot ? berlinDate.format(new Date(snapshot.generatedAt)) : "";
  const waveCode = useMemo(() => new Map(waves.map((wave) => [wave.id, wave.code])), [waves]);
  const may = useMemo(
    () =>
      Object.fromEntries(
        batchKinds.map((kind) => [
          kind,
          (kind !== "wave" || taTg) && items.some((item) => rowMay[kind](item, mayAssign)),
        ]),
      ) as Record<BatchKind, boolean>,
    [items, mayAssign, taTg],
  );
  const rank = useMemo(() => new Map(ordered.map((item, i) => [item.id, i])), [ordered]);
  const columns = useWorklistColumns({ projectId, taTg, today, waveCode, rank });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: worklistQuery(api, projectId).queryKey });
  const loading = snapshot === undefined;
  const problem = query.error instanceof ApiProblemError ? query.error.status : null;
  const filtered = Object.keys(filter).length > 0 || search.trim() !== "";
  // The route's callback, read when called: a keystroke must not rebuild the table.
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => {
    onChangeRef.current = onChange;
  });
  const changeFilter = useCallback(
    (next: WorklistFilter) => onChangeRef.current({ filter: next, sort }),
    [sort],
  );
  // A reset clears the search field too (it keeps its own text while typing).
  const [searchKeyCount, setSearchKeyCount] = useState(0);
  const activeFilters = Object.keys(filter).length;

  // C6: the scroll position for the way back, in memory; restored once the rows are there.
  useScrollMemory(projectId, shownKey, !loading, tableScroll);

  // The table changes with its rows, never with a keystroke alone (architecture/overview.md,
  // performance approach): the search field is uncontrolled and the element memoized.
  const table = useMemo(() => {
    if (!snapshot) return null;
    const batchLabel = (kind: BatchKind) => t(`worklist.batch.${kind}`);
    const open = (kind: BatchKind, rows: ListItem[], trigger: HTMLElement | null) =>
      setBatch({ kind, items: rows, trigger });
    const participantLink = (id: string) =>
      ({
        to: "/projects/$projectId/participations/$participationId",
        params: { projectId, participationId: id },
      }) as const;
    const batchActions: BatchAction[] = batchKinds
      .filter((kind) => may[kind])
      .map((kind) => ({
        label: batchLabel(kind),
        onClick: (trigger) =>
          open(
            kind,
            items.filter((item) => selected.has(item.id)),
            trigger,
          ),
      }));
    const selectable = batchActions.length > 0;
    const rowActions = (item: ListItem): RowAction[] => [
      { label: t("worklist.rowOpen"), onClick: () => void navigate(participantLink(item.id)) },
      ...batchKinds
        .filter((kind) => may[kind] && rowMay[kind](item, mayAssign))
        .map((kind) => ({
          label: batchLabel(kind),
          onClick: (trigger: HTMLElement | null) => open(kind, [item], trigger),
        })),
    ];
    return (
      <DataTable
        title={t("participants.title")}
        items={matches}
        columns={columns}
        rowLabel={(item) => item.personnelNumber ?? fullName(item) ?? t("participants.open")}
        sort={sortFromCode(sort)}
        onSortChange={(next: TableSort) =>
          onChangeRef.current({ filter, sort: codeFromSort(next) })
        }
        selection={selectable ? { selected, onChange: setSelected, batchActions } : undefined}
        rowActions={rowActions}
        columnChooser
        hiddenColumns={hiddenColumns ?? defaultHidden}
        onHiddenColumnsChange={setHiddenColumns}
        pageSize={pageSize}
        limit={limit}
        onLimitChange={(next) => setShown({ key: shownKey, limit: next })}
        onRowClick={(item) => void navigate(participantLink(item.id))}
        scrollRef={tableScroll}
        toolbar={
          <>
            <p className="tp-worklist-count" aria-live="polite">
              {[
                ...(filtered ? [t("worklist.matches", { count: matches.length })] : []),
                viewer.assignedOnly
                  ? t("worklist.assignedTotal", { count: items.length })
                  : t("worklist.total", { count: items.length }),
                t("worklist.asOf", { time: berlinTime.format(new Date(snapshot.generatedAt)) }),
              ].join(" · ")}
            </p>
            <TableToolbarSearch
              key={searchKeyCount}
              id="worklist-search"
              persistent
              labelText={t("worklist.search")}
              placeholder={t("worklist.search")}
              autoComplete="off"
              spellCheck={false}
              defaultValue={worklistMemory(projectId).term}
              onChange={(_: unknown, value?: string) => setTerm(value ?? "")}
            />
            <Button
              kind="ghost"
              renderIcon={Filter}
              aria-haspopup="dialog"
              onClick={() => setFiltersOpen(true)}
            >
              {activeFilters > 0
                ? t("worklist.filters.titleActive", { count: activeFilters })
                : t("worklist.filters.title")}
            </Button>
          </>
        }
        emptyState={
          items.length === 0 ? (
            <EmptyState
              variant="noData"
              title={t("participants.emptyTitle")}
              description={t("participants.empty")}
            />
          ) : (
            <EmptyState
              variant="noMatches"
              title={t("worklist.noMatches")}
              onResetFilters={() => {
                setTerm("");
                setSearchKeyCount((n) => n + 1);
                changeFilter({});
              }}
            />
          )
        }
      />
    );
  }, [
    snapshot,
    t,
    may,
    items,
    selected,
    mayAssign,
    navigate,
    projectId,
    matches,
    columns,
    sort,
    filter,
    setSelected,
    hiddenColumns,
    setHiddenColumns,
    limit,
    setShown,
    shownKey,
    filtered,
    viewer.assignedOnly,
    searchKeyCount,
    setTerm,
    activeFilters,
    changeFilter,
  ]);

  if (print) {
    return print.kind === "notice" ? (
      <NoticePrintView items={print.items} onClose={() => setPrint(null)} />
    ) : (
      <ActivationPrintView
        kind={print.kind}
        items={print.items}
        onClose={() => setPrint(null)}
        itemActions={
          print.kind === "sheet"
            ? print.items.map((item) => (
                <SheetHandover
                  key={item.activationCodeId}
                  item={item}
                  projectId={projectId}
                  onChanged={() => void refresh()}
                />
              ))
            : undefined
        }
        footerActions={
          print.kind === "sheet" ? (
            <RevokeUnhandedSheets
              items={print.items}
              onDone={() => {
                setPrint(null);
                void refresh();
              }}
            />
          ) : undefined
        }
      />
    );
  }
  const filterProps = { filter, onChange: changeFilter, taTg, waves, consultants };
  return (
    // The panel is named by its tab; no heading repeats it (ui-patterns.md, principle 6).
    <section aria-label={t("participants.title")} className="tp-worklist">
      {problem === 403 ? (
        <EmptyState
          variant="forbidden"
          title={t("participants.forbidden")}
          description={t("participants.forbiddenWho")}
        />
      ) : problem === 422 ? (
        <EmptyState variant="error" title={t("worklist.tooLarge")} />
      ) : query.isError ? (
        <EmptyState
          variant="error"
          title={t("participants.failed")}
          onRetry={() => void query.refetch()}
        />
      ) : (
        <Stack gap={5}>
          <QuickViews
            views={views}
            counts={loading ? null : viewCounts}
            filter={filter}
            onChoose={changeFilter}
          />
          <ActiveFilterTags {...filterProps} />
          {loading ? (
            <TableSkeleton
              label={t("worklist.loading")}
              headers={columns
                .filter((column) => !defaultHidden.has(column.key))
                .map((column) => column.header)}
            />
          ) : (
            table
          )}
        </Stack>
      )}
      <SidePanel
        open={filtersOpen}
        title={t("worklist.filters.title")}
        onClose={() => setFiltersOpen(false)}
        footer={
          <>
            <Button
              kind="secondary"
              disabled={activeFilters === 0}
              onClick={() => changeFilter({})}
            >
              {t("worklist.filters.reset")}
            </Button>
            <Button kind="primary" onClick={() => setFiltersOpen(false)}>
              {t("worklist.filters.done", { count: matches.length })}
            </Button>
          </>
        }
      >
        <WorklistFilterFields {...filterProps} />
      </SidePanel>
      {batch && (
        <BatchPanel
          batch={batch}
          projectId={projectId}
          consultants={consultants}
          waves={waves}
          onClose={() => setBatch(null)}
          onApplied={() => setSelected(new Set())}
          onPrinted={(result) => {
            setBatch(null);
            setSelected(new Set());
            setPrint(result);
          }}
          onRefresh={() => void refresh()}
        />
      )}
    </section>
  );
}

const noWaves: components["schemas"]["EntryWave"][] = [];
const noSelection: ReadonlySet<string> = new Set();

const fullName = (item: ListItem) =>
  [item.lastName, item.firstName].filter(Boolean).join(", ") || undefined;

/**
 * The quick views above the table (the plan of Slice 6b, D6): each one filter; choosing one
 * replaces the filters. A view with no rows stays (its empty state explains it).
 */
const QuickViews = memo(function QuickViews({
  views,
  counts,
  filter,
  onChoose,
}: {
  views: ReturnType<typeof quickViews>;
  counts: ReadonlyMap<string, number> | null;
  filter: WorklistFilter;
  onChoose: (filter: WorklistFilter) => void;
}) {
  const { t } = useTranslation();
  return (
    <ul className="tp-quick-views" aria-label={t("worklist.views.label")}>
      {views.map((view) => {
        const active = sameFilter(filter, view.filter);
        const count = counts?.get(view.key);
        return (
          <li key={view.key}>
            <Button
              kind={active ? "primary" : "tertiary"}
              size="sm"
              aria-pressed={active}
              onClick={() => onChoose(view.filter)}
            >
              {count === undefined
                ? t(`worklist.views.${view.key}`)
                : t("worklist.views.withCount", {
                    view: t(`worklist.views.${view.key}`),
                    count,
                  })}
            </Button>
          </li>
        );
      })}
    </ul>
  );
});

/**
 * Remembers where the page and the table were scrolled for this list (`key`: its filter, search
 * and sort), in memory, and goes back there once the rows are rendered (ui-patterns.md, C6).
 */
function useScrollMemory(
  projectId: string,
  key: string,
  ready: boolean,
  table: React.RefObject<HTMLDivElement | null>,
) {
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (!ready || restored.current) return;
    restored.current = true;
    const saved = worklistMemory(projectId).scroll;
    if (!saved || saved.key !== key) return;
    const restore = () => {
      window.scrollTo({ top: saved.page });
      table.current?.scrollTo({ top: saved.table });
    };
    restore();
    // The router resets the page's scroll after rendering a new location: once more after it.
    const frame = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(frame);
  }, [ready, key, projectId, table]);
  useEffect(() => {
    if (!ready) return;
    const element = table.current;
    const save = () => {
      worklistMemory(projectId).scroll = {
        key,
        page: window.scrollY,
        table: table.current?.scrollTop ?? 0,
      };
    };
    window.addEventListener("scroll", save, { passive: true });
    element?.addEventListener("scroll", save, { passive: true });
    return () => {
      window.removeEventListener("scroll", save);
      element?.removeEventListener("scroll", save);
    };
  }, [ready, key, projectId, table]);
}

/** The columns of the work list (the plan of Slice 6b, D7). */
function useWorklistColumns({
  projectId,
  taTg,
  today,
  waveCode,
  rank,
}: {
  projectId: string;
  taTg: boolean;
  today: string;
  waveCode: ReadonlyMap<string, string>;
  /** Each row's place in the default order. */
  rank: ReadonlyMap<string, number>;
}): DataColumn<ListItem>[] {
  const { t } = useTranslation();
  return useMemo(() => {
    const activationText = (item: ListItem): string =>
      item.activationStatus.account === "activated"
        ? t("activation.status.activated")
        : t(`activation.code.${item.activationStatus.code}`);
    const columns: (DataColumn<ListItem> | false)[] = [
      {
        key: "name",
        header: t("participants.columns.participant"),
        alwaysVisible: true,
        // Last name, then first name; the Personalnummer when no name may be listed.
        sortValue: (item) => fullName(item) ?? item.personnelNumber,
        render: (item) => (
          <div className="tp-two-lines">
            {/* The URL carries only the id, never a person's value (ADR-0010, pagination). */}
            <RouterLink
              to="/projects/$projectId/participations/$participationId"
              params={{ projectId, participationId: item.id }}
            >
              {fullName(item) ?? item.personnelNumber ?? t("participants.open")}
            </RouterLink>
            {fullName(item) && item.personnelNumber && (
              <span className="tp-secondary-line">{item.personnelNumber}</span>
            )}
          </div>
        ),
      },
      {
        key: "status",
        header: t("participants.columns.status"),
        sortValue: (item) => t(`participants.statuses.${item.status}`),
        // The three tracks run in parallel: three separate tags (ui-patterns.md, C3).
        render: (item) => (
          <div className="tp-status-tags">
            <StatusTag family="main" code={item.status} />
            <StatusTag family="profiling" code={item.profilingStatus} />
            {taTg && <StatusTag family="dsv" code={item.dsvStatus} />}
          </div>
        ),
      },
      {
        key: "nextStep",
        header: t("participants.columns.nextStep"),
        // The default order's rank: ascending is the default order, descending its reverse.
        sortValue: (item) => rank.get(item.id),
        render: (item) => <NextStep item={item} today={today} />,
      },
      {
        key: "deadline",
        header: t("participants.columns.deadline"),
        // Overdue (the older date) first, then the nearest upcoming one.
        sortValue: (item) => mostUrgent(item.deadlines)?.date,
        render: (item) => <DeadlineCell item={item} today={today} />,
      },
      {
        key: "consultants",
        header: t("participants.columns.consultants"),
        sortValue: (item) => item.consultants.map((c) => c.displayName).join(", "),
        render: (item) => item.consultants.map((c) => c.displayName).join(", "),
      },
      taTg && {
        key: "wave",
        header: t("participants.columns.wave"),
        sortValue: (item) => (item.entryWaveId ? waveCode.get(item.entryWaveId) : undefined),
        render: (item) => (item.entryWaveId ? (waveCode.get(item.entryWaveId) ?? "") : ""),
      },
      {
        key: "agentur",
        header: t("participants.columns.agentur"),
        hiddenByDefault: true,
        sortValue: (item) => item.placementAgenturKey,
        render: (item) => <AgenturCell item={item} />,
      },
      {
        key: "portal",
        header: t("participants.columns.portal"),
        hiddenByDefault: true,
        sortValue: (item) => t(`worklist.portal.${item.portal}`),
        render: (item) => t(`worklist.portal.${item.portal}`),
      },
      {
        key: "reminded",
        header: t("participants.columns.reminded"),
        hiddenByDefault: true,
        sortValue: (item) => item.reminder?.lastRequestedOn,
        render: (item) =>
          item.reminder
            ? `${formatDate(item.reminder.lastRequestedOn)} (${t(`reminders.status.${item.reminder.status}`)})`
            : "",
      },
      {
        key: "activation",
        header: t("participants.columns.activationStatus"),
        hiddenByDefault: true,
        sortValue: activationText,
        render: activationText,
      },
      {
        key: "notice",
        header: t("participants.columns.privacyNoticeState"),
        hiddenByDefault: true,
        sortValue: (item) => item.privacyNoticeState.state,
        render: (item) =>
          t(`activation.notice.${item.privacyNoticeState.state}`, {
            dueOn: formatDate(item.privacyNoticeState.dueOn),
          }),
      },
      {
        key: "appointment",
        header: t("participants.columns.appointment"),
        hiddenByDefault: true,
        sortValue: (item) =>
          item.appointments.items[0]?.startsAt ?? item.appointments.next?.startsAt,
        render: (item) => <AppointmentCell item={item} />,
      },
    ];
    return columns.filter((column): column is DataColumn<ListItem> => column !== false);
  }, [t, projectId, taTg, waveCode, today, rank]);
}

/** One open item as the column "Nächster Schritt" names it; tiers 1 and 3 with their date. */
function StepLabel({ step, today }: { step: OpenStep; today: string }) {
  const { t } = useTranslation();
  const label = useSelfServiceLabel();
  switch (step.source) {
    case "deadline":
      // The kind, then relative and absolute date (ui-patterns.md, principle 5).
      return (
        <>
          {`${t(`worklist.deadlineKinds.${step.kind}`)}: `}
          <RelativeDate date={step.date} today={today} kind="deadline" />
          {step.final && ` (${t("worklist.deadlineFinal")})`}
        </>
      );
    case "appointment":
      return (
        <>
          {`${t(`worklist.appointmentItems.${step.kind}`)}: ${t(`appointments.kinds.${step.appointmentKind}`)}, `}
          <RelativeDate date={step.date} today={today} kind="event" />
        </>
      );
    case "case":
      // Without a dated deadline the ASU orientation, never as overdue (process-and-lifecycle.md, dates).
      return step.kind === "knowledge_date_missing"
        ? t("worklist.knowledgeDateMissing", { date: formatDate(step.date) })
        : t(`worklist.caseItems.${step.kind as CaseItemKind}`, { date: formatDate(step.date) });
    case "agentur":
      return t(`worklist.agenturItems.${step.kind}`, { date: formatDate(step.date) });
    case "flag":
      return t(`worklist.flags.${step.kind}`);
    case "action":
      return `${label(step.action.key)} ${t(`worklist.actionStates.${step.action.state}`)}`;
  }
}

const stepKey = (step: OpenStep, i: number) => `${step.source}-${step.kind}-${i}`;

/**
 * "Nächster Schritt" (process-and-lifecycle.md, the work list's next step): the first open item,
 * its tier as a tag's tone, and "+n weitere", which lists the others in the same order.
 */
function NextStep({ item, today }: { item: ListItem; today: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const steps = useMemo(() => openSteps(item), [item]);
  const [first, ...rest] = steps;
  if (!first) return <span aria-label={t("worklist.nothingOpen")}>{"–"}</span>;
  const listId = `next-steps-${item.id}`;
  return (
    <div className="tp-next-step">
      <span>
        {first.tier === 1 && (
          <>
            <Tag type="red" size="sm">
              {t("worklist.overdueTag")}
            </Tag>{" "}
          </>
        )}
        <StepLabel step={first} today={today} />
      </span>
      {rest.length > 0 && (
        <>
          <Button
            kind="ghost"
            size="sm"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded(!expanded)}
          >
            {t("worklist.moreSteps", { count: rest.length })}
          </Button>
          {expanded && (
            <ul id={listId} className="tp-list">
              {rest.map((step, i) => (
                <li key={stepKey(step, i)}>
                  <StepLabel step={step} today={today} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** "Frist": the most urgent deadline, else the ASU orientation (process-and-lifecycle.md, dates). */
function DeadlineCell({ item, today }: { item: ListItem; today: string }) {
  const { t } = useTranslation();
  const urgent = mostUrgent(item.deadlines);
  if (!urgent) {
    const orientation = item.caseItems.find((case_) => case_.kind === "knowledge_date_missing");
    return orientation
      ? t("worklist.knowledgeDateMissing", { date: formatDate(orientation.date) })
      : "";
  }
  return (
    <>
      {`${t(`worklist.deadlineKinds.${urgent.kind}`)}: `}
      <RelativeDate date={urgent.date} today={today} kind="deadline" />
      {urgent.final && ` (${t("worklist.deadlineFinal")})`}
    </>
  );
}

/**
 * "Termin" (process-and-lifecycle.md, appointment items): the most urgent item, else the next
 * booking.
 */
function AppointmentCell({ item }: { item: ListItem }) {
  const { t } = useTranslation();
  const {
    appointments: { next, items: open },
  } = item;
  const [first] = open;
  if (!first) {
    return next
      ? t("worklist.appointmentNext", {
          kind: t(`appointments.kinds.${next.kind}`),
          date: formatDate(appointmentDate(next.startsAt)),
          time: appointmentTime(next.startsAt),
        })
      : "";
  }
  const overdue = first.kind === "attendance_missing" || first.kind === "missed";
  return (
    <>
      <Tag type={overdue ? "red" : "purple"} size="sm">
        {t(`worklist.appointmentItems.${first.kind}`)}
      </Tag>{" "}
      {t("worklist.appointmentItem", {
        kind: t(`appointments.kinds.${first.appointmentKind}`),
        date: formatDate(appointmentDate(first.startsAt)),
      })}
      {open.length > 1 && ` ${t("worklist.appointmentMore", { count: open.length - 1 })}`}
    </>
  );
}

/**
 * "Agentur" (process-and-lifecycle.md, TL 407 submission): the placement Agentur and its most
 * urgent item; an escalation in red.
 */
function AgenturCell({ item: { placementAgenturKey, agenturItems } }: { item: ListItem }) {
  const { t } = useTranslation();
  const [first] = agenturItems;
  return (
    <>
      {placementAgenturKey ?? ""}
      {first && (
        <>
          {" "}
          <Tag type={first.kind === "tl407_escalated" ? "red" : "purple"} size="sm">
            {t(`worklist.agenturItems.${first.kind}`, { date: formatDate(first.date) })}
          </Tag>
          {agenturItems.length > 1 &&
            ` ${t("worklist.appointmentMore", { count: agenturItems.length - 1 })}`}
        </>
      )}
    </>
  );
}

/**
 * A batch action over the rows selected when it was opened (the plan of Slice 6b, D8): a side
 * panel with its choice, or the existing dialog with its preview and confirmation. Each says how
 * many of the selection it reaches (ui-patterns.md, C1).
 */
function BatchPanel({
  batch,
  projectId,
  consultants,
  waves,
  onClose,
  onApplied,
  onPrinted,
  onRefresh,
}: {
  batch: Batch;
  projectId: string;
  consultants: { staffUserId: string; displayName: string }[];
  waves: components["schemas"]["EntryWave"][];
  onClose: () => void;
  onApplied: () => void;
  onPrinted: (result: PrintState) => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const [dirty, setDirty] = useState(false);
  const pendingNavigation = usePanelNavigationGuard(dirty);
  const { kind, items } = batch;
  // The dialogs bring their own preview and confirmation (data-protection.md, reminders).
  if (kind === "remind") {
    return (
      <BulkRemind projectId={projectId} selected={items} onSent={onApplied} onClose={onClose} />
    );
  }
  if (kind === "invite") {
    return (
      <BulkInvite projectId={projectId} selected={items} onSent={onApplied} onClose={onClose} />
    );
  }
  const close = () => {
    setDirty(false);
    onClose();
  };
  return (
    <SidePanel
      open
      title={t(`worklist.batch.${kind}`)}
      label={t("worklist.selected", { count: items.length })}
      dirty={dirty}
      onClose={close}
      pendingNavigation={pendingNavigation}
      returnFocusTo={batch.trigger}
    >
      {kind === "assign" && (
        <BulkAssign
          projectId={projectId}
          consultants={consultants}
          selected={items.map((item) => item.id)}
          onAssigned={() => {
            onApplied();
            close();
          }}
          onDirtyChange={setDirty}
        />
      )}
      {kind === "wave" && (
        <BulkWave
          projectId={projectId}
          waves={waves}
          selected={items}
          onAssigned={() => {
            onApplied();
            close();
          }}
          onDirtyChange={setDirty}
        />
      )}
      {kind === "kug200b" && (
        <BulkKug200b
          projectId={projectId}
          selected={items}
          onGenerated={() => {
            onApplied();
            onRefresh();
          }}
        />
      )}
      {kind === "activation" && (
        <BulkActivation projectId={projectId} selected={items} onPrinted={onPrinted} />
      )}
    </SidePanel>
  );
}

/** "Berater zuweisen": the selected participations to one consultant of the project (Q62). */
function BulkAssign({
  projectId,
  consultants,
  selected,
  onAssigned,
  onDirtyChange,
}: {
  projectId: string;
  consultants: { staffUserId: string; displayName: string }[];
  selected: string[];
  onAssigned: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [staffUserId, setStaffUserId] = useState("");
  const [refused, setRefused] = useState(false);
  // A chosen person is input until assigned (ui-patterns.md, C4).
  useLayoutEffect(() => onDirtyChange(staffUserId !== ""), [staffUserId, onDirtyChange]);
  const assign = useMutation({
    mutationFn: async () => {
      const { data } = await api.POST("/api/v1/projects/{projectId}/assignments", {
        params: { path: { projectId } },
        body: { staffUserId, participationIds: selected },
      });
      return data!;
    },
    onSuccess: async ({ assigned }) => {
      setRefused(false);
      onAssigned();
      showToast({ title: t("participants.assigned", { count: assigned }) });
      await queryClient.invalidateQueries({ queryKey: worklistQuery(api, projectId).queryKey });
    },
    onError: () => setRefused(true),
  });
  return (
    <Stack gap={5}>
      {refused && (
        <InlineNotification
          kind="error"
          title={t("participants.assignFailed")}
          onClose={() => setRefused(false)}
        />
      )}
      <Select
        id="assign-consultant"
        labelText={t("participants.assignTo")}
        value={staffUserId}
        onChange={(event) => setStaffUserId(event.target.value)}
      >
        <SelectItem value="" text={t("participants.chooseConsultant")} />
        {consultants.map((c) => (
          <SelectItem key={c.staffUserId} value={c.staffUserId} text={c.displayName} />
        ))}
      </Select>
      <div>
        <Button
          disabled={!staffUserId || selected.length === 0 || assign.isPending}
          onClick={() => assign.mutate()}
        >
          {t("participants.assign", { count: selected.length })}
        </Button>
      </div>
    </Stack>
  );
}

/**
 * "Aktivierung drucken": letters, sheets or the privacy notice for the selection, all or nothing;
 * a reissue only with the explicit confirmation.
 */
function BulkActivation({
  projectId,
  selected,
  onPrinted,
}: {
  projectId: string;
  selected: ListItem[];
  onPrinted: (state: PrintState) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const [language, setLanguage] = useState<"de" | "en">("de");
  const [replace, setReplace] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const requiresReplacement = selected.some((item) =>
    ["printed", "open", "delivery_unknown"].includes(item.activationStatus.code),
  );
  const issuable = selected.filter((item) => item.capabilities.issueActivationCode).length;
  const noticeable = selected.filter((item) => item.capabilities.providePrivacyNotice).length;
  const mayIssue = selected.length > 0 && issuable === selected.length;
  const mayNotice = selected.length > 0 && noticeable === selected.length;
  const ids = selected.map(({ id }) => id);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: worklistQuery(api, projectId).queryKey });
  const run = async (request: () => Promise<PrintState | undefined>) => {
    setPending(true);
    setFailed(false);
    try {
      const result = await request();
      if (!result) throw new Error("No print data");
      await refresh();
      onPrinted(result);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  const issue = (kind: "letter" | "sheet") =>
    run(async () => {
      const { data } = await api.POST("/api/v1/projects/{projectId}/activation-codes", {
        params: { path: { projectId } },
        body: { participationIds: ids, channel: kind, language, replaceOpenCode: replace },
      });
      return data && { kind, items: data.items };
    });
  const notice = () =>
    run(async () => {
      const { data } = await api.POST("/api/v1/projects/{projectId}/privacy-notices", {
        params: { path: { projectId } },
        body: { participationIds: ids, language },
      });
      return data && { kind: "notice", items: data.items };
    });
  return (
    <Stack gap={5}>
      <p>{t("activation.bulk.title")}</p>
      {/* C1: an action for only part of the selection says for how many, not a bare disabled button. */}
      {!mayIssue && (
        <p>{t("activation.bulk.notAllIssuable", { count: issuable, total: selected.length })}</p>
      )}
      {failed && (
        <InlineNotification
          kind="error"
          title={t("activation.bulk.failed")}
          onClose={() => setFailed(false)}
        />
      )}
      <Select
        id="activation-language"
        labelText={t("activation.bulk.language")}
        value={language}
        onChange={(event) => setLanguage(event.target.value as "de" | "en")}
      >
        <SelectItem value="de" text="Deutsch" />
        <SelectItem value="en" text="English" />
      </Select>
      {requiresReplacement && (
        <Checkbox
          id="confirm-activation-reissue"
          labelText={t("activation.bulk.confirmReissue")}
          checked={replace}
          onChange={(_, { checked }) => setReplace(checked)}
        />
      )}
      <div className="tp-inline-actions">
        <Button
          kind="primary"
          disabled={!mayIssue || pending || (requiresReplacement && !replace)}
          onClick={() => void issue("letter")}
        >
          {t("activation.bulk.letters")}
        </Button>
        <Button
          kind="secondary"
          disabled={!mayIssue || pending || (requiresReplacement && !replace)}
          onClick={() => void issue("sheet")}
        >
          {t("activation.bulk.sheets")}
        </Button>
        <Button kind="secondary" disabled={!mayNotice || pending} onClick={() => void notice()}>
          {t("activation.bulk.notices")}
        </Button>
      </div>
      {!mayNotice && (
        <p>
          {t("activation.bulk.notAllNoticeable", { count: noticeable, total: selected.length })}
        </p>
      )}
    </Stack>
  );
}

export function SheetHandover({
  item,
  projectId,
  onChanged,
}: {
  item: ActivationPrintItem;
  projectId: string;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const [state, setState] = useState<"printed" | "handed" | "revoked" | "failed">("printed");
  const [pending, setPending] = useState(false);
  const perform = async (action: "handover" | "revocation") => {
    setPending(true);
    const response =
      action === "handover"
        ? await api.POST("/api/v1/participations/{participationId}/activation-codes/handover", {
            params: { path: { participationId: item.participationId } },
            body: { activationCodeId: item.activationCodeId },
          })
        : await api.POST("/api/v1/participations/{participationId}/activation-codes/revocation", {
            params: { path: { participationId: item.participationId } },
            body: { activationCodeId: item.activationCodeId, reason: "not_handed_over" },
          });
    setPending(false);
    if (!response.data) return setState("failed");
    setState(action === "handover" ? "handed" : "revoked");
    onChanged();
  };
  return (
    <div className="tp-print-controls" data-project-id={projectId}>
      {state === "printed" ? (
        <>
          <Button disabled={pending} onClick={() => void perform("handover")}>
            {t("activation.handover.confirm")}
          </Button>
          <Button
            kind="danger--tertiary"
            disabled={pending}
            onClick={() => void perform("revocation")}
          >
            {t("activation.handover.revoke")}
          </Button>
        </>
      ) : (
        <strong>{t(`activation.handover.${state}`)}</strong>
      )}
    </div>
  );
}

function RevokeUnhandedSheets({
  items,
  onDone,
}: {
  items: ActivationPrintItem[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const [pending, setPending] = useState(false);
  const revoke = async () => {
    setPending(true);
    await Promise.all(
      items.map((item) =>
        api.POST("/api/v1/participations/{participationId}/activation-codes/revocation", {
          params: { path: { participationId: item.participationId } },
          body: { activationCodeId: item.activationCodeId, reason: "not_handed_over" },
        }),
      ),
    );
    setPending(false);
    onDone();
  };
  return (
    <div className="tp-print-controls">
      <Button kind="danger" disabled={pending} onClick={() => void revoke()}>
        {t("activation.handover.revokeRemaining")}
      </Button>
    </div>
  );
}
