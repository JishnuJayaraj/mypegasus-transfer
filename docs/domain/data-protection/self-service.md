# Data protection: self-service

### Self-service data *(assumed, Q112, Q138, Q140, Q141)*

- **What the participant writes:** the wizard's confidential fields (TL 407 section B; pages and
  value sets in `regional-variation.md`, "Self-service wizard"): the profile in
  `participant_profile` (one row per participation: gender, Familienstand, education and work
  history, languages, driving licence, vehicle, working time, job wishes, locations, distance,
  earliest start, the chain's confidential custom fields; class `confidential`, retention
  `personnel_file`) and the contact fields address, phone, mobile and private email in
  `participant_details` (never the login channels or the work email; names and birth date are
  shown read-only). The highly confidential and special-category answers have their own
  encrypted tables and logged endpoints (below); no page write, list or wizard response carries
  them (unknown keys are refused).
- **Write path:** only `write_self_service_data` (SECURITY DEFINER; the runtime role selects the
  tables and writes none). One page per call, saved whole into the real fields (no draft store),
  with the profile's `revision` (optimistic concurrency: a stale one is `409 stale_revision`). The
  function computes the changed fields and audits them as `participant_data_changed` with their
  names (`custom.<key>` for a custom field), never a value; an unchanged page writes nothing.
  Refused when the participation is terminal (`participation_closed`), for any session but the
  live `active` session of this participation (an `activating` one included, `401`), before the
  current purposes notice is acknowledged (`409 notice_required`), and in the evidence-set phase
  (no writes, the matrix above). Staff write through assisted mode only (ADR-0007).
- **Participant-maintained contact fields (Q112):** a contact field the participant changes (also
  in assisted mode) is recorded in `participant_details.participant_maintained`; the HR import
  (`write_participant_data`) never overwrites it, and its preview reports a differing value as
  `participant_maintained` by row and target, never the value. A written address also notes its
  time, for the placement-Agentur hint (`regional-variation.md`, "Placement Agentur").
- **Purposes notice (Q138):** before the first page the portal shows `self-service-purposes:v1`
  (de/en, `packages/domain/src/notices/catalog.ts`): the purposes per phase and their legal bases
  (Art. 6(1)(b)/(c), Art. 9(2)(b) for the yes/no health answers). Its acknowledgement (version,
  language, the participant or staff on their behalf, time) is a record in
  `self_service_notice_acknowledgement`, immutable, retention `personnel_file`, audited as
  `self_service_notice_acknowledged`: **not a consent**. A new version is shown, and acknowledged,
  again before the next page.
- **Staff read** (`GET /api/v1/participations/{id}/self-service`, normal mode): each value the
  access matrix lets the viewer read (confidential: the assigned consultant, the PL, back office;
  an unassigned consultant and the org roles get a `403`), the maintained contact fields, the
  notice acknowledgement and the missing items of the data-collection and profiling steps as
  codes, for the fields the viewer may know about (below). Nothing on it needs a logged read.
- **The tab "Selbstauskunft"** (staff app, normal mode): the confidential answers the viewer
  reads, by wizard page; the highly confidential and special-category answers only as "angegeben
  / fehlt" (`sensitive`, presence) for the fields the viewer may know about: those they read in
  normal mode or see in assisted mode or through break-glass (so the PL sees whether health and
  disability are given, never the value). "Anzeigen" appears for the fields the viewer may read
  in normal mode (`sensitiveReadable`: the assigned consultant all, back office all but health)
  and reads that one field on `GET …/self-service/sensitive/{group}?field=…`, a logged read
  (`sensitive_read`), never cached. The missing items of the data-collection and profiling steps
  are listed per step as labels; custom fields by their German label (`customLabels`).
- **Highly confidential and special-category answers (Q135, Q141):** encrypted in the database
  (ADR-0002, field encryption), one table per access category and retention class:

  | Table | Fields (TL 407 section B) | Class / access category | Retention |
  |---|---|---|---|
  | `participant_identifier_data` | RV-Nummer | highly confidential / `identifiers` | `participation_record` (evidence set, Q88) |
  | `participant_residence_social_data` | nationality (`german`, or `other` with an ISO 3166-1 alpha-2 country), entry date and residence status (only with another nationality, never required), Bürgergeld yes/no | highly confidential / `residence_social` | `personnel_file` |
  | `participant_health_data` | health restrictions yes/no, Schwerbehinderung/Gleichstellung yes/no; never a diagnosis or the GdB | special category / `health`, `disability` | `health_record` |

  Each value is a ciphertext (`pgp_sym_encrypt`, AES-256, an envelope binding it to its
  participation and field) beside an unencrypted presence flag; completeness, the wizard state
  and every list use the presence only, never the value. The runtime role can't select a
  ciphertext column and writes none of the tables; only `write_sensitive_fields` and
  `read_sensitive_fields` encrypt and decrypt, with the key the API passes per call
  (`FIELD_ENCRYPTION_KEY`, HKDF `field-encryption:v1`). Every field written is audited as
  `sensitive_write`, every field read as `sensitive_read`, with its key only.
- **Their endpoints:** the participant reads and writes a group (`ba_details`, `health`) on
  `GET`/`PUT /api/v1/portal/self-service/sensitive/{group}` (`no-store`; the write as a page write:
  whole, with the revision, after the notice; `422` with codes and locations, never a value); the
  health group needs the session's step-up (`403 step_up_required`; ADR-0007, step-up). Staff read
  on `GET /api/v1/participations/{id}/self-service/sensitive/{group}` in normal mode exactly the
  fields the matrix gives them (the assigned consultant all; back office identifiers,
  residence_social and disability; the PL none without assisted mode or break-glass), each read
  logged (`field` narrows it to one); the others are left out, not shown empty. In assisted mode
  staff read and write on `GET`/`PUT /api/v1/participations/{id}/assisted/self-service/
  sensitive/{group}` the group's fields their role sees there (a write leaves the others as they
  are), each field audited with actor and `onBehalfOf`; no step-up for staff.
- **Assisted mode records** (`assisted_mode`, ADR-0007): the staff session's hash, the staff
  user, the participation, how and when it started and ended; class internal, `case_internal`,
  retention `access_credential`. No value of the participant's is on it.
- **Step-up (Q129, Q137):** before the health and disability answers, once per portal session: a
  birth-date account enters its birth date again (the session after an activation with that step
  counts; the fifth wrong one ends the session, audited `step_up_failed`), a photo-ID account a
  step-up code sent to a verified channel it picks (the login code never counts; the code has its
  own five attempts). Only the special-category fields are gated.
- **The portal's own consents** (`GET /api/v1/portal/consents`): purpose, source, text version,
  language, given and ended, and the channel id of a portal contact consent; never an address.
  The portal page "Einwilligungen" lists them; revoking `portal_contact` is removing the channel.
- **The wizard in the portal** (`@transfer/self-service-ui`, "Meine Angaben"): the purposes notice
  first, then one page at a time, saved whole on "Weiter" with the revision read ("Zurück" doesn't
  save); a `409` reloads the state and says so, a `422` shows the codes at their fields. The copy
  says optional data may be left for the Berater and asks for no diagnoses in free text; the
  "Gesundheit" page says it asks yes or no only. "Angaben für die Agentur" (after Kontakt) and
  "Gesundheit" (last before "Weitere Angaben", behind the step-up) read their group each time they
  open and keep the values only in the page's form, never in the query cache; the progress bar
  counts them by presence. Nothing is kept in browser storage; logging out drops the cached state.
- **The portal start page: "Das fehlt noch"** (`GET /api/v1/portal/progress`, `no-store`; slice
  6b, C5 in `docs/architecture/ui-patterns.md`): the participant's own tasks with a done flag and
  codes only, never a value: the purposes notice; each wizard page with a required field (done
  when none is missing, the sensitive pages by presence); each required upload of the
  participant's own document types (`documentPresent` rules that apply now, done while a
  non-rejected document is there, or an accepted one where the rule asks for it); each appointment
  they were invited to that is still upcoming and not cancelled, or that they booked (done with a
  live booking). Pages without a required field are listed as "Freiwillig" and never counted, so
  filling one changes nothing. Computed by the completeness engine (`portalProgress`); the start
  page loads only `/portal/me`, `/portal/progress` and `/portal/appointments` (the next booking's
  generic details), never `/portal/self-service` or a sensitive group. "Mein Konto" shows the
  masked channels and "Abmelden".
