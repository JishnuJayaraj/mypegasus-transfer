import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import { createLink } from "@tanstack/react-router";
import {
  compareUrgency,
  daysBetween,
  matchesSearch,
  matchesWorklistFilter,
  mostUrgent,
  searchKey,
  type WorklistFilter,
} from "@transfer/domain";
import {
  Add,
  Button,
  Checkbox,
  formatDate,
  InlineNotification,
  Link,
  Select,
  SelectItem,
  SimpleTable,
  Tag,
  TextInput,
  useToast,
} from "@transfer/ui";
import { memo, useCallback, useDeferredValue, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { entryWavesQuery, projectConfigQuery, useApi, worklistQuery } from "../api";
import { ActivationPrintView, NoticePrintView } from "./activation-print-view";
import { ManualParticipationForm } from "./manual-participation-form";
import { useSelfServiceLabel } from "./self-service-tab";
import { useConsultants } from "./team";
import { BulkWave, WorklistFilters } from "./worklist-tools";

const RouterLink = createLink(Link);

const columns = [
  "select",
  "personnelNumber",
  "lastName",
  "firstName",
  "status",
  "profilingStatus",
  "dsvStatus",
  "wave",
  "consultants",
  "open",
  "deadline",
  "portal",
  "activationStatus",
  "privacyNoticeState",
] as const;

/** Rows rendered at once; "Weitere anzeigen" adds as many. Filtering covers the whole snapshot. */
const pageSize = 25;

type ListItem = components["schemas"]["WorklistItem"];
type ActivationPrintItem = components["schemas"]["BatchActivationCodeResult"]["items"][number];
type PrivacyNoticePrintItem = components["schemas"]["PrivacyNoticeBatchResult"]["items"][number];
type PrintState =
  | { kind: "letter" | "sheet"; items: ActivationPrintItem[] }
  | { kind: "notice"; items: PrivacyNoticePrintItem[] };

const berlinTime = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  minute: "2-digit",
});
const berlinDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" });

/**
 * "Teilnehmende", the work list (data-protection.md, the work list and the dashboard): the
 * viewer's whole scope as one snapshot, filtered by the route's code filters and searched by name
 * in memory. The search term stays in this component's state: never in a request, the URL, a
 * query key or browser storage. Until the snapshot is there nothing is searchable and no empty
 * state shows. A 403 reads as "not allowed", never as an empty list.
 */
export function Participants({
  projectId,
  taTg,
  filter,
  onFilterChange,
}: {
  projectId: string;
  taTg: boolean;
  filter: WorklistFilter;
  onFilterChange: (filter: WorklistFilter) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const query = useQuery(worklistQuery(api, projectId));
  // Manual creation is one import row (process-and-lifecycle.md, import and manual creation):
  // offered with the import's capability.
  const { data: config } = useSuspenseQuery(projectConfigQuery(api, projectId));
  const { data: waves = noWaves } = useQuery({
    ...entryWavesQuery(api, projectId),
    enabled: taTg,
  });
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const { consultants, mayAssign } = useConsultants(projectId);
  const [term, setTerm] = useState("");
  const search = useDeferredValue(term);
  const filterKey = JSON.stringify(filter);
  // The selection and the rows shown belong to one filter and search; another starts afresh.
  const [selection, setSelection] = useState({ key: filterKey, ids: new Set<string>() });
  const selected = selection.key === filterKey ? selection.ids : noSelection;
  const [shown, setShown] = useState({ key: "", count: pageSize });
  const shownKey = `${filterKey}\u0000${search}`;
  const limit = shown.key === shownKey ? shown.count : pageSize;
  const [print, setPrint] = useState<PrintState | null>(null);

  const snapshot = query.data;
  const items = useMemo(() => snapshot?.items ?? [], [snapshot]);
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
  const matches = useMemo(() => {
    const filtered = items.filter(
      (item) => matchesWorklistFilter(item, filter) && matchesSearch(index.get(item.id)!, search),
    );
    // A deadline filter shows the most urgent first (the dashboard's drill-down); a stable sort.
    if (filter.deadlineKind === undefined && filter.deadlineState === undefined) return filtered;
    return filtered.toSorted((a, b) =>
      compareUrgency(mostUrgent(a.deadlines)!, mostUrgent(b.deadlines)!),
    );
  }, [items, filter, index, search]);

  const setSelected = (ids: Set<string>) => setSelection({ key: filterKey, ids });
  // Stable, so a keystroke re-renders the table only once its matches change.
  const toggle = useCallback(
    (id: string, on: boolean) =>
      setSelection((current) => {
        const ids = new Set(current.key === filterKey ? current.ids : []);
        if (on) ids.add(id);
        else ids.delete(id);
        return { key: filterKey, ids };
      }),
    [filterKey],
  );
  const today = snapshot ? berlinDate.format(new Date(snapshot.generatedAt)) : "";
  const waveCode = useMemo(() => new Map(waves.map((wave) => [wave.id, wave.code])), [waves]);
  const shownItems = useMemo(() => matches.slice(0, limit), [matches, limit]);
  const selectedItems = items.filter((item) => selected.has(item.id));
  const mayActivate = items.some(
    (item) => item.capabilities.issueActivationCode || item.capabilities.providePrivacyNotice,
  );
  const mayAssignWave = taTg && items.some((item) => item.capabilities.assignEntryWave);
  const selectable = mayAssign || mayActivate || mayAssignWave;
  const visibleColumns = useMemo(
    () =>
      columns.filter(
        (key) =>
          (key !== "select" || selectable) && ((key !== "dsvStatus" && key !== "wave") || taTg),
      ),
    [selectable, taTg],
  );
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: worklistQuery(api, projectId).queryKey });
  const loading = snapshot === undefined;
  const problem = query.error instanceof ApiProblemError ? query.error.status : null;

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
  return (
    <section aria-labelledby="project-participants" className="tp-section">
      <h2 id="project-participants">{t("participants.title")}</h2>
      {created && (
        <>
          <InlineNotification
            kind="success"
            title={t("manual.created")}
            onClose={() => setCreated(null)}
          />
          <p>
            <RouterLink
              to="/projects/$projectId/participations/$participationId"
              params={{ projectId, participationId: created }}
            >
              {t("manual.openCreated")}
            </RouterLink>
          </p>
        </>
      )}
      {adding ? (
        <ManualParticipationForm
          projectId={projectId}
          onCancel={() => setAdding(false)}
          onCreated={async (detail) => {
            setAdding(false);
            setCreated(detail.id);
            showToast({ title: t("manual.created") });
            await Promise.all([
              refresh(),
              queryClient.invalidateQueries({ queryKey: entryWavesQuery(api, projectId).queryKey }),
            ]);
          }}
        />
      ) : (
        config.capabilities.importParticipations && (
          <Button
            className="tp-load-more"
            renderIcon={Add}
            onClick={() => {
              setCreated(null);
              setAdding(true);
            }}
          >
            {t("manual.add")}
          </Button>
        )
      )}
      {problem === 403 ? (
        <p role="alert">{t("participants.forbidden")}</p>
      ) : problem === 422 ? (
        <p role="alert">{t("worklist.tooLarge")}</p>
      ) : query.isError ? (
        <p role="alert">{t("participants.failed")}</p>
      ) : (
        <>
          <WorklistFilters
            filter={filter}
            onChange={onFilterChange}
            taTg={taTg}
            waves={waves}
            consultants={consultants}
          />
          <div className="tp-bulk-actions">
            <TextInput
              id="worklist-search"
              labelText={t("worklist.search")}
              helperText={t("worklist.searchHelper")}
              autoComplete="off"
              spellCheck={false}
              disabled={loading}
              value={term}
              onChange={(event) => setTerm(event.target.value)}
            />
          </div>
          {loading ? (
            <p aria-live="polite">{t("worklist.loading")}</p>
          ) : (
            <>
              <p aria-live="polite">
                {[
                  t("worklist.matches", { count: matches.length }),
                  t("worklist.asOf", { time: berlinTime.format(new Date(snapshot.generatedAt)) }),
                  ...(selected.size > 0 ? [t("worklist.selected", { count: selected.size })] : []),
                ].join(" · ")}
              </p>
              {visibleColumns.includes("select") && (
                <div className="tp-bulk-actions">
                  <Button
                    kind="tertiary"
                    size="sm"
                    disabled={query.isFetching || matches.length === 0}
                    onClick={() => setSelected(new Set(matches.map((item) => item.id)))}
                  >
                    {t("worklist.selectAll")}
                  </Button>
                  <Button
                    kind="ghost"
                    size="sm"
                    disabled={selected.size === 0}
                    onClick={() => setSelected(new Set())}
                  >
                    {t("worklist.clearSelection")}
                  </Button>
                </div>
              )}
              {mayAssign && (
                <BulkAssign
                  projectId={projectId}
                  consultants={consultants}
                  selected={[...selected]}
                  onAssigned={() => setSelected(new Set())}
                />
              )}
              {mayAssignWave && (
                <BulkWave
                  projectId={projectId}
                  waves={waves}
                  selected={selectedItems}
                  onAssigned={() => setSelected(new Set())}
                />
              )}
              {mayActivate && (
                <BulkActivation
                  projectId={projectId}
                  selected={selectedItems}
                  onPrinted={(result) => {
                    setSelected(new Set());
                    setPrint(result);
                  }}
                />
              )}
              <WorklistTable
                projectId={projectId}
                items={shownItems}
                columns={visibleColumns}
                selected={selected}
                onToggle={toggle}
                waveCode={waveCode}
                today={today}
                empty={items.length === 0}
              />
              {matches.length > limit && (
                <>
                  <p>{t("worklist.shownOf", { shown: limit, count: matches.length })}</p>
                  <Button
                    className="tp-load-more"
                    kind="tertiary"
                    onClick={() => setShown({ key: shownKey, count: limit + pageSize })}
                  >
                    {t("worklist.showMore")}
                  </Button>
                </>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

const noWaves: components["schemas"]["EntryWave"][] = [];
const noSelection: ReadonlySet<string> = new Set();

/** The shown rows of the work list; memoized, so typing re-renders it only for new matches. */
const WorklistTable = memo(function WorklistTable({
  projectId,
  items,
  columns: shownColumns,
  selected,
  onToggle,
  waveCode,
  today,
  empty,
}: {
  projectId: string;
  items: ListItem[];
  columns: readonly (typeof columns)[number][];
  selected: ReadonlySet<string>;
  onToggle: (id: string, on: boolean) => void;
  waveCode: ReadonlyMap<string, string>;
  today: string;
  empty: boolean;
}) {
  const { t } = useTranslation();
  const label = useSelfServiceLabel();
  const deadline = (item: ListItem) => {
    const urgent = mostUrgent(item.deadlines);
    if (!urgent) return "";
    const kind = t(`worklist.deadlineKinds.${urgent.kind}`);
    const days = daysBetween(today, urgent.date);
    const text =
      urgent.state === "overdue"
        ? t("worklist.deadlineOverdue", { kind, date: formatDate(urgent.date) })
        : days === 0
          ? t("worklist.deadlineToday", { kind })
          : t("worklist.deadlineIn", { kind, count: days });
    return urgent.final ? `${text} (${t("worklist.deadlineFinal")})` : text;
  };
  const rows = items.map((item) => ({
    id: item.id,
    select: (
      <Checkbox
        id={`select-${item.id}`}
        labelText={t("participants.select", {
          name: item.personnelNumber ?? t("participants.open"),
        })}
        hideLabel
        checked={selected.has(item.id)}
        onChange={(_, { checked }) => onToggle(item.id, checked)}
      />
    ),
    // The URL carries only the id, never a person's value (ADR-0010, pagination).
    personnelNumber: (
      <RouterLink
        to="/projects/$projectId/participations/$participationId"
        params={{ projectId, participationId: item.id }}
      >
        {item.personnelNumber ?? t("participants.open")}
      </RouterLink>
    ),
    lastName: item.lastName ?? "",
    firstName: item.firstName ?? "",
    status: t(`participants.statuses.${item.status}`),
    profilingStatus: t(`participants.profilingStatuses.${item.profilingStatus}`),
    dsvStatus: t(`participants.dsvStatuses.${item.dsvStatus}`),
    wave: item.entryWaveId ? (waveCode.get(item.entryWaveId) ?? "") : "",
    consultants: item.consultants.map((c) => c.displayName).join(", "),
    open:
      item.actions.length === 0 ? (
        ""
      ) : (
        <>
          {t("worklist.openCount", { count: item.actions.length })}{" "}
          <Tag type={item.actions[0]!.state === "rejected" ? "red" : "gray"} size="sm">
            {`${label(item.actions[0]!.key)} ${t(`worklist.actionStates.${item.actions[0]!.state}`)}`}
          </Tag>
        </>
      ),
    deadline: deadline(item),
    portal: t(`worklist.portal.${item.portal}`),
    activationStatus: t(
      item.activationStatus.account === "activated"
        ? "activation.status.activated"
        : `activation.code.${item.activationStatus.code}`,
    ),
    privacyNoticeState: t(`activation.notice.${item.privacyNoticeState.state}`, {
      dueOn: formatDate(item.privacyNoticeState.dueOn),
    }),
  }));
  return (
    <SimpleTable
      title={t("participants.title")}
      columns={shownColumns.map((key) => ({ key, header: t(`participants.columns.${key}`) }))}
      rows={rows}
      emptyState={empty ? t("participants.empty") : t("worklist.noMatches")}
    />
  );
});

/** "Zuweisen": the selected participations to one consultant of the project (Q62). */
function BulkAssign({
  projectId,
  consultants,
  selected,
  onAssigned,
}: {
  projectId: string;
  consultants: { staffUserId: string; displayName: string }[];
  selected: string[];
  onAssigned: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [staffUserId, setStaffUserId] = useState("");
  const [refused, setRefused] = useState(false);
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
    <div className="tp-bulk-actions">
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
      <Button
        kind="secondary"
        disabled={!staffUserId || selected.length === 0 || assign.isPending}
        onClick={() => assign.mutate()}
      >
        {t("participants.assign", { count: selected.length })}
      </Button>
    </div>
  );
}

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
  const mayIssue =
    selected.length > 0 && selected.every((item) => item.capabilities.issueActivationCode);
  const mayNotice =
    selected.length > 0 && selected.every((item) => item.capabilities.providePrivacyNotice);
  const ids = selected.map(({ id }) => id);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: worklistQuery(api, projectId).queryKey });
  const issue = async (kind: "letter" | "sheet") => {
    setPending(true);
    setFailed(false);
    try {
      const { data } = await api.POST("/api/v1/projects/{projectId}/activation-codes", {
        params: { path: { projectId } },
        body: {
          participationIds: ids,
          channel: kind,
          language,
          replaceOpenCode: replace,
        },
      });
      if (!data) throw new Error("No print data");
      await refresh();
      onPrinted({ kind, items: data.items });
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  const notice = async () => {
    setPending(true);
    setFailed(false);
    try {
      const { data } = await api.POST("/api/v1/projects/{projectId}/privacy-notices", {
        params: { path: { projectId } },
        body: { participationIds: ids, language },
      });
      if (!data) throw new Error("No print data");
      await refresh();
      onPrinted({ kind: "notice", items: data.items });
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="tp-section" aria-label={t("activation.bulk.title")}>
      <h3>{t("activation.bulk.title")}</h3>
      {failed && (
        <InlineNotification
          kind="error"
          title={t("activation.bulk.failed")}
          onClose={() => setFailed(false)}
        />
      )}
      <div className="tp-bulk-actions">
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
        <Button
          kind="secondary"
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
    </section>
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
