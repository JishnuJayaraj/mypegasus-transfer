import { z } from "zod";
import { isoDate, type IsoDate } from "../iso-date";
import type { ScanProblem } from "../documents/scans";

/** Actual dates on the offered paper; absent signatures remain absent. */
export const DsvSignatures = z.strictObject({
  participant: isoDate.optional(),
  customer: isoDate.optional(),
  transfergesellschaft: isoDate.optional(),
});

/** Receipt is explicitly recorded, never inferred from the uploader or today's date. */
export const DsvScanMetadata = z.strictObject({
  offerId: z.uuid(),
  signatures: DsvSignatures,
  receivedBy: z.uuid(),
  receivedOn: isoDate,
});
export type DsvScanMetadata = z.infer<typeof DsvScanMetadata>;

/** Calendar boundaries for DSV paper (process-and-lifecycle.md, the DSV). */
export function dsvScanProblems(
  input: Pick<DsvScanMetadata, "signatures" | "receivedOn">,
  today: IsoDate,
): ScanProblem[] {
  const problems: ScanProblem[] = [];
  if (input.receivedOn > today) {
    problems.push({ code: "received_in_future", field: "receivedOn" });
  }
  for (const [kind, date] of Object.entries(input.signatures)) {
    if (date !== undefined && date > today) {
      problems.push({ code: "signature_in_future", field: `signatures/${kind}` });
    }
  }
  if (
    input.signatures.participant !== undefined &&
    input.receivedOn < input.signatures.participant
  ) {
    problems.push({ code: "received_before_signature", field: "receivedOn" });
  }
  return problems;
}
