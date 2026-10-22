# Decisions — 2026-10-21, round 38 (Slice 4a planning, Q133–Q140)

The product owner answered the questions raised while planning
[Slice 4a](../plans/archive/slice-4a.md). These are pilot answers in the placeholder roles of rounds 32–37:
no external Legal, BA or DPO confirmation is involved and none blocks development on synthetic
data. The 🔒 rows stay `assumed` until the DPO confirms them before the pilot; Q134 is
`confirmed`.

## Slice 4a scope

- **Sensitive fields (Q135):** 4a brings every TL 407 section B field a participant answers:
  RV-Nummer, nationality, entry date and residence status, Bürgergeld, health restrictions
  (yes/no) and Schwerbehinderung/Gleichstellung (yes/no). Not "arbeitslos seit/bis" (Q85 stays
  open; the profiler records it in Slice 6) and not the GdB (back office, payroll, Slice 8). With
  them come the first encrypted storage, the separate logged endpoints and the Q129 step-up.
- **Assisted mode (Q136):** the PL, the assigned consultant and back office may open the wizard on
  behalf of a participant. Each sees and writes exactly what the access matrix gives their role in
  assisted mode; the `undecided` (Q65) cells this needs are decided for the consultant and back
  office (Q136 row). Opening it requires the confirmation "the participant is present or on the
  phone and asked for help" and a controlled code `in_person` or `phone`, audited as
  `assisted_mode_started`; no free text, no time-limited grant.
- **Step-up (Q137):** once per participant session. An account assured by birth date re-enters the
  birth date (the session that follows an activation with the birth-date step already counts); an
  account assured by photo ID receives a dedicated step-up one-time code to a verified channel (the
  login code doesn't count). Five wrong birth dates end the session, audited. The gate covers
  special-category data (health, disability) only, as data-protection.md says.
- **Consents (Q138):** the "consent screen first" of F5 is a versioned purposes notice per phase
  (de/en) before the first wizard page, recorded as an acknowledgement, not a consent: the
  wizard's data rests on Art. 6(1)(b)/(c) and Art. 9(2)(b) (yes/no only). `consent_record` is
  generalised (purpose, source `portal` or `paper_form`, a channel only for `portal_contact`); the
  portal lists the participant's own consents. `kug200b_profile_access` becomes a purpose; staff
  record it from the signed paper form in Slice 6.
- **Placement Agentur (Q139):** the PL or back office choose any Agentur key for a participation
  (catalog or not), changeable while it isn't terminal, audited. A catalog Agentur the project
  hasn't pinned gets its latest version pinned in the same transaction (refused with the issues
  when the override wouldn't validate); without a template the participation can still collect
  data, its Agentur submission stays blocked. When the participant changes their address after
  the choice, the detail shows "Vermittlungs-Agentur prüfen"; nothing changes automatically. No
  postcode mapping.
- **Requirements (Q140):** the TL 407 section B fields marked `*` on the form (08/2025, primary
  source) become base-default rules `base-tl407-<field>` in the `profiling` step, basis `ba_form`
  (locked), for every project type. The wizard's pages are fixed in code in the order of the form;
  configuration adds rules, custom fields (on a final page) and help texts.
- **Contact data (Q112 as built):** the wizard edits address, phone, mobile and private email (never
  the login channels or the work email). A value the participant wrote, also in assisted mode, is
  never overwritten by a re-import, which reports a difference by code only.
- **Retention (Q141):** the profile (education, work history, languages, mobility, job wishes,
  gender, Familienstand) and nationality, entry date, residence status and Bürgergeld:
  `personnel_file`. RV-Nummer: `participation_record` (evidence set, Q88). Health and disability
  yes/no: a new class `health_record` (3 months after exit or with non-signer deletion). Purpose
  acknowledgements and consents: `personnel_file`. All periods stay `unset` until Slice 7.
- **Encryption:** in the database with `pgcrypto`, inside the SECURITY DEFINER functions that
  write and read the encrypted fields; the API derives the key from a new `FIELD_ENCRYPTION_KEY`
  and passes it per call (ADR-0002 amendment in PR 4a-4).

## Q133, Q134: accepted as built

- **Q133:** a recovery doesn't require a photo ID. The staff confirmation (`identityVerified`) and
  the assurance of the chosen channel (letter: imported address and birth date; sheet: photo-ID
  handover; in person: photo-ID check) stand. Stays `assumed` (🔒) until the DPO confirms.
- **Q134:** readings (a)–(g) of PR 3f are accepted. `confirmed`.
