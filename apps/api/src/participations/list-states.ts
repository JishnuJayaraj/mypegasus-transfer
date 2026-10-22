import type { Clock } from "@transfer/adapters";
import {
  activationCode,
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  participantAccount,
  participantAssignment,
  privacyNoticeDelivery,
  staffUser,
  type Database,
} from "@transfer/db";
import {
  activationStatus,
  mayPerformOperation,
  privacyNoticeState,
  type AssignedConsultant,
  type Subject,
} from "@transfer/domain";
import { projectTarget } from "../access";
import { utc } from "../sql";

// What a participant list row shows beside its statuses: the consultants, the activation and
// Article 14 notice states and the activation operations (data-protection.md, access matrix).
// Shared by the paged list and the work list.

type Db = Pick<Database, "select">;

/** The open assignments of `participationIds` with the consultants' names, oldest first (Q62). */
export async function consultantsOf(db: Db, participationIds: readonly string[]) {
  if (participationIds.length === 0) return new Map<string, AssignedConsultant[]>();
  const rows = await db
    .select({
      participationId: participantAssignment.participationId,
      staffUserId: participantAssignment.staffUserId,
      displayName: staffUser.displayName,
      assignedAt: utc(participantAssignment.assignedAt),
    })
    .from(participantAssignment)
    .innerJoin(staffUser, eq(staffUser.id, participantAssignment.staffUserId))
    .where(
      and(
        inArray(participantAssignment.participationId, [...participationIds]),
        isNull(participantAssignment.endedAt),
      ),
    )
    .orderBy(asc(participantAssignment.assignedAt), asc(participantAssignment.id));
  const byParticipation = new Map<string, AssignedConsultant[]>();
  for (const { participationId, ...consultant } of rows) {
    byParticipation.set(participationId, [
      ...(byParticipation.get(participationId) ?? []),
      consultant,
    ]);
  }
  return byParticipation;
}

export function activationCapabilities(
  subject: Subject,
  projectId: string,
  regionId: string | null,
  participationId: string,
) {
  const target = projectTarget(projectId, regionId, participationId);
  const may = (
    kind:
      | "issueActivationCode"
      | "recordHandover"
      | "revokeActivationCode"
      | "providePrivacyNotice",
  ) => mayPerformOperation(subject, { kind }, target).ok;
  return {
    issueActivationCode: may("issueActivationCode"),
    recordHandover: may("recordHandover"),
    revokeActivationCode: may("revokeActivationCode"),
    providePrivacyNotice: may("providePrivacyNotice"),
  };
}

export type ListStates = {
  activationStatus: ReturnType<typeof activationStatus>;
  privacyNoticeState: ReturnType<typeof privacyNoticeState>;
};

/** The activation and notice states of `ids`; `receivedOn` is each one's Berlin creation date. */
export async function listStatesOf(
  db: Db,
  clock: Clock,
  ids: readonly string[],
  receivedOn: ReadonlyMap<string, string>,
): Promise<Map<string, ListStates>> {
  if (ids.length === 0) return new Map();
  const [codes, deliveries, accounts] = await Promise.all([
    db
      .select({
        participationId: activationCode.participationId,
        purpose: activationCode.purpose,
        channel: activationCode.channel,
        issuedAt: utc(activationCode.issuedAt),
        expiresAt: utc(activationCode.expiresAt),
        deliveryStatus: activationCode.deliveryStatus,
        handedOverAt: utc(activationCode.handedOverAt),
        lockedAt: utc(activationCode.lockedAt),
        revokedAt: utc(activationCode.revokedAt),
        usedAt: utc(activationCode.usedAt),
      })
      .from(activationCode)
      .where(inArray(activationCode.participationId, [...ids]))
      .orderBy(desc(activationCode.issuedAt), desc(activationCode.id)),
    db
      .select({
        participationId: privacyNoticeDelivery.participationId,
        providedAt: utc(privacyNoticeDelivery.providedAt),
      })
      .from(privacyNoticeDelivery)
      .where(inArray(privacyNoticeDelivery.participationId, [...ids])),
    db
      .select({ participationId: participantAccount.participationId })
      .from(participantAccount)
      .where(inArray(participantAccount.participationId, [...ids])),
  ]);
  const activated = new Set(accounts.map((account) => account.participationId));
  const latest = new Map<string, (typeof codes)[number]>();
  for (const code of codes)
    if (!latest.has(code.participationId)) latest.set(code.participationId, code);
  const provided = new Map<string, { providedAt: string }[]>();
  for (const delivery of deliveries) {
    provided.set(delivery.participationId, [
      ...(provided.get(delivery.participationId) ?? []),
      delivery,
    ]);
  }
  const now = clock.now().toISOString();
  const result = new Map<string, ListStates>();
  for (const id of ids) {
    const code = latest.get(id);
    result.set(id, {
      activationStatus: activationStatus(
        activated.has(id),
        code
          ? {
              purpose: code.purpose,
              channel: code.channel,
              issuedAt: code.issuedAt,
              expiresAt: code.expiresAt,
              deliveryStatus: code.deliveryStatus,
              handedOverAt: code.handedOverAt,
              lockedAt: code.lockedAt,
              revokedAt: code.revokedAt,
              usedAt: code.usedAt,
            }
          : null,
        now,
      ),
      privacyNoticeState: privacyNoticeState(
        receivedOn.get(id)!,
        provided.get(id) ?? [],
        clock.today(),
      ),
    });
  }
  return result;
}
