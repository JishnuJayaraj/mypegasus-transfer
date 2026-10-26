import { mergePdfs, PdfUnavailable, type PdfRenderer } from "@transfer/adapters";
import { configDirs, loadOrganisation } from "@transfer/config/load";
import {
  asc,
  eq,
  participantProfiling,
  participantProfilingAssessment,
  participantResidenceSocialData,
  participation,
  profilingSession,
  project,
  projectEntryWave,
  sql,
  type Database,
} from "@transfer/db";
import {
  checkTl407,
  effectiveTgEnd,
  effectiveTgStart,
  presentSensitiveValues,
  renderAnlage,
  sensitiveFields,
  tl407Input,
  tl407ProfilerReadiness,
  tl407ReadinessSummary,
  unconfirmedWarnings,
  type IsoDate,
  type ProfilingAssessment,
  type Tl407Generation,
  type Tl407Readiness,
  type Tl407Source,
  type Tl407WarningCode,
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
import type { FormRegistry } from "./registry";

// The TL 407 of one participation (data-protection.md, generated forms and the readiness
// projection; ba-forms.md, validation before rendering): its sources read in one snapshot, the
// profiler's check and the PL's summary, and the generation. Only the database functions decrypt,
// each value's read audited `sensitive_read`; nothing here logs or answers a value.

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type SensitiveValues = Tl407Source["sensitive"];

/** The revisions a generation was built from (its provenance), each 0 before the first write. */
export type Tl407Sources = {
  profile: number;
  profiling: number;
  assessment: number;
  unemployment: number;
};

type Read = { source: Tl407Source; sources: Tl407Sources };

/** What the service needs beyond the database. */
export type Tl407Deps = {
  db: Database;
  release: Release;
  registry: FormRegistry;
  /** Built once, on the first generation. */
  renderer: () => PdfRenderer;
  files: DocumentFiles | undefined;
  fieldKey: FieldKey;
  documentKeyRoot: string;
  configDir: string | undefined;
};

/** Why a generation was refused: a domain code with its body location, or the store. */
export type Tl407Refusal =
  | { kind: "domain"; codes: { code: string; field: string | null }[] }
  | { kind: "unavailable"; code: "storage_unavailable" | "pdf_unavailable" }
  | { kind: "function"; error: unknown };

export function tl407Service(deps: Tl407Deps) {
  const { db, release, registry } = deps;
  const organisation = loadOrganisation(configDirs(deps.configDir).organisation);
  const documentKey = documentEncryptionKey(deps.documentKeyRoot);
  let renderer: PdfRenderer | undefined;

  /**
   * The source as the viewer may know it, in one REPEATABLE READ snapshot: the participation and
   * its dates, the self-service record, the profiling record and, with `decrypt`, the sensitive
   * answers, section C and the unemployment period through their logged reads (the present
   * fields only). Without it the sensitive answers are presence stand-ins, never values.
   */
  async function read(
    participationId: string,
    today: IsoDate,
    decrypt: { context: SQL } | null,
  ): Promise<Read> {
    return db.transaction(
      async (tx) => {
        const [found] = await tx
          .select({
            projectType: project.type,
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
        const sessions = await tx
          .select({
            date: profilingSession.sessionDate,
            from: profilingSession.timeFrom,
            to: profilingSession.timeTo,
          })
          .from(profilingSession)
          .where(eq(profilingSession.participationId, participationId))
          .orderBy(asc(profilingSession.sessionDate), asc(profilingSession.timeFrom));
        const [profiling] = await tx
          .select({
            revision: participantProfiling.revision,
            jobboerseChoice: participantProfiling.jobboerseChoice,
            baContact: participantProfiling.baContactConsent,
          })
          .from(participantProfiling)
          .where(eq(participantProfiling.participationId, participationId));
        const [assessmentRow] = await tx
          .select({ revision: participantProfilingAssessment.revision })
          .from(participantProfilingAssessment)
          .where(eq(participantProfilingAssessment.participationId, participationId));
        const [unemploymentRow] = await tx
          .select({
            present: participantResidenceSocialData.unemploymentPeriodPresent,
            revision: participantResidenceSocialData.unemploymentRevision,
          })
          .from(participantResidenceSocialData)
          .where(eq(participantResidenceSocialData.participationId, participationId));

        let sensitive: SensitiveValues = presentSensitiveValues(record.sensitive);
        let assessment: ProfilingAssessment | null = null;
        let unemployment: Tl407Source["unemployment"] = { from: null, until: null };
        if (decrypt) {
          sensitive = await readSensitive(tx, participationId, decrypt.context, record.sensitive);
          // Its read audits every field (data-protection.md, the profiling record): only once
          // something is stored.
          if (assessmentRow)
            assessment = await readAssessment(tx, participationId, decrypt.context);
          if (unemploymentRow?.present) {
            unemployment = await readUnemployment(tx, participationId, decrypt.context);
          }
        }
        const wave = found!.wave;
        const source: Tl407Source = {
          projectType: found!.projectType,
          today,
          transferCompany: organisation.transfergesellschaft,
          identity: record.identity,
          tgStart: effectiveTgStart(found!, wave),
          tgEnd: effectiveTgEnd(found!, wave),
          contact: {
            address: record.values.address,
            phone: record.values.phone,
            mobile: record.values.mobile,
            privateEmail: record.values.privateEmail,
          },
          profile: record.values,
          sensitive,
          unemployment,
          sessions,
          declarations: {
            jobboerseChoice: profiling?.jobboerseChoice ?? null,
            baContact: profiling?.baContact ?? null,
          },
          assessment,
        };
        return {
          source,
          sources: {
            profile: record.revision,
            profiling: profiling?.revision ?? 0,
            assessment: assessmentRow?.revision ?? 0,
            unemployment: unemploymentRow?.revision ?? 0,
          },
        };
      },
      { isolationLevel: "repeatable read" },
    );
  }

  /** The present sensitive answers, each read audited; the others stay null. */
  async function readSensitive(
    tx: Tx,
    participationId: string,
    context: SQL,
    present: Readonly<Record<keyof SensitiveValues, boolean>>,
  ): Promise<SensitiveValues> {
    const keys = sensitiveFields.filter((key) => present[key]);
    const values = Object.fromEntries(sensitiveFields.map((key) => [key, null])) as SensitiveValues;
    if (keys.length === 0) return values;
    const { rows } = await tx.execute<{ result: Partial<SensitiveValues> }>(
      sql`select read_sensitive_fields(p_participation_id => ${participationId}::uuid,
        p_context => ${context}, p_keys => ${textArray(keys)}::text[],
        p_key => ${deps.fieldKey.key}, p_key_id => ${deps.fieldKey.keyId}) as result`,
    );
    return { ...values, ...rows[0]!.result };
  }

  /** Section C and p. 7, each stored field's read audited. */
  async function readAssessment(tx: Tx, participationId: string, context: SQL) {
    const { rows } = await tx.execute<{ result: { values: ProfilingAssessment } }>(
      sql`select read_profiling_assessment(p_participation_id => ${participationId}::uuid,
        p_context => ${context}, p_key => ${deps.fieldKey.key},
        p_key_id => ${deps.fieldKey.keyId}) as result`,
    );
    return rows[0]!.result.values;
  }

  /** "arbeitslos seit / bis", its read audited. */
  async function readUnemployment(tx: Tx, participationId: string, context: SQL) {
    const { rows } = await tx.execute<{
      result: { period: { from: IsoDate; until: IsoDate | null } | null };
    }>(
      sql`select read_unemployment_period(p_participation_id => ${participationId}::uuid,
        p_context => ${context}, p_key => ${deps.fieldKey.key},
        p_key_id => ${deps.fieldKey.keyId}) as result`,
    );
    return rows[0]!.result.period ?? { from: null, until: null };
  }

  /**
   * The readiness projected for the viewer (data-protection.md, the readiness projection): the
   * profiler's full check of the decrypted input, or the PL's summary from presence alone.
   */
  async function readiness(
    participationId: string,
    viewer:
      | { kind: "profiler"; context: SQL }
      | { kind: "project_lead"; knows: (field: string) => boolean },
    today: IsoDate,
  ): Promise<Tl407Readiness> {
    const map = registry.inUse("tl407", today)?.fieldMap ?? null;
    if (viewer.kind === "project_lead") {
      const { source } = await read(participationId, today, null);
      return tl407ReadinessSummary(tl407Input(source), map, today, viewer.knows);
    }
    const { source } = await read(participationId, today, { context: viewer.context });
    const input = tl407Input(source);
    const measure = await registry.measure();
    const check = checkTl407(input, map, source.profile.educationHistory, today, measure);
    return tl407ProfilerReadiness(map, check);
  }

  /**
   * A generation (data-protection.md, generated forms): the version in use, the sources read and
   * checked, each warning confirmed by code, the packet rendered (the form and its Anlage),
   * encrypted and stored, then recorded with its provenance by `record_form_generation`; on its
   * refusal the stored object is deleted at once.
   */
  async function generate(
    participationId: string,
    today: IsoDate,
    context: SQL,
    confirmed: readonly Tl407WarningCode[],
  ): Promise<{ ok: true; generation: Tl407Generation } | { ok: false; refusal: Tl407Refusal }> {
    const files = deps.files;
    if (!files) return { ok: false, refusal: { kind: "unavailable", code: "storage_unavailable" } };
    const version = registry.inUse("tl407", today);
    if (!version) {
      const codes = [{ code: "form_version_unavailable", field: null }];
      return { ok: false, refusal: { kind: "domain", codes } };
    }
    const { source, sources } = await read(participationId, today, { context });
    const input = tl407Input(source);
    const check = checkTl407(
      input,
      version.fieldMap,
      source.profile.educationHistory,
      today,
      await registry.measure(),
    );
    if (check.errors.length > 0) {
      const codes = [...new Set(check.errors.map((error) => error.code))];
      return {
        ok: false,
        refusal: { kind: "domain", codes: codes.map((code) => ({ code, field: null })) },
      };
    }
    const open = unconfirmedWarnings(check, confirmed);
    if (open.length > 0) {
      const codes = open.map((code) => ({ code, field: "confirmWarnings" }));
      return { ok: false, refusal: { kind: "domain", codes } };
    }
    const layout = check.layout!;
    renderer ??= deps.renderer();
    let content: Uint8Array;
    try {
      const form = await renderer.fillForm({
        template: version.blank,
        fieldMap: version.fieldMap,
        fields: layout.fields,
      });
      content = layout.anlage
        ? await mergePdfs([
            form,
            await renderer.renderHtml(
              renderAnlage(registry.template(layout.anlage.template), layout.anlage),
            ),
          ])
        : form;
    } catch (error) {
      if (error instanceof PdfUnavailable) {
        return { ok: false, refusal: { kind: "unavailable", code: "pdf_unavailable" } };
      }
      throw error;
    }
    const documentId = randomUUID();
    const sealed = encryptDocument(
      documentKey,
      { documentId, participationId, type: "tl407_form" },
      content,
    );
    try {
      await files.storage.put(objectKey(documentId), sealed.object);
    } catch {
      return { ok: false, refusal: { kind: "unavailable", code: "storage_unavailable" } };
    }
    // Only the confirmations the check asked for are recorded and audited.
    const asked = new Set(check.warnings.map((warning) => warning.code));
    const confirmedWarnings = confirmed.filter((code) => asked.has(code));
    const declarations = {
      jobboerseChoice: source.declarations.jobboerseChoice,
      baContactConsent: source.declarations.baContact,
    };
    try {
      await db.execute(sql`select record_form_generation(
        p_context => ${context}, p_participation_id => ${participationId}::uuid,
        p_generation_id => ${randomUUID()}::uuid, p_document_id => ${documentId}::uuid,
        p_form_code => 'tl407'::form_code, p_form_version => ${version.manifest.version},
        p_sources => ${JSON.stringify(sources)}::jsonb,
        p_declarations => ${JSON.stringify(declarations)}::jsonb,
        p_confirmed_warnings => ${textArray(confirmedWarnings)}::text[],
        p_anlage => ${layout.anlage !== null}::boolean,
        p_size_bytes => ${content.length}::integer,
        p_content_sha256 => ${createHash("sha256").update(content).digest("hex")},
        p_key_id => ${sealed.keyId},
        p_wrapped_key => ${Buffer.from(sealed.wrappedKey)}::bytea) as result`);
    } catch (error) {
      await files.storage.delete(objectKey(documentId)).catch(() => undefined);
      return { ok: false, refusal: { kind: "function", error } };
    }
    return {
      ok: true,
      generation: {
        documentId,
        formVersion: version.manifest.version,
        anlage: layout.anlage !== null,
      },
    };
  }

  return { readiness, generate };
}

export type Tl407Service = ReturnType<typeof tl407Service>;
