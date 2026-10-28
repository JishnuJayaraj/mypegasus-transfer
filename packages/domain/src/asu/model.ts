import { z } from "zod";
import { asuDueDate, type AsuDueDate, type AsuDueDateParams } from "../dates";
import type { DocumentState } from "../completeness/engine";
import type { IsoDate } from "../iso-date";
import type { MainStatus } from "../lifecycle/enums";
import type { ProjectType } from "../project";
import type { AsuChannel } from "../projects/agentur-settings";

// The ASU record (process-and-lifecycle.md, Arbeitsuchendmeldung; Q55, Q186; `ta_tg` only, Q89):
// the route, and a registration that keeps its channel, its actual date, its proof and the
// instant the complete fact was recorded apart. Pure; no I/O, no system time.

/** The routes a registration is recorded on directly; on `kug_200b` the batch submission is it. */
export const directAsuChannels = ["online_self", "in_person"] as const satisfies AsuChannel[];

/**
 * What proves a registration (Q186): the Kug 200b batch's submission (Slice 6, PR 6-5a), an
 * accepted BA confirmation (`asu_proof`), or the PL's attestation of the BA-Kundennummer.
 */
export const AsuProofKind = z
  .enum(["kug200b_submission", "ba_confirmation", "ba_customer_number"])
  .meta({ id: "AsuProofKind" });
export type AsuProofKind = z.infer<typeof AsuProofKind>;

/** Where the PL verified the registration and its date (Q184, Q186). */
export const AttestationSource = z
  .enum(["ba_document_inspected", "ba_online_account_inspected", "ba_confirmed_by_phone"])
  .meta({ id: "AttestationSource" });
export type AttestationSource = z.infer<typeof AttestationSource>;

/**
 * The BA-Kundennummer as typed: letters and digits, 4–20 after trimming (an assumed bound, Q201;
 * the BA's format isn't checked). Upper case is stored; the value is never returned or logged.
 */
export const BaCustomerNumber = z
  .string()
  .trim()
  .regex(/^[0-9A-Za-z]{4,20}$/);

export type AsuRegistrationProblem = "registered_on_in_future";

/** The actual registration date is a past or today's date (process-and-lifecycle.md, dates). */
export function asuRegistrationProblem(
  registeredOn: IsoDate,
  today: IsoDate,
): AsuRegistrationProblem | null {
  return registeredOn > today ? "registered_on_in_future" : null;
}

/** A registration as stored, with its proof's state where a document proves it. */
export type AsuRegistrationFacts = {
  registeredOn: IsoDate;
  /** When the registration was recorded (UTC, ISO 8601). */
  recordedAt: string;
  proof: null | {
    kind: AsuProofKind;
    /** When the proof was linked: the attestation's with the registration, a document's later. */
    linkedAt: string;
    /** The proving `asu_proof` document: usable while accepted, live, not quarantined or invalidated. */
    document?: { usable: boolean; quarantineLiftedAt: string | null };
  };
};

/**
 * When `asuRegisteredWithProof` was recorded (process-and-lifecycle.md, guards and the snapshot
 * rule), as the row's own ISO 8601 text (instants of one format, so they compare as strings): the
 * later of the registration, its proof's link and a lifted quarantine of the proving document, so
 * a proof accepted earlier and linked today is recorded today. Null without a proof or with an
 * unusable document: then there is no fact. The fact is valid on the actual registration date;
 * the caller makes the instant a `Date` (the domain reads no time of its own).
 */
export function asuRegisteredSince(registration: AsuRegistrationFacts | null): string | null {
  const proof = registration?.proof;
  if (!registration || !proof || proof.document?.usable === false) return null;
  const instants = [registration.recordedAt, proof.linkedAt, proof.document?.quarantineLiftedAt];
  return instants
    .filter((i): i is string => !!i)
    .toSorted()
    .at(-1)!;
}

/**
 * The state completeness sees for `asu_proof` (regional-variation.md, the base rules): accepted
 * once a registration with proof exists, on any route, without a file (the attestation, the batch
 * submission); otherwise the live documents' states, an accepted but unlinked one still awaiting
 * its link, so the rule's item is `not_accepted` rather than `missing`.
 */
export function asuProofState(
  registered: boolean,
  documents: readonly DocumentState[],
): DocumentState[] {
  if (registered) return ["accepted"];
  return documents.map((state) => (state === "accepted" ? "uploaded" : state));
}

const preEntry: ReadonlySet<MainStatus> = new Set([
  "imported",
  "contacted",
  "unreachable",
  "informed",
]);

/**
 * The ASU due date that applies (process-and-lifecycle.md, dates): in `ta_tg`, before
 * `active_in_tg`, not terminal, while no registration with proof exists and the end of the old
 * employment is known; statutory with a knowledge date, else an orientation ("Kenntnisdatum
 * klären"), never an overdue finding. Informational, no automatic reminder (Q1, Q152).
 */
export function applicableAsuDueDate(
  facts: {
    projectType: ProjectType;
    status: MainStatus;
    registered: boolean;
    endDate: IsoDate | null;
    knowledgeDate: IsoDate | null;
  },
  params?: AsuDueDateParams,
): AsuDueDate | null {
  if (facts.projectType !== "ta_tg" || !preEntry.has(facts.status) || facts.registered) return null;
  if (facts.endDate === null) return null;
  return asuDueDate({ endDate: facts.endDate, knowledgeDate: facts.knowledgeDate }, params);
}
