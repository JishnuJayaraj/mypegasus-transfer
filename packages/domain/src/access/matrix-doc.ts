import { DocumentType } from "../documents/catalog";
import {
  AuditStream,
  decideAccess,
  type AccessAction,
  type AccessPhase,
  type Decision,
  type Resource,
} from "./decide";
import {
  accessModes,
  accessProfiles,
  fieldCategories,
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

function text(d: Decision): string {
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

type Cell = { label: string; staff: boolean; key: string; action: AccessAction; text: string };

function cells(index: number, phase: AccessPhase, mode: Mode): Cell[] {
  const { kind, resource } = kinds[index]!;
  return accessProfiles.flatMap(({ label, subject }) =>
    kind.keys.flatMap((key) =>
      kind.actions.map((action) => ({
        label,
        staff: subject.kind === "staff",
        key,
        action,
        text: text(decideAccess(subject, resource(key, phase), action, accessModes[mode])),
      })),
    ),
  );
}

function section(index: number, phase: AccessPhase, mode: Mode): string {
  const { kind } = kinds[index]!;
  const heading = `### ${phase === "active" ? "Active" : "Evidence-set"} phase, ${mode.replace("_", "-")} mode`;
  const current = cells(index, phase, mode);
  if (mode === "normal") {
    const rows = [];
    for (let i = 0; i < current.length; i += kind.actions.length) {
      const row = current.slice(i, i + kind.actions.length);
      rows.push([row[0]!.label, code(row[0]!.key), ...row.map((c) => c.text)]);
    }
    return `${heading}\n\n${table(["Subject", "Key", ...kind.actions.map(code)], rows)}`;
  }
  const normal = cells(index, phase, "normal");
  const changed = current
    .filter((c, i) => c.staff && c.text !== normal[i]!.text)
    .map((c) => [c.label, code(c.key), code(c.action), normal[current.indexOf(c)]!.text, c.text]);
  const body = changed.length
    ? table(["Subject", "Key", "Action", "Normal mode", "This mode"], changed)
    : "No cell differs from normal mode.";
  return `${heading}\n\nOnly the staff cells that differ from normal mode.\n\n${body}`;
}

function audit(): string {
  const rows = accessProfiles.flatMap(({ label, subject }) =>
    AuditStream.options.map((stream) => {
      const decide = (actor: string, phase: AccessPhase, mode: Mode) =>
        text(decideAccess(subject, sampleAudit(stream, actor, phase), "read", accessModes[mode]));
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
    text(decideAccess(subject, sampleAggregate(), "read", accessModes.normal)),
  ]);
  return table(["Subject", "`read`, `list`"], rows);
}

function undecided(): string {
  const rows = new Map<string, string[]>();
  kinds.forEach((_, index) => {
    for (const phase of phases) {
      for (const mode of modes) {
        for (const c of cells(index, phase, mode)) {
          const question = /undecided \((Q\d+)\)/.exec(c.text)?.[1];
          if (!question) continue;
          const key = [question, c.label, code(c.key), code(c.action)].join(" | ");
          rows.set(key, [...(rows.get(key) ?? []), `${phase} ${mode}`]);
        }
      }
    }
  });
  return table(
    ["Question", "Subject", "Key", "Action", "Phase and mode"],
    [...rows].map(([key, where]) => [...key.split(" | "), where.join(", ")]),
  );
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
[data-protection.md](../data-protection.md), the Slice 1 plan (section 5.6) and
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
\`not_applicable\`. Unknown access is denied: \`undecided\` names the open question (D10).

${personSections.join("\n\n")}

## Audit metadata

Filtered projections (Q87 A), the same in every mode in the active phase; \`list\` as \`read\`
(never in the evidence set); \`write\` is \`never\` (append-only). Once only the evidence set
is left, the operational streams need break-glass; the review queue stays open (round 12).

${audit()}

## Aggregates

The same in every mode.

${aggregates()}

## Undecided cells

**Q65**: write permissions, pending the DPO and PL review
([open-questions.md](../../open-questions.md)).

${undecided()}
`;
}
