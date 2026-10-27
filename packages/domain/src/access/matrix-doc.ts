import { auditProjectionRows, historyStreams, roleFieldKnowledge } from "../audit/history";
import { DocumentType } from "../documents/catalog";
import { ProjectRole } from "../enums";
import {
  AuditStream,
  decideAccess,
  type AccessAction,
  type AccessPhase,
  type Decision,
  type Resource,
} from "./decide";
import {
  mayAddDocument,
  mayDeleteDocument,
  mayReviewDocument,
  type DocumentOperation,
  type DocumentPermission,
} from "./document-operations";
import {
  accessModes,
  accessProfiles,
  fieldCategories,
  sample,
  sampleAggregate,
  sampleAudit,
  sampleDocument,
  sampleField,
} from "./profiles";

type Mode = keyof typeof accessModes;
const modes = Object.keys(accessModes) as Mode[];
const phases: AccessPhase[] = ["active", "evidence_set"];

const code = (value: string) => `\`${value}\``;
const table = (head: string[], rows: string[][]) =>
  [head, head.map(() => "---"), ...rows].map((r) => `| ${r.join(" | ")} |`).join("\n");

/** A decision as a matrix cell shows it. */
export function cellText(d: Decision): string {
  if (d.effect === "deny") {
    return "question" in d ? `no: undecided (${d.question})` : `no: ${d.because}`;
  }
  const view = d.view === "full" ? "yes" : d.view;
  return [view, d.audit, d.grant && "grant", d.flagForReview && "review"]
    .filter(Boolean)
    .join(" · ");
}

/** A person-level table: rows are profile × key, columns the actions. */
type Kind = { name: string; keys: readonly string[]; actions: AccessAction[] };
const kinds: { kind: Kind; resource: (key: string, phase: AccessPhase) => Resource }[] = [
  {
    kind: { name: "Fields", keys: fieldCategories, actions: ["read", "list", "write"] },
    resource: (key, phase) => sampleField(key as (typeof fieldCategories)[number], phase),
  },
  {
    kind: {
      name: "Documents",
      keys: DocumentType.options,
      actions: ["read", "list", "open_document", "write"],
    },
    resource: (key, phase) => sampleDocument(key as DocumentType, phase),
  },
];

export type Cell = {
  label: string;
  staff: boolean;
  key: string;
  action: AccessAction | DocumentOperation;
  text: string;
};

function cells(index: number, phase: AccessPhase, mode: Mode): Cell[] {
  const { kind, resource } = kinds[index]!;
  return accessProfiles.flatMap(({ label, subject }) =>
    kind.keys.flatMap((key) =>
      kind.actions.map((action) => ({
        label,
        staff: subject.kind === "staff",
        key,
        action,
        text: cellText(decideAccess(subject, resource(key, phase), action, accessModes[mode])),
      })),
    ),
  );
}

/** The full table in normal mode; in another mode only the staff cells that differ from it. */
function modeTable(mode: Mode, current: Cell[], normal: Cell[], columns: string[]): string {
  if (mode === "normal") {
    const rows = [];
    for (let i = 0; i < current.length; i += columns.length - 2) {
      const row = current.slice(i, i + columns.length - 2);
      rows.push([row[0]!.label, code(row[0]!.key), ...row.map((c) => c.text)]);
    }
    return table(columns, rows);
  }
  const changed = current.flatMap((c, i) =>
    c.staff && c.text !== normal[i]!.text
      ? [[c.label, code(c.key), code(c.action), normal[i]!.text, c.text]]
      : [],
  );
  const body = changed.length
    ? table([...columns.slice(0, 2), "Action", "Normal mode", "This mode"], changed)
    : "No cell differs from normal mode.";
  return `Only the staff cells that differ from normal mode.\n\n${body}`;
}

const modeName = (mode: Mode) => mode.replace("_", "-");

function section(index: number, phase: AccessPhase, mode: Mode): string {
  const { kind } = kinds[index]!;
  const heading = `### ${phase === "active" ? "Active" : "Evidence-set"} phase, ${modeName(mode)} mode`;
  const columns = ["Subject", "Key", ...kind.actions.map(code)];
  const body = modeTable(mode, cells(index, phase, mode), cells(index, phase, "normal"), columns);
  return `${heading}\n\n${body}`;
}

function audit(): string {
  const rows = accessProfiles.flatMap(({ label, subject }) =>
    AuditStream.options.map((stream) => {
      const decide = (actor: string, phase: AccessPhase, mode: Mode) =>
        cellText(
          decideAccess(subject, sampleAudit(stream, actor, phase), "read", accessModes[mode]),
        );
      return [
        label,
        code(stream),
        decide("staff-other", "active", "normal"),
        decide("staff-a", "active", "normal"),
        decide("staff-other", "evidence_set", "normal"),
        decide("staff-other", "evidence_set", "break_glass"),
      ];
    }),
  );
  const head = [
    "Subject",
    "Stream",
    "Others' events",
    "Own actions",
    "Evidence set",
    "Evidence set, break-glass",
  ];
  return table(head, rows);
}

function aggregates(): string {
  const rows = accessProfiles.map(({ label, subject }) => [
    label,
    cellText(decideAccess(subject, sampleAggregate(), "read", accessModes.normal)),
  ]);
  return table(["Subject", "`read`, `list`"], rows);
}

/** A document operation as a matrix cell shows it. */
export function permissionText(p: DocumentPermission): string {
  if (p.ok) return "yes";
  return "question" in p ? `no: undecided (${p.question})` : `no: ${p.because}`;
}

const documentOperations: DocumentOperation[] = ["add", "review", "delete"];
const operationTarget = {
  projectId: sample.projectId,
  regionId: sample.regionId,
  participationId: sample.participationId,
};

/** One cell per subject, document type and operation; the participant deletes their own upload. */
function operationCells(mode: Mode): Cell[] {
  const check = {
    add: mayAddDocument,
    review: mayReviewDocument,
    delete: (...args: Parameters<typeof mayAddDocument>) =>
      mayDeleteDocument(...args, { addedByParticipant: true, reviewState: "unreviewed" }),
  };
  return accessProfiles.flatMap(({ label, subject }) =>
    DocumentType.options.flatMap((key) =>
      documentOperations.map((action) => ({
        label,
        staff: subject.kind === "staff",
        key,
        action,
        text: permissionText(check[action](subject, key, operationTarget, accessModes[mode])),
      })),
    ),
  );
}

function operationSection(mode: Mode): string {
  const columns = ["Subject", "Type", ...documentOperations.map(code)];
  const body = modeTable(mode, operationCells(mode), operationCells("normal"), columns);
  const heading = { normal: "Normal", assisted: "Assisted", break_glass: "Break-glass" }[mode];
  return `### ${heading} mode\n\n${body}`;
}

/** An undecided cell found: its question, subject, key and action, and in which phase and mode. */
export type UndecidedCell = {
  question: string;
  label: string;
  key: string;
  action: AccessAction | DocumentOperation;
  where: string;
};

/** The undecided cells, one row per subject, key and action with every phase and mode. */
export function undecidedTable(found: readonly UndecidedCell[]): string {
  if (found.length === 0) return "No sampled cell is undecided.";
  const rows = new Map<string, string[]>();
  for (const c of found) {
    const key = [c.question, c.label, code(c.key), code(c.action)].join(" | ");
    rows.set(key, [...(rows.get(key) ?? []), c.where]);
  }
  return table(
    ["Question", "Subject", "Key", "Action", "Phase and mode"],
    [...rows].map(([key, where]) => [...key.split(" | "), where.join(", ")]),
  );
}

/** The cell as an undecided one (in `where`), or nothing when it is decided. */
export function asUndecided(c: Cell, where: string): UndecidedCell[] {
  const question = /undecided \((Q\d+)\)/.exec(c.text)?.[1];
  return question ? [{ question, label: c.label, key: c.key, action: c.action, where }] : [];
}

function undecided(): string {
  const found = kinds.flatMap((_, index) =>
    phases.flatMap((phase) =>
      modes.flatMap((mode) =>
        cells(index, phase, mode).flatMap((c) => asUndecided(c, `${phase} ${mode}`)),
      ),
    ),
  );
  const operations = modes.flatMap((mode) =>
    operationCells(mode).flatMap((c) => asUndecided(c, `any phase ${mode}`)),
  );
  return undecidedTable([...found, ...operations]);
}

const yesNo = (value: boolean) => (value ? "yes" : "no");
const codes = (values: readonly string[]) => (values.length ? values.map(code).join(", ") : "—");

/** The history's streams per project role, and each event type's projection (Q157, Q161). */
export function historyTables(): string {
  const roles = ProjectRole.options.map((role) => {
    const { streams, ownStreams } = historyStreams(new Set([role]), true);
    return [code(role), codes(streams), codes(ownStreams), codes(roleFieldKnowledge[role])];
  });
  const events = auditProjectionRows().map((row) => [
    code(row.eventType) + (row.field ? ` (${code(row.field)})` : ""),
    row.stream ? code(row.stream) : "project-level",
    yesNo(row.showsChange),
    yesNo(row.showsReason),
    codes(row.detailKeys),
  ]);
  return [
    table(["Project role", "Streams", "Own events only", "Field keys of"], roles),
    table(["Event type", "Stream", "Change", "Reason", "Detail keys"], events),
  ].join("\n\n");
}

/** docs/domain/generated/access-matrix.md, written by `pnpm generate`. */
export function renderAccessMatrixDoc(): string {
  const personSections = kinds.map(
    ({ kind }, index) =>
      `## ${kind.name}\n\n${phases.flatMap((phase) => modes.map((mode) => section(index, phase, mode))).join("\n\n")}`,
  );
  return `# Access matrix (generated)

Generated by \`pnpm generate\` from \`packages/domain/src/access\`. Do not edit: CI fails when
this file differs from the code. The rules behind it are in
[data-protection.md](../data-protection.md) and
[round 11](../../decisions/2026-10-16-answers-round-11.md); they are *assumed* (Q28, Q49, Q51,
Q61–Q65, Q80, Q87) until the DPO confirms them (pre-pilot gate).

How to read it: one row per subject and key (field category, document type, audit stream), for
one participation of the subject's project and region. \`yes\` is the full view;
\`sensitive_read\`, \`sensitive_write\`, \`document_opened\` and \`break_glass_access\` name the
audit entry; a break-glass \`grant\` covers that one participant, category or document type and
action, and is flagged for \`review\`. Field rows use a self-service field of the category where
there is one; participants' other fields are \`never\`. Not shown: staff without a role in the
project are \`not_member\`, org roles outside their region \`out_of_region\`; participants reach
only their own participation and have no modes (every other mode is \`never\` for them).
\`open_document\` on a field, audit or aggregate resource and \`write\` on an aggregate are
\`not_applicable\`. Unknown access is denied: \`undecided\` names the open question.

${personSections.join("\n\n")}

## Document operations

Who may add, review and delete a document (Q146, *assumed*; \`mayAddDocument\`,
\`mayReviewDocument\`, \`mayDeleteDocument\`), which the document functions check again; the
access matrix above answers \`write\` with \`via_domain_operation\` for them. Staff add in
normal mode as themselves or in assisted mode on the participant's behalf (actor +
\`onBehalfOf\`), review and delete in normal mode only; break-glass never writes. The
participant's \`delete\` is sampled on their own upload, not yet accepted: one added by staff is
\`added_by_staff\`, an accepted one \`document_accepted\`; staff delete any document of the type
with a reason code. Signed documents are never deleted (\`immutable\`: the retention job only).
A type whose slice hasn't decided its operations is \`undecided\` (Q65) for the roles that may
open it.

${modes.map(operationSection).join("\n\n")}

## Audit metadata

Filtered projections (Q87 A), the same in every mode in the active phase; \`list\` as \`read\`
(never in the evidence set); \`write\` is \`never\` (append-only). Once only the evidence set
is left, the operational streams need break-glass; the review queue stays open (round 12).

${audit()}

## Audit history

A participation's tab "Verlauf" (Q157, *accepted*; the per-type readings Q161, *assumed*): the
function \`audit_history\` returns only these rows, and of each only what its event type shows.
A consultant's streams apply while assigned; several roles are the union (Q61). Field keys in
\`fields\` are kept only for the categories the viewer's roles may know. \`security\`,
\`review\` and project-level events are never in a history; opening one writes
\`audit_history_opened\` (\`security\`). Generated from \`auditProjection\`,
\`historyStreams\` and \`roleFieldKnowledge\` (\`packages/domain/src/audit/history.ts\`).

${historyTables()}

## Aggregates

The same in every mode.

${aggregates()}

## Undecided cells

**Q65**: write permissions, pending the DPO and PL review
([open-questions.md](../../open-questions.md)). Q136 decided the staff writes of self-service
fields: in assisted mode only. Staff writes of a category's other fields outside a domain
operation (e.g. the IBAN by a consultant, the birth date by back office) stay \`undecided\`;
the rows above sample self-service fields, so they don't show here. Q146 decided the operations
of the participant's own documents (\`cv\`, \`participant_upload\`,
\`qualification_certificate\`); the other types' operations stay \`undecided\` until their
slice (Slices 6 and 7).

${undecided()}
`;
}
