import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiProblemError } from "@transfer/api-client";
import { berlinDate, MissedResolution } from "@transfer/domain";
import {
  Button,
  formatDate,
  InlineNotification,
  Modal,
  Select,
  SelectItem,
  SimpleTable,
  useToast,
} from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { participationAppointmentsQuery, useApi } from "../api";
import { problemCodes, useWhen } from "./appointments";
import { BookingAttendanceActions, useAttendanceLabel } from "./attendance";

// The participant tab "Termine" (process-and-lifecycle.md and data-protection.md, appointments):
// the participation's bookings with their attendance, "Buchung absagen" and the attendance actions
// (also after the participation closed, where a conflict stays visible), and the upcoming
// appointments staff may book for it with "Buchen", each with its seat state, refusal or warning.
// A missed appointment (process-and-lifecycle.md, appointment items) offers "Folgetermin
// buchen" (the bookable appointments of its kind; a consultation is linked as its follow-up) and
// "Keine weitere Nachverfolgung" with a closed reason.

type Kind = "info_event" | "consultation";

export function AppointmentsTab({
  participationId,
  projectId,
}: {
  participationId: string;
  projectId: string;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const when = useWhen();
  const attendanceLabel = useAttendanceLabel();
  const query = useQuery(participationAppointmentsQuery(api, participationId));
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [followUp, setFollowUp] = useState<{ id: string; kind: Kind; startsAt: string } | null>(
    null,
  );
  const [resolving, setResolving] = useState<string | null>(null);
  const [reason, setReason] = useState<MissedResolution | "">("");
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["participations", participationId] }),
      queryClient.invalidateQueries({ queryKey: ["appointments"] }),
      queryClient.invalidateQueries({ queryKey: ["projects", projectId, "appointments"] }),
    ]);
  const book = useMutation({
    mutationFn: async (appointmentId: string) => {
      // An info event's follow-up is matched automatically; a consultation's is linked.
      const followUpOf = followUp?.kind === "consultation" ? followUp.id : undefined;
      const { data } = await api.POST("/api/v1/appointments/{appointmentId}/bookings", {
        params: { path: { appointmentId } },
        body: { participationId, ...(followUpOf && { followUpOf }) },
      });
      return data!;
    },
    onSuccess: async (result) => {
      setError(undefined);
      setFollowUp(null);
      await refresh();
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
  const cancel = useMutation({
    mutationFn: async (bookingId: string) => {
      await api.POST("/api/v1/appointment-bookings/{bookingId}/cancellation", {
        params: { path: { bookingId } },
        body: {},
      });
    },
    onSuccess: async () => {
      setCancelling(null);
      await refresh();
      showToast({ title: t("appointments.page.bookingCancelled") });
    },
  });

  const resolve = useMutation({
    mutationFn: async ({ bookingId, chosen }: { bookingId: string; chosen: MissedResolution }) => {
      await api.POST("/api/v1/appointment-bookings/{bookingId}/missed-resolution", {
        params: { path: { bookingId } },
        body: { reason: chosen },
      });
    },
    onSuccess: async () => {
      setResolving(null);
      setReason("");
      setError(undefined);
      await refresh();
      showToast({ title: t("appointments.participant.missed.done") });
    },
    onError: (failure) => {
      setResolving(null);
      setError(problemCodes(failure)[0]!.code);
    },
  });

  if (query.isError) {
    const forbidden = query.error instanceof ApiProblemError && query.error.status === 403;
    return <p role="alert">{t(forbidden ? "appointments.forbidden" : "appointments.failed")}</p>;
  }
  if (!query.data) return <p aria-live="polite">{t("appointments.loading")}</p>;
  const { bookings, capabilities } = query.data;
  const bookable = followUp
    ? query.data.bookable.filter((item) => item.appointment.kind === followUp.kind)
    : query.data.bookable;
  const kind = (appointment: { kind: "info_event" | "consultation"; title: string | null }) =>
    [t(`appointments.kinds.${appointment.kind}`), appointment.title].filter(Boolean).join(" – ");

  return (
    <section className="tp-section" aria-labelledby="participant-appointments">
      <h2 id="participant-appointments">{t("appointments.participant.title")}</h2>
      {error && (
        <InlineNotification
          kind="error"
          title={t(`appointments.errors.${error}` as never)}
          hideCloseButton
        />
      )}
      <SimpleTable
        title={t("appointments.participant.bookings")}
        columns={(["kind", "when", "venue", "status", "attendance", "actions"] as const).map(
          (key) => ({ key, header: t(`appointments.participant.columns.${key}`) }),
        )}
        rows={bookings.map((booking) => ({
          id: booking.id,
          kind: kind(booking.appointment),
          when: when(booking.appointment),
          venue: booking.appointment.venue,
          status: [
            t(`appointments.bookingStatuses.${booking.status}`),
            booking.cancelReason && t(`appointments.bookingCancelReasons.${booking.cancelReason}`),
            booking.followUpOf && t("appointments.participant.missed.followUpOf"),
            booking.missed && t("appointments.participant.missed.open"),
            booking.missedResolution &&
              t("appointments.participant.missed.resolved", {
                reason: t(`appointments.participant.missed.reasons.${booking.missedResolution}`),
              }),
          ]
            .filter(Boolean)
            .join(" · "),
          attendance: attendanceLabel(booking),
          actions: (
            <>
              {booking.capabilities.cancel && (
                <Button kind="ghost" size="sm" onClick={() => setCancelling(booking.id)}>
                  {t("appointments.participant.cancel")}
                </Button>
              )}
              {booking.missed?.followUp && (
                <Button
                  kind="ghost"
                  size="sm"
                  onClick={() =>
                    setFollowUp({
                      id: booking.id,
                      kind: booking.appointment.kind,
                      startsAt: booking.appointment.startsAt,
                    })
                  }
                >
                  {t("appointments.participant.missed.followUp")}
                </Button>
              )}
              {booking.missed?.resolve && (
                <Button kind="ghost" size="sm" onClick={() => setResolving(booking.id)}>
                  {t("appointments.participant.missed.resolve")}
                </Button>
              )}
              <BookingAttendanceActions
                booking={{ ...booking, participationId }}
                appointmentId={booking.appointment.id}
                onChanged={refresh}
              />
            </>
          ),
        }))}
        emptyState={t("appointments.participant.bookingsEmpty")}
      />
      {followUp && (
        <div>
          <InlineNotification
            kind="info"
            title={t("appointments.participant.missed.followUpHint", {
              date: formatDate(berlinDate(followUp.startsAt)),
              kind: t(`appointments.kinds.${followUp.kind}`),
            })}
            hideCloseButton
          />
          <Button kind="ghost" size="sm" onClick={() => setFollowUp(null)}>
            {t("appointments.participant.missed.followUpCancel")}
          </Button>
        </div>
      )}
      <SimpleTable
        title={t("appointments.participant.bookable")}
        columns={(["kind", "when", "venue", "availability", "hint", "actions"] as const).map(
          (key) => ({ key, header: t(`appointments.participant.columns.${key}`) }),
        )}
        rows={bookable.map((item) => ({
          id: item.appointment.id,
          kind: kind(item.appointment),
          when: when(item.appointment),
          venue: item.appointment.venue,
          availability: t(`appointments.seats.${item.availability}`),
          hint: item.code
            ? t(`appointments.errors.${item.code}`)
            : item.warnings
                .map((warning) =>
                  t(`appointments.warnings.${warning.code}`, {
                    date: formatDate(warning.latestEntryDate),
                  }),
                )
                .join(" "),
          actions:
            capabilities.book && item.code === null ? (
              <Button
                kind="ghost"
                size="sm"
                disabled={book.isPending}
                onClick={() => book.mutate(item.appointment.id)}
              >
                {t("appointments.participant.book")}
              </Button>
            ) : (
              ""
            ),
        }))}
        emptyState={t("appointments.participant.bookableEmpty")}
      />
      {cancelling && (
        <Modal
          open
          danger
          modalHeading={t("appointments.page.cancelBookingTitle")}
          primaryButtonText={t("appointments.participant.cancel")}
          secondaryButtonText={t("appointments.form.cancel")}
          primaryButtonDisabled={cancel.isPending}
          onRequestClose={() => setCancelling(null)}
          onRequestSubmit={() => cancel.mutate(cancelling)}
        >
          <p>{t("appointments.page.cancelBookingText")}</p>
        </Modal>
      )}
      {resolving && (
        <Modal
          open
          modalHeading={t("appointments.participant.missed.resolveTitle")}
          primaryButtonText={t("appointments.participant.missed.resolve")}
          secondaryButtonText={t("appointments.form.cancel")}
          primaryButtonDisabled={reason === "" || resolve.isPending}
          onRequestClose={() => setResolving(null)}
          onRequestSubmit={() =>
            reason !== "" && resolve.mutate({ bookingId: resolving, chosen: reason })
          }
        >
          <p>{t("appointments.participant.missed.resolveText")}</p>
          <Select
            id="missed-resolution"
            labelText={t("appointments.participant.missed.reason")}
            value={reason}
            onChange={(event) => setReason(event.target.value as MissedResolution)}
          >
            <SelectItem value="" text={t("appointments.participant.missed.chooseReason")} />
            {MissedResolution.options.map((option) => (
              <SelectItem
                key={option}
                value={option}
                text={t(`appointments.participant.missed.reasons.${option}`)}
              />
            ))}
          </Select>
        </Modal>
      )}
    </section>
  );
}
