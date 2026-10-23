import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import { nextEligibleDate, NoticeFollowUpMethod, reminderTemplates } from "@transfer/domain";
import {
  Button,
  formatDate,
  formatTimestamp,
  InlineNotification,
  Modal,
  Select,
  SelectItem,
  SimpleTable,
  Stack,
  useToast,
} from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { participationRemindersQuery, useApi, worklistQuery } from "../api";

type ListItem = components["schemas"]["WorklistItem"];
type Result = components["schemas"]["ReminderRequestResult"];
type SkipCode = Result["skipped"][number]["code"];
type FollowUpMethod = components["schemas"]["NoticeFollowUpInput"]["method"];
const followUpMethods = NoticeFollowUpMethod.options;

/** Both channel codes read as one text to staff (data-protection.md, reminders). */
const generic = (code: SkipCode) =>
  code === "no_channel" || code === "consent_required" ? "no_usable_channel" : code;

/** The counts the dialog shows before sending, from the rows' capabilities. */
export function reminderCounts(items: readonly ListItem[]) {
  const counts = { email: 0, sms: 0, no_usable_channel: 0, reminded_recently: 0, nothing_open: 0 };
  const closed = { participation_closed: 0 };
  let again: string | null = null;
  for (const { capabilities, reminder } of items) {
    const { allowed, code, channel } = capabilities.remind;
    if (allowed && channel) counts[channel]++;
    else if (code === "participation_closed") closed.participation_closed++;
    else if (code) counts[generic(code) as keyof typeof counts]++;
    if (code === "reminded_recently" && reminder) {
      const next = nextEligibleDate(reminder.lastRequestedOn);
      if (again === null || next < again) again = next;
    }
  }
  return { ...counts, ...closed, again };
}

/** The fixed text, as the participant gets it by email, with the portal's address as a label. */
function Preview() {
  const { t } = useTranslation();
  const template = reminderTemplates.de;
  return (
    <blockquote className="tp-preview" aria-label={t("reminders.preview")}>
      <p>
        <strong>{template.subject}</strong>
      </p>
      <p>{template.text.replace("{{portalUrl}}", t("reminders.portalUrl"))}</p>
      <p>{template.emailNote}</p>
    </blockquote>
  );
}

/**
 * "Erinnern" (data-protection.md, reminders): the selected rows the viewer may remind, their
 * counts from the rows' capabilities, the fixed text as a preview, "Senden", then the result per
 * code. The database decides again; a skip is data, never an error.
 */
export function BulkRemind({
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
  const [result, setResult] = useState<Result | null>(null);
  const permitted = selected.filter(
    ({ capabilities: { remind } }) => remind.allowed || remind.code !== null,
  );
  const counts = reminderCounts(permitted);
  const send = useMutation({
    mutationFn: async () => {
      const { data } = await api.POST("/api/v1/projects/{projectId}/reminders", {
        params: { path: { projectId } },
        body: { kind: "open_items", participationIds: permitted.map(({ id }) => id) },
      });
      return data!;
    },
    onSuccess: async (data) => {
      setResult(data);
      onSent();
      showToast({ title: t("reminders.sent", { count: data.queued.length }) });
      await queryClient.invalidateQueries({ queryKey: worklistQuery(api, projectId).queryKey });
    },
  });
  const close = () => {
    setOpen(false);
    setResult(null);
    send.reset();
  };
  const lines: [string, number][] = [
    [t("reminders.counts.email", { count: counts.email }), counts.email],
    [t("reminders.counts.sms", { count: counts.sms }), counts.sms],
    [
      t("reminders.counts.recently", {
        count: counts.reminded_recently,
        date: counts.again ? formatDate(counts.again) : "",
      }),
      counts.reminded_recently,
    ],
    [
      t("reminders.counts.noUsableChannel", { count: counts.no_usable_channel }),
      counts.no_usable_channel,
    ],
    [t("reminders.counts.nothingOpen", { count: counts.nothing_open }), counts.nothing_open],
    [
      t("reminders.counts.closed", { count: counts.participation_closed }),
      counts.participation_closed,
    ],
  ];
  const resultLines = result
    ? Object.entries(
        result.skipped.reduce<Record<string, number>>((acc, { code }) => {
          acc[generic(code)] = (acc[generic(code)] ?? 0) + 1;
          return acc;
        }, {}),
      )
    : [];
  return (
    <>
      <div className="tp-bulk-actions">
        <Button kind="secondary" disabled={permitted.length === 0} onClick={() => setOpen(true)}>
          {t("reminders.open", { count: permitted.length })}
        </Button>
      </div>
      <Modal
        open={open}
        modalHeading={t("reminders.title")}
        primaryButtonText={result ? t("reminders.close") : t("reminders.send")}
        secondaryButtonText={t("reminders.cancel")}
        primaryButtonDisabled={!result && (send.isPending || counts.email + counts.sms === 0)}
        onRequestSubmit={() => (result ? close() : send.mutate())}
        onRequestClose={close}
        size="sm"
      >
        <Stack gap={5}>
          {send.isError && (
            <InlineNotification
              kind="error"
              title={
                send.error instanceof ApiProblemError && send.error.status === 503
                  ? t("reminders.unavailable")
                  : t("reminders.failed")
              }
              hideCloseButton
              lowContrast
            />
          )}
          {result ? (
            <div aria-live="polite">
              <p>
                {t("reminders.result.queued", {
                  count: result.queued.length,
                  email: result.queued.filter((q) => q.channel === "email").length,
                  sms: result.queued.filter((q) => q.channel === "sms").length,
                })}
              </p>
              {resultLines.length > 0 && (
                <ul className="tp-list">
                  {resultLines.map(([code, count]) => (
                    <li key={code}>{t(`reminders.result.${code}` as never, { count })}</li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <>
              <ul className="tp-list" aria-label={t("reminders.countsLabel")}>
                {lines
                  .filter(([, count]) => count > 0)
                  .map(([text]) => (
                    <li key={text}>{text}</li>
                  ))}
              </ul>
              <p>{t("reminders.previewIntro")}</p>
              <Preview />
            </>
          )}
        </Stack>
      </Modal>
    </>
  );
}

/**
 * "Nachrichten" (data-protection.md, reminders and messages): every message of the participation,
 * newest first: when, what, E-Mail or SMS (or none: written without a usable channel), its state
 * or why it was cancelled, the team or the system (an organizer's notice) as the sender, never a
 * name or an address; on an undelivered notice "Nachverfolgung erfassen" and, once recorded, how.
 */
export function MessagesTab({ participationId }: { participationId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const query = useInfiniteQuery(participationRemindersQuery(api, participationId));
  const [followUp, setFollowUp] = useState<string | null>(null);
  if (query.isError) {
    const status = query.error instanceof ApiProblemError ? query.error.status : null;
    return (
      <p role="alert">
        {status === 403 ? t("reminders.tab.forbidden") : t("reminders.tab.failed")}
      </p>
    );
  }
  if (!query.data) return <p aria-live="polite">{t("worklist.loading")}</p>;
  const items = query.data.pages.flatMap((page) => page.items);
  return (
    <section className="tp-section" aria-labelledby="participant-messages">
      <h2 id="participant-messages">{t("reminders.tab.title")}</h2>
      <SimpleTable
        title={t("reminders.tab.title")}
        columns={(["requestedAt", "kind", "channel", "state", "by", "followUp"] as const).map(
          (key) => ({ key, header: t(`reminders.tab.columns.${key}`) }),
        )}
        rows={items.map((item) => ({
          id: item.id,
          requestedAt: formatTimestamp(item.requestedAt),
          kind: t(`reminders.kinds.${item.kind}`),
          channel: item.channel
            ? t(`reminders.channels.${item.channel}`)
            : t("reminders.tab.noChannel"),
          state: item.cancelReason
            ? `${t("reminders.status.cancelled")}: ${t(`reminders.cancelReasons.${item.cancelReason}`)}`
            : t(`reminders.status.${item.status}`),
          by: item.bySystem ? t("reminders.tab.system") : t("reminders.tab.team"),
          followUp: item.followUpMethod ? (
            t("reminders.followUp.recorded", {
              method: t(`reminders.followUp.methods.${item.followUpMethod}`),
              date: formatTimestamp(item.followedUpAt ?? ""),
            })
          ) : item.capabilities.followUp ? (
            <Button kind="tertiary" size="sm" onClick={() => setFollowUp(item.id)}>
              {t("reminders.followUp.action")}
            </Button>
          ) : (
            ""
          ),
        }))}
        emptyState={t("reminders.tab.empty")}
      />
      {query.hasNextPage && (
        <Button
          className="tp-load-more"
          kind="tertiary"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {t("reminders.tab.more")}
        </Button>
      )}
      {followUp && (
        <FollowUpDialog
          participationId={participationId}
          reminderId={followUp}
          onClose={() => setFollowUp(null)}
        />
      )}
    </section>
  );
}

/** "Nachverfolgung erfassen": how the person was told, or that it isn't needed. */
function FollowUpDialog({
  participationId,
  reminderId,
  onClose,
}: {
  participationId: string;
  reminderId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [method, setMethod] = useState<FollowUpMethod | "">("");
  const save = useMutation({
    mutationFn: async () => {
      await api.POST("/api/v1/participations/{participationId}/reminders/{reminderId}/follow-up", {
        params: { path: { participationId, reminderId } },
        body: { method: method as FollowUpMethod },
      });
    },
    onSuccess: async () => {
      showToast({ title: t("reminders.followUp.saved") });
      await queryClient.invalidateQueries({
        queryKey: participationRemindersQuery(api, participationId).queryKey,
      });
      onClose();
    },
  });
  return (
    <Modal
      open
      modalHeading={t("reminders.followUp.title")}
      primaryButtonText={t("reminders.followUp.save")}
      secondaryButtonText={t("reminders.cancel")}
      primaryButtonDisabled={method === "" || save.isPending}
      onRequestSubmit={() => save.mutate()}
      onRequestClose={onClose}
      size="sm"
    >
      <Stack gap={5}>
        {save.isError && (
          <InlineNotification
            kind="error"
            title={t("reminders.followUp.failed")}
            hideCloseButton
            lowContrast
          />
        )}
        <p>{t("reminders.followUp.intro")}</p>
        <Select
          id="follow-up-method"
          labelText={t("reminders.followUp.method")}
          value={method}
          onChange={(event) => setMethod(event.target.value as FollowUpMethod | "")}
        >
          <SelectItem value="" text={t("reminders.followUp.choose")} />
          {followUpMethods.map((value) => (
            <SelectItem key={value} value={value} text={t(`reminders.followUp.methods.${value}`)} />
          ))}
        </Select>
      </Stack>
    </Modal>
  );
}
