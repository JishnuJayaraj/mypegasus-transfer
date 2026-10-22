import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, createLink, type ErrorComponentProps } from "@tanstack/react-router";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  Button,
  Checkbox,
  formatDate,
  formatTimestamp,
  InlineNotification,
  Link,
  PageHeader,
  Select,
  SelectItem,
  SimpleTable,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  TextInput,
} from "@transfer/ui";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  entryWavesQuery,
  participantsQuery,
  participationActivationQuery,
  participationQuery,
  projectQuery,
  projectTeamQuery,
  useApi,
} from "../../api";
import { EntryWaveChoice } from "../../components/entry-wave-choice";
import { ParticipationDatesForm } from "../../components/participation-dates-form";
import { PlacementAgentur } from "../../components/placement-agentur";
import { RecoveryPanel } from "../../components/recovery";
import { RouteError } from "../../components/route-error";
import { SelfServiceTab } from "../../components/self-service-tab";
import { useConsultants } from "../../components/team";
import type de from "../../locales/de/translation.json";

type Detail = components["schemas"]["ParticipationDetail"];
type FieldKey = keyof typeof de.participant.fields;
const RouterLink = createLink(Link);

/** The tab shown: the overview, or "Selbstauskunft" (e.g. after assisted mode ended). */
type Search = { tab?: "self-service" };

export const Route = createFileRoute("/projects/$projectId_/participations/$participationId")({
  validateSearch: (search: Record<string, unknown>): Search =>
    search.tab === "self-service" ? { tab: "self-service" } : {},
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
 * One participant (process-and-lifecycle.md; data-protection.md, access matrix): person, contact,
 * status, placement Agentur, wave and contractual dates; the tab "Selbstauskunft" with what the
 * participant answered and assisted mode. The API sends only what the viewer may read: an absent
 * field isn't shown, a field without a value shows a dash. Actions follow the API's capabilities.
 */
function ParticipationPage() {
  const { t } = useTranslation();
  const { projectId, participationId } = Route.useParams();
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  const api = useApi();
  const { data: project } = useSuspenseQuery(projectQuery(api, projectId));
  const { data: detail } = useSuspenseQuery(participationQuery(api, participationId));
  // The loader refuses a participant of another project; the cache can't change that later.
  if (detail.projectId !== projectId) {
    return <InlineNotification kind="error" title={t("participant.notFound")} hideCloseButton />;
  }
  const { person, dates } = detail;
  const name = [person.lastName, person.firstName].filter(Boolean).join(", ");
  return (
    <>
      <RouterLink to="/projects/$projectId" params={{ projectId }}>
        {t("participant.back", { project: project.name })}
      </RouterLink>
      <PageHeader title={name || t("participant.title")} />
      {detail.hints.map((hint) => (
        <InlineNotification
          key={hint}
          kind="warning"
          title={t(`participant.hints.${hint}`)}
          hideCloseButton
        />
      ))}
      <Tabs
        selectedIndex={tab === "self-service" ? 1 : 0}
        onChange={({ selectedIndex }) =>
          void navigate({
            search: selectedIndex === 1 ? { tab: "self-service" } : {},
            replace: true,
          })
        }
      >
        <TabList aria-label={t("participant.tabs.label")}>
          <Tab>{t("participant.tabs.overview")}</Tab>
          <Tab>{t("participant.tabs.selfService")}</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
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
            />
            {person.workEmail !== undefined && <p>{t("participant.workEmailHint")}</p>}
            <Facts
              title={t("participant.status")}
              rows={[
                ["status", t(`participants.statuses.${detail.status}`)],
                ["profilingStatus", t(`participants.profilingStatuses.${detail.profilingStatus}`)],
                ["dsvStatus", t(`participants.dsvStatuses.${detail.dsvStatus}`)],
                ["tgEntryDate", date(dates.tgEntryDate)],
                ["exitDate", date(dates.exitDate)],
                ["withdrawnOn", date(dates.withdrawnOn)],
              ]}
            />
            <PlacementAgentur detail={detail} projectId={projectId} />
            <Assignments detail={detail} projectId={projectId} />
            <ActivationPanel detail={detail} projectId={projectId} />
            {project.type === "ta_tg" && <WaveAndDates detail={detail} projectId={projectId} />}
          </TabPanel>
          <TabPanel>
            {/* Loaded only when shown: the tab reads the participant's self-service data. */}
            {tab === "self-service" && <SelfServiceTab detail={detail} projectId={projectId} />}
          </TabPanel>
        </TabPanels>
      </Tabs>
    </>
  );
}

function ActivationPanel({ detail, projectId }: { detail: Detail; projectId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const mayRead = Object.values({
    issue: detail.capabilities.issueActivationCode,
    handover: detail.capabilities.recordHandover,
    revoke: detail.capabilities.revokeActivationCode,
    notice: detail.capabilities.providePrivacyNotice,
  }).some(Boolean);
  const query = useQuery({
    ...participationActivationQuery(api, detail.id),
    enabled: mayRead,
  });
  const [language, setLanguage] = useState<"de" | "en">("de");
  const [deliveryKind, setDeliveryKind] = useState<"email" | "sms">("email");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [identityChecked, setIdentityChecked] = useState(false);
  const [confirmReissue, setConfirmReissue] = useState(false);
  const [failed, setFailed] = useState(false);
  const refresh = async () => {
    setFailed(false);
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: participationActivationQuery(api, detail.id).queryKey,
      }),
      queryClient.invalidateQueries({ queryKey: participationQuery(api, detail.id).queryKey }),
      queryClient.invalidateQueries({ queryKey: participantsQuery(api, projectId).queryKey }),
    ]);
  };
  const send = useMutation({
    mutationFn: async () => {
      const { data } = await api.POST(
        "/api/v1/participations/{participationId}/activation-codes/in-person",
        {
          params: { path: { participationId: detail.id } },
          body: {
            deliveryKind,
            deliveryAddress,
            language,
            identityChecked: true,
            replaceOpenCode: confirmReissue,
          },
        },
      );
      if (!data) throw new Error("Activation delivery failed");
      return data;
    },
    onSuccess: async () => {
      setDeliveryAddress("");
      setIdentityChecked(false);
      setConfirmReissue(false);
      await refresh();
    },
    onError: () => setFailed(true),
  });
  const revoke = useMutation({
    mutationFn: async () => {
      const activationCodeId = query.data?.current?.activationCodeId;
      if (!activationCodeId) throw new Error("No activation code");
      const { data } = await api.POST(
        "/api/v1/participations/{participationId}/activation-codes/revocation",
        {
          params: { path: { participationId: detail.id } },
          body: { activationCodeId, reason: "lost" },
        },
      );
      if (!data) throw new Error("Revocation failed");
    },
    onSuccess: refresh,
    onError: () => setFailed(true),
  });
  const provideNotice = useMutation({
    mutationFn: async () => {
      const { data, response } = await api.POST(
        "/api/v1/participations/{participationId}/privacy-notices",
        {
          params: { path: { participationId: detail.id } },
          body: { language, method: "in_person_print", handedOver: true },
        },
      );
      if (!data && response.status !== 201) throw new Error("Notice handover failed");
    },
    onSuccess: refresh,
    onError: () => setFailed(true),
  });
  const status = query.data?.status ?? detail.activationStatus;
  const current = query.data?.current;
  const requiresReissueConfirmation = ["printed", "open", "delivery_unknown"].includes(status.code);
  // Expired codes are still open in the database; locked and used ones can't be revoked.
  const revocable = requiresReissueConfirmation || status.code === "expired";
  return (
    <section className="tp-section" aria-label={t("activation.detail.title")}>
      <h2>{t("activation.detail.title")}</h2>
      {failed && (
        <InlineNotification
          kind="error"
          title={t("activation.detail.failed")}
          onClose={() => setFailed(false)}
        />
      )}
      <dl className="tp-facts">
        <div>
          <dt>{t("activation.detail.status")}</dt>
          <dd>
            {status.account === "activated"
              ? status.code === "none"
                ? t("activation.status.activated")
                : t("activation.status.activatedRecovery", {
                    code: t(`activation.code.${status.code}`),
                  })
              : t(`activation.code.${status.code}`)}
          </dd>
        </div>
        {query.data?.account && (
          <>
            <div>
              <dt>{t("activation.detail.activatedAt")}</dt>
              <dd>{formatTimestamp(query.data.account.activatedAt)}</dd>
            </div>
            <div>
              <dt>{t("activation.detail.identityAssurance")}</dt>
              <dd>{t(`activation.assurance.${query.data.account.identityAssurance}`)}</dd>
            </div>
          </>
        )}
        <div>
          <dt>{t("activation.detail.notice")}</dt>
          <dd>
            {t(`activation.notice.${detail.privacyNoticeState.state}`, {
              dueOn: detail.privacyNoticeState.dueOn,
            })}
          </dd>
        </div>
        {current && (
          <>
            <div>
              <dt>{t("activation.detail.purpose")}</dt>
              <dd>{t(`activation.purpose.${current.purpose}`)}</dd>
            </div>
            <div>
              <dt>{t("activation.detail.channel")}</dt>
              <dd>{t(`activation.channel.${current.channel}`)}</dd>
            </div>
            <div>
              <dt>{t("activation.detail.issuedAt")}</dt>
              <dd>{formatTimestamp(current.issuedAt)}</dd>
            </div>
            <div>
              <dt>{t("activation.detail.issuedBy")}</dt>
              <dd>{current.issuedByDisplayName}</dd>
            </div>
            <div>
              <dt>{t("activation.detail.expiresAt")}</dt>
              <dd>{formatTimestamp(current.expiresAt)}</dd>
            </div>
            <div>
              <dt>{t("activation.detail.delivery")}</dt>
              <dd>
                {current.deliveryStatus ? t(`activation.delivery.${current.deliveryStatus}`) : "—"}
              </dd>
            </div>
            <div>
              <dt>{t("activation.detail.attempts")}</dt>
              <dd>{current.attemptsLeft}</dd>
            </div>
          </>
        )}
      </dl>
      {query.data && query.data.channels.length > 0 && (
        <>
          <h3>{t("activation.detail.channels")}</h3>
          {/* Q123 (data-protection.md): kind, states and dates; the address never reaches staff. */}
          <ul className="tp-list">
            {query.data.channels.map((channel) => (
              <li key={channel.id}>
                {t("activation.detail.channelLine", {
                  kind: t(`activation.deliveryKind.${channel.kind}`),
                  verifiedAt: formatTimestamp(channel.verifiedAt),
                  verifiedBy: t(`activation.verifiedBy.${channel.verifiedBy}`),
                  consentGivenAt: formatTimestamp(channel.consentGivenAt),
                })}{" "}
                {channel.noticeSentAt
                  ? t("activation.detail.noticeSent", { at: formatTimestamp(channel.noticeSentAt) })
                  : t("activation.detail.noticePending")}
                {channel.suspendedAt &&
                  !channel.removedAt &&
                  ` ${t("activation.detail.suspended", { at: formatTimestamp(channel.suspendedAt) })}`}
                {channel.removedAt &&
                  ` ${t("activation.detail.removed", { at: formatTimestamp(channel.removedAt) })}`}
              </li>
            ))}
          </ul>
        </>
      )}
      {(detail.capabilities.issueActivationCode || detail.capabilities.providePrivacyNotice) && (
        <Select
          id="activation-detail-language"
          labelText={t("activation.bulk.language")}
          value={language}
          onChange={(event) => setLanguage(event.target.value as "de" | "en")}
        >
          <SelectItem value="de" text="Deutsch" />
          <SelectItem value="en" text="English" />
        </Select>
      )}
      {detail.capabilities.issueActivationCode && status.account !== "activated" && (
        <fieldset className="tp-fieldset">
          <legend>{t("activation.detail.sendInPerson")}</legend>
          <Select
            id="activation-delivery-kind"
            labelText={t("activation.detail.deliveryKind")}
            value={deliveryKind}
            onChange={(event) => setDeliveryKind(event.target.value as "email" | "sms")}
          >
            <SelectItem value="email" text={t("activation.deliveryKind.email")} />
            <SelectItem value="sms" text={t("activation.deliveryKind.sms")} />
          </Select>
          <TextInput
            id="activation-delivery-address"
            labelText={t("activation.detail.deliveryAddress")}
            value={deliveryAddress}
            onChange={(event) => setDeliveryAddress(event.target.value)}
            autoComplete="off"
          />
          <Checkbox
            id="activation-identity-checked"
            labelText={t("activation.detail.identityChecked")}
            checked={identityChecked}
            onChange={(_, { checked }) => setIdentityChecked(checked)}
          />
          {requiresReissueConfirmation && (
            <Checkbox
              id="activation-confirm-reissue"
              labelText={t("activation.detail.confirmReissue")}
              checked={confirmReissue}
              onChange={(_, { checked }) => setConfirmReissue(checked)}
            />
          )}
          <Button
            disabled={
              !deliveryAddress ||
              !identityChecked ||
              (requiresReissueConfirmation && !confirmReissue) ||
              send.isPending
            }
            onClick={() => send.mutate()}
          >
            {t("activation.detail.send")}
          </Button>
        </fieldset>
      )}
      {detail.capabilities.issueActivationCode && status.account === "activated" && (
        <RecoveryPanel
          participationId={detail.id}
          projectId={projectId}
          language={language}
          openCode={requiresReissueConfirmation}
          onChanged={refresh}
        />
      )}
      <div className="tp-bulk-actions">
        {detail.capabilities.revokeActivationCode && current && revocable && (
          <Button
            kind="danger--tertiary"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate()}
          >
            {t("activation.detail.revoke")}
          </Button>
        )}
        {detail.capabilities.providePrivacyNotice &&
          detail.privacyNoticeState.state !== "provided" && (
            <Button
              kind="secondary"
              disabled={provideNotice.isPending}
              onClick={() => provideNotice.mutate()}
            >
              {t("activation.detail.noticeHandedOver")}
            </Button>
          )}
        {detail.capabilities.issueActivationCode && status.account !== "activated" && (
          <RouterLink to="/projects/$projectId" params={{ projectId }}>
            {t("activation.detail.issuePrint")}
          </RouterLink>
        )}
      </div>
    </section>
  );
}

/**
 * The consultants the participant is assigned to (Q62); the PL assigns another consultant of the
 * project or ends an assignment (`capabilities.assignParticipations`). Access follows at once.
 */
function Assignments({ detail, projectId }: { detail: Detail; projectId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const { consultants } = useConsultants(projectId);
  const [staffUserId, setStaffUserId] = useState("");
  const [failed, setFailed] = useState(false);
  const may = detail.capabilities.assignParticipations;
  const refresh = async () => {
    setFailed(false);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: participationQuery(api, detail.id).queryKey }),
      queryClient.invalidateQueries({ queryKey: participantsQuery(api, projectId).queryKey }),
    ]);
  };
  const assign = useMutation({
    mutationFn: () =>
      api.POST("/api/v1/projects/{projectId}/assignments", {
        params: { path: { projectId } },
        body: { staffUserId, participationIds: [detail.id] },
      }),
    onSuccess: async () => {
      setStaffUserId("");
      await refresh();
    },
    onError: () => setFailed(true),
  });
  const unassign = useMutation({
    mutationFn: (consultant: string) =>
      api.DELETE("/api/v1/participations/{participationId}/assignments/{staffUserId}", {
        params: { path: { participationId: detail.id, staffUserId: consultant } },
      }),
    onSuccess: refresh,
    onError: () => setFailed(true),
  });
  const assigned = new Set(detail.assignments.map((a) => a.staffUserId));
  const rows = detail.assignments.map((a) => ({
    id: a.staffUserId,
    displayName: a.displayName,
    assignedAt: formatTimestamp(a.assignedAt),
    actions: may && (
      <Button
        kind="ghost"
        size="sm"
        disabled={unassign.isPending}
        onClick={() => unassign.mutate(a.staffUserId)}
      >
        {t("participant.assignments.unassign", { name: a.displayName })}
      </Button>
    ),
  }));
  return (
    <section className="tp-section" aria-label={t("participant.assignments.title")}>
      {failed && (
        <InlineNotification
          kind="error"
          title={t("participant.assignments.failed")}
          onClose={() => setFailed(false)}
        />
      )}
      <SimpleTable
        title={t("participant.assignments.title")}
        columns={(may
          ? (["displayName", "assignedAt", "actions"] as const)
          : (["displayName", "assignedAt"] as const)
        ).map((key) => ({ key, header: t(`participant.assignments.columns.${key}`) }))}
        rows={rows}
        emptyState={t("participant.assignments.empty")}
      />
      {may && (
        <div className="tp-bulk-actions">
          <Select
            id="participant-assign"
            labelText={t("participants.assignTo")}
            value={staffUserId}
            onChange={(event) => setStaffUserId(event.target.value)}
          >
            <SelectItem value="" text={t("participants.chooseConsultant")} />
            {consultants
              .filter((c) => !assigned.has(c.staffUserId))
              .map((c) => (
                <SelectItem key={c.staffUserId} value={c.staffUserId} text={c.displayName} />
              ))}
          </Select>
          <Button
            kind="secondary"
            disabled={!staffUserId || assign.isPending}
            onClick={() => assign.mutate()}
          >
            {t("participant.assignments.assign")}
          </Button>
        </div>
      )}
    </section>
  );
}

const date = (value: string | null | undefined) =>
  value === undefined ? undefined : formatDate(value);
const address = (value: Detail["person"]["address"]) =>
  value && `${value.street}, ${value.postalCode} ${value.city}, ${value.country}`;

function WaveAndDates({ detail, projectId }: { detail: Detail; projectId: string }) {
  const { t } = useTranslation();
  const { entryWave: wave, dates } = detail;
  // Where a contractual date comes from: the participation's own, else the wave's
  // (process-and-lifecycle.md, Dates).
  const source = (own: string | null, effective: string | null) =>
    effective === null
      ? null
      : `${formatDate(effective)} (${t(own === null ? "participant.fromWave" : "participant.individual")})`;
  return (
    <>
      <Facts
        title={t("participant.waveAndDates")}
        rows={[
          ["wave", wave ? `${wave.code} – ${wave.name}` : null],
          // The wave's own four dates, also where individual dates override them.
          ["signingDeadline", wave && formatDate(wave.signingDeadline)],
          ["defaultTgStart", wave && formatDate(wave.defaultTgStart)],
          ["defaultTgEnd", wave && formatDate(wave.defaultTgEnd)],
          ["latestEntryDate", wave && formatDate(wave.latestEntryDate)],
          ["offerDeadline", date(dates.offerDeadline)],
          ["tgStart", source(dates.tgStart, dates.effectiveTgStart)],
          ["tgEnd", source(dates.tgEnd, dates.effectiveTgEnd)],
        ]}
      />
      <EntryWaveChoice detail={detail} projectId={projectId} />
      <ParticipationDatesForm detail={detail} />
      <Amendments detail={detail} />
      <ReportingTasks detail={detail} />
    </>
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
    <section className="tp-section" aria-label={t("participant.amendments.title")}>
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

/**
 * The BA reporting tasks (process-and-lifecycle.md, "BA reporting"): pending until the
 * Agentur-submission slice records them.
 */
function ReportingTasks({ detail }: { detail: Detail }) {
  const { t } = useTranslation();
  if (detail.baReportingTasks === undefined) return null;
  const rows = detail.baReportingTasks.map((task) => ({
    id: task.id,
    reportingKind: t(`participant.tasks.kinds.${task.reportingKind}`),
    subjectDate: formatDate(task.subjectDate),
    createdAt: formatTimestamp(task.createdAt),
    status: t(`participant.tasks.statuses.${task.status}`),
  }));
  const columns = ["reportingKind", "subjectDate", "createdAt", "status"] as const;
  return (
    <section className="tp-section" aria-label={t("participant.tasks.title")}>
      <SimpleTable
        title={t("participant.tasks.title")}
        columns={columns.map((key) => ({ key, header: t(`participant.tasks.columns.${key}`) }))}
        rows={rows}
        emptyState={t("participant.tasks.empty")}
      />
    </section>
  );
}

/** A titled list of label/value pairs; `undefined` (not readable) hides the row. */
function Facts({ title, rows }: { title: string; rows: [FieldKey, ReactNode][] }) {
  const { t } = useTranslation();
  const shown = rows.filter(([, value]) => value !== undefined);
  if (shown.length === 0) return null;
  return (
    <section className="tp-section" aria-label={title}>
      <h2>{title}</h2>
      <dl className="tp-facts">
        {shown.map(([key, value]) => (
          <div key={key}>
            <dt>{t(`participant.fields.${key}`)}</dt>
            <dd>{value === null || value === "" ? "—" : value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
