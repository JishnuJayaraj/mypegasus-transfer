import { types, type Client, type CustomTypesConfig } from "pg";
import { seedProjectIds, seedStaffUserIds } from "../seed";

// Test helpers for the status functions (integration tests only). Production code calls them
// only through the API's status service (plan 5.4).

/** Legal dates stay ISO strings, as in the app (`date` mode "string"). */
export const textDates: CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: "text" | "binary") =>
    oid === types.builtins.DATE
      ? (value: string) => value
      : types.getTypeParser(oid, format)) as CustomTypesConfig["getTypeParser"],
};

export type AuditContext = {
  actorType: "user" | "participant" | "system" | null;
  staffUserId?: string | null;
  participationId?: string | null;
  systemJob?: string | null;
  onBehalfOf?: string | null;
  requestId?: string | null;
  jobId?: string | null;
};

const quote = (value: string) => `"${value.replace(/["\\]/g, (c) => `\\${c}`)}"`;

/** The `audit_context` composite as a text literal. */
export function auditContext(c: AuditContext): string {
  const fields = [c.actorType, c.staffUserId, c.participationId, c.systemJob, c.onBehalfOf];
  return `(${[...fields, c.requestId, c.jobId].map((f) => (f == null ? "" : quote(f))).join(",")})`;
}

export const pl = auditContext({ actorType: "user", staffUserId: seedStaffUserIds.projectLead });
/** A second staff user, for four-eyes decisions (the role is the service's check, 1g-2). */
export const reviewer = auditContext({ actorType: "user", staffUserId: seedStaffUserIds.admin });
export const nightly = auditContext({
  actorType: "system",
  systemJob: "lifecycle.evaluate-project",
});

const snake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Calls a function with named arguments (`p_<snake_case name>`); returns its result. */
export async function call<T = string>(
  client: Pick<Client, "query">,
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  const names = Object.keys(args);
  const list = names.map((name, i) => `p_${snake(name)} => $${i + 1}`).join(", ");
  const values = names.map((name) => {
    const value = args[name];
    return name === "details" ? JSON.stringify(value) : value;
  });
  const { rows } = await client.query(`select ${fn}(${list}) as result`, values);
  return rows[0].result as T;
}

export type Change = {
  field: "status" | "profiling_status" | "dsv_status";
  from: string;
  to: string;
  context?: string;
  entryKind?: string;
  endReason?: string;
  secondaryReasons?: string[];
  offerDeadline?: string;
  effectiveDate?: string;
  scheduledAt?: string;
};

export async function changeStatus(client: Pick<Client, "query">, id: string, change: Change) {
  const { from, context = pl, ...rest } = change;
  if (change.field === "dsv_status" && change.to === "dsv_offered" && !change.effectiveDate) {
    const { rows } = await client.query(
      `select p.status_version, coalesce(p.tg_start, w.default_tg_start)::text as start,
      coalesce(p.tg_end, w.default_tg_end)::text as finish, w.signing_deadline::text as deadline
      from participation p left join project_entry_wave w on w.id = p.entry_wave_id where p.id = $1`,
      [id],
    );
    const paper = rows[0];
    return call(client, "offer_dsv", {
      context,
      participationId: id,
      generationId: null,
      external: JSON.stringify({
        deadline: change.offerDeadline ?? (from === "not_offered" ? paper.deadline : null),
        printedTgStart: paper.start,
        printedTgEnd: paper.finish,
      }),
      expectedStatusVersion: paper.status_version,
    });
  }
  return call(client, "change_participation_status", {
    id,
    expectedFrom: from,
    context,
    ...rest,
  });
}

/** Moves a new participation of `projectId` to `informed`, optionally with a wave. */
export async function informedParticipation(
  client: Pick<Client, "query">,
  options: { projectId?: string; entryWaveId?: string } = {},
): Promise<string> {
  const id = await call(client, "create_participation", {
    projectId: options.projectId ?? seedProjectIds.werkNord,
    context: pl,
    ...(options.entryWaveId && { entryWaveId: options.entryWaveId }),
  });
  await changeStatus(client, id, { field: "status", from: "imported", to: "contacted" });
  await changeStatus(client, id, { field: "status", from: "contacted", to: "informed" });
  return id;
}

/** Inserts a test wave as the owner (waves are created with project setup, Slice 2). */
export async function createWave(
  owner: Pick<Client, "query">,
  projectId: string = seedProjectIds.werkNord,
  code = "T1",
): Promise<string> {
  const { rows } = await owner.query(
    `insert into project_entry_wave (project_id, code, name, signing_deadline, default_tg_start, default_tg_end, latest_entry_date)
     values ($1, $2, $2, '2027-02-15', '2027-03-01', '2028-02-29', '2027-03-15') returning id`,
    [projectId, code],
  );
  return rows[0].id;
}

/**
 * A BA confirmation evidence record of the participation (data-protection.md, exception
 * evidence), recorded by the PL; its id. Different references give different fingerprints.
 */
export function baEvidence(
  client: Pick<Client, "query">,
  participationId: string,
  reference = "az-1",
  context = pl,
): Promise<string> {
  return call(client, "create_exception_evidence_record", {
    context,
    participationId,
    kind: "ba_confirmation",
    documentIds: null,
    agenturKey: "beispielstadt-nord",
    reference,
    confirmedOn: "2026-01-15",
  });
}

const allSignatures = (day: string) => ({
  participant: day,
  customer: day,
  transfergesellschaft: day,
});

/** An external-paper offer from the participation's wave, as the PL records it; the offer's id. */
export async function externalDsvOffer(client: Pick<Client, "query">, participationId: string) {
  const {
    rows: [r],
  } = await client.query(
    `select p.status_version, w.signing_deadline::text as deadline, w.default_tg_start::text as start,
       w.default_tg_end::text as finish
     from participation p join project_entry_wave w on w.id = p.entry_wave_id where p.id = $1`,
    [participationId],
  );
  return call<string>(client, "offer_dsv", {
    context: pl,
    participationId,
    generationId: null,
    external: JSON.stringify({
      deadline: r.deadline,
      printedTgStart: r.start,
      printedTgEnd: r.finish,
    }),
    expectedStatusVersion: r.status_version,
  });
}

/**
 * A scan of the participation's current offer (open, or signed for the countersigned original)
 * uploaded by the PL, received by them today, and accepted with the given actual dates; its id.
 */
export async function acceptDsvScan(
  client: Pick<Client, "query">,
  participationId: string,
  signatures: { participant?: string; customer?: string; transfergesellschaft?: string },
) {
  const {
    rows: [row],
  } = await client.query(
    `select o.id, (now() at time zone 'Europe/Berlin')::date::text as today, gen_random_uuid() as scan from dsv_offer o
     where participation_id = $1 and (ended_as is null or ended_as = 'signed')
     order by offered_at desc limit 1`,
    [participationId],
  );
  await call(client, "add_document", {
    context: pl,
    participationId,
    id: row.scan,
    type: "dsv_signed_scan",
    mediaType: "application/pdf",
    sizeBytes: 100,
    contentSha256: "a".repeat(64),
    fileName: null,
    keyId: "b".repeat(16),
    wrappedKey: Buffer.alloc(60),
    dsv: JSON.stringify({
      offerId: row.id,
      receivedBy: seedStaffUserIds.projectLead,
      receivedOn: row.today,
      signatures,
    }),
  });
  await call(client, "review_document", {
    context: pl,
    documentId: row.scan,
    decision: "accepted",
    reason: null,
    dsv: JSON.stringify({ signatures, termsConfirmed: true }),
  });
  return row.scan as string;
}

/**
 * Synthetic accepted paper for tests whose subject is a later lifecycle transition: one scan of the
 * open offer showing all three signatures today, so it supports the signature and the TG entry.
 */
export async function acceptedDsvScan(client: Pick<Client, "query">, participationId: string) {
  const {
    rows: [{ today }],
  } = await client.query("select (now() at time zone 'Europe/Berlin')::date::text as today");
  return acceptDsvScan(client, participationId, allSignatures(today));
}

/**
 * Moves a participation's synthetic DSV scans to a past day, as owner (tests with a clock in the
 * past: the database stamps real time, and the entry rests on facts recorded before the run).
 */
export async function backdateDsvScans(
  client: Pick<Client, "query">,
  participationId: string,
  day: string,
) {
  const instant = `(${"$2"}::date + time '09:00') at time zone 'Europe/Berlin'`;
  await client.query(
    `update dsv_scan_signature set signed_on = $2::date, recorded_at = ${instant}
     where participation_id = $1`,
    [participationId, day],
  );
  await client.query(
    `update document set reviewed_at = ${instant}, dsv_received_on = $2::date
     where participation_id = $1 and type = 'dsv_signed_scan'`,
    [participationId, day],
  );
}
