# Decisions — 2026-10-20, round 35 (participant access before Slice 3)

The product owner reviewed how participants first get into the portal and replaced the
project-wide QR registration (Q31) with personal activation codes. It's a pilot decision, made in
the same placeholder roles as rounds 32–34: no external Legal, BA or DPO confirmation is involved,
and anything here can be revisited. The owner answered the follow-up questions Q112–Q120 the same
day (below).

## Why the QR goes

- **Identity came second.** The import already says who the people are. The QR made them type
  their identity again, and the PL then matched every registration by hand, with typo and
  duplicate risk.
- **It was an anonymous public endpoint that creates personal-data records.** That needed a
  captcha, rate limits, a 30-day cleanup and an abuse story. A QR on a slide or flyer can be
  photographed and passed on.
- **It only worked in person.** People who missed the info event, the group that most needs
  reaching early, got nothing.
- **It worked around the real gap without closing it.** Imports don't reliably contain a private
  contact, and work email is never used (Q11), so no invitation could go out.

## Decision: personal activation codes

- **One code per participation, generated when it is issued.** A code is generated when the PL
  prints a letter or sheet (or otherwise issues it), never at import: only a keyed hash is kept,
  so the code can't be printed later. It is high-entropy, single-use, valid for a limited time
  from issuance and locked after a few failed attempts (Q118). Issuing a new code revokes the
  old one.
- **Three ways to issue it; the PL chooses per participant (Q120):**
  - an **activation letter** to the imported Anschrift (the address is a required import target
    unless relaxed);
  - a **printed sheet** handed out at the info event;
  - **in person, sent to a private email or mobile** the person gives after the PL checked their
    ID.

  The letter and the sheet carry the code and a QR of the personal activation link. The code sits in the link's
  fragment (`#…`), so it never reaches server logs, proxies or `Referer` headers. The page posts
  it and removes it from the address bar.
- **Activation:** the participant opens the link (or types the code), passes the knowledge check
  (date of birth; without one see Q113), registers a private email or mobile with consent, and confirms it with
  a one-time code. After that they log in with a one-time code to that channel.
- **Bound from the first click.** The account belongs to the imported participation from the
  start. There is no anonymous endpoint, no `self_registered` state and no matching.
- **The PL sees the activation status per participation** and can reissue a code (who may:
  Q118). After an activation, a notice goes to the newly registered channel.
- **Email and SMS are both channels from Slice 3, chosen by the participant** (Q119). Both run
  behind the mail and SMS adapters, mocks for now.
  - An email login uses a code the participant types, or a link that takes effect only after a
    click on the page. A bare GET never logs anyone in, because mail scanners open links in
    advance.
  - Imported work email is still never used (Q11).
- **Fallbacks:** assisted mode as before, and a new code (by letter or at an event) when a
  participant loses access.
- **People missing from the employer's list** are added by the PL through manual creation and
  then get a code like everyone else.

## Consequences

- **Slice 4c (QR registration and matching) is dropped from the roadmap.** Its 30-day deletion
  job goes with it.
- **`self_registered` leaves the lifecycle core** in its own PR, with its edges and `rejected`,
  whose only path is from `self_registered`.
- **Slice 3 builds** activation codes, the activation flow, channel registration with consent,
  one-time-code login, sessions and the PL's activation status. The letter and the sheet start as
  printable pages. A PDF letter and any posting service come with the PDF adapter (Slice 6), or
  earlier if needed.
- **Two-way communication** (dates, forms, personal data, messages) builds on an activated
  account in Slices 4a and 5. "Not activated" becomes a funnel stage on the PL dashboard.

## Answers to the follow-up questions (same day)

- **Q113, no birth date:** no self-activation. The PL hands the code over in person after an ID
  check.
- **Q114, Art. 14 notice:** every activation letter and sheet is planned as the participant's
  Art. 14 GDPR notice, with versioned pilot content now. External DPO review is a gate before
  real data, not a Slice 3 development gate.
- **Q115, posting:** the PL batch-prints and posts the letters, on normal project postage. No
  per-letter budgeting in the MVP; a posting adapter comes later.
- **Q116, status:** an activation moves `imported → contacted` and `unreachable → contacted` in
  the same transaction. It never moves a later status back.
- **Q117, channel:** self-service activation needs at least one verified private email or
  mobile. Without one, assisted mode applies.
- **Q118, code values:** valid for 30 days from issuance (not from the participation's
  creation), locked after 5 failed attempts, 12 characters in groups. There is no anonymous or
  self-service reissue. The PL, or back office assigned to the project, reissues after verifying
  the person. Every issuance and reissue is audited.
- **Q119, channels:** email and SMS both from Slice 3, behind mock adapters at first.
- **Q112, re-import:** participant-maintained data wins. A re-import reports differences but
  never overwrites the private email, mobile or other contact data the participant manages.
  Employer-managed work email follows the normal import rules and stays unusable for login.
- **Q120, in-person issuance:** yes, as a third channel next to letter and sheet; the PL picks
  whatever fits. After an ID check the PL sends the activation link to the private email or
  mobile the person gives. The person opens it on their own device, passes the knowledge check
  and gives consent themselves; opening the link also verifies the channel. The PL never sees
  the code, and the issuance is audited with the channel it went to, never the code.
