# Decisions — 2026-10-20, round 35 (participant access before Slice 3)

The product owner reviewed how participants first get into the portal and replaced the
project-wide QR registration (Q31) with personal activation codes. It's a pilot decision, made in
the same placeholder roles as rounds 32–34: no external Legal, BA or DPO confirmation is involved,
and anything here can be revisited. The details still open are Q113–Q119.

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

- **One code per participation.** When a participation is created (import or manual creation),
  it gets a personal activation code. The code is high-entropy, single-use, valid for a limited
  time and locked after a few failed attempts (values: Q118). Only a keyed hash is stored.
  Reissuing a code revokes the old one.
- **Two ways to deliver it:**
  - an **activation letter** to the imported Anschrift (the address is a required import target
    unless relaxed);
  - a **printed sheet** handed out at the info event.

  Both carry the code and a QR of the personal activation link. The code sits in the link's
  fragment (`#…`), so it never reaches server logs, proxies or `Referer` headers. The page posts
  it and removes it from the address bar.
- **Activation:** the participant opens the link (or types the code), passes the knowledge check
  (date of birth, Q113), registers a private email or mobile with consent, and confirms it with
  a one-time code. After that they log in with a one-time code to that channel.
- **Bound from the first click.** The account belongs to the imported participation from the
  start. There is no anonymous endpoint, no `self_registered` state and no matching.
- **The PL sees the activation status per participation** and can reissue a code (who may:
  Q118). After an activation, a notice goes to the newly registered channel.
- **Email and SMS are both channels, chosen by the participant** (Q119). Both run behind the
  mail and SMS adapters, which are mocks in dev.
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
- **`self_registered` leaves the lifecycle core** in its own PR, together with its edges and
  `rejected`-from-`self_registered`. `rejected` stays only if another path uses it.
- **Slice 3 builds** activation codes, the activation flow, channel registration with consent,
  one-time-code login, sessions and the PL's activation status. The letter and the sheet start as
  printable pages. A PDF letter and any posting service come with the PDF adapter (Slice 6), or
  earlier if Q115 needs it.
- **Two-way communication** (dates, forms, personal data, messages) builds on an activated
  account in Slices 4a and 5. "Not activated" becomes a funnel stage on the PL dashboard.
