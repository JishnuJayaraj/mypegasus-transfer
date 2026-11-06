import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { components } from "@transfer/api-client";
import { berlinDate, berlinTime, openSteps, type OpenStep } from "@transfer/domain";
import {
  ActionButton,
  Button,
  Card,
  formatDate,
  formatTimestamp,
  Grid,
  InlineNotification,
  Loading,
  RelativeDate,
  Select,
  SelectItem,
  SidePanel,
  SimpleTable,
  Stack,
  StatusTag,
  Tag,
  useToast,
} from "@transfer/ui";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { participationQuery, useApi, worklistQuery } from "../api";
import type de from "../locales/de/translation.json";
import { BaReportingTasks } from "./ba-reporting-tasks";
import { EntryWaveChoice } from "./entry-wave-choice";
import { StepLabel, stepTarget, type StepTarget } from "./open-steps";
import { usePanelNavigationGuard } from "./panel-guard";
import {
  ActivationCard,
  NoticeHandoverForm,
  RecoveryForm,
  SendInPersonForm,
  type ActivationPanelKind,
} from "./participant-activation";
import { ParticipantTimeline, timeline, useTargetName } from "./participant-timeline";
import { ParticipationDatesForm } from "./participation-dates-form";
import { PlacementAgenturFacts, PlacementAgenturForm } from "./placement-agentur";
import type { RecoveryPrinted } from "./recovery";
import { useConsultants } from "./team";

// The participant's overview (the plan of Slice 6b, 6b-5): three columns that separate concerns —
// "Stand" (the three tracks, each its own summary, ui-patterns.md C3), "Offen" (the open items in
// the work list's order, C2) and "Termine & Zuständigkeit" — then the timeline (D12, stage 1),
// "Stammdaten" and the cards whose edit forms open in a side panel (C4). Only the fixed lifecycle
// core is shown; nothing regional is hard-coded (ADR-0004).

type Detail = components["schemas"]["ParticipationDetail"];
type Item = components["schemas"]["WorklistItem"];
type FieldKey = keyof typeof de.participant.fields;

/** The side panels of the overview; the page header's "Aktionen" opens some of them. */
export type OverviewPanel = "assign" | "agentur" | "wave" | "dates" | ActivationPanelKind;

/** The work list's row of this participation, as far as the viewer has the work list. */
export type ItemState =
  | { state: "loading" }
  | { state: "unavailable" }
  | { state: "failed"; retry: () => void }
  | { state: "loaded"; item: Item };

export interface OverviewProps {
  detail: Detail;
  projectId: string;
  taTg: boolean;
  row: ItemState;
  /** The Berlin date the relative dates count from (the snapshot's). */
  today: string;
  panel: OverviewPanel | null;
  onPanel: (panel: OverviewPanel | null) => void;
  /** The URL of a tab or card, and opening it. */
  href: (target: StepTarget) => string;
  onOpen: (target: StepTarget) => void;
  /** Whether the viewer has the tab or card. */
  available: (target: StepTarget) => boolean;
  onPrinted: (printed: RecoveryPrinted) => void;
}

export function ParticipantOverview(props: OverviewProps) {
  const { detail, projectId, taTg, row, today, onPanel } = props;
  const item = row.state === "loaded" ? row.item : undefined;
  return (
    <Stack gap={6}>
      <Grid columns={3} collapse="wide">
        <TrackSummaries detail={detail} taTg={taTg} item={item} today={today} />
        <OpenItems {...props} />
        <Responsibility
          detail={detail}
          row={row}
          onPanel={onPanel}
          href={props.href}
          onOpen={props.onOpen}
        />
      </Grid>
      <ParticipantTimeline
        timeline={timeline(detail, item, today)}
        href={props.href}
        onOpen={props.onOpen}
        available={props.available}
      />
      <MasterData detail={detail} />
      <ActivationCard detail={detail} projectId={projectId} onOpen={onPanel} />
      {taTg && <WaveAndDates detail={detail} onPanel={onPanel} />}
      {taTg && <BaReportingTasks detail={detail} />}
      <EditPanels {...props} />
    </Stack>
  );
}

/** The fixed core path of each track (process-and-lifecycle.md, lifecycle model). */
const paths = {
  main: (taTg: boolean) =>
    taTg
      ? (["imported", "contacted", "informed", "active_in_tg", "exited"] as const)
      : (["imported", "contacted", "informed", "ta_completed"] as const),
  profiling: [
    "not_started",
    "profiling_accepted",
    "profiling_in_progress",
    "profiling_done",
  ] as const,
  dsv: ["not_offered", "dsv_offered", "dsv_signed"] as const,
};

/**
 * "Stand": the main status, the profiling track and the DSV track (`ta_tg`) as three separate
 * summaries, each with its tag, its own short step list and its key date — never one sequence
 * across the tracks (ui-patterns.md, C3).
 */
function TrackSummaries({
  detail,
  taTg,
  item,
  today,
}: {
  detail: Detail;
  taTg: boolean;
  item: Item | undefined;
  today: string;
}) {
  const { t } = useTranslation();
  const { dates } = detail;
  const deadline = (...kinds: string[]) => item?.deadlines.find((d) => kinds.includes(d.kind));
  const profilingDeadline = deadline("tl407_submission", "profiling_exception");
  const offerDeadline = deadline("offer_deadline");
  const fact = (key: FieldKey, value: ReactNode): [string, ReactNode] => [
    t(`participant.fields.${key}`),
    value,
  ];
  return (
    <Card id="participant-stand" title={t("participant.overview.stand")}>
      <Stack gap={6}>
        <Track
          track="main"
          title={t("participant.overview.tracks.main")}
          tag={<StatusTag family="main" code={detail.status} />}
          path={paths.main(taTg)}
          current={detail.status}
          label={(code) => t(`participants.statuses.${code as Detail["status"]}`)}
          facts={[
            fact("tgEntryDate", dates.tgEntryDate && formatDate(dates.tgEntryDate)),
            fact("exitDate", dates.exitDate && formatDate(dates.exitDate)),
            fact("withdrawnOn", dates.withdrawnOn && formatDate(dates.withdrawnOn)),
            ...(taTg && !dates.tgEntryDate && dates.effectiveTgStart
              ? [
                  fact(
                    "tgStart",
                    <RelativeDate date={dates.effectiveTgStart} today={today} kind="deadline" />,
                  ),
                ]
              : []),
          ]}
        />
        <Track
          track="profiling"
          title={t("participant.overview.tracks.profiling")}
          tag={<StatusTag family="profiling" code={detail.profilingStatus} />}
          path={paths.profiling}
          current={detail.profilingStatus}
          label={(code) => t(`participants.profilingStatuses.${code as Detail["profilingStatus"]}`)}
          facts={[
            [
              t("participant.overview.profilingDoneOn"),
              dates.profilingDoneOn && formatDate(dates.profilingDoneOn),
            ],
            ...(profilingDeadline && !dates.profilingDoneOn
              ? [
                  [
                    t(`worklist.deadlineKinds.${profilingDeadline.kind}`),
                    <RelativeDate
                      key="deadline"
                      date={profilingDeadline.date}
                      today={today}
                      kind="deadline"
                    />,
                  ] as [string, ReactNode],
                ]
              : []),
          ]}
        />
        {taTg && (
          <Track
            track="dsv"
            title={t("participant.overview.tracks.dsv")}
            tag={<StatusTag family="dsv" code={detail.dsvStatus} />}
            path={paths.dsv}
            current={detail.dsvStatus}
            label={(code) => t(`participants.dsvStatuses.${code as Detail["dsvStatus"]}`)}
            facts={
              // The key date while the DSV is open: the offer deadline, else the wave's.
              detail.dsvStatus === "dsv_offered" || detail.dsvStatus === "not_offered"
                ? [
                    fact(
                      "offerDeadline",
                      offerDeadline ? (
                        <RelativeDate date={offerDeadline.date} today={today} kind="deadline" />
                      ) : (
                        dates.offerDeadline && formatDate(dates.offerDeadline)
                      ),
                    ),
                    ...(detail.entryWave?.signingDeadline && !dates.offerDeadline
                      ? [fact("signingDeadline", formatDate(detail.entryWave.signingDeadline))]
                      : []),
                  ]
                : []
            }
          />
        )}
      </Stack>
    </Card>
  );
}

/** One track: its tag, where it stands on its own path, and its dates. */
function Track({
  track,
  title,
  tag,
  path,
  current,
  label,
  facts,
}: {
  track: "main" | "profiling" | "dsv";
  title: string;
  tag: ReactNode;
  path: readonly string[];
  current: string;
  label: (code: string) => string;
  /** A label and its value; an empty value is left out. */
  facts: [string, ReactNode][];
}) {
  const { t } = useTranslation();
  const index = path.indexOf(current);
  const shown = facts.filter(([, value]) => value !== null && value !== undefined && value !== "");
  return (
    <section className="tp-track" aria-label={title} data-track={track}>
      <h3>{title}</h3>
      <div>{tag}</div>
      <p className="tp-track-step">
        {index >= 0
          ? t("participant.overview.step", { n: index + 1, total: path.length })
          : t("participant.overview.offPath")}
      </p>
      {index >= 0 && (
        <ol
          className="tp-track-steps"
          aria-label={t("participant.overview.steps", { track: title })}
        >
          {path.map((code, i) => (
            <li
              key={code}
              className={i < index ? "tp-track-done" : i === index ? "tp-track-current" : undefined}
              aria-current={i === index ? "step" : undefined}
            >
              {label(code)}
              {i < index && (
                <span className="tp-visually-hidden">{` (${t("participant.overview.done")})`}</span>
              )}
            </li>
          ))}
        </ol>
      )}
      {shown.length > 0 && (
        <dl className="tp-facts">
          {shown.map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/**
 * "Offen": the participation's open items in the work list's order (C2: `openSteps`), each with
 * a link to the tab or card that resolves it, and the prerequisite as text where the action
 * there is blocked (C1).
 */
/** "Offen" shows this many items, the rest behind "Alle anzeigen". */
const openShown = 5;

function OpenItems({ detail, taTg, row, today, href, onOpen, available }: OverviewProps) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const targetName = useTargetName();
  const blocked = (step: OpenStep, target: StepTarget): string | null => {
    if (!("anchor" in target) || target.anchor !== "participant-dates") return null;
    // The wave's choice or the contractual dates: their refusal code as the prerequisite;
    // "forbidden" means the viewer doesn't act here at all (no text, C1).
    const wave = step.source === "flag" && step.kind === "informed_without_wave_at_cutoff";
    if (wave) {
      const refusal = detail.refusals.assignEntryWave;
      return !detail.capabilities.assignEntryWave && refusal && refusal !== "forbidden"
        ? t(`participant.waveRefusals.${refusal}`)
        : null;
    }
    const refusal = detail.refusals.setParticipationDates;
    return !detail.capabilities.setParticipationDates && refusal && refusal !== "forbidden"
      ? t(`participant.dates.refusals.${refusal}`)
      : null;
  };
  let body: ReactNode;
  switch (row.state) {
    case "loading":
      body = <Loading label={t("participant.overview.openLoading")} />;
      break;
    case "unavailable":
      body = <p>{t("participant.overview.openUnavailable")}</p>;
      break;
    case "failed":
      body = (
        <Stack gap={3}>
          <p role="alert">{t("participant.overview.openFailed")}</p>
          <div>
            <Button kind="tertiary" size="sm" onClick={row.retry}>
              {t("participant.overview.retry")}
            </Button>
          </div>
        </Stack>
      );
      break;
    case "loaded": {
      const steps = openSteps(row.item);
      const shownSteps = all ? steps : steps.slice(0, openShown);
      body =
        steps.length === 0 ? (
          <p>{t("participant.overview.nothingOpen")}</p>
        ) : (
          <Stack gap={3}>
            <ol className="tp-open-items" id="participant-open-list">
              {shownSteps.map((step, index) => {
                const target = stepTarget(step);
                // A card of `ta_tg` only, or a tab the viewer hasn't: the item is text only.
                const linked =
                  available(target) &&
                  (taTg || !("anchor" in target) || target.anchor !== "participant-dates");
                const reason = blocked(step, target);
                return (
                  <li key={`${step.source}-${step.kind}-${index}`}>
                    <span>
                      {step.tier === 1 && (
                        <>
                          <Tag type="red" size="sm">
                            {t("worklist.overdueTag")}
                          </Tag>{" "}
                        </>
                      )}
                      <StepLabel step={step} today={today} />
                    </span>
                    {linked && (
                      <a
                        className="tp-open-item-link"
                        href={href(target)}
                        onClick={(event) => {
                          event.preventDefault();
                          onOpen(target);
                        }}
                      >
                        {t("participant.overview.goTo", { place: targetName(target) })}
                      </a>
                    )}
                    {reason && <span className="tp-action-reason">{reason}</span>}
                  </li>
                );
              })}
            </ol>
            {steps.length > openShown && (
              <div>
                <Button
                  kind="ghost"
                  size="sm"
                  aria-expanded={all}
                  aria-controls="participant-open-list"
                  onClick={() => setAll(!all)}
                >
                  {all
                    ? t("participant.overview.fewer")
                    : t("participant.overview.all", { count: steps.length })}
                </Button>
              </div>
            )}
          </Stack>
        );
    }
  }
  return (
    <Card id="participant-open" title={t("participant.overview.open")}>
      {body}
    </Card>
  );
}

/** "Termine & Zuständigkeit": the next appointment, the consultants and the placement Agentur. */
function Responsibility({
  detail,
  row,
  onPanel,
  href,
  onOpen,
}: {
  detail: Detail;
  row: ItemState;
  onPanel: (panel: OverviewPanel) => void;
  href: (target: StepTarget) => string;
  onOpen: (target: StepTarget) => void;
}) {
  const { t } = useTranslation();
  const next = row.state === "loaded" ? row.item.appointments.next : null;
  return (
    <Card id="participant-responsibility" title={t("participant.overview.responsibility")}>
      <Stack gap={6}>
        <section aria-label={t("participant.overview.nextAppointment")}>
          <h3>{t("participant.overview.nextAppointment")}</h3>
          <p>
            {row.state !== "loaded"
              ? null
              : next
                ? t("participant.overview.appointmentLine", {
                    kind: t(`appointments.kinds.${next.kind}`),
                    date: formatDate(berlinDate(next.startsAt)),
                    time: berlinTime(next.startsAt),
                  })
                : t("participant.overview.noAppointment")}{" "}
            <a
              href={href({ tab: "appointments" })}
              onClick={(event) => {
                event.preventDefault();
                onOpen({ tab: "appointments" });
              }}
            >
              {t("participant.overview.allAppointments")}
            </a>
          </p>
        </section>
        <section aria-label={t("participant.assignments.title")}>
          <h3>{t("participant.assignments.title")}</h3>
          {detail.assignments.length === 0 ? (
            <p>{t("participant.assignments.empty")}</p>
          ) : (
            <ul className="tp-plain-list">
              {detail.assignments.map((a) => (
                <li key={a.staffUserId}>{a.displayName}</li>
              ))}
            </ul>
          )}
          {detail.capabilities.assignParticipations && (
            <div className="tp-button-row">
              <Button kind="tertiary" size="sm" onClick={() => onPanel("assign")}>
                {t("participant.assignments.edit")}
              </Button>
            </div>
          )}
        </section>
        <section aria-label={t("participant.placementAgentur.title")}>
          <h3>{t("participant.placementAgentur.title")}</h3>
          <PlacementAgenturFacts detail={detail} />
          {detail.capabilities.setPlacementAgentur && (
            <div className="tp-button-row">
              <Button kind="tertiary" size="sm" onClick={() => onPanel("agentur")}>
                {t(
                  detail.placementAgenturKey
                    ? "participant.placementAgentur.change"
                    : "participant.placementAgentur.choose",
                )}
              </Button>
            </div>
          )}
        </section>
      </Stack>
    </Card>
  );
}

const date = (value: string | null | undefined) =>
  value === undefined ? undefined : formatDate(value);
const address = (value: Detail["person"]["address"]) =>
  value && `${value.street}, ${value.postalCode} ${value.city}, ${value.country}`;

/** "Stammdaten": the person and contact facts the viewer may read; an absent one isn't shown. */
function MasterData({ detail }: { detail: Detail }) {
  const { t } = useTranslation();
  const { person } = detail;
  return (
    <Card id="participant-master-data" title={t("participant.overview.masterData")}>
      <Grid columns={2}>
        <Facts
          title={t("participant.person")}
          rows={[
            ["personnelNumber", person.personnelNumber],
            ["lastName", person.lastName],
            ["firstName", person.firstName],
            ["birthDate", date(person.birthDate)],
            ["oldEmploymentEndDate", date(person.oldEmploymentEndDate)],
          ]}
        />
        <Facts
          title={t("participant.contact")}
          rows={[
            ["address", address(person.address)],
            ["phone", person.phone],
            ["mobile", person.mobile],
            ["privateEmail", person.privateEmail],
            ["workEmail", person.workEmail],
          ]}
        >
          {person.workEmail !== undefined && <p>{t("participant.workEmailHint")}</p>}
        </Facts>
      </Grid>
    </Card>
  );
}

/** A titled list of label/value pairs; `undefined` (not readable) hides the row. */
function Facts({
  title,
  rows,
  children,
}: {
  title: string;
  rows: [FieldKey, ReactNode][];
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const shown = rows.filter(([, value]) => value !== undefined);
  if (shown.length === 0) return null;
  return (
    <section aria-label={title}>
      <h3>{title}</h3>
      <dl className="tp-facts">
        {shown.map(([key, value]) => (
          <div key={key}>
            <dt>{t(`participant.fields.${key}`)}</dt>
            <dd>{value === null || value === "" ? "—" : value}</dd>
          </div>
        ))}
      </dl>
      {children}
    </section>
  );
}

/**
 * "Welle und Vertragsdaten" (process-and-lifecycle.md, Dates): the wave and its four dates, the
 * offer deadline and the contractual dates with their source, the DSV amendments; the wave's
 * choice and the dates' change each in a side panel, or their prerequisite as text (C1).
 */
function WaveAndDates({
  detail,
  onPanel,
}: {
  detail: Detail;
  onPanel: (panel: OverviewPanel) => void;
}) {
  const { t } = useTranslation();
  const { entryWave: wave, dates } = detail;
  // Where a contractual date comes from: the participation's own, else the wave's.
  const source = (own: string | null, effective: string | null) =>
    effective === null
      ? null
      : `${formatDate(effective)} (${t(own === null ? "participant.fromWave" : "participant.individual")})`;
  const rows: [FieldKey, ReactNode][] = [
    ["wave", wave ? `${wave.code} – ${wave.name}` : null],
    // The wave's own four dates, also where individual dates override them.
    ["signingDeadline", wave && formatDate(wave.signingDeadline)],
    ["defaultTgStart", wave && formatDate(wave.defaultTgStart)],
    ["defaultTgEnd", wave && formatDate(wave.defaultTgEnd)],
    ["latestEntryDate", wave && formatDate(wave.latestEntryDate)],
    ["offerDeadline", date(dates.offerDeadline)],
    ["tgStart", source(dates.tgStart, dates.effectiveTgStart)],
    ["tgEnd", source(dates.tgEnd, dates.effectiveTgEnd)],
  ];
  // The missing permission isn't a prerequisite: such an action isn't rendered (C1).
  const waveRefusal = detail.refusals.assignEntryWave;
  const datesRefusal = detail.refusals.setParticipationDates;
  const mayWave =
    detail.capabilities.assignEntryWave || (waveRefusal && waveRefusal !== "forbidden");
  const mayDates =
    detail.capabilities.setParticipationDates || (datesRefusal && datesRefusal !== "forbidden");
  return (
    <Card id="participant-dates" title={t("participant.waveAndDates")}>
      <Stack gap={5}>
        <dl className="tp-facts">
          {rows.map(([key, value]) => (
            <div key={key}>
              <dt>{t(`participant.fields.${key}`)}</dt>
              <dd>{value === null || value === "" ? "—" : value}</dd>
            </div>
          ))}
        </dl>
        {(mayWave || mayDates) && (
          <div className="tp-button-row">
            {mayWave && (
              <ActionButton
                kind="tertiary"
                size="md"
                onClick={() => onPanel("wave")}
                unavailableReason={
                  detail.capabilities.assignEntryWave || !waveRefusal
                    ? null
                    : t(`participant.waveRefusals.${waveRefusal}`)
                }
              >
                {t(wave ? "participant.changeWave" : "participant.chooseWave")}
              </ActionButton>
            )}
            {mayDates && (
              <ActionButton
                kind="tertiary"
                size="md"
                onClick={() => onPanel("dates")}
                unavailableReason={
                  detail.capabilities.setParticipationDates || !datesRefusal
                    ? null
                    : t(`participant.dates.refusals.${datesRefusal}`)
                }
              >
                {t("participant.dates.open")}
              </ActionButton>
            )}
          </div>
        )}
        <Amendments detail={detail} />
      </Stack>
    </Card>
  );
}

/**
 * The DSV amendments (process-and-lifecycle.md, "DSV amendment"): evidence only; the signed
 * original stays on paper.
 */
function Amendments({ detail }: { detail: Detail }) {
  const { t } = useTranslation();
  if (detail.amendments === undefined) return null;
  const rows = detail.amendments.map((a) => ({
    id: a.id,
    kind: t(`participant.amendments.kinds.${a.kind}`),
    fullyExecutedOn: formatDate(a.fullyExecutedOn),
    dates: [
      a.oldTgStart !== a.newTgStart &&
        `${t("participant.fields.tgStart")}: ${formatDate(a.oldTgStart) || "—"} → ${formatDate(a.newTgStart)}`,
      a.oldTgEnd !== a.newTgEnd &&
        `${t("participant.fields.tgEnd")}: ${formatDate(a.oldTgEnd) || "—"} → ${formatDate(a.newTgEnd)}`,
    ]
      .filter(Boolean)
      .join("; "),
    originalLocation: t(`participant.dates.locations.${a.originalLocation}`),
    documentReference: a.documentReference ?? "—",
    confirmedAt: formatTimestamp(a.confirmedAt),
  }));
  const columns = [
    "kind",
    "fullyExecutedOn",
    "dates",
    "originalLocation",
    "documentReference",
    "confirmedAt",
  ] as const;
  return (
    <section aria-label={t("participant.amendments.title")}>
      <SimpleTable
        title={t("participant.amendments.title")}
        columns={columns.map((key) => ({
          key,
          header: t(`participant.amendments.columns.${key}`),
        }))}
        rows={rows}
        emptyState={t("participant.amendments.empty")}
      />
    </section>
  );
}

/** Each edit form in its side panel; closing with unsaved input asks first (C4). */
function EditPanels({ detail, projectId, panel, onPanel, onPrinted }: OverviewProps) {
  const { t } = useTranslation();
  const [dirty, setDirty] = useState(false);
  const pendingNavigation = usePanelNavigationGuard(panel !== null && dirty);
  const close = () => {
    setDirty(false);
    onPanel(null);
  };
  const titles: Record<OverviewPanel, string> = {
    assign: t("participant.assignments.edit"),
    agentur: t("participant.placementAgentur.title"),
    wave: t(detail.entryWave ? "participant.changeWave" : "participant.chooseWave"),
    dates: t("participant.dates.title"),
    send: t("activation.detail.sendInPerson"),
    recovery: t("activation.recovery.title"),
    notice: t("activation.detail.noticeHandedOver"),
  };
  const form = (kind: OverviewPanel): ReactNode => {
    const common = { detail, projectId, onDirtyChange: setDirty, onSaved: close };
    switch (kind) {
      case "assign":
        return <AssignmentsForm {...common} />;
      case "agentur":
        return <PlacementAgenturForm {...common} />;
      case "wave":
        return <EntryWaveChoice {...common} />;
      case "dates":
        return <ParticipationDatesForm {...common} />;
      case "send":
        return <SendInPersonForm {...common} />;
      case "recovery":
        return (
          <RecoveryForm
            detail={detail}
            projectId={projectId}
            onDirtyChange={setDirty}
            onPrinted={(printed) => {
              close();
              onPrinted(printed);
            }}
          />
        );
      case "notice":
        return <NoticeHandoverForm {...common} />;
    }
  };
  return (
    <SidePanel
      open={panel !== null}
      title={panel ? titles[panel] : ""}
      dirty={dirty}
      onClose={close}
      pendingNavigation={pendingNavigation}
    >
      {panel && form(panel)}
    </SidePanel>
  );
}

/**
 * The consultants the participant is assigned to (Q62): the PL assigns another consultant of the
 * project or ends an assignment (`capabilities.assignParticipations`). Access follows at once.
 */
function AssignmentsForm({
  detail,
  projectId,
  onDirtyChange,
}: {
  detail: Detail;
  projectId: string;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const { consultants } = useConsultants(projectId);
  const [staffUserId, setStaffUserId] = useState("");
  const [failed, setFailed] = useState(false);
  const choose = (value: string) => {
    setStaffUserId(value);
    onDirtyChange(value !== "");
  };
  const refresh = async () => {
    setFailed(false);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: participationQuery(api, detail.id).queryKey }),
      queryClient.invalidateQueries({ queryKey: worklistQuery(api, projectId).queryKey }),
    ]);
  };
  const assign = useMutation({
    mutationFn: async () => {
      const { data } = await api.POST("/api/v1/projects/{projectId}/assignments", {
        params: { path: { projectId } },
        body: { staffUserId, participationIds: [detail.id] },
      });
      if (!data) throw new Error("Assignment failed");
    },
    onSuccess: async () => {
      choose("");
      showToast({ title: t("participant.assignments.assigned") });
      await refresh();
    },
    onError: () => setFailed(true),
  });
  const unassign = useMutation({
    mutationFn: async (consultant: string) => {
      const { response } = await api.DELETE(
        "/api/v1/participations/{participationId}/assignments/{staffUserId}",
        { params: { path: { participationId: detail.id, staffUserId: consultant } } },
      );
      if (!response.ok) throw new Error("Unassignment failed");
    },
    onSuccess: refresh,
    onError: () => setFailed(true),
  });
  const assigned = new Set(detail.assignments.map((a) => a.staffUserId));
  return (
    <Stack gap={5}>
      {failed && (
        <InlineNotification
          kind="error"
          title={t("participant.assignments.failed")}
          onClose={() => setFailed(false)}
        />
      )}
      <SimpleTable
        title={t("participant.assignments.title")}
        columns={(["displayName", "assignedAt", "actions"] as const).map((key) => ({
          key,
          header: t(`participant.assignments.columns.${key}`),
        }))}
        rows={detail.assignments.map((a) => ({
          id: a.staffUserId,
          displayName: a.displayName,
          assignedAt: formatTimestamp(a.assignedAt),
          actions: (
            <Button
              kind="ghost"
              size="sm"
              disabled={unassign.isPending}
              onClick={() => unassign.mutate(a.staffUserId)}
            >
              {t("participant.assignments.unassign", { name: a.displayName })}
            </Button>
          ),
        }))}
        emptyState={t("participant.assignments.empty")}
      />
      <Select
        id="participant-assign"
        labelText={t("participants.assignTo")}
        value={staffUserId}
        onChange={(event) => choose(event.target.value)}
      >
        <SelectItem value="" text={t("participants.chooseConsultant")} />
        {consultants
          .filter((c) => !assigned.has(c.staffUserId))
          .map((c) => (
            <SelectItem key={c.staffUserId} value={c.staffUserId} text={c.displayName} />
          ))}
      </Select>
      <div>
        <Button disabled={!staffUserId || assign.isPending} onClick={() => assign.mutate()}>
          {t("participant.assignments.assign")}
        </Button>
      </div>
    </Stack>
  );
}
