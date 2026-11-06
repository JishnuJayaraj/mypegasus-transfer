import { type PdfRenderer } from "@transfer/adapters";
import { configDirs, loadOrganisation } from "@transfer/config/load";
import {
  and,
  desc,
  document,
  eq,
  formGeneration,
  participation,
  project,
  projectEntryWave,
  sql,
  transactionWithClient,
  type Database,
} from "@transfer/db";
import {
  dsvDeadline,
  dsvGeneratedFact,
  dsvGenerationBlockers,
  dsvGenerationProblem,
  dsvSourceCanonical,
  dsvTemplateRef,
  dsvTemplateUsable,
  effectiveTgEnd,
  effectiveTgStart,
  renderDsv,
  validateDsvSource,
  type DsvDeadlineChoice,
  type DsvGenerationResult,
  type DsvSource,
  type DsvStatus,
  type DsvValidation,
  type IsoDate,
  type MainStatus,
  type ProjectStatus,
  type ProjectType,
} from "@transfer/domain";
import type { SQL } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { documentEncryptionKey, encryptDocument } from "../document-encryption";
import { objectKey, type DocumentFiles } from "../documents/files";
import { loadSelfService } from "../participations/self-service";
import type { Release } from "../projects/template-pins";
import { formPersonOf, organisationFingerprint, sha256, type FormPerson } from "./person";
import type { FormRegistry } from "./registry";

// The DSV of one participation (process-and-lifecycle.md, the DSV: generation; data-protection.md,
// generated forms; ADR-0009, the DSV template; Slice 7 D1–D3): its printed sources read in one
// snapshot with their source token, the generations with their currency, and the generation: the
// deadline validated, the template rendered with its variable parts, stored encrypted and recorded
// with the token the database compares again under the lock. Nothing here logs or answers a value
// the paper prints. The DSV is signed on paper (§623 BGB): there is no signature here.

export type DsvDeps = {
  db: Database;
  release: Release;
  registry: FormRegistry;
  /** Built once, on the first generation. */
  renderer: () => PdfRenderer;
  files: DocumentFiles | undefined;
  documentKeyRoot: string;
  configDir: string | undefined;
  /** `NODE_ENV=production`: only a template approved for live use is generated (D1). */
  production: boolean;
};

/** Why a generation was refused. */
export type DsvRefusal =
  | { kind: "domain"; codes: { code: string; field: string | null }[] }
  /** The printed values moved since the view the user saw (`409 source_changed`). */
  | { kind: "stale" }
  | { kind: "unavailable"; code: "storage_unavailable" | "pdf_unavailable" }
  | { kind: "function"; error: unknown };

/** One snapshot of what the DSV prints and decides on. */
export type DsvRead = {
  projectId: string;
  projectType: ProjectType;
  projectStatus: ProjectStatus;
  status: MainStatus;
  dsvStatus: DsvStatus;
  wave: {
    id: string;
    signingDeadline: IsoDate | null;
    latestEntryDate: IsoDate | null;
  } | null;
  templateVersion: string | null;
  /** The template's approval, null without a pin or for a version the registry lacks. */
  templateApproved: boolean | null;
  source: DsvSource;
  person: FormPerson;
  profileRevision: number;
  sourceToken: string;
  validation: DsvValidation;
  generations: {
    documentId: string;
    generatedAt: string;
    generatedOn: IsoDate;
    templateVersion: string;
    offerDeadline: IsoDate;
    deadlineKind: "wave" | "explicit";
    checklist: DsvValidation["checklist"];
    sourceToken: string;
    purged: boolean;
  }[];
};

/** A UTC instant as ISO 8601 text, microseconds kept. */
const utc = (column: unknown) =>
  sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export function dsvService(deps: DsvDeps) {
  const { db, release, registry } = deps;
  const company = loadOrganisation(configDirs(deps.configDir).organisation).transfergesellschaft;
  const organisationSha256 = organisationFingerprint(company);
  const documentKey = documentEncryptionKey(deps.documentKeyRoot);
  let renderer: PdfRenderer | undefined;

  const approval = (version: string | null) =>
    version === null
      ? null
      : (registry.ownTemplateVersions("dsv").find((entry) => entry.version === version)
          ?.approvedForLive ?? null);

  /** The DSV's sources and generations in one REPEATABLE READ snapshot. */
  function read(participationId: string): Promise<DsvRead> {
    return db.transaction(
      async (tx) => {
        const [found] = await tx
          .select({
            projectId: participation.projectId,
            status: participation.status,
            dsvStatus: participation.dsvStatus,
            tgStart: participation.tgStart,
            tgEnd: participation.tgEnd,
            offerDeadline: participation.offerDeadline,
            projectType: project.type,
            projectStatus: project.status,
            customerName: project.customerName,
            templateVersion: project.dsvTemplateVersion,
            wave: projectEntryWave,
          })
          .from(participation)
          .innerJoin(project, eq(project.id, participation.projectId))
          .leftJoin(projectEntryWave, eq(projectEntryWave.id, participation.entryWaveId))
          .where(eq(participation.id, participationId));
        const record = (await loadSelfService(tx, release, participationId))!;
        const tgStart = effectiveTgStart(found!, found!.wave);
        const tgEnd = effectiveTgEnd(found!, found!.wave);
        const person = formPersonOf(record, tgStart, tgEnd);
        const { rows } = await tx.execute<{ country: string | null }>(
          sql`select address_country as country from participant_details
            where participation_id = ${participationId}::uuid and address_street is not null`,
        );
        const source: DsvSource = {
          templateVersion: found!.templateVersion as DsvSource["templateVersion"],
          firstName: person.firstName,
          lastName: person.lastName,
          birthDate: person.birthDate,
          street: person.street,
          postalCode: person.postalCode,
          city: person.city,
          country: rows[0]?.country ?? null,
          tgStart,
          tgEnd,
          entryWaveId: found!.wave?.id ?? null,
          customerName: found!.customerName,
          organisationSha256,
        };
        const generations = await tx
          .select({
            documentId: formGeneration.documentId,
            generatedAt: utc(formGeneration.generatedAt),
            generatedOn: sql<string>`(${formGeneration.generatedAt} at time zone 'Europe/Berlin')::date::text`,
            templateVersion: formGeneration.formVersion,
            offerDeadline: formGeneration.offerDeadline,
            deadlineKind: formGeneration.deadlineKind,
            checklist: formGeneration.checklist,
            sourceToken: formGeneration.sourceToken,
            purged: sql<boolean>`${document.deletedAt} is not null`,
          })
          .from(formGeneration)
          .innerJoin(document, eq(document.id, formGeneration.documentId))
          .where(
            and(
              eq(formGeneration.participationId, participationId),
              sql`${formGeneration.formCode}::text = 'dsv'`,
            ),
          )
          .orderBy(desc(formGeneration.generatedAt), desc(formGeneration.id));
        return {
          projectId: found!.projectId,
          projectType: found!.projectType,
          projectStatus: found!.projectStatus,
          status: found!.status,
          dsvStatus: found!.dsvStatus,
          wave: found!.wave && {
            id: found!.wave.id,
            signingDeadline: found!.wave.signingDeadline,
            latestEntryDate: found!.wave.latestEntryDate,
          },
          templateVersion: found!.templateVersion,
          templateApproved: approval(found!.templateVersion),
          source,
          person,
          profileRevision: record.revision,
          sourceToken: sha256(dsvSourceCanonical(source)),
          validation: validateDsvSource(source, company),
          generations: generations.map((generation) => ({
            ...generation,
            offerDeadline: generation.offerDeadline!,
            deadlineKind: generation.deadlineKind!,
            checklist: (generation.checklist ?? []) as DsvValidation["checklist"],
          })),
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  /** Why no DSV can be generated now: the state's blockers and the template's approval. */
  function blockers(read: DsvRead) {
    const found = dsvGenerationBlockers({
      projectType: read.projectType,
      projectStatus: read.projectStatus,
      status: read.status,
      dsvStatus: read.dsvStatus,
      entryWaveId: read.wave?.id ?? null,
      tgStart: read.source.tgStart,
      tgEnd: read.source.tgEnd,
      templateVersion: read.source.templateVersion,
    });
    const unapproved =
      read.templateApproved === null
        ? read.templateVersion !== null
        : !dsvTemplateUsable({ approvedForLive: read.templateApproved }, deps.production);
    return unapproved && !found.includes("not_ta_tg")
      ? [...found, "dsv_template_not_approved" as const]
      : found;
  }

  /** Whether a generation can still be handed out (D3). */
  const stale = (read: DsvRead, generation: DsvRead["generations"][number], today: IsoDate) =>
    dsvGenerationProblem(
      generation,
      { sourceToken: read.sourceToken, waveSigningDeadline: read.wave?.signingDeadline ?? null },
      today,
    ) !== null;

  /** `dsvGenerated` (D3): the latest current generation. */
  const generatedFact = (read: DsvRead, today: IsoDate) =>
    dsvGeneratedFact(
      read.generations.map((generation) => ({
        generatedOn: generation.generatedOn,
        generatedAt: new Date(generation.generatedAt),
        current: !stale(read, generation, today),
      })),
    );

  /**
   * Generates the DSV: the state and deadline checked on the snapshot (the function checks both
   * again under the lock), the expected token compared, the template rendered, the file stored
   * encrypted, then recorded; a refused record deletes the stored object.
   */
  async function generate(
    participationId: string,
    input: { deadline: DsvDeadlineChoice; expectedSourceToken: string },
    today: IsoDate,
    context: SQL,
  ): Promise<{ ok: true; result: DsvGenerationResult } | { ok: false; refusal: DsvRefusal }> {
    let current: DsvRead;
    try {
      current = await read(participationId);
    } catch (error) {
      return { ok: false, refusal: { kind: "function", error } };
    }
    const blocked = blockers(current);
    if (blocked.length > 0) {
      return {
        ok: false,
        refusal: { kind: "domain", codes: blocked.map((code) => ({ code, field: null })) },
      };
    }
    const deadline = dsvDeadline(input.deadline, {
      today,
      dsvStatus: current.dsvStatus,
      waveSigningDeadline: current.wave?.signingDeadline ?? null,
      latestEntryDate: current.wave?.latestEntryDate ?? null,
      tgStart: current.source.tgStart,
    });
    if (!deadline.ok) {
      if (deadline.problem === "source_changed") return { ok: false, refusal: { kind: "stale" } };
      return {
        ok: false,
        refusal: { kind: "domain", codes: [{ code: deadline.problem, field: "deadline" }] },
      };
    }
    if (input.expectedSourceToken !== current.sourceToken) {
      return { ok: false, refusal: { kind: "stale" } };
    }
    if (current.validation.errors.length > 0) {
      return {
        ok: false,
        refusal: {
          kind: "domain",
          codes: [...new Set(current.validation.errors.map((error) => error.code))].map((code) => ({
            code,
            field: null,
          })),
        },
      };
    }
    const files = deps.files;
    if (!files) return { ok: false, refusal: { kind: "unavailable", code: "storage_unavailable" } };
    const version = current.templateVersion!;
    let content: Uint8Array;
    try {
      renderer ??= deps.renderer();
      content = await renderer.renderHtml(
        renderDsv(registry.template(dsvTemplateRef(version as never)), {
          ...current.source,
          company,
          tgStart: current.source.tgStart!,
          tgEnd: current.source.tgEnd!,
          offerDeadline: deadline.deadline,
        }),
      );
    } catch {
      return { ok: false, refusal: { kind: "unavailable", code: "pdf_unavailable" } };
    }
    const documentId = randomUUID();
    const seal = encryptDocument(
      documentKey,
      { documentId, participationId, type: "dsv_form" },
      content,
    );
    try {
      await files.storage.put(objectKey(documentId), seal.object);
    } catch {
      return { ok: false, refusal: { kind: "unavailable", code: "storage_unavailable" } };
    }
    const checklist = current.validation.checklist;
    try {
      await transactionWithClient(db, (tx) =>
        tx.execute(sql`select record_form_generation(
          p_context => ${context}, p_participation_id => ${participationId}::uuid,
          p_generation_id => ${randomUUID()}::uuid, p_document_id => ${documentId}::uuid,
          p_form_code => 'dsv'::form_code, p_form_version => ${version},
          p_sources => ${JSON.stringify({ profile: current.profileRevision, profiling: 0, assessment: 0, unemployment: 0 })}::jsonb,
          p_person => ${JSON.stringify(current.person)}::jsonb, p_source_token => ${current.sourceToken},
          p_organisation_sha256 => ${organisationSha256}, p_declarations => null::jsonb,
          p_confirmed_warnings => '{}'::text[], p_anlage => false,
          p_size_bytes => ${content.length}::integer,
          p_content_sha256 => ${createHash("sha256").update(content).digest("hex")},
          p_key_id => ${seal.keyId}, p_wrapped_key => ${Buffer.from(seal.wrappedKey)}::bytea,
          p_checklist => ${JSON.stringify(checklist)}::jsonb, p_employer_sha256 => null::text,
          p_offer_deadline => ${deadline.deadline}::date,
          p_deadline_kind => ${input.deadline.kind}::dsv_deadline_kind) as result`),
      );
    } catch (error) {
      await files.storage.delete(objectKey(documentId)).catch(() => undefined);
      return { ok: false, refusal: { kind: "function", error } };
    }
    return {
      ok: true,
      result: {
        documentId,
        templateVersion: version as DsvGenerationResult["templateVersion"],
        offerDeadline: deadline.deadline,
        checklist,
      },
    };
  }

  /** Whether the project's pin is fixed: a DSV of the project was generated. */
  async function pinFixed(projectId: string): Promise<boolean> {
    const { rows } = await db.execute<{ fixed: boolean }>(
      sql`select exists (select from form_generation where project_id = ${projectId}::uuid
        and form_code::text = 'dsv') as fixed`,
    );
    return rows[0]!.fixed;
  }

  return {
    read,
    blockers,
    stale,
    generatedFact,
    generate,
    pinFixed,
  };
}

export type DsvService = ReturnType<typeof dsvService>;
