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

export function changeStatus(client: Pick<Client, "query">, id: string, change: Change) {
  const { from, context = pl, ...rest } = change;
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

/** Inserts a wave as the owner (waves are created with project setup, Slice 2). */
export async function createWave(
  owner: Pick<Client, "query">,
  projectId: string = seedProjectIds.werkNord,
  code = "W2",
): Promise<string> {
  const { rows } = await owner.query(
    `insert into project_entry_wave (project_id, code, name, signing_deadline, default_tg_start, default_tg_end, latest_entry_date)
     values ($1, $2, $2, '2027-02-15', '2027-03-01', '2028-02-29', '2027-03-15') returning id`,
    [projectId, code],
  );
  return rows[0].id;
}
