import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import { matchesSearch, searchKey, terminalMainStatuses } from "@transfer/domain";
import {
  Button,
  Checkbox,
  InlineNotification,
  Modal,
  Select,
  SelectItem,
  SimpleTable,
  Stack,
  TextInput,
  useToast,
} from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi, worklistQuery } from "../api";
import { problemCodes, type Appointment } from "./appointments";

// Attendance and `informed` in the staff app (process-and-lifecycle.md and data-protection.md,
// appointments: attendance): "Teilnahme erfassen" and the actions on one booking. Recording what
// happened and confirming what it rests on are two steps; every button follows the API's
// capabilities, and the database decides again.

type Booking = components["schemas"]["AppointmentBooking"];
type AttendanceValue = NonNullable<Booking["attendance"]>;
type AfterCloseReason = NonNullable<Booking["afterCloseReason"]>;
/** The attendance fields and capabilities a booking carries on both pages. */
export type BookingAttendance = Pick<
  Booking,
  | "id"
  | "attendance"
  | "afterCloseReason"
  | "informedBasis"
  | "superseded"
  | "conflict"
  | "conflictResolution"
  | "capabilities"
>;

const afterCloseReasons: AfterCloseReason[] = ["late_entry", "correction"];
const beforeInformed = new Set(["imported", "contacted", "unreachable"]);
const name = (row: { lastName?: string | null; firstName?: string | null }) =>
  [row.lastName, row.firstName].filter(Boolean).join(", ");

/** "teilgenommen · Grundlage für informiert · Klärung offen" and the like. */
export function useAttendanceLabel() {
  const { t } = useTranslation();
  return (booking: BookingAttendance) =>
    [
      booking.attendance ? t(`appointments.attendance.values.${booking.attendance}`) : "—",
      booking.afterCloseReason &&
        t(`appointments.attendance.afterCloseReasons.${booking.afterCloseReason}`),
      booking.superseded && t("appointments.attendance.superseded"),
      booking.informedBasis && t("appointments.attendance.basis"),
      booking.conflict && t(`appointments.attendance.conflicts.${booking.conflict}`),
      booking.conflictResolution &&
        t(`appointments.attendance.resolutions.${booking.conflictResolution}`),
    ]
      .filter(Boolean)
      .join(" · ");
}

/** Each refused row's name and code, or the request's own refusal (ADR-0010: `/entries/<i>`). */
function refusalLines(
  error: unknown,
  rowName: (index: number) => string,
  text: (code: string) => string,
) {
  const errors =
    error instanceof ApiProblemError && error.status === 422 ? (error.problem.errors ?? []) : [];
  if (errors.length === 0) return problemCodes(error).map(({ code }) => text(code));
  return errors.map((item) => {
    const index = /^\/entries\/(\d+)$/.exec(item.pointer ?? "")?.[1];
    return index === undefined ? text(item.code) : `${rowName(Number(index))}: ${text(item.code)}`;
  });
}

type Row = {
  participationId: string;
  label: string;
  attended: boolean;
  absent: boolean;
  offerInformed: boolean;
  afterClose: boolean;
  walkIn: boolean;
};

/**
 * "Teilnahme erfassen": per booking not yet recorded "teilgenommen" (from the start) or "nicht
 * erschienen" (after the end), "als informiert erfassen" on an attended row before `informed`
 * (preselected for an info event, never for a consultation), the confirmation "Die erforderlichen
 * Informationen wurden vermittelt" (unticked; a ticked row without it is refused here), the
 * closed-case flow's reason, and "Ohne Buchung erschienen" from the work list snapshot.
 */
export function AttendanceDialog({
  appointment,
  bookings,
  projectId,
  onClose,
  onRecorded,
}: {
  appointment: Appointment;
  bookings: Booking[];
  projectId: string;
  onClose: () => void;
  onRecorded: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const showToast = useToast();
  const worklist = useQuery(worklistQuery(api, projectId));
  const infoEvent = appointment.kind === "info_event";
  const booked: Row[] = bookings
    .filter(
      (booking) =>
        booking.status === "booked" &&
        booking.attendance === null &&
        (booking.capabilities.recordAttended || booking.capabilities.recordAbsent),
    )
    .map((booking) => ({
      participationId: booking.participationId,
      label: `${name(booking)} (${booking.personnelNumber ?? "—"})`,
      attended: booking.capabilities.recordAttended,
      absent: booking.capabilities.recordAbsent,
      offerInformed: booking.capabilities.offerInformed,
      afterClose: booking.capabilities.afterClose,
      walkIn: false,
    }));
  const [walkIns, setWalkIns] = useState<Row[]>([]);
  const rows = [...booked, ...walkIns];
  const [values, setValues] = useState<Record<string, { attendance: string; informed: boolean }>>(
    {},
  );
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState<AfterCloseReason | "">("");
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [term, setTerm] = useState("");
  const entries = rows.flatMap((row) => {
    const value = values[row.participationId];
    if (!value?.attendance) return [];
    const attendance = value.attendance as AttendanceValue;
    return [
      {
        row,
        entry: {
          participationId: row.participationId,
          attendance,
          markInformed: attendance === "attended" && row.offerInformed && value.informed,
        },
      },
    ];
  });
  const ticked = entries.some(({ entry }) => entry.markInformed);
  const needsReason = entries.some(({ row }) => row.afterClose);
  const save = useMutation({
    mutationFn: async () => {
      const { data } = await api.POST("/api/v1/appointments/{appointmentId}/attendance", {
        params: { path: { appointmentId: appointment.id } },
        body: {
          entries: entries.map(({ entry }) => entry),
          informationDelivered: confirmed,
          afterCloseReason: needsReason && reason ? reason : null,
        },
      });
      return data!;
    },
    onSuccess: async (result) => {
      await onRecorded();
      showToast({
        title: t("appointments.attendance.recorded", {
          recorded: result.recorded,
          informed: result.informed,
        }),
      });
      onClose();
    },
  });
  const choose = (row: Row, attendance: string) =>
    setValues((current) => ({
      ...current,
      // "als informiert erfassen" is preselected for an info event, never for a consultation.
      [row.participationId]: { attendance, informed: attendance === "attended" && infoEvent },
    }));
  const known = new Set([
    ...bookings.filter((b) => b.status === "booked").map((b) => b.participationId),
    ...walkIns.map((row) => row.participationId),
  ]);
  const candidates = (worklist.data?.items ?? []).filter(
    (item) => !terminalMainStatuses.has(item.status) && !known.has(item.id),
  );
  const candidateLabel = (item: (typeof candidates)[number]) =>
    `${name(item)} (${item.personnelNumber ?? "—"})`;
  const matches = term.trim()
    ? candidates.filter((item) => matchesSearch(searchKey(candidateLabel(item)), term)).slice(0, 25)
    : [];
  const submit = () => {
    if (ticked && !confirmed) {
      setUnconfirmed(true);
      return;
    }
    save.mutate();
  };
  const rowName = (index: number) => entries[index]?.row.label ?? "";
  return (
    <Modal
      open
      size="lg"
      modalHeading={t("appointments.attendance.title")}
      primaryButtonText={t("appointments.attendance.submit")}
      secondaryButtonText={t("appointments.form.cancel")}
      primaryButtonDisabled={entries.length === 0 || (needsReason && !reason) || save.isPending}
      onRequestClose={onClose}
      onRequestSubmit={submit}
    >
      <Stack gap={5}>
        <p>{t("appointments.attendance.intro")}</p>
        {save.isError && (
          <div>
            <InlineNotification
              kind="error"
              title={t("appointments.attendance.refused")}
              hideCloseButton
            />
            <ul>
              {refusalLines(save.error, rowName, (code) =>
                t(`appointments.errors.${code}` as never),
              ).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
        <SimpleTable
          title={t("appointments.attendance.rows")}
          columns={(["name", "attendance", "informed"] as const).map((key) => ({
            key,
            header: t(`appointments.attendance.columns.${key}`),
          }))}
          rows={rows.map((row) => {
            const value = values[row.participationId];
            return {
              id: row.participationId,
              name: row.walkIn ? `${row.label} · ${t("appointments.origins.walk_in")}` : row.label,
              attendance: (
                <Select
                  id={`attendance-${row.participationId}`}
                  labelText={t("appointments.attendance.valueOf", { name: row.label })}
                  hideLabel
                  size="sm"
                  value={value?.attendance ?? ""}
                  onChange={(event) => choose(row, event.target.value)}
                >
                  <SelectItem value="" text="—" />
                  {row.attended && (
                    <SelectItem
                      value="attended"
                      text={t("appointments.attendance.values.attended")}
                    />
                  )}
                  {row.absent && (
                    <SelectItem value="absent" text={t("appointments.attendance.values.absent")} />
                  )}
                </Select>
              ),
              informed:
                row.offerInformed && value?.attendance === "attended" ? (
                  <Checkbox
                    id={`informed-${row.participationId}`}
                    labelText={t("appointments.attendance.markInformedOf", { name: row.label })}
                    checked={value.informed}
                    onChange={(_, { checked }) =>
                      setValues((current) => ({
                        ...current,
                        [row.participationId]: { attendance: "attended", informed: checked },
                      }))
                    }
                  />
                ) : (
                  ""
                ),
            };
          })}
          emptyState={t("appointments.attendance.empty")}
        />
        <Stack gap={4}>
          <h3>{t("appointments.attendance.walkIn")}</h3>
          <TextInput
            id="attendance-walk-in-search"
            labelText={t("appointments.page.search")}
            autoComplete="off"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
          />
          {term.trim() && matches.length === 0 && <p>{t("appointments.page.noMatch")}</p>}
          {matches.map((item) => (
            <Button
              key={item.id}
              kind="ghost"
              size="sm"
              onClick={() => {
                const row: Row = {
                  participationId: item.id,
                  label: candidateLabel(item),
                  attended: true,
                  absent: false,
                  offerInformed: beforeInformed.has(item.status),
                  afterClose: false,
                  walkIn: true,
                };
                setWalkIns((current) => [...current, row]);
                choose(row, "attended");
                setTerm("");
              }}
            >
              {t("appointments.attendance.addWalkIn", { name: candidateLabel(item) })}
            </Button>
          ))}
        </Stack>
        {needsReason && (
          <Select
            id="attendance-after-close-reason"
            labelText={t("appointments.attendance.afterCloseReason")}
            helperText={t("appointments.attendance.afterCloseHint")}
            value={reason}
            onChange={(event) => setReason(event.target.value as AfterCloseReason)}
          >
            <SelectItem value="" text={t("appointments.page.chooseHint")} />
            {afterCloseReasons.map((code) => (
              <SelectItem
                key={code}
                value={code}
                text={t(`appointments.attendance.afterCloseReasons.${code}`)}
              />
            ))}
          </Select>
        )}
        {ticked && (
          <Checkbox
            id="attendance-delivered"
            labelText={t("appointments.attendance.delivered")}
            checked={confirmed}
            invalid={unconfirmed && !confirmed}
            invalidText={t("appointments.errors.information_delivery_unconfirmed")}
            onChange={(_, { checked }) => setConfirmed(checked)}
          />
        )}
      </Stack>
    </Modal>
  );
}

type Action = "correct" | "informed" | "basis" | "escalate" | "otherwise";

/**
 * The actions on one booking: "Teilnahme korrigieren" (the other value; the closed-case flow
 * with its reason), "Als informiert erfassen", "Als Grundlage bestätigen" on a conflict, and the
 * PL's "Eskalieren" and "Anderweitig informiert".
 */
export function BookingAttendanceActions({
  booking,
  appointmentId,
  onChanged,
}: {
  booking: BookingAttendance & { participationId: string };
  appointmentId: string;
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const showToast = useToast();
  const [action, setAction] = useState<Action | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState<AfterCloseReason | "">("");
  const { capabilities } = booking;
  const other: AttendanceValue | null =
    booking.attendance === "attended" && capabilities.recordAbsent
      ? "absent"
      : booking.attendance === "absent" && capabilities.recordAttended
        ? "attended"
        : null;
  const run = useMutation({
    mutationFn: async (chosen: Action) => {
      const bookingPath = { params: { path: { bookingId: booking.id } } };
      if (chosen === "correct") {
        await api.POST("/api/v1/appointments/{appointmentId}/attendance", {
          params: { path: { appointmentId } },
          body: {
            entries: [
              { participationId: booking.participationId, attendance: other!, markInformed: false },
            ],
            informationDelivered: false,
            afterCloseReason: capabilities.afterClose && reason ? reason : null,
          },
        });
      } else if (chosen === "informed" || chosen === "basis") {
        await api.POST("/api/v1/appointment-bookings/{bookingId}/informed", {
          ...bookingPath,
          body: { informationDelivered: true },
        });
      } else {
        await api.POST("/api/v1/appointment-bookings/{bookingId}/conflict-review", {
          ...bookingPath,
          body: { reason: chosen === "escalate" ? "escalated" : "information_delivered_otherwise" },
        });
      }
    },
    onSuccess: async (_, chosen) => {
      setAction(null);
      setConfirmed(false);
      await onChanged();
      showToast({ title: t(`appointments.attendance.actions.${chosen}.done`) });
    },
  });
  const offered: Action[] = [
    ...(other ? (["correct"] as const) : []),
    ...(capabilities.markInformed ? (["informed"] as const) : []),
    ...(capabilities.confirmBasis ? (["basis"] as const) : []),
    ...(capabilities.reviewConflict && booking.conflict === "open" ? (["escalate"] as const) : []),
    ...(capabilities.reviewConflict ? (["otherwise"] as const) : []),
  ];
  const needsConfirmation = action === "informed" || action === "basis";
  const needsReason = action === "correct" && capabilities.afterClose;
  return (
    <>
      {offered.map((key) => (
        <Button
          key={key}
          kind="ghost"
          size="sm"
          onClick={() => {
            run.reset();
            setAction(key);
          }}
        >
          {t(`appointments.attendance.actions.${key}.button`)}
        </Button>
      ))}
      {action && (
        <Modal
          open
          modalHeading={t(`appointments.attendance.actions.${action}.title`)}
          primaryButtonText={t(`appointments.attendance.actions.${action}.button`)}
          secondaryButtonText={t("appointments.form.cancel")}
          primaryButtonDisabled={
            (needsConfirmation && !confirmed) || (needsReason && !reason) || run.isPending
          }
          onRequestClose={() => setAction(null)}
          onRequestSubmit={() => run.mutate(action)}
        >
          <Stack gap={5}>
            <p>
              {t(`appointments.attendance.actions.${action}.text`, {
                value: other ? t(`appointments.attendance.values.${other}`) : "",
              })}
            </p>
            {run.isError && (
              <InlineNotification
                kind="error"
                title={t(`appointments.errors.${problemCodes(run.error)[0]!.code}` as never)}
                hideCloseButton
              />
            )}
            {needsReason && (
              <Select
                id="attendance-correction-reason"
                labelText={t("appointments.attendance.afterCloseReason")}
                helperText={t("appointments.attendance.afterCloseHint")}
                value={reason}
                onChange={(event) => setReason(event.target.value as AfterCloseReason)}
              >
                <SelectItem value="" text={t("appointments.page.chooseHint")} />
                {afterCloseReasons.map((code) => (
                  <SelectItem
                    key={code}
                    value={code}
                    text={t(`appointments.attendance.afterCloseReasons.${code}`)}
                  />
                ))}
              </Select>
            )}
            {needsConfirmation && (
              <Checkbox
                id="booking-delivered"
                labelText={t("appointments.attendance.delivered")}
                checked={confirmed}
                onChange={(_, { checked }) => setConfirmed(checked)}
              />
            )}
          </Stack>
        </Modal>
      )}
    </>
  );
}
