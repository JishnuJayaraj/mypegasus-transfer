# ADR-0006: Ports & adapters for external services

- Status: Accepted (amended 2026-10-22)
- Date: 2026-10-15

## Decision
Every external capability is an interface in `packages/adapters` with a mock implementation.
Features import interfaces only. The implementation is selected via environment configuration.

Canonical list:

| Interface | Purpose | First real implementation |
|---|---|---|
| `PdfRenderer` | AcroForm filling of official forms + HTML→PDF for our documents | pdf-lib (AcroForm), Gotenberg (HTML) — ADR-0009 |
| `Mailer` | email | open |
| `SmsSender` | SMS (primary participant login channel) | open (EU provider, AVV) |
| `FileStorage` | uploads, scans, generated documents | S3-compatible (MinIO locally, Hetzner Object Storage) |
| `VirusScanner` | upload scanning | open (e.g. ClamAV in the cluster) |
| `Exporter` | versioned CSV exports: payroll (DATEV LODAS later), Teilnehmerliste per Agentur, customer report, half-yearly Agentur report | CSV |
| `Clock` | current date/time, so deadline logic and system transitions are testable | system clock |
| `AiAssistant` | **v2 only**; not built in the MVP | — |

Not adapters:
- **Staff login** uses a plain OIDC client configured by environment (Entra ID). No
  `IdentityProvider` adapter (ADR-0007).
- **No e-signature adapter.** DSV, TL 407 and Kug 200b are signed in wet ink.

## Consequences
+ The MVP runs fully locally and in cloud sessions with mocks; real providers are added one by
  one.
+ Easy to test.
- Each real adapter needs contract tests against its interface. For `PdfRenderer`, that means
  tests that fill the real blank TL 407 / Kug 200b and read the values back.

## Conventions as built (Slices 0–2)

- **No direct time** in `packages/domain`, `packages/config` and `apps/api/src/jobs`: no
  `Date.now()` and no `new Date(…)` outside tests and `testing/`, enforced by a source scan
  (`packages/adapters/src/clock/no-direct-time.test.ts`). Business dates (Berlin today, run times)
  come from the injected `Clock`; recorded instants (`occurred_at`, `activated_at`,
  `completed_at`) are the database's `now()`.

## As built 2026-10-21: activation delivery (Slice 3, PR 3d)

- `Mailer.send` and `SmsSender.send` take the destination, rendered text and an explicit
  `idempotencyKey`. They return `sent` or definitive `failed`; `DeliveryOutcomeUnknown` means a
  timeout or lost response whose provider outcome cannot safely be guessed.
- The mock implementations share a process-local `DevelopmentOutbox`, deduplicate by idempotency
  key, retain only the last 100 messages and can be switched to sent, failed or unknown in tests.
  Their log callback receives only the generated message id. In development,
  `GET /api/v1/dev/outbox` exposes the synthetic outbox; it is not mounted in production.
- Activation messages use the committed `activation_code.id` as the provider idempotency key.
  The provider is called only after the issuance transaction commits. A definitive failure
  revokes the code (unless a reissue or terminal transition already revoked it during the send;
  that reason stands); an unknown outcome records `delivery_unknown` and keeps it valid. Any
  other provider error counts as unknown and is not logged, since it may echo the destination.
- `MAIL_ADAPTER` and `SMS_ADAPTER` currently accept only `mock`. The mocks are wired only outside
  `NODE_ENV=production`: they report `sent` without sending, which would record Art. 14 evidence
  for a message nobody received. In production, in-person issuance answers
  `503 delivery_unavailable` before any code exists. A real EU provider, its AVV and interface
  contract tests are required before real messages. SMS is one participant-selected
  channel, not a default or primary channel.

## As built 2026-10-21: one-time codes and the activation notice (Slice 3, PR 3e)

- A portal one-time code follows the same protocol: `create_one_time_code` commits the challenge
  `pending`; the API sends after the commit with the challenge id as the idempotency key; then
  `record_one_time_code_delivery` records the outcome. A definitive failure invalidates the code
  (unless a newer one superseded it during the send) and answers `503 delivery_failed`; any
  provider error is an unknown outcome, never logged, and the code stays usable. Without a sender
  (production) the request answers `503 delivery_unavailable` before a challenge exists.
- The activation notice carries no secret and goes through the job `portal.activation-notice`
  (ADR-0011) with the provider key `activation-notice:<channelId>`. The server builds one set of
  senders for the API and the jobs (`messaging` in `apps/api/src/app.ts`), so the development
  outbox shows the notice too.

## As built 2026-10-21: login codes (Slice 3, PR 3f)

- A login code follows the same protocol (`request_login_code`, the send with the challenge id
  as the idempotency key, `record_login_code_delivery`), except that the send runs **after the
  `202`** (`apps/api/src/detached.ts`): the answer must not reveal, by its timing or its outcome,
  whether the address has an account, so a definitive failure only invalidates the code. The code
  exists only in the closure of that task, never in a job payload; failures are logged without a
  message; shutdown waits for the tasks in flight before closing the pool. Whether a sender exists
  depends on the kind only, so `503 delivery_unavailable` reveals nothing.
- A channel verification code (`request_channel_code`) is sent in the request like the
  activation's, and its outcome recorded by `record_one_time_code_delivery`.
- A recovery code in person is sent like a first in-person code (`record_activation_delivery`).

## As built 2026-10-22: reminder delivery (Slice 5, PR 5-2)

- Reminders go through the same `Mailer` and `SmsSender` (data-protection.md, reminders): plain
  text, the fixed `portal-reminder:v1` in the account's language with `PORTAL_PUBLIC_URL` as its
  only placeholder; by email with the subject and the privacy note, by SMS the text alone. The
  idempotency key is `reminder:<reminderId>`, so a retry after an unknown outcome never sends
  twice at a provider that honours it (the mock outbox does).
- `sent` and `failed` are the provider's answer; `DeliveryOutcomeUnknown` or any other error
  counts as unknown, is never logged (it may echo the address) and fails the job for a retry.
- Production has no sender until a real adapter exists, so the reminder route answers
  `503 delivery_unavailable` there; in development and e2e the mocks write to the outbox
  (`GET /api/v1/dev/outbox`).

## As built 2026-10-22: document storage and virus scan (Slice 4b, PR 4b-1)

- `FileStorage` (`packages/adapters/src/storage`): `put(key, bytes)` (replaces an object under
  the same key), `get(key)` (`FileNotFound` when missing), `delete(key)` (a missing key
  succeeds, so the purge job can retry). Keys are lower-case segments of letters, digits and
  hyphens (`documents/<documentId>`); anything else (`..`, an absolute path, a name) is a
  `RangeError` that never repeats the key. `MemoryFileStorage` serves tests;
  `FilesystemFileStorage` serves development and e2e under `STORAGE_DIR` (default
  `.data/documents` in the repo, git-ignored, outside the web root), directories `0700`, files
  `0600`, written to a temporary file and renamed. One contract test
  (`storage/testing/contract.ts`) runs against both; a real adapter runs it too.
- `VirusScanner` (`packages/adapters/src/virus-scan`): `scan(bytes)` → `clean`, `infected` or
  `unscannable`; `ScannerUnavailable` when it can't be reached (the upload is refused, nothing
  stored). `MockVirusScanner` answers `infected` for the EICAR test file, `unscannable` for a
  PDF with `/Encrypt`, `clean` otherwise, and throws when `available` is false. The EICAR test
  string is never committed: tests assemble it at runtime, the mock knows only its distinctive
  part.
- **File encryption is not an adapter's job.** The API encrypts every file before `put`
  (`apps/api/src/document-encryption.ts`; data-protection.md, document files): AES-256-GCM with
  a data key per document, wrapped under an HKDF key (`document-encryption:v1`) from
  `DOCUMENT_ENCRYPTION_KEY` (required outside development), so no store, provider or backup
  ever holds plaintext, and a real S3 adapter needs no server-side encryption to be safe.
- Environment: `STORAGE_ADAPTER` (`filesystem` or `memory`; `mock`, the value of older `.env`
  files, reads as `filesystem`), `STORAGE_DIR`, `VIRUS_SCAN_ADAPTER` (`mock` only).
- **Production wiring:** like the mail and SMS mocks, neither the storage nor the mock scanner is
  wired with `NODE_ENV=production`; uploads and openings answer `503 storage_unavailable` there
  (from PR 4b-2) until an S3-compatible store (Hetzner Object Storage or MinIO in the cluster,
  no public access, versions and backups kept ≤ 30 days) and a ClamAV scanner exist with their
  contract tests and AVV chain (pre-pilot, Q149).

## As built 2026-10-24: `PdfRenderer` and `Exporter` (Slice 6, PR 6-1)

- `PdfRenderer` (`packages/adapters/src/pdf`): `fillForm({ template, fieldMap, fields, flatten? })`
  and `renderHtml(document)`.
  - **Filling** runs in process with pdf-lib for every adapter: each text field at the layout's
    size in the committed Noto Sans subset, embedded whole through `@pdf-lib/fontkit` so names
    outside WinAnsi (`Ł`, `ğ`, `ș`) print; radios and checkboxes by the export value or on-state
    of the field map; a field the map never fills, or a value of another kind, is
    `FormFillRefused` (the field name, never a value). Flattening is the default; it then drops
    the objects flattening orphaned and the references to deleted widgets (page `Annots`, the
    tagged structure tree's `OBJR`), so strict readers find no broken cross-reference. Contract
    tests read every value back from the unflattened fill and check the flattened page count.
  - **HTML** goes to an `HtmlRenderer`: `GotenbergHtmlRenderer` posts `index.html`, `header.html`
    and `footer.html` to Gotenberg's `/forms/chromium/convert/html` (A4, margins for the header
    and footer); `MockHtmlRenderer` draws the document's structured text (`PrintDocument.text`)
    with pdf-lib, without a browser or network, page "n von m" included. A refusal or an
    unreachable Gotenberg is `PdfUnavailable`, never logged with content.
  - `createPdfRenderer({ adapter, gotenbergUrl, production, font })`: `PDF_ADAPTER=gotenberg`
    needs `GOTENBERG_URL` (a cluster-internal service); `mock` wires the mock outside production
    only, so in production HTML answers `PdfUnavailable` (`503 pdf_unavailable`) while forms
    still fill. `createTextMeasure(font)` gives the layout the same metrics pdf-lib draws with.
  - Pure helpers: `mergePdfs` (a form and its Anlage as one packet, a batch's scans) and
    `imageToPdf` (a JPEG or PNG scan as a centred A4 page); `readAcroFormValues` reads a fill
    back.
  - The Gotenberg contract test runs against `GOTENBERG_URL` (CI's service container
    `gotenberg/gotenberg:8.37.0-chromium`, pinned by digest) and is skipped when it is empty.
- `Exporter` (`packages/adapters/src/export`): `CsvExporter.export({ kind, version, columns, rows })`
  → `<kind>-v<version>.csv`, `;`-separated, UTF-8 with BOM, a header row, CRLF, quoted where a
  cell holds `;`, `"` or a line break; a cell starting with `=`, `+`, `-`, `@`, a tab or a carriage
  return gets a leading `'` (Q159). `EXPORT_ADAPTER=csv`.
