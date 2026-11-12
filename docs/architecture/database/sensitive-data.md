# Database: sensitive data

## Amendment 2026-10-21: field encryption with pgcrypto (Slice 4a, PR 4a-4)

Decided in [round 38](../../decisions/2026-10-21-answers-round-38.md) (Q135): the highly confidential
and special-category fields are encrypted **in the database**, inside the SECURITY DEFINER
functions that write and read them.

- `0049` creates three tables, one row per participation and one retention class each:
  `participant_identifier_data` (RV-Nummer, `participation_record`),
  `participant_residence_social_data` (nationality, entry date, residence status, Bürgergeld,
  `personnel_file`) and `participant_health_data` (health restrictions and
  Schwerbehinderung/Gleichstellung yes/no, `health_record`). Each field is a `bytea` ciphertext
  beside an unencrypted `<field>_present` boolean (a CHECK holds them equal), with the row's
  `key_id` and `written_at`. Completeness and every list or state payload use the presence only.
- `0050` installs `pgcrypto` in its own schema `crypto` (a trusted extension the owner role
  creates); `transfer_app` has no `USAGE` on it, so it can't call pgcrypto at all.
- **Encryption:** `pgp_sym_encrypt(…, 'cipher-algo=aes256, compress-algo=0')` (OpenPGP with an
  integrity check, no compression). The plaintext is an envelope `{p: participation id, f: field
  key, v: value}`; decryption checks `p` and `f` and refuses a mismatch (`envelope_mismatch`), so a
  ciphertext copied to another row or field can't be read there. A wrong key or damaged
  ciphertext is `decryption_failed`, pgcrypto's own message dropped.
- **The key:** the API derives it (HKDF-SHA256, info `field-encryption:v1`) from
  `FIELD_ENCRYPTION_KEY` (at least 32 characters, required outside development; a fixed constant
  in development like `ACCESS_CODE_SECRET`'s) and passes it per call as a **bind parameter**,
  never with `set_config` (which would leave it in the session). `key_id` is a 64-bit fingerprint
  of the derived key, stored per row: a row written under another key is `key_unknown`, never
  misread. Rotation (re-encrypting under a new key) is a later migration; the key never reaches a
  log, an error or the audit trail. The cluster's Postgres must log no statements or bind
  parameters (ADR-0005, pre-pilot gate).
- Two granted functions: `write_sensitive_fields(context, participation, group, values, revision,
  notice version, key, key id, token hash)` writes one group (`ba_details` or `health`) whole for
  the participant through their live active session (`lock_self_service_writer`, as the page
  writes); the health group needs the session's step-up (`step_up_required`); the notice and the
  wizard's one `revision` are checked as for the pages, and a write bumps it. It decrypts the stored
  values to find the changed fields and audits one `sensitive_write` per changed field key;
  nothing changed writes nothing. `read_sensitive_fields(context, participation, keys, key, key
  id, token hash)` decrypts the keys and audits one `sensitive_read` per key, so no read path skips
  the log: a participant through their own live active session (health and disability need the
  step-up), staff in normal mode only as the assigned consultant (every field) or back office of
  the project (all but the health restrictions), else `actor_not_allowed`. The API decides with
  the access matrix first; the functions check again. Staff write, and read on the participant's
  behalf, in assisted mode (amendment below).
- The structure of each value is checked in the database too (`sensitive_value_valid`: the
  RV-Nummer's format, nationality `german` or `other` with a country other than `DE`, an ISO
  date, the residence statuses, booleans), and entry date and residence status only with the
  nationality `other`; the domain's schemas (`packages/domain/src/self-service/sensitive.ts`)
  validate first and give the codes.
- Grants: `transfer_app` selects only the key, presence, key-id and time columns of the three
  tables (column grants), never a ciphertext; no `INSERT`, `UPDATE` or `DELETE`. The step-up
  functions are below (ADR-0007).
- **Step-up state** on `participant_session`: `sensitive_step_up_method` (`birth_date`,
  `photo_id_and_code`), `sensitive_step_up_at` (both or neither, only on an `active` session) and
  `step_up_failures` (0–5). Granted: `check_step_up_birth_date`, `request_step_up_code` (a
  `step_up` one-time code to a live channel of the participant's; returns its kind and address
  for the send) and `verify_step_up_code`; counted failures are returned, never raised, as in 0042.
  Internal: `record_step_up` (audited `step_up_completed`), `fail_step_up` (the fifth ends the
  session `step_up_failed`, audited), `participant_session_stepped_up`. `record_audit_event`
  refuses the two step-up types.
