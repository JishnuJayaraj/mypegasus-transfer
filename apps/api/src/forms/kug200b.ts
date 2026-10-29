import { type PdfRenderer } from "@transfer/adapters";
import { configDirs, loadOrganisation } from "@transfer/config/load";
import {
  eq,
  participation,
  project,
  projectEntryWave,
  sql,
  transactionWithClient,
  type Database,
} from "@transfer/db";
import {
  checkKug200b,
  effectiveTgEnd,
  effectiveTgStart,
  kug200bInput,
  type IsoDate,
  type Kug200bGeneration,
  type Kug200bSource,
} from "@transfer/domain";
import type { SQL } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import type { DocumentFiles } from "../documents/files";
import { objectKey } from "../documents/files";
import { documentEncryptionKey, encryptDocument } from "../document-encryption";
import type { FieldKey } from "../field-encryption";
import { loadSelfService } from "../participations/self-service";
import type { Release } from "../projects/template-pins";
import { textArray } from "../routes/self-service";
import { formPersonOf, organisationFingerprint, sha256, type FormPerson } from "./person";
import type { FormRegistry } from "./registry";

// The Kug 200b (data-protection.md, generated forms; ba-forms.md, what is filled; Q179, Q197):
// generated for one participation by the PL or the assigned consultant, or for 1–100 by the PL in
// one transaction, all or nothing. The values it prints from the sensitive answers are decrypted
// only by `read_kug200b_values`, each read audited; the form and its handwriting checklist are
// what the response carries, never a value. Nothing here logs a value.

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** The sensitive answers a Kug 200b prints (10–12). */
const printedKeys = ["nationality", "pensionInsuranceNumber", "severeDisability"] as const;

export type Kug200bDeps = {
  db: Database;
  release: Release;
  registry: FormRegistry;
  renderer: () => PdfRenderer;
  files: DocumentFiles | undefined;
  fieldKey: FieldKey;
  documentKeyRoot: string;
  configDir: string | undefined;
};

/** Why a generation was refused: domain codes (with the participation in a bulk), or the store. */
export type Kug200bRefusal =
  | { kind: "domain"; participationId: string; codes: string[] }
  | { kind: "unavailable"; code: "storage_unavailable" | "pdf_unavailable" }
  | { kind: "function"; error: unknown };

type Prepared = Kug200bGeneration & {
  content: Uint8Array;
  sources: { profile: number; profiling: number; assessment: number; unemployment: number };
  person: FormPerson;
  /** The employer printed (the project's customer name), compared again at the record. */
  employerSha256: string;
  token: string;
};

export function kug200bService(deps: Kug200bDeps) {
  const { db, release, registry } = deps;
  const organisation = loadOrganisation(configDirs(deps.configDir).organisation);
  const company = organisation.transfergesellschaft;
  const organisationSha256 = organisationFingerprint(company);
  const documentKey = documentEncryptionKey(deps.documentKeyRoot);
  let renderer: PdfRenderer | undefined;

  /**
   * One participation's form in one REPEATABLE READ snapshot: the participation, its project's
   * customer, the self-service record and the printed sensitive answers through their logged,
   * purpose-bound read; checked against the version in use, laid out and filled. The database
   * functions refuse an actor, project type or participation the generation doesn't allow.
   */
  async function prepare(
    participationId: string,
    today: IsoDate,
    context: SQL,
  ): Promise<{ ok: true; prepared: Prepared } | { ok: false; refusal: Kug200bRefusal }> {
    const version = registry.inUse("kug200b", today);
    if (!version) {
      return {
        ok: false,
        refusal: { kind: "domain", participationId, codes: ["form_version_unavailable"] },
      };
    }
    let read;
    try {
      read = await db.transaction(
        async (tx) => {
          const [found] = await tx
            .select({
              customerName: project.customerName,
              tgStart: participation.tgStart,
              tgEnd: participation.tgEnd,
              offerDeadline: participation.offerDeadline,
              wave: projectEntryWave,
            })
            .from(participation)
            .innerJoin(project, eq(project.id, participation.projectId))
            .leftJoin(projectEntryWave, eq(projectEntryWave.id, participation.entryWaveId))
            .where(eq(participation.id, participationId));
          const record = (await loadSelfService(tx, release, participationId))!;
          const [revisions] = (
            await tx.execute<{ profiling: number; assessment: number; unemployment: number }>(
              sql`select
                (select revision from participant_profiling where participation_id = ${participationId}::uuid) as profiling,
                (select revision from participant_profiling_assessment where participation_id = ${participationId}::uuid) as assessment,
                (select unemployment_revision from participant_residence_social_data where participation_id = ${participationId}::uuid) as unemployment`,
            )
          ).rows;
          const sensitive = await readPrinted(tx, participationId, context, record.sensitive);
          const tgStart = effectiveTgStart(found!, found!.wave);
          const tgEnd = effectiveTgEnd(found!, found!.wave);
          return {
            source: {
              transferCompany: company,
              customerName: found!.customerName,
              identity: record.identity,
              address: record.values.address,
              maritalStatus: record.values.maritalStatus,
              sensitive,
            } satisfies Kug200bSource,
            sources: {
              profile: record.revision,
              profiling: revisions?.profiling ?? 0,
              assessment: revisions?.assessment ?? 0,
              unemployment: revisions?.unemployment ?? 0,
            },
            person: formPersonOf(record, tgStart, tgEnd),
          };
        },
        { isolationLevel: "repeatable read" },
      );
    } catch (error) {
      return { ok: false, refusal: { kind: "function", error } };
    }
    const check = checkKug200b(
      kug200bInput(read.source),
      version.fieldMap,
      today,
      await registry.measure(),
    );
    if (!check.ok) {
      const codes = [...new Set(check.errors.map((error) => error.code))];
      return { ok: false, refusal: { kind: "domain", participationId, codes } };
    }
    renderer ??= deps.renderer();
    const content = await renderer.fillForm({
      template: version.blank,
      fieldMap: version.fieldMap,
      fields: check.layout.fields,
    });
    const formVersion = version.manifest.version;
    const token = sha256(
      `kug200b-sources:v1\n${JSON.stringify([
        formVersion,
        today,
        read.sources.profile,
        Object.values(read.person),
        read.source.customerName,
        organisationSha256,
      ])}`,
    );
    return {
      ok: true,
      prepared: {
        participationId,
        documentId: randomUUID(),
        formVersion,
        checklist: check.checklist,
        content,
        sources: read.sources,
        person: read.person,
        employerSha256: sha256(read.source.customerName),
        token,
      },
    };
  }

  /** The printed sensitive answers that hold a value, each read audited; the others null. */
  async function readPrinted(
    tx: Tx,
    participationId: string,
    context: SQL,
    present: Readonly<Record<string, boolean>>,
  ): Promise<Kug200bSource["sensitive"]> {
    const values: Kug200bSource["sensitive"] = {
      nationality: null,
      pensionInsuranceNumber: null,
      severeDisability: null,
    };
    const keys = printedKeys.filter((key) => present[key]);
    if (keys.length === 0) return values;
    const { rows } = await tx.execute<{ result: Partial<Kug200bSource["sensitive"]> }>(
      sql`select read_kug200b_values(p_participation_id => ${participationId}::uuid,
        p_context => ${context}, p_keys => ${textArray(keys)}::text[],
        p_key => ${deps.fieldKey.key}, p_key_id => ${deps.fieldKey.keyId}) as result`,
    );
    return { ...values, ...rows[0]!.result };
  }

  /** The record of one prepared form, inside the caller's transaction. */
  const record = (
    tx: Pick<Database, "execute">,
    context: SQL,
    form: Prepared,
    keyId: string,
    wrapped: Uint8Array,
  ) =>
    tx.execute(sql`select record_form_generation(
      p_context => ${context}, p_participation_id => ${form.participationId}::uuid,
      p_generation_id => ${randomUUID()}::uuid, p_document_id => ${form.documentId}::uuid,
      p_form_code => 'kug200b'::form_code, p_form_version => ${form.formVersion},
      p_sources => ${JSON.stringify(form.sources)}::jsonb,
      p_person => ${JSON.stringify(form.person)}::jsonb, p_source_token => ${form.token},
      p_organisation_sha256 => ${organisationSha256}, p_declarations => null::jsonb,
      p_confirmed_warnings => '{}'::text[], p_anlage => false,
      p_size_bytes => ${form.content.length}::integer,
      p_content_sha256 => ${createHash("sha256").update(form.content).digest("hex")},
      p_key_id => ${keyId}, p_wrapped_key => ${Buffer.from(wrapped)}::bytea,
      p_checklist => ${JSON.stringify(form.checklist.map(({ code, key }) => ({ code, key })))}::jsonb,
      p_employer_sha256 => ${form.employerSha256}) as result`);

  /**
   * Generates the forms of the participations, in their order: each prepared, then each stored
   * encrypted, then all recorded in one transaction (for more than one under the project's
   * exclusive lock, `lock_bulk_form_generation`). Any refusal records none and deletes every
   * stored object at once.
   */
  async function generate(
    participationIds: readonly string[],
    today: IsoDate,
    context: SQL,
    bulk: { projectId: string } | null,
  ): Promise<
    { ok: true; generations: Kug200bGeneration[] } | { ok: false; refusal: Kug200bRefusal }
  > {
    const files = deps.files;
    if (!files) return { ok: false, refusal: { kind: "unavailable", code: "storage_unavailable" } };
    const prepared: Prepared[] = [];
    for (const participationId of participationIds) {
      const outcome = await prepare(participationId, today, context);
      if (!outcome.ok) return outcome;
      prepared.push(outcome.prepared);
    }
    const stored: string[] = [];
    const removeStored = () =>
      Promise.all(stored.map((id) => files.storage.delete(objectKey(id)).catch(() => undefined)));
    const sealed = new Map<string, { keyId: string; wrappedKey: Uint8Array }>();
    try {
      for (const form of prepared) {
        const seal = encryptDocument(
          documentKey,
          {
            documentId: form.documentId,
            participationId: form.participationId,
            type: "kug200b_form",
          },
          form.content,
        );
        await files.storage.put(objectKey(form.documentId), seal.object);
        stored.push(form.documentId);
        sealed.set(form.documentId, seal);
      }
    } catch {
      await removeStored();
      return { ok: false, refusal: { kind: "unavailable", code: "storage_unavailable" } };
    }
    try {
      await transactionWithClient(db, async (tx) => {
        if (bulk) {
          await tx.execute(sql`select lock_bulk_form_generation(p_context => ${context},
            p_project_id => ${bulk.projectId}::uuid,
            p_participation_ids => ${textArray([...participationIds])}::uuid[])`);
        }
        for (const form of prepared) {
          const seal = sealed.get(form.documentId)!;
          await record(tx, context, form, seal.keyId, seal.wrappedKey);
        }
      });
    } catch (error) {
      await removeStored();
      return { ok: false, refusal: { kind: "function", error } };
    }
    return {
      ok: true,
      generations: prepared.map(({ participationId, documentId, formVersion, checklist }) => ({
        participationId,
        documentId,
        formVersion,
        checklist,
      })),
    };
  }

  return { generate };
}

export type Kug200bService = ReturnType<typeof kug200bService>;
