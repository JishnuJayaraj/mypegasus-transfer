# Decisions — 2026-10-20, round 36 (Slice 3 plan review, Q121–Q130)

The product owner reviewed the [Slice 3 plan](../plans/slice-3.md) in
[#58](https://github.com/JishnuJayaraj/mypegasus-transfer/pull/58) and answered the questions it
raised. These are pilot answers in the placeholder roles of rounds 32–35: no external Legal, BA or
DPO confirmation is involved, none blocks development on synthetic data, and external DPO approval
of the final wording stays a gate before real data. The 🔒 rows stay `assumed` until then; Q126 is
`confirmed`.

## The plan

- **The six-PR split is approved.** The estimates are guidance, not a hard 1,500-line ceiling:
  keep each PR cohesive. 3a and 3b may start in parallel; they merge one after the other, and the
  second renumbers its migration if both took the same number.
- **Separate `ACCESS_CODE_SECRET`:** accepted, with separate HKDF contexts for activation codes,
  delivery-address hashes and one-time codes. Rotating it invalidates open codes and challenges
  (reissue); it never affects sessions.
- **In-person delivery hash:** accepted, with corrected semantics. A hash match proves only that
  the participant re-entered the same normalised address; possession of the link delivered to it
  verifies control of the channel. The issuer sees the address while typing it; it is never
  returned later, logged or put into audit details.
- **The participant's activation transition:** accepted. `complete_activation` may call one
  ungranted internal status primitive in its transaction; the granted staff status function keeps
  refusing participant actors.
- **The flat role goes, `mayCreateProjects` comes:** accepted, as in Q126.
- **Channel privacy:** accepted (Q123).

## Answers

**Q121, cutoff and terminal states.** A first activation in `imported`, `contacted` or
`unreachable` is allowed only before that participation's cutoff, checked again with database time
at completion; a code issued earlier doesn't bypass it. `informed` and `active_in_tg` may activate
after the cutoff, with no status change backwards. An activated account stays usable until the
lifecycle actually becomes terminal. A terminal participation can't be issued a code, activate or
log in; its open codes are revoked and its sessions end.

**Q122, retention.** The class `access_credential`: activation codes, one-time challenges and staff
and participant sessions are deleted, or irreversibly stripped of hashes and addresses, 30 days
after use, expiry, lock, revocation or end. `staff_audit_event` follows `audit_log`, assignments
`participation_record`, participant account and consent evidence `personnel_file`. A removed
private address isn't kept because its consent evidence is: the address and the delivery hash are
erased after 30 days; the proof without the value (kind, purpose, text version, dates, actor, end
reason) stays for its evidence period. A legal hold never keeps an authentication secret usable.
Executable periods stay `unset` until Slice 7.

**Q123, staff and channels.** No staff role may retrieve a registered private email or mobile.
Staff see the kind, the verification and consent state and the dates. The app may send versioned
portal notifications under `portal_contact`; it is not a contact directory.

**Q124, Art. 14 notice.** The notice is supplied **at issuance**. Letter and sheet include it; an
in-person issuance by email or SMS hands the notice over or sends a durable notice or link in that
first message. The portal repeats it and records the version, but is never the first delivery.
Record the version, the method and the time it was sent or handed over. Deadline: no later than the
first communication with the participant and in any case within one calendar month after the data
was received. Slice 3 shows the due and overdue state; it isn't left to Slice 5. German and English
variants for every format; German by default, the PL chooses until the participant's preference is
known.

**Q125, shared addresses.** One normalised email or mobile belongs to at most one active
participant account. Two participations in different projects are never inferred to be one person.
A collision returns the generic `channel_in_use` after authentication and never identifies the
other account; the participant uses another channel or assisted mode.

**Q126, org administration.**
- Only a global admin creates and deactivates staff accounts, grants org roles and sets
  `mayCreateProjects`.
- A staff member with that flag creates a project, chooses its region and becomes its first PL.
- The project's PL changes the region only while the project is draft and manages members, roles
  and participant assignments.
- A global admin may change a region at any time and may add a replacement PL for recovery,
  without gaining case-data access by doing so.
- The last active PL can't be removed or deactivated.
- Regional admins stay region-scoped; in Slice 3 they neither deactivate global accounts nor
  manage project teams.

**Q127, identity verification per channel.**
- **Letter:** the imported address is delivery, not identity verification. Assurance is possession
  of the code delivered there plus the birth-date check; no birth date, no letter activation.
- **Sheet:** printing is not an ID check. The code becomes activatable only once staff record the
  handover after inspecting an original official photo ID against the imported identity. Only the
  confirmer, time and method are stored: no ID number, copy or image. Sheets not handed over are
  revoked. So a sheet is `printed` and then `handed_over` (or generated only at handover); a
  checkbox at batch printing isn't enough.
- **In person:** the same photo-ID check comes before sending. Possession of the delivered link
  verifies control of the channel; retyping the address (a hash match) alone doesn't.

**Q128, failed attempts.** For a valid open code, a well-formed wrong birth date counts; for an
in-person code, a wrong normalised delivery address counts too. The fifth failure locks atomically.
Syntax errors don't count. Unknown, expired, revoked, used or locked codes increment no counter and
get a generic answer. One-time codes have their own counter of five. The IP throttle applies to all
activation-code submissions; in memory is fine for synthetic data and development, but a shared
edge or store limiter is required before a multi-process deployment with real data.

**Q129, no birth date and later sensitive access.** Only a handed-over sheet or an in-person send
after the Q127 ID check may skip the birth date; the identity-assurance method, confirmer and time
are recorded. Later special-category access uses that recorded in-person proof plus a fresh
one-time code to a currently verified channel as step-up, never the postcode. Until Slice 4a builds
that step-up, these participants see no special-category data in the portal.

**Q130, lost access.** A distinct `lost_access` recovery operation. After staff verify the person,
issuing the recovery code at once ends all participant sessions and suspends every old channel for
login and notifications, so a lost phone stops working before the recovery completes. A completed
recovery replaces the channels and ends the old consents' use with the reason
`lost_access_replaced` (never recorded as a withdrawal by the participant). If the recovery code
expires, the old channels stay suspended and assisted recovery remains. No lifecycle status change.

## Plan corrections

1. The sheet's ID confirmation becomes an audited handover step (Q127).
2. Notice delivery at issuance and its one-month due/overdue state are part of 3d (Q124).
3. An external send can't be atomic with a database transaction: commit a pending code or
   challenge, send synchronously, then record the outcome; on a definitive failure revoke or
   invalidate it; handle "provider accepted, response lost" safely; never hold a transaction open
   across network delivery.
4. Notice delivery is **at least once**, with a provider idempotency key where supported.
5. Q121's cutoff check applies to every pre-admission status, not only `unreachable`.
6. `knowledge_checked_at` becomes identity-assurance and step-up metadata, so Q129 is represented
   without pretending a birth-date check happened.

These clarify the implementation and are no new approval gate; implementation is authorised.
