import { z } from "zod";
import { decideAccess, type Subject } from "../access/decide";
import { addDays, compareIsoDates } from "../dates";
import type { IsoDate } from "../iso-date";
import { terminalMainStatuses, type MainStatus } from "../lifecycle/enums";
import { PORTAL_CONTACT_CONSENT_VERSION, reminderConsentVersion } from "../notices/catalog";
import type { ContactKind } from "../portal/contact";

// Reminders (data-protection.md, reminders; Q152–Q156): manual, one fixed generic text, sent only
// to a channel the participant registered with a live consent v2. The database decides again at
// the request and before the dispatch; these rules give the work list its capability.

/**
 * What a message is about (data-protection.md, messages): something open in the portal (the
 * participant's actions, a reminder), an invitation to an appointment, or the organizer's notice
 * that a booked appointment changed (title or venue) or was cancelled.
 */
export const ReminderKind = z
  .enum(["open_items", "appointment_invitation", "appointment_changed", "appointment_cancelled"])
  .meta({ id: "ReminderKind" });
export type ReminderKind = z.infer<typeof ReminderKind>;

/**
 * `queued` until the job claims it (`dispatching`); then `sent`, `failed` (the provider's
 * definitive answer), `delivery_unknown` (it may have gone out) or `cancelled` with a reason.
 */
export const ReminderStatus = z
  .enum(["queued", "dispatching", "sent", "failed", "delivery_unknown", "cancelled"])
  .meta({ id: "ReminderStatus" });
export type ReminderStatus = z.infer<typeof ReminderStatus>;

/**
 * Why a selected participation got no message; the request goes on for the others. An invitation
 * also skips `not_eligible` (the booking rules), `already_booked`, `already_invited` and
 * `invitation_limit` (data-protection.md, invitations).
 */
export const ReminderSkip = z.enum([
  "no_channel",
  "consent_required",
  "reminded_recently",
  "nothing_open",
  "participation_closed",
  "not_eligible",
  "already_booked",
  "already_invited",
  "invitation_limit",
]);
export type ReminderSkip = z.infer<typeof ReminderSkip>;

/**
 * Why a message was never handed to a provider. An invitation or notice without a usable channel
 * is written `cancelled` at once (`no_channel`, `consent_required`), so the portal shows it either
 * way; the claim cancels an invitation whose appointment is no longer bookable for the
 * participation (`appointment_unavailable`) or booked meanwhile (`nothing_open`).
 */
export const ReminderCancelReason = z.enum([
  "channel_unavailable",
  "consent_ended",
  "participation_closed",
  "nothing_open",
  "requester_no_longer_authorized",
  "delivery_unavailable",
  "no_channel",
  "consent_required",
  "appointment_unavailable",
]);
export type ReminderCancelReason = z.infer<typeof ReminderCancelReason>;

/** The organizer's notices: the people booked, told by the system (data-protection.md, messages). */
export const noticeKinds: ReadonlySet<ReminderKind> = new Set([
  "appointment_changed",
  "appointment_cancelled",
]);

/**
 * One policy everywhere, no regional rule (regional-variation.md, reminder rules; Q152, Q155):
 * one reminder per participation within 3 Berlin calendar days from the last queued request,
 * whatever its outcome; 1–500 participations per request. Invitations and notices neither use nor
 * consume the window; an invitation has at most three delivery attempts per participation and
 * appointment, the first included.
 */
export const reminderPolicy = {
  windowDays: 3,
  minPerRequest: 1,
  maxPerRequest: 500,
  invitationAttempts: 3,
} as const;

/** A previous invitation of the participation to the same appointment. */
export type PreviousInvitation = {
  status: ReminderStatus;
  cancelReason: ReminderCancelReason | null;
  /** UTC timestamp (ISO 8601) of the request: the latest decides. */
  requestedAt: string;
};

/** The cancellations for a delivery reason, after which a new invitation may go out. */
const deliveryReasons: ReadonlySet<ReminderCancelReason> = new Set([
  "no_channel",
  "consent_required",
  "channel_unavailable",
  "consent_ended",
  "delivery_unavailable",
  // Only a currently authorized requester asks again: the request checks the requester first.
  "requester_no_longer_authorized",
]);

/** An attempt is a row the claim handed to a provider; transport retries are the same attempt. */
const attempted: ReadonlySet<ReminderStatus> = new Set(["sent", "failed", "delivery_unknown"]);

/**
 * Whether a new invitation to the appointment may be requested for the participation
 * (data-protection.md, invitations; Q165): always without a previous one; after the latest ended
 * `failed` or was cancelled for a delivery reason (or `requester_no_longer_authorized`); never
 * while it is open or its outcome uncertain (`queued`, `dispatching`, `sent`, `delivery_unknown`)
 * or after any other cancellation (`already_invited`); and at most three delivery attempts in all
 * (`invitation_limit`), rows cancelled before the provider counting none.
 */
export function invitationRetryAllowed(
  previous: readonly PreviousInvitation[],
): "ok" | "already_invited" | "invitation_limit" {
  const latest = previous.toSorted((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
  if (!latest) return "ok";
  const retry =
    latest.status === "failed" ||
    (latest.status === "cancelled" && deliveryReasons.has(latest.cancelReason!));
  if (!retry) return "already_invited";
  const attempts = previous.filter(({ status }) => attempted.has(status)).length;
  return attempts >= reminderPolicy.invitationAttempts ? "invitation_limit" : "ok";
}

/**
 * How staff told a person whose notice wasn't delivered, or that it isn't needed
 * (data-protection.md, messages: follow-up).
 */
export const NoticeFollowUpMethod = z
  .enum(["phone", "in_person", "letter", "not_needed"])
  .meta({ id: "NoticeFollowUpMethod" });
export type NoticeFollowUpMethod = z.infer<typeof NoticeFollowUpMethod>;

/**
 * Whether an organizer's notice needs staff follow-up (`notice_undelivered`): it ended `failed`,
 * `delivery_unknown` or cancelled for any reason but `participation_closed`, and no follow-up is
 * recorded yet.
 */
export function noticeUndelivered(notice: {
  kind: ReminderKind;
  status: ReminderStatus;
  cancelReason: ReminderCancelReason | null;
  followedUp: boolean;
}): boolean {
  if (!noticeKinds.has(notice.kind) || notice.followedUp) return false;
  if (notice.status === "failed" || notice.status === "delivery_unknown") return true;
  return notice.status === "cancelled" && notice.cancelReason !== "participation_closed";
}

/** The first Berlin date a new reminder may be requested: a Monday's allows the Thursday's. */
export function nextEligibleDate(lastQueuedOn: IsoDate): IsoDate {
  return addDays(lastQueuedOn, reminderPolicy.windowDays);
}

/** A participant's channel as the reminder rules see it: never its address. */
export type ReminderChannelFacts = {
  id: string;
  kind: ContactKind;
  /** UTC timestamp (ISO 8601) of its verification. */
  verifiedAt: string;
  /** Verified, neither removed nor suspended. */
  live: boolean;
  consentVersion: string;
  consentEnded: boolean;
};

const hasReminderConsent = (channel: Omit<ReminderChannelFacts, "id" | "kind" | "verifiedAt">) =>
  channel.live && !channel.consentEnded && channel.consentVersion === reminderConsentVersion;

/**
 * The channel a reminder goes to (Q154): among the live channels with a live consent v2, the most
 * recently verified email, else the most recently verified mobile; the smaller id breaks a tie.
 * `null` when there is none.
 */
export function chooseChannel<T extends ReminderChannelFacts>(channels: readonly T[]): T | null {
  const eligible = channels.filter(hasReminderConsent);
  const rank = (channel: T) => (channel.kind === "email" ? 0 : 1);
  return (
    eligible.toSorted(
      (a, b) =>
        rank(a) - rank(b) ||
        b.verifiedAt.localeCompare(a.verifiedAt) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )[0] ?? null
  );
}

/**
 * `reachable`: a live channel with a live consent v2; `consent_required`: a live channel, none
 * with it; `not_reachable`: no live channel.
 */
export const PortalReach = z
  .enum(["reachable", "consent_required", "not_reachable"])
  .meta({ id: "PortalReach" });
export type PortalReach = z.infer<typeof PortalReach>;

export function portalReach(
  channels: readonly Omit<ReminderChannelFacts, "id" | "kind" | "verifiedAt">[],
): PortalReach {
  if (channels.some(hasReminderConsent)) return "reachable";
  return channels.some((channel) => channel.live) ? "consent_required" : "not_reachable";
}

/**
 * Whether a reminder may be requested for the participation today, or the code it is skipped
 * with: a closed participation first, then nothing open, then the channel, then the window.
 */
export function reminderEligibility(
  item: { status: MainStatus; actionCount: number; portal: PortalReach },
  lastQueuedOn: IsoDate | null,
  today: IsoDate,
): "ok" | ReminderSkip {
  if (terminalMainStatuses.has(item.status)) return "participation_closed";
  if (item.actionCount === 0) return "nothing_open";
  if (item.portal === "not_reachable") return "no_channel";
  if (item.portal === "consent_required") return "consent_required";
  if (lastQueuedOn !== null && compareIsoDates(today, nextEligibleDate(lastQueuedOn)) < 0) {
    return "reminded_recently";
  }
  return "ok";
}

/**
 * Whether "Meine Kontaktwege" offers the voluntary upgrade to consent v2 (data-protection.md,
 * consent v2): a live channel whose consent is an earlier version.
 */
export function consentUpgradeOffered(channel: { live: boolean; consentVersion: string }): boolean {
  return channel.live && channel.consentVersion !== PORTAL_CONTACT_CONSENT_VERSION;
}

/**
 * Who reads a participation's reminders ("Nachrichten"; Q156): whoever reads its `case_internal`
 * data, i.e. the PL, the assigned consultant and back office (data-protection.md, access matrix).
 */
export function mayReadReminders(
  subject: Subject,
  target: { projectId: string; participationId: string },
): boolean {
  return (
    decideAccess(
      subject,
      { kind: "field", ...target, regionId: null, phase: "active", field: "reminderLog" },
      "read",
      { kind: "normal" },
    ).effect === "allow"
  );
}
