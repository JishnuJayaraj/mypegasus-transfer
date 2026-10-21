import { z } from "zod";
import { compareIsoDates } from "../dates";
import { isoDate, type IsoDate } from "../iso-date";
import { isEmail, isPhone } from "../import/rows";

// The value sets of the self-service fields (ba-forms.md, TL 407 08/2025 section B; the form is
// the primary source). Dates are ISO in the API (`TT.MM.JJJJ` is the UI's); an impossible date is
// an error, `von > bis` a warning the participant sees. Validity is checked on write, completeness
// checks presence (process-and-lifecycle.md, profiling). Every issue carries a code, never a value.

const coded = (code: string) => ({ params: { code } });

// oxlint-disable-next-line no-control-regex -- control characters are what this refuses
const controlCharacters = /\p{Cc}/u;

/** Trimmed text of 1 to `max` characters without control characters, as the tables hold it. */
export const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !controlCharacters.test(value), coded("control_characters"));

/** TL 407 field 22. */
export const Gender = z.enum(["male", "female", "diverse", "not_specified"]);
export type Gender = z.infer<typeof Gender>;

/** TL 407 field 30 offers these two only. */
export const MaritalStatus = z.enum(["single", "married"]);
export type MaritalStatus = z.infer<typeof MaritalStatus>;

/** TL 407 field 41: the levels of German and of each further language. */
export const LanguageLevel = z
  .enum(["basic", "extended", "business_fluent"])
  .meta({ id: "SelfServiceLanguageLevel" });
export type LanguageLevel = z.infer<typeof LanguageLevel>;

/** TL 407 field 44. */
export const EmploymentType = z
  .enum(["full_time", "part_time"])
  .meta({ id: "SelfServiceEmploymentType" });
export type EmploymentType = z.infer<typeof EmploymentType>;

/** TL 407 field 42: the EU driving licence classes. */
export const DrivingLicenceClass = z
  .enum([
    "AM",
    "A1",
    "A2",
    "A",
    "B",
    "BE",
    "C1",
    "C1E",
    "C",
    "CE",
    "D1",
    "D1E",
    "D",
    "DE",
    "L",
    "T",
  ])
  .meta({ id: "DrivingLicenceClass" });
export type DrivingLicenceClass = z.infer<typeof DrivingLicenceClass>;

/**
 * The bounded row tables (ba-forms.md, row limits): rows beyond the form's go onto the "Anlage
 * zum Profilingbogen" when the form is generated.
 */
export const rowLimits = { educationHistory: 20, workHistory: 20, languages: 10 } as const;

const period = { from: isoDate, to: isoDate.nullable() };

/** TL 407 field 39: one row of school, vocational training or university. */
export const EducationRow = z
  .strictObject({
    ...period,
    institution: text(200),
    qualification: text(200),
    /** "Abschluss" yes/no; null while it is still running. */
    completed: z.boolean().nullable(),
  })
  .meta({ id: "EducationRow" });
export type EducationRow = z.infer<typeof EducationRow>;

/** TL 407 field 40: one row of the work history, gaps included. */
export const WorkRow = z
  .strictObject({ ...period, employer: text(200), activity: text(200) })
  .meta({ id: "WorkRow" });
export type WorkRow = z.infer<typeof WorkRow>;

/** TL 407 field 41: German first, then up to nine further languages. */
export const LanguageSkills = z.strictObject({
  german: LanguageLevel,
  others: z
    .array(z.strictObject({ language: text(60), level: LanguageLevel }))
    .max(rowLimits.languages - 1),
});
export type LanguageSkills = z.infer<typeof LanguageSkills>;

/** TL 407 field 42: the classes held, or `none` (an answer, so the starred field is present). */
export const DrivingLicence = z.union([
  z.literal("none"),
  z
    .array(DrivingLicenceClass)
    .min(1)
    .max(DrivingLicenceClass.options.length)
    .refine((classes) => new Set(classes).size === classes.length, coded("duplicate_value")),
]);
export type DrivingLicence = z.infer<typeof DrivingLicence>;

/** TL 407 fields 44 and 45: the kind of employment, weekly hours and their distribution. */
export const WorkingTimePreferences = z.strictObject({
  employmentType: EmploymentType,
  weeklyHours: z.number().min(1).max(60).nullable(),
  distribution: text(500).nullable(),
});
export type WorkingTimePreferences = z.infer<typeof WorkingTimePreferences>;

/** TL 407 fields 46 and 47: the desired job and an alternative. */
export const JobWishes = z.strictObject({ desired: text(200), alternative: text(200).nullable() });
export type JobWishes = z.infer<typeof JobWishes>;

/** TL 407 field 49: a distance in km, nationwide or international. */
export const MaxCommuteDistance = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("km"),
    km: z.int().min(1).max(1000),
  }),
  z.strictObject({ kind: z.literal("nationwide") }),
  z.strictObject({ kind: z.literal("international") }),
]);
export type MaxCommuteDistance = z.infer<typeof MaxCommuteDistance>;

/** Street with house number, a five-digit postal code, city; only Germany in the MVP (round 32). */
export const ContactAddress = z.strictObject({
  street: text(200),
  postalCode: z.string().refine((value) => /^[0-9]{5}$/.test(value), coded("postal_code_invalid")),
  city: text(200),
  country: z.literal("DE"),
});
export type ContactAddress = z.infer<typeof ContactAddress>;

const phone = z.string().trim().refine(isPhone, coded("phone_invalid"));
const email = text(254).refine(isEmail, coded("email_invalid"));

const rows = <T extends z.ZodType>(row: T, max: number) => z.array(row).min(1).max(max);

/**
 * Each confidential self-service field's value; `null` is empty. The highly confidential and
 * special-category fields have their own, encrypted path.
 */
export const selfServiceValueSchemas = {
  gender: Gender,
  maritalStatus: MaritalStatus,
  address: ContactAddress,
  phone,
  mobile: phone,
  privateEmail: email,
  educationHistory: rows(EducationRow, rowLimits.educationHistory),
  workHistory: rows(WorkRow, rowLimits.workHistory),
  languageSkills: LanguageSkills,
  drivingLicence: DrivingLicence,
  vehicleAvailable: z.boolean(),
  workingTimePreferences: WorkingTimePreferences,
  jobWishes: JobWishes,
  desiredWorkLocations: text(500),
  maxCommuteDistance: MaxCommuteDistance,
  earliestStartDate: isoDate,
} as const;
export type SelfServiceField = keyof typeof selfServiceValueSchemas;
export type SelfServiceValues = {
  [K in SelfServiceField]: z.infer<(typeof selfServiceValueSchemas)[K]> | null;
};

/** The contact fields; a participant's write makes them participant-maintained (Q112). */
export const contactFields = ["address", "phone", "mobile", "privateEmail"] as const;
export type ContactField = (typeof contactFields)[number];

/** A warning on a valid value the participant sees and may keep; a code and where, never a value. */
export type ValueWarning = { code: "from_after_to"; path: (string | number)[] };

const reversed = (row: { from: IsoDate; to: IsoDate | null }) =>
  row.to !== null && compareIsoDates(row.from, row.to) > 0;

/** `von > bis` in a row table (ba-forms.md, validation): a warning, never a refusal. */
export function valueWarnings(values: Partial<SelfServiceValues>): ValueWarning[] {
  return (["educationHistory", "workHistory"] as const).flatMap((field) =>
    (values[field] ?? []).flatMap((row, index): ValueWarning[] =>
      reversed(row) ? [{ code: "from_after_to", path: [field, index] }] : [],
    ),
  );
}

const sizeCodes = {
  too_small: { string: "required_missing", array: "required_missing" },
  too_big: { string: "too_long", array: "too_many_rows" },
} as const;

/**
 * The code of an issue of these schemas, for a refusal (ADR-0010): a refinement's own code, else
 * one derived from Zod's, never the value. Unknown keys are `unknown_field`.
 */
export function valueIssueCode(issue: z.core.$ZodIssue): string {
  const own = (issue as { params?: { code?: string } }).params?.code;
  if (own) return own;
  switch (issue.code) {
    case "too_small":
    case "too_big": {
      const codes: Partial<Record<string, string>> = sizeCodes[issue.code];
      return codes[issue.origin] ?? "out_of_range";
    }
    case "invalid_value":
    case "invalid_union":
      return "value_not_allowed";
    case "unrecognized_keys":
      return "unknown_field";
    default:
      return issue.code;
  }
}
