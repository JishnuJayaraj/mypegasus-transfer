import { resolveForParticipation } from "@transfer/config";
import { canonicalHash } from "@transfer/config/load";
import type { Clock } from "@transfer/adapters";
import {
  and,
  desc,
  eq,
  importColumnMapping,
  inArray,
  participantDetails,
  participantIdentity,
  participation,
  project,
  projectEntryWave,
  sql,
  type Database,
} from "@transfer/db";
import {
  checkMapping,
  planImport,
  suggestTargets,
  terminalMainStatuses,
  validateRow,
  type ColumnMapping,
  type ExistingParticipant,
  type ImportCounts,
  type ImportCell,
  type ImportIssue,
  type ImportPlan,
  type ImportPreviewInput,
  type ImportReportRow,
  type ImportTarget,
  type ImportValues,
  type ValidatedRow,
  type ContactField,
} from "@transfer/domain";
import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type { StaffSubject } from "../participations/subjects";
import { projectSnapshot, type Release } from "../projects/template-pins";
import { ImportFileError } from "./errors";
import { decodeFile, toGrid, type Grid } from "./grid";
import { auditContext, callFunction } from "../sql";
import { headerHmac } from "./keys";
import { defaultParseDeps, parseSpreadsheet } from "./parse";
import type { Slots } from "./slots";

// What the preview and the confirm share (process-and-lifecycle.md, Import): the state a plan
// needs, the mapping suggestions, the analysis of a file against that state, the report and the
// digest the preview token binds. Nothing here logs a file name, a header or a value.

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** A refusal with stable codes: a file, a domain rule, a stale preview or a missing project. */
export class ImportRefusal extends Error {
  override readonly name = "ImportRefusal";

  constructor(
    readonly kind: "file" | "domain" | "conflict" | "not_found",
    readonly issues: { code: string; field: string | null }[] = [],
  ) {
    super(kind);
  }
}

export const domain = (code: string, field: string | null = null) =>
  new ImportRefusal("domain", [{ code, field }]);

export type ImportActor = {
  staffUserId: string;
  requestId: string | null;
  subject: StaffSubject;
};

export type ImportContext = {
  db: Database;
  release: Release;
  clock: Clock;
  logger: Logger;
  /** The parse-worker slots (ADR-0010, uploads). */
  slots: Slots;
  /** Keys derived from `SESSION_SECRET` (keys.ts). */
  mapKey: Buffer;
  tokKey: Buffer;
};

/** What a plan needs from the database, read in one transaction. */
export type State = {
  type: "ta_tg" | "ta_only";
  customerName: string;
  relaxedRuleIds: Set<string>;
  existing: ExistingParticipant[];
  /** The stored values by participation, for old values and kept values. */
  stored: Map<string, ImportValues>;
  /** The contact fields each participant maintains, which the import never overwrites (Q112). */
  maintained: Map<string, ReadonlySet<ContactField>>;
};

const valueColumns = [
  "personnelNumber",
  "lastName",
  "firstName",
  "birthDate",
  "oldEmploymentEndDate",
  "addressStreet",
  "addressPostalCode",
  "addressCity",
  "addressCountry",
  "phone",
  "mobile",
  "privateEmail",
  "workEmail",
] as const satisfies readonly ImportTarget[];

export async function loadState(
  tx: Tx,
  release: Release,
  projectId: string,
): Promise<State | undefined> {
  const snapshot = await projectSnapshot(tx, release, projectId);
  if (!snapshot) return undefined;
  const [{ customerName }] = (await tx
    .select({ customerName: project.customerName })
    .from(project)
    .where(eq(project.id, projectId))) as [{ customerName: string }];
  // The import's required targets are base rules, and a new participation has no placement
  // Agentur (regional-variation.md, "Placement Agentur"): the base-only chain, plus the project's.
  const resolution = resolveForParticipation({ ...snapshot.input, placementAgenturKey: null });
  const relaxedRuleIds = new Set(resolution.config.relaxed.map(({ ruleId }) => ruleId));
  const rows = await tx
    .select({
      id: participation.id,
      status: participation.status,
      personnelNumber: participantIdentity.personnelNumber,
      lastName: participantIdentity.lastName,
      firstName: participantIdentity.firstName,
      birthDate: participantIdentity.birthDate,
      oldEmploymentEndDate: participantDetails.oldEmploymentEndDate,
      addressStreet: participantDetails.addressStreet,
      addressPostalCode: participantDetails.addressPostalCode,
      addressCity: participantDetails.addressCity,
      addressCountry: participantDetails.addressCountry,
      phone: participantDetails.phone,
      mobile: participantDetails.mobile,
      privateEmail: participantDetails.privateEmail,
      workEmail: participantDetails.workEmail,
      participantMaintained: participantDetails.participantMaintained,
    })
    .from(participation)
    .innerJoin(participantIdentity, eq(participantIdentity.participationId, participation.id))
    .leftJoin(participantDetails, eq(participantDetails.participationId, participation.id))
    .where(eq(participation.projectId, projectId));
  const existing: ExistingParticipant[] = [];
  const stored = new Map<string, ImportValues>();
  const maintained = new Map<string, ReadonlySet<ContactField>>();
  for (const row of rows) {
    const values: ImportValues = {};
    for (const target of valueColumns) {
      const value = row[target];
      if (value !== null) values[target] = value;
    }
    stored.set(row.id, values);
    const kept = new Set((row.participantMaintained ?? []) as ContactField[]);
    if (kept.size > 0) maintained.set(row.id, kept);
    existing.push({
      participationId: row.id,
      terminal: terminalMainStatuses.has(row.status),
      values: values as ExistingParticipant["values"],
      ...(kept.size > 0 && { participantMaintained: kept }),
    });
  }
  return {
    type: snapshot.project.type,
    customerName,
    relaxedRuleIds,
    existing,
    stored,
    maintained,
  };
}

/**
 * The wave of a new participation: only a `ta_tg` project's own waves (process-and-lifecycle.md,
 * Dates).
 */
export async function checkWave(
  tx: Tx,
  state: State,
  projectId: string,
  waveId: string | undefined,
) {
  if (waveId === undefined) return;
  if (state.type !== "ta_tg") throw domain("not_ta_tg", "waveId");
  const [wave] = await tx
    .select({ id: projectEntryWave.id })
    .from(projectEntryWave)
    .where(and(eq(projectEntryWave.id, waveId), eq(projectEntryWave.projectId, projectId)));
  if (!wave) throw domain("wave_of_other_project", "waveId");
}

type Source = "project" | "customer" | "builtin";

/**
 * The suggested target per column (process-and-lifecycle.md, Import): this project's saved mappings
 * first, then those of the project's customer (other projects, newest first), then the built-in
 * synonyms; one target once.
 */
export async function suggest(
  tx: Tx,
  key: Buffer,
  projectId: string,
  customerName: string,
  headers: readonly string[],
) {
  const hmacs = headers.map((header) => headerHmac(key, header));
  const wanted = [...new Set(hmacs.filter((h): h is string => h !== null))];
  const own = wanted.length
    ? await tx
        .select({ hmac: importColumnMapping.headerHmac, target: importColumnMapping.target })
        .from(importColumnMapping)
        .where(
          and(
            eq(importColumnMapping.projectId, projectId),
            inArray(importColumnMapping.headerHmac, wanted),
          ),
        )
    : [];
  const other = wanted.length
    ? await tx
        .select({ hmac: importColumnMapping.headerHmac, target: importColumnMapping.target })
        .from(importColumnMapping)
        .innerJoin(project, eq(project.id, importColumnMapping.projectId))
        .where(
          and(
            sql`${project.id} <> ${projectId}::uuid`,
            sql`lower(btrim(${project.customerName})) = lower(btrim(${customerName}))`,
            inArray(importColumnMapping.headerHmac, wanted),
          ),
        )
        .orderBy(desc(importColumnMapping.updatedAt))
    : [];
  const result: { column: number; target: ImportTarget; source: Source }[] = [];
  const used = new Set<ImportTarget>();
  const assigned = new Set<number>();
  const take = (
    saved: { hmac: string; target: ImportTarget }[],
    source: Exclude<Source, "builtin">,
  ) => {
    hmacs.forEach((hmac, column) => {
      if (hmac === null || assigned.has(column)) return;
      const found = saved.find((s) => s.hmac === hmac);
      if (!found || used.has(found.target)) return;
      used.add(found.target);
      assigned.add(column);
      result.push({ column, target: found.target, source });
    });
  };
  take(own, "project");
  take(other, "customer");
  suggestTargets(headers).forEach((target, column) => {
    if (target === null || assigned.has(column) || used.has(target)) return;
    used.add(target);
    assigned.add(column);
    result.push({ column, target, source: "builtin" });
  });
  return result.toSorted((a, b) => a.column - b.column);
}

type Analysis = {
  mappingIssues: ImportIssue[];
  validated: ValidatedRow[];
  plan: ImportPlan | null;
};

/** The mapping check, then every row validated and planned (pure given the state). */
export function analyse(args: {
  grid: Grid;
  mapping: readonly ColumnMapping[];
  country: string | null;
  state: State;
  today: ReturnType<Clock["today"]>;
}): Analysis {
  const { grid, mapping, country, state, today } = args;
  const mappingIssues = checkMapping({
    targets: mapping.map((m) => m.target),
    relaxedRuleIds: state.relaxedRuleIds,
    country,
  });
  if (mappingIssues.length > 0) return { mappingIssues, validated: [], plan: null };
  const validated = grid.rows.map(({ row, cells }) =>
    validateRow({
      row,
      cells: Object.fromEntries(
        mapping.map((m): [ImportTarget, ImportCell | undefined] => [m.target, cells[m.column]]),
      ),
      country,
      today,
    }),
  );
  const plan = planImport({
    rows: validated,
    mapped: new Set(mapping.map((m) => m.target)),
    existing: state.existing,
    relaxedRuleIds: state.relaxedRuleIds,
  });
  return { mappingIssues, validated, plan };
}

const addressText = (v: ImportValues) =>
  `${v.addressStreet}, ${v.addressPostalCode} ${v.addressCity}, ${v.addressCountry}`;

/** The rows that need the PL's attention, with old and new values and the kept ones (round 32). */
export function reportRows(
  plan: ImportPlan,
  validated: ValidatedRow[],
  state: State,
): ImportReportRow[] {
  const values = new Map(validated.map((v) => [v.row, v.values]));
  return plan.rows
    .filter((r) => r.outcome !== "create" || r.issues.length > 0)
    .filter((r) => !(r.outcome === "unchanged" && r.issues.length === 0))
    .map((r): ImportReportRow => {
      const stored = r.participationId ? state.stored.get(r.participationId) : undefined;
      const row: ImportReportRow = {
        row: r.row,
        outcome: r.outcome,
        issues: r.issues.map(({ row: n, target, code, severity }) => ({
          row: n as number,
          target,
          code,
          severity,
        })),
      };
      const personnelNumber = values.get(r.row)?.personnelNumber;
      if (personnelNumber !== undefined) row.personnelNumber = personnelNumber;
      if (r.outcome === "update" && stored) {
        row.changes = (r.changed ?? []).map((target) => ({
          target,
          old: stored[target] ?? null,
          new: values.get(r.row)![target] as string,
        }));
      }
      const kept = r.issues.filter((i) => i.code === "kept_existing" && stored);
      if (kept.length > 0) {
        row.kept = kept.map(({ target }) => ({
          target: target!,
          value:
            target === "address"
              ? addressText(stored!)
              : (stored![target as ImportTarget] as string),
        }));
      }
      return row;
    });
}

export function countsOf(plan: ImportPlan): ImportCounts {
  return {
    rows: plan.rows.length,
    ...plan.counts,
    warnings: plan.rows.reduce(
      (n, r) => n + r.issues.filter((i) => i.severity === "warning").length,
      0,
    ),
    missing: plan.missing,
  };
}

/** Everything that decides what a confirm would write, as one digest (the token binds it). */
export function planDigest(plan: ImportPlan, validated: ValidatedRow[], state: State): string {
  return canonicalHash({
    rows: plan.rows.map((r) => ({
      row: r.row,
      outcome: r.outcome,
      participationId: r.participationId ?? null,
      changed: r.changed ?? null,
      issues: r.issues.map((i) => [i.target, i.code, i.severity]),
    })),
    values: validated.map((v) => [v.row, v.values]),
    stored: plan.rows.flatMap((r) =>
      r.participationId ? [[r.participationId, state.stored.get(r.participationId) ?? null]] : [],
    ),
    // A field the participant started maintaining since the preview changes what is written.
    maintained: plan.rows.flatMap((r) =>
      r.participationId
        ? [[r.participationId, [...(state.maintained.get(r.participationId) ?? [])].toSorted()]]
        : [],
    ),
    relaxed: [...state.relaxedRuleIds].toSorted(),
    missing: plan.missing,
  });
}

export const cleanCountry = (country: string | null | undefined) => country?.trim() || null;

/** Decodes and parses the file (before any transaction); a refusal is `kind: "file"`. */
export async function readFile(input: ImportPreviewInput, slots: Slots) {
  try {
    const bytes = decodeFile(input.file);
    const parsed = await parseSpreadsheet(
      { bytes, sheet: input.sheet, csv: input.csv },
      { ...defaultParseDeps, slots },
    );
    return {
      parsed,
      grid: toGrid(parsed, input.headerRow),
      fileHash: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (error instanceof ImportFileError) {
      throw new ImportRefusal("file", [{ code: error.code, field: "file" }]);
    }
    throw error;
  }
}

/** A mapping that names a column the file doesn't have is refused (422 at `/mapping`). */
export function checkColumns(grid: Grid, mapping: readonly ColumnMapping[] | undefined) {
  if (mapping?.some((m) => m.column >= grid.headers.length)) {
    throw domain("mapping_column_unknown", "mapping");
  }
}

export const binding = (
  projectId: string,
  read: Awaited<ReturnType<typeof readFile>>,
  input: ImportPreviewInput,
  mapping: readonly ColumnMapping[],
  digest: string,
) => ({
  projectId,
  fileHash: read.fileHash,
  sheet: read.parsed.sheet,
  csv: read.parsed.csv,
  headerRow: read.grid.headerRow,
  mapping: [...mapping],
  country: cleanCountry(input.country),
  waveId: input.waveId ?? null,
  planDigest: digest,
});

/**
 * Writes a participation's person data through `write_participant_data` (data-protection.md,
 * person-data writes): a missing value is `null`, which keeps the stored one (Q103: an empty cell
 * never clears data).
 */
export function writeParticipantData(
  tx: Tx,
  context: ReturnType<typeof auditContext>,
  participationId: string,
  v: ImportValues,
) {
  return callFunction(
    tx,
    sql`write_participant_data(p_participation_id => ${participationId}::uuid,
      p_context => ${context},
      p_personnel_number => ${v.personnelNumber ?? null}::text,
      p_last_name => ${v.lastName ?? null}::text,
      p_first_name => ${v.firstName ?? null}::text,
      p_birth_date => ${v.birthDate ?? null}::date,
      p_old_employment_end_date => ${v.oldEmploymentEndDate ?? null}::date,
      p_address_street => ${v.addressStreet ?? null}::text,
      p_address_postal_code => ${v.addressPostalCode ?? null}::text,
      p_address_city => ${v.addressCity ?? null}::text,
      p_address_country => ${v.addressCountry ?? null}::text,
      p_phone => ${v.phone ?? null}::text, p_mobile => ${v.mobile ?? null}::text,
      p_private_email => ${v.privateEmail ?? null}::text,
      p_work_email => ${v.workEmail ?? null}::text)`,
  );
}
