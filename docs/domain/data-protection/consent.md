# Data protection: consent

## Legal basis and consent *(assumed, Q4, Q44)*

| Purpose | Legal basis |
|---|---|
| Import from the customer (name, contact, Personalnummer) | Art. 6(1)(f), backed by the Transfersozialplan |
| Information, data collection, DSV preparation | Art. 6(1)(b), pre-contractual |
| beE employment, payroll, Transfer-KuG | Art. 6(1)(b) + (c) (SGB III, SGB IV, AO) |
| Profiling and reporting to the Agentur | Art. 6(1)(c) (§110/§111 SGB III) + signed TL 407 declaration |
| Health / disability | Art. 9(2)(b). Details beyond yes/no only with explicit consent, Art. 9(2)(a) |
| Private email/mobile for portal login and portal notifications (reminders) | consent, Art. 6(1)(a), revocable (`portal-contact-consent:v2`) |
| TG access to the BA applicant profile (Kug 200b) | the signed acknowledgement (declaration 17) recorded as written, kept as the record `kug200b_profile_access`; whether it is a consent, and what a withdrawal effects, is to verify (Q185) |
| Aggregated customer reporting | Art. 6(1)(f), anonymised |

- Each processing purpose is stored with its legal basis.
- **Our consents** are records (`consent_record`, Q138): purpose (`portal_contact`,
  `kug200b_profile_access`), source (`portal`, or `paper_form` that staff record from a signed
  form), text version and language, who and when, and when and why it ended. A channel is named
  exactly for `portal_contact` (a `CHECK`), which is given in the portal; revoking it is the
  channel's removal. `kug200b_profile_access` is recorded from the signed Kug 200b (Slice 6): declaration 17 is worded
  as an acknowledgement of selective access, so its characterization as a consent stays a DPO/legal
  check (Q185); a recorded withdrawal never claims BA access was disabled and never erases a valid
  ASU registration.
  Revoking consent never blocks contract-based or legally required processing.
- **Consent v2 (Slice 5; Q154, final):** `portal-contact-consent:v2` (de/en, immutable, SHA-256
  tests) covers login codes and operational notifications from the portal, such as a reminder
  that something is open; no advertising; voluntary and revocable by removing the channel or
  writing to the controller. From Slice 5 on, activation, recovery and a new channel record v2
  only (`complete_activation` and `add_participant_channel` refuse v1). No migration converts v1
  evidence: a v1 channel keeps login codes but gets no reminder. "Meine Kontaktwege" offers each
  v1 channel a voluntary upgrade (the v2 text, "Zustimmen", "Später"); declining removes no
  channel, ends no session and doesn't affect login; the offer comes back on the next visit only
  there. The verified address isn't verified again; staff can't give v2 on a participant's behalf
  (no staff or assisted route). `upgrade_channel_consent` locks the participation, the channel and
  its consent, ends the v1 consent `superseded` (never `revoked`), inserts the participant's v2
  consent, points the channel to it and audits `consent_ended` and `consent_given`, or answers
  `already_current`. Staff channel views show the consent version beside kind and state.
- **Acknowledgements are not consents:** the self-service purposes notice is acknowledged, not
  consented to (above, "Self-service data").
- **Declarations to the BA** are not our consents: the Jobbörse choice (TL 407 field 50) is
  stored as an enum on the profiling record, and the BA contact/research consent as a boolean,
  each with a date. Revocation goes to the BA.
