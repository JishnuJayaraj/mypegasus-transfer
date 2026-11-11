import { z } from "zod";
import { isoDate } from "../iso-date";
import { Funded110 } from "./rules";

// Retention's inputs over the API (ADR-0010; data-protection.md, funding and settlement dates;
// Q52, Q217): read, then written against the values read.

const SettlementDates = z.strictObject({
  kugFinalSettlementDate: isoDate.nullable(),
  measure110SettlementDate: isoDate.nullable(),
});

/** A project's settlement dates, which of them apply, and whether the viewer may set them. */
export const SettlementDatesView = SettlementDates.extend({
  required: z.strictObject({
    kugFinalSettlementDate: z.boolean(),
    measure110SettlementDate: z.boolean(),
    /** A participation's funding is still `unknown`: stage two stays blocked. */
    fundingUnknown: z.boolean(),
  }),
  capabilities: z.strictObject({ set: z.boolean() }),
}).meta({ id: "SettlementDatesView" });
export type SettlementDatesView = z.infer<typeof SettlementDatesView>;

/** The dates to record (null clears one) and the dates as read. */
export const SettlementDatesRequest = SettlementDates.extend({ expected: SettlementDates }).meta({
  id: "SettlementDatesRequest",
});
export type SettlementDatesRequest = z.infer<typeof SettlementDatesRequest>;

const fundingSource = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value === value.trim() && !/\p{Cc}/u.test(value), "source_invalid");

/** A participation's funding as recorded, by whom it was is in the history. */
export const FundingView = z
  .strictObject({
    funded110: Funded110,
    /** The documented source, e.g. the notice's reference; null while `unknown` was never set. */
    source: z.string().nullable(),
    setAt: z.iso.datetime({ offset: true }).nullable(),
    capabilities: z.strictObject({ set: z.boolean() }),
  })
  .meta({ id: "FundingView" });
export type FundingView = z.infer<typeof FundingView>;

export const FundingRequest = z
  .strictObject({
    funded110: Funded110,
    source: fundingSource,
    expected: z.strictObject({ funded110: Funded110, source: z.string().nullable() }),
  })
  .meta({ id: "FundingRequest" });
export type FundingRequest = z.infer<typeof FundingRequest>;
