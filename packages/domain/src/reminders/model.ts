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

/** What a reminder is about: something open in the portal (the participant's actions). */
export const ReminderKind = z.enum(["open_items"]).meta({ id: "ReminderKind" });
export type ReminderKind = z.infer<typeof ReminderKind>;

/**
 * `queued` until the job claims it (`dispatching`); then `sent`, `failed` (the provider's
 * definitive answer), `delivery_unknown` (it may have gone out) or `cancelled` with a reason.
 */
export const ReminderStatus = z
  .enum(["queued", "dispatching", "sent", "failed", "delivery_unknown", "cancelled"])
  .meta({ id: "ReminderStatus" });
export type ReminderStatus = z.infer<typeof ReminderStatus>;

/** Why a selected participation got no reminder; the request goes on for the others. */
export const ReminderSkip = z.enum([
  "no_channel",
  "consent_required",
  "reminded_recently",
  "nothing_open",
  "participation_closed",
]);
export type ReminderSkip = z.infer<typeof ReminderSkip>;

/** Why a queued reminder was never handed to a provider. */
export const ReminderCancelReason = z.enum([
  "channel_unavailable",
  "consent_ended",
  "participation_closed",
  "nothing_open",
  "requester_no_longer_authorized",
  "delivery_unavailable",
]);
export type ReminderCancelReason = z.infer<typeof ReminderCancelReason>;

/**
 * One policy everywhere, no regional rule (regional-variation.md, reminder rules; Q152, Q155):
 * one reminder per participation within 3 Berlin calendar days from the last queued request,
 * whatever its outcome; 1–500 participations per request.
 */
export const reminderPolicy = { windowDays: 3, minPerRequest: 1, maxPerRequest: 500 } as const;

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
