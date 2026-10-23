import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, createLink, type ErrorComponentProps } from "@tanstack/react-router";
import { ApiProblemError, type components } from "@transfer/api-client";
import { matchesSearch, searchKey, terminalMainStatuses } from "@transfer/domain";
import {
  Button,
  ButtonSet,
  formatDate,
  formatTimestamp,
  InlineNotification,
  Link,
  Modal,
  PageHeader,
  Select,
  SelectItem,
  SimpleTable,
  Stack,
  TextInput,
  useToast,
} from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  appointmentBookingsQuery,
  appointmentQuery,
  entryWavesQuery,
  projectQuery,
  projectTeamQuery,
  useApi,
  worklistQuery,
} from "../../api";
import {
  AppointmentForm,
  problemCodes,
  useHostName,
  useSeats,
  useWhen,
  type Appointment,
} from "../../components/appointments";
import {
  AttendanceDialog,
  BookingAttendanceActions,
  useAttendanceLabel,
} from "../../components/attendance";
import { RouteError } from "../../components/route-error";

type CancelReason = NonNullable<components["schemas"]["AppointmentCancelInput"]["reason"]>;
const cancelReasons: CancelReason[] = [
  "organiser_unavailable",
  "too_few_bookings",
  "did_not_take_place",
  "created_in_error",
  "other",
];
const RouterLink = createLink(Link);
const name = (row: { lastName: string | null; firstName: string | null }) =>
  [row.lastName, row.firstName].filter(Boolean).join(", ");

export const Route = createFileRoute("/projects/$projectId_/appointments/$appointmentId")({
  loader: async ({ context: { api, queryClient }, params: { projectId, appointmentId } }) => {
    const [project, appointment] = await Promise.all([
      queryClient.ensureQueryData(projectQuery(api, projectId)),
      queryClient.ensureQueryData(appointmentQuery(api, appointmentId)),
    ]);
    // The appointment must belong to the project in the URL; anything else is not found.
    if (appointment.projectId !== projectId) {
      throw new ApiProblemError({
        type: "urn:transfer:problem:not-found",
        title: "Not found",
        status: 404,
      });
    }
    await queryClient.ensureQueryData(projectTeamQuery(api, projectId));
    if (project.type === "ta_tg")
      await queryClient.ensureQueryData(entryWavesQuery(api, projectId));
  },
  component: AppointmentPage,
  errorComponent: AppointmentError,
});

function AppointmentError(props: ErrorComponentProps) {
  const { t } = useTranslation();
  const { error } = props;
  if (error instanceof ApiProblemError && [403, 404].includes(error.status)) {
    const key = error.status === 403 ? "appointments.forbidden" : "appointments.notFound";
    return <InlineNotification kind="error" title={t(key)} hideCloseButton />;
  }
  return <RouteError {...props} />;
}

/**
 * One appointment (process-and-lifecycle.md, appointments): its details, "Ändern",
 * "Gastgeber·in ändern" (the PL), "Absagen" with a reason or the PL's "Fand nicht statt
 * (Korrektur)", the bookings the viewer may list with their attendance, "Teilnehmende buchen" and
 * "Teilnahme erfassen". Every action follows the API's capabilities.
 */
function AppointmentPage() {
  const { t } = useTranslation();
  const { projectId, appointmentId } = Route.useParams();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const when = useWhen();
  const seats = useSeats();
  const hostName = useHostName(projectId);
  const { data: project } = useSuspenseQuery(projectQuery(api, projectId));
  const { data: appointment } = useSuspenseQuery(appointmentQuery(api, appointmentId));
  const waves = useQuery({ ...entryWavesQuery(api, projectId), enabled: project.type === "ta_tg" });
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["appointments", appointmentId] }),
      queryClient.invalidateQueries({ queryKey: ["projects", projectId, "appointments"] }),
      queryClient.invalidateQueries({ queryKey: ["participations"] }),
    ]);
  if (appointment.projectId !== projectId) {
    return <InlineNotification kind="error" title={t("appointments.notFound")} hideCloseButton />;
  }
  const { capabilities } = appointment;
  const audience =
    appointment.kind !== "info_event"
      ? null
      : appointment.audienceWaveId === null
        ? t("appointments.form.wholeProject")
        : t("appointments.form.wave", {
            code: waves.data?.find((wave) => wave.id === appointment.audienceWaveId)?.code ?? "",
          });
  const facts: [string, string | null][] = [
    ["kind", t(`appointments.kinds.${appointment.kind}`)],
    ["when", when(appointment)],
    ["bookingClosesAt", formatTimestamp(appointment.bookingClosesAt)],
    ["title", appointment.title],
    ["venue", appointment.venue],
    ["host", appointment.kind === "consultation" ? hostName(appointment.hostStaffUserId) : null],
    ["audience", audience],
    ["capacity", String(appointment.capacity)],
    ["bookings", seats(appointment.bookings, appointment.capacity)],
    ["status", t(`appointments.statuses.${appointment.status}`)],
    [
      "cancelReason",
      appointment.cancelReason ? t(`appointments.cancelReasons.${appointment.cancelReason}`) : null,
    ],
  ];
  return (
    <>
      <RouterLink to="/projects/$projectId" params={{ projectId }} search={{ tab: "appointments" }}>
        {t("appointments.page.back", { project: project.name })}
      </RouterLink>
      <PageHeader
        title={[t(`appointments.kinds.${appointment.kind}`), appointment.title]
          .filter(Boolean)
          .join(" – ")}
      />
      {appointment.needsResolution ? (
        <InlineNotification
          kind="warning"
          title={t("appointments.page.resolution", { count: appointment.needsResolution })}
          hideCloseButton
        />
      ) : null}
      <section className="tp-section" aria-labelledby="appointment-details">
        <h2 id="appointment-details">{t("appointments.page.details")}</h2>
        <dl className="tp-facts">
          {facts
            .filter(([, value]) => value !== null)
            .map(([key, value]) => (
              <div key={key}>
                <dt>{t(`appointments.page.facts.${key}` as never)}</dt>
                <dd>{value}</dd>
              </div>
            ))}
        </dl>
        {!editing && (
          <ButtonSet>
            {capabilities.change && (
              <Button kind="secondary" onClick={() => setEditing(true)}>
                {t("appointments.page.change")}
              </Button>
            )}
            {capabilities.cancel && (
              <Button kind="danger--tertiary" onClick={() => setCancelling(true)}>
                {t("appointments.page.cancel")}
              </Button>
            )}
            {capabilities.correctNotTakenPlace && (
              <Button kind="danger--tertiary" onClick={() => setCorrecting(true)}>
                {t("appointments.attendance.notTakenPlace")}
              </Button>
            )}
          </ButtonSet>
        )}
        {editing && (
          <AppointmentForm
            projectId={projectId}
            taTg={project.type === "ta_tg"}
            kind={appointment.kind}
            chooseHost={false}
            appointment={appointment}
            onCancel={() => setEditing(false)}
            onSaved={async () => {
              await refresh();
              showToast({ title: t("appointments.saved") });
              setEditing(false);
            }}
          />
        )}
        {capabilities.changeHost && !editing && (
          <HostChange appointment={appointment} projectId={projectId} onSaved={refresh} />
        )}
      </section>
      <CancelAppointment
        appointment={appointment}
        open={cancelling}
        onClose={() => setCancelling(false)}
        onCancelled={async () => {
          await refresh();
          showToast({ title: t("appointments.page.cancelled") });
          setCancelling(false);
        }}
      />
      {correcting && (
        <NotTakenPlace
          appointment={appointment}
          onClose={() => setCorrecting(false)}
          onCorrected={async () => {
            await refresh();
            showToast({ title: t("appointments.attendance.notTakenPlaceDone") });
            setCorrecting(false);
          }}
        />
      )}
      <Bookings appointment={appointment} projectId={projectId} onChanged={refresh} />
    </>
  );
}

/** "Gastgeber·in ändern": a PL or consultant of the project, with the version read. */
function HostChange({
  appointment,
  projectId,
  onSaved,
}: {
  appointment: Appointment;
  projectId: string;
  onSaved: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const showToast = useToast();
  const { data: team } = useSuspenseQuery(projectTeamQuery(api, projectId));
  const [host, setHost] = useState("");
  const [error, setError] = useState<string>();
  const hosts = team.members.filter(
    (member) =>
      !member.deactivated &&
      member.staffUserId !== appointment.hostStaffUserId &&
      (member.roles.includes("project_lead") || member.roles.includes("consultant")),
  );
  const save = useMutation({
    mutationFn: async () => {
      const { data } = await api.POST("/api/v1/appointments/{appointmentId}/host", {
        params: { path: { appointmentId: appointment.id } },
        body: { expectedVersion: appointment.version, hostStaffUserId: host },
      });
      return data!;
    },
    onSuccess: async () => {
      setError(undefined);
      setHost("");
      await onSaved();
      showToast({ title: t("appointments.page.hostSaved") });
    },
    onError: (failure) => setError(problemCodes(failure)[0]!.code),
  });
  return (
    <Stack gap={4}>
      <Select
        id="appointment-new-host"
        labelText={t("appointments.page.changeHost")}
        value={host}
        onChange={(event) => setHost(event.target.value)}
        invalid={error !== undefined}
        invalidText={error ? t(`appointments.errors.${error}` as never) : undefined}
      >
        <SelectItem value="" text={t("appointments.page.chooseHint")} />
        {hosts.map((member) => (
          <SelectItem
            key={member.staffUserId}
            value={member.staffUserId}
            text={member.displayName}
          />
        ))}
      </Select>
      <Button kind="tertiary" disabled={!host || save.isPending} onClick={() => save.mutate()}>
        {t("appointments.page.changeHost")}
      </Button>
    </Stack>
  );
}

/** "Absagen" with a closed reason and the confirmation that every booking goes with it. */
function CancelAppointment({
  appointment,
  open,
  onClose,
  onCancelled,
}: {
  appointment: Appointment;
  open: boolean;
  onClose: () => void;
  onCancelled: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const [reason, setReason] = useState<CancelReason | "">("");
  const cancel = useMutation({
    mutationFn: async () => {
      const { data } = await api.POST("/api/v1/appointments/{appointmentId}/cancellation", {
        params: { path: { appointmentId: appointment.id } },
        body: { reason: reason as CancelReason },
      });
      return data!;
    },
    onSuccess: onCancelled,
  });
  if (!open) return null;
  return (
    <Modal
      open
      danger
      modalHeading={t("appointments.page.cancelTitle")}
      primaryButtonText={t("appointments.page.cancelSubmit")}
      secondaryButtonText={t("appointments.form.cancel")}
      primaryButtonDisabled={!reason || cancel.isPending}
      onRequestClose={onClose}
      onRequestSubmit={() => cancel.mutate()}
    >
      <Stack gap={5}>
        <p>{t("appointments.page.cancelText")}</p>
        {cancel.isError && (
          <InlineNotification
            kind="error"
            title={t(`appointments.errors.${problemCodes(cancel.error)[0]!.code}` as never)}
            hideCloseButton
          />
        )}
        <Select
          id="appointment-cancel-reason"
          labelText={t("appointments.page.reason")}
          value={reason}
          onChange={(event) => setReason(event.target.value as CancelReason)}
        >
          <SelectItem value="" text={t("appointments.page.chooseHint")} />
          {cancelReasons.map((code) => (
            <SelectItem key={code} value={code} text={t(`appointments.cancelReasons.${code}`)} />
          ))}
        </Select>
      </Stack>
    </Modal>
  );
}

/**
 * "Fand nicht statt (Korrektur)" (the PL; process-and-lifecycle.md, appointments): with absences
 * only recorded, the appointment is cancelled `did_not_take_place` and each absence superseded.
 */
function NotTakenPlace({
  appointment,
  onClose,
  onCorrected,
}: {
  appointment: Appointment;
  onClose: () => void;
  onCorrected: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const correct = useMutation({
    mutationFn: async () => {
      await api.POST("/api/v1/appointments/{appointmentId}/cancellation", {
        params: { path: { appointmentId: appointment.id } },
        body: { reason: "did_not_take_place" },
      });
    },
    onSuccess: onCorrected,
  });
  return (
    <Modal
      open
      danger
      modalHeading={t("appointments.attendance.notTakenPlaceTitle")}
      primaryButtonText={t("appointments.attendance.notTakenPlace")}
      secondaryButtonText={t("appointments.form.cancel")}
      primaryButtonDisabled={correct.isPending}
      onRequestClose={onClose}
      onRequestSubmit={() => correct.mutate()}
    >
      <Stack gap={5}>
        <p>{t("appointments.attendance.notTakenPlaceText")}</p>
        {correct.isError && (
          <InlineNotification
            kind="error"
            title={t(`appointments.errors.${problemCodes(correct.error)[0]!.code}` as never)}
            hideCloseButton
          />
        )}
      </Stack>
    </Modal>
  );
}

/**
 * The bookings the viewer may list, "Buchung absagen" per booking, and "Teilnehmende buchen" from
 * the viewer's work list snapshot (the name search stays in this component's state).
 */
function Bookings({
  appointment,
  projectId,
  onChanged,
}: {
  appointment: Appointment;
  projectId: string;
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const showToast = useToast();
  const bookings = useQuery(appointmentBookingsQuery(api, appointment.id));
  const attendanceLabel = useAttendanceLabel();
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const cancel = useMutation({
    mutationFn: async (bookingId: string) => {
      await api.POST("/api/v1/appointment-bookings/{bookingId}/cancellation", {
        params: { path: { bookingId } },
        body: {},
      });
    },
    onSuccess: async () => {
      setCancelling(null);
      await onChanged();
      showToast({ title: t("appointments.page.bookingCancelled") });
    },
  });
  return (
    <section className="tp-section" aria-labelledby="appointment-bookings">
      <h2 id="appointment-bookings">{t("appointments.page.bookings")}</h2>
      {appointment.capabilities.book && (
        <BookParticipant appointment={appointment} projectId={projectId} onBooked={onChanged} />
      )}
      {appointment.capabilities.recordAttendance && (
        <Button kind="secondary" onClick={() => setRecording(true)}>
          {t("appointments.attendance.record")}
        </Button>
      )}
      {recording && (
        <AttendanceDialog
          appointment={appointment}
          bookings={bookings.data?.items ?? []}
          projectId={projectId}
          onClose={() => setRecording(false)}
          onRecorded={onChanged}
        />
      )}
      <SimpleTable
        title={t("appointments.page.bookings")}
        columns={(
          [
            "name",
            "personnelNumber",
            "status",
            "origin",
            "bookedAt",
            "attendance",
            "actions",
          ] as const
        ).map((key) => ({ key, header: t(`appointments.page.bookingColumns.${key}`) }))}
        rows={(bookings.data?.items ?? []).map((row) => ({
          id: row.id,
          name: name(row),
          personnelNumber: row.personnelNumber ?? "",
          status: [
            t(`appointments.bookingStatuses.${row.status}`),
            row.cancelReason && t(`appointments.bookingCancelReasons.${row.cancelReason}`),
            row.needsResolution && t("appointments.page.needsResolution"),
          ]
            .filter(Boolean)
            .join(" · "),
          origin: t(`appointments.origins.${row.origin}`),
          bookedAt: formatTimestamp(row.bookedAt),
          attendance: attendanceLabel(row),
          actions: (
            <>
              {row.capabilities.cancel && (
                <Button kind="ghost" size="sm" onClick={() => setCancelling(row.id)}>
                  {t("appointments.page.cancelBooking")}
                </Button>
              )}
              <BookingAttendanceActions
                booking={row}
                appointmentId={appointment.id}
                onChanged={onChanged}
              />
            </>
          ),
        }))}
        emptyState={t("appointments.page.bookingsEmpty")}
      />
      {cancelling && (
        <Modal
          open
          danger
          modalHeading={t("appointments.page.cancelBookingTitle")}
          primaryButtonText={t("appointments.page.cancelBooking")}
          secondaryButtonText={t("appointments.form.cancel")}
          primaryButtonDisabled={cancel.isPending}
          onRequestClose={() => setCancelling(null)}
          onRequestSubmit={() => cancel.mutate(cancelling)}
        >
          <p>{t("appointments.page.cancelBookingText")}</p>
          {cancel.isError && (
            <InlineNotification
              kind="error"
              title={t(`appointments.errors.${problemCodes(cancel.error)[0]!.code}` as never)}
              hideCloseButton
            />
          )}
        </Modal>
      )}
    </section>
  );
}

/** "Teilnehmende buchen": a person from the snapshot, then the API's warnings or refusal. */
function BookParticipant({
  appointment,
  projectId,
  onBooked,
}: {
  appointment: Appointment;
  projectId: string;
  onBooked: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const showToast = useToast();
  const worklist = useQuery(worklistQuery(api, projectId));
  const [term, setTerm] = useState("");
  const [chosen, setChosen] = useState("");
  const [error, setError] = useState<string>();
  const open = (worklist.data?.items ?? []).filter(
    (item) => !terminalMainStatuses.has(item.status),
  );
  const label = (item: (typeof open)[number]) =>
    `${[item.lastName, item.firstName].filter(Boolean).join(", ")} (${item.personnelNumber ?? "—"})`;
  const matches = term.trim()
    ? open.filter((item) => matchesSearch(searchKey(label(item)), term)).slice(0, 25)
    : [];
  const book = useMutation({
    mutationFn: async () => {
      const { data } = await api.POST("/api/v1/appointments/{appointmentId}/bookings", {
        params: { path: { appointmentId: appointment.id } },
        body: { participationId: chosen },
      });
      return data!;
    },
    onSuccess: async (result) => {
      setError(undefined);
      setChosen("");
      setTerm("");
      await onBooked();
      showToast({
        title: t("appointments.page.booked"),
        subtitle: result.warnings
          .map((warning) =>
            t(`appointments.warnings.${warning.code}`, {
              date: formatDate(warning.latestEntryDate),
            }),
          )
          .join(" "),
      });
    },
    onError: (failure) => setError(problemCodes(failure)[0]!.code),
  });
  return (
    <Stack gap={4}>
      <h3>{t("appointments.page.book")}</h3>
      <TextInput
        id="appointment-book-search"
        labelText={t("appointments.page.search")}
        autoComplete="off"
        value={term}
        onChange={(event) => {
          setTerm(event.target.value);
          setChosen("");
        }}
      />
      {term.trim() && matches.length === 0 && <p>{t("appointments.page.noMatch")}</p>}
      {matches.length > 0 && (
        <Select
          id="appointment-book-choice"
          labelText={t("appointments.page.choose")}
          value={chosen}
          onChange={(event) => setChosen(event.target.value)}
        >
          <SelectItem value="" text={t("appointments.page.chooseHint")} />
          {matches.map((item) => (
            <SelectItem key={item.id} value={item.id} text={label(item)} />
          ))}
        </Select>
      )}
      {error && (
        <InlineNotification
          kind="error"
          title={t(`appointments.errors.${error}` as never)}
          hideCloseButton
        />
      )}
      <Button disabled={!chosen || book.isPending} onClick={() => book.mutate()}>
        {t("appointments.page.bookSubmit")}
      </Button>
    </Stack>
  );
}
