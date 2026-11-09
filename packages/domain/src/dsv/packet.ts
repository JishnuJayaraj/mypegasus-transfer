import type { IsoDate } from "../iso-date";
import type { DsvSignatures } from "./scans";
import type { z } from "zod";

// process-and-lifecycle.md, DSV packet: the facts rest on counting scans (accepted, live, neither
// quarantined nor invalidated); no I/O here.

/** An accepted, counting scan of the signed offer with its confirmed signatures. */
export type DsvCountingScan = {
  documentId: string;
  signatures: z.infer<typeof DsvSignatures>;
  /** The latest of acceptance, signature recording and quarantine lift (ISO 8601 UTC). */
  recordedAt: string;
};

export type DsvPacketFact = { documentId: string; validOn: IsoDate; recordedAt: string };

/** The participant date every accepted scan of the offer shares; null before the first. */
export function dsvSignedOn(participantDates: readonly IsoDate[]): IsoDate | null {
  return participantDates.toSorted()[0] ?? null;
}

/**
 * A participant date that differs from another accepted scan of the same offer is refused; a
 * correction of a wrong date is a supersession, never a second scan.
 */
export function dsvSignatureDateProblem(
  participant: IsoDate | undefined,
  acceptedParticipantDates: readonly IsoDate[],
): "signature_date_mismatch" | null {
  if (participant === undefined) return null;
  return acceptedParticipantDates.some((date) => date !== participant)
    ? "signature_date_mismatch"
    : null;
}

/**
 * `dsvFullyExecuted`: one scan showing all three signatures whose participant date equals the
 * offer's signed date; valid on the latest actual date, recorded when that scan counted.
 */
export function dsvPacketFact(
  scans: readonly DsvCountingScan[],
  signedOn: IsoDate | null,
): DsvPacketFact | null {
  if (signedOn === null) return null;
  const packets = scans
    .filter(
      ({ signatures: s }) =>
        s.participant === signedOn &&
        s.customer !== undefined &&
        s.transfergesellschaft !== undefined,
    )
    .toSorted((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
  const first = packets[0];
  if (!first) return null;
  const { participant, customer, transfergesellschaft } = first.signatures;
  const validOn = [participant!, customer!, transfergesellschaft!].toSorted().at(-1)!;
  return { documentId: first.documentId, validOn, recordedAt: first.recordedAt };
}
