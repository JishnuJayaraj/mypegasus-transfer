# Data protection: authentication

## Authentication *(assumed, Q7, Q11, Q27, Q28)*

- **Staff**: Entra ID via OIDC, MFA enforced by Conditional Access. Roles and assignments are
  managed in the app. Sessions last 8 hours, server-side, in httpOnly SameSite cookies.
  - **As built (Slice 3, PR 3b):**
    - **Sessions:** both login modes (OIDC, and the dev stub, never in production) start a
      `staff_session` row. The cookie `__Host-tp_staff` (`Secure`, `HttpOnly`, `SameSite=Lax`,
      `Path=/`; `tp_staff` over http in development) carries 32 random bytes. The table keeps only
      their SHA-256, so a database read gives no live session. Every login issues a new token and
      ends the one the browser carried (`superseded`). 8 hours absolute, no sliding window,
      checked in SQL against database time; logout ends the row.
    - **Binding:** staff accounts are created in the app. The first OIDC login of an active,
      unbound account binds the token's `(iss, sub)` to the account whose email equals the `email`
      claim (else `preferred_username`), compared case-insensitively; later logins match
      `(iss, sub)` only. Unknown, deactivated and differently bound accounts are refused
      (`unknown_account`, `account_deactivated`, `identity_mismatch`). The app doesn't check `amr`:
      MFA is the identity provider's. Use the tenant-specific issuer: the `email` claim is only
      trusted for the first binding of an account an admin created.
    - **Staff audit:** `staff_audit_event` records `staff_login` (with the method),
      `staff_logout`, `staff_login_refused` (the code, and the matched account where there is one;
      never the claimed email) and `staff_identity_bound` (the claim matched). The runtime role has
      no privilege on it.
    - **No secrets in logs:** request lines carry the route pattern and the staff user id; no
      token, cookie, authorization code, claim or email reaches a log line, an error or a URL.
  - **As built (Slice 3, PR 3c):** accounts are created and deactivated only by a global admin
    (`/admin/staff`); deactivation ends the account's sessions at once (`end_reason`
    `deactivated`), removes its org roles and memberships, closes its assignments, and is refused
    for a project's last active PL. The staff audit trail adds `staff_account_created`,
    `staff_account_changed` (the
    changed keys, never the name or email), `staff_account_deactivated` (counts), `org_role_granted`
    and `org_role_revoked` (role and region; deactivation also records `account_deactivated`),
    `region_created` and `region_changed` (the region's
    id). A login may return to `/admin` pages too.
- **Participants**:
  - First access: a personal activation code, generated when the PL issues it: a printed
    letter to the imported address, a sheet at the info event (both with a QR of the personal
    link; the code in the link's fragment, never in a URL the server logs), or in person, sent
    to a private email or mobile the person gives after an ID check, activated on the person's
    own device; the PL never sees the code (Q120). It is single-use,
    stored only as a keyed hash, valid 30 days from issuance, locked after 5 failed attempts;
    a new issuance revokes the old one. The PL or assigned back office issue it after verifying
    the person; no anonymous or self-service reissue; every issuance is audited
    ([round 35](../../decisions/2026-10-20-answers-round-35.md), Q118). The letter or sheet is the
    Art. 14 GDPR notice, versioned (Q114).
  - The participant then registers at least one private email or mobile (their choice, Q117,
    Q119) and logs in with one-time codes to it. Contact data the participant maintains is never
    overwritten by an HR re-import (Q112). **Imported work emails are never used for login.** An email
    login never takes effect on a bare GET (mail scanners open links).
  - After an activation, a notice goes to the newly registered channel.
  - Links/codes are single-use and expire after 15 minutes, with at most 5 requests per hour
    per phone number or email.
  - Sessions: 30 minutes idle, 12 hours absolute.
  - Before special-category data is shown, the participant must enter their date of birth as a
    knowledge check. A real second factor comes later.
  - Fallbacks: a new activation code (letter or info event), and assisted mode.
  - **Round 36** ([answers](../../decisions/2026-10-20-answers-round-36.md), Q121–Q130, assumed
    unless noted):
    - **Identity per channel (Q127):** a letter is delivery, not verification: assurance is the
      code plus the birth-date check, so no birth date, no letter. A sheet becomes activatable only
      once staff record its handover after inspecting an original official photo ID against the
      imported identity; an in-person send needs the same check first. Only the confirmer, time
      and method are stored, never an ID number, copy or image. Without a birth date only these
      two channels skip the birth-date step, and the method is recorded (Q129).
    - **Failures (Q128):** a well-formed wrong birth date, or for an in-person code a wrong
      delivery address, counts; the fifth locks. Unknown, expired, revoked, used or locked codes
      count nothing and get one generic answer. A per-IP throttle covers every code submission;
      a shared limiter is needed before a multi-process deployment with real data.
    - **Art. 14 notice (Q124, verify):** supplied at issuance (letter, sheet, or a durable notice
      or link in the first in-person message), never first in the portal; version, language,
      method and time recorded; due at the first communication and at the latest one calendar
      month after the data was received; the PL sees due and overdue. German and English for
      every format.
    - **Channels (Q123, Q125):** staff never retrieve a registered private email or mobile, only
      its kind, verification and consent state and dates; the app sends versioned portal
      notifications under the consent purpose `portal_contact`. One address belongs to at most one
      active account; a collision never names the other account.
    - **Cutoff and terminal statuses (Q121):** a first activation before `informed` needs the
      participation's cutoff not to have passed; a terminal status revokes open codes and ends
      sessions.
    - **Lost access (Q130):** a recovery code; issuing it ends the sessions and suspends the old
      channels at once; completion replaces them (consents end `lost_access_replaced`).
    - **Retention (Q122):** activation codes, one-time codes and sessions (class
      `access_credential`) are deleted or stripped of hashes and addresses 30 days after use,
      expiry, lock, revocation or end; a removed address and its hash are erased after 30 days
      while the value-free consent proof stays with the personnel file; a legal hold never keeps
      a secret usable.
  - **As built (Slice 3, PR 3d — issuance only):**
    - Codes are twelve Crockford base32 characters (about 60 bits, printed `XXXX-XXXX-XXXX`)
      generated only on issuance; input is normalised (upper case, spaces and hyphens dropped,
      O→0, I/L→1), and a malformed code counts nothing. HMAC keys for the
      code, destination and later one-time codes are independently HKDF-derived from
      `ACCESS_CODE_SECRET`; staff-session keys are unrelated. Rotation invalidates open codes but
      never staff sessions.
    - Letter and sheet batches are atomic. A letter requires the imported postal address and birth
      date. A sheet records Article 14 provision only when its photo-ID handover is confirmed.
      In-person issuance records the photo-ID check and commits `pending` before the provider call;
      a definitive successful send records notice provision, failure revokes, and an unknown
      outcome remains valid without claiming provision.
    - The immutable bilingual `art14-activation:v1` catalog is protected by fixed SHA-256 tests.
      Letter/sheet output embeds the text; the first in-person message links to a public static
      versioned page with no personal data or API request. Controller/DPO values come from
      organisation configuration and must receive final DPO review before real data.
    - Codes exist in staff memory only for the print result; QR links use the fragment. Application
      logs, audit details, errors and later responses contain no code, destination or hash.
  - **As built (Slice 3, PR 3e — activation and sessions):**
    - The portal takes the code from the link's fragment, removes it from the address bar and
      posts it only on a click. A code starts an `activating` session (cookie `__Host-tp_portal`,
      its SHA-256 stored) that opens only the activation steps; completion starts an `active` one
      with a new token. 30 minutes idle, 12 hours absolute, by database time; a terminal status
      ends every session.
    - Steps: the notice repeated (the version shown recorded), the birth date (skipped only for a
      handed-over sheet or an in-person code without one), then the retyped delivery address of
      an in-person code (keyed hash comparison) or a private email or mobile with the consent
      `portal-contact-consent:v1` (de/en, purpose `portal_contact`; v2 from Slice 5) and a six-digit one-time code.
      The imported work email is refused (`channel_invalid`); an address of another active
      account is the generic `channel_in_use`.
    - Failures: a wrong birth date or delivery address counts on the code and the fifth locks it
      (audited by the system); a wrong one-time code counts on that code and the fifth ends it.
      Unknown or unusable codes, and syntax errors, count nothing and get the one generic
      `code_invalid`. Every code submission passes the per-IP throttle (10 per 15 minutes, in
      memory per process; a shared limiter is a pre-pilot item, ADR-0005).
    - Completion is one transaction: code used, account (`birth_date`, or `photo_id` with the
      code's ID check), consent, channel, `imported`/`unreachable` → `contacted` by the participant
      (cutoff re-checked by database time), `participant_activated`, `consent_given`,
      `contact_channel_added`. The activation notice goes to the new channel through a job queued
      in that transaction.
    - Staff see that the account is activated, how the identity was assured, and per channel its
      kind, verification, consent and notice dates; never the address. The participant sees their
      own channels masked. No response, log line or audit row carries a code, one-time code,
      address or hash; portal request lines carry the participation id.
    - The consent and message wording are pilot drafts awaiting DPO review (Q132).
  - **As built (Slice 3, PR 3f — login, channels, lost-access recovery):**
    - **Login:** the participant types their private email or mobile; the answer (`202`) is the
      same whether or not it is a live channel of a usable account, and a code is sent only when it
      is, after the response so the timing doesn't tell either. The email carries the six-digit
      code and a link with it in the fragment (never the address); the page logs in only after the
      participant typed the address and clicked. An unknown address, a wrong, expired or used code
      and the fifth wrong entry get the same `one_time_code_invalid`. Login codes are limited to
      five per address and hour for every address alike (in memory, keyed hashes); the database
      also counts login and verification codes of known addresses together, and a request only it
      refuses is accepted silently. Logins are audited (`participant_login`, the channel's id).
    - **Channels:** the participant adds a private email or mobile with its own consent and a
      one-time code to it, and removes one, which ends its consent `revoked` (both audited as the
      participant). Removing the last channel ends all their sessions; the portal warns first
      that portal login is then no longer possible and that help in person, by phone or by letter
      remains (Q154). From Slice 5 a new channel records consent v2 (above, "Legal basis and
      consent"). An
      address of another account, or the participant's own, is the generic `channel_in_use`; the
      work email is `channel_invalid`. Staff still see only kind, states and dates.
    - **Recovery (Q130):** the PL or back office issue a recovery code (letter, sheet or in person)
      for an activated account only, after confirming they verified the person (Q133 for how).
      Issuing it ends every session and suspends every live channel in the same transaction
      (`contact_channels_suspended`); suspended channels get no login codes or notices. The
      participant runs the activation steps again; completion removes the old channels, ends their
      consents `lost_access_replaced` (never a withdrawal), adds the new channel and consent,
      changes no lifecycle status, and is a login. The account keeps its first identity
      assurance. The activation notice goes to the new channel. If the code expires or is revoked, the channels stay suspended.
- **Assisted mode**: staff act on behalf of the participant, audited as `actor` + `onBehalfOf`.
  No session sharing.
- **No self-registration.** There is no anonymous endpoint that creates participant records;
  every account is bound to a participation the PL created ([round 35](../../decisions/2026-10-20-answers-round-35.md)).
