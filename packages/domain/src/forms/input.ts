import { z } from "zod";
import type { IsoDate } from "../iso-date";
import type { ProjectType } from "../project";
import type { SensitiveValues } from "../self-service/sensitive";
import type { ContactAddress, SelfServiceValues } from "../self-service/values";
import type { FormCode } from "./field-map";
import { formatFormNumber } from "./format";
import { orderEducation, orderSessions, recentWork, type SessionRow } from "./rows";

// The input of a generated form (ba-forms.md, what is filled): built from domain data by
// `tl407Input` and `kug200bInput`, keyed by the field map's keys, before any layout. Dates are
// ISO, times `hh:mm`, radio and choice values our codes, checkboxes booleans; null is blank.

export type FormValue = string | boolean;
export type FormRow = Readonly<Record<string, FormValue | null>>;
export type FormInput = {
  formCode: FormCode;
  projectType: ProjectType;
  values: Readonly<Record<string, FormValue | null>>;
  tables: Readonly<Record<string, readonly FormRow[]>>;
};

/**
 * The delivering legal entity, the TL 407's Maßnahmeträger and the Kug 200b's TG (Q181), from
 * the organisation configuration; never the old employer.
 */
export const TransferCompany = z.strictObject({
  name: z.string().min(1),
  street: z.string().min(1),
  houseNumber: z.string().min(1),
  postalCode: z.string().regex(/^[0-9]{5}$/),
  city: z.string().min(1),
});
export type TransferCompany = z.infer<typeof TransferCompany>;

/** TL 407 section C: one line's rating (ba-forms.md). */
export const SectionCRating = z.enum(["no_need", "placement_relevant"]);
export type SectionCRating = z.infer<typeof SectionCRating>;

/** TL 407 field 50: the Jobbörse choice, a declaration to the BA (ba-forms.md, Q44). */
export const JobboerseChoice = z.enum(["full", "anonymous_callme", "anonymous_no_contact", "none"]);
export type JobboerseChoice = z.infer<typeof JobboerseChoice>;

type Line = { rating: SectionCRating | null; text: string | null };
type OtherLine = Line & { label: string | null };

/** Section C and p. 7 as the profiler recorded them; the health line has its rating only (Q192). */
export type Tl407Assessment = {
  schoolQualification: Line;
  vocationalQualification: Line;
  workExperience: Line;
  languageSkills: Line;
  otherQualification: OtherLine;
  health: { rating: SectionCRating | null };
  intellectualCapacity: Line;
  workAndSocialBehaviour: Line;
  otherPerformance: OtherLine;
  initiative: Line;
  learningReadiness: Line;
  otherMotivation: OtherLine;
  localMobility: Line;
  otherConditions: OtherLine;
  overallAssessment: string | null;
  nextSteps: string | null;
};

type Profile = Pick<
  SelfServiceValues,
  | "gender"
  | "maritalStatus"
  | "educationHistory"
  | "workHistory"
  | "languageSkills"
  | "drivingLicence"
  | "vehicleAvailable"
  | "workingTimePreferences"
  | "jobWishes"
  | "desiredWorkLocations"
  | "maxCommuteDistance"
  | "earliestStartDate"
>;

export type Tl407Source = {
  projectType: ProjectType;
  /** The Berlin date of the generation (the jobs of the last three years). */
  today: IsoDate;
  transferCompany: TransferCompany;
  identity: { firstName: string; lastName: string; birthDate: IsoDate | null };
  /** The effective contractual TG dates; used only in `ta_tg` (Q181). */
  tgStart: IsoDate | null;
  tgEnd: IsoDate | null;
  contact: {
    address: ContactAddress | null;
    phone: string | null;
    mobile: string | null;
    privateEmail: string | null;
  };
  profile: Profile;
  sensitive: SensitiveValues;
  unemployment: { from: IsoDate | null; until: IsoDate | null };
  sessions: readonly SessionRow[];
  /** The pending declarations to the BA (ba-forms.md, declarations): never the portal consent. */
  declarations: { jobboerseChoice: JobboerseChoice | null; baContact: boolean | null };
  assessment: Tl407Assessment | null;
};

const yesNo = (value: boolean | null) => (value === null ? null : value ? "yes" : "no");

const houseNumber = /^(.*?\S)\s+([0-9]+(?:\s?[a-zA-Z])?(?:\s*[-/]\s*[0-9]+(?:\s?[a-zA-Z])?)?)$/;
// A street left ending in a bare number or a separator: which part is the house number is unclear.
const ambiguousStreet = /(?:^|\s)[0-9]+(?:\s?[a-zA-Z])?$|[-/]$/;

/**
 * A German street with its house number split for the forms' two fields (Q197): the trailing
 * house number or range (`12`, `12a`, `12 a`, `12-14`, `12 - 14`, `3/4b`, `3 / 4b`), keeping
 * digits inside the street name (`Straße des 17. Juni 12a`). Without a clear trailing number, or
 * when the street would still end in one (`Weg 7 12`), the original text stays the street and
 * the number blank, for clarification or handwriting.
 */
export function splitStreet(street: string): { street: string; houseNumber: string | null } {
  const match = houseNumber.exec(street.trim());
  if (!match || ambiguousStreet.test(match[1]!)) return { street, houseNumber: null };
  return { street: match[1]!, houseNumber: match[2]! };
}

function address(value: ContactAddress | null) {
  if (value === null) return { street: null, houseNumber: null, postalCode: null, city: null };
  return { ...splitStreet(value.street), postalCode: value.postalCode, city: value.city };
}

const countryNames = new Intl.DisplayNames(["de"], { type: "region", fallback: "code" });

/** The other nationality as its German country name (TL 407 field 31, Kug 200b field 10). */
function nationality(value: SensitiveValues["nationality"]) {
  if (value === null) return { nationality: null, otherNationality: null };
  return value.kind === "german"
    ? { nationality: "german", otherNationality: null }
    : { nationality: "other", otherNationality: countryNames.of(value.country)! };
}

function drivingLicence(value: Profile["drivingLicence"]): string | null {
  if (value === null) return null;
  return value === "none" ? "keine" : value.join(", ");
}

const assessmentLines = [
  ["schoolQualification", false],
  ["vocationalQualification", false],
  ["workExperience", false],
  ["languageSkills", false],
  ["otherQualification", true],
  ["intellectualCapacity", false],
  ["workAndSocialBehaviour", false],
  ["otherPerformance", true],
  ["initiative", false],
  ["learningReadiness", false],
  ["otherMotivation", true],
  ["localMobility", false],
  ["otherConditions", true],
] as const;

function assessment(value: Tl407Assessment | null): Record<string, string | null> {
  const values: Record<string, string | null> = {
    "assessment.health.rating": value?.health.rating ?? null,
    overallAssessment: value?.overallAssessment ?? null,
    nextSteps: value?.nextSteps ?? null,
  };
  for (const [line, labelled] of assessmentLines) {
    const entry: OtherLine | Line | undefined = value?.[line];
    values[`assessment.${line}.rating`] = entry?.rating ?? null;
    values[`assessment.${line}.text`] = entry?.text ?? null;
    if (labelled)
      values[`assessment.${line}.label`] = (entry as OtherLine | undefined)?.label ?? null;
  }
  return values;
}

/**
 * The TL 407 08/2025 input (ba-forms.md, what is filled): §110 in `ta_only`, §111 in `ta_tg`;
 * the Träger from the organisation; the beE stay from the TG dates in `ta_tg`, blank in
 * `ta_only`; phone, mobile and email only under the form's own BA contact declaration; the health
 * line's rating without text; signatures, their places and dates, and the Vermerke never.
 */
export function tl407Input(source: Tl407Source): FormInput {
  const { profile, sensitive, contact } = source;
  const tg = source.projectType === "ta_tg";
  const shareContact = source.declarations.baContact === true;
  const preferences = profile.workingTimePreferences;
  const distance = profile.maxCommuteDistance;
  const values: Record<string, FormValue | null> = {
    paragraph110: !tg,
    paragraph111: tg,
    "carrier.name": source.transferCompany.name,
    "carrier.street": source.transferCompany.street,
    "carrier.houseNumber": source.transferCompany.houseNumber,
    "carrier.postalCode": source.transferCompany.postalCode,
    "carrier.city": source.transferCompany.city,
    firstName: source.identity.firstName,
    lastName: source.identity.lastName,
    birthDate: source.identity.birthDate,
    beeFrom: tg ? source.tgStart : null,
    beeTo: tg ? source.tgEnd : null,
    pensionInsuranceNumber: sensitive.pensionInsuranceNumber,
    gender: profile.gender,
    ...address(contact.address),
    phone: shareContact ? contact.phone : null,
    mobile: shareContact ? contact.mobile : null,
    email: shareContact ? contact.privateEmail : null,
    maritalStatus: profile.maritalStatus,
    ...nationality(sensitive.nationality),
    entryToGermanyDate: sensitive.entryToGermanyDate,
    residenceStatus: sensitive.residenceStatus,
    unemployedFrom: source.unemployment.from,
    unemployedUntil: source.unemployment.until,
    buergergeld: yesNo(sensitive.buergergeld),
    healthRestrictions: yesNo(sensitive.healthRestrictions),
    severeDisability: yesNo(sensitive.severeDisability),
    germanLevel: profile.languageSkills?.german ?? null,
    drivingLicence: drivingLicence(profile.drivingLicence),
    vehicleAvailable: yesNo(profile.vehicleAvailable),
    employmentType: preferences?.employmentType ?? null,
    weeklyHours:
      preferences?.weeklyHours == null ? null : formatFormNumber(preferences.weeklyHours),
    workingTimeDistribution: preferences?.distribution ?? null,
    desiredJob: profile.jobWishes?.desired ?? null,
    alternativeJob: profile.jobWishes?.alternative ?? null,
    desiredWorkLocations: profile.desiredWorkLocations,
    maxDistanceKm: distance?.kind === "km" ? String(distance.km) : null,
    maxDistanceScope: distance && distance.kind !== "km" ? distance.kind : null,
    jobboerseChoice: source.declarations.jobboerseChoice,
    earliestStartDate: profile.earliestStartDate,
    ...assessment(source.assessment),
  };
  return {
    formCode: "tl407",
    projectType: source.projectType,
    values,
    tables: {
      sessions: orderSessions(source.sessions).map(({ date, from, to }) => ({ date, from, to })),
      education: orderEducation(
        (profile.educationHistory ?? []).map((row) => ({
          ...row,
          kind: row.highestSchoolQualification ? ("school" as const) : ("other" as const),
        })),
      ).map((row) => ({
        from: row.from,
        to: row.to,
        institution: row.institution,
        qualification: row.qualification,
        completed: yesNo(row.completed),
      })),
      work: recentWork(profile.workHistory ?? [], source.today).map((row) => ({
        from: row.from,
        to: row.to,
        employer: row.employer,
        activity: row.activity,
      })),
      languages: (profile.languageSkills?.others ?? []).map(({ language, level }) => ({
        language,
        level,
      })),
    },
  };
}

export type Kug200bSource = {
  transferCompany: TransferCompany;
  /** The project's customer, the personalabgebender Betrieb. */
  customerName: string | null;
  identity: { firstName: string; lastName: string };
  address: ContactAddress | null;
  maritalStatus: SelfServiceValues["maritalStatus"];
  sensitive: Pick<SensitiveValues, "nationality" | "pensionInsuranceNumber" | "severeDisability">;
};

/**
 * The Kug 200b 09/2021 input (ba-forms.md, what is filled): 1–12 from the TG, the customer and
 * the participant's data; missing data stays blank for the participant to write. The voluntary
 * contact data 13–15, the declarations 16 and 17 and place and date 18–19 are never filled.
 */
export function kug200bInput(source: Kug200bSource): FormInput {
  return {
    formCode: "kug200b",
    projectType: "ta_tg",
    values: {
      tgName: source.transferCompany.name,
      employerName: source.customerName,
      firstName: source.identity.firstName,
      lastName: source.identity.lastName,
      ...address(source.address),
      maritalStatus: source.maritalStatus,
      ...nationality(source.sensitive.nationality),
      pensionInsuranceNumber: source.sensitive.pensionInsuranceNumber,
      severeDisability: yesNo(source.sensitive.severeDisability),
    },
    tables: {},
  };
}
