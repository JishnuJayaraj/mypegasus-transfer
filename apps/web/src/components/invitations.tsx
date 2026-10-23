import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import { invitationTemplates } from "@transfer/domain";
import {
  Button,
  formatTimestamp,
  InlineNotification,
  Modal,
  Select,
  SelectItem,
  Stack,
  useToast,
} from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { projectAppointmentsQuery, useApi, worklistQuery } from "../api";

type ListItem = components["schemas"]["WorklistItem"];
type Result = components["schemas"]["InvitationRequestResult"];

/** The counts the dialog shows before sending, from the rows' capabilities. */
export function invitationCounts(items: readonly ListItem[]) {
  const counts = { email: 0, sms: 0, notDeliverable: 0, closed: 0 };
  for (const { capabilities } of items) {
    const { allowed, channel } = capabilities.invite;
    if (!allowed) counts.closed++;
    else if (channel) counts[channel]++;
    else counts.notDeliverable++;
  }
  return counts;
}

/** The fixed text, as the participant gets it by email, with the portal's address as a label. */
function Preview() {
  const { t } = useTranslation();
  const template = invitationTemplates.de;
  return (
    <blockquote className="tp-preview" aria-label={t("invitations.preview")}>
      <p>
        <strong>{template.subject}</strong>
      </p>
      <p>{template.text.replace("{{portalUrl}}", t("reminders.portalUrl"))}</p>
      <p>{template.emailNote}</p>
    </blockquote>
  );
}

/**
 * "Zu Termin einladen" (data-protection.md, invitations): the appointment, the selected rows the
 * viewer may invite with their counts per channel ("nicht zustellbar, im Portal sichtbar" without
 * one), the fixed text as a preview, "Einladen", then the result per code. The database decides
 * again; a skip is data, never an error.
 */
export function BulkInvite({
  projectId,
  selected,
  onSent,
}: {
  projectId: string;
  selected: ListItem[];
  onSent: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [open, setOpen] = useState(false);
  const [appointmentId, setAppointmentId] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  // When the dialog was rendered first: the public cutoffs are compared with it.
  const [shownAt] = useState(() => Date.now());
  const appointments = useInfiniteQuery({
    ...projectAppointmentsQuery(api, projectId, "upcoming"),
    enabled: open,
  });
  // Appointments the participant can still book from the portal.
  const choices = (appointments.data?.pages.flatMap((page) => page.items) ?? []).filter(
    (item) =>
      item.status === "scheduled" &&
      Date.parse(item.bookingClosesAt) > shownAt &&
      item.bookings.availability === "available",
  );
  const permitted = selected.filter(({ capabilities }) => capabilities.invite.allowed);
  const counts = invitationCounts(selected);
  const send = useMutation({
    mutationFn: async () => {
      const { data } = await api.POST("/api/v1/appointments/{appointmentId}/invitations", {
        params: { path: { appointmentId } },
        body: { participationIds: permitted.map(({ id }) => id) },
      });
      return data!;
    },
    onSuccess: async (data) => {
      setResult(data);
      onSent();
      showToast({
        title: t("invitations.sent", { count: data.queued.length + data.notDeliverable.length }),
      });
      await queryClient.invalidateQueries({ queryKey: worklistQuery(api, projectId).queryKey });
    },
  });
  const close = () => {
    setOpen(false);
    setResult(null);
    setAppointmentId("");
    send.reset();
  };
  const lines: [string, number][] = [
    [t("invitations.counts.email", { count: counts.email }), counts.email],
    [t("invitations.counts.sms", { count: counts.sms }), counts.sms],
    [
      t("invitations.counts.notDeliverable", { count: counts.notDeliverable }),
      counts.notDeliverable,
    ],
    [t("invitations.counts.closed", { count: counts.closed }), counts.closed],
  ];
  const skipped = result
    ? Object.entries(
        result.skipped.reduce<Record<string, number>>((acc, { code }) => {
          acc[code] = (acc[code] ?? 0) + 1;
          return acc;
        }, {}),
      )
    : [];
  const problem =
    send.error instanceof ApiProblemError
      ? send.error.status === 503
        ? "unavailable"
        : (send.error.problem.errors?.[0]?.code ?? "failed")
      : "failed";
  return (
    <>
      <div className="tp-bulk-actions">
        <Button kind="secondary" disabled={permitted.length === 0} onClick={() => setOpen(true)}>
          {t("invitations.open", { count: permitted.length })}
        </Button>
      </div>
      <Modal
        open={open}
        modalHeading={t("invitations.title")}
        primaryButtonText={result ? t("invitations.close") : t("invitations.send")}
        secondaryButtonText={t("invitations.cancel")}
        primaryButtonDisabled={!result && (send.isPending || appointmentId === "")}
        onRequestSubmit={() => (result ? close() : send.mutate())}
        onRequestClose={close}
        size="sm"
      >
        <Stack gap={5}>
          {send.isError && (
            <InlineNotification
              kind="error"
              title={t(`invitations.errors.${problem}` as never, {
                defaultValue: t("invitations.errors.failed"),
              })}
              hideCloseButton
              lowContrast
            />
          )}
          {result ? (
            <div aria-live="polite">
              <p>
                {t("invitations.result.queued", {
                  count: result.queued.length,
                  email: result.queued.filter((q) => q.channel === "email").length,
                  sms: result.queued.filter((q) => q.channel === "sms").length,
                })}
              </p>
              <ul className="tp-list">
                {result.notDeliverable.length > 0 && (
                  <li>
                    {t("invitations.counts.notDeliverable", {
                      count: result.notDeliverable.length,
                    })}
                  </li>
                )}
                {skipped.map(([code, count]) => (
                  <li key={code}>{t(`invitations.skips.${code}` as never, { count })}</li>
                ))}
              </ul>
            </div>
          ) : (
            <>
              <Select
                id="invitation-appointment"
                labelText={t("invitations.appointment")}
                value={appointmentId}
                onChange={(event) => setAppointmentId(event.target.value)}
                disabled={appointments.isPending}
              >
                <SelectItem value="" text={t("invitations.choose")} />
                {choices.map((item) => (
                  <SelectItem
                    key={item.id}
                    value={item.id}
                    text={`${t(`appointments.kinds.${item.kind}`)}, ${formatTimestamp(item.startsAt)}${item.title ? ` – ${item.title}` : ""}`}
                  />
                ))}
              </Select>
              {appointments.isSuccess && choices.length === 0 && <p>{t("invitations.none")}</p>}
              <ul className="tp-list" aria-label={t("invitations.countsLabel")}>
                {lines
                  .filter(([, count]) => count > 0)
                  .map(([text]) => (
                    <li key={text}>{text}</li>
                  ))}
              </ul>
              <p>{t("invitations.rulesNote")}</p>
              <p>{t("invitations.previewIntro")}</p>
              <Preview />
            </>
          )}
        </Stack>
      </Modal>
    </>
  );
}
