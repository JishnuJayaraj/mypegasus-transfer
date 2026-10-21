import { z } from "zod";
import { addMonths, compareIsoDates } from "../dates";
import { isoDate, type IsoDate } from "../iso-date";

export const PrivacyNoticeState = z
  .strictObject({
    state: z.enum(["provided", "due", "overdue"]),
    dueOn: isoDate,
    providedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: "PrivacyNoticeState" });
export type PrivacyNoticeState = z.infer<typeof PrivacyNoticeState>;

export function privacyNoticeState(
  receivedOn: IsoDate,
  deliveries: readonly { providedAt: string }[],
  today: IsoDate,
): PrivacyNoticeState {
  const dueOn = addMonths(receivedOn, 1);
  const providedAt = deliveries.map((delivery) => delivery.providedAt).toSorted()[0] ?? null;
  return {
    state: providedAt ? "provided" : compareIsoDates(today, dueOn) > 0 ? "overdue" : "due",
    dueOn,
    providedAt,
  };
}
