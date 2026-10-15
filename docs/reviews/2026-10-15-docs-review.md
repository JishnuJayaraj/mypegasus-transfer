# Docs review — 2026-10-15

Critical review of `CLAUDE.md` and everything under `docs/` before Slice 0, written from a
senior-engineer point of view. No code was written. Questions raised here are in
`docs/open-questions.md` as #13–#39. Nothing in the existing docs or ADRs has been changed yet:
section 4 proposes the ADR changes, to be applied after approval.

## 1. The eight things to fix first

1. **Rule 6 ("no person-level data to the customer") collides with the DSV.** The customer is a
   party to the tripartite contract and signs it. It must know who signed so it can end those
   employment relationships, and it usually pays per-head costs. The rule needs a defined,
   minimal exception list (Q13, Q14).
2. **The lifecycle has no way out for most states.** Nobody can leave from `imported`,
   `contacted`, `unreachable`, `informed`, `data_collection` … `dsv_signed`. Real projects have
   direct placements, withdrawals and people who never answer. TA-only projects have no end
   state. Late joiners and overrides contradict "only along the arrows" (see 2.1).
3. **One Agentur and one TG start date per project is assumed and not verified.** Both are
   probably per participant (Q15, Q18). This changes the data model and the config resolution.
4. **Data protection work comes too late.** There is no DPIA, no key management, no audit-log
   retention, and backup/restore only arrives in Slice 9, while ADR-0005 allows pilots with real
   data "locally". The pilot location and a DSFA must be settled before any real data (Q25, Q26).
5. **Authorisation arrives in Slice 3, after import (Slice 2).** The first endpoints that take
   personal data would be built without the permission model. Move the authz model forward.
6. **"Zod schemas" cannot be configuration data.** Regional field schemas stored in the DB must
   be JSON Schema (or a small DSL) turned into validators at runtime. The completeness-rule
   language is not defined, and without a definition it will turn into a workflow engine.
7. **The audit guarantee is only a convention.** "Use the audit helper" will be bypassed sooner
   or later. Enforce it in the database (same transaction, no direct `UPDATE` of status,
   append-only by grants). Audit records are personal data themselves and need a retention rule.
8. **Platform versions:** Node 22 leaves LTS in April 2027, a few months after the planned MVP.
   Vite+ (beta) and TS 7 tooling are both early-stage. Slice 0 needs written exit criteria for
   falling back.

## 2. Contradictions

### 2.1 Domain and lifecycle
| # | Where | Contradiction |
|---|---|---|
| C1 | CLAUDE.md rule 6, data-protection.md rule 2 vs. glossary (DSV) and F8 | The customer signs the DSV but may receive no person-level data. |
| C2 | process-and-lifecycle.md "only along the arrows" vs. "late joiners … move back into the flow" and "PL can override a guard" | Late joiners need arrows that don't exist (e.g. `dsv_declined → dsv_offered`, `profiling_declined → informed`, `closed → …`). Overrides skip guards, but nothing says whether they can skip arrows. |
| C3 | Lifecycle: `closed` triggers deletion vs. late-joiner re-entry | A non-signer who changes their mind can't come back if the retention job has already run. Deletion needs a grace period tied to the signing deadline. |
| C4 | regional-variation.md config step keys (`agentur_submission`, `profiling`, `dsv`) vs. lifecycle states (`submitted_to_agentur`, `profiling_in_progress`, `dsv_offered`) | Two different vocabularies. Config steps should reference a fixed `Step` enum in `packages/domain`. |
| C5 | regional-variation.md "Fixed: data model of core entities" + "core fields are columns" vs. "Required fields per step are configurable" | The base field set is not listed anywhere, and "base defaults" in the resolution order are undefined. |
| C6 | ADR-0004 "New region = new template, no deploy" vs. "seed files in MVP" | With seed files, a new region needs a deploy. That's fine for the MVP, but the ADR should say so. |
| C7 | PRD "Admin: global or per region" / lifecycle "regional admins see their region" | "Region" is not an entity anywhere (Q35). |

### 2.2 Data protection and hosting
| # | Where | Contradiction |
|---|---|---|
| C8 | data-protection.md rule 5 ("unless contractually covered") vs. ADR-0005 ("AI providers must meet the same residency rules") | Is a US provider with a contract allowed or not? (Q38) |
| C9 | ADR-0005 "Development & pilots: run locally … real data only on company machines" vs. CLAUDE.md rule 1 and the ASVS L2 target | A pilot with social data on a laptop running Docker Compose has no backup, TLS, monitoring or access control. Pilots should run on the cluster. |
| C10 | Classification table (social data = "health, disability, BA data") vs. "BA data" everywhere | "BA data" is undefined. Is the BA-Kundennummer special? What about profiling results? Some of the most sensitive data is missing from the table: SV-Nummer, Steuer-ID, IBAN (Q29). |
| C11 | NFR "2,000 participants filtered client-side" vs. "audit every read of special-category data" | If list payloads contain special-category fields, every list load creates thousands of audit entries. Lists must exclude those fields by design. |
| C12 | data-protection.md "encrypted at rest (field level)" vs. ADR-0002 "config fields in jsonb" and client-side filtering | Encrypted fields can't be filtered or indexed, and no key management is defined. |
| C13 | Audit log "append-only" (ADR-0002) vs. deletion/anonymisation (rule 3) | Audit entries name the person. Either pseudonymise subject references or define audit retention. |

### 2.3 Product, tooling and process
| # | Where | Contradiction |
|---|---|---|
| C14 | CLAUDE.md "UI text German, `en` later" vs. PRD (German + English in MVP) | (Q39) |
| C15 | CLAUDE.md rule 3 adapter list (includes e-signature, no virus scan) vs. ADR-0006 list (virus scanner, identity provider, exporter) vs. `.env.example` (5 adapters) | The three lists should match. An e-signature adapter isn't needed while e-signatures are out of scope. |
| C16 | Guide level 1 "approve each command" vs. `.claude/settings.json` allowlisting `pnpm add *`, `pnpm exec *` and `git commit *` | Adding dependencies (supply chain) and running arbitrary binaries is pre-approved from day one. `pnpm add` should be `ask`. |
| C17 | `.claude/settings.json` denies `Read(./.env)`, but `Bash(cat .env)` is not denied | The deny is easy to get around. Low impact while there are no secrets, but don't rely on it. |
| C18 | CLAUDE.md "dates: store UTC" vs. legal deadlines (signing deadline, TG start, exit date) | These are calendar dates in Germany. Stored as UTC timestamps they shift by a day around midnight. Use `date` columns for legal dates. |
| C19 | CLAUDE.md "use `gh api` REST" vs. cloud sessions that use the GitHub MCP tools | Minor. Say "use the GitHub tools available in the session". |
| C20 | ADR-0007 is **Proposed**, while CLAUDE.md, the overview and the roadmap treat it as decided | Accept it or mark the dependent text as provisional. |

## 3. Gaps and risky assumptions

### 3.1 Domain
- **Linear process assumption.** The lifecycle assumes data collection → profiling →
  submission → DSV. In practice the DSV is often handed out at the info event with a deadline,
  in parallel with profiling, and profiling is a legal prerequisite for Transfer-KuG with
  exceptions (Q17). Consider separate tracks on the participation (profiling track, DSV track)
  with a combined guard for `active_in_tg`, instead of one chain.
- **Missing exits:** a `withdrawn` (or `left`) transition with a reason from every pre-TG state,
  including `dsv_signed` before the start date. Direct placement in the TA phase should feed the
  placement statistics (Q19).
- **TA-only end state** (`ta_completed`) and the §110 measures besides profiling (Q20).
- **System actor.** `dsv_expired` (deadline) and `active_in_tg` (start date) are time-driven.
  The audit model needs a `system` actor and a job that is idempotent and testable (inject a
  `Clock`).
- **Assisted mode actor.** Audit needs `actor` + `onBehalfOf`, not just "who".
- **DSV completeness.** Participant signature ≠ fully executed contract. The paper original's
  physical location should be tracked (Q21).
- **Project-level BA steps** (Anzeige, Agentur consultation of the parties) are not modelled
  (Q16).
- **Per-participant dates and Agentur** (Q15, Q18).
- **TG phase reality:** sub-statuses affecting KuG (sickness, parental leave), periodic reports
  to the Agentur, and qualification approval/funding sources such as ESF with their own
  retention rules (Q22, Q23, Q33).
- **Person across projects.** "Model it" without rules is a privacy risk: linking people across
  different customers is itself processing that needs a legal basis. Deletion must work per
  participation without breaking another active one (Q30).
- **Glossary gaps:** Remanenzkosten, Aufstockung, beE as code term, Personalnummer,
  BA-Kundennummer, Anzeige über Arbeitsausfall, Eingliederungsbericht (if applicable).
  Enum-value casing (`snake_case` states vs. `camelCase` code) is not stated.

### 3.2 Regional configuration
- No definition of **base defaults**, of the **completeness-rule language** (conditional
  requirements like "driving licence copy only if a licence is declared" are certain to come
  up), or of the **deadline/reminder rule format**.
- **Template upgrade semantics** for running projects: recompute completeness? Keep generated
  documents on the old version? (Q36)
- **Form templates:** official BA forms are probably fillable PDFs (AcroForm field mapping),
  which is a different PDF adapter capability from HTML→PDF for our own documents like the DSV
  (Q37).
- **Risky assumption:** that every regional difference sits at the edges. Some Agenturen may
  run profiling themselves or require an extra step. Collect the PL table (regional-variation.md)
  *before* Slice 1 freezes the state machine.

### 3.3 Data protection and security
- No **DPIA**, no record of processing activities, no TOM document (Q25).
- No **key management** for field-level encryption. Backups must be encrypted too.
- **Logging:** nothing says application logs, error trackers and job payloads must not contain
  personal data. This is the most common leak path.
- **Deletion vs. backups:** deleted data lives on in backups. Define the backup retention so the
  deletion promise holds.
- **Magic links:** the employer-provided contact data is often a work email that the employer
  controls. Shared family phones are another problem. Consider a second factor for social data
  (Q27). Also missing: rate limiting, link expiry values, and session lifetime.
- **Staff MFA** isn't mentioned. Make it a requirement for the IdP (ASVS L2).
- **Public self-registration endpoint:** abuse, people registering others, and retention of
  unmatched entries (Q31).
- **Defence in depth for project isolation:** consider Postgres row-level security keyed on
  project, in addition to API checks.
- **Excel import:** the common npm `xlsx` package is outdated on the registry. Pick a maintained
  parser, parse on the server, and treat uploads as untrusted (zip bombs, formula injection on
  CSV *export*).

### 3.4 Architecture and stack
- **Participant portal inside the staff SPA.** Mobile-first performance, a different auth flow,
  RTL languages (AR in v1.1) and a smaller attack surface all point to a separate
  `apps/portal` that shares `packages/*`. ADR-0001 already allows this. Decide now, because
  routing, auth and i18n setup depend on it.
- **API contract style** is undecided ("typed client from shared Zod schemas"): Hono RPC client
  vs. OpenAPI (`@hono/zod-openapi`). OpenAPI also helps exports and future integrations.
- **i18n library**, **job queue** (deferred to Slice 5, but time-driven transitions and
  reminders exist earlier), **object storage** (Hetzner Object Storage/S3-compatible behind
  `FileStorage`), **PDF engine** (Gotenberg/Chromium vs. pdf-lib) — all undecided.
- **`IdentityProvider` as an adapter** is over-abstraction for OIDC, which is already a
  standard. A configured OIDC client plus a dev stub is enough.
- **Node 22** reaches end of life on 30 April 2027. Target Node 24 LTS for the production
  image. The cloud sessions currently have Node 22.22.0 and PostgreSQL 16, so align dev and
  prod explicitly.
- **Session start hook:** `pnpm install` without `--frozen-lockfile` as a silent fallback can
  rewrite the lockfile. Also, `DATABASE_URL` uses the `postgres` user without a password over
  TCP, which may fail under the default `pg_hba`. Settle this in Slice 0.

### 3.5 Roadmap
- Slice 1 freezes the state machine before the PL table and Q15–Q20 are answered. Gate Slice 1
  on those answers, or accept that the state machine will change.
- Move the **authorisation model** (role × project × assignment, special-category visibility)
  into Slice 1 as pure domain logic. Slice 3 then only wires up identity.
- Slice 4 (wizard + consent + uploads + assisted mode + QR registration + matching) won't fit
  in < 400 lines. Split it into 4a wizard/consent, 4b uploads, 4c registration/matching.
- Add a **pre-pilot gate** between Slice 7 and real use: DPIA, backups/restore tested, TLS,
  monitoring, deployment manifests, pen-test or security review. Slice 9 is too late if pilots
  start earlier.

## 4. Proposed ADR changes

### Amendments to existing ADRs
| ADR | Proposed change |
|---|---|
| 0001 | Decide now: `apps/web` (staff) and `apps/portal` (participants) as two SPAs on one API. Add module-boundary enforcement (lint rule on import paths, e.g. Oxlint `no-restricted-imports`). |
| 0002 | Add: legal dates as `date`, timestamps as `timestamptz`; audit/status written in the same transaction via a single DB function or repository, with `UPDATE` on status columns revoked from the app role; append-only enforced by grants; subject references pseudonymisable; optional RLS per project. Config-field schemas are **JSON Schema** stored as data, compiled to validators at runtime (not Zod source). |
| 0003 | Node **24 LTS** instead of 22. Write down Slice 0 exit criteria for Vite+ and TS 7 (e.g. "if X doesn't work in a day, fall back"). Pin exact versions. Choose the i18n library and the API contract style (see ADR-0010). Verify the TS 6 alias package names and the Carbon v12 status before relying on them. |
| 0004 | Define: the `Step` enum shared by the lifecycle and config; the base-defaults file; a minimal declarative completeness DSL (required, requiredIf with equals/exists, document present + accepted), explicitly with no scripting; the template upgrade procedure; the template validation schema; seed files in the MVP mean a deploy per new region. Open: one template per project vs. per participant (Q15). |
| 0005 | Pilots with real data run **only on the cluster**, never on laptops. Add a pre-pilot checklist (DPIA, AVV with the cluster operator if it's a group company, backup and restore drill, encrypted backups with retention aligned to deletion, TLS, monitoring, German locations only). Resolve the AI wording conflict with data-protection.md (Q38). |
| 0006 | Make one canonical adapter list: `PdfRenderer` (HTML→PDF and AcroForm fill), `Mailer`, `SmsSender`, `FileStorage`, `VirusScanner`, `Exporter`, `AiAssistant` (v2), plus `Clock` for testable deadlines. Drop the e-signature adapter (out of scope) and replace the `IdentityProvider` adapter with plain OIDC config (see 0007). Keep `.env.example` in sync. |
| 0007 | Accept it or mark it provisional. Add: staff MFA required at the IdP; server-side sessions in httpOnly SameSite cookies (no JWT in localStorage); CSRF protection; magic-link TTL, single use, rate limits; an optional second factor for participants (Q27); assisted mode as audited "act on behalf" with no session sharing. Authorisation model defined in `packages/domain` in Slice 1. |

### New ADRs to write
| ADR | Topic |
|---|---|
| 0008 | **Audit log design**: event schema (actor type user/participant/system, onBehalfOf, from/to, reason, request id), transactional write, retention, pseudonymisation, read-access logging for special-category data. |
| 0009 | **Personal data protection in the stack**: field-level encryption scope and key management (env-provided key vs. KMS/Vault on the cluster, rotation), no PII in logs/errors/job payloads, backup encryption and retention, deletion/anonymisation procedure. |
| 0010 | **API contract**: Hono + `@hono/zod-openapi` (or Hono RPC), error format, pagination, versioning. |
| 0011 | **Background jobs**: pg-boss (or similar) decided in Slice 0/1, not Slice 5; idempotent time-driven transitions with the system actor. |
| 0012 | **File and document storage**: S3-compatible object storage behind `FileStorage`, virus scan before availability, signed URLs, retention per document type, tracking of paper originals. |
| 0013 | **Authorisation model**: role × project × assignment matrix incl. special-category visibility, the region scope, optional Postgres RLS. |

## 5. Suggested next steps
1. Product owner and DPO answer Q13, Q14, Q25, Q26 and Q38. These change rules in CLAUDE.md.
2. PLs fill in the regional table and answer Q15–Q21 before Slice 1.
3. Approve or adjust section 4, then apply it to the ADRs in a separate docs PR (and fix the
   small contradictions C14–C20).
4. Tighten `.claude/settings.json` (`pnpm add` → ask) before Level 1 sessions start.
