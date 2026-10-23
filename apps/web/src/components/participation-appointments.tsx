import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiProblemError } from "@transfer/api-client";
import { Button, formatDate, InlineNotification, Modal, SimpleTable, useToast } from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { participationAppointmentsQuery, useApi } from "../api";
import { problemCodes, useWhen } from "./appointments";

// The participant tab "Termine" (process-and-lifecycle.md and data-protection.md, appointments):
// the participation's bookings with "Buchung absagen", and the upcoming appointments staff may
// book for it with "Buchen", each with its seat state, refusal or warning from the API.

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
  const query = useQuery(participationAppointmentsQuery(api, participationId));
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["participations", participationId] }),
      queryClient.invalidateQueries({ queryKey: ["appointments"] }),
      queryClient.invalidateQueries({ queryKey: ["projects", projectId, "appointments"] }),
    ]);
  const book = useMutation({
    mutationFn: async (appointmentId: string) => {
      const { data } = await api.POST("/api/v1/appointments/{appointmentId}/bookings", {
        params: { path: { appointmentId } },
        body: { participationId },
      });
      return data!;
    },
    onSuccess: async (result) => {
      setError(undefined);
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

  if (query.isError) {
    const forbidden = query.error instanceof ApiProblemError && query.error.status === 403;
    return <p role="alert">{t(forbidden ? "appointments.forbidden" : "appointments.failed")}</p>;
  }
  if (!query.data) return <p aria-live="polite">{t("appointments.loading")}</p>;
  const { bookings, bookable, capabilities } = query.data;
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
        columns={(["kind", "when", "venue", "status", "actions"] as const).map((key) => ({
          key,
          header: t(`appointments.participant.columns.${key}`),
        }))}
        rows={bookings.map((booking) => ({
          id: booking.id,
          kind: kind(booking.appointment),
          when: when(booking.appointment),
          venue: booking.appointment.venue,
          status: [
            t(`appointments.bookingStatuses.${booking.status}`),
            booking.cancelReason && t(`appointments.bookingCancelReasons.${booking.cancelReason}`),
          ]
            .filter(Boolean)
            .join(" · "),
          actions: booking.capabilities.cancel ? (
            <Button kind="ghost" size="sm" onClick={() => setCancelling(booking.id)}>
              {t("appointments.participant.cancel")}
            </Button>
          ) : (
            ""
          ),
        }))}
        emptyState={t("appointments.participant.bookingsEmpty")}
      />
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
    </section>
  );
}
