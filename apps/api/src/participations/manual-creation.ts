import type { Clock } from "@transfer/adapters";
import { sql, type Database } from "@transfer/db";
import {
  checkManualCreation,
  type ManualIssue,
  type ManualParticipationInput,
} from "@transfer/domain";
import { functionRefusal } from "../database-errors";
import {
  checkWave,
  ImportRefusal,
  loadState,
  writeParticipantData,
  type ImportActor,
} from "../imports/analysis";
import type { Release } from "../projects/template-pins";
import { auditContext, callFunction } from "../sql";
import { createParticipationIn } from "./status-service";

/** A refusal of a manual creation (R32): codes at their fields, and the existing participation. */
export class ManualCreationRefusal extends Error {
  override readonly name = "ManualCreationRefusal";

  constructor(
    readonly issues: readonly ManualIssue[],
    /** The participation that already has the Personalnummer (`personnel_number_taken`). */
    readonly participationId?: string,
  ) {
    super("manual_creation_refused");
  }
}

/**
 * Creates one participation from the PL's form (Slice 2 plan, "Planned in PR 2h", R32): under the
 * exclusive project lock like an import confirm, so a concurrent import or creation of the same
 * Personalnummer is seen; the import's state and rules decide (`checkManualCreation`); then the
 * creation edge, the person data, the confirmed warnings and `participation_created_manually`
 * with the base-defaults version (R26), in one transaction. Returns the new participation's id.
 */
export async function createManually(
  deps: { db: Database; release: Release; clock: Clock },
  actor: ImportActor,
  projectId: string,
  input: ManualParticipationInput,
): Promise<string> {
  const { db, release, clock } = deps;
  const context = auditContext(actor.staffUserId, actor.requestId);
  return db
    .transaction(async (tx) => {
      await tx.execute(sql`select lock_project_setup(${projectId}::uuid)`);
      const state = await loadState(tx, release, projectId);
      if (!state) throw new ImportRefusal("not_found");
      await checkWave(tx, state, projectId, input.waveId);
      const checked = checkManualCreation({
        values: input.values,
        existing: state.existing,
        relaxedRuleIds: state.relaxedRuleIds,
        today: clock.today(),
        confirmWarnings: input.confirmWarnings,
        createDespiteDuplicate: input.createDespiteDuplicate,
      });
      if (!checked.ok) throw new ManualCreationRefusal(checked.issues, checked.participationId);
      const { participationId } = await createParticipationIn(
        tx,
        actor.subject,
        { projectId, ...(input.waveId && { entryWaveId: input.waveId }) },
        { requestId: actor.requestId ?? undefined },
      );
      await writeParticipantData(tx, context, participationId, checked.values);
      for (const code of checked.confirmedWarnings) {
        await callFunction(
          tx,
          sql`record_audit_event(p_project_id => ${projectId}::uuid,
            p_participation_id => ${participationId}::uuid,
            p_event_type => 'warning_confirmed'::audit_event_type, p_context => ${context},
            p_reason_code => ${code})`,
        );
      }
      await callFunction(
        tx,
        sql`record_audit_event(p_project_id => ${projectId}::uuid,
          p_participation_id => ${participationId}::uuid,
          p_event_type => 'participation_created_manually'::audit_event_type,
          p_context => ${context},
          p_details => ${JSON.stringify({ baseDefaultsVersion: release.baseDefaults.version })}::jsonb)`,
      );
      return participationId;
    })
    .catch((error: unknown) => {
      if (functionRefusal(error) === "project_not_found") throw new ImportRefusal("not_found");
      throw error;
    });
}
