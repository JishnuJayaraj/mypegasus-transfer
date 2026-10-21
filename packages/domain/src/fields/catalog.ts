import { z } from "zod";
import type { DataClass, ParticipantRetentionClass } from "../enums";

/**
 * Categories of participant fields and documents (data-protection.md). Audit
 * metadata and aggregates are resource kinds of their own (`decideAccess`, round 11).
 */
export const AccessCategory = z.enum([
  "case_internal",
  "confidential",
  "health",
  "disability",
  "identifiers",
  "residence_social",
  "profiling_assessment",
  "signed_tl407",
  "signed_kug200b",
  "employment_contract",
  "absence",
]);
export type AccessCategory = z.infer<typeof AccessCategory>;

export type FieldEntry = {
  key: string;
  dataClass: DataClass;
  accessCategory: AccessCategory;
  /** May appear in list payloads. Never for special-category or highly confidential data. */
  listable: boolean;
  /** On the customer whitelist (provisional, Q13). */
  customerVisible: boolean;
  /** The participant may write it (Q65; reviewed with the access matrix in PR 1d). */
  selfService: boolean;
  storage: "column" | "encrypted_column";
  /** Values more sensitive than the field itself (Q66). */
  valueClasses?: Readonly<Record<string, DataClass>>;
  /** Set for every field a table stores (ADR-0008). */
  retentionClass?: ParticipantRetentionClass;
};

type Options = Partial<
  Pick<FieldEntry, "listable" | "customerVisible" | "valueClasses" | "retentionClass">
>;

const sensitive = (c: DataClass) => c === "special_category" || c === "highly_confidential";

function field(
  key: string,
  dataClass: DataClass,
  accessCategory: AccessCategory,
  selfService: boolean,
  options: Options = {},
): FieldEntry {
  return {
    key,
    dataClass,
    accessCategory,
    listable: options.listable ?? !sensitive(dataClass),
    customerVisible: options.customerVisible ?? false,
    selfService,
    storage: sensitive(dataClass) ? "encrypted_column" : "column",
    ...(options.valueClasses && { valueClasses: options.valueClasses }),
    ...(options.retentionClass && { retentionClass: options.retentionClass }),
  };
}

/** Several fields with the same classification. */
function fields(
  keys: string[],
  ...rest: [dataClass: DataClass, category: AccessCategory, selfService: boolean, options?: Options]
): FieldEntry[] {
  return keys.map((key) => field(key, ...rest));
}

const C = "confidential";
const record = { retentionClass: "participation_record" } as const;
const personnelFile = { retentionClass: "personnel_file" } as const;
const customer = { customerVisible: true, ...record };

/**
 * Every participant field the docs name, classified by data-protection.md (Q29, Q43, Q66) and
 * ba-forms.md (TL 407 / Kug 200b sections). Documents get their own types (PR 1e).
 */
export const fieldCatalog: readonly FieldEntry[] = [
  // statuses and dates (internal), on `participation`
  ...fields(["status", "profilingStatus", "dsvStatus"], "internal", "case_internal", false, record),
  ...fields(["activationStatus", "privacyNoticeState"], "internal", "case_internal", false, {
    listable: true,
  }),
  ...fields(["offerDeadline", "tgStart", "tgEnd"], "internal", "case_internal", false, record),
  field("dsvSignedOn", "internal", "case_internal", false, { customerVisible: true }),
  ...fields(["tgEntryDate", "exitDate"], "internal", "case_internal", false, customer),
  ...fields(["withdrawnOn", "profilingDoneOn"], "internal", "case_internal", false, record),
  // The Agentur the participant is placed with (Q139), a key; listed with the case data
  field("placementAgenturKey", "internal", "case_internal", false, { listable: true, ...record }),
  // identity and case data (confidential); identity fields come from the import, on
  // `participant_identity` (participation record) and `participant_details` (personnel file,
  // Q105); `address` is street, postal code, city and country as one unit (round 32)
  ...fields(["firstName", "lastName", "personnelNumber"], C, "confidential", false, customer),
  field("birthDate", C, "confidential", false, record),
  ...fields(["workEmail", "oldEmploymentEndDate"], C, "confidential", false, personnelFile),
  field("knowledgeDate", C, "confidential", false),
  ...fields(["address", "phone", "mobile", "privateEmail"], C, "confidential", true, personnelFile),
  // The participant's verified portal contacts (ADR-0007, Q123): staff see kind, state and
  // dates only, never the address; never in lists
  field("portalChannels", C, "confidential", true, { listable: false, ...personnelFile }),
  ...fields(
    ["maritalStatus", "gender", "educationHistory", "workHistory"],
    C,
    "confidential",
    true,
  ),
  ...fields(["qualifications", "languageSkills", "drivingLicence"], C, "confidential", true),
  ...fields(["vehicleAvailable", "workingTimePreferences", "jobWishes"], C, "confidential", true),
  ...fields(["desiredWorkLocations", "maxCommuteDistance"], C, "confidential", true),
  field("earliestStartDate", C, "confidential", true),
  // recorded by the profiler on the profiling record (ba-forms.md)
  ...fields(["profilingSessions", "jobboerseChoice", "baContactConsent"], C, "confidential", false),
  field("endReason", C, "confidential", false, {
    valueClasses: { long_term_illness_reduced_earning_capacity: "special_category" },
    ...record,
  }),
  // DSV amendments and BA reporting tasks (process-and-lifecycle.md; round 32): operational
  // evidence of contractual date changes, never in lists or customer exports
  ...fields(["dsvAmendment", "baReportingTask"], C, "confidential", false, {
    listable: false,
    ...record,
  }),
  // codes only; `participant_prevented_documented` deliberately reveals no illness (Q81)
  field("profilingExceptionReasonCode", C, "confidential", false, record),
  // special category
  field("healthRestrictions", "special_category", "health", true),
  ...fields(["severeDisability", "disabilityDegree"], "special_category", "disability", true),
  // highly confidential
  field("pensionInsuranceNumber", "highly_confidential", "identifiers", true),
  ...fields(["taxId", "iban", "baCustomerNumber"], "highly_confidential", "identifiers", false),
  ...fields(["nationality", "entryToGermanyDate"], "highly_confidential", "residence_social", true),
  ...fields(["residenceStatus", "buergergeld"], "highly_confidential", "residence_social", true),
  // Q85 (open): not classified by the docs; the stricter class of its TL 407 section meanwhile
  field("unemploymentPeriod", "highly_confidential", "residence_social", true),
  // TL 407 section C and p. 7, profiler only; the health line is special category
  ...fields(
    ["profilingAssessment", "overallAssessment", "nextSteps"],
    "highly_confidential",
    "profiling_assessment",
    false,
  ),
  field("profilingHealthAssessment", "special_category", "profiling_assessment", false),
  // payroll records, type and dates only (Q51); not listed until Q85 is answered
  field("absencePeriods", C, "absence", false, { listable: false }),
];

/** The person-data fields `write_participant_data` writes, as its audit event names them. */
export const ParticipantDataField = z.enum([
  "personnelNumber",
  "lastName",
  "firstName",
  "birthDate",
  "oldEmploymentEndDate",
  "address",
  "phone",
  "mobile",
  "privateEmail",
  "workEmail",
]);
export type ParticipantDataField = z.infer<typeof ParticipantDataField>;

const byKey = new Map(fieldCatalog.map((entry) => [entry.key, entry]));

export function fieldEntry(key: string): FieldEntry {
  const entry = byKey.get(key);
  if (!entry) throw new Error(`Unknown field ${key}`);
  return entry;
}

/** The class of one stored value: the field's, unless that value is more sensitive. */
export function valueDataClass(key: string, value: string): DataClass {
  const entry = fieldEntry(key);
  return entry.valueClasses?.[value] ?? entry.dataClass;
}

/** Whether the field, or one of its values, may appear in a list payload. */
export function isListable(key: string, value?: string): boolean {
  const entry = fieldEntry(key);
  if (!entry.listable) return false;
  return value === undefined || !sensitive(valueDataClass(key, value));
}
