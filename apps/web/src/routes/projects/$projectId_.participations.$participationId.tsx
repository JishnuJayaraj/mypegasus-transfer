import { ContactStatusDialog, contactStatusOffered } from "../../components/contact-status";
import { useCorrectionRequest } from "../../components/evidence-correction";
import {
  EndReasonDialog,
  WithdrawDialog,
  withdrawOffered,
} from "../../components/participation-ending";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  createLink,
  useRouter,
  useRouterState,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  InlineNotification,
  Link,
  PageHeader,
  StatusTag,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  type MenuAction,
} from "@transfer/ui";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  entryWavesQuery,
  participationQuery,
  projectQuery,
  projectTeamQuery,
  useApi,
  worklistQuery,
} from "../../api";
import { StartAssistedMode } from "../../components/assisted-mode";
import { AsuTab } from "../../components/asu-tab";
import { ReconciliationDialog } from "../../components/reconciliation";
import { DocumentsTab } from "../../components/documents-tab";
import { DsvTab } from "../../components/dsv-tab";
import { HistoryTab } from "../../components/history";
import { BulkInvite } from "../../components/invitations";
import type { StepTarget } from "../../components/open-steps";
import { activationPanels } from "../../components/participant-activation";
import {
  ParticipantOverview,
  type ItemState,
  type OverviewPanel,
} from "../../components/participant-overview";
import { berlinToday } from "../../components/participant-timeline";
import { AppointmentsTab } from "../../components/participation-appointments";
import { ProfilingTab } from "../../components/profiling-tab";
import { RecoveryPrint, type RecoveryPrinted } from "../../components/recovery";
import { BulkRemind, MessagesTab } from "../../components/reminders";
import { RouteError } from "../../components/route-error";
import { SelfServiceTab } from "../../components/self-service-tab";
import { RetentionTab } from "../../components/retention-tab";
import { worklistMemory } from "../../components/worklist-state";
import { usePageTitle } from "../../page-title";

type Detail = components["schemas"]["ParticipationDetail"];
const RouterLink = createLink(Link);

/**
 * The tab shown: the overview, "Selbstauskunft" (e.g. after assisted mode ended), "Profiling" (for
 * the PL and the assigned consultant), "Arbeitsuche" (`ta_tg`, the case readers), "DSV" (`ta_tg`,
 * the PL and back office), "Unterlagen",
 * "Termine", "Nachrichten", "Aufbewahrung" (the PL and back office) or "Verlauf".
 */
const tabs = [
  undefined,
  "self-service",
  "profiling",
  "asu",
  "dsv",
  "documents",
  "appointments",
  "messages",
  "retention",
  "history",
] as const;
type Search = { tab?: Exclude<(typeof tabs)[number], undefined> };
const tabLabels = {
  overview: "overview",
  "self-service": "selfService",
  profiling: "profiling",
  asu: "asu",
  dsv: "dsv",
  documents: "documents",
  appointments: "appointments",
  messages: "messages",
  retention: "retention",
  history: "history",
} as const;

export const Route = createFileRoute("/projects/$projectId_/participations/$participationId")({
  validateSearch: (search: Record<string, unknown>): Search => {
    const tab = tabs.find((candidate) => candidate !== undefined && candidate === search.tab);
    return tab ? { tab } : {};
  },
  loader: async ({ context: { api, queryClient }, params: { projectId, participationId } }) => {
    const [project, detail] = await Promise.all([
      queryClient.ensureQueryData(projectQuery(api, projectId)),
      queryClient.ensureQueryData(participationQuery(api, participationId)),
    ]);
    // The participant must belong to the project in the URL; anything else is not found, and
    // nothing of the other project (its waves) is loaded.
    if (detail.projectId !== projectId) {
      throw new ApiProblemError({
        type: "urn:transfer:problem:not-found",
        title: "Not found",
        status: 404,
      });
    }
    // The assignment choice lists the project's consultants (Q62).
    await queryClient.ensureQueryData(projectTeamQuery(api, projectId));
    // The wave choice lists the project's waves (visible to every member).
    if (project.type === "ta_tg")
      await queryClient.ensureQueryData(entryWavesQuery(api, projectId));
  },
  component: ParticipationPage,
  errorComponent: ParticipationError,
});

/** A 403 or 404 reads as "not allowed" or "not found", never as an empty page. */
function ParticipationError(props: ErrorComponentProps) {
  const { t } = useTranslation();
  const { error } = props;
  if (error instanceof ApiProblemError && [403, 404].includes(error.status)) {
    const key = error.status === 403 ? "participant.forbidden" : "participant.notFound";
    return <InlineNotification kind="error" title={t(key)} hideCloseButton />;
  }
  return <RouteError {...props} />;
}

/**
 * One participant (process-and-lifecycle.md; data-protection.md, access matrix), as the plan of
 * Slice 6b (6b-5) lays it out: the page header with the breadcrumb back to the work list as it was
 * left (ui-patterns.md, C6), the three tracks as separate tags (C3) and the actions the
 * capabilities allow under "Aktionen"; one "Handlungsbedarf" with the hints; the overview and the
 * tabs. The API sends only what the viewer may read: an absent field isn't shown, a field without
 * a value shows a dash. The document title names the page, never the person (data-protection.md,
 * page titles).
 */
function ParticipationPage() {
  const { t } = useTranslation();
  const { projectId, participationId } = Route.useParams();
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const api = useApi();
  const { data: project } = useSuspenseQuery(projectQuery(api, projectId));
  // The page, not the person: no name in the title (data-protection.md, page titles).
  usePageTitle(t("participant.title"), project.name);
  const { data: detail } = useSuspenseQuery(participationQuery(api, participationId));
  // The open items, the deadlines and the appointments are the work list's row (no new API); a
  // viewer without the work list (403) sees the page without them.
  const worklist = useQuery(worklistQuery(api, projectId));
  const [panel, setPanel] = useState<OverviewPanel | null>(null);
  const [dialog, setDialog] = useState<
    | "remind"
    | "invite"
    | "assisted"
    | "withdraw"
    | "endReason"
    | "reconcile"
    | "contactStatus"
    | null
  >(null);
  const [printed, setPrinted] = useState<RecoveryPrinted | null>(null);
  const fromList = useRouterState({ select: (state) => state.location.state.worklistSearch });
  const withdrawnOnCorrection = useCorrectionRequest({ participationId, projectId });
  // The loader refuses a participant of another project; the cache can't change that later.
  if (detail.projectId !== projectId) {
    return <InlineNotification kind="error" title={t("participant.notFound")} hideCloseButton />;
  }
  const taTg = project.type === "ta_tg";
  const { person } = detail;
  const name = [person.lastName, person.firstName].filter(Boolean).join(", ");
  const item = worklist.data?.items.find((row) => row.id === detail.id);
  const row: ItemState = worklist.isPending
    ? { state: "loading" }
    : worklist.isError
      ? worklist.error instanceof ApiProblemError && [403, 404].includes(worklist.error.status)
        ? { state: "unavailable" }
        : { state: "failed", retry: () => void worklist.refetch() }
      : item
        ? { state: "loaded", item }
        : { state: "unavailable" };
  const today = berlinToday(worklist.data?.generatedAt);
  // Back office and the org roles have no tab "Profiling" (data-protection.md, Q49); the tab
  // "Arbeitsuche" is the case readers' in a `ta_tg` project (Q89).
  const shown = tabs.filter(
    (key) =>
      (key !== "profiling" || detail.capabilities.viewProfiling) &&
      (key !== "asu" || detail.capabilities.viewAsu) &&
      (key !== "dsv" || detail.capabilities.viewDsv) &&
      (key !== "retention" || detail.capabilities.viewRetention),
  );
  const current = shown.includes(tab) ? tab : undefined;

  /** Whether the viewer has a tab or card an item links to. */
  const available = (target: StepTarget) =>
    "tab" in target
      ? shown.includes(target.tab)
      : target.anchor === "participant-dates"
        ? taTg
        : target.anchor === "participant-ba"
          ? taTg && detail.baReportingTasks !== undefined
          : true;
  const location = (target: StepTarget) => ({
    to: "/projects/$projectId/participations/$participationId" as const,
    params: { projectId, participationId },
    search: "tab" in target ? { tab: target.tab } : {},
    ...("anchor" in target && { hash: target.anchor }),
  });
  const href = (target: StepTarget) => router.buildLocation(location(target)).href;
  const open = (target: StepTarget) => {
    // The history state (the way back to the list) stays with the page's own navigations.
    void navigate({ ...location(target), state: true }).then(() => {
      if ("anchor" in target) document.getElementById(target.anchor)?.scrollIntoView();
    });
  };

  // The breadcrumb's way back: the work list with the codes and sort it was left with (C6), from
  // the navigation's history state (kept on a reload), else from the page's memory.
  const listSearch = fromList ?? worklistMemory(projectId).search;
  const menuActions: MenuAction[] = [
    ...activationPanels(detail).map((kind) => ({
      label: t(`participant.actions.${kind}`),
      onClick: () => setPanel(kind),
    })),
    ...(item && (item.capabilities.remind.allowed || item.capabilities.remind.code !== null)
      ? [{ label: t("participant.actions.remind"), onClick: () => setDialog("remind") }]
      : []),
    ...(item?.capabilities.invite.allowed
      ? [{ label: t("participant.actions.invite"), onClick: () => setDialog("invite") }]
      : []),
    ...(detail.capabilities.startAssistedMode
      ? [{ label: t("participant.actions.assisted"), onClick: () => setDialog("assisted") }]
      : []),
    // process-and-lifecycle.md, the manual contact statuses (Q215): by its capability.
    ...(contactStatusOffered(detail)
      ? [
          {
            label: t("participant.actions.contactStatus"),
            onClick: () => setDialog("contactStatus"),
          },
        ]
      : []),
    // process-and-lifecycle.md, manual withdrawal and the end reason (Q72), by capability.
    ...(detail.capabilities.correctEndReason
      ? [
          {
            label: t("participant.actions.correctEndReason"),
            onClick: () => setDialog("endReason"),
          },
        ]
      : []),
    // A wrong manual withdrawal date (data-protection.md, evidence corrections: field targets).
    ...(detail.dateCorrections?.withdrawnOn?.mayRequest
      ? [
          {
            label: t("participant.actions.correctWithdrawnOn"),
            onClick: () =>
              withdrawnOnCorrection.open({
                kind: "field",
                id: "withdrawnOn",
                label: t("corrections.fields.withdrawnOn"),
              }),
          },
        ]
      : []),
    // process-and-lifecycle.md, the reconciliation (Q68 case 2): by its capability.
    ...(detail.capabilities.reconcileTgEntry
      ? [{ label: t("participant.actions.reconcile"), onClick: () => setDialog("reconcile") }]
      : []),
    ...(withdrawOffered(detail)
      ? [
          {
            label: t("participant.actions.withdraw"),
            onClick: () => setDialog("withdraw"),
            danger: true,
          },
        ]
      : []),
  ];
  const metadata = [
    person.personnelNumber &&
      t("participant.header.personnelNumber", { number: person.personnelNumber }),
    taTg &&
      t("participant.header.wave", {
        wave: detail.entryWave?.code ?? t("participant.header.noWave"),
      }),
  ]
    .filter(Boolean)
    .join(" · ");

  /** A tab's content; each but the overview is loaded only while it is shown. */
  function panelOf(key: (typeof tabs)[number]): ReactNode {
    if (key !== current) return null;
    switch (key) {
      case undefined:
        return (
          <ParticipantOverview
            detail={detail}
            projectId={projectId}
            taTg={taTg}
            row={row}
            today={today}
            panel={panel}
            onPanel={setPanel}
            href={href}
            onOpen={open}
            available={available}
            onPrinted={setPrinted}
          />
        );
      // The tab reads the participant's self-service data.
      case "self-service":
        return <SelfServiceTab detail={detail} projectId={projectId} />;
      // Its sensitive blocks only on "Anzeigen" (data-protection.md, the profiling record).
      case "profiling":
        return <ProfilingTab detail={detail} projectId={projectId} />;
      // The ASU record (process-and-lifecycle.md, Arbeitsuchendmeldung).
      case "asu":
        return <AsuTab detail={detail} />;
      // The DSV (process-and-lifecycle.md, the DSV): the PL and back office in `ta_tg`.
      case "dsv":
        return <DsvTab participationId={participationId} projectId={projectId} />;
      case "documents":
        return <DocumentsTab detail={detail} />;
      // The bookings (data-protection.md, appointments).
      case "appointments":
        return <AppointmentsTab participationId={participationId} projectId={projectId} />;
      // The participant's reminders (data-protection.md).
      case "messages":
        return <MessagesTab participationId={participationId} />;
      // The funding and the legal holds (data-protection.md): the PL and back office.
      case "retention":
        return <RetentionTab participationId={participationId} />;
      // Opening the history is audited (data-protection.md).
      case "history":
        return (
          <HistoryTab
            participationId={participationId}
            projectId={projectId}
            withWaves={project.type === "ta_tg"}
          />
        );
    }
  }

  return (
    <>
      <PageHeader
        title={name || t("participant.title")}
        breadcrumbs={[
          // Ancestors, never the current page: each active only on exactly its own URL.
          <RouterLink key="projects" to="/projects" activeOptions={{ exact: true }}>
            {t("projects.title")}
          </RouterLink>,
          <RouterLink
            key="project"
            to="/projects/$projectId"
            params={{ projectId }}
            activeOptions={{ exact: true }}
          >
            {project.name}
          </RouterLink>,
          <RouterLink
            key="participants"
            to="/projects/$projectId"
            params={{ projectId }}
            search={{ ...listSearch?.filter, tab: "participants", sort: listSearch?.sort }}
            activeOptions={{ exact: true }}
          >
            {t("projectDetail.participants")}
          </RouterLink>,
        ]}
        tags={<TrackTags detail={detail} taTg={taTg} />}
        metadata={metadata}
        menuActions={menuActions}
      />
      {detail.hints.length > 0 && (
        <InlineNotification
          kind="warning"
          title={t("participant.hints.title")}
          hideCloseButton
          lowContrast
        >
          <ul className="tp-list">
            {detail.hints.map((hint) => (
              <li key={hint}>{t(`participant.hints.${hint}`)}</li>
            ))}
          </ul>
        </InlineNotification>
      )}
      {printed && (
        <RecoveryPrint
          printed={printed}
          projectId={projectId}
          onClose={() => setPrinted(null)}
          onChanged={async () => {
            await worklist.refetch();
          }}
        />
      )}
      {dialog === "remind" && item && (
        <BulkRemind
          projectId={projectId}
          selected={[item]}
          onSent={() => undefined}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "invite" && item && (
        <BulkInvite
          projectId={projectId}
          selected={[item]}
          onSent={() => undefined}
          onClose={() => setDialog(null)}
        />
      )}
      {withdrawnOnCorrection.element}
      {dialog === "contactStatus" && (
        <ContactStatusDialog detail={detail} onClose={() => setDialog(null)} />
      )}
      {dialog === "withdraw" && <WithdrawDialog detail={detail} onClose={() => setDialog(null)} />}
      {dialog === "reconcile" && (
        <ReconciliationDialog participationId={participationId} onClose={() => setDialog(null)} />
      )}
      {dialog === "endReason" && (
        <EndReasonDialog detail={detail} onClose={() => setDialog(null)} />
      )}
      {/* Mounted only while open: the tab "Selbstauskunft" has its own. */}
      {dialog === "assisted" && (
        <StartAssistedMode
          projectId={projectId}
          participationId={participationId}
          controlled={{ open: true, onClose: () => setDialog(null) }}
        />
      )}
      <Tabs
        selectedIndex={shown.indexOf(current)}
        onChange={({ selectedIndex }) => {
          const next = shown[selectedIndex];
          void navigate({ search: next ? { tab: next } : {}, replace: true, state: true });
        }}
      >
        <TabList aria-label={t("participant.tabs.label")}>
          {shown.map((key) => (
            <Tab key={key ?? "overview"}>
              {t(`participant.tabs.${tabLabels[key ?? "overview"]}`)}
            </Tab>
          ))}
        </TabList>
        {/* Each panel is named by its tab, never by a heading of its own (ui-patterns.md,
            principle 6). */}
        <TabPanels>
          {shown.map((key) => (
            <TabPanel key={key ?? "overview"}>{panelOf(key)}</TabPanel>
          ))}
        </TabPanels>
      </Tabs>
    </>
  );
}

/** The three tracks as three separate tags, each named (ui-patterns.md, C3). */
function TrackTags({ detail, taTg }: { detail: Detail; taTg: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      <StatusTag
        family="main"
        code={detail.status}
        prefix={t("participant.overview.tracks.main")}
      />
      <StatusTag
        family="profiling"
        code={detail.profilingStatus}
        prefix={t("participant.overview.tracks.profiling")}
      />
      {taTg && (
        <StatusTag
          family="dsv"
          code={detail.dsvStatus}
          prefix={t("participant.overview.tracks.dsv")}
        />
      )}
    </>
  );
}
