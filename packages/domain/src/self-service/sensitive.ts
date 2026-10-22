import { z } from "zod";
import { fieldEntry } from "../fields/catalog";
import { isoDate } from "../iso-date";
import { wizardPages, type SensitivePage } from "./wizard";

// The highly confidential and special-category self-service fields (data-protection.md,
// self-service; Q135): TL 407 section B (ba-forms.md, the form 08/2025 is the primary source).
// They are stored encrypted and travel only on their own logged endpoints; completeness needs only
// their presence. Every issue carries a code, never a value.

const coded = (code: string) => ({ params: { code } });

/** ISO 3166-1 alpha-2: the officially assigned codes. */
export const countryCodes: readonly string[] = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL " +
  "BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV " +
  "CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD " +
  "GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM " +
  "IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK " +
  "LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW " +
  "MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR " +
  "PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS " +
  "ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY " +
  "UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW "
)
  .trim()
  .split(" ");

/** A country other than Germany, for the nationality "other" (TL 407 field 31). */
export const ForeignCountry = z
  .enum(countryCodes.filter((code) => code !== "DE") as [string, ...string[]])
  .meta({ id: "ForeignCountry" });

/** TL 407 field 31: German, or another nationality with its country. */
export const Nationality = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("german") }),
  z.strictObject({ kind: z.literal("other"), country: ForeignCountry }),
]);
export type Nationality = z.infer<typeof Nationality>;

/** TL 407 field 33: the residence status of a non-German nationality. */
export const ResidenceStatus = z.enum([
  "blue_card",
  "residence_permit",
  "visa",
  "settlement_permit",
  "permission_to_reside",
  "toleration",
]);
export type ResidenceStatus = z.infer<typeof ResidenceStatus>;

/**
 * TL 407 field 25, the Rentenversicherungsnummer: area number and birth date (8 digits), the
 * initial of the birth name, serial number and check digit (3 digits). Its format only; the
 * portal removes spaces and capitalises before sending.
 */
export const PensionInsuranceNumber = z
  .string()
  .refine(
    (value) => /^[0-9]{8}[A-Z][0-9]{3}$/.test(value),
    coded("pension_insurance_number_invalid"),
  );

/** Each sensitive field's value; `null` is empty. Health and disability are yes/no only (Q135). */
export const sensitiveValueSchemas = {
  pensionInsuranceNumber: PensionInsuranceNumber,
  nationality: Nationality,
  entryToGermanyDate: isoDate,
  residenceStatus: ResidenceStatus,
  buergergeld: z.boolean(),
  healthRestrictions: z.boolean(),
  severeDisability: z.boolean(),
} as const;
export type SensitiveField = keyof typeof sensitiveValueSchemas;
export type SensitiveValues = {
  [K in SensitiveField]: z.infer<(typeof sensitiveValueSchemas)[K]> | null;
};

/** The fields of a sensitive page, which is also the group its endpoints read and write. */
export const sensitiveFieldsOf = (group: SensitivePage) =>
  wizardPages.find((p) => p.page === group)!.fields as readonly SensitiveField[];

/** All sensitive fields, in the order of the wizard. */
export const sensitiveFields: readonly SensitiveField[] = [
  ...sensitiveFieldsOf("ba_details"),
  ...sensitiveFieldsOf("health"),
];

/** Shown and taken only with a nationality other than German (Q140: never required). */
const foreignOnly = ["entryToGermanyDate", "residenceStatus"] as const;

/**
 * The values a group write carries: each of the group's fields, `null` or absent for empty (the
 * group is saved whole). Unknown keys are refused; entry date and residence status need the
 * nationality "other". Staff in assisted mode write the group's fields their role sees (`fields`,
 * Q136); the others are unknown keys to them.
 */
export function sensitiveValuesSchema(
  group: SensitivePage,
  fields: readonly SensitiveField[] = sensitiveFieldsOf(group),
) {
  const shape = Object.fromEntries(
    fields.map((key) => [key, sensitiveValueSchemas[key].nullable().optional()]),
  );
  return z.strictObject(shape).superRefine((values, ctx) => {
    if (group !== "ba_details") return;
    const nationality = values.nationality as Nationality | null | undefined;
    if (nationality?.kind === "other") return;
    for (const key of foreignOnly) {
      if (values[key] != null) {
        ctx.addIssue({ code: "custom", path: [key], message: key, ...coded("not_applicable") });
      }
    }
  });
}

/** Every field of the group (or of `fields`), `null` where the write left it empty. */
export function completeSensitiveValues(
  group: SensitivePage,
  values: Readonly<Record<string, unknown>>,
  fields: readonly SensitiveField[] = sensitiveFieldsOf(group),
): Partial<SensitiveValues> {
  return Object.fromEntries(fields.map((key) => [key, values[key] ?? null]));
}

/**
 * Whether reading or writing the group needs the participant's step-up (Q129, Q137): it holds
 * special-category fields (data-protection.md, access matrix: health and disability).
 */
export const groupNeedsStepUp = (group: SensitivePage) =>
  sensitiveFieldsOf(group).some((key) => fieldEntry(key).dataClass === "special_category");
