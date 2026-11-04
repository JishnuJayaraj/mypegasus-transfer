import { resolveForParticipation } from "@transfer/config";
import { agenturSubmission, and, desc, eq, inArray, sql, type Database } from "@transfer/db";
import {
  tl407SubmissionSettings,
  type AgenturRejectionReason,
  type IsoDate,
  type Tl407Attempt,
  type Tl407SubmissionSettings,
} from "@transfer/domain";
import type { FormRegistry } from "../forms/registry";
import { projectSnapshot, type Release } from "../projects/template-pins";
import { utc } from "../sql";

// The TL 407's submission as the API reads it (process-and-lifecycle.md, TL 407 submission;
// regional-variation.md, blockers; D26, D27): a placement Agentur's submission settings resolved
// from the project's layers, and each participation's attempts. The database function checks the
// rules again under the participation's lock; a writer resolves the settings after taking the
// project's exclusive lock (`lock_project_setup`), which every configuration write and the
// placement Agentur's change take, so the values it passes are the ones in force at its commit.

type Db = Pick<Database, "select" | "selectDistinctOn" | "execute">;

/** A placement Agentur's submission settings now and the TL 407 versions it rejects as outdated. */
export type AgenturSubmissionSettings = {
  /** Null while any of the four settings is unset (the blocker, Q92). */
  settings: Tl407SubmissionSettings | null;
  /** The TL 407 versions not in use today, where the Agentur rejects outdated forms (Q188). */
  outdatedVersions: string[];
  /** The resolved `leadTimeDays` alone, for the deadline (D27); null while unset. */
  leadTimeDays: number | null;
};

/** Resolves the settings of each key in `agenturKeys` once, from one project snapshot. */
export async function submissionSettingsOf(
  db: Db,
  release: Release,
  registry: FormRegistry,
  projectId: string,
  agenturKeys: Iterable<string>,
  today: IsoDate,
): Promise<Map<string, AgenturSubmissionSettings>> {
  const keys = [...new Set(agenturKeys)];
  const result = new Map<string, AgenturSubmissionSettings>();
  if (keys.length === 0) return result;
  const snapshot = (await projectSnapshot(db, release, projectId))!;
  for (const agenturKey of keys) {
    const { config } = resolveForParticipation({
      ...snapshot.input,
      placementAgenturKey: agenturKey,
    });
    const settings = tl407SubmissionSettings(config.settings);
    result.set(agenturKey, {
      settings,
      outdatedVersions: settings?.rejectsOutdatedFormVersions
        ? registry.versions("tl407").filter((v) => !registry.versionInUse("tl407", v, today))
        : [],
      leadTimeDays: config.settings.agentur_submission?.leadTimeDays ?? null,
    });
  }
  return result;
}

/** One TL 407 attempt as recorded, with the tab's fields. */
export type AttemptRow = Tl407Attempt & {
  id: string;
  participationId: string;
  documentId: string;
  formVersion: string;
  agenturKey: string;
  rejectionReason: AgenturRejectionReason | null;
  recordedAt: string;
};

/** Each participation's TL 407 attempts, newest first (by sent date, then recording). */
export async function attemptsOf(
  db: Db,
  participationIds: readonly string[],
): Promise<Map<string, AttemptRow[]>> {
  const byParticipation = new Map<string, AttemptRow[]>(participationIds.map((id) => [id, []]));
  if (participationIds.length === 0) return byParticipation;
  const rows = await db
    .select({
      id: agenturSubmission.id,
      participationId: agenturSubmission.participationId,
      documentId: agenturSubmission.documentId,
      formVersion: agenturSubmission.formVersion,
      agenturKey: agenturSubmission.agenturKey,
      channel: agenturSubmission.channel,
      submittedOn: agenturSubmission.submittedOn,
      originalRequired: sql<boolean>`coalesce(${agenturSubmission.originalRequired}, false)`,
      originalSentOn: agenturSubmission.originalSentOn,
      rejectedOn: agenturSubmission.rejectedOn,
      rejectionReason: agenturSubmission.rejectionReason,
      recordedAt: utc(agenturSubmission.recordedAt),
    })
    .from(agenturSubmission)
    .where(
      and(
        inArray(agenturSubmission.participationId, [...participationIds]),
        eq(agenturSubmission.formCode, "tl407"),
      ),
    )
    .orderBy(
      desc(agenturSubmission.recordedAt),
      desc(agenturSubmission.submittedOn),
      desc(agenturSubmission.id),
    );
  for (const row of rows) byParticipation.get(row.participationId)!.push(row);
  return byParticipation;
}
