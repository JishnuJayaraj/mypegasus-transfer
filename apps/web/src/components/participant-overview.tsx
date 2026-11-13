import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import type { components } from "@transfer/api-client";
import { berlinDate, berlinTime, openSteps, type OpenStep } from "@transfer/domain";
import {
  ActionButton,
  Button,
  ButtonSet,
  Card,
  Facts,
  formatDate,
  formatTimestamp,
  InlineNotification,
  Link,
  NextSteps,
  RelativeDate,
  Section,
  SectionCard,
  Select,
  SelectItem,
  SidePanel,
  SimpleTable,
  Split,
  Stack,
  StatusTag,
  TrackBar,
  useToast,
  type Fact,
  type StatusTone,
} from "@transfer/ui";
import { Fragment, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { participationQuery, useApi, worklistQuery } from "../api";
import type de from "../locales/de/translation.json";
import { BaReportingTasks } from "./ba-reporting-tasks";
import { EntryWaveChoice } from "./entry-wave-choice";
import { stepTarget, useStepText, type OverviewAnchor, type StepTarget } from "./open-steps";
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

// The participant's overview (ui-patterns.md, the participant page): a main column with "Als
// Nächstes" (the open items in the work list's order, C2), "Stand" (the three tracks, each its own
// bar, C3), the timeline and one collapsible card per topic, whose edit forms open in a side
// panel (C4); a side column with the appointments, the responsibility and the deadlines. Only the
// fixed lifecycle core is shown; nothing regional is hard-coded (ADR-0004).

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

/** One collapsible card's open state, held by the overview. */
export interface CardState {
  open: boolean;
  onToggle: (open: boolean) => void;
}

export function ParticipantOverview(props: OverviewProps) {
  const { detail, projectId, taTg, row, today, onPanel } = props;
  const item = row.state === "loaded" ? row.item : undefined;
  // Which cards are open: component state only. A card an item or the address points to is open.
  const hash = useRouterState({ select: (state) => state.location.hash });
  const [cards, setCards] = useState<Partial<Record<OverviewAnchor | "master", boolean>>>({});
  const card = (id: OverviewAnchor | "master", byDefault = false): CardState => ({
    open: cards[id] ?? (hash === id || byDefault),
    onToggle: (open) => setCards((current) => ({ ...current, [id]: open })),
  });
  const onOpen = (target: StepTarget) => {
    if ("anchor" in target) setCards((current) => ({ ...current, [target.anchor]: true }));
    props.onOpen(target);
  };
  const links = { ...props, onOpen };
  return (
    <>
      <Split
        side={
          <>
            <Responsibility
              detail={detail}
              row={row}
              onPanel={onPanel}
              href={props.href}
              onOpen={onOpen}
            />
            <Deadlines row={row} today={today} />
          </>
        }
      >
        <OpenItems {...links} />
        <TrackSummaries detail={detail} taTg={taTg} item={item} today={today} />
        <ParticipantTimeline
          timeline={timeline(detail, item, today)}
          href={props.href}
          onOpen={onOpen}
          available={props.available}
        />
        <MasterData detail={detail} card={card("master", true)} />
        <ActivationCard
          detail={detail}
          projectId={projectId}
          onOpen={onPanel}
          card={card("participant-activation")}
        />
        {taTg && (
          <WaveAndDates detail={detail} onPanel={onPanel} card={card("participant-dates")} />
        )}
        {taTg && <BaReportingTasks detail={detail} card={card("participant-ba")} />}
      </Split>
      <EditPanels {...props} />
    </>
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
 * bars, each with its tag, its place on its own path and its key date — never one sequence
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
  const relative = (date: string) => <RelativeDate date={date} today={today} kind="deadline" />;
  const fact = (key: FieldKey, value: ReactNode): [string, ReactNode] => [
    t(`participant.fields.${key}`),
    value,
  ];
  return (
    <Card id="participant-stand" title={t("participant.overview.stand")}>
      <Track
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
            ? [fact("tgStart", relative(dates.effectiveTgStart))]
            : []),
        ]}
      />
      <Track
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
                  relative(profilingDeadline.date),
                ] as [string, ReactNode],
              ]
            : []),
        ]}
      />
      {taTg && (
        <Track
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
                    offerDeadline
                      ? relative(offerDeadline.date)
                      : dates.offerDeadline && formatDate(dates.offerDeadline),
                  ),
                  ...(detail.entryWave?.signingDeadline && !dates.offerDeadline
                    ? [fact("signingDeadline", formatDate(detail.entryWave.signingDeadline))]
                    : []),
                ]
              : []
          }
        />
      )}
    </Card>
  );
}

/** One track: its bar on its own path, its tag, and under them its step and its dates. */
function Track({
  title,
  tag,
  path,
  current,
  label,
  facts,
}: {
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
    <TrackBar title={title} steps={path.map(label)} current={index} tag={tag}>
      {index >= 0
        ? t("participant.overview.step", { n: index + 1, total: path.length })
        : t("participant.overview.offPath")}
      {shown.map(([name, value]) => (
        <Fragment key={name}>
          {" · "}
          {name}
          {": "}
          {value}
        </Fragment>
      ))}
    </TrackBar>
  );
}

/** "Als Nächstes" shows this many items, the rest behind "Alle n anzeigen". */
const openShown = 3;
const tierTone: Record<OpenStep["tier"], StatusTone> = {
  1: "danger",
  2: "warning",
  3: "info",
  4: "neutral",
};

/**
 * "Als Nächstes": the participation's open items in the work list's order (C2: `openSteps`),
 * each with its own action, the link to the tab or card that resolves it, and the prerequisite
 * as text where the action there is blocked (C1).
 */
function OpenItems({ detail, taTg, row, today, href, onOpen, available }: OverviewProps) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const targetName = useTargetName();
  const text = useStepText();
  const title = t("participant.overview.open");
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
  if (row.state !== "loaded") {
    return (
      <NextSteps
        title={title}
        items={[]}
        emptyText={t(
          row.state === "loading"
            ? "participant.overview.openLoading"
            : row.state === "failed"
              ? "participant.overview.openFailed"
              : "participant.overview.openUnavailable",
        )}
        more={
          row.state === "failed" && (
            <Button kind="tertiary" size="sm" onClick={row.retry}>
              {t("participant.overview.retry")}
            </Button>
          )
        }
      />
    );
  }
  const steps = openSteps(row.item);
  const shown = all ? steps : steps.slice(0, openShown);
  return (
    <NextSteps
      title={title}
      emptyText={t("participant.overview.nothingOpen")}
      summary={
        steps.length > shown.length &&
        t("participant.overview.openSummary", { shown: shown.length, count: steps.length })
      }
      more={
        steps.length > openShown && (
          <Button kind="ghost" size="sm" aria-expanded={all} onClick={() => setAll(!all)}>
            {all
              ? t("participant.overview.fewer")
              : t("participant.overview.all", { count: steps.length })}
          </Button>
        )
      }
      items={shown.map((step, index) => {
        const target = stepTarget(step);
        const reason = blocked(step, target);
        const { title: name, detail: when } = text(step, today);
        return {
          id: `${step.source}-${step.kind}-${index}`,
          tone: tierTone[step.tier],
          toneLabel: t(`participant.overview.tiers.${step.tier}`),
          title: name,
          detail: (when || reason) && (
            <>
              {when}
              {when && reason && " · "}
              {reason}
            </>
          ),
          // A card of `ta_tg` only, or a tab the viewer hasn't: the item is text only.
          action: available(target) &&
            (taTg || !("anchor" in target) || target.anchor !== "participant-dates") && (
              <Link
                href={href(target)}
                onClick={(event) => {
                  event.preventDefault();
                  onOpen(target);
                }}
              >
                {t("participant.overview.goTo", { place: targetName(target) })}
              </Link>
            ),
        };
      })}
    />
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
        <Section title={t("participant.overview.nextAppointment")} level={3}>
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
            <Link
              href={href({ tab: "appointments" })}
              onClick={(event) => {
                event.preventDefault();
                onOpen({ tab: "appointments" });
              }}
            >
              {t("participant.overview.allAppointments")}
            </Link>
          </p>
        </Section>
        <Section title={t("participant.assignments.title")} level={3}>
          <Stack gap={3}>
            <p>
              {detail.assignments.length === 0
                ? t("participant.assignments.empty")
                : detail.assignments.map((a) => a.displayName).join(", ")}
            </p>
            {detail.capabilities.assignParticipations && (
              <div>
                <Button kind="tertiary" size="sm" onClick={() => onPanel("assign")}>
                  {t("participant.assignments.edit")}
                </Button>
              </div>
            )}
          </Stack>
        </Section>
        <Section title={t("participant.placementAgentur.title")} level={3}>
          <Stack gap={3}>
            <PlacementAgenturFacts detail={detail} />
            {detail.capabilities.setPlacementAgentur && (
              <div>
                <Button kind="tertiary" size="sm" onClick={() => onPanel("agentur")}>
                  {t(
                    detail.placementAgenturKey
                      ? "participant.placementAgentur.change"
                      : "participant.placementAgentur.choose",
                  )}
                </Button>
              </div>
            )}
          </Stack>
        </Section>
      </Stack>
    </Card>
  );
}

/** "Fristen": the deadlines of the work list's row, each relative and absolute (principle 5). */
function Deadlines({ row, today }: { row: ItemState; today: string }) {
  const { t } = useTranslation();
  if (row.state !== "loaded") return null;
  const { deadlines } = row.item;
  return (
    <Card id="participant-deadlines" title={t("participant.overview.deadlines")}>
      {deadlines.length === 0 ? (
        <p>{t("participant.overview.noDeadlines")}</p>
      ) : (
        <Facts
          labels="above"
          items={deadlines.map((deadline) => ({
            label: t(`worklist.deadlineKinds.${deadline.kind}`),
            value: <RelativeDate date={deadline.date} today={today} kind="deadline" />,
          }))}
        />
      )}
    </Card>
  );
}

const date = (value: string | null | undefined) =>
  value === undefined ? undefined : formatDate(value);
const address = (value: Detail["person"]["address"]) =>
  value && `${value.street}, ${value.postalCode} ${value.city}, ${value.country}`;

/** "Stammdaten": the person and contact facts the viewer may read; an absent one isn't shown. */
function MasterData({ detail, card }: { detail: Detail; card: CardState }) {
  const { t } = useTranslation();
  const { person } = detail;
  const identity = facts(t, [
    ["personnelNumber", person.personnelNumber],
    ["lastName", person.lastName],
    ["firstName", person.firstName],
    ["birthDate", date(person.birthDate)],
    ["oldEmploymentEndDate", date(person.oldEmploymentEndDate)],
  ]);
  const contact = facts(t, [
    ["address", address(person.address)],
    ["phone", person.phone],
    ["mobile", person.mobile],
    ["privateEmail", person.privateEmail],
    ["workEmail", person.workEmail],
  ]);
  return (
    <SectionCard
      id="participant-master-data"
      title={t("participant.overview.masterData")}
      summary={t("participant.overview.masterDataSummary")}
      {...card}
    >
      <Stack gap={5}>
        {identity.length > 0 && (
          <Section title={t("participant.person")} level={3}>
            <Facts items={identity} />
          </Section>
        )}
        {contact.length > 0 && (
          <Section title={t("participant.contact")} level={3}>
            <Stack gap={3}>
              <Facts items={contact} />
              {person.workEmail !== undefined && <p>{t("participant.workEmailHint")}</p>}
            </Stack>
          </Section>
        )}
      </Stack>
    </SectionCard>
  );
}

/** Label and value pairs of the participant's fields; `undefined` (not readable) hides the row. */
const facts = (
  t: (key: `participant.fields.${FieldKey}`) => string,
  rows: [FieldKey, ReactNode][],
): Fact[] =>
  rows
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({ label: t(`participant.fields.${key}`), value }));

/**
 * "Welle und Vertragsdaten" (process-and-lifecycle.md, Dates): the wave and its four dates, the
 * offer deadline and the contractual dates with their source, the DSV amendments; the wave's
 * choice and the dates' change each in a side panel, or their prerequisite as text (C1).
 */
function WaveAndDates({
  detail,
  onPanel,
  card,
}: {
  detail: Detail;
  onPanel: (panel: OverviewPanel) => void;
  card: CardState;
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
  const period =
    dates.effectiveTgStart && dates.effectiveTgEnd
      ? `${formatDate(dates.effectiveTgStart)} – ${formatDate(dates.effectiveTgEnd)}`
      : null;
  return (
    <SectionCard
      id="participant-dates"
      title={t("participant.waveAndDates")}
      summary={[wave?.code ?? t("participant.overview.noWave"), period].filter(Boolean).join(" · ")}
      {...card}
    >
      <Stack gap={5}>
        <Facts items={facts(t, rows)} />
        {(mayWave || mayDates) && (
          <ButtonSet>
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
          </ButtonSet>
        )}
        <Amendments detail={detail} />
      </Stack>
    </SectionCard>
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
